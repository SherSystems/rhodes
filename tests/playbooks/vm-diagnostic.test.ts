import { describe, it, expect } from "vitest";
import {
  parseDfH,
  parseFreeH,
  parseUptime,
  parseSystemctlFailed,
  parseJournalctl,
  parseDmesg,
  parseSsListening,
  parseSystemctlStatus,
  buildGatherCommands,
  gatherDiagnostics,
  parseGatherBundle,
  classifyFailureModes,
  buildDiagnosticPlan,
  runVmDiagnosticPlaybook,
  DISK_PRESSURE_PCT,
  DISK_FULL_PCT,
  MEMORY_PRESSURE_PCT,
  SWAP_PRESSURE_PCT,
  BOOT_LOOP_UPTIME_SECS,
  PLAYBOOK_ACTION_TIERS,
  FAILURE_MODE_PRIORITY,
  type VmDiagnosticExecutor,
  type ParsedDiagnostics,
  type GatherRaw,
  type DiagnosticPlan,
  type FailureMode,
} from "../../src/playbooks/vm-diagnostic.js";

// ── Fixtures ────────────────────────────────────────────────

const DF_OUT = `
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   88G   12G  88% /
tmpfs           4.0G     0  4.0G   0% /dev/shm
/dev/sda2        50G   48G  2.0G  96% /var
/dev/sda3       200G   10G  190G   5% /home
`;

const FREE_OUT_HEALTHY = `              total        used        free      shared  buff/cache   available
Mem:           7.7Gi       2.1Gi       4.0Gi        50Mi       1.6Gi       5.4Gi
Swap:          2.0Gi       0.0Gi       2.0Gi
`;

const FREE_OUT_PRESSURE = `              total        used        free      shared  buff/cache   available
Mem:           8.0Gi       7.5Gi       250Mi        50Mi       250Mi       500Mi
Swap:          2.0Gi       1.5Gi       500Mi
`;

const UPTIME_LONG = ` 13:42:13 up 7 days,  2:33,  3 users,  load average: 0.42, 0.31, 0.28`;
const UPTIME_SHORT = ` 13:42:13 up  4 min,  1 user,  load average: 1.20, 0.50, 0.20`;
const UPTIME_HM = ` 13:42:13 up  1:33,  2 users,  load average: 0.10, 0.20, 0.30`;

const SYSTEMCTL_FAILED_OUT = `  UNIT                LOAD   ACTIVE SUB    DESCRIPTION
● jellyfin.service   loaded failed failed Jellyfin Media Server
● cron.service       loaded failed failed Regular background program processing daemon

2 loaded units listed. Pass --all to see loaded but inactive units, too.
`;

const JOURNAL_SERVICE_OUT = `
Apr 30 13:42:14 host1 jellyfin[1234]: Application failed to start, exit code 137
Apr 30 13:42:15 host1 jellyfin[1234]: Application failed to start, exit code 137
Apr 30 13:42:16 host1 jellyfin[1234]: Restarting in 3s
`;

const DMESG_OOM = `[Thu Apr 30 13:42:13 2026] Out of memory: Killed process 1234 (jellyfin) total-vm:9999kB
[Thu Apr 30 13:42:14 2026] oom-killer: gfp_mask=0x...
`;

const DMESG_IO = `[Thu Apr 30 13:42:13 2026] sd 0:0:0:0: [sda] tag#0 FAILED Result: hostbyte=DID_NO_CONNECT
[Thu Apr 30 13:42:14 2026] EXT4-fs error (device sda1): handle_dquot_inode_quota:5018
`;

const DMESG_CLEAN = `[Thu Apr 30 13:42:13 2026] some informational notice
`;

const SS_LISTENING_OUT = `State    Recv-Q  Send-Q  Local Address:Port    Peer Address:Port  Process
LISTEN   0       128     0.0.0.0:22            0.0.0.0:*          users:(("sshd",pid=900,fd=3))
LISTEN   0       128     [::]:8096             [::]:*             users:(("jellyfin",pid=4321,fd=20))
`;

const SS_MISSING_OUT = `State    Recv-Q  Send-Q  Local Address:Port    Peer Address:Port  Process
LISTEN   0       128     0.0.0.0:22            0.0.0.0:*          users:(("sshd",pid=900,fd=3))
`;

