// ============================================================
// vClaw — Probe Scheduler
//
// A small subsystem that:
//   - Loads probe definitions from config
//   - Schedules each probe at its configured interval (independent
//     timers per probe — a slow probe never starves another)
//   - Records consecutive failure counts in a `ProbeStateTracker`
//   - Emits `ProbeSucceeded` / `ProbeFailed` / `ProbeRecovered` events
//   - Records provider-adapter health on every poll tick of the
//     parent autopilot daemon
//
// Design decision (from the brief): we run our OWN timers per-probe
// rather than piggy-back on the daemon's poll loop, because probe
// intervals are commonly 10–60s while the cluster-state poll runs
// every 30s by default. Coupling the two would either over-poll the
// daemon or under-sample probes. The provider-adapter check, in
// contrast, IS hooked into the daemon poll because it has the same
// natural cadence.
//
// All state is in-memory; on restart probes start fresh. That matches
// the existing `RuleStateTracker`/`AutopilotDaemon` behavior.
// ============================================================

import { AgentEventType, type AgentEvent } from "../../types.js";
import type { EventBus } from "../../agent/events.js";
import type { ToolRegistry } from "../../providers/registry.js";
import type { ProbeDef } from "./schema.js";
import {
  type ProbeRunner,
  type ProbeResult,
  type ProberOverrides,
  runProbe,
} from "./probers.js";
import {
  ProbeStateTracker,
  ProviderHealthTracker,
  buildProbeKey,
} from "./probe-state.js";

// ── Configuration ───────────────────────────────────────────

export interface ProbeSchedulerConfig {
  /** Probe definitions to schedule. */
  probes: ProbeDef[];
  /** Optional runner overrides for tests. Maps kind → runner. */
  runnerOverrides?: ProberOverrides;
  /** Default consecutive-failure threshold for provider-unreachable. */
  providerFailuresToAlert?: number;
  /** Manual clock injection (tests use vi fake timers normally). */
  now?: () => Date;
}

// ── Active Probe Bookkeeping ────────────────────────────────

interface ActiveProbe {
  probe: ProbeDef;
  timer: ReturnType<typeof setInterval> | null;
  /** Concurrency guard — never run a probe while a prior run is in flight. */
  inFlight: boolean;
}

// ── Scheduler ───────────────────────────────────────────────

export class ProbeScheduler {
  private eventBus: EventBus;
  private registry: ToolRegistry | null;
  private probes: ProbeDef[];
  private active: Map<string, ActiveProbe> = new Map();
  private overrides: ProberOverrides;
  private state = new ProbeStateTracker();
  private providerHealth: ProviderHealthTracker;
  private now: () => Date;
  private running = false;

