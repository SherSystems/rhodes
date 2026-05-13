// ============================================================
// RHODES — In-VM Diagnostic + Remediation Playbook
//
// The agentic loop that runs when a higher-level probe (HTTP
// service probe, host alert) says "this VM is sick". RHODES SSHes
// into the VM and reproduces what a human operator would do:
//
//   1. GATHER — run a fan-out of diagnostic commands in parallel
//      (df, free, uptime, systemctl, journalctl, dmesg, ss).
//   2. CLASSIFY — reduce parsed output into one or more named
//      failure modes (DISK_FULL, MEMORY_OOM, BOOT_LOOP, ...).
//   3. PLAN — propose remediation steps with action tiers AND
//      escalations for things we will never auto-touch.
//   4. EXECUTE — gated on operator approval, run each step with
//      a sleep + re-probe of the original app between steps.
//
// This file is the canonical reference for how RHODES handles
// the in-VM half of the diagnostic chain triggered by
// ServiceUnreachable / VM-level host alerts.
// ============================================================

import type { ActionTier } from "../providers/types.js";

// ── Constants & Policy ──────────────────────────────────────

/** Any mount at or above this is "disk pressure". */
export const DISK_PRESSURE_PCT = 85;

/** Any mount at or above this is "disk full" — escalate. */
export const DISK_FULL_PCT = 95;

/** Memory pressure threshold. */
export const MEMORY_PRESSURE_PCT = 90;

/** Swap pressure threshold. */
export const SWAP_PRESSURE_PCT = 50;

/** Uptime under this many seconds + repeated service failures = boot-loop. */
export const BOOT_LOOP_UPTIME_SECS = 300;

/** dmesg lines newer than this many seconds count as "recent kernel error". */
export const KERNEL_ERROR_RECENCY_SECS = 300;

/** Sleep between executed steps before we re-probe the app. */
export const STEP_REVERIFY_DELAY_MS = 3_000;

/** Action tier table for the commands this playbook may issue. */
export const PLAYBOOK_ACTION_TIERS: Record<string, ActionTier> = {
  "df": "read",
  "free": "read",
  "uptime": "read",
  "systemctl --failed": "read",
  "systemctl status": "read",
  "journalctl": "read",
  "dmesg": "read",
  "ss": "read",
  "journalctl --vacuum-size": "risky_write",
  "apt-get clean": "safe_write",
  "systemctl restart": "risky_write",
  "systemctl disable": "risky_write",
};

// ── Failure Mode Enumeration ────────────────────────────────

/** All recognized failure-mode classifications. Order in this union
 *  is documentation only — priority is enforced by `FAILURE_MODE_PRIORITY`. */
export type FailureMode =
  | "DISK_FULL"
  | "DISK_PRESSURE"
  | "MEMORY_OOM"
  | "MEMORY_PRESSURE"
  | "BOOT_LOOP"
  | "SERVICE_CRASHED"
  | "SERVICE_NOT_LISTENING"
  | "KERNEL_ERROR"
  | "IO_ERROR"
  | "UNDETERMINED";

/** Priority ordering for the classifier. Lower index = higher priority.
 *  IO_ERROR comes first because it's a storage-pool signal — we'd rather
 *  hand off to the proxmox-storage-pause playbook than do anything else. */
export const FAILURE_MODE_PRIORITY: readonly FailureMode[] = [
  "IO_ERROR",
  "DISK_FULL",
  "MEMORY_OOM",
  "BOOT_LOOP",
  "SERVICE_CRASHED",
  "SERVICE_NOT_LISTENING",
  "KERNEL_ERROR",
  "DISK_PRESSURE",
  "MEMORY_PRESSURE",
  "UNDETERMINED",
];

export type DiagnosticPhase =
  | "gather"
  | "classify"
  | "plan"
  | "execute"
  | "verify";

// ── Parser Output Types ─────────────────────────────────────

export interface DiskUsage {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  used_pct: number;
  mount_point: string;
  /** True when `used_pct >= DISK_PRESSURE_PCT`. */
  pressure: boolean;
}

export interface MemoryUsage {
  total_mb: number;
  used_mb: number;
  free_mb: number;
  used_pct: number;
  swap_total_mb: number;
  swap_used_mb: number;
  swap_used_pct: number;
  pressure: boolean;
}

export interface UptimeInfo {
  up_seconds: number;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  /** True when up_seconds < BOOT_LOOP_UPTIME_SECS. */
  boot_loop: boolean;
}

export interface FailedUnit {
  unit: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  description?: string;
}