const SYSTEMCTL_STATUS_FAILED = `● jellyfin.service - Jellyfin Media Server
     Loaded: loaded (/lib/systemd/system/jellyfin.service; enabled; vendor preset: enabled)
     Active: failed (Result: exit-code) since Thu 2026-04-30 13:42:13 UTC; 5min ago
   Main PID: 1234 (code=exited, status=137)

Apr 30 13:42:13 host1 systemd[1]: jellyfin.service: Main process exited, code=exited
Apr 30 13:42:13 host1 systemd[1]: jellyfin.service: Failed with result 'exit-code'.
`;

const SYSTEMCTL_STATUS_ACTIVE = `● jellyfin.service - Jellyfin Media Server
     Loaded: loaded
     Active: active (running) since Thu 2026-04-30 12:00:00 UTC; 1h ago
   Main PID: 1234 (jellyfin)
`;

// ── df Tests ────────────────────────────────────────────────

describe("parseDfH", () => {
  it("parses standard df -h output", () => {
    const disks = parseDfH(DF_OUT);
    expect(disks).toHaveLength(4);
    const root = disks.find((d) => d.mount_point === "/");
    expect(root?.used_pct).toBe(88);
    expect(root?.filesystem).toBe("/dev/sda1");
  });

  it("flags >=85% as pressure", () => {
    const disks = parseDfH(DF_OUT);
    expect(disks.find((d) => d.mount_point === "/")?.pressure).toBe(true);
    expect(disks.find((d) => d.mount_point === "/home")?.pressure).toBe(false);
  });

  it("preserves mount-point identity", () => {
    const disks = parseDfH(DF_OUT);
    expect(disks.find((d) => d.mount_point === "/var")?.used_pct).toBe(96);
  });

  it("threshold constants are exposed", () => {
    expect(DISK_PRESSURE_PCT).toBe(85);
    expect(DISK_FULL_PCT).toBe(95);
  });

  it("returns empty array for malformed input", () => {
    const disks = parseDfH("this is not df output");
    expect(disks).toEqual([]);
  });
});

// ── free Tests ──────────────────────────────────────────────

describe("parseFreeH", () => {
  it("parses healthy memory output", () => {
    const m = parseFreeH(FREE_OUT_HEALTHY);
    expect(m.used_pct).toBeLessThan(MEMORY_PRESSURE_PCT);
    expect(m.pressure).toBe(false);
  });

  it("flags memory pressure when used_pct >= 90", () => {
    const m = parseFreeH(FREE_OUT_PRESSURE);
    expect(m.used_pct).toBeGreaterThanOrEqual(MEMORY_PRESSURE_PCT);
    expect(m.pressure).toBe(true);
  });

  it("flags swap pressure when swap >= 50%", () => {
    const m = parseFreeH(FREE_OUT_PRESSURE);
    expect(m.swap_used_pct).toBeGreaterThanOrEqual(SWAP_PRESSURE_PCT);
  });

  it("returns zeros for malformed input", () => {
    const m = parseFreeH("nothing here");
    expect(m.total_mb).toBe(0);
    expect(m.used_pct).toBe(0);
    expect(m.pressure).toBe(false);
  });
});

// ── uptime Tests ────────────────────────────────────────────

describe("parseUptime", () => {
  it("parses long uptime in days+H:M form", () => {
    const u = parseUptime(UPTIME_LONG);
    expect(u.up_seconds).toBe(7 * 86400 + 2 * 3600 + 33 * 60);
    expect(u.boot_loop).toBe(false);
  });

  it("parses short uptime in minutes", () => {
    const u = parseUptime(UPTIME_SHORT);
    expect(u.up_seconds).toBe(4 * 60);
    expect(u.boot_loop).toBe(true);
  });

  it("parses H:M-only form (no days)", () => {
    const u = parseUptime(UPTIME_HM);
    expect(u.up_seconds).toBe(1 * 3600 + 33 * 60);
    expect(u.boot_loop).toBe(false);
  });

  it("extracts load averages", () => {
    const u = parseUptime(UPTIME_LONG);
    expect(u.load_1m).toBeCloseTo(0.42);
    expect(u.load_5m).toBeCloseTo(0.31);
    expect(u.load_15m).toBeCloseTo(0.28);
  });

  it("handles malformed input gracefully", () => {
    const u = parseUptime("garbage");
    expect(u.up_seconds).toBe(0);
    expect(u.load_1m).toBe(0);
  });

  it("respects BOOT_LOOP_UPTIME_SECS threshold", () => {
    expect(BOOT_LOOP_UPTIME_SECS).toBe(300);
  });
});

// ── systemctl --failed Tests ────────────────────────────────

