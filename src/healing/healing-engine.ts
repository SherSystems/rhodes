import { randomUUID } from "node:crypto";
import { AgentEventType } from "../types.js";
import type { Goal } from "../types.js";
import type { AgentCore, AgentRunResult } from "../agent/core.js";
import type { EventBus } from "../agent/events.js";
import { AnomalyDetector } from "../monitoring/anomaly.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import { HealthMonitor } from "../monitoring/health.js";
import { PlaybookEngine } from "./playbooks.js";
import type { Playbook, HealingAction } from "./playbooks.js";
import { IncidentCoordinator } from "./incident-coordinator.js";
import type { Incident } from "./incidents.js";
import { RCAAnalyzer } from "./rca-analyzer.js";
import type { ToolRegistry } from "../tools/registry.js";

interface FastPathResult {
  success: boolean;
  steps_completed: number;
  duration_ms: number;
  errors: string[];
}

const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_MINUTES = 30;
const CIRCUIT_BREAKER_THRESHOLD = 3;

interface ActiveHeal {
  id: string;
  anomalyKey: string;
  incidentId: string;
  goal: Goal;
  startedAt: string;
  promise: Promise<AgentRunResult>;
}

interface CircuitBreakerState {
  consecutiveFailures: number;
  paused: boolean;
  pausedAt?: string;
}

export interface TickSummary {
  timestamp: string;
  anomaliesDetected: number;
  healingsStarted: number;
  healingsCompleted: number;
  healingsFailed: number;
  openIncidents: number;
  activeHeals: number;
  circuitBreakerPaused: boolean;
}

export interface HealingEngineConfig {
  pollIntervalMs: number;
  healingEnabled: boolean;
  maxConcurrentHeals: number;
  /**
   * When true, healing actions that map to a single registered tool
   * (e.g. `restart_vm` → `start_vm`) bypass the LLM agent and call the
   * tool directly. Cuts typical recovery from ~60s to ~2s on simple
   * playbooks. Defaults to false to preserve agent-loop semantics
   * unless the host explicitly opts in.
   */
  fastPathEnabled?: boolean;
  /** When true (default), the first tick runs an initial-state pass.
   *  See HealingOrchestratorConfig.bootEvalEnabled. */
  bootEvalEnabled?: boolean;
}

export interface HealingEngineStatus {
  running: boolean;
  healingEnabled: boolean;
  activeHeals: Array<{ id: string; anomalyKey: string; startedAt: string }>;
  openIncidents: Incident[];
  circuitBreaker: CircuitBreakerState;
  lastTick?: TickSummary;
}

class HealingExecutor {
  private readonly activeHeals: Map<string, ActiveHeal> = new Map();
  private readonly circuitBreaker: CircuitBreakerState = {
    consecutiveFailures: 0,
    paused: false,
  };