export interface JournalLine {
  /** Best-effort raw timestamp; we don't try to parse the journalctl
   *  TZ format — the operator looks at the raw text anyway. */
  timestamp: string;
  host: string;
  unit?: string;
  message: string;
}

export type DmesgSeverity = "low" | "medium" | "high";

export interface DmesgLine {
  /** ISO timestamp (parsed from `dmesg -T` bracket prefix). May be empty
   *  if dmesg ran without `-T`. */
  timestamp_iso: string;
  level: string;
  message: string;
  severity: DmesgSeverity;
}

export interface SsListeningResult {
  listening: boolean;
  process?: string;
  /** Raw matching line for the operator. */
  raw?: string;
}

export interface SystemctlStatus {
  active_state: string;
  sub_state: string;
  pid?: number;
  restart_count?: number;
  last_log_lines: string[];
}

// ── Parsers (deterministic, fully testable) ─────────────────

/**
 * Parse `df -h` output, e.g.:
 *
 *   Filesystem      Size  Used Avail Use% Mounted on
 *   /dev/sda1       100G   88G   12G  88% /
 *   tmpfs           4.0G     0  4.0G   0% /dev/shm
 */
export function parseDfH(stdout: string): DiskUsage[] {
  const out: DiskUsage[] = [];
  const lines = stdout.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^filesystem\s+/i.test(line)) continue;
    // Note: df -h can wrap long filesystem names onto the next line, but
    // GNU df reflows to a single line by default. We accept the common form.
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const [filesystem, size, used, available, usePctStr, ...mountParts] = cols;
    if (!/%$/.test(usePctStr)) continue;
    const used_pct = Number(usePctStr.replace(/%$/, ""));
    if (!Number.isFinite(used_pct)) continue;
    const mount_point = mountParts.join(" ");
    out.push({
      filesystem,
      size,
      used,
      available,
      used_pct,
      mount_point,
      pressure: used_pct >= DISK_PRESSURE_PCT,
    });
  }
  return out;
}

/**
 * Parse `free -h` or `free -m` output. We accept the `-h` (human) and the
 * `-m` (megabytes) form; values are normalized to MiB.
 *
 *                total        used        free      shared  buff/cache   available
 *   Mem:           7.7Gi       6.9Gi       250Mi        50Mi       620Mi       500Mi
 *   Swap:          2.0Gi       1.5Gi       500Mi
 */
export function parseFreeH(stdout: string): MemoryUsage {
  let memCols: string[] = [];
  let swapCols: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (/^mem:/i.test(line)) memCols = line.split(/\s+/);
    else if (/^swap:/i.test(line)) swapCols = line.split(/\s+/);
  }
  const total_mb = parseHumanMiB(memCols[1] ?? "0");
  const used_mb = parseHumanMiB(memCols[2] ?? "0");
  const free_mb = parseHumanMiB(memCols[3] ?? "0");
  const swap_total_mb = parseHumanMiB(swapCols[1] ?? "0");
  const swap_used_mb = parseHumanMiB(swapCols[2] ?? "0");
  const used_pct = total_mb > 0 ? (used_mb / total_mb) * 100 : 0;
  const swap_used_pct =
    swap_total_mb > 0 ? (swap_used_mb / swap_total_mb) * 100 : 0;
  return {
    total_mb,
    used_mb,
    free_mb,
    used_pct,
    swap_total_mb,
    swap_used_mb,
    swap_used_pct,
    pressure: used_pct >= MEMORY_PRESSURE_PCT || swap_used_pct >= SWAP_PRESSURE_PCT,
  };
}

function parseHumanMiB(raw: string): number {
  if (!raw) return 0;
  const m = raw.match(/^([\d.]+)\s*([KMGTP]?i?)?(B)?$/i);
  if (!m) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (m[2] ?? "").toLowerCase();
  let factor: number;
  switch (unit[0]) {
    case "k":
      factor = 1 / 1024;
      break;
    case "g":
      factor = 1024;
      break;
    case "t":
      factor = 1024 * 1024;
      break;
    case "p":
      factor = 1024 * 1024 * 1024;
      break;
    case "m":
    default:
      factor = 1;
      break;
  }
  return value * factor;
}

/**
 * Parse `uptime` output. The Linux form looks like:
 *
 *   13:42:13 up 7 days,  2:33,  3 users,  load average: 0.42, 0.31, 0.28
 *   13:42:13 up  4 min,  1 user,  load average: 1.20, 0.50, 0.20
 *   13:42:13 up 33 min,  1 user,  load average: ...
 */