describe("parseSystemctlFailed", () => {
  it("extracts unit names and states", () => {
    const units = parseSystemctlFailed(SYSTEMCTL_FAILED_OUT);
    expect(units).toHaveLength(2);
    expect(units[0].unit).toBe("jellyfin.service");
    expect(units[0].active_state).toBe("failed");
  });

  it("captures description column", () => {
    const units = parseSystemctlFailed(SYSTEMCTL_FAILED_OUT);
    expect(units[0].description).toMatch(/Jellyfin Media Server/);
  });

  it("returns empty for a clean system", () => {
    expect(parseSystemctlFailed("0 loaded units listed.")).toEqual([]);
  });

  it("ignores garbage rows", () => {
    const units = parseSystemctlFailed("not really systemctl output\nfoo bar baz");
    expect(units).toEqual([]);
  });
});

// ── journalctl Tests ────────────────────────────────────────

describe("parseJournalctl", () => {
  it("extracts message bodies", () => {
    const lines = parseJournalctl(JOURNAL_SERVICE_OUT);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0].message).toMatch(/Application failed to start/);
  });

  it("captures the unit field when present", () => {
    const lines = parseJournalctl(JOURNAL_SERVICE_OUT);
    expect(lines[0].unit).toBe("jellyfin");
  });

  it("captures the host field", () => {
    const lines = parseJournalctl(JOURNAL_SERVICE_OUT);
    expect(lines[0].host).toBe("host1");
  });

  it("returns empty for malformed input", () => {
    expect(parseJournalctl("not a real journal line")).toEqual([]);
  });
});

// ── dmesg Tests ─────────────────────────────────────────────