  constructor(
    eventBus: EventBus,
    registry: ToolRegistry | null,
    config: ProbeSchedulerConfig,
  ) {
    this.eventBus = eventBus;
    this.registry = registry;
    this.probes = config.probes ?? [];
    this.overrides = config.runnerOverrides ?? {};
    this.providerHealth = new ProviderHealthTracker(
      config.providerFailuresToAlert ?? 3,
    );
    this.now = config.now ?? (() => new Date());
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Start a timer for each enabled probe. Each probe runs its first
   * check immediately, then every `interval_s` seconds.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const probe of this.probes) {
      if (!probe.enabled) continue;
      this.scheduleProbe(probe);
    }
  }

  /**
   * Stop all probe timers. Idempotent.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const active of this.active.values()) {
      if (active.timer) clearInterval(active.timer);
    }
    this.active.clear();
  }

  /** True while at least one probe is scheduled. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Snapshot of probe state — exposed for the dashboard's Operations
   * tab and for tests asserting on consecutive-failure counts.
   */
  getProbeStateSnapshot(): ReturnType<ProbeStateTracker["snapshot"]> {
    return this.state.snapshot();
  }

  /** Snapshot of provider-adapter health. */
  getProviderHealthSnapshot(): ReturnType<ProviderHealthTracker["snapshot"]> {
    return this.providerHealth.snapshot();
  }

  /** Live probe definitions — in case the dashboard wants to render them. */
  getProbes(): ProbeDef[] {
    return [...this.probes];
  }

  /**
   * Whether a probe is currently in the alerting state — used by the
   * `service_unreachable` rule evaluator to decide if it should fire.
   */
  isProbeAlerting(probeId: string): boolean {
    const probe = this.probes.find((p) => p.id === probeId);
    if (!probe) return false;
    return this.state.isAlerting(probe);
  }

  /**
   * Whether a provider adapter is currently considered unreachable.
   */
  isProviderUnreachable(providerName: string): boolean {
    return this.providerHealth.isAlerting(providerName);
  }

  /**
   * Record that a remediation was dispatched for a probe — sets the
   * cooldown clock so a flapping VM isn't power-cycled in a loop.
   */
  recordRemediation(probeId: string, now: Date): void {
    const probe = this.probes.find((p) => p.id === probeId);
    if (!probe) return;
    this.state.recordRemediation(probe, now);
  }

  /**
   * Whether enough time has passed since the last remediation for the
   * given probe.
   */
  canRemediate(
    probeId: string,
    now: Date,
  ): { admitted: true } | { admitted: false; retryAfterMs: number } {
    const probe = this.probes.find((p) => p.id === probeId);
    if (!probe) return { admitted: true };
    return this.state.canRemediate(probe, now);
  }

  /**
   * Get the probe def by id (used by the rule handler when restart_vm
   * needs to look up the target VM).
   */
  getProbe(probeId: string): ProbeDef | undefined {
    return this.probes.find((p) => p.id === probeId);
  }

  /**
   * Probe the connection state of every registered hypervisor adapter.
   * Called from the daemon's poll loop. Adapters whose `isConnected()`
   * returns false count as a failure; those that throw are also failures.
   */
  pollProviders(): void {
    if (!this.registry) return;
    const now = this.now();
    const adapters = this.registry.getHypervisorAdapters();
    for (const adapter of adapters) {
      let ok = false;
      let err: string | undefined;
      try {
        ok = adapter.isConnected();
        if (!ok) err = "adapter reports not connected";
      } catch (e) {
        ok = false;
        err = (e as Error).message;
      }

      const outcome = this.providerHealth.recordResult(
        adapter.name,
        ok,
        now,
        err,
      );

      if (ok && outcome.transitionedToHealthy) {
        this.emit({
          type: AgentEventType.ProviderRecovered,
          timestamp: now.toISOString(),
          data: {
            provider: adapter.name,
          },
        });
      } else if (!ok && outcome.crossedThreshold) {
        this.emit({
          type: AgentEventType.ProviderUnreachable,
          timestamp: now.toISOString(),
          data: {
            provider: adapter.name,
            consecutive_failures: outcome.consecutiveFailures,
            error: err ?? "unreachable",
          },
        });
      }
    }
  }

  /**
   * Run one probe immediately (test hook + future "probe now" UI).
   * The result IS recorded in state and IS emitted.
   */
  async runOnce(probeId: string): Promise<ProbeResult | null> {
    const probe = this.probes.find((p) => p.id === probeId);
    if (!probe) return null;
    return this.tickProbe(probe);
  }

  // ── Internals ─────────────────────────────────────────────

  private scheduleProbe(probe: ProbeDef): void {
    const intervalMs = (probe.interval_s ?? 60) * 1000;
    const active: ActiveProbe = {
      probe,
      timer: null,
      inFlight: false,
    };
    this.active.set(probe.id, active);

    // Run an initial probe on the next tick so the state is populated
    // before the first interval fires (matches AutopilotDaemon behavior).
    void this.tickProbe(probe).catch((err) => {
      this.emitProbeError(probe, err);
    });

    active.timer = setInterval(() => {
      void this.tickProbe(probe).catch((err) => {
        this.emitProbeError(probe, err);
      });
    }, intervalMs);
  }

  private async tickProbe(probe: ProbeDef): Promise<ProbeResult> {
    const active = this.active.get(probe.id);

    // Skip if a prior tick is still running (e.g. probe slower than
    // its interval). Better to drop a tick than queue.
    if (active && active.inFlight) {
      return {
        ok: false,
        duration_ms: 0,
        detail: "skipped: previous tick still in flight",
        error_code: "in_flight",
      };
    }
    if (active) active.inFlight = true;

    const now = this.now();
    let result: ProbeResult;
    try {
      result = await runProbe(probe, this.overrides);
    } finally {
      if (active) active.inFlight = false;
    }

    const outcome = this.state.recordResult(probe, result.ok, now);
    const probeKey = buildProbeKey(probe);

    if (outcome.kind === "success") {
      this.emit({
        type: AgentEventType.ProbeSucceeded,
        timestamp: now.toISOString(),
        data: {
          probe_id: probe.id,
          probe_key: probeKey,
          kind: probe.kind,
          target: probe.target_vm_id ?? probe.target_host ?? probe.host,
          duration_ms: result.duration_ms,
          detail: result.detail,
        },
      });
      if (outcome.transitionedToHealthy) {
        this.emit({
          type: AgentEventType.ProbeRecovered,
          timestamp: now.toISOString(),
          data: {
            probe_id: probe.id,
            probe_key: probeKey,
            kind: probe.kind,
            target: probe.target_vm_id ?? probe.target_host ?? probe.host,
          },
        });
      }
    } else {
      this.emit({
        type: AgentEventType.ProbeFailed,
        timestamp: now.toISOString(),
        data: {
          probe_id: probe.id,
          probe_key: probeKey,
          kind: probe.kind,
          target: probe.target_vm_id ?? probe.target_host ?? probe.host,
          consecutive_failures: outcome.consecutiveFailures,
          crossed_threshold: outcome.crossedThreshold,
          duration_ms: result.duration_ms,
          detail: result.detail,
          error_code: result.error_code,
        },
      });
    }

    return result;
  }

  private emit(event: AgentEvent): void {
    try {
      this.eventBus.emit(event);
    } catch (err) {
      // Don't let listener exceptions kill the scheduler.
      console.error("[probes] event emit failed:", err);
    }
  }

  private emitProbeError(probe: ProbeDef, err: unknown): void {
    const now = this.now();
    this.emit({
      type: AgentEventType.ProbeFailed,
      timestamp: now.toISOString(),
      data: {
        probe_id: probe.id,
        probe_key: buildProbeKey(probe),
        kind: probe.kind,
        target: probe.target_vm_id ?? probe.target_host ?? probe.host,
        consecutive_failures: this.state.consecutiveFailures(probe),
        crossed_threshold: false,
        duration_ms: 0,
        detail: `scheduler error: ${(err as Error).message}`,
        error_code: "scheduler",
      },
    });
  }
}