  constructor(
    private readonly agentCore: AgentCore,
    private readonly eventBus: EventBus,
    private readonly playbookEngine: PlaybookEngine,
    private readonly incidentCoordinator: IncidentCoordinator,
    private readonly rcaAnalyzer: RCAAnalyzer,
    private readonly healthMonitor: HealthMonitor,
    private readonly config: HealingEngineConfig,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  getStatusParts(): {
    activeHeals: Array<{ id: string; anomalyKey: string; startedAt: string }>;
    circuitBreaker: CircuitBreakerState;
  } {
    return {
      activeHeals: Array.from(this.activeHeals.values()).map((heal) => ({
        id: heal.id,
        anomalyKey: heal.anomalyKey,
        startedAt: heal.startedAt,
      })),
      circuitBreaker: { ...this.circuitBreaker },
    };
  }

  getActiveIncidentIds(): Set<string> {
    return new Set(Array.from(this.activeHeals.values()).map((heal) => heal.incidentId));
  }

  get activeHealCount(): number {
    return this.activeHeals.size;
  }

  get circuitPaused(): boolean {
    return this.circuitBreaker.paused;
  }

  async handleAnomaly(anomaly: Anomaly, summary: TickSummary): Promise<void> {
    const { key, acquired } = this.incidentCoordinator.beginAnomaly(anomaly);
    if (!acquired) return;

    try {
      if (this.incidentCoordinator.findOpenIncident(anomaly)) return;

      const incident = this.incidentCoordinator.openIncident(anomaly);

      if (!this.config.healingEnabled || this.circuitBreaker.paused) return;

      if (this.incidentCoordinator.shouldEscalate(key)) {
        this.emitEvent(AgentEventType.HealingEscalated, {
          anomalyKey: key,
          incident_id: incident.id,
          reason: `Anomaly triggered ${ESCALATION_THRESHOLD}+ times in ${ESCALATION_WINDOW_MINUTES} minutes`,
        });
        return;
      }

      // ── Multi-match: fire every playbook whose trigger matches ──
      //
      // v0.4.6 fix (correctness MEDIUM, trigger-collision): when two
      // playbooks register the same trigger (e.g. jellyfin-service-probe
      // and vm_in_guest_diagnostic both key on
      // metric=service_http_status, type=state_change, severity=critical)
      // we used to fire ONLY the first match — `match(anomaly)[0]`. The
      // v0.4.4 release notes claimed the two would "fire together"; they
      // did not. The matcher's downstream consumer was throwing away every
      // entry past index 0.
      //
      // Now: collect the suggestPlaybook hint (pattern learning) plus
      // every trigger match, dedupe by id, then fire each playbook
      // through executeHealing independently. Each playbook respects its
      // own cooldown_minutes (already enforced inside match() — cooled
      // playbooks are filtered out there), requires_approval (each one
      // escalates separately if it needs approval), and max_retries.
      // The activeHeals concurrency limit applies in aggregate across
      // playbooks for the same anomaly.
      const matched = this.playbookEngine.match(anomaly);
      const suggestedId = this.incidentCoordinator.incidentManager.suggestPlaybook({
        type: anomaly.type,
        severity: anomaly.severity,
        metric: anomaly.metric,
        labels: anomaly.labels,
        value: anomaly.current_value,
        description: anomaly.message,
      });
      const suggested = suggestedId ? this.playbookEngine.get(suggestedId) : undefined;

      const candidates: Playbook[] = [];
      const seen = new Set<string>();
      // The learned/suggested playbook (if any) runs first so pattern
      // learning still steers ordering, but it is NOT exclusive — every
      // other matching playbook fires afterwards.
      if (suggested && !seen.has(suggested.id)) {
        candidates.push(suggested);
        seen.add(suggested.id);
      }
      for (const playbook of matched) {
        if (seen.has(playbook.id)) continue;
        candidates.push(playbook);
        seen.add(playbook.id);
      }
      if (candidates.length === 0) return;

      // RCA runs once per incident regardless of how many playbooks fire.
      this.rcaAnalyzer.analyze(anomaly, incident, this.healthMonitor.store).catch((err) => {
        console.error(
          `[healing] RCA analysis failed for incident ${incident.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      const healPromises: Promise<void>[] = [];
      for (const playbook of candidates) {
        // Each playbook's approval requirement is independent. An auto
        // playbook fires while a co-triggered approval playbook escalates
        // — operator sees both events.
        if (playbook.requires_approval) {
          this.emitEvent(AgentEventType.HealingEscalated, {
            anomalyKey: key,
            incident_id: incident.id,
            playbook_id: playbook.id,
            reason: `Playbook "${playbook.name}" requires approval — escalating to operator`,
          });
          continue;
        }

        if (this.activeHeals.size >= this.config.maxConcurrentHeals) break;

        // Fire concurrently. executeHealing runs synchronously up to the
        // agentCore.run() call where it inserts into activeHeals — so the
        // concurrency check above sees each in-flight heal before
        // deciding whether to start the next one for this anomaly.
        healPromises.push(this.executeHealing(anomaly, incident, playbook, summary, key));
      }

      if (healPromises.length > 0) {
        await Promise.all(healPromises);
      }
    } finally {
      this.incidentCoordinator.endAnomaly(key);
    }
  }

  private async executeHealing(
    anomaly: Anomaly,
    incident: Incident,
    playbook: Playbook,
    summary: TickSummary,
    anomalyKey: string,
  ): Promise<void> {
    const healId = randomUUID();
    const goal = this.playbookEngine.toGoal(playbook, anomaly);
    const startedAt = new Date().toISOString();

    this.incidentCoordinator.recordEscalation(anomalyKey);
    this.emitEvent(AgentEventType.HealingStarted, {
      heal_id: healId,
      incident_id: incident.id,
      playbook_id: playbook.id,
      goal_id: goal.id,
      description: goal.description,
    });

    this.incidentCoordinator.incidentManager.recordAction(
      incident.id,
      `Executing playbook "${playbook.name}"`,
      true,
      `Goal: ${goal.description}`,
    );

    summary.healingsStarted++;

    // Fast-path: if every action in the playbook maps directly to a registered
    // tool call, execute the tools synchronously and skip the LLM round-trip.
    // This is the difference between ~2s and ~60s on a vm restart. Opt-in via
    // config so tests that exercise the agent path are unaffected.
    const fastPath = this.config.fastPathEnabled
      ? this.tryFastPath(playbook, anomaly)
      : null;
    if (fastPath) {
      try {
        const fastResult = await fastPath();
        if (fastResult.success) {
          this.circuitBreaker.consecutiveFailures = 0;
          summary.healingsCompleted++;
          this.incidentCoordinator.incidentManager.recordAction(
            incident.id,
            `Playbook "${playbook.name}" succeeded (fast-path)`,
            true,
            `${fastResult.steps_completed} step(s) completed in ${fastResult.duration_ms}ms`,
          );
          this.incidentCoordinator.incidentManager.resolve(
            incident.id,
            `Healed by playbook "${playbook.name}" — ${fastResult.steps_completed} step(s) completed via direct tool call`,
          );
          this.playbookEngine.recordExecution(playbook.id, anomaly.id, true);
          this.emitEvent(AgentEventType.HealingCompleted, {
            heal_id: healId,
            incident_id: incident.id,
            playbook_id: playbook.id,
            steps_completed: fastResult.steps_completed,
            duration_ms: fastResult.duration_ms,
            fast_path: true,
          });
          return;
        }
        // Fast-path failed — fall through to LLM agent as a backstop. Record
        // the failure so it shows up in the incident timeline.
        this.incidentCoordinator.incidentManager.recordAction(
          incident.id,
          `Fast-path failed, falling back to agent`,
          false,
          fastResult.errors.join("; "),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.incidentCoordinator.incidentManager.recordAction(
          incident.id,
          `Fast-path threw, falling back to agent`,
          false,
          message,
        );
      }
    }

    const promise = this.agentCore.run(goal);
    this.activeHeals.set(healId, { id: healId, anomalyKey, incidentId: incident.id, goal, startedAt, promise });

    try {
      const result = await promise;
      this.activeHeals.delete(healId);

      if (!result.success) {
        this.onHealingFailed(healId, incident, playbook, anomaly, result.errors, summary);
        return;
      }

      this.circuitBreaker.consecutiveFailures = 0;
      summary.healingsCompleted++;

      this.incidentCoordinator.incidentManager.recordAction(
        incident.id,
        `Playbook "${playbook.name}" succeeded`,
        true,
        `${result.steps_completed} steps completed in ${result.duration_ms}ms`,
      );
      this.incidentCoordinator.incidentManager.resolve(
        incident.id,
        `Healed by playbook "${playbook.name}" — ${result.steps_completed} steps completed`,
      );
      this.playbookEngine.recordExecution(playbook.id, anomaly.id, true);

      this.emitEvent(AgentEventType.HealingCompleted, {
        heal_id: healId,
        incident_id: incident.id,
        playbook_id: playbook.id,
        steps_completed: result.steps_completed,
        duration_ms: result.duration_ms,
      });
    } catch (err) {
      this.activeHeals.delete(healId);
      const message = err instanceof Error ? err.message : String(err);
      this.onHealingFailed(healId, incident, playbook, anomaly, [message], summary);
    }
  }

  private onHealingFailed(
    healId: string,
    incident: Incident,
    playbook: Playbook,
    anomaly: Anomaly,
    errors: string[],
    summary: TickSummary,
  ): void {
    this.circuitBreaker.consecutiveFailures++;
    summary.healingsFailed++;

    const errorMessage = errors.join("; ");
    this.incidentCoordinator.incidentManager.recordAction(
      incident.id,
      `Playbook "${playbook.name}" failed`,
      false,
      errorMessage,
    );
    this.incidentCoordinator.incidentManager.fail(incident.id, `Healing failed: ${errorMessage}`);
    this.playbookEngine.recordExecution(playbook.id, anomaly.id, false);

    this.emitEvent(AgentEventType.HealingFailed, {
      heal_id: healId,
      incident_id: incident.id,
      playbook_id: playbook.id,
      errors,
    });

    if (this.circuitBreaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreaker.paused = true;
      this.circuitBreaker.pausedAt = new Date().toISOString();

      this.emitEvent(AgentEventType.HealingPaused, {
        reason: `${CIRCUIT_BREAKER_THRESHOLD} consecutive healing failures`,
        consecutive_failures: this.circuitBreaker.consecutiveFailures,
      });
    }
  }

  private emitEvent(type: AgentEventType, data: Record<string, unknown>): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  // ── Fast-Path ──────────────────────────────────────────────
  //
  // For playbooks whose actions all map cleanly to a single tool call, skip
  // the LLM agent and call tools directly. This drops typical recovery from
  // ~60-90s (LLM thinking + tool calls) to ~1-3s (pure API). The agent
  // remains the fallback for anything we don't recognize, and `custom_goal`
  // actions in the playbook are quietly dropped under fast-path because they
  // are notify-only (alerts, advisories) and not load-bearing for recovery.

  private tryFastPath(
    playbook: Playbook,
    anomaly: Anomaly,
  ): (() => Promise<FastPathResult>) | null {
    const actionable = playbook.actions.filter(
      (a) => a.type !== "custom_goal",
    );
    if (actionable.length === 0) return null;

    const calls: Array<() => Promise<{ ok: boolean; error?: string }>> = [];
    for (const action of actionable) {
      const call = this.fastPathCall(action, anomaly);
      if (!call) return null; // any unrecognised action disqualifies the whole playbook
      calls.push(call);
    }

    return async () => {
      const start = Date.now();
      const errors: string[] = [];
      let stepsCompleted = 0;
      for (const call of calls) {
        const r = await call();
        if (!r.ok) {
          if (r.error) errors.push(r.error);
          break;
        }
        stepsCompleted++;
      }
      return {
        success: errors.length === 0 && stepsCompleted === calls.length,
        steps_completed: stepsCompleted,
        duration_ms: Date.now() - start,
        errors,
      };
    };
  }

  private fastPathCall(
    action: HealingAction,
    anomaly: Anomaly,
  ): (() => Promise<{ ok: boolean; error?: string }>) | null {
    switch (action.type) {
      case "restart_vm": {
        const node = anomaly.labels.node;
        const vmid = anomaly.labels.vmid;
        if (!node || !vmid) return null;
        // Anomaly value 0 means VM is stopped — start it. For any other state
        // we'd need to stop-then-start, which the LLM agent can sequence; keep
        // fast-path conservative.
        if (anomaly.metric !== "vm_status" || anomaly.current_value !== 0) {
          return null;
        }
        return async () => {
          const result = await this.toolRegistry.execute("start_vm", {
            node,
            vmid: Number(vmid),
          });
          return {
            ok: result.success,
            error: result.success ? undefined : result.error,
          };
        };
      }
      default:
        return null;
    }
  }
}

export class HealingEngine {
  private readonly executor: HealingExecutor;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTick?: TickSummary;
  /** True until the first successful tick has run the boot-eval pass.
   *  Used so we only synthesize discovered_state_change anomalies once
   *  per process lifetime. */
  private bootEvalPending = true;

  constructor(
    private readonly eventBus: EventBus,
    private readonly healthMonitor: HealthMonitor,
    private readonly anomalyDetector: AnomalyDetector,
    private readonly incidentCoordinator: IncidentCoordinator,
    private readonly config: HealingEngineConfig,
    executorDeps: {
      agentCore: AgentCore;
      playbookEngine: PlaybookEngine;
      rcaAnalyzer: RCAAnalyzer;
      toolRegistry: ToolRegistry;
    },
  ) {
    this.executor = new HealingExecutor(
      executorDeps.agentCore,
      eventBus,
      executorDeps.playbookEngine,
      incidentCoordinator,
      executorDeps.rcaAnalyzer,
      healthMonitor,
      config,
      executorDeps.toolRegistry,
    );
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    console.log(`[healing] Starting orchestrator (poll: ${this.config.pollIntervalMs}ms, healing: ${this.config.healingEnabled})`);
    this.healthMonitor.start(this.config.pollIntervalMs);

    setTimeout(() => {
      this.tick().catch((err) => console.error("[healing] First tick failed:", err));
    }, 5000);

    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => console.error("[healing] Tick failed:", err));
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    this.healthMonitor.stop();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getStatus(): HealingEngineStatus {
    const status = this.executor.getStatusParts();
    return {
      running: this.running,
      healingEnabled: this.config.healingEnabled,
      activeHeals: status.activeHeals,
      openIncidents: this.incidentCoordinator.incidentManager.getOpen(),
      circuitBreaker: status.circuitBreaker,
      lastTick: this.lastTick,
    };
  }

  async tick(): Promise<void> {
    const summary: TickSummary = {
      timestamp: new Date().toISOString(),
      anomaliesDetected: 0,
      healingsStarted: 0,
      healingsCompleted: 0,
      healingsFailed: 0,
      openIncidents: 0,
      activeHeals: this.executor.activeHealCount,
      circuitBreakerPaused: this.executor.circuitPaused,
    };

    try {
      const anomalies = this.anomalyDetector.detect(wrapStoreForDetector(this.healthMonitor));
      const vmCrashAnomalies = this.incidentCoordinator.detectVmStateChanges(this.healthMonitor.store);
      anomalies.push(...vmCrashAnomalies);

      // Boot-eval: on the first tick after start(), walk current state
      // and synthesize discovered_state_change anomalies for entities
      // already in a bad state. Runs AFTER the first poll has populated
      // the metric store (the tick wrapping detect() is precisely that
      // — store updates land in the recordAndBatch path inside
      // HealthMonitor.collect, which the poll timer drives before us).
      //
      // PLAYBOOK-FIRING JOIN POINT: boot-eval anomalies are appended to
      // the same `anomalies` list that flows into the per-anomaly loop
      // below at `executor.handleAnomaly(...)`. That handler runs the
      // identical pipeline for every anomaly regardless of origin:
      //   findOpenIncident → openIncident → suggestPlaybook /
      //   playbookEngine.match → executeHealing.
      // So the proxmox_storage_exhaustion_pause playbook (trigger:
      // metric=vm_status, type=state_change, labels.reason=
      // paused_io_error) fires for both real running→paused_io_error
      // transitions detected mid-flight AND for boot-eval anomalies
      // synthesized at startup. There is no real-vs-boot asymmetry —
      // the join is here, the matching is downstream, and both paths
      // share it.
      if (this.bootEvalPending && this.config.bootEvalEnabled !== false) {
        const seriesCount = this.healthMonitor.store.seriesCount;
        if (seriesCount > 0) {
          const boot = this.incidentCoordinator.evaluateInitialState(
            this.healthMonitor.store,
          );
          const vmStatusSeries = this.healthMonitor.store
            .getAllLatest("vm_status").length;
          const nodeSeries = this.healthMonitor.store
            .getAllLatest("node_cpu_pct").length;
          const poolSeries = this.healthMonitor.store
            .getAllLatest("storage_usage_pct").length;
          console.log(
            `[orchestrator] initial-state evaluation: examined ${vmStatusSeries} VMs / ${nodeSeries} nodes / ${poolSeries} pools, triggered ${boot.length} playbooks`,
          );
          anomalies.push(...boot);
          this.bootEvalPending = false;
        }
        // If seriesCount is 0, the first poll hasn't landed yet — try
        // again on the next tick. We leave `bootEvalPending` true.
      }

      summary.anomaliesDetected = anomalies.length;

      for (const anomaly of anomalies) {
        await this.executor.handleAnomaly(anomaly, summary);
      }

      this.incidentCoordinator.resolveRecoveredIncidents(
        this.healthMonitor.store,
        this.executor.getActiveIncidentIds(),
      );

      summary.openIncidents = this.incidentCoordinator.incidentManager.getOpen().length;
      summary.activeHeals = this.executor.activeHealCount;
      summary.circuitBreakerPaused = this.executor.circuitPaused;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[healing] Tick error: ${message}`);
    }

    this.lastTick = summary;
    this.eventBus.emit({
      type: AgentEventType.HealingTick,
      timestamp: new Date().toISOString(),
      data: { ...summary },
    });
  }

  async handleAnomaly(anomaly: Anomaly, summary: TickSummary): Promise<void> {
    await this.executor.handleAnomaly(anomaly, summary);
  }
}

function wrapStoreForDetector(healthMonitor: HealthMonitor): {
  query(metric: string, labels: Record<string, string>, duration_minutes: number): Array<{ timestamp: string; value: number; labels: Record<string, string> }>;
  getLatest(metric: string, labels: Record<string, string>): { timestamp: string; value: number; labels: Record<string, string> } | null;
} {
  return {
    query: (metric, labels, duration_minutes) =>
      healthMonitor.store.query(metric, labels, duration_minutes).map((point) => ({
        timestamp: new Date(point.timestamp).toISOString(),
        value: point.value,
        labels: point.labels,
      })),
    getLatest: (metric, labels) => {
      const point = healthMonitor.store.getLatest(metric, labels);
      if (!point) return null;
      return {
        timestamp: new Date(point.timestamp).toISOString(),
        value: point.value,
        labels: point.labels,
      };
    },
  };
}
