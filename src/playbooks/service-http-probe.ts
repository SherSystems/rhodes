// ============================================================
// RHODES — Service-level HTTP Probe Playbook
//
// Generic, reusable playbook that detects "VM up but app down"
// failure modes. Today's Proxmox-level monitoring sees a VM as
// `running` while the actual systemd service inside the guest
// is crashed, deadlocked, or hung. Users notice — RHODES does
// not. This playbook closes that gap.
//
// Canonical first user: Jellyfin (vmid 101 on pranavlab). The
// shape is intentionally service-agnostic; register one config
// per in-VM HTTP service.
//
// Detection chain:
//   1. periodic HTTP GET against `<probe_url>`
//   2. N consecutive failures (default 3) → ServiceUnreachable
//   3. ping the VM → distinguish VM down vs service down
//   4. SSH `systemctl is-active <service>` → classify
//        - SERVICE_DOWN       systemd inactive/failed
//        - SERVICE_UNHEALTHY  systemd active but HTTP still failing
//        - VM_UNREACHABLE     ping fails — hand off to VM-level
//   5. Tier 2 SAFE_WRITE: `sudo systemctl restart <service>`
//   6. verify recovery: 10s grace + 3 re-probes over 30s
//   7. restart-loop guard: ≥3 restarts in 30min → stop, alert
//
// This file is the canonical reference for how RHODES handles
// the SERVICE_DOWN / SERVICE_UNHEALTHY event classes.
// ============================================================

import type { ActionTier } from "../providers/types.js";
import type { EventBus } from "../agent/events.js";
import { AgentEventType } from "../types.js";

// ── Constants & Policy ──────────────────────────────────────

/** Default consecutive-probe-failure threshold before classifying. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Default HTTP probe interval. */
export const DEFAULT_PROBE_INTERVAL_SECS = 60;

/** Default per-probe HTTP timeout. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Default ping timeout used by the diagnostic chain. */
export const DEFAULT_PING_TIMEOUT_MS = 3000;

/** Default backoff: refuse to auto-restart more than 3 times in 30 min. */
export const DEFAULT_RESTART_BACKOFF_WINDOW_MINS = 30;
export const DEFAULT_MAX_RESTARTS_IN_WINDOW = 3;

/** Verify phase timings. */
export const VERIFY_INITIAL_DELAY_MS = 10_000;
export const VERIFY_REPROBE_INTERVAL_MS = 10_000;
export const VERIFY_REPROBE_COUNT = 3;

/** Action tiers for systemctl commands this playbook may issue.
 *  `restart` is idempotent + well-understood → Tier 2 (SAFE_WRITE).
 *  Policy still lets the operator gate it via the standard approval
 *  path; we just don't classify it as risky_write by default. */
export const PLAYBOOK_ACTION_TIERS: Record<string, ActionTier> = {
  "systemctl restart": "safe_write",
  "systemctl is-active": "read",
  "systemctl status": "read",
};

// ── Public Types ────────────────────────────────────────────

export type ServiceClassification =
  | "SERVICE_DOWN" // systemd inactive/failed — restart in scope
  | "SERVICE_UNHEALTHY" // systemd active but HTTP probe still failing
  | "VM_UNREACHABLE" // ping fails — hand off, do NOT restart
  | "HEALTHY" // probe currently succeeds (post-verify)
  | "UNDETERMINED";

export interface ServiceProbeConfig {
  /** Stable identifier — used for events, restart-loop tracking. */
  name: string;
  /** systemd unit name inside the VM (without `.service`). */
  service_name: string;
  /** Full URL hit by the HTTP probe (e.g. `http://host:8096/health`). */
  probe_url: string;
  /** SSH target id (must be registered with SshAdapter) OR `user@host`
   *  if you're going via the lightweight executor contract below. */
  ssh_target: string;
  /** Ping target (defaults to the host portion of `probe_url`). */
  ping_host?: string;
  probe_interval_secs?: number;
  probe_timeout_ms?: number;
  failure_threshold?: number;
  /** Restart-loop guard window, in minutes. */
  restart_backoff_window_mins?: number;
  /** Max restarts allowed within the guard window. */
  max_restarts_in_window?: number;
  /** Optional: a substring/regex the body must contain for a 200 to count
   *  as healthy. Default: empty string (any 200 OK is fine). */
  healthy_body_match?: string | RegExp;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  elapsed_ms: number;
  timestamp: string;
}

export interface DiagnosticResult {
  classification: ServiceClassification;
  ping_ok: boolean;
  systemctl_state?: string;
  systemctl_status_tail?: string;
  notes: string[];
}

