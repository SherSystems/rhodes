// ============================================================
// vClaw — Probe State Tracker
// In-memory state for service-health probes:
//   - consecutive_failures per (probe, target)
//   - last fire / last success times for transition detection
//   - per-(probe, target) cooldowns for restart_vm dampening
//
// Modeled on RuleStateTracker but keyed on the probe's identity
// rather than rule+entity. Probes are first-class scheduled
// objects, while rules are reactive matches over cluster state.
// ============================================================

import type { ProbeDef } from "./schema.js";

/** Composite key: `${probe.id}:${target}`. Stable across restarts. */
export type ProbeKey = string;

interface ProbeRecord {
  /** Number of consecutive failed probe results since last success. */
  consecutiveFailures: number;
  /** Wall-clock ms epoch of the most recent probe execution. */
  lastCheck: number;
  /** Wall-clock ms epoch of the most recent successful probe. */
  lastSuccess?: number;
  /** Wall-clock ms epoch of the most recent failure. */
  lastFailure?: number;
  /** Wall-clock ms epoch of the most recent remediation attempt. */
  lastRemediation?: number;
  /** Whether the probe is currently in the "alerting" phase
   *  (consecutive_failures >= failures_to_alert). Drives recovery
   *  detection — when it flips back to false we emit ProbeRecovered. */
  alerting: boolean;
}

/**
 * Build the per-probe-target dedupe key. A single probe can target one
 * VM/host today, but the format reserves room for fan-out later.
 */
export function buildProbeKey(probe: ProbeDef): ProbeKey {
  const target =
    probe.target_vm_id !== undefined
      ? String(probe.target_vm_id)
      : (probe.target_host ?? "_anon");
  return `${probe.id}:${target}`;
}

// ── Outcome of `recordResult` ──────────────────────────────

export type ProbeOutcome =
  | { kind: "success"; transitionedToHealthy: boolean }
  | { kind: "failure"; consecutiveFailures: number; crossedThreshold: boolean };

// ── Tracker ────────────────────────────────────────────────

export class ProbeStateTracker {
  private records = new Map<ProbeKey, ProbeRecord>();

  /**
   * Record the outcome of a probe run.
   *
   * Returns a structured `ProbeOutcome` describing the transition so the
   * scheduler can decide which event(s) to emit (Succeeded / Failed /
   * Recovered) and whether the `service_unreachable` rule should fire.
   */
  recordResult(
    probe: ProbeDef,
    ok: boolean,
    now: Date,
  ): ProbeOutcome {
    const key = buildProbeKey(probe);
    const nowMs = now.getTime();
    const rec: ProbeRecord = this.records.get(key) ?? {
      consecutiveFailures: 0,
      lastCheck: 0,
      alerting: false,
    };

    rec.lastCheck = nowMs;

    if (ok) {
      const wasAlerting = rec.alerting;
      rec.consecutiveFailures = 0;
      rec.lastSuccess = nowMs;
      rec.alerting = false;
      this.records.set(key, rec);
      return { kind: "success", transitionedToHealthy: wasAlerting };
    }

    rec.consecutiveFailures += 1;
    rec.lastFailure = nowMs;

    const threshold = probe.failures_to_alert ?? 3;
    const crossed =
      !rec.alerting && rec.consecutiveFailures >= threshold;
    if (crossed) rec.alerting = true;

    this.records.set(key, rec);
    return {
      kind: "failure",
      consecutiveFailures: rec.consecutiveFailures,
      crossedThreshold: crossed,
    };
  }

  /**
   * Whether the (probe, target) is currently considered alerting — i.e.
   * `consecutive_failures >= failures_to_alert` and not yet recovered.
   */
  isAlerting(probe: ProbeDef): boolean {
    return this.records.get(buildProbeKey(probe))?.alerting ?? false;
  }

  /**
   * Number of consecutive failures since the last successful probe.
   */
  consecutiveFailures(probe: ProbeDef): number {
    return this.records.get(buildProbeKey(probe))?.consecutiveFailures ?? 0;
  }

