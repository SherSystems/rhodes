// ============================================================
// RHODES — Chaos Engine
// Simulate and execute failure scenarios to validate resilience
// ============================================================

import { randomUUID } from "node:crypto";
import type { AgentCore } from "../agent/core.js";
import type { EventBus } from "../agent/events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HealingOrchestrator } from "../healing/orchestrator.js";
import type { Incident } from "../healing/incidents.js";
import type { ApprovalGate } from "../governance/approval.js";
import { AgentEventType } from "../types.js";
import type { ApprovalRequest, VMInfo, ClusterState } from "../types.js";
import type { ChaosScenario, ChaosAction } from "./scenarios.js";
import { getScenario, getAllScenarios } from "./scenarios.js";

// ── Interfaces ──────────────────────────────────────────────

export interface BlastRadiusResult {
  affected_vms: Array<{
    vmid: string;
    name: string;
    node: string;
    status: string;
    will_be_affected: boolean;
    expected_recovery: string;
  }>;
  total_affected: number;
  critical_services_affected: number;
  estimated_downtime_s: number;
}

export interface ChaosRun {
  id: string;
  scenario: ChaosScenario;
  status:
    | "pending"
    | "simulating"
    | "awaiting_approval"
    | "executing"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed"
    | "rejected"
    | "blocked";
  started_at: string;
  completed_at?: string;

  /** Populated when the run goes through (or skips) the approval gate. */
  approval?: {
    required: boolean;
    threshold: number;
    decision: "approved" | "rejected" | "timeout" | "blocked" | "not_required";
    decided_at?: string;
    operator?: string;
    plan_id?: string;
  };

  /** Simulation results (computed before execution) */
  simulation: {
    blast_radius: BlastRadiusResult;
    predicted_recovery_time_s: number;
    risk_score: number; // 0-100
    recommendation: string;
  };

  /** Actual execution results (populated after execution) */
  actual?: {
    recovery_time_s: number;
    all_recovered: boolean;
    incidents_created: string[];
    steps_executed: number;
  };

  /** Predicted-vs-actual comparison */
  score?: {
    predicted_vs_actual_recovery: string;
    resilience_pct: number; // what % of affected VMs recovered
    verdict: "pass" | "partial" | "fail";
  };
}

export interface ChaosEngineOptions {
  agentCore: AgentCore;
  toolRegistry: ToolRegistry;
  eventBus: EventBus;
  healingOrchestrator: HealingOrchestrator;
  /**
   * Approval gate wired in so high-risk chaos scenarios actually stop
   * and wait for an operator decision instead of just updating a
   * recommendation string. When absent, the engine still enforces the
   * NEVER list and the risk threshold, but treats the missing gate as
   * an auto-reject (fail-safe, never fail-open).
   *
   * See docs/audits/security-2026-05-14.md (Finding X-1).
   */
  approvalGate?: ApprovalGate;
  /**
   * Risk-score threshold above which approval is required (assuming the
   * scenario sets `requires_approval`). Overrides
   * `RHODES_CHAOS_APPROVAL_RISK_THRESHOLD`. Set to 0 to require approval
   * for any approval-flagged scenario regardless of risk.
   */
  approvalRiskThreshold?: number;
  /**
   * Maximum time (ms) to wait for an approval decision before treating
   * it as a rejection. Defaults to 5 minutes. Override via
   * `RHODES_CHAOS_APPROVAL_TIMEOUT_MS`.
   */
  approvalTimeoutMs?: number;
}

// ── Constants ───────────────────────────────────────────────