export interface RestartStep {
  command: string;
  description: string;
  tier: ActionTier;
}

export interface RemediationPlan {
  classification: ServiceClassification;
  service_name: string;
  ssh_target: string;
  steps: RestartStep[];
  /** True if we refuse to auto-remediate (VM unreachable or restart-loop). */
  hand_off: boolean;
  hand_off_reason?: string;
}

export interface VerifyResult {
  recovered: boolean;
  probes: ProbeResult[];
}

export interface RestartHistoryEntry {
  service: string;
  at: string;
  success: boolean;
}

// ── Probe Executor Contract ─────────────────────────────────
//
// The playbook does NOT call fetch() / ping / ssh directly. It
// expects an executor implementing this interface — that's how
// tests mock everything and how production wires the adapters.

export interface ServiceProbeExecutor {
  /** HTTP GET <url> with a timeout. */
  httpProbe(url: string, timeoutMs: number): Promise<ProbeResult>;
  /** Ping the VM. true = reachable. */
  ping(host: string, timeoutMs: number): Promise<boolean>;
  /** `systemctl is-active <service>` — returns the literal output
   *  ("active", "inactive", "failed", etc.). */
  systemctlIsActive(
    target: string,
    service: string,
  ): Promise<{ state: string; ok: boolean }>;
  /** `systemctl status <service> --no-pager | head -20`. */
  systemctlStatus(
    target: string,
    service: string,
  ): Promise<{ stdout: string; ok: boolean }>;
  /** `sudo systemctl restart <service>`. */
  systemctlRestart(
    target: string,
    service: string,
  ): Promise<{ ok: boolean; error?: string }>;
  sleep(ms: number): Promise<void>;
  /** Current time — injected so tests can fake the restart-loop window. */
  now(): Date;
}

// ── Probe Loop State ────────────────────────────────────────

export interface ServiceProbeState {
  /** Number of consecutive HTTP probe failures. Resets to 0 on a success. */
  consecutive_failures: number;
  /** Most recent probe result, for the dashboard. */
  last_probe?: ProbeResult;
  /** ServiceUnreachable event fired for the current failure streak. */
  unreachable_event_fired: boolean;
}

export function freshState(): ServiceProbeState {
  return {
    consecutive_failures: 0,
    unreachable_event_fired: false,
  };
}

// ── Healthy/Unhealthy Probe Verdict ─────────────────────────

export function isProbeHealthy(
  probe: ProbeResult,
  matcher?: string | RegExp,
): boolean {
  if (!probe.ok) return false;
  if (probe.status !== 200) return false;
  if (!matcher) return true;
  const body = probe.body ?? "";
  if (matcher instanceof RegExp) return matcher.test(body);
  return body.includes(matcher);
}

// ── Probe-Loop Step ─────────────────────────────────────────
//
// One iteration of the loop: do one HTTP probe, update state,
// optionally emit ServiceUnreachable. Pure decision module —
// no scheduling, no I/O loops. The autopilot (or test) calls
// this on a timer.

export interface ProbeIterationResult {
  probe: ProbeResult;
  state: ServiceProbeState;
  /** True when this iteration crossed the failure threshold. */
  threshold_crossed: boolean;
}

export async function runProbeIteration(
  executor: ServiceProbeExecutor,
  config: ServiceProbeConfig,
  state: ServiceProbeState,
  eventBus?: EventBus,
): Promise<ProbeIterationResult> {
  const timeoutMs = config.probe_timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probe = await executor.httpProbe(config.probe_url, timeoutMs);
  const healthy = isProbeHealthy(probe, config.healthy_body_match);

  const next: ServiceProbeState = {
    consecutive_failures: healthy ? 0 : state.consecutive_failures + 1,
    last_probe: probe,
    unreachable_event_fired: healthy ? false : state.unreachable_event_fired,
  };

  const threshold =
    config.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD;
  const thresholdCrossed =
    !healthy &&
    next.consecutive_failures >= threshold &&
    !state.unreachable_event_fired;

  if (thresholdCrossed) {
    next.unreachable_event_fired = true;
    emit(eventBus, AgentEventType.ServiceUnreachable, {
      service_name: config.service_name,
      playbook: config.name,
      probe_url: config.probe_url,
      consecutive_failures: next.consecutive_failures,
      last_error: probe.error,
      last_status: probe.status,
    });
  }

  return { probe, state: next, threshold_crossed: thresholdCrossed };
}

// ── Diagnostic Chain ────────────────────────────────────────

