// ============================================================
// vClaw — Executor
// Runs plan steps through governance checks and tool execution
// ============================================================

import { randomUUID } from "node:crypto";
import { AgentEventType } from "../types.js";
import type {
  PlanStep,
  StepResult,
  AgentMode,
  ActionTier,
  AuditEntry,
  ToolDefinition,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus } from "./events.js";
import type { SandboxManager } from "../security/sandbox.js";

export interface GovernanceEngineRef {
  evaluate(
    action: string,
    params: Record<string, unknown>,
    mode: AgentMode,
    tools: ToolDefinition[],
  ): Promise<{
    allowed: boolean;
    tier: ActionTier;
    needs_approval: boolean;
    reason: string;
    approval?: { request_id: string; approved: boolean; method?: "cli" | "dashboard" | "auto" };
    approval_wait_ms?: number;
    explicit_approval_required?: boolean;
    rollback_required?: boolean;
    rollback_timeout_ms?: number;
  }>;
  logAction(entry: AuditEntry): void;
  circuitBreaker: {
    track(success: boolean): void;
    isTripped(): boolean;
  };
}

export class Executor {
  private toolRegistry: ToolRegistry;
  private governance: GovernanceEngineRef;
  private eventBus: EventBus;
  private sandbox?: SandboxManager;

  constructor(
    toolRegistry: ToolRegistry,
    governance: GovernanceEngineRef,
    eventBus: EventBus,
    sandbox?: SandboxManager,
  ) {
    this.toolRegistry = toolRegistry;
    this.governance = governance;
    this.eventBus = eventBus;
    if (sandbox) {
      this.sandbox = sandbox;
      this.sandbox.setExecutor((tool, params) => this.toolRegistry.execute(tool, params));
    }
  }

  /**
   * Execute a single plan step with full governance checks,
   * state capture, event emission, and audit logging.
   */
  async executeStep(
    step: PlanStep,
    mode: AgentMode,
    planId?: string,
    runId?: string,
  ): Promise<StepResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Emit step_started
    this.eventBus.emit({
      type: AgentEventType.StepStarted,
      timestamp,
      data: {
        step_id: step.id,
        action: step.action,
        description: step.description,
        plan_id: planId,
        run_id: runId,
      },
    });

    // Check circuit breaker
    if (this.governance.circuitBreaker.isTripped()) {
      const result = this.buildFailedResult(
        startTime,
        "Circuit breaker is tripped — too many consecutive failures",
      );
      this.emitStepFailed(step, result, planId, runId);
      this.logAudit(step, mode, "blocked", result, planId, "Circuit breaker tripped");
      return result;
    }