export function parseUptime(stdout: string): UptimeInfo {
  const line = stdout.trim();
  let up_seconds = 0;

  // Try the standard `up X days, HH:MM` / `up X min` patterns.
  const daysMatch = line.match(/up\s+(\d+)\s+days?,\s*(?:(\d+):(\d+)|(\d+)\s+min)/);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    up_seconds += days * 86400;
    if (daysMatch[2] && daysMatch[3]) {
      up_seconds += Number(daysMatch[2]) * 3600 + Number(daysMatch[3]) * 60;
    } else if (daysMatch[4]) {
      up_seconds += Number(daysMatch[4]) * 60;
    }
  } else {
    const hmMatch = line.match(/up\s+(\d+):(\d+),/);
    if (hmMatch) {
      up_seconds = Number(hmMatch[1]) * 3600 + Number(hmMatch[2]) * 60;
    } else {
      const minMatch = line.match(/up\s+(\d+)\s+min/);
      if (minMatch) {
        up_seconds = Number(minMatch[1]) * 60;
      } else {
        const secMatch = line.match(/up\s+(\d+)\s+sec/);
        if (secMatch) up_seconds = Number(secMatch[1]);
      }
    }
  }

  const loadMatch = line.match(
    /load average:?\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i,
  );
  const load_1m = loadMatch ? Number(loadMatch[1]) : 0;
  const load_5m = loadMatch ? Number(loadMatch[2]) : 0;
  const load_15m = loadMatch ? Number(loadMatch[3]) : 0;

  return {
    up_seconds,
    load_1m: Number.isFinite(load_1m) ? load_1m : 0,
    load_5m: Number.isFinite(load_5m) ? load_5m : 0,
    load_15m: Number.isFinite(load_15m) ? load_15m : 0,
    boot_loop: up_seconds > 0 && up_seconds < BOOT_LOOP_UPTIME_SECS,
  };
}

/**
 * Parse `systemctl --failed --no-pager`:
 *
 *   UNIT                    LOAD   ACTIVE SUB    DESCRIPTION
 *   ● foo.service           loaded failed failed Foo Daemon
 *   ● bar.service           loaded failed failed Bar Daemon
 *
 *   2 loaded units listed.
 */
export function parseSystemctlFailed(stdout: string): FailedUnit[] {
  const out: FailedUnit[] = [];
  for (const rawLine of stdout.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    // Strip leading bullet character that systemctl uses for failed units.
    line = line.replace(/^[●*✗x]\s*/u, "");
    if (/^UNIT\s+LOAD/i.test(line)) continue;
    if (/loaded units? listed/i.test(line)) continue;
    if (/^to show all installed/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    // First col must look like a unit name; reject prose.
    if (!/\.\w+$/.test(cols[0])) continue;
    const [unit, load_state, active_state, sub_state, ...descParts] = cols;
    const entry: FailedUnit = {
      unit,
      load_state,
      active_state,
      sub_state,
    };
    if (descParts.length > 0) entry.description = descParts.join(" ");
    out.push(entry);
  }
  return out;
}

/**
 * Parse `journalctl --since=10min ago -p err -n 100` (default format):
 *
 *   Apr 30 13:42:14 host1 jellyfin[1234]: AbcException: blah
 *   Apr 30 13:42:15 host1 sshd[5678]: Failed password for invalid user
 */
export function parseJournalctl(stdout: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^--\s*(logs begin|reboot|no entries)/i.test(line)) continue;
    const m = line.match(
      /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)$/,
    );
    if (m) {
      const [, timestamp, host, unitRaw, , message] = m;
      const unit = unitRaw.replace(/\[.*$/, "");
      const entry: JournalLine = { timestamp, host, message };
      if (unit) entry.unit = unit;
      out.push(entry);
      continue;
    }
    // Fall back to a looser form for journalctl output without service tag.
    const loose = line.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/);
    if (loose) {
      out.push({
        timestamp: loose[1],
        host: loose[2],
        message: loose[3],
      });
    }
  }
  return out;
}

/**
 * Parse `dmesg -T --level=err,crit,alert,emerg`:
 *
 *   [Thu Apr 30 13:42:13 2026] Out of memory: Killed process 1234 (foo)
 *   [Thu Apr 30 13:42:14 2026] sd 0:0:0:0: [sda] tag#0 FAILED Result: hostbyte=DID_NO_CONNECT
 */
export function parseDmesg(stdout: string): DmesgLine[] {
  const out: DmesgLine[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    let timestamp_iso = "";
    let body = line;
    const bracket = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (bracket) {
      const dt = new Date(bracket[1]);
      if (!Number.isNaN(dt.getTime())) timestamp_iso = dt.toISOString();
      body = bracket[2];
    }
    const level = inferDmesgLevel(body);
    const severity = inferDmesgSeverity(body);
    out.push({ timestamp_iso, level, message: body, severity });
  }
  return out;
}