export async function diagnose(
  executor: ServiceProbeExecutor,
  config: ServiceProbeConfig,
): Promise<DiagnosticResult> {
  const notes: string[] = [];
  const pingHost = config.ping_host ?? hostOfUrl(config.probe_url);

  const pingOk = await executor.ping(
    pingHost,
    DEFAULT_PING_TIMEOUT_MS,
  );

  if (!pingOk) {
    notes.push(
      `Ping to ${pingHost} failed — VM unreachable, escalate to VM-level playbook.`,
    );
    return {
      classification: "VM_UNREACHABLE",
      ping_ok: false,
      notes,
    };
  }

  const active = await executor.systemctlIsActive(
    config.ssh_target,
    config.service_name,
  );
  const statusOut = await executor.systemctlStatus(
    config.ssh_target,
    config.service_name,
  );

  const stateText = active.state.trim().toLowerCase();
  const statusTail = headLines(statusOut.stdout, 20);

  let classification: ServiceClassification;
  if (stateText === "active" || stateText === "activating") {
    classification = "SERVICE_UNHEALTHY";
    notes.push(
      `systemctl reports "${stateText}" yet HTTP probe failed — likely deadlock, hang, or application-layer bug.`,
    );
  } else if (
    stateText === "inactive" ||
    stateText === "failed" ||
    stateText === "deactivating"
  ) {
    classification = "SERVICE_DOWN";
    notes.push(`systemctl reports "${stateText}".`);
  } else {
    classification = "UNDETERMINED";
    notes.push(`systemctl reported an unrecognized state: "${active.state}".`);
  }

  return {
    classification,
    ping_ok: true,
    systemctl_state: active.state,
    systemctl_status_tail: statusTail,
    notes,
  };
}

// ── Plan Builder ────────────────────────────────────────────

export function buildRemediationPlan(
  config: ServiceProbeConfig,
  diagnostic: DiagnosticResult,
): RemediationPlan {
  const base: RemediationPlan = {
    classification: diagnostic.classification,
    service_name: config.service_name,
    ssh_target: config.ssh_target,
    steps: [],
    hand_off: false,
  };

  if (diagnostic.classification === "VM_UNREACHABLE") {
    base.hand_off = true;
    base.hand_off_reason =
      "Ping failed — handing off to the VM-level recovery playbook. Service-level restart would be premature.";
    return base;
  }

  if (
    diagnostic.classification !== "SERVICE_DOWN" &&
    diagnostic.classification !== "SERVICE_UNHEALTHY"
  ) {
    base.hand_off = true;
    base.hand_off_reason = `Classification "${diagnostic.classification}" is not auto-remediable.`;
    return base;
  }

  const flavor =
    diagnostic.classification === "SERVICE_UNHEALTHY"
      ? `Service self-reported healthy but HTTP probe failed — restart anyway (suspect deadlock/hang).`
      : `Service is inactive/failed — restart.`;

  base.steps.push({
    command: `sudo systemctl restart ${config.service_name}`,
    description: `Restart ${config.service_name}. ${flavor}`,
    tier: PLAYBOOK_ACTION_TIERS["systemctl restart"],
  });

  return base;
}

// ── Restart-Loop Guard ──────────────────────────────────────
//
// Tracks restart attempts so the playbook refuses to flap forever.
// The history is intentionally in-memory + injected; the autopilot
// owns persistence if it cares to survive restarts of RHODES itself.

export interface RestartLoopGuardInput {
  config: ServiceProbeConfig;
  history: RestartHistoryEntry[];
  now: Date;
}

export interface RestartLoopGuardResult {
  loop_detected: boolean;
  restarts_in_window: number;
  window_started_at: string;
}

export function detectRestartLoop(
  input: RestartLoopGuardInput,
): RestartLoopGuardResult {
  const max = input.config.max_restarts_in_window ?? DEFAULT_MAX_RESTARTS_IN_WINDOW;
  const windowMins =
    input.config.restart_backoff_window_mins ??
    DEFAULT_RESTART_BACKOFF_WINDOW_MINS;
  const windowMs = windowMins * 60 * 1000;
  const cutoff = input.now.getTime() - windowMs;

  const recent = input.history.filter(
    (h) =>
      h.service === input.config.service_name &&
      new Date(h.at).getTime() >= cutoff,
  );

  return {
    loop_detected: recent.length >= max,
    restarts_in_window: recent.length,
    window_started_at: new Date(cutoff).toISOString(),
  };
}

// ── Verify Phase ────────────────────────────────────────────