    // Evaluate governance
    let evaluation: Awaited<ReturnType<GovernanceEngineRef["evaluate"]>>;
    try {
      evaluation = await this.governance.evaluate(
        step.action,
        step.params,
        mode,
        this.toolRegistry.getAllTools(),
      );
    } catch (err) {
      const result = this.buildFailedResult(
        startTime,
        `Governance evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.emitStepFailed(step, result, planId, runId);
      return result;
    }

    // If not allowed, fail immediately
    if (!evaluation.allowed) {
      const result = this.buildFailedResult(
        startTime,
        `Blocked by governance: ${evaluation.reason}`,
      );
      this.emitStepFailed(step, result, planId, runId);
      this.logAudit(step, mode, "blocked", result, planId, evaluation.reason);
      return result;
    }

    const explicitApprovalRequired = evaluation.explicit_approval_required === true;
    const rollbackRequired = evaluation.rollback_required === true;
    const rollbackTimeoutMs = this.resolveRollbackTimeoutMs(
      evaluation.rollback_timeout_ms,
    );

    // If approval flow was involved, emit request/response events so telemetry can
    // capture wait durations and approval outcomes.
    if (evaluation.needs_approval) {
      this.eventBus.emit({
        type: AgentEventType.ApprovalRequested,
        timestamp: new Date().toISOString(),
        data: {
          step_id: step.id,
          action: step.action,
          tier: evaluation.tier,
          request_id: evaluation.approval?.request_id,
          plan_id: planId,
          run_id: runId,
        },
      });

      this.eventBus.emit({
        type: AgentEventType.ApprovalReceived,
        timestamp: new Date().toISOString(),
        data: {
          step_id: step.id,
          action: step.action,
          tier: evaluation.tier,
          request_id: evaluation.approval?.request_id,
          approved: evaluation.approval?.approved === true,
          wait_ms: evaluation.approval_wait_ms ?? 0,
          plan_id: planId,
          run_id: runId,
        },
      });

      if (!evaluation.approval || !evaluation.approval.approved) {
        const result = this.buildFailedResult(
          startTime,
          "Approval required but not granted",
        );
        this.emitStepFailed(step, result, planId, runId);
        this.logAudit(step, mode, "blocked", result, planId, "Approval not granted");
        return result;
      }
    }

    // Guard against bypass: unsafe tiers must have explicit human approval.
    if (
      explicitApprovalRequired
      && (!evaluation.approval || !evaluation.approval.approved || evaluation.approval.method === "auto")
    ) {
      const result = this.buildFailedResult(
        startTime,
        "Unsafe action blocked: explicit approval required",
      );
      this.emitStepFailed(step, result, planId, runId);
      this.logAudit(
        step,
        mode,
        "blocked",
        result,
        planId,
        "Explicit approval required",
      );
      return result;
    }

    // Capture state before execution
    let stateBefore: Record<string, unknown> | undefined;
    try {
      const clusterState = await this.toolRegistry.getClusterState();
      if (clusterState) {
        stateBefore = clusterState as unknown as Record<string, unknown>;
      }
    } catch {
      // State capture is best-effort; continue execution
    }

    // Execute the tool (via sandbox if available, otherwise direct)
    let toolResult: { success: boolean; data?: unknown; error?: string };
    try {
      const outcome = await this.executeToolWithTimeout(
        step.action,
        step.params,
        rollbackRequired ? rollbackTimeoutMs : undefined,
      );

      if (outcome.timed_out) {
        const result = this.buildFailedResult(
          startTime,
          `Tool execution timed out after ${rollbackTimeoutMs}ms`,
          stateBefore,
        );
        this.governance.circuitBreaker.track(false);
        this.emitStepFailed(step, result, planId, runId);
        this.logAudit(step, mode, "failed", result, planId);
        this.emitRollbackTrigger(
          step,
          result.error || "Tool execution timed out",
          "timeout",
          rollbackRequired,
          rollbackTimeoutMs,
          planId,
          runId,
        );
        return result;
      }

      toolResult = outcome.tool_result;
    } catch (err) {
      const result = this.buildFailedResult(
        startTime,
        `Tool execution threw: ${err instanceof Error ? err.message : String(err)}`,
        stateBefore,
      );
      this.governance.circuitBreaker.track(false);
      this.emitStepFailed(step, result, planId, runId);
      this.logAudit(step, mode, "failed", result, planId);
      this.emitRollbackTrigger(
        step,
        result.error || "Tool execution threw",
        "failure",
        rollbackRequired,
        rollbackTimeoutMs,
        planId,
        runId,
      );
      return result;
    }

    // Capture state after execution
    let stateAfter: Record<string, unknown> | undefined;
    try {
      const clusterState = await this.toolRegistry.getClusterState();
      if (clusterState) {
        stateAfter = clusterState as unknown as Record<string, unknown>;
      }
    } catch {
      // State capture is best-effort
    }

    const durationMs = Date.now() - startTime;

    if (toolResult.success) {
      const result: StepResult = {
        success: true,
        data: toolResult.data,
        duration_ms: durationMs,
        state_before: stateBefore,
        state_after: stateAfter,
        timestamp: new Date().toISOString(),
      };

      this.governance.circuitBreaker.track(true);
      this.emitStepCompleted(step, result, planId, runId);
      this.logAudit(step, mode, "success", result, planId);
      return result;
    } else {
      const result: StepResult = {
        success: false,
        error: toolResult.error || "Tool returned failure with no error message",
        data: toolResult.data,
        duration_ms: durationMs,
        state_before: stateBefore,
        state_after: stateAfter,
        timestamp: new Date().toISOString(),
      };

      this.governance.circuitBreaker.track(false);
      this.emitStepFailed(step, result, planId, runId);
      this.logAudit(step, mode, "failed", result, planId);
      this.emitRollbackTrigger(
        step,
        result.error || "Tool returned failure",
        "failure",
        rollbackRequired,
        rollbackTimeoutMs,
        planId,
        runId,
      );
      return result;
    }
  }

  // ── Private Helpers ─────────────────────────────────────────

  private buildFailedResult(
    startTime: number,
    error: string,
    stateBefore?: Record<string, unknown>,
  ): StepResult {
    return {
      success: false,
      error,
      duration_ms: Date.now() - startTime,
      state_before: stateBefore,
      timestamp: new Date().toISOString(),
    };
  }

  private resolveRollbackTimeoutMs(timeoutMs?: number): number {
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      return Math.floor(timeoutMs);
    }
    return 60_000;
  }

  private async executeToolWithTimeout(
    action: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<
    | { timed_out: false; tool_result: { success: boolean; data?: unknown; error?: string } }
    | { timed_out: true; tool_result: { success: false; error: string } }
  > {
    const executePromise = this.sandbox
      ? this.sandbox.execute(action, params)
      : this.toolRegistry.execute(action, params);

    if (!timeoutMs) {
      return {
        timed_out: false,
        tool_result: await executePromise,
      };
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ timed_out: true; tool_result: { success: false; error: string } }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          timed_out: true,
          tool_result: {
            success: false,
            error: `Tool execution timed out after ${timeoutMs}ms`,
          },
        });
      }, timeoutMs);
    });

    const wrappedExecution = executePromise.then((toolResult) => ({
      timed_out: false as const,
      tool_result: toolResult,
    }));

    const winner = await Promise.race([wrappedExecution, timeoutPromise]);

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (winner.timed_out) {
      // The original execution may still resolve/reject later; prevent unhandled rejections.
      void executePromise.catch(() => undefined);
    }

    return winner;
  }

  private emitRollbackTrigger(
    step: PlanStep,
    error: string,
    trigger: "failure" | "timeout",
    rollbackRequired: boolean,
    timeoutMs: number,
    planId?: string,
    runId?: string,
  ): void {
    if (!rollbackRequired) return;

    this.eventBus.emit({
      type: AgentEventType.RunEscalated,
      timestamp: new Date().toISOString(),
      data: {
        run_id: runId,
        plan_id: planId,
        step_id: step.id,
        action: step.action,
        tier: step.tier,
        reason: "rollback_triggered",
        trigger,
        timeout_ms: timeoutMs,
        error,
      },
    });
  }

  private emitStepCompleted(
    step: PlanStep,
    result: StepResult,
    planId?: string,
    runId?: string,
  ): void {
    this.eventBus.emit({
      type: AgentEventType.StepCompleted,
      timestamp: new Date().toISOString(),
      data: {
        step_id: step.id,
        action: step.action,
        duration_ms: result.duration_ms,
        output: result.data,
        plan_id: planId,
        run_id: runId,
      },
    });
  }

  private emitStepFailed(
    step: PlanStep,
    result: StepResult,
    planId?: string,
    runId?: string,
  ): void {
    this.eventBus.emit({
      type: AgentEventType.StepFailed,
      timestamp: new Date().toISOString(),
      data: {
        step_id: step.id,
        action: step.action,
        error: result.error,
        duration_ms: result.duration_ms,
        plan_id: planId,
        run_id: runId,
      },
    });
  }

  private logAudit(
    step: PlanStep,
    mode: AgentMode,
    resultStatus: AuditEntry["result"],
    result: StepResult,
    planId?: string,
    reason?: string,
  ): void {
    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      action: step.action,
      tier: step.tier,
      reasoning: reason || step.description,
      params: step.params,
      result: resultStatus,
      error: result.error,
      state_before: result.state_before,
      state_after: result.state_after,
      step_id: step.id,
      plan_id: planId,
      duration_ms: result.duration_ms,
    };

    this.governance.logAction(entry);
  }
}