/** VM IDs that must NEVER be targeted by chaos (e.g. the VM running RHODES itself) */
const PROTECTED_VMIDS = new Set(
  (process.env.CHAOS_PROTECTED_VMIDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

/** Maximum time (ms) to wait for healing to complete before declaring failure */
const MAX_RECOVERY_WAIT_MS = 5 * 60 * 1000;
/** Polling interval (ms) while waiting for recovery */
const RECOVERY_POLL_MS = 5_000;
/** Default predicted recovery time when no historical data exists */
const DEFAULT_PREDICTED_RECOVERY_S = 60;

// ── Approval Gate Constants ─────────────────────────────────

/** Default risk-score threshold (>) that demands approval. */
const DEFAULT_APPROVAL_RISK_THRESHOLD = 70;
/** Default wait window for an approval decision before treating as reject. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hardcoded NEVER list — scenario IDs that are unconditionally blocked,
 * regardless of `requires_approval`, `risk_score`, env overrides, or
 * operator approval. Matches the SSH adapter's `never` tier semantics:
 * not approvable.
 *
 * Built-in scenarios today are all reversible. These IDs are reserved
 * for any future scenario whose name literally describes a destructive
 * primitive — they would still be rejected here even if someone added
 * them to the registry by accident.
 */
const NEVER_SCENARIO_IDS: ReadonlySet<string> = new Set([
  "vm_destroy",
  "delete_volume",
  "wipe_node",
  "format_storage",
]);

/**
 * Hardcoded NEVER regex — any scenario whose id OR any action's `type`
 * or `description` matches this pattern is unconditionally blocked.
 * Words are matched with `\b` boundaries (case-insensitive).
 * Intentionally narrow: only literal destruction primitives, never
 * broader words like "kill" which legitimately apply to "stop the VM"
 * semantics for `vm_kill` / `random_vm_kill`.
 */
const NEVER_ACTION_REGEX = /\b(destroy|delete|wipe|format)\b/i;

// ── ChaosEngine ─────────────────────────────────────────────

export class ChaosEngine {
  private agentCore: AgentCore;
  private toolRegistry: ToolRegistry;
  private eventBus: EventBus;
  private healingOrchestrator: HealingOrchestrator;
  private approvalGate?: ApprovalGate;
  /** Risk threshold above which approval is required (`>`, not `>=`). */
  private approvalRiskThreshold: number;
  /** Wait window for an approval decision before treating as reject. */
  private approvalTimeoutMs: number;

  private history: ChaosRun[] = [];
  private activeRun: ChaosRun | null = null;

  constructor(options: ChaosEngineOptions) {
    this.agentCore = options.agentCore;
    this.toolRegistry = options.toolRegistry;
    this.eventBus = options.eventBus;
    this.healingOrchestrator = options.healingOrchestrator;
    this.approvalGate = options.approvalGate;

    const envThreshold = Number(process.env.RHODES_CHAOS_APPROVAL_RISK_THRESHOLD);
    this.approvalRiskThreshold =
      options.approvalRiskThreshold ??
      (Number.isFinite(envThreshold) && envThreshold >= 0
        ? envThreshold
        : DEFAULT_APPROVAL_RISK_THRESHOLD);

    const envTimeout = Number(process.env.RHODES_CHAOS_APPROVAL_TIMEOUT_MS);
    this.approvalTimeoutMs =
      options.approvalTimeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : DEFAULT_APPROVAL_TIMEOUT_MS);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Run blast-radius analysis for a scenario WITHOUT executing it.
   * This is the star function: it queries the current cluster state,
   * identifies every VM/resource that would be affected, and uses
   * historical incident data to predict recovery time.
   */
  async simulate(
    scenarioId: string,
    params?: Record<string, unknown>,
  ): Promise<ChaosRun> {
    const scenario = this.resolveScenario(scenarioId);
    const run = this.createRun(scenario);
    run.status = "simulating";

    try {
      const clusterState = await this.toolRegistry.getClusterState();
      if (!clusterState) {
        throw new Error("Cannot simulate: no cluster state available (adapter disconnected?)");
      }

      const blastRadius = this.computeBlastRadius(scenario, clusterState, params);
      const predictedRecovery = this.predictRecoveryTime(scenario, blastRadius);
      const riskScore = this.computeRiskScore(scenario, blastRadius, clusterState);
      const recommendation = this.generateRecommendation(scenario, blastRadius, riskScore);

      run.simulation = {
        blast_radius: blastRadius,
        predicted_recovery_time_s: predictedRecovery,
        risk_score: riskScore,
        recommendation,
      };

      run.status = "pending";
      this.emitEvent(AgentEventType.ChaosSimulated, {
        run_id: run.id,
        scenario_id: scenario.id,
        total_affected: blastRadius.total_affected,
        predicted_recovery_s: predictedRecovery,
        risk_score: riskScore,
        recommendation,
      });

      return run;
    } catch (err) {
      run.status = "failed";
      run.completed_at = new Date().toISOString();
      this.history.push(run);
      throw err;
    }
  }

  /**
   * Actually execute a chaos scenario: inject failures, then wait for
   * the healing orchestrator to detect and recover. Simulation runs
   * automatically as the first step.
   *
   * Approval gating (security X-1):
   *   1. Hardcoded NEVER list rejects the run before simulation.
   *   2. After simulate(), if `requires_approval && risk_score > threshold`
   *      the engine awaits `approvalGate.requestApproval()` and bails out
   *      on reject / timeout. Threshold is configurable via the
   *      `RHODES_CHAOS_APPROVAL_RISK_THRESHOLD` env var (default 70).
   *      A threshold of 0 means "always require approval when the
   *      scenario flags `requires_approval`".
   */
  async execute(
    scenarioId: string,
    params?: Record<string, unknown>,
  ): Promise<ChaosRun> {
    if (this.activeRun) {
      throw new Error(
        `A chaos run is already active: ${this.activeRun.id} (scenario: ${this.activeRun.scenario.id}). ` +
        `Only one run at a time is allowed.`,
      );
    }

    // Step 0: NEVER-list check — unconditional, before simulation.
    // These scenarios are never approvable; they never even reach the gate.
    const preScenario = this.resolveScenario(scenarioId);
    const neverReason = this.matchesNeverList(preScenario);
    if (neverReason) {
      const blockedRun = this.createRun(preScenario);
      blockedRun.status = "blocked";
      blockedRun.completed_at = new Date().toISOString();
      blockedRun.approval = {
        required: false,
        threshold: this.approvalRiskThreshold,
        decision: "blocked",
        decided_at: blockedRun.completed_at,
      };
      blockedRun.simulation.recommendation =
        `[BLOCKED-NEVER] ${neverReason}. This scenario is unconditionally forbidden.`;
      this.emitEvent(AgentEventType.ChaosBlocked, {
        run_id: blockedRun.id,
        scenario_id: preScenario.id,
        reason: neverReason,
        params: params ?? {},
      });
      this.emitAuditEvent(blockedRun, params, false);
      this.history.push(blockedRun);
      return blockedRun;
    }

    // Step 1: Simulate to get blast radius
    const run = await this.simulate(scenarioId, params);

    const requiresApproval =
      run.scenario.requires_approval &&
      run.simulation.risk_score > this.approvalRiskThreshold;

    if (requiresApproval) {
      run.simulation.recommendation =
        `[APPROVAL REQUIRED] Risk score ${run.simulation.risk_score}/100 exceeds threshold ${this.approvalRiskThreshold}. ` +
        run.simulation.recommendation;

      this.activeRun = run;
      run.status = "awaiting_approval";

      const decision = await this.awaitApprovalDecision(run, params);
      if (decision.outcome !== "approved") {
        run.status = "rejected";
        run.completed_at = new Date().toISOString();
        run.approval = {
          required: true,
          threshold: this.approvalRiskThreshold,
          decision: decision.outcome === "timeout" ? "timeout" : "rejected",
          decided_at: run.completed_at,
          operator: decision.operator,
          plan_id: decision.planId,
        };
        const eventType =
          decision.outcome === "timeout"
            ? AgentEventType.ChaosApprovalTimeout
            : AgentEventType.ChaosRejected;
        this.emitEvent(eventType, {
          run_id: run.id,
          scenario_id: run.scenario.id,
          scenario_name: run.scenario.name,
          risk_score: run.simulation.risk_score,
          plan_id: decision.planId,
          reason: decision.reason,
          timeout_ms: this.approvalTimeoutMs,
        });
        this.emitAuditEvent(run, params, false);
        this.history.push(run);
        this.activeRun = null;
        return run;
      }

      run.approval = {
        required: true,
        threshold: this.approvalRiskThreshold,
        decision: "approved",
        decided_at: new Date().toISOString(),
        operator: decision.operator,
        plan_id: decision.planId,
      };
      this.emitEvent(AgentEventType.ChaosApproved, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        scenario_name: run.scenario.name,
        risk_score: run.simulation.risk_score,
        plan_id: decision.planId,
        operator: decision.operator,
      });
    } else {
      run.approval = {
        required: false,
        threshold: this.approvalRiskThreshold,
        decision: "not_required",
      };
    }

    this.activeRun = run;
    run.status = "executing";
    const executionStart = Date.now();

    this.emitEvent(AgentEventType.ChaosStarted, {
      run_id: run.id,
      scenario_id: run.scenario.id,
      scenario_name: run.scenario.name,
      severity: run.scenario.severity,
      total_affected: run.simulation.blast_radius.total_affected,
      affected_vms: run.simulation.blast_radius.affected_vms
        .filter((v) => v.will_be_affected)
        .map((v) => ({ vmid: v.vmid, name: v.name, node: v.node })),
    });

    try {
      // Step 2: Inject failures
      const clusterState = await this.toolRegistry.getClusterState();
      if (!clusterState) {
        throw new Error("Cluster state unavailable during execution");
      }

      const stepsExecuted = await this.injectFailures(run.scenario, clusterState, params);

      // Step 3: Wait for healing
      run.status = "recovering";
      this.emitEvent(AgentEventType.ChaosRecoveryDetected, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        message: "Failures injected, waiting for healing orchestrator to respond",
      });

      const affectedVmids = run.simulation.blast_radius.affected_vms
        .filter((v) => v.will_be_affected)
        .map((v) => v.vmid);

      const recoveryResult = await this.waitForRecovery(
        affectedVmids,
        run.scenario.expected_recovery.max_recovery_time_s * 1000,
      );

      const recoveryTimeS = (Date.now() - executionStart) / 1000;

      // Step 4: Verify and score
      run.status = "verifying";
      const incidentsCreated = this.findRelevantIncidents(affectedVmids, executionStart);

      run.actual = {
        recovery_time_s: Math.round(recoveryTimeS * 10) / 10,
        all_recovered: recoveryResult.allRecovered,
        incidents_created: incidentsCreated.map((i) => i.id),
        steps_executed: stepsExecuted,
      };

      run.score = this.scoreRun(run);
      run.status = "completed";
      run.completed_at = new Date().toISOString();

      this.emitEvent(AgentEventType.ChaosCompleted, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        verdict: run.score.verdict,
        resilience_pct: run.score.resilience_pct,
        predicted_recovery_s: run.simulation.predicted_recovery_time_s,
        actual_recovery_s: run.actual.recovery_time_s,
        all_recovered: run.actual.all_recovered,
        incidents_created: run.actual.incidents_created.length,
      });

      this.emitAuditEvent(run, params, true);
      this.history.push(run);
      this.activeRun = null;
      return run;
    } catch (err) {
      run.status = "failed";
      run.completed_at = new Date().toISOString();

      const errMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent(AgentEventType.ChaosFailed, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        error: errMsg,
      });

      this.emitAuditEvent(run, params, true, errMsg);
      this.history.push(run);
      this.activeRun = null;
      throw err;
    }
  }

  /**
   * Get all past chaos runs.
   */
  getHistory(): ChaosRun[] {
    return [...this.history];
  }

  /**
   * Get the currently executing chaos run, if any.
   */
  getActiveRun(): ChaosRun | null {
    return this.activeRun;
  }

  /**
   * Cancel the currently active chaos run.
   */
  cancel(): ChaosRun | null {
    if (!this.activeRun) return null;
    const run = this.activeRun;
    run.status = "failed";
    run.completed_at = new Date().toISOString();
    this.emitEvent(AgentEventType.ChaosFailed, {
      run_id: run.id,
      scenario_id: run.scenario.id,
      error: "Cancelled by operator",
    });
    this.history.push(run);
    this.activeRun = null;
    return run;
  }

  /**
   * List all available scenarios (built-in).
   */
  listScenarios(): ChaosScenario[] {
    return getAllScenarios();
  }

  // ── Blast Radius Analysis ─────────────────────────────────

  private computeBlastRadius(
    scenario: ChaosScenario,
    clusterState: ClusterState,
    params?: Record<string, unknown>,
  ): BlastRadiusResult {
    const runningVMs = clusterState.vms.filter(
      (v) => v.status === "running" && !PROTECTED_VMIDS.has(String(v.id)),
    );
    const affectedVMs: BlastRadiusResult["affected_vms"] = [];

    switch (scenario.id) {
      case "vm_kill": {
        const targetVmid = params?.vmid as string | number | undefined;
        if (!targetVmid) {
          throw new Error("vm_kill scenario requires params.vmid");
        }
        const targetVmidStr = String(targetVmid);
        if (PROTECTED_VMIDS.has(targetVmidStr)) {
          throw new Error(`VM ${targetVmid} is protected — it runs RHODES itself and cannot be targeted`);
        }
        const vm = clusterState.vms.find((v) => String(v.id) === targetVmidStr);
        if (!vm) {
          throw new Error(`VM ${targetVmid} not found in cluster state`);
        }
        affectedVMs.push({
          vmid: String(vm.id),
          name: vm.name,
          node: vm.node,
          status: vm.status,
          will_be_affected: true,
          expected_recovery: "Self-healing restart via vm_stopped playbook",
        });
        break;
      }

      case "random_vm_kill": {
        if (runningVMs.length === 0) {
          throw new Error("No running VMs available for random_vm_kill");
        }
        // Show all running VMs; mark one as the random pick
        const pickIndex = Math.floor(Math.random() * runningVMs.length);
        for (let i = 0; i < runningVMs.length; i++) {
          const vm = runningVMs[i];
          affectedVMs.push({
            vmid: String(vm.id),
            name: vm.name,
            node: vm.node,
            status: vm.status,
            will_be_affected: i === pickIndex,
            expected_recovery:
              i === pickIndex
                ? "Self-healing restart via vm_stopped playbook"
                : "Not affected",
          });
        }
        break;
      }

      case "multi_vm_kill": {
        const count = Math.min(
          (params?.count as number) || 2,
          runningVMs.length,
        );
        if (runningVMs.length < 2) {
          throw new Error(
            `multi_vm_kill requires at least 2 running VMs (found ${runningVMs.length})`,
          );
        }
        // Shuffle and pick
        const shuffled = [...runningVMs].sort(() => Math.random() - 0.5);
        const picked = new Set(shuffled.slice(0, count).map((v) => String(v.id)));

        for (const vm of runningVMs) {
          affectedVMs.push({
            vmid: String(vm.id),
            name: vm.name,
            node: vm.node,
            status: vm.status,
            will_be_affected: picked.has(String(vm.id)),
            expected_recovery: picked.has(String(vm.id))
              ? "Concurrent self-healing restart"
              : "Not affected",
          });
        }
        break;
      }

      case "node_drain": {
        const targetNode = params?.node as string | undefined;
        if (!targetNode) {
          throw new Error("node_drain scenario requires params.node");
        }
        const nodeExists = clusterState.nodes.some(
          (n) => n.name === targetNode,
        );
        if (!nodeExists) {
          throw new Error(`Node "${targetNode}" not found in cluster state`);
        }

        for (const vm of clusterState.vms) {
          const onTargetNode = vm.node === targetNode;
          affectedVMs.push({
            vmid: String(vm.id),
            name: vm.name,
            node: vm.node,
            status: vm.status,
            will_be_affected: onTargetNode && vm.status === "running",
            expected_recovery: onTargetNode
              ? "Bulk restart or migration after node failure detection"
              : "Not affected (different node)",
          });
        }
        break;
      }

      case "cpu_stress":
      case "memory_pressure":
      case "network_partition": {
        const targetVmid = params?.vmid as string | number | undefined;
        if (!targetVmid) {
          throw new Error(`${scenario.id} scenario requires params.vmid`);
        }

        const targetVmidStr = String(targetVmid);
        if (PROTECTED_VMIDS.has(targetVmidStr)) {
          throw new Error(`VM ${targetVmid} is protected — it runs RHODES itself and cannot be targeted`);
        }

        const vm = clusterState.vms.find((v) => String(v.id) === targetVmidStr);
        if (!vm) {
          throw new Error(`VM ${targetVmid} not found in cluster state`);
        }

        affectedVMs.push({
          vmid: String(vm.id),
          name: vm.name,
          node: vm.node,
          status: vm.status,
          will_be_affected: vm.status === "running",
          expected_recovery: scenario.id === "network_partition"
            ? "Connectivity should recover after partition window ends"
            : "Resource pressure should recover after stress window ends",
        });
        break;
      }

      default:
        throw new Error(`Unknown scenario: ${scenario.id}`);
    }

    const affected = affectedVMs.filter((v) => v.will_be_affected);
    // Heuristic: VMs with names containing critical-service keywords
    const criticalPatterns = /\b(db|database|api|gateway|dns|auth|ldap|ad|vcenter)\b/i;
    const criticalCount = affected.filter((v) =>
      criticalPatterns.test(v.name),
    ).length;

    return {
      affected_vms: affectedVMs,
      total_affected: affected.length,
      critical_services_affected: criticalCount,
      estimated_downtime_s: scenario.expected_recovery.max_recovery_time_s,
    };
  }

  // ── Recovery Prediction ───────────────────────────────────

  private predictRecoveryTime(
    scenario: ChaosScenario,
    blastRadius: BlastRadiusResult,
  ): number {
    // Use historical incident data to refine predictions
    const incidentManager = this.healingOrchestrator.incidentManager;
    const recentIncidents = incidentManager.getRecent(50);

    // Find resolved VM-status incidents and compute average resolution time
    const vmResolved = recentIncidents.filter(
      (i) =>
        i.status === "resolved" &&
        i.metric === "vm_status" &&
        i.duration_ms !== undefined,
    );

    let baseRecoveryS: number;
    if (vmResolved.length > 0) {
      const avgMs =
        vmResolved.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0) /
        vmResolved.length;
      baseRecoveryS = Math.round(avgMs / 1000);
    } else {
      baseRecoveryS = DEFAULT_PREDICTED_RECOVERY_S;
    }

    // Scale by blast radius: more VMs = longer recovery
    const scaleFactor = Math.max(1, blastRadius.total_affected * 0.5);
    // Critical services add extra predicted time
    const criticalPenalty = blastRadius.critical_services_affected * 15;

    return Math.round(baseRecoveryS * scaleFactor + criticalPenalty);
  }

  // ── Risk Scoring ──────────────────────────────────────────

  private computeRiskScore(
    scenario: ChaosScenario,
    blastRadius: BlastRadiusResult,
    clusterState: ClusterState,
  ): number {
    let score = 0;

    // Severity contribution (0-30)
    const severityWeights: Record<string, number> = {
      low: 5,
      medium: 15,
      high: 25,
      critical: 30,
    };
    score += severityWeights[scenario.severity] ?? 15;

    // Blast radius contribution (0-30)
    const totalRunning = clusterState.vms.filter(
      (v) => v.status === "running",
    ).length;
    const affectedPct =
      totalRunning > 0
        ? (blastRadius.total_affected / totalRunning) * 100
        : 0;
    score += Math.min(30, Math.round(affectedPct * 0.3));

    // Critical services contribution (0-20)
    score += Math.min(20, blastRadius.critical_services_affected * 10);

    // Cluster health contribution (0-20)
    // If the cluster is already stressed, the risk is higher
    const offlineNodes = clusterState.nodes.filter(
      (n) => n.status !== "online",
    ).length;
    score += Math.min(10, offlineNodes * 5);

    const avgCpuPct =
      clusterState.nodes.length > 0
        ? clusterState.nodes.reduce((s, n) => s + n.cpu_usage_pct, 0) /
          clusterState.nodes.length
        : 0;
    if (avgCpuPct > 70) score += 5;
    if (avgCpuPct > 85) score += 5;

    return Math.min(100, Math.max(0, score));
  }

  // ── Recommendation Generation ─────────────────────────────

  private generateRecommendation(
    scenario: ChaosScenario,
    blastRadius: BlastRadiusResult,
    riskScore: number,
  ): string {
    const parts: string[] = [];

    if (riskScore <= 20) {
      parts.push("Low risk. Safe to execute.");
    } else if (riskScore <= 50) {
      parts.push("Moderate risk. Review blast radius before proceeding.");
    } else if (riskScore <= 70) {
      parts.push("Elevated risk. Consider running during a maintenance window.");
    } else {
      parts.push("HIGH RISK. Manual approval strongly recommended.");
    }

    if (blastRadius.critical_services_affected > 0) {
      parts.push(
        `${blastRadius.critical_services_affected} critical service(s) will be affected.`,
      );
    }

    if (blastRadius.total_affected === 0) {
      parts.push("No running VMs would be affected — scenario may be a no-op.");
    }

    if (scenario.requires_approval) {
      parts.push("This scenario requires operator approval.");
    }

    return parts.join(" ");
  }

  // ── Failure Injection ─────────────────────────────────────

  private async injectFailures(
    scenario: ChaosScenario,
    clusterState: ClusterState,
    params?: Record<string, unknown>,
  ): Promise<number> {
    let stepsExecuted = 0;
    const runningVMs = clusterState.vms.filter(
      (v) => v.status === "running" && !PROTECTED_VMIDS.has(String(v.id)),
    );

    for (const action of scenario.actions) {
      if (action.delay_before_ms && action.delay_before_ms > 0) {
        await this.sleep(action.delay_before_ms);
      }

      switch (action.type) {
        case "stop_vm":
        case "kill_vm": {
          const targets = this.resolveTargetVMs(
            action,
            scenario,
            runningVMs,
            params,
          );
          for (const vm of targets) {
            await this.stopVM(vm);
            stepsExecuted++;
          }
          break;
        }

        case "custom_goal": {
          const goalDesc =
            (action.params.goal_description as string) ||
            action.description;
          const goal = {
            id: randomUUID(),
            mode: "build" as const,
            description: goalDesc,
            raw_input: goalDesc,
            created_at: new Date().toISOString(),
          };
          await this.agentCore.run(goal);
          stepsExecuted++;
          break;
        }

        case "stress_cpu":
        case "stress_memory":
        case "disconnect_network": {
          const targets = this.resolveTargetVMs(
            action,
            scenario,
            runningVMs,
            params,
          );
          for (const vm of targets) {
            await this.injectGuestFault(vm, action);
            stepsExecuted++;
          }
          break;
        }

        // fill_disk — placeholder for future implementation
        default:
          console.warn(
            `[chaos] Action type "${action.type}" not yet implemented, skipping`,
          );
          break;
      }
    }

    return stepsExecuted;
  }

  /**
   * Determine which VMs to target for a stop/kill action based on
   * the scenario type and user-provided params.
   */
  private resolveTargetVMs(
    _action: ChaosAction,
    scenario: ChaosScenario,
    runningVMs: VMInfo[],
    params?: Record<string, unknown>,
  ): VMInfo[] {
    // Node drain: all running VMs on the target node
    if (_action.params.all_on_node) {
      const node = params?.node as string | undefined;
      if (!node) throw new Error("node_drain requires params.node");
      return runningVMs.filter((v) => v.node === node);
    }

    // Random pick (single or multiple)
    if (_action.params.random) {
      const count = Math.min(
        (_action.params.count as number) || (params?.count as number) || 1,
        runningVMs.length,
      );
      const shuffled = [...runningVMs].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count);
    }

    // Explicit target by vmid
    const vmid = (params?.vmid as string | number | undefined) ?? _action.target;
    if (vmid !== undefined) {
      const vm = runningVMs.find((v) => String(v.id) === String(vmid));
      if (!vm) {
        throw new Error(
          `Target VM ${vmid} not found or not running`,
        );
      }
      return [vm];
    }

    throw new Error(
      `Cannot resolve target VMs for action "${_action.type}" in scenario "${scenario.id}". ` +
      `Provide params.vmid, params.node, or use a random-pick scenario.`,
    );
  }

  /**
   * Force-stop a VM via the infrastructure adapter.
   */
  private async stopVM(vm: VMInfo): Promise<void> {
    console.log(`[chaos] Stopping VM ${vm.name} (${vm.id}) on ${vm.node}`);
    const vmId = String(vm.id);
    const result = vmId.startsWith("vm-")
      ? await this.toolRegistry.execute("vmware_vm_power_off", {
          vm_id: vmId,
        })
      : await this.toolRegistry.execute("stop_vm", {
          node: vm.node,
          vmid: Number(vm.id),
        });
    if (!result.success) {
      throw new Error(
        `Failed to stop VM ${vm.id} (${vm.name}): ${result.error}`,
      );
    }
  }

  private async injectGuestFault(vm: VMInfo, action: ChaosAction): Promise<void> {
    if (!vm.ip_address) {
      throw new Error(
        `VM ${vm.id} (${vm.name}) has no IP address; cannot execute guest-level chaos action "${action.type}"`,
      );
    }

    const durationS = Math.max(
      1,
      Number(action.params.duration_s ?? 60),
    );

    let command: string;
    if (action.type === "stress_cpu") {
      const workers = Math.max(1, Number(action.params.workers ?? 2));
      command = [
        "sh -lc",
        `'for i in $(seq 1 ${workers}); do yes > /dev/null & done;`,
        `sleep ${durationS};`,
        "pkill -f '^yes$' || true'",
      ].join(" ");
    } else if (action.type === "stress_memory") {
      const bytesMb = Math.max(32, Number(action.params.bytes_mb ?? 512));
      const bytes = bytesMb * 1024 * 1024;
      command = [
        "python3 -c",
        `'import time; _buf=bytearray(${bytes}); time.sleep(${durationS})'`,
      ].join(" ");
    } else {
      command = [
        "sh -lc",
        `'iptables -I INPUT -j DROP; iptables -I OUTPUT -j DROP;`,
        `sleep ${durationS};`,
        "iptables -D INPUT 1 || true; iptables -D OUTPUT 1 || true'",
      ].join(" ");
    }

    const result = await this.toolRegistry.execute("ssh_exec", {
      host: vm.ip_address,
      user: "root",
      command,
      timeout_ms: (durationS + 30) * 1000,
    });
    if (!result.success) {
      throw new Error(
        `Failed to execute "${action.type}" on VM ${vm.id} (${vm.name}): ${result.error}`,
      );
    }
  }

  // ── Recovery Monitoring ───────────────────────────────────

  /**
   * Poll the cluster state until all affected VMs are running again
   * or the timeout expires.
   */
  private async waitForRecovery(
    affectedVmids: string[],
    timeoutMs: number,
  ): Promise<{ allRecovered: boolean; recovered: string[]; notRecovered: string[] }> {
    const deadline = Date.now() + Math.min(timeoutMs, MAX_RECOVERY_WAIT_MS);
    const recoveredSet = new Set<string>();

    while (Date.now() < deadline) {
      await this.sleep(RECOVERY_POLL_MS);

      const state = await this.toolRegistry.getClusterState();
      if (!state) continue;

      for (const vmid of affectedVmids) {
        if (recoveredSet.has(vmid)) continue;
        const vm = state.vms.find((v) => String(v.id) === vmid);
        if (vm && vm.status === "running") {
          recoveredSet.add(vmid);
          console.log(`[chaos] VM ${vmid} recovered (running)`);
        }
      }

      if (recoveredSet.size === affectedVmids.length) {
        break;
      }
    }

    const notRecovered = affectedVmids.filter((id) => !recoveredSet.has(id));
    return {
      allRecovered: notRecovered.length === 0,
      recovered: [...recoveredSet],
      notRecovered,
    };
  }

  /**
   * Find incidents that were opened for the affected VMs during this chaos run.
   */
  private findRelevantIncidents(
    affectedVmids: string[],
    executionStartMs: number,
  ): Incident[] {
    const recent = this.healingOrchestrator.incidentManager.getRecent(50);
    const vmidStrings = new Set(affectedVmids.map(String));

    return recent.filter((incident) => {
      const incidentTime = new Date(incident.detected_at).getTime();
      if (incidentTime < executionStartMs) return false;
      // Match by vmid label
      return vmidStrings.has(incident.labels.vmid);
    });
  }

  // ── Scoring ───────────────────────────────────────────────

  private scoreRun(run: ChaosRun): NonNullable<ChaosRun["score"]> {
    const predicted = run.simulation.predicted_recovery_time_s;
    const actual = run.actual!.recovery_time_s;
    const totalAffected = run.simulation.blast_radius.total_affected;

    // Predicted vs actual comparison
    let comparison: string;
    const diff = actual - predicted;
    const pctDiff =
      predicted > 0 ? Math.round((diff / predicted) * 100) : 0;
    if (Math.abs(pctDiff) <= 10) {
      comparison = `Accurate (predicted ${predicted}s, actual ${actual}s, ${pctDiff > 0 ? "+" : ""}${pctDiff}%)`;
    } else if (actual < predicted) {
      comparison = `Faster than predicted (predicted ${predicted}s, actual ${actual}s, ${pctDiff}%)`;
    } else {
      comparison = `Slower than predicted (predicted ${predicted}s, actual ${actual}s, +${pctDiff}%)`;
    }

    // Resilience percentage
    let resiliencePct: number;
    if (totalAffected === 0) {
      resiliencePct = 100;
    } else if (run.actual!.all_recovered) {
      resiliencePct = 100;
    } else {
      // Count how many VMs actually recovered (incidents resolved)
      const resolvedIncidents = run.actual!.incidents_created.filter((id) => {
        const incident = this.healingOrchestrator.incidentManager.getById(id);
        return incident?.status === "resolved";
      });
      resiliencePct = Math.round(
        (resolvedIncidents.length / totalAffected) * 100,
      );
    }

    // Verdict
    let verdict: "pass" | "partial" | "fail";
    if (
      run.actual!.all_recovered &&
      actual <= run.scenario.expected_recovery.max_recovery_time_s
    ) {
      verdict = "pass";
    } else if (resiliencePct >= 50) {
      verdict = "partial";
    } else {
      verdict = "fail";
    }

    return {
      predicted_vs_actual_recovery: comparison,
      resilience_pct: resiliencePct,
      verdict,
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private resolveScenario(scenarioId: string): ChaosScenario {
    const scenario = getScenario(scenarioId);
    if (!scenario) {
      const available = getAllScenarios()
        .map((s) => s.id)
        .join(", ");
      throw new Error(
        `Unknown scenario "${scenarioId}". Available: ${available}`,
      );
    }
    return scenario;
  }

  private createRun(scenario: ChaosScenario): ChaosRun {
    return {
      id: randomUUID(),
      scenario,
      status: "pending",
      started_at: new Date().toISOString(),
      simulation: {
        blast_radius: {
          affected_vms: [],
          total_affected: 0,
          critical_services_affected: 0,
          estimated_downtime_s: 0,
        },
        predicted_recovery_time_s: 0,
        risk_score: 0,
        recommendation: "",
      },
    };
  }

  private emitEvent(
    type: AgentEventType,
    data: Record<string, unknown>,
  ): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * Emit the structured ChaosAudited record. Always fires once per run
   * (approved, rejected, blocked, completed, or failed). This is what
   * the dashboard audit log + the Telegram bridge surface as the
   * single source of truth for "did this chaos test actually run?".
   */
  private emitAuditEvent(
    run: ChaosRun,
    params: Record<string, unknown> | undefined,
    executed: boolean,
    error?: string,
  ): void {
    const affected = run.simulation.blast_radius.affected_vms
      .filter((v) => v.will_be_affected)
      .map((v) => v.vmid);
    const target =
      affected.length > 0
        ? affected
        : params && (params.vmid !== undefined || params.node !== undefined)
          ? (params.vmid ?? params.node)
          : null;
    this.emitEvent(AgentEventType.ChaosAudited, {
      run_id: run.id,
      scenario: run.scenario.id,
      scenario_name: run.scenario.name,
      severity: run.scenario.severity,
      target,
      params: params ?? {},
      risk_score: run.simulation.risk_score,
      approval_required: run.approval?.required ?? false,
      approval_decision: run.approval?.decision ?? "not_required",
      approval_operator: run.approval?.operator,
      approval_plan_id: run.approval?.plan_id,
      executed,
      status: run.status,
      error,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Return a human-readable reason if the scenario matches the
   * hardcoded NEVER list, otherwise undefined. Belt-and-suspenders
   * defense: even if `requires_approval` is misconfigured, scenarios
   * whose id (or any action) literally names a destroy/delete/wipe/
   * format primitive are unconditionally blocked.
   */
  private matchesNeverList(scenario: ChaosScenario): string | undefined {
    if (NEVER_SCENARIO_IDS.has(scenario.id)) {
      return `scenario "${scenario.id}" is on the hardcoded NEVER list`;
    }
    if (NEVER_ACTION_REGEX.test(scenario.id)) {
      return `scenario id "${scenario.id}" matches NEVER pattern ${NEVER_ACTION_REGEX}`;
    }
    for (const action of scenario.actions ?? []) {
      if (typeof action.type === "string" && NEVER_ACTION_REGEX.test(action.type)) {
        return `action type "${action.type}" matches NEVER pattern ${NEVER_ACTION_REGEX}`;
      }
      if (typeof action.description === "string" && NEVER_ACTION_REGEX.test(action.description)) {
        return `action description matches NEVER pattern ${NEVER_ACTION_REGEX}`;
      }
    }
    return undefined;
  }

  /**
   * Await an operator decision from the wired ApprovalGate. Returns the
   * outcome (`approved` | `rejected` | `timeout`) plus optional operator
   * + plan_id metadata for the audit trail.
   *
   * Fail-safe behaviour:
   *   - No approval gate wired       → rejected (never fail-open).
   *   - No decision within window    → rejected with outcome=timeout.
   *   - Gate throws                  → rejected with the error as reason.
   */
  private async awaitApprovalDecision(
    run: ChaosRun,
    params: Record<string, unknown> | undefined,
  ): Promise<{
    outcome: "approved" | "rejected" | "timeout";
    operator?: string;
    planId?: string;
    reason?: string;
  }> {
    if (!this.approvalGate) {
      return {
        outcome: "rejected",
        reason:
          "no approval gate wired — high-risk chaos scenarios cannot run without an operator decision channel",
      };
    }

    const planId = (params?.plan_id as string | undefined) ?? `chaos:${run.id}`;
    const request: ApprovalRequest = {
      id: randomUUID(),
      action: `chaos:execute:${run.scenario.id}`,
      tier: "destructive",
      params: {
        scenario_id: run.scenario.id,
        risk_score: run.simulation.risk_score,
        total_affected: run.simulation.blast_radius.total_affected,
        critical_services: run.simulation.blast_radius.critical_services_affected,
        affected_vms: run.simulation.blast_radius.affected_vms
          .filter((v) => v.will_be_affected)
          .map((v) => ({ vmid: v.vmid, name: v.name, node: v.node })),
        ...(params ?? {}),
      },
      reasoning:
        `Chaos scenario "${run.scenario.name}" (${run.scenario.id}) risk ${run.simulation.risk_score}/100 ` +
        `exceeds approval threshold ${this.approvalRiskThreshold}. ` +
        run.simulation.recommendation,
      plan_id: planId,
      timestamp: new Date().toISOString(),
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ outcome: "timeout"; planId: string }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({ outcome: "timeout", planId });
      }, this.approvalTimeoutMs);
    });

    try {
      const decision = await Promise.race([
        this.approvalGate.requestApproval(request).then((response) => ({
          outcome: response.approved ? ("approved" as const) : ("rejected" as const),
          operator: response.approved_by,
          planId,
        })),
        timeoutPromise,
      ]);

      if (decision.outcome === "timeout") {
        return {
          outcome: "timeout",
          planId,
          reason: `no decision within ${this.approvalTimeoutMs}ms`,
        };
      }
      return decision;
    } catch (err) {
      return {
        outcome: "rejected",
        planId,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