export async function verifyRecovery(
  executor: ServiceProbeExecutor,
  config: ServiceProbeConfig,
  options: {
    initial_delay_ms?: number;
    reprobe_interval_ms?: number;
    reprobe_count?: number;
  } = {},
): Promise<VerifyResult> {
  const initialDelay = options.initial_delay_ms ?? VERIFY_INITIAL_DELAY_MS;
  const interval = options.reprobe_interval_ms ?? VERIFY_REPROBE_INTERVAL_MS;
  const count = options.reprobe_count ?? VERIFY_REPROBE_COUNT;
  const probeTimeout = config.probe_timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes: ProbeResult[] = [];

  await executor.sleep(initialDelay);

  let successes = 0;
  for (let i = 0; i < count; i++) {
    const p = await executor.httpProbe(config.probe_url, probeTimeout);
    probes.push(p);
    if (isProbeHealthy(p, config.healthy_body_match)) {
      successes++;
    }
    // Don't sleep after the last probe
    if (i < count - 1) await executor.sleep(interval);
  }

  // "Sustained recovery" = strict majority succeeds AND the last probe
  // succeeded (catches the "one flap then stable" path).
  const recovered =
    successes >= Math.ceil(count / 2) &&
    isProbeHealthy(probes[probes.length - 1]!, config.healthy_body_match);

  return { recovered, probes };
}

// ── End-to-End Runner ──────────────────────────────────────

export interface RunOptions {
  config: ServiceProbeConfig;
  /** Mutable restart history — the runner appends new entries. */
  restart_history: RestartHistoryEntry[];
  /** Optional approval gate (Tier 2 still respects per-call policy). */
  approve_restart?: (plan: RemediationPlan) => Promise<boolean>;
}

export interface RunResult {
  diagnostic: DiagnosticResult;
  plan: RemediationPlan;
  restart_executed: boolean;
  loop_guard: RestartLoopGuardResult;
  verify?: VerifyResult;
  recovered: boolean;
  notes: string[];
}

/**
 * Drive the diagnostic → plan → restart → verify chain once. Call
 * AFTER `runProbeIteration` has crossed the failure threshold.
 *
 * This function does NOT loop. The autopilot owns scheduling.
 */
export async function runServiceProbePlaybook(
  executor: ServiceProbeExecutor,
  options: RunOptions,
  eventBus?: EventBus,
): Promise<RunResult> {
  const notes: string[] = [];
  const { config } = options;

  // 1. Diagnose
  const diagnostic = await diagnose(executor, config);

  if (diagnostic.classification === "VM_UNREACHABLE") {
    notes.push(...diagnostic.notes);
    // No ServiceDown / ServiceUnhealthy event — hand off cleanly.
    const plan = buildRemediationPlan(config, diagnostic);
    return {
      diagnostic,
      plan,
      restart_executed: false,
      loop_guard: {
        loop_detected: false,
        restarts_in_window: 0,
        window_started_at: executor.now().toISOString(),
      },
      recovered: false,
      notes,
    };
  }

  // 2. Emit the classified state.
  if (diagnostic.classification === "SERVICE_DOWN") {
    emit(eventBus, AgentEventType.ServiceDown, {
      service_name: config.service_name,
      playbook: config.name,
      ssh_target: config.ssh_target,
      systemctl_state: diagnostic.systemctl_state,
      status_tail: diagnostic.systemctl_status_tail,
    });
  } else if (diagnostic.classification === "SERVICE_UNHEALTHY") {
    emit(eventBus, AgentEventType.ServiceUnhealthy, {
      service_name: config.service_name,
      playbook: config.name,
      ssh_target: config.ssh_target,
      systemctl_state: diagnostic.systemctl_state,
      status_tail: diagnostic.systemctl_status_tail,
      // Stronger language for the operator — systemd lied to us.
      message:
        `${config.service_name}: systemd reports "${diagnostic.systemctl_state}" but HTTP probe failed. ` +
        `Suspected hang/deadlock — restarting.`,
    });
  }

  // 3. Restart-loop guard
  const loopGuard = detectRestartLoop({
    config,
    history: options.restart_history,
    now: executor.now(),
  });

  if (loopGuard.loop_detected) {
    notes.push(
      `Restart-loop guard tripped — ${loopGuard.restarts_in_window} restarts since ${loopGuard.window_started_at}. ` +
        `Stopping auto-remediation; operator must intervene.`,
    );
    emit(eventBus, AgentEventType.ServiceRestartLoopDetected, {
      service_name: config.service_name,
      playbook: config.name,
      restarts_in_window: loopGuard.restarts_in_window,
      window_started_at: loopGuard.window_started_at,
    });
    const plan = buildRemediationPlan(config, diagnostic);
    plan.hand_off = true;
    plan.hand_off_reason = "Restart-loop guard — see ServiceRestartLoopDetected event.";
    return {
      diagnostic,
      plan,
      restart_executed: false,
      loop_guard: loopGuard,
      recovered: false,
      notes,
    };
  }

  // 4. Build + maybe approve plan
  const plan = buildRemediationPlan(config, diagnostic);
  if (plan.hand_off || plan.steps.length === 0) {
    notes.push(
      plan.hand_off_reason ?? "Plan was empty — nothing to do.",
    );
    return {
      diagnostic,
      plan,
      restart_executed: false,
      loop_guard: loopGuard,
      recovered: false,
      notes,
    };
  }

  if (options.approve_restart) {
    const ok = await options.approve_restart(plan);
    if (!ok) {
      notes.push("Operator rejected restart plan.");
      return {
        diagnostic,
        plan,
        restart_executed: false,
        loop_guard: loopGuard,
        recovered: false,
        notes,
      };
    }
  }

  // 5. Execute restart
  const restart = await executor.systemctlRestart(
    config.ssh_target,
    config.service_name,
  );
  options.restart_history.push({
    service: config.service_name,
    at: executor.now().toISOString(),
    success: restart.ok,
  });

  if (!restart.ok) {
    notes.push(`systemctl restart failed: ${restart.error ?? "unknown"}.`);
    return {
      diagnostic,
      plan,
      restart_executed: false,
      loop_guard: loopGuard,
      recovered: false,
      notes,
    };
  }

  // 6. Verify
  const verify = await verifyRecovery(executor, config);

  if (verify.recovered) {
    emit(eventBus, AgentEventType.ServiceRecovered, {
      service_name: config.service_name,
      playbook: config.name,
      probes: verify.probes.length,
    });
  } else {
    notes.push(
      `Verification failed — service did not stay healthy across ${verify.probes.length} re-probes.`,
    );
  }

  return {
    diagnostic,
    plan,
    restart_executed: true,
    loop_guard: loopGuard,
    verify,
    recovered: verify.recovered,
    notes,
  };
}