describe("parseDmesg", () => {
  it("flags oom-killer as high severity", () => {
    const lines = parseDmesg(DMESG_OOM);
    expect(lines[0].severity).toBe("high");
    expect(lines[0].message).toMatch(/Out of memory/);
  });

  it("flags IO/EXT4 errors as high severity", () => {
    const lines = parseDmesg(DMESG_IO);
    expect(lines.every((l) => l.severity === "high")).toBe(true);
  });

  it("parses the bracketed timestamp", () => {
    const lines = parseDmesg(DMESG_IO);
    expect(lines[0].timestamp_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns low severity for informational lines", () => {
    const lines = parseDmesg(DMESG_CLEAN);
    expect(lines[0].severity).toBe("low");
  });

  it("handles missing timestamps", () => {
    const lines = parseDmesg("Out of memory: Killed process 1234 (foo)");
    expect(lines[0].timestamp_iso).toBe("");
    expect(lines[0].severity).toBe("high");
  });
});

// ── ss Tests ────────────────────────────────────────────────

describe("parseSsListening", () => {
  it("detects a listening port and process", () => {
    const r = parseSsListening(SS_LISTENING_OUT, 8096);
    expect(r.listening).toBe(true);
    expect(r.process).toBe("jellyfin");
  });

  it("reports false when port absent", () => {
    const r = parseSsListening(SS_MISSING_OUT, 8096);
    expect(r.listening).toBe(false);
  });

  it("does not false-positive on port substrings", () => {
    const fake = `LISTEN   0  128  0.0.0.0:108096   0.0.0.0:*  users:(("foo",pid=1,fd=1))\n`;
    const r = parseSsListening(fake, 8096);
    expect(r.listening).toBe(false);
  });

  it("returns false on malformed input", () => {
    expect(parseSsListening("garbage", 22).listening).toBe(false);
  });
});

// ── systemctl status Tests ──────────────────────────────────

describe("parseSystemctlStatus", () => {
  it("extracts active/sub states for a failed unit", () => {
    const s = parseSystemctlStatus(SYSTEMCTL_STATUS_FAILED);
    expect(s.active_state).toBe("failed");
    expect(s.sub_state).toMatch(/exit-code/);
    expect(s.pid).toBe(1234);
  });

  it("extracts active state for a healthy unit", () => {
    const s = parseSystemctlStatus(SYSTEMCTL_STATUS_ACTIVE);
    expect(s.active_state).toBe("active");
  });

  it("captures the log tail", () => {
    const s = parseSystemctlStatus(SYSTEMCTL_STATUS_FAILED);
    expect(s.last_log_lines.length).toBeGreaterThan(0);
    expect(s.last_log_lines[0]).toMatch(/jellyfin\.service/);
  });

  it("returns unknown states on garbage input", () => {
    const s = parseSystemctlStatus("this is not systemctl output");
    expect(s.active_state).toBe("unknown");
    expect(s.sub_state).toBe("unknown");
    expect(s.last_log_lines).toEqual([]);
  });
});

// ── gather command builder ──────────────────────────────────

describe("buildGatherCommands", () => {
  it("includes the service name in service-specific commands", () => {
    const cmds = buildGatherCommands({ service: "jellyfin" });
    expect(cmds.journalctl_service).toMatch(/jellyfin/);
    expect(cmds.systemctl_status).toMatch(/jellyfin/);
  });

  it("quotes services that include shell metacharacters", () => {
    const cmds = buildGatherCommands({ service: "foo bar" });
    expect(cmds.systemctl_status).toMatch(/'foo bar'/);
  });

  it("uses the default 10min ago since when not provided", () => {
    const cmds = buildGatherCommands({ service: "jellyfin" });
    expect(cmds.journalctl_service).toMatch(/'10min ago'/);
  });

  it("honors a custom since window", () => {
    const cmds = buildGatherCommands({ service: "jellyfin", since: "30min ago" });
    expect(cmds.journalctl_service).toMatch(/'30min ago'/);
  });
});

// ── gather (executor-driven) ────────────────────────────────

function makeExecutor(
  responses: Partial<GatherRaw> & {
    restartOk?: boolean;
    restartError?: string;
    probe?: (count: number) => { ok: boolean; status?: number };
    onExec?: (cmd: string) => void;
    /** Map command substrings to stdout. */
    extra?: Record<string, string>;
  } = {},
): VmDiagnosticExecutor & { calls: string[]; restarts: number; probeCalls: number } {
  const calls: string[] = [];
  let restarts = 0;
  let probeCalls = 0;
  const executor = {
    calls,
    get restarts() {
      return restarts;
    },
    get probeCalls() {
      return probeCalls;
    },
    async exec(command: string) {
      calls.push(command);
      responses.onExec?.(command);
      let stdout = "";
      if (command.startsWith("df ")) stdout = responses.df ?? "";
      else if (command.startsWith("free ")) stdout = responses.free ?? "";
      else if (command === "uptime") stdout = responses.uptime ?? "";
      else if (command.startsWith("systemctl --failed")) stdout = responses.systemctl_failed ?? "";
      else if (command.startsWith("journalctl -u ")) stdout = responses.journalctl_service ?? "";
      else if (command.startsWith("journalctl --since=")) stdout = responses.journalctl_system ?? "";
      else if (command.startsWith("dmesg ")) stdout = responses.dmesg ?? "";
      else if (command.startsWith("ss ")) stdout = responses.ss ?? "";
      else if (command.startsWith("systemctl status ")) stdout = responses.systemctl_status ?? "";
      else {
        for (const [k, v] of Object.entries(responses.extra ?? {})) {
          if (command.includes(k)) {
            stdout = v;
            break;
          }
        }
      }
      return { exit_code: 0, stdout, stderr: "", timed_out: false };
    },
    async restartService() {
      restarts++;
      return { ok: responses.restartOk ?? true, ...(responses.restartError ? { error: responses.restartError } : {}) };
    },
    async probeApp() {
      probeCalls++;
      if (responses.probe) return responses.probe(probeCalls);
      return { ok: true, status: 200 };
    },
    async sleep() {
      /* deterministic — no real sleeping in tests */
    },
  };
  return executor;
}

describe("gatherDiagnostics", () => {
  it("fires all nine diagnostic commands", async () => {
    const ex = makeExecutor({ df: DF_OUT });
    await gatherDiagnostics(ex, { service: "jellyfin" });
    expect(ex.calls).toHaveLength(9);
    expect(ex.calls.some((c) => c.startsWith("df "))).toBe(true);
    expect(ex.calls.some((c) => c === "uptime")).toBe(true);
    expect(ex.calls.some((c) => c.startsWith("ss "))).toBe(true);
  });

  it("returns raw stdouts under the canonical keys", async () => {
    const ex = makeExecutor({ df: DF_OUT });
    const raw = await gatherDiagnostics(ex, { service: "jellyfin" });
    expect(raw.df).toBe(DF_OUT);
  });

  it("tolerates exec errors by returning empty strings", async () => {
    const exErr: VmDiagnosticExecutor = {
      async exec() {
        throw new Error("boom");
      },
      async restartService() {
        return { ok: true };
      },
      async sleep() {},
    };
    const raw = await gatherDiagnostics(exErr, { service: "jellyfin" });
    expect(raw.df).toBe("");
    expect(raw.uptime).toBe("");
  });
});

// ── Classification ──────────────────────────────────────────

function emptyParsed(): ParsedDiagnostics {
  return {
    disks: [],
    memory: parseFreeH(FREE_OUT_HEALTHY),
    uptime: parseUptime(UPTIME_LONG),
    failed_units: [],
    service_journal: [],
    system_journal: [],
    dmesg: [],
    ss_listening: { listening: true },
    systemctl_status: parseSystemctlStatus(SYSTEMCTL_STATUS_ACTIVE),
  };
}

describe("classifyFailureModes", () => {
  it("returns UNDETERMINED for a clean bundle", () => {
    const modes = classifyFailureModes(emptyParsed(), { service: "jellyfin" });
    expect(modes).toEqual(["UNDETERMINED"]);
  });

  it("classifies DISK_FULL on >=95% mount", () => {
    const p = emptyParsed();
    p.disks = parseDfH(DF_OUT);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).toContain("DISK_FULL");
    // Should not double-up as DISK_PRESSURE.
    expect(modes).not.toContain("DISK_PRESSURE");
  });

  it("classifies DISK_PRESSURE when >=85% but <95%", () => {
    const p = emptyParsed();
    p.disks = [
      {
        filesystem: "/dev/sda1",
        size: "100G",
        used: "88G",
        available: "12G",
        used_pct: 88,
        mount_point: "/",
        pressure: true,
      },
    ];
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).toContain("DISK_PRESSURE");
  });

  it("classifies MEMORY_OOM on dmesg oom-killer", () => {
    const p = emptyParsed();
    p.dmesg = parseDmesg(DMESG_OOM);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).toContain("MEMORY_OOM");
    // OOM suppresses MEMORY_PRESSURE
    expect(modes).not.toContain("MEMORY_PRESSURE");
  });

  it("classifies MEMORY_PRESSURE on used%>=90 with no OOM", () => {
    const p = emptyParsed();
    p.memory = parseFreeH(FREE_OUT_PRESSURE);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).toContain("MEMORY_PRESSURE");
  });

  it("classifies BOOT_LOOP when uptime<5min + service journal failures", () => {
    const p = emptyParsed();
    p.uptime = parseUptime(UPTIME_SHORT);
    p.service_journal = parseJournalctl(JOURNAL_SERVICE_OUT);
    p.systemctl_status = parseSystemctlStatus(SYSTEMCTL_STATUS_FAILED);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).toContain("BOOT_LOOP");
  });

  it("does not classify BOOT_LOOP without multiple journal failures", () => {
    const p = emptyParsed();
    p.uptime = parseUptime(UPTIME_SHORT);
    // No service_journal entries
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).not.toContain("BOOT_LOOP");
  });

  it("classifies SERVICE_CRASHED on systemctl failed", () => {
    const p = emptyParsed();
    p.systemctl_status = parseSystemctlStatus(SYSTEMCTL_STATUS_FAILED);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes).toContain("SERVICE_CRASHED");
  });

  it("classifies SERVICE_NOT_LISTENING for active service with closed port", () => {
    const p = emptyParsed();
    p.ss_listening = parseSsListening(SS_MISSING_OUT, 8096);
    const modes = classifyFailureModes(p, { service: "jellyfin", port: 8096 });
    expect(modes).toContain("SERVICE_NOT_LISTENING");
    expect(modes).not.toContain("SERVICE_CRASHED");
  });

  it("classifies IO_ERROR over DISK_FULL when both present", () => {
    const p = emptyParsed();
    p.disks = parseDfH(DF_OUT);
    p.dmesg = parseDmesg(DMESG_IO);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    expect(modes[0]).toBe("IO_ERROR");
    expect(modes.indexOf("IO_ERROR")).toBeLessThan(modes.indexOf("DISK_FULL"));
  });

  it("respects FAILURE_MODE_PRIORITY ordering", () => {
    const p = emptyParsed();
    p.disks = parseDfH(DF_OUT);
    p.memory = parseFreeH(FREE_OUT_PRESSURE);
    p.systemctl_status = parseSystemctlStatus(SYSTEMCTL_STATUS_FAILED);
    const modes = classifyFailureModes(p, { service: "jellyfin" });
    const indexed = modes.map((m) => FAILURE_MODE_PRIORITY.indexOf(m));
    const sorted = [...indexed].sort((a, b) => a - b);
    expect(indexed).toEqual(sorted);
  });

  it("classifies KERNEL_ERROR for recent high-sev non-IO dmesg", () => {
    const now = new Date("2026-04-30T13:43:00Z");
    const p = emptyParsed();
    p.dmesg = [
      {
        timestamp_iso: "2026-04-30T13:42:30Z",
        level: "alert",
        message: "kernel panic - not syncing",
        severity: "high",
      },
    ];
    const modes = classifyFailureModes(p, { service: "jellyfin", now });
    expect(modes).toContain("KERNEL_ERROR");
  });

  it("does not classify KERNEL_ERROR for stale entries", () => {
    const now = new Date("2026-04-30T13:43:00Z");
    const p = emptyParsed();
    p.dmesg = [
      {
        timestamp_iso: "2026-04-29T00:00:00Z",
        level: "alert",
        message: "kernel panic - not syncing",
        severity: "high",
      },
    ];
    const modes = classifyFailureModes(p, { service: "jellyfin", now });
    expect(modes).not.toContain("KERNEL_ERROR");
  });
});

