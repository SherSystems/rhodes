// ============================================================
// Governance Engine — The central authority for all agent actions
// Ties together policy, classification, approval, circuit
// breaking, and audit logging into a single evaluate() call.
// ============================================================

import { randomUUID } from "node:crypto";
import type {
  ActionTier,
  AgentMode,
  ApprovalResponse,
  AuditEntry,
  CircuitBreakerState,
  PolicyConfig,
  ToolDefinition,
} from "../types.js";
import { classifyAction } from "./classifier.js";
import { ApprovalGate } from "./approval.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { AuditLog } from "./audit.js";

// ── Types ───────────────────────────────────────────────────

export interface GovernanceDecision {
  allowed: boolean;
  tier: ActionTier;
  needs_approval: boolean;
  reason: string;
  approval?: ApprovalResponse;
  approval_wait_ms?: number;
  explicit_approval_required?: boolean;
  rollback_required?: boolean;
  rollback_timeout_ms?: number;
}

// ── Re-exports ──────────────────────────────────────────────

export { loadPolicy } from "./policy.js";
export { classifyAction } from "./classifier.js";
export { ApprovalGate } from "./approval.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export { AuditLog } from "./audit.js";

// ── GovernanceEngine Class ──────────────────────────────────

export class GovernanceEngine {
  private readonly policy: PolicyConfig;
  readonly approvalGate: ApprovalGate;
  readonly circuitBreaker: CircuitBreaker;
  readonly audit: AuditLog;

  constructor(policy: PolicyConfig, auditDbPath?: string) {
    this.policy = policy;
    this.approvalGate = new ApprovalGate();
    this.circuitBreaker = new CircuitBreaker({
      maxConsecutiveFailures: policy.guardrails.max_restart_attempts,
      cooldownMs: policy.guardrails.cooldown_between_restarts_s * 1000,
    });
    this.audit = new AuditLog(auditDbPath);
  }

  /**
   * Evaluate whether an action is allowed under current governance rules.
   *
   * Flow:
   * 1. Check circuit breaker
   * 2. Classify action tier
   * 3. Check forbidden actions
   * 4. Check guardrails
   * 5. Determine if approval is needed
   * 6. Request approval if necessary
   * 7. Return decision
   */
  async evaluate(
    action: string,
    params: Record<string, unknown>,
    mode: AgentMode,
    tools: ToolDefinition[],
  ): Promise<GovernanceDecision> {
    const rollbackDefaults = this.getRollbackPolicy("read");

    // 1. Circuit breaker check
    if (this.circuitBreaker.isTripped()) {
      return {
        allowed: false,
        tier: "never",
        needs_approval: false,
        reason:
          "Circuit breaker is tripped due to consecutive failures. Waiting for cooldown.",
        explicit_approval_required: false,
        rollback_required: false,
        rollback_timeout_ms: rollbackDefaults.timeoutMs,
      };
    }

    // 2. Classify the action
    const tier = classifyAction(action, params, tools);
    const explicitApprovalRequired = this.approvalGate.requiresExplicitApproval(
      tier,
      this.policy,
    );
    const rollbackPolicy = this.getRollbackPolicy(tier);

    // 3. Forbidden tier — always blocked
    if (tier === "never") {
      return {
        allowed: false,
        tier,
        needs_approval: false,
        reason: `Action "${action}" is classified as forbidden and cannot be executed.`,
        explicit_approval_required: false,
        rollback_required: false,
        rollback_timeout_ms: rollbackPolicy.timeoutMs,
      };
    }

    // 4. Check boundary forbidden actions
    if (this.policy.boundaries.forbidden_actions.includes(action)) {
      return {
        allowed: false,
        tier,
        needs_approval: false,
        reason: `Action "${action}" is in the policy forbidden actions list.`,
        explicit_approval_required: explicitApprovalRequired,
        rollback_required: false,
        rollback_timeout_ms: rollbackPolicy.timeoutMs,
      };
    }

    // 5. Check guardrails
    const guardrailViolation = this.checkGuardrails(action, params);
    if (guardrailViolation) {
      return {
        allowed: false,
        tier,
        needs_approval: false,
        reason: guardrailViolation,
        explicit_approval_required: explicitApprovalRequired,
        rollback_required: false,
        rollback_timeout_ms: rollbackPolicy.timeoutMs,
      };
    }

    // 6. Determine approval requirement
    const needsApproval = this.approvalGate.needsApproval(
      tier,
      mode,
      this.policy,
    );

    if (!needsApproval) {
      return {
        allowed: true,
        tier,
        needs_approval: false,
        reason: `Action "${action}" (${tier}) auto-approved under ${mode} mode.`,
        approval: this.approvalGate.autoApprove(randomUUID()),
        explicit_approval_required: explicitApprovalRequired,
        rollback_required: rollbackPolicy.required,
        rollback_timeout_ms: rollbackPolicy.timeoutMs,
      };
    }

    // 6b. If the plan was already approved at plan-level, skip step-level approval
    //     only when this tier does not require explicit per-step approval.
    const planId = params._plan_id as string | undefined;
    if (
      planId
      && !explicitApprovalRequired
      && this.approvalGate.isPlanApproved(planId)
    ) {
      return {
        allowed: true,
        tier,
        needs_approval: false,
        reason: `Action "${action}" (${tier}) covered by plan-level approval.`,
        approval: this.approvalGate.autoApprove(randomUUID()),
        explicit_approval_required: false,
        rollback_required: rollbackPolicy.required,
        rollback_timeout_ms: rollbackPolicy.timeoutMs,
      };
    }

    // 7. Request human approval
    const approvalRequest = {
      id: randomUUID(),
      action,
      tier,
      params,
      reasoning: `Action "${action}" classified as ${tier} requires approval in ${mode} mode.`,
      timestamp: new Date().toISOString(),
    };

    const approvalStart = Date.now();
    const approval =
      await this.approvalGate.requestApproval(approvalRequest);
    const approvalWaitMs = Date.now() - approvalStart;
    const explicitApproved =
      !explicitApprovalRequired
      || (approval.approved && approval.method !== "auto");

    return {
      allowed: approval.approved && explicitApproved,
      tier,
      needs_approval: true,
      reason: !approval.approved
        ? `Action "${action}" rejected by user.`
        : !explicitApproved
          ? `Action "${action}" requires explicit human approval and auto-approval is not allowed.`
          : `Action "${action}" approved by ${approval.approved_by}.`,
      approval,
      approval_wait_ms: approvalWaitMs,
      explicit_approval_required: explicitApprovalRequired,
      rollback_required: rollbackPolicy.required,
      rollback_timeout_ms: rollbackPolicy.timeoutMs,
    };
  }