  /**
   * Whether enough time has elapsed since the last remediation to allow
   * another. Returns `{ admitted: true }` if no remediation has happened
   * yet, or if the cooldown has expired.
   */
  canRemediate(
    probe: ProbeDef,
    now: Date,
  ): { admitted: true } | { admitted: false; retryAfterMs: number } {
    const rec = this.records.get(buildProbeKey(probe));
    if (!rec || rec.lastRemediation === undefined) return { admitted: true };
    const cooldownMs = (probe.cooldown_s ?? 300) * 1000;
    const elapsed = now.getTime() - rec.lastRemediation;
    if (elapsed >= cooldownMs) return { admitted: true };
    return { admitted: false, retryAfterMs: cooldownMs - elapsed };
  }

  /** Mark a remediation attempt — call after dispatching restart_vm. */
  recordRemediation(probe: ProbeDef, now: Date): void {
    const key = buildProbeKey(probe);
    const rec = this.records.get(key) ?? {
      consecutiveFailures: 0,
      lastCheck: 0,
      alerting: false,
    };
    rec.lastRemediation = now.getTime();
    this.records.set(key, rec);
  }

  /** Reset state for one probe or all probes. */
  reset(probeId?: string): void {
    if (probeId === undefined) {
      this.records.clear();
      return;
    }
    const prefix = `${probeId}:`;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }

  /** Snapshot for dashboards and tests. */
  snapshot(): Array<{
    key: string;
    consecutiveFailures: number;
    lastCheck: number;
    lastSuccess?: number;
    lastFailure?: number;
    lastRemediation?: number;
    alerting: boolean;
  }> {
    return [...this.records.entries()].map(([key, rec]) => ({
      key,
      consecutiveFailures: rec.consecutiveFailures,
      lastCheck: rec.lastCheck,
      lastSuccess: rec.lastSuccess,
      lastFailure: rec.lastFailure,
      lastRemediation: rec.lastRemediation,
      alerting: rec.alerting,
    }));
  }
}

// ── Provider-Adapter State Tracker ──────────────────────────

/**
 * Sibling tracker for provider-adapter unreachability. A provider has
 * no `failures_to_alert` knob in config — it uses the daemon-wide
 * defaults — but otherwise behaves like the probe tracker.
 */
export interface ProviderHealthRecord {
  consecutiveFailures: number;
  lastCheck: number;
  lastSuccess?: number;
  lastFailure?: number;
  lastError?: string;
  alerting: boolean;
}

export interface ProviderHealthOutcome {
  ok: boolean;
  consecutiveFailures: number;
  crossedThreshold: boolean;
  transitionedToHealthy: boolean;
}

export class ProviderHealthTracker {
  private records = new Map<string, ProviderHealthRecord>();
  private threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  recordResult(
    providerName: string,
    ok: boolean,
    now: Date,
    error?: string,
  ): ProviderHealthOutcome {
    const nowMs = now.getTime();
    const rec: ProviderHealthRecord = this.records.get(providerName) ?? {
      consecutiveFailures: 0,
      lastCheck: 0,
      alerting: false,
    };
    rec.lastCheck = nowMs;

    if (ok) {
      const wasAlerting = rec.alerting;
      rec.consecutiveFailures = 0;
      rec.lastSuccess = nowMs;
      rec.alerting = false;
      rec.lastError = undefined;
      this.records.set(providerName, rec);
      return {
        ok: true,
        consecutiveFailures: 0,
        crossedThreshold: false,
        transitionedToHealthy: wasAlerting,
      };
    }

    rec.consecutiveFailures += 1;
    rec.lastFailure = nowMs;
    rec.lastError = error;

    const crossed =
      !rec.alerting && rec.consecutiveFailures >= this.threshold;
    if (crossed) rec.alerting = true;
    this.records.set(providerName, rec);
    return {
      ok: false,
      consecutiveFailures: rec.consecutiveFailures,
      crossedThreshold: crossed,
      transitionedToHealthy: false,
    };
  }

  isAlerting(providerName: string): boolean {
    return this.records.get(providerName)?.alerting ?? false;
  }

  snapshot(): Array<
    ProviderHealthRecord & { name: string }
  > {
    return [...this.records.entries()].map(([name, rec]) => ({
      name,
      ...rec,
    }));
  }

  reset(): void {
    this.records.clear();
  }
}