// ── Planner ─────────────────────────────────────────────────

describe("buildDiagnosticPlan", () => {
  it("DISK_FULL on /var → vacuum + apt-get clean", () => {
    const parsed: ParsedDiagnostics = emptyParsed();
    parsed.disks = [
      {
        filesystem: "/dev/sda2",
        size: "50G",
        used: "48G",
        available: "2.0G",
        used_pct: 96,
        mount_point: "/var",
        pressure: true,
      },
    ];
    const plan = buildDiagnosticPlan(["DISK_FULL"], { service: "jellyfin", parsed });
    expect(plan.steps.map((s) => s.command)).toEqual([
      "sudo journalctl --vacuum-size=500M",
      "sudo apt-get clean",
    ]);
    expect(plan.steps[0].tier).toBe("risky_write");
    expect(plan.steps[1].tier).toBe("safe_write");
  });

  it("DISK_FULL on / escalates to operator (Tier 5)", () => {
    const parsed: ParsedDiagnostics = emptyParsed();
    parsed.disks = [
      {
        filesystem: "/dev/sda1",
        size: "100G",
        used: "97G",
        available: "3G",
        used_pct: 97,
        mount_point: "/",
        pressure: true,
      },
    ];
    const plan = buildDiagnosticPlan(["DISK_FULL"], { service: "jellyfin", parsed });
    expect(plan.steps).toHaveLength(0);
    expect(plan.escalations[0].failure_mode).toBe("DISK_FULL");
  });

  it("MEMORY_OOM proposes restart + capacity escalation", () => {
    const plan = buildDiagnosticPlan(["MEMORY_OOM"], { service: "jellyfin" });
    expect(plan.steps[0].command).toMatch(/systemctl restart jellyfin/);
    expect(plan.steps[0].tier).toBe("risky_write");
    expect(plan.escalations.some((e) => e.failure_mode === "MEMORY_OOM")).toBe(true);
  });

  it("MEMORY_PRESSURE proposes restart + capacity escalation", () => {
    const plan = buildDiagnosticPlan(["MEMORY_PRESSURE"], { service: "jellyfin" });
    expect(plan.steps[0].command).toMatch(/systemctl restart/);
    expect(plan.escalations.some((e) => e.failure_mode === "MEMORY_PRESSURE")).toBe(true);
  });

  it("BOOT_LOOP proposes disable + escalation (no restart)", () => {
    const plan = buildDiagnosticPlan(["BOOT_LOOP"], { service: "jellyfin" });
    expect(plan.steps[0].command).toMatch(/systemctl disable jellyfin/);
    expect(plan.steps.every((s) => !/restart/.test(s.command))).toBe(true);
    expect(plan.escalations.some((e) => e.failure_mode === "BOOT_LOOP")).toBe(true);
  });

  it("SERVICE_CRASHED proposes a restart", () => {
    const plan = buildDiagnosticPlan(["SERVICE_CRASHED"], { service: "jellyfin" });
    expect(plan.steps[0].command).toBe("sudo systemctl restart jellyfin");
    expect(plan.steps[0].tier).toBe("risky_write");
  });

  it("SERVICE_NOT_LISTENING proposes a restart", () => {
    const plan = buildDiagnosticPlan(["SERVICE_NOT_LISTENING"], { service: "jellyfin" });
    expect(plan.steps[0].command).toBe("sudo systemctl restart jellyfin");
  });

  it("KERNEL_ERROR is operator-only (escalation, zero steps)", () => {
    const plan = buildDiagnosticPlan(["KERNEL_ERROR"], { service: "jellyfin" });
    expect(plan.steps).toHaveLength(0);
    expect(plan.escalations[0].failure_mode).toBe("KERNEL_ERROR");
  });

  it("IO_ERROR is escalate-only (suggest storage-pause)", () => {
    const plan = buildDiagnosticPlan(["IO_ERROR"], { service: "jellyfin" });
    expect(plan.steps).toHaveLength(0);
    expect(plan.escalations[0].reason).toMatch(/STORAGE_EXHAUSTION_PAUSE/);
  });

  it("does not propose duplicate restarts when multiple modes overlap", () => {
    const plan = buildDiagnosticPlan(
      ["MEMORY_OOM", "SERVICE_CRASHED", "SERVICE_NOT_LISTENING"],
      { service: "jellyfin" },
    );
    const restarts = plan.steps.filter((s) => s.command.includes("restart"));
    expect(restarts).toHaveLength(1);
  });

  it("registers tiers via PLAYBOOK_ACTION_TIERS", () => {
    expect(PLAYBOOK_ACTION_TIERS["systemctl restart"]).toBe("risky_write");
    expect(PLAYBOOK_ACTION_TIERS["apt-get clean"]).toBe("safe_write");
    expect(PLAYBOOK_ACTION_TIERS["systemctl disable"]).toBe("risky_write");
  });
});