function inferDmesgLevel(msg: string): string {
  const lower = msg.toLowerCase();
  if (/emerg|panic/.test(lower)) return "emerg";
  if (/alert/.test(lower)) return "alert";
  if (/crit|critical/.test(lower)) return "crit";
  if (/err|error|fail/.test(lower)) return "err";
  return "info";
}

function inferDmesgSeverity(msg: string): DmesgSeverity {
  const lower = msg.toLowerCase();
  if (
    /oom-killer|out of memory: killed/.test(lower) ||
    /\bnmi\b/.test(lower) ||
    /i\/o error|io error|sd \d+:\d+:\d+:\d+:.*failed result/.test(lower) ||
    /ext[234]-fs error|jbd2|fs error/.test(lower) ||
    /kernel panic/.test(lower)
  ) {
    return "high";
  }
  if (/err|error|fail|crit|alert/.test(lower)) return "medium";
  return "low";
}

/**
 * Parse `ss -tlnp` output looking for a specific port.
 *
 *   State   Recv-Q  Send-Q  Local Address:Port    Peer Address:Port  Process
 *   LISTEN  0       128     0.0.0.0:22            0.0.0.0:*          users:(("sshd",pid=1234,fd=3))
 *   LISTEN  0       128     [::]:8096             [::]:*             users:(("jellyfin",pid=4321,fd=20))
 */
export function parseSsListening(stdout: string, port: number): SsListeningResult {
  const portStr = String(port);
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^state\s+recv/i.test(line)) continue;
    // The "Local Address:Port" column ends with `:<port>` — but only for
    // exact-match listens. Anchor on a colon to avoid matching e.g. "8096"
    // appearing inside "108096".
    const colMatch = line.match(/(?:^|\s)(\S+):(\d+)\s/);
    if (!colMatch) continue;
    if (colMatch[2] !== portStr) continue;
    const proc = line.match(/users:\(\("([^"]+)"/);
    const result: SsListeningResult = { listening: true, raw: line };
    if (proc) result.process = proc[1];
    return result;
  }
  return { listening: false };
}

/**
 * Parse `systemctl status <service> --no-pager -l`. We pull just what the
 * classifier needs: active state, sub state, optional pid, optional restart
 * counter, and the tail of in-line journal lines that systemctl prints.
 */
export function parseSystemctlStatus(stdout: string): SystemctlStatus {
  let active_state = "unknown";
  let sub_state = "unknown";
  let pid: number | undefined;
  let restart_count: number | undefined;
  const last_log_lines: string[] = [];

  const lines = stdout.split("\n");
  let inLogTail = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    const active = trimmed.match(/^Active:\s*(\S+)\s*\(([^)]+)\)/);
    if (active) {
      active_state = active[1];
      sub_state = active[2];
      continue;
    }
    const pidMatch = trimmed.match(/^Main PID:\s*(\d+)/);
    if (pidMatch) {
      pid = Number(pidMatch[1]);
      continue;
    }
    // systemd doesn't print "Restart count" natively, but our prior shell
    // pipelines sometimes append it. Accept it if present.
    const rc = trimmed.match(/^Restart[- ]count:\s*(\d+)/i);
    if (rc) {
      restart_count = Number(rc[1]);
      continue;
    }
    // The journal tail starts after a blank line that follows the metadata.
    // Easier heuristic: lines beginning with a month-day-time + host pattern.
    if (/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/.test(trimmed)) {
      inLogTail = true;
      last_log_lines.push(trimmed);
      continue;
    }
    if (inLogTail && trimmed.length > 0) last_log_lines.push(trimmed);
  }

  const out: SystemctlStatus = {
    active_state,
    sub_state,
    last_log_lines,
  };
  if (pid !== undefined) out.pid = pid;
  if (restart_count !== undefined) out.restart_count = restart_count;
  return out;
}

// ── Gather Phase ────────────────────────────────────────────

export interface VmDiagnosticExecutor {
  exec(command: string): Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
    timed_out: boolean;
  }>;
  /** Restart a service. Should be gated by the caller through the SSH
   *  classifier + approval. */
  restartService(service: string): Promise<{ ok: boolean; error?: string }>;
  /** Optional callback to re-probe the original failing application. */
  probeApp?(): Promise<{ ok: boolean; status?: number }>;
  sleep(ms: number): Promise<void>;
}

export interface GatherOptions {
  /** systemd unit to inspect specifically (no `.service` suffix). */
  service: string;
  /** Optional port the service is expected to listen on. When set, drives
   *  the SERVICE_NOT_LISTENING check. */
  port?: number;
  /** journalctl `--since=` window. */
  since?: string;
}