// ── Helpers ─────────────────────────────────────────────────

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Fall back to a best-effort substring — still useful for tests.
    const m = url.match(/^[a-z]+:\/\/([^/:]+)/i);
    return m?.[1] ?? url;
  }
}

function headLines(text: string, n: number): string {
  return text.split("\n").slice(0, n).join("\n");
}

function emit(
  bus: EventBus | undefined,
  type: AgentEventType,
  data: Record<string, unknown>,
): void {
  if (!bus) return;
  bus.emit({
    type,
    timestamp: new Date().toISOString(),
    data,
  });
}

// ── Default Config Helpers (env wiring) ─────────────────────

/** Read a string env var with a fallback. */
export function strFromEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const v = env[key];
  return v && v.length > 0 ? v : fallback;
}

/** Read a positive integer env var with a fallback. */
export function intFromEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const v = env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build the canonical Jellyfin service-probe config from env. */
export function jellyfinConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServiceProbeConfig {
  return {
    name: "jellyfin-service-probe",
    service_name: "jellyfin",
    probe_url: strFromEnv(
      env,
      "JELLYFIN_PROBE_URL",
      "http://100.105.89.123:8096/health",
    ),
    ssh_target: strFromEnv(
      env,
      "JELLYFIN_SSH_TARGET",
      "pranav@100.105.89.123",
    ),
    probe_interval_secs: intFromEnv(
      env,
      "JELLYFIN_PROBE_INTERVAL_SECS",
      DEFAULT_PROBE_INTERVAL_SECS,
    ),
    probe_timeout_ms: intFromEnv(
      env,
      "JELLYFIN_PROBE_TIMEOUT_MS",
      DEFAULT_PROBE_TIMEOUT_MS,
    ),
    failure_threshold: intFromEnv(
      env,
      "JELLYFIN_FAILURE_THRESHOLD",
      DEFAULT_FAILURE_THRESHOLD,
    ),
    restart_backoff_window_mins: DEFAULT_RESTART_BACKOFF_WINDOW_MINS,
    max_restarts_in_window: DEFAULT_MAX_RESTARTS_IN_WINDOW,
    // Jellyfin's /health returns the literal string "Healthy" with HTTP 200.
    healthy_body_match: "Healthy",
  };
}