  /**
   * Log a completed action to the audit trail.
   * Also tracks success/failure in the circuit breaker.
   */
  logAction(entry: AuditEntry): void {
    // Track in circuit breaker
    this.circuitBreaker.track(entry.result === "success");

    // Persist to audit log
    if (this.policy.audit.log_all_actions) {
      this.audit.log(entry);
    } else if (entry.result !== "success") {
      // Always log failures even if log_all_actions is false
      this.audit.log(entry);
    }
  }

  /**
   * Get the current circuit breaker state.
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  /**
   * Get aggregate audit statistics.
   */
  getAuditStats(): object {
    return this.audit.getStats();
  }

  /**
   * Clean shutdown — close database connections.
   */
  close(): void {
    this.audit.close();
  }

  // ── Private Helpers ─────────────────────────────────────────

  private checkGuardrails(
    action: string,
    params: Record<string, unknown>,
  ): string | null {
    const g = this.policy.guardrails;

    // VM count limit
    const vmCount =
      (params.count as number) ??
      (params.num_vms as number) ??
      (params.quantity as number);
    if (typeof vmCount === "number" && vmCount > g.max_vms_per_action) {
      return `Guardrail violation: requested ${vmCount} VMs exceeds max_vms_per_action (${g.max_vms_per_action}).`;
    }

    // Forbidden VMID check
    const vmid = params.vmid as number | undefined;
    if (
      typeof vmid === "number" &&
      this.policy.boundaries.forbidden_vmids.includes(vmid)
    ) {
      return `Guardrail violation: VMID ${vmid} is in the forbidden list.`;
    }

    // Allowed networks check (if configured)
    const network = params.network as string | undefined;
    if (
      network &&
      this.policy.boundaries.allowed_networks.length > 0 &&
      !this.policy.boundaries.allowed_networks.includes(network)
    ) {
      return `Guardrail violation: network "${network}" is not in the allowed networks list.`;
    }

    // Allowed storage check (if configured)
    const storage = params.storage as string | undefined;
    if (
      storage &&
      this.policy.boundaries.allowed_storage.length > 0 &&
      !this.policy.boundaries.allowed_storage.includes(storage)
    ) {
      return `Guardrail violation: storage "${storage}" is not in the allowed storage list.`;
    }

    return null;
  }

  private getRollbackPolicy(
    tier: ActionTier,
  ): { required: boolean; timeoutMs: number } {
    const cfg = this.policy.orchestration.rollback;
    const timeoutMs = cfg.timeout_s * 1000;
    const required =
      cfg.enabled
      && cfg.trigger_tiers.includes(tier)
      && tier !== "never";

    return {
      required,
      timeoutMs,
    };
  }
}