// ── parseGatherBundle ───────────────────────────────────────

describe("parseGatherBundle", () => {
  it("composes parsers into a structured bundle", () => {
    const raw: GatherRaw = {
      df: DF_OUT,
      free: FREE_OUT_PRESSURE,
      uptime: UPTIME_LONG,
      systemctl_failed: SYSTEMCTL_FAILED_OUT,
      journalctl_service: JOURNAL_SERVICE_OUT,
      journalctl_system: "",
      dmesg: DMESG_OOM,
      ss: SS_MISSING_OUT,
      systemctl_status: SYSTEMCTL_STATUS_FAILED,
    };
    const parsed = parseGatherBundle(raw, { service: "jellyfin", port: 8096 });
    expect(parsed.disks).toHaveLength(4);
    expect(parsed.memory.pressure).toBe(true);
    expect(parsed.failed_units).toHaveLength(2);
    expect(parsed.dmesg[0].severity).toBe("high");
    expect(parsed.ss_listening.listening).toBe(false);
    expect(parsed.systemctl_status.active_state).toBe("failed");
  });

  it("skips ss listening check when no port provided", () => {
    const raw: GatherRaw = {
      df: "",
      free: "",
      uptime: "",
      systemctl_failed: "",
      journalctl_service: "",
      journalctl_system: "",
      dmesg: "",
      ss: SS_LISTENING_OUT,
      systemctl_status: "",
    };
    const parsed = parseGatherBundle(raw, { service: "jellyfin" });
    expect(parsed.ss_listening.listening).toBe(false);
  });
});