/** Raw stdouts from each diagnostic command. */
export interface GatherRaw {
  df: string;
  free: string;
  uptime: string;
  systemctl_failed: string;
  journalctl_service: string;
  journalctl_system: string;
  dmesg: string;
  ss: string;
  systemctl_status: string;
}

/** Parsed bundle assembled by `parseGatherBundle`. */
export interface ParsedDiagnostics {
  disks: DiskUsage[];
  memory: MemoryUsage;
  uptime: UptimeInfo;
  failed_units: FailedUnit[];
  service_journal: JournalLine[];
  system_journal: JournalLine[];
  dmesg: DmesgLine[];
  ss_listening: SsListeningResult;
  systemctl_status: SystemctlStatus;
}

/** Compose the canonical command list for the GATHER phase. */
export function buildGatherCommands(opts: GatherOptions): GatherRaw {
  const since = opts.since ?? "10min ago";
  return {
    df: `df -h`,
    free: `free -h`,
    uptime: `uptime`,
    systemctl_failed: `systemctl --failed --no-pager`,
    journalctl_service:
      `journalctl -u ${shellQuote(opts.service)} --since=${shellQuote(since)} --no-pager -p err -n 100`,
    journalctl_system:
      `journalctl --since=${shellQuote(since)} --no-pager -p err -n 50`,
    dmesg: `dmesg -T --level=err,crit,alert,emerg | tail -50`,
    ss: `ss -tlnp`,
    systemctl_status: `systemctl status ${shellQuote(opts.service)} --no-pager -l`,
  };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Issue every gather command in parallel via the executor. Returns raw
 * stdouts (or empty strings when the underlying command errored). We
 * deliberately swallow exec errors here — the classifier will see the
 * empty output and route to UNDETERMINED rather than crashing the run.
 */
export async function gatherDiagnostics(
  executor: VmDiagnosticExecutor,
  opts: GatherOptions,
): Promise<GatherRaw> {
  const cmds = buildGatherCommands(opts);
  const keys = Object.keys(cmds) as (keyof GatherRaw)[];
  const results = await Promise.all(
    keys.map(async (k) => {
      try {
        const r = await executor.exec(cmds[k]);
        return [k, r.stdout] as const;
      } catch {
        return [k, ""] as const;
      }
    }),
  );
  const out: GatherRaw = {
    df: "",
    free: "",
    uptime: "",
    systemctl_failed: "",
    journalctl_service: "",
    journalctl_system: "",
    dmesg: "",
    ss: "",
    systemctl_status: "",
  };
  for (const [k, v] of results) out[k] = v;
  return out;
}

/** Parse a complete `GatherRaw` bundle into structured data. */
export function parseGatherBundle(
  raw: GatherRaw,
  opts: GatherOptions,
): ParsedDiagnostics {
  return {
    disks: parseDfH(raw.df),
    memory: parseFreeH(raw.free),
    uptime: parseUptime(raw.uptime),
    failed_units: parseSystemctlFailed(raw.systemctl_failed),
    service_journal: parseJournalctl(raw.journalctl_service),
    system_journal: parseJournalctl(raw.journalctl_system),
    dmesg: parseDmesg(raw.dmesg),
    ss_listening: opts.port
      ? parseSsListening(raw.ss, opts.port)
      : { listening: false },
    systemctl_status: parseSystemctlStatus(raw.systemctl_status),
  };
}

// ── Classification ──────────────────────────────────────────

export interface ClassifyOptions {
  service: string;
  /** When set, SERVICE_NOT_LISTENING checks `ss -tlnp` against this port. */
  port?: number;
  /** "now" for kernel-error recency. Injected for tests. */
  now?: Date;
}

/**
 * Reduce the parsed bundle into a (deduplicated, priority-ordered) list of
 * failure modes. Returns `["UNDETERMINED"]` when nothing matched.
 */
export function classifyFailureModes(
  parsed: ParsedDiagnostics,
  opts: ClassifyOptions,
): FailureMode[] {
  const modes = new Set<FailureMode>();
  const now = opts.now ?? new Date();

  // IO_ERROR — highest priority. dmesg high-severity that mentions IO.
  const ioRe = /(i\/o error|io error|sd \d+:\d+:\d+:\d+:.*failed result|jbd2)/i;
  if (parsed.dmesg.some((d) => d.severity === "high" && ioRe.test(d.message))) {
    modes.add("IO_ERROR");
  }

  // DISK_FULL / DISK_PRESSURE
  if (parsed.disks.some((d) => d.used_pct >= DISK_FULL_PCT)) {
    modes.add("DISK_FULL");
  } else if (parsed.disks.some((d) => d.used_pct >= DISK_PRESSURE_PCT)) {
    modes.add("DISK_PRESSURE");
  }

  // MEMORY_OOM — dmesg shows oom-killer
  if (parsed.dmesg.some((d) => /oom-killer|out of memory: killed/i.test(d.message))) {
    modes.add("MEMORY_OOM");
  }

  // MEMORY_PRESSURE — no OOM yet but free reports pressure
  if (!modes.has("MEMORY_OOM") && parsed.memory.pressure) {
    modes.add("MEMORY_PRESSURE");
  }

  // BOOT_LOOP — uptime < 5min AND service journal shows the unit
  // failing repeatedly.
  const serviceFailures = parsed.service_journal.filter((j) =>
    /failed|fatal|crash|exit code/i.test(j.message),
  ).length;
  if (parsed.uptime.boot_loop && serviceFailures >= 2) {
    modes.add("BOOT_LOOP");
  }

  // SERVICE_CRASHED — systemctl status reports failed for the named service
  const st = parsed.systemctl_status;
  if (
    /failed|inactive/i.test(st.active_state) ||
    parsed.failed_units.some((u) => u.unit.startsWith(`${opts.service}.`))
  ) {
    modes.add("SERVICE_CRASHED");
  }

  // SERVICE_NOT_LISTENING — active but port not bound
  if (
    opts.port !== undefined &&
    /active|activating/i.test(st.active_state) &&
    !parsed.ss_listening.listening &&
    !modes.has("SERVICE_CRASHED")
  ) {
    modes.add("SERVICE_NOT_LISTENING");
  }

  // KERNEL_ERROR — recent high-sev dmesg without IO
  const recentMs = KERNEL_ERROR_RECENCY_SECS * 1000;
  const hasRecentHighSev = parsed.dmesg.some((d) => {
    if (d.severity !== "high") return false;
    if (ioRe.test(d.message)) return false; // already attributed
    if (/oom-killer|out of memory: killed/i.test(d.message)) return false;
    if (!d.timestamp_iso) return true; // no timestamp → assume recent
    const ts = new Date(d.timestamp_iso).getTime();
    if (Number.isNaN(ts)) return true;
    return now.getTime() - ts <= recentMs;
  });
  if (hasRecentHighSev) modes.add("KERNEL_ERROR");

  if (modes.size === 0) modes.add("UNDETERMINED");

  // Sort by FAILURE_MODE_PRIORITY.
  return FAILURE_MODE_PRIORITY.filter((m) => modes.has(m));
}

// ── Plan ────────────────────────────────────────────────────

export interface RemediationStep {
  command: string;
  description: string;
  tier: ActionTier;
  failure_mode: FailureMode;
}

export interface EscalationItem {
  failure_mode: FailureMode;
  reason: string;
}

export interface DiagnosticPlan {
  failure_modes: FailureMode[];
  steps: RemediationStep[];
  /** Items the playbook refused to auto-generate; operator must handle. */
  escalations: EscalationItem[];
}

export interface PlanOptions {
  service: string;
  /** Used by the DISK_FULL planner to pick safer commands. */
  parsed?: ParsedDiagnostics;
}

/**
 * Translate classified failure modes into a remediation plan with action
 * tiers. Modes the playbook will NOT auto-handle (e.g. BOOT_LOOP,
 * KERNEL_ERROR) become escalations.
 */
export function buildDiagnosticPlan(
  modes: FailureMode[],
  opts: PlanOptions,
): DiagnosticPlan {
  const steps: RemediationStep[] = [];
  const escalations: EscalationItem[] = [];
  // Track whether we already proposed a restart so we don't emit dupes
  // when multiple modes (e.g. SERVICE_CRASHED + MEMORY_PRESSURE) all want one.
  let restartProposed = false;

  for (const mode of modes) {
    switch (mode) {
      case "IO_ERROR":
        escalations.push({
          failure_mode: mode,
          reason:
            "IO_ERROR in dmesg suggests storage-pool exhaustion — emit a STORAGE_EXHAUSTION_PAUSE event for the proxmox-storage-pause playbook to handle. Do NOT auto-run from here.",
        });
        break;

      case "DISK_FULL": {
        // Differentiate `/var` (auto-actionable) from `/` (escalate-only).
        const fullMount = opts.parsed?.disks.find(
          (d) => d.used_pct >= DISK_FULL_PCT,
        );
        const mount = fullMount?.mount_point ?? "/";
        if (mount === "/var" || mount.startsWith("/var/")) {
          steps.push({
            command: `sudo journalctl --vacuum-size=500M`,
            description: `Trim journal on ${mount} to free space.`,
            tier: PLAYBOOK_ACTION_TIERS["journalctl --vacuum-size"],
            failure_mode: mode,
          });
          steps.push({
            command: `sudo apt-get clean`,
            description: `Drop the apt cache to free additional space on ${mount}.`,
            tier: PLAYBOOK_ACTION_TIERS["apt-get clean"],
            failure_mode: mode,
          });
        } else {
          escalations.push({
            failure_mode: mode,
            reason: `Disk full on ${mount} — Tier 5 manual triage. The playbook only auto-cleans /var.`,
          });
        }
        break;
      }

      case "DISK_PRESSURE": {
        // Pressure (not full) is informational; we suggest the same safe-ish
        // cleanups but flag them as advisory.
        steps.push({
          command: `sudo journalctl --vacuum-size=500M`,
          description: `Disk pressure detected — trim journals to reclaim space.`,
          tier: PLAYBOOK_ACTION_TIERS["journalctl --vacuum-size"],
          failure_mode: mode,
        });
        break;
      }

      case "MEMORY_OOM": {
        if (!restartProposed) {
          steps.push({
            command: `sudo systemctl restart ${opts.service}`,
            description: `OOM kill detected — restart ${opts.service} to recover.`,
            tier: PLAYBOOK_ACTION_TIERS["systemctl restart"],
            failure_mode: mode,
          });
          restartProposed = true;
        }
        escalations.push({
          failure_mode: mode,
          reason:
            "Repeated OOM kills indicate a capacity problem; capture for follow-up review.",
        });
        break;
      }

      case "MEMORY_PRESSURE": {
        if (!restartProposed) {
          steps.push({
            command: `sudo systemctl restart ${opts.service}`,
            description: `Memory pressure (no OOM yet) — restart ${opts.service}.`,
            tier: PLAYBOOK_ACTION_TIERS["systemctl restart"],
            failure_mode: mode,
          });
          restartProposed = true;
        }
        escalations.push({
          failure_mode: mode,
          reason: "Memory pressure suggests capacity tuning is needed.",
        });
        break;
      }

      case "BOOT_LOOP":
        // EXPLICITLY do not auto-restart — that worsens the loop.
        steps.push({
          command: `sudo systemctl disable ${opts.service}`,
          description: `Boot-loop suspected — disable ${opts.service} so the operator can debug without it auto-restarting.`,
          tier: PLAYBOOK_ACTION_TIERS["systemctl disable"],
          failure_mode: mode,
        });
        escalations.push({
          failure_mode: mode,
          reason:
            "Boot-loop detected (uptime <5min + repeated unit failures). Operator must investigate before re-enabling.",
        });
        break;

      case "SERVICE_CRASHED":
        if (!restartProposed) {
          steps.push({
            command: `sudo systemctl restart ${opts.service}`,
            description: `Service ${opts.service} is in a failed/inactive state — restart.`,
            tier: PLAYBOOK_ACTION_TIERS["systemctl restart"],
            failure_mode: mode,
          });
          restartProposed = true;
        }
        break;

      case "SERVICE_NOT_LISTENING":
        if (!restartProposed) {
          steps.push({
            command: `sudo systemctl restart ${opts.service}`,
            description: `Service ${opts.service} is active but not listening on the expected port — restart.`,
            tier: PLAYBOOK_ACTION_TIERS["systemctl restart"],
            failure_mode: mode,
          });
          restartProposed = true;
        }
        break;

      case "KERNEL_ERROR":
        escalations.push({
          failure_mode: mode,
          reason:
            "Recent kernel error in dmesg — no auto-action. Tier 5 manual triage.",
        });
        break;

      case "UNDETERMINED":
        // Nothing to do; the runner will mark the result as inconclusive.
        break;
    }
  }

  return { failure_modes: modes, steps, escalations };
}

// ── End-to-End Runner ──────────────────────────────────────

export interface RunOptions extends GatherOptions {
  /** Approval gate; if not provided, the plan is auto-approved. */
  approve_plan?: (plan: DiagnosticPlan) => Promise<boolean>;
  /** Force the playbook to refuse BOOT_LOOP auto-actions even if the operator
   *  approves the plan. Defaults to true — operator override required. */
  refuse_boot_loop_auto?: boolean;
  /** "now" used by the kernel-error classifier (test injection). */
  now?: Date;
}

export interface ExecutedStep extends RemediationStep {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface RunResult {
  phase: DiagnosticPhase;
  raw: GatherRaw;
  parsed: ParsedDiagnostics;
  failure_modes: FailureMode[];
  plan: DiagnosticPlan;
  executed_steps: ExecutedStep[];
  app_probe_after?: { ok: boolean; status?: number };
  recovered: boolean;
  notes: string[];
}

/**
 * Run the full diagnostic → plan → (approval) → execute → verify loop.
 *
 * This function is pure orchestration: every I/O point is on the executor.
 */
export async function runVmDiagnosticPlaybook(
  executor: VmDiagnosticExecutor,
  options: RunOptions,
): Promise<RunResult> {
  const notes: string[] = [];

  // 1. GATHER
  const raw = await gatherDiagnostics(executor, options);
  const parsed = parseGatherBundle(raw, options);

  // 2. CLASSIFY
  const classifyOpts: ClassifyOptions = { service: options.service };
  if (options.port !== undefined) classifyOpts.port = options.port;
  if (options.now !== undefined) classifyOpts.now = options.now;
  const modes = classifyFailureModes(parsed, classifyOpts);

  // 3. PLAN
  const planOpts: PlanOptions = { service: options.service, parsed };
  const plan = buildDiagnosticPlan(modes, planOpts);

  // Empty plan + UNDETERMINED → bail out without asking for approval.
  if (modes[0] === "UNDETERMINED" && plan.steps.length === 0) {
    notes.push("Classifier returned UNDETERMINED — nothing to remediate.");
    return {
      phase: "classify",
      raw,
      parsed,
      failure_modes: modes,
      plan,
      executed_steps: [],
      recovered: false,
      notes,
    };
  }

  // Operator approval gate.
  if (options.approve_plan && plan.steps.length > 0) {
    const ok = await options.approve_plan(plan);
    if (!ok) {
      notes.push("Operator rejected remediation plan.");
      return {
        phase: "plan",
        raw,
        parsed,
        failure_modes: modes,
        plan,
        executed_steps: [],
        recovered: false,
        notes,
      };
    }
  }

  // 4. EXECUTE
  const executed_steps: ExecutedStep[] = [];
  let recovered = false;
  let app_probe_after: { ok: boolean; status?: number } | undefined;

  const refuseBootLoop = options.refuse_boot_loop_auto ?? true;
  if (refuseBootLoop && modes.includes("BOOT_LOOP")) {
    notes.push(
      "BOOT_LOOP detected — playbook refuses auto-remediation even with operator approval. Set refuse_boot_loop_auto=false to override.",
    );
    return {
      phase: "plan",
      raw,
      parsed,
      failure_modes: modes,
      plan,
      executed_steps: [],
      recovered: false,
      notes,
    };
  }

  for (const step of plan.steps) {
    let stepResult: ExecutedStep;
    if (step.command.startsWith("sudo systemctl restart ")) {
      const restart = await executor.restartService(options.service);
      stepResult = {
        ...step,
        ok: restart.ok,
        ...(restart.error !== undefined ? { error: restart.error } : {}),
      };
    } else {
      const exec = await executor.exec(step.command);
      stepResult = {
        ...step,
        ok: exec.exit_code === 0 && !exec.timed_out,
        stdout: exec.stdout,
        stderr: exec.stderr,
      };
    }
    executed_steps.push(stepResult);

    if (!stepResult.ok) {
      notes.push(`Step failed: ${step.command} — ${stepResult.error ?? stepResult.stderr ?? "non-zero exit"}`);
      continue;
    }

    // Sleep + optional app re-probe.
    await executor.sleep(STEP_REVERIFY_DELAY_MS);
    if (executor.probeApp) {
      app_probe_after = await executor.probeApp();
      if (app_probe_after.ok && (app_probe_after.status === 200 || app_probe_after.status === undefined)) {
        recovered = true;
        notes.push(
          `App probe succeeded after step: ${step.command} — stopping early.`,
        );
        break;
      }
    }
  }

  // 5. VERIFY — if we have a probe and never crossed the early-stop
  // condition, record the final probe verdict.
  if (!recovered && executor.probeApp) {
    if (!app_probe_after) {
      app_probe_after = await executor.probeApp();
    }
    if (app_probe_after.ok && (app_probe_after.status === 200 || app_probe_after.status === undefined)) {
      recovered = true;
    }
  }

  if (plan.escalations.length > 0) {
    for (const e of plan.escalations) {
      notes.push(`Escalation [${e.failure_mode}]: ${e.reason}`);
    }
  }

  const result: RunResult = {
    phase: "verify",
    raw,
    parsed,
    failure_modes: modes,
    plan,
    executed_steps,
    recovered,
    notes,
  };
  if (app_probe_after !== undefined) result.app_probe_after = app_probe_after;
  return result;
}
