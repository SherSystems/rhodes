// ============================================================
// vClaw — Autopilot Daemon
// Continuous monitoring loop that polls cluster state, runs
// health checks, detects issues, and triggers self-healing
// actions through the governance pipeline.
// ============================================================

import { randomUUID } from "node:crypto";
import { AgentEventType } from "../types.js";
import type {
  Alert,
  AlertSeverity,
  HealthCheck,
  AutopilotRule,
  ClusterState,
  VMInfo,
  NodeInfo,
  AgentEvent,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { GovernanceEngine } from "../governance/index.js";
import type { EventBus } from "../agent/events.js";
import { DEFAULT_RULES, evaluateRules, type RuleMatch } from "./rules.js";
import {
  RuleStateTracker,
  buildEntityKey,
  type SuppressionInfo,
} from "./rule-state.js";
import { ProbeScheduler } from "./probes/scheduler.js";
import type { ProbeDef } from "./probes/schema.js";
import type { ProberOverrides } from "./probes/probers.js";

// ── Configuration ───────────────────────────────────────────

export interface AutopilotConfig {
  /** Polling interval in milliseconds. Default: 30000 (30s) */
  pollIntervalMs: number;
  /** Whether the daemon is enabled. Default: true */
  enabled: boolean;
  /** Service-health probes — when non-empty, the probe scheduler is
   *  started alongside the daemon. */
  probes?: ProbeDef[];
  /** Whether the probe scheduler runs at all. Default: true (the
   *  daemon's own `enabled` still gates startup). */
  probesEnabled?: boolean;
  /** Test hook — kind→runner overrides for the probe scheduler so
   *  unit tests can inject mock runners with no real sockets. */
  probeRunnerOverrides?: ProberOverrides;
}

const DEFAULT_CONFIG: AutopilotConfig = {
  pollIntervalMs: 30_000,
  enabled: true,
  probesEnabled: true,
};

// ── Restart Tracking ────────────────────────────────────────

interface RestartRecord {
  vmid: string | number;
  lastAttempt: number;
  attempts: number;
}

// ── AutopilotDaemon Class ───────────────────────────────────

export class AutopilotDaemon {
  private toolRegistry: ToolRegistry;
  private governance: GovernanceEngine;
  private eventBus: EventBus;
  private config: AutopilotConfig;

  private rules: AutopilotRule[];
  private previousState: ClusterState | null = null;
  private alerts: Alert[] = [];
  private healthChecks: HealthCheck[] = [];
  private restartRecords: Map<string | number, RestartRecord> = new Map();
  private ruleState = new RuleStateTracker();
  private probeScheduler: ProbeScheduler | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    toolRegistry: ToolRegistry,
    governance: GovernanceEngine,
    eventBus: EventBus,
    config?: Partial<AutopilotConfig>,
  ) {
    this.toolRegistry = toolRegistry;
    this.governance = governance;
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rules = DEFAULT_RULES.map((r) => ({ ...r }));

    // Probe scheduler: created eagerly so tests can inspect it before
    // start() is called. The scheduler isn't running yet — start()
    // calls scheduler.start() under the same gate as the poll timer.
    if (this.config.probesEnabled !== false) {
      // The scheduler accepts either a real ToolRegistry (provider
      // checks) or null (tests, probes-only mode).
      const registryHasAdapters =
        typeof (toolRegistry as { getHypervisorAdapters?: unknown })
          .getHypervisorAdapters === "function";
      this.probeScheduler = new ProbeScheduler(
        this.eventBus,
        registryHasAdapters ? toolRegistry : null,
        {
          probes: this.config.probes ?? [],
          runnerOverrides: this.config.probeRunnerOverrides,
        },
      );
    }
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Start the polling loop.
   */
  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      console.log("[autopilot] Daemon is disabled, not starting.");
      return;
    }

    this.running = true;
    console.log(
      `[autopilot] Starting daemon with ${this.config.pollIntervalMs}ms poll interval.`,
    );

    // Bring the probe scheduler up alongside the daemon — independent
    // timers per probe, so a slow probe never starves another.
    if (this.probeScheduler) this.probeScheduler.start();

    // Run first poll immediately
    void this.poll();

    // Schedule subsequent polls
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.probeScheduler) this.probeScheduler.stop();
    console.log("[autopilot] Daemon stopped.");
  }

  /**
   * Snapshot of probe state, exposed for the dashboard.
   */
  getProbeStateSnapshot() {
    return this.probeScheduler?.getProbeStateSnapshot() ?? [];
  }

  /**
   * Snapshot of provider-adapter health, exposed for the dashboard.
   */
  getProviderHealthSnapshot() {
    return this.probeScheduler?.getProviderHealthSnapshot() ?? [];
  }

  /**
   * The probe scheduler instance — exposed for tests that want to drive
   * one-off probe runs. Returns null when probes are disabled.
   */
  getProbeScheduler(): ProbeScheduler | null {
    return this.probeScheduler;
  }

  /**
   * Get all alerts (most recent first).
   */
  getAlerts(): Alert[] {
    return [...this.alerts].reverse();
  }

  /**
   * Get the most recent health check results.
   */
  getHealthChecks(): HealthCheck[] {
    return [...this.healthChecks];
  }

  /**
   * Snapshot of the per-rule/per-entity dedupe and rate-limit state.
   * Exposed for the dashboard and tests.
   */
  getRuleStateSnapshot(): Array<{
    key: string;
    lastFire: number;
    recentFireCount: number;
  }> {
    return this.ruleState.snapshot();
  }

  // ── Core Poll Loop ────────────────────────────────────────

  private async poll(): Promise<void> {
    const now = new Date();

    let currentState: ClusterState | null;
    try {
      currentState = await this.toolRegistry.getClusterState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] Failed to fetch cluster state: ${msg}`);
      this.fireAlert(
        "critical",
        "autopilot",
        `Failed to fetch cluster state: ${msg}`,
      );
      return;
    }

    if (!currentState) {
      console.warn("[autopilot] No cluster adapter connected, skipping poll.");
      return;
    }

    try {
      // Run health checks
      this.runHealthChecks(currentState, now);

      // Provider-adapter reachability — checked on the daemon's poll
      // cadence rather than on its own timer, since they share the
      // same natural rate (a poll proves a connection works).
      if (this.probeScheduler) {
        try {
          this.probeScheduler.pollProviders();
        } catch (err) {
          // Provider polling must never break the daemon poll loop.
          console.error(
            `[autopilot] Provider health poll failed: ${(err as Error).message}`,
          );
        }
      }

      // Evaluate rules
      const matches = evaluateRules(
        this.rules,
        currentState,
        this.previousState,
        now,
        this.probeScheduler ?? undefined,
      );

      // Emit a single per-poll evaluation event for observability — easier
      // than reasoning about N "rule fired" events without a denominator.
      this.eventBus.emit({
        type: AgentEventType.AutopilotRuleEvaluated,
        timestamp: now.toISOString(),
        data: {
          rules: this.rules.length,
          enabled: this.rules.filter((r) => r.enabled).length,
          matches: matches.length,
        },
      });

      // Process rule matches with per-entity dedupe + rate limiting.
      for (const match of matches) {
        const entityKey = buildEntityKey(match.rule.id, match.params);
        const admit = this.ruleState.shouldAdmit(match.rule, entityKey, now);

        if (!admit.admitted && admit.suppression) {
          this.emitSuppressed(match, entityKey, admit.suppression, now);
          continue;
        }

        // Record fire BEFORE handling so concurrent admits within the same
        // tick (e.g. duplicate matches for the same entity) are deduped.
        this.ruleState.recordFire(match.rule, entityKey, now);

        this.eventBus.emit({
          type: AgentEventType.AutopilotRuleFired,
          timestamp: now.toISOString(),
          data: {
            rule_id: match.rule.id,
            rule_name: match.rule.name,
            action: match.action,
            entity_key: entityKey,
            trigger: match.trigger,
            tier: match.rule.tier,
          },
        });

        await this.handleRuleMatch(match, now);
      }

      // Store state for next comparison
      this.previousState = currentState;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] Poll execution failed: ${msg}`);
      this.fireAlert(
        "warning",
        "autopilot/poll",
        `Poll execution failed: ${msg}`,
      );
    }
  }

  // ── Health Checks ─────────────────────────────────────────

  private runHealthChecks(state: ClusterState, now: Date): void {
    const checks: HealthCheck[] = [];
    const timestamp = now.toISOString();

    // Check each node
    for (const node of state.nodes) {
      checks.push(this.checkNodeHealth(node, timestamp));
    }

    // Check each VM
    for (const vm of state.vms) {
      checks.push(this.checkVmHealth(vm, timestamp));
    }

    // Check storage
    for (const storage of state.storage) {
      const usedPct =
        storage.total_gb > 0
          ? (storage.used_gb / storage.total_gb) * 100
          : 0;

      let status: HealthCheck["status"] = "healthy";
      let message = `${usedPct.toFixed(1)}% used (${storage.available_gb.toFixed(1)} GB free)`;

      if (usedPct > 95) {
        status = "unhealthy";
        message = `CRITICAL: ${usedPct.toFixed(1)}% used — only ${storage.available_gb.toFixed(1)} GB free`;
      } else if (usedPct > 85) {
        status = "degraded";
        message = `WARNING: ${usedPct.toFixed(1)}% used — ${storage.available_gb.toFixed(1)} GB free`;
      }

      checks.push({
        target: `storage/${storage.id}@${storage.node}`,
        type: "resource_threshold",
        status,
        message,
        timestamp,
      });
    }

    this.healthChecks = checks;

    // Emit health check event
    const unhealthyCount = checks.filter((c) => c.status === "unhealthy").length;
    const degradedCount = checks.filter((c) => c.status === "degraded").length;

    this.eventBus.emit({
      type: AgentEventType.HealthCheck,
      timestamp,
      data: {
        total: checks.length,
        healthy: checks.filter((c) => c.status === "healthy").length,
        degraded: degradedCount,
        unhealthy: unhealthyCount,
      },
    });
  }

  private checkNodeHealth(node: NodeInfo, timestamp: string): HealthCheck {
    if (node.status === "offline") {
      return {
        target: `node/${node.name}`,
        type: "connectivity",
        status: "unhealthy",
        message: "Node is offline",
        timestamp,
      };
    }

    const ramPct =
      node.ram_total_mb > 0
        ? (node.ram_used_mb / node.ram_total_mb) * 100
        : 0;

    if (ramPct > 95) {
      return {
        target: `node/${node.name}`,
        type: "resource_threshold",
        status: "unhealthy",
        message: `RAM critically high at ${ramPct.toFixed(1)}%`,
        timestamp,
      };
    }

    if (ramPct > 90 || node.cpu_usage_pct > 90) {
      return {
        target: `node/${node.name}`,
        type: "resource_threshold",
        status: "degraded",
        message: `Resources elevated — RAM: ${ramPct.toFixed(1)}%, CPU: ${node.cpu_usage_pct.toFixed(1)}%`,
        timestamp,
      };
    }

    return {
      target: `node/${node.name}`,
      type: "resource_threshold",
      status: "healthy",
      message: `RAM: ${ramPct.toFixed(1)}%, CPU: ${node.cpu_usage_pct.toFixed(1)}%`,
      timestamp,
    };
  }

  private checkVmHealth(vm: VMInfo, timestamp: string): HealthCheck {
    if (vm.status === "unknown") {
      return {
        target: `vm/${vm.name} (${vm.id})`,
        type: "vm_status",
        status: "unhealthy",
        message: "VM status is unknown",
        timestamp,
      };
    }

    if (vm.status === "paused") {
      return {
        target: `vm/${vm.name} (${vm.id})`,
        type: "vm_status",
        status: "degraded",
        message: "VM is paused",
        timestamp,
      };
    }

    return {
      target: `vm/${vm.name} (${vm.id})`,
      type: "vm_status",
      status: "healthy",
      message: `VM is ${vm.status}`,
      timestamp,
    };
  }

  // ── Suppression Events ────────────────────────────────────

  private emitSuppressed(
    match: RuleMatch,
    entityKey: string,
    suppression: SuppressionInfo,
    now: Date,
  ): void {
    this.eventBus.emit({
      type: AgentEventType.AutopilotRuleSuppressed,
      timestamp: now.toISOString(),
      data: {
        rule_id: match.rule.id,
        rule_name: match.rule.name,
        action: match.action,
        entity_key: entityKey,
        reason: suppression.reason,
        retry_after_ms: suppression.retryAfterMs,
      },
    });
  }

  // ── Rule Match Handling ───────────────────────────────────

  private async handleRuleMatch(match: RuleMatch, now: Date): Promise<void> {
    const { rule, trigger, action, params } = match;

    console.log(`[autopilot] Rule "${rule.name}" triggered: ${trigger}`);

    // NOTE: per-entity dedupe and rate-limiting are now handled by the
    // RuleStateTracker in the poll loop. We deliberately no longer mutate
    // `rule.last_triggered_at` here — doing so blocked OTHER entities from
    // firing during the cooldown window, which defeats per-entity dedupe.
    // The tracker handles each entity independently.

    if (action === "alert") {
      // Fire an alert
      const severity = (params.severity as AlertSeverity) ?? "warning";
      this.fireAlert(severity, `rule/${rule.id}`, trigger);
      return;
    }

    if (action === "start_vm") {
      await this.handleVmRestart(match, now);
      return;
    }

    if (action === "restart_vm") {
      await this.handleServiceUnreachableRestart(match, now);
      return;
    }

    // Unknown action — log it
    console.warn(
      `[autopilot] Unknown rule action "${action}" for rule "${rule.id}".`,
    );
  }

  /**
   * Service-unreachable remediation — the VM is RUNNING but its service
   * has stopped responding. We try a power-cycle (stop_vm followed by
   * start_vm) routed through governance. Both calls are tier=risky_write
   * because we're operating on a live VM. Per-(probe, target) cooldown
   * is enforced by the ProbeScheduler so a flapping VM isn't power-
   * cycled in a loop.
   */
  private async handleServiceUnreachableRestart(
    match: RuleMatch,
    now: Date,
  ): Promise<void> {
    const probeId = match.params.probe_id as string | undefined;
    const vmid = match.params.vmid as string | number | undefined;
    const vmName = (match.params.vm_name as string | undefined) ?? `vm/${vmid}`;
    const node = match.params.node as string | undefined;

    if (probeId && this.probeScheduler) {
      const cooldown = this.probeScheduler.canRemediate(probeId, now);
      if (!cooldown.admitted) {
        console.log(
          `[autopilot] Skipping restart_vm for probe ${probeId} — cooldown ${cooldown.retryAfterMs}ms remaining.`,
        );
        return;
      }
    }

    if (vmid === undefined) {
      this.fireAlert(
        "warning",
        `rule/${match.rule.id}`,
        `Service unreachable: ${match.trigger} — no target VM configured for restart`,
      );
      return;
    }

    // Stop then start. We route both through governance so an operator
    // can deny either step.
    const stopDecision = await this.governance.evaluate(
      "stop_vm",
      { vmid, node },
      "watch",
      this.toolRegistry.getAllTools(),
    );
    this.eventBus.emit({
      type: AgentEventType.AutopilotActionGoverned,
      timestamp: now.toISOString(),
      data: {
        rule_id: match.rule.id,
        action: "stop_vm",
        vmid,
        allowed: stopDecision.allowed,
        tier: stopDecision.tier,
        reason: stopDecision.reason,
      },
    });
    if (!stopDecision.allowed) {
      this.fireAlert(
        "warning",
        "autopilot/governance",
        `Service-unreachable restart of "${vmName}" (${vmid}) blocked by governance: ${stopDecision.reason}`,
      );
      if (probeId && this.probeScheduler) {
        this.probeScheduler.recordRemediation(probeId, now);
      }
      return;
    }

    const stopResult = await this.toolRegistry.execute("stop_vm", {
      vmid,
      node,
    });
    if (!stopResult.success) {
      this.fireAlert(
        "warning",
        `autopilot/${match.rule.id}`,
        `Failed to stop "${vmName}" (${vmid}) for service-unreachable restart: ${stopResult.error}`,
      );
      if (probeId && this.probeScheduler) {
        this.probeScheduler.recordRemediation(probeId, now);
      }
      return;
    }

    const startDecision = await this.governance.evaluate(
      "start_vm",
      { vmid, node },
      "watch",
      this.toolRegistry.getAllTools(),
    );
    this.eventBus.emit({
      type: AgentEventType.AutopilotActionGoverned,
      timestamp: now.toISOString(),
      data: {
        rule_id: match.rule.id,
        action: "start_vm",
        vmid,
        allowed: startDecision.allowed,
        tier: startDecision.tier,
        reason: startDecision.reason,
      },
    });
    if (!startDecision.allowed) {
      this.fireAlert(
        "critical",
        "autopilot/governance",
        `Stopped "${vmName}" (${vmid}) but start was blocked by governance: ${startDecision.reason}`,
      );
      if (probeId && this.probeScheduler) {
        this.probeScheduler.recordRemediation(probeId, now);
      }
      return;
    }

    const startResult = await this.toolRegistry.execute("start_vm", {
      vmid,
      node,
    });
    if (probeId && this.probeScheduler) {
      this.probeScheduler.recordRemediation(probeId, now);
    }
    if (startResult.success) {
      this.fireAlert(
        "info",
        `autopilot/${match.rule.id}`,
        `Service-unreachable restart of "${vmName}" (${vmid}) completed.`,
        true,
      );
    } else {
      this.fireAlert(
        "warning",
        `autopilot/${match.rule.id}`,
        `Service-unreachable restart of "${vmName}" (${vmid}) — start failed: ${startResult.error}`,
      );
    }
  }

  private async handleVmRestart(
    match: RuleMatch,
    now: Date,
  ): Promise<void> {
    const vmid = match.params.vmid as string | number;
    const vmName = match.params.vm_name as string;

    // Check restart cooldown and attempt limits
    const record = this.restartRecords.get(vmid);
    if (record) {
      const cooldownMs = match.rule.cooldown_s * 1000;
      if (now.getTime() - record.lastAttempt < cooldownMs) {
        console.log(
          `[autopilot] Skipping restart for VM ${vmid} — still in cooldown.`,
        );
        return;
      }
      if (record.attempts >= 3) {
        console.warn(
          `[autopilot] VM ${vmid} has exceeded max restart attempts (3). Firing alert instead.`,
        );
        this.fireAlert(
          "critical",
          `autopilot/vm_restart`,
          `VM "${vmName}" (${vmid}) has been restarted 3 times and keeps stopping. Manual intervention required.`,
        );
        return;
      }
    }

    // Check governance
    const decision = await this.governance.evaluate(
      "start_vm",
      { vmid, node: match.params.node },
      "watch",
      this.toolRegistry.getAllTools(),
    );

    this.eventBus.emit({
      type: AgentEventType.AutopilotActionGoverned,
      timestamp: now.toISOString(),
      data: {
        rule_id: match.rule.id,
        action: match.action,
        vmid,
        allowed: decision.allowed,
        tier: decision.tier,
        reason: decision.reason,
      },
    });

    if (!decision.allowed) {
      console.log(
        `[autopilot] Governance blocked restart of VM ${vmid}: ${decision.reason}`,
      );
      this.fireAlert(
        "warning",
        "autopilot/governance",
        `Auto-restart of VM "${vmName}" (${vmid}) blocked by governance: ${decision.reason}`,
      );
      return;
    }

    // Execute the restart
    console.log(`[autopilot] Auto-restarting VM "${vmName}" (${vmid})...`);

    const result = await this.toolRegistry.execute("start_vm", {
      vmid,
      node: match.params.node,
    });

    // Track the attempt
    const updatedRecord: RestartRecord = {
      vmid,
      lastAttempt: now.getTime(),
      attempts: (record?.attempts ?? 0) + 1,
    };
    this.restartRecords.set(vmid, updatedRecord);

    if (result.success) {
      this.fireAlert(
        "info",
        "autopilot/vm_restart",
        `VM "${vmName}" (${vmid}) auto-restarted successfully (attempt ${updatedRecord.attempts}).`,
        true,
      );
    } else {
      this.fireAlert(
        "warning",
        "autopilot/vm_restart",
        `Failed to auto-restart VM "${vmName}" (${vmid}): ${result.error}`,
      );
    }
  }

  // ── Alert Management ──────────────────────────────────────

  private fireAlert(
    severity: AlertSeverity,
    source: string,
    message: string,
    autoHealed = false,
  ): void {
    const alert: Alert = {
      id: randomUUID(),
      severity,
      source,
      message,
      timestamp: new Date().toISOString(),
      acknowledged: false,
      resolved: autoHealed,
      auto_healed: autoHealed,
    };

    this.alerts.push(alert);

    // Cap stored alerts at 500
    if (this.alerts.length > 500) {
      this.alerts = this.alerts.slice(-500);
    }

    console.log(`[autopilot] Alert [${severity}] ${source}: ${message}`);

    // Forward to EventBus for Dashboard consumption
    this.eventBus.emit({
      type: AgentEventType.AlertFired,
      timestamp: alert.timestamp,
      data: {
        alert_id: alert.id,
        severity: alert.severity,
        source: alert.source,
        message: alert.message,
        auto_healed: alert.auto_healed,
      },
    });
  }
}