// ── End-to-end runner ──────────────────────────────────────

describe("runVmDiagnosticPlaybook", () => {
  it("SERVICE_CRASHED → restart → probe-200 happy path", async () => {
    const ex = makeExecutor({
      systemctl_status: SYSTEMCTL_STATUS_FAILED,
      systemctl_failed: SYSTEMCTL_FAILED_OUT,
      probe: () => ({ ok: true, status: 200 }),
    });
    const result = await runVmDiagnosticPlaybook(ex, {
      service: "jellyfin",
    });
    expect(result.failure_modes).toContain("SERVICE_CRASHED");
    expect(result.executed_steps).toHaveLength(1);
    expect(result.executed_steps[0].ok).toBe(true);
    expect(result.recovered).toBe(true);
    expect(ex.restarts).toBe(1);
  });

  it("DISK_FULL on /var → vacuum step is executed, escalates when still pressured", async () => {
    let probeCount = 0;
    const ex = makeExecutor({
      df: `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda2        50G   48G  2.0G  96% /var`,
      probe: () => {
        probeCount++;
        return { ok: false };
      },
    });
    const result = await runVmDiagnosticPlaybook(ex, { service: "jellyfin" });
    expect(result.failure_modes).toContain("DISK_FULL");
    expect(result.plan.steps.some((s) => s.command.includes("vacuum-size"))).toBe(true);
    // Probe never returned ok=true so we did NOT mark recovered.
    expect(result.recovered).toBe(false);
    expect(probeCount).toBeGreaterThan(0);
  });

  it("refuses BOOT_LOOP auto-action by default", async () => {
    const ex = makeExecutor({
      uptime: UPTIME_SHORT,
      journalctl_service: JOURNAL_SERVICE_OUT,
      systemctl_status: SYSTEMCTL_STATUS_FAILED,
    });
    const result = await runVmDiagnosticPlaybook(ex, { service: "jellyfin" });
    expect(result.failure_modes).toContain("BOOT_LOOP");
    expect(result.executed_steps).toHaveLength(0);
    expect(ex.restarts).toBe(0);
    expect(result.notes.some((n) => /BOOT_LOOP/.test(n))).toBe(true);
  });

  it("BOOT_LOOP with operator override (refuse_boot_loop_auto=false) runs disable step", async () => {
    const ex = makeExecutor({
      uptime: UPTIME_SHORT,
      journalctl_service: JOURNAL_SERVICE_OUT,
      systemctl_status: SYSTEMCTL_STATUS_FAILED,
    });
    const result = await runVmDiagnosticPlaybook(ex, {
      service: "jellyfin",
      refuse_boot_loop_auto: false,
    });
    expect(result.executed_steps.some((s) => s.command.includes("disable"))).toBe(true);
  });

  it("operator rejection short-circuits execute", async () => {
    const ex = makeExecutor({
      systemctl_status: SYSTEMCTL_STATUS_FAILED,
    });
    const result = await runVmDiagnosticPlaybook(ex, {
      service: "jellyfin",
      approve_plan: async () => false,
    });
    expect(result.executed_steps).toHaveLength(0);
    expect(result.notes.some((n) => /rejected/i.test(n))).toBe(true);
  });

  it("approve_plan is called with the assembled plan", async () => {
    const ex = makeExecutor({ systemctl_status: SYSTEMCTL_STATUS_FAILED });
    let seen: DiagnosticPlan | undefined;
    await runVmDiagnosticPlaybook(ex, {
      service: "jellyfin",
      approve_plan: async (p) => {
        seen = p;
        return true;
      },
    });
    expect(seen).toBeDefined();
    expect(seen?.failure_modes).toContain("SERVICE_CRASHED");
  });

  it("UNDETERMINED returns early without asking for approval", async () => {
    let asked = false;
    // All-healthy bundle: low-usage disks, normal memory, no failed units.
    const ex = makeExecutor({
      df: `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   10G   90G   10% /
tmpfs           4.0G     0  4.0G    0% /dev/shm`,
      free: FREE_OUT_HEALTHY,
      uptime: UPTIME_LONG,
      systemctl_status: SYSTEMCTL_STATUS_ACTIVE,
      ss: SS_LISTENING_OUT,
    });
    const result = await runVmDiagnosticPlaybook(ex, {
      service: "jellyfin",
      port: 8096,
      approve_plan: async () => {
        asked = true;
        return true;
      },
    });
    expect(result.failure_modes).toEqual(["UNDETERMINED"]);
    expect(asked).toBe(false);
    expect(result.phase).toBe("classify");
  });

  it("stops early when app probe recovers mid-plan", async () => {
    // Plan: DISK_FULL on /var generates 2 steps; probe returns 200 on
    // first call so the second step should NOT run.
    const ex = makeExecutor({
      df: `Filesystem  Size Used Avail Use% Mounted on
/dev/sda2   50G  48G  2G   96% /var`,
      probe: () => ({ ok: true, status: 200 }),
    });
    const result = await runVmDiagnosticPlaybook(ex, { service: "jellyfin" });
    expect(result.recovered).toBe(true);
    expect(result.executed_steps).toHaveLength(1);
  });

  it("records executed step failure when restartService fails", async () => {
    const ex = makeExecutor({
      systemctl_status: SYSTEMCTL_STATUS_FAILED,
      restartOk: false,
      restartError: "Unit not found",
      probe: () => ({ ok: false, status: 500 }),
    });
    const result = await runVmDiagnosticPlaybook(ex, { service: "jellyfin" });
    expect(result.executed_steps[0].ok).toBe(false);
    expect(result.executed_steps[0].error).toBe("Unit not found");
    expect(result.recovered).toBe(false);
    expect(result.notes.some((n) => /Step failed/.test(n))).toBe(true);
  });

  it("appends escalation messages to notes", async () => {
    const ex = makeExecutor({
      dmesg: DMESG_IO,
    });
    const result = await runVmDiagnosticPlaybook(ex, { service: "jellyfin" });
    expect(result.failure_modes).toContain("IO_ERROR");
    expect(result.notes.some((n) => /IO_ERROR/.test(n))).toBe(true);
    expect(result.notes.some((n) => /STORAGE_EXHAUSTION_PAUSE/.test(n))).toBe(true);
  });
});
