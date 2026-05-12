// ============================================================
// RHODES — Executor
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

export type ExecutorTerminalErrorType =
  | "tool_failure"
  | "timeout"
  | "exception"
  | "limit_violation";

export interface ExecutorRetryContext {
  action: string;
  attempt: number;
  maxAttempts: number;
  terminalErrorType: ExecutorTerminalErrorType;
}

export interface ExecutorRetryPolicy {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  retryOnTimeout: boolean;
  retryableErrorPatterns: RegExp[];
  retryableErrorFilter?: (error: string, context: ExecutorRetryContext) => boolean;
}

export interface ExecutorCallLimitPolicy {
  maxToolCallsPerRun: number;
  maxToolCallsPerPlan: number;
}

export interface ExecutorOptions {
  reliability?: {
    retry?: Partial<ExecutorRetryPolicy>;
    limits?: Partial<ExecutorCallLimitPolicy>;
  };
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * Shadow / dry-run mode. When true, tier-2+ actions (safe_write,
   * risky_write, destructive) are short-circuited after governance
   * evaluates them — the executor logs a clear `[DRY_RUN] would-execute`
   * line and returns a synthetic success result containing `dryRun: true`.
   * Tier-1 (read) actions still run normally so the autopilot can keep
   * polling and classifying events.
   */
  dryRun?: boolean;
}

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

const DEFAULT_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /temporar/i,
  /rate.?limit/i,
  /\b429\b/,
  /\b503\b/,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enetunreach/i,
  /ehostunreach/i,
];

const DEFAULT_RETRY_POLICY: ExecutorRetryPolicy = {
  maxRetries: 2,
  baseBackoffMs: 250,
  maxBackoffMs: 4_000,
  jitterRatio: 0.2,
  retryOnTimeout: true,
  retryableErrorPatterns: DEFAULT_RETRYABLE_ERROR_PATTERNS,
};

const DEFAULT_CALL_LIMIT_POLICY: ExecutorCallLimitPolicy = {
  maxToolCallsPerRun: 200,
  maxToolCallsPerPlan: 100,
};

type ToolResult = { success: boolean; data?: unknown; error?: string };

type ToolExecutionOutcome =
  | {
      kind: "result";
      toolResult: ToolResult;
      attempts: number;
      terminalErrorType?: ExecutorTerminalErrorType;
    }
  | {
      kind: "timeout";
      error: string;
      attempts: number;
      terminalErrorType: "timeout";
    }
  | {
      kind: "exception";
      error: string;
      attempts: number;
      terminalErrorType: "exception";
    }
  | {
      kind: "limit_violation";
      error: string;
      attempts: number;
      terminalErrorType: "limit_violation";
    };

export class Executor {
  private toolRegistry: ToolRegistry;
  private governance: GovernanceEngineRef;
  private eventBus: EventBus;
  private sandbox?: SandboxManager;
  private readonly retryPolicy: ExecutorRetryPolicy;
  private readonly callLimits: ExecutorCallLimitPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly dryRun: boolean;
  private readonly runCallCounts = new Map<string, number>();
  private readonly planCallCounts = new Map<string, number>();

  constructor(
    toolRegistry: ToolRegistry,
    governance: GovernanceEngineRef,
    eventBus: EventBus,
    sandbox?: SandboxManager,
    options?: ExecutorOptions,
  ) {
    this.toolRegistry = toolRegistry;
    this.governance = governance;
    this.eventBus = eventBus;
    if (sandbox) {
      this.sandbox = sandbox;
      this.sandbox.setExecutor((tool, params) => this.toolRegistry.execute(tool, params));
    }

    const retryPolicy = options?.reliability?.retry;
    const limitPolicy = options?.reliability?.limits;

    this.retryPolicy = {
      maxRetries: this.normalizeInteger(retryPolicy?.maxRetries, DEFAULT_RETRY_POLICY.maxRetries, 0),
      baseBackoffMs: this.normalizeInteger(
        retryPolicy?.baseBackoffMs,
        DEFAULT_RETRY_POLICY.baseBackoffMs,
        0,
      ),
      maxBackoffMs: this.normalizeInteger(
        retryPolicy?.maxBackoffMs,
        DEFAULT_RETRY_POLICY.maxBackoffMs,
        0,
      ),
      jitterRatio: this.normalizeFloat(retryPolicy?.jitterRatio, DEFAULT_RETRY_POLICY.jitterRatio, 0, 1),
      retryOnTimeout: retryPolicy?.retryOnTimeout ?? DEFAULT_RETRY_POLICY.retryOnTimeout,
      retryableErrorPatterns: retryPolicy?.retryableErrorPatterns ?? DEFAULT_RETRY_POLICY.retryableErrorPatterns,
      retryableErrorFilter: retryPolicy?.retryableErrorFilter,
    };

    this.callLimits = {
      maxToolCallsPerRun: this.normalizeInteger(
        limitPolicy?.maxToolCallsPerRun,
        DEFAULT_CALL_LIMIT_POLICY.maxToolCallsPerRun,
        1,
      ),
      maxToolCallsPerPlan: this.normalizeInteger(
        limitPolicy?.maxToolCallsPerPlan,
        DEFAULT_CALL_LIMIT_POLICY.maxToolCallsPerPlan,
        1,
      ),
    };

    this.sleep = options?.sleep ?? this.defaultSleep;
    this.random = options?.random ?? Math.random;
    this.dryRun = options?.dryRun === true;
  }

  /**
   * Returns true if a tier represents a mutating action that must be
   * blocked in dry-run / shadow mode. Tier-1 ("read") still executes
   * so the autopilot can poll and classify events; everything that
   * would touch the world is held back.
   */
  private isMutatingTier(tier: ActionTier): boolean {
    return tier === "safe_write" || tier === "risky_write" || tier === "destructive";
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

    // ── Shadow / dry-run gate ─────────────────────────────────
    // Tier-1 (read) actions still run normally so the autopilot can keep
    // observing the cluster. Tier-2+ actions get short-circuited: we log
    // a clear "would-execute" line, emit step_completed with a synthetic
    // success payload (dryRun: true), and skip the real tool call.
    if (this.dryRun && this.isMutatingTier(evaluation.tier)) {
      const paramSummary = this.summarizeParams(step.params);
      console.log(
        `[DRY_RUN] would-execute tier=${evaluation.tier} action=${step.action} ${paramSummary} blocked by RHODES_DRY_RUN`,
      );
      const dryResult: StepResult = {
        success: true,
        data: { dryRun: true, action: step.action, tier: evaluation.tier, params: step.params },
        duration_ms: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      this.governance.circuitBreaker.track(true);
      this.emitStepCompleted(step, dryResult, planId, runId);
      this.logAudit(step, mode, "success", dryResult, planId, "dry-run (shadow mode)");
      return dryResult;
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

    // Execute the tool with retry/limit policies.
    const execution = await this.executeToolWithPolicies(
      step,
      planId,
      runId,
      rollbackRequired ? rollbackTimeoutMs : undefined,
    );

    if (execution.kind === "limit_violation") {
      const result = this.buildFailedResult(startTime, execution.error, stateBefore);
      this.emitStepFailed(step, result, planId, runId);
      this.logAudit(step, mode, "blocked", result, planId, execution.error);
      return result;
    }

    if (execution.kind === "timeout") {
      const result = this.buildFailedResult(startTime, execution.error, stateBefore);
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

    if (execution.kind === "exception") {
      const result = this.buildFailedResult(startTime, execution.error, stateBefore);
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

    const toolResult = execution.toolResult;
    const terminalErrorType = execution.terminalErrorType ?? "tool_failure";
    const attemptCount = execution.attempts;

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
        error: this.formatTerminalFailure(
          toolResult.error || "Tool returned failure with no error message",
          attemptCount,
          terminalErrorType,
        ),
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

  private async executeToolWithPolicies(
    step: PlanStep,
    planId?: string,
    runId?: string,
    timeoutMs?: number,
  ): Promise<ToolExecutionOutcome> {
    const maxAttempts = this.retryPolicy.maxRetries + 1;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reservation = this.reserveToolCall(planId, runId);
      if (!reservation.allowed) {
        const scope = reservation.scope === "run" ? "run" : "plan/thread";
        const error = `Tool-call limit exceeded for ${scope} scope (limit=${reservation.limit}, attempted_call=${reservation.attemptedCall}).`;
        this.emitToolLimitViolation(step, reservation, planId, runId);
        return {
          kind: "limit_violation",
          error,
          attempts,
          terminalErrorType: "limit_violation",
        };
      }

      attempts++;
      const outcome = await this.executeAttempt(step, timeoutMs);
      if (outcome.kind === "result" && outcome.toolResult.success) {
        return { kind: "result", toolResult: outcome.toolResult, attempts };
      }

      const shouldRetry = this.shouldRetryFailure(outcome, step.action, attempt, maxAttempts);
      if (!shouldRetry || attempt >= maxAttempts) {
        if (outcome.kind === "result") {
          return {
            kind: "result",
            toolResult: outcome.toolResult,
            attempts,
            terminalErrorType: "tool_failure",
          };
        }
        if (outcome.kind === "timeout") {
          return {
            kind: "timeout",
            error: this.formatTerminalFailure(outcome.error, attempts, "timeout"),
            attempts,
            terminalErrorType: "timeout",
          };
        }
        return {
          kind: "exception",
          error: this.formatTerminalFailure(outcome.error, attempts, "exception"),
          attempts,
          terminalErrorType: "exception",
        };
      }

      const backoffMs = this.computeBackoffMs(attempt);
      this.emitRetryAttempt(step, outcome, attempt, maxAttempts, backoffMs, planId, runId);
      if (backoffMs > 0) {
        await this.sleep(backoffMs);
      }
    }

    return {
      kind: "exception",
      error: this.formatTerminalFailure(
        "Retry loop exited unexpectedly",
        attempts,
        "exception",
      ),
      attempts,
      terminalErrorType: "exception",
    };
  }

  private async executeAttempt(
    step: PlanStep,
    timeoutMs?: number,
  ): Promise<
    | { kind: "result"; toolResult: ToolResult }
    | { kind: "timeout"; error: string; terminalErrorType: "timeout" }
    | { kind: "exception"; error: string; terminalErrorType: "exception" }
  > {
    try {
      const outcome = await this.executeToolWithTimeout(
        step.action,
        step.params,
        timeoutMs,
      );

      if (outcome.timed_out) {
        return {
          kind: "timeout",
          error: outcome.tool_result.error,
          terminalErrorType: "timeout",
        };
      }

      return {
        kind: "result",
        toolResult: outcome.tool_result,
      };
    } catch (err) {
      return {
        kind: "exception",
        error: `Tool execution threw: ${err instanceof Error ? err.message : String(err)}`,
        terminalErrorType: "exception",
      };
    }
  }

  private shouldRetryFailure(
    outcome:
      | { kind: "result"; toolResult: ToolResult }
      | { kind: "timeout"; error: string; terminalErrorType: "timeout" }
      | { kind: "exception"; error: string; terminalErrorType: "exception" },
    action: string,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (outcome.kind === "timeout" && !this.retryPolicy.retryOnTimeout) {
      return false;
    }

    const error = outcome.kind === "result"
      ? outcome.toolResult.error || "Tool returned failure with no error message"
      : outcome.error;

    const terminalErrorType: ExecutorTerminalErrorType = outcome.kind === "result"
      ? "tool_failure"
      : outcome.terminalErrorType;

    const context: ExecutorRetryContext = {
      action,
      attempt,
      maxAttempts,
      terminalErrorType,
    };

    if (this.retryPolicy.retryableErrorFilter) {
      return this.retryPolicy.retryableErrorFilter(error, context);
    }

    return this.retryPolicy.retryableErrorPatterns.some((pattern) => pattern.test(error));
  }

  private formatTerminalFailure(
    error: string,
    attempts: number,
    terminalErrorType: ExecutorTerminalErrorType,
  ): string {
    return `Tool execution failed after ${attempts} attempt(s) (terminal_error_type=${terminalErrorType}): ${error}`;
  }

  private computeBackoffMs(attempt: number): number {
    const exponential = this.retryPolicy.baseBackoffMs * (2 ** Math.max(0, attempt - 1));
    const capped = Math.min(exponential, this.retryPolicy.maxBackoffMs);
    const jitterWindow = capped * this.retryPolicy.jitterRatio;
    const jitter = jitterWindow > 0
      ? ((this.random() * 2) - 1) * jitterWindow
      : 0;
    return Math.max(0, Math.round(capped + jitter));
  }

  private reserveToolCall(
    planId?: string,
    runId?: string,
  ):
    | { allowed: true }
    | {
      allowed: false;
      scope: "run" | "plan";
      limit: number;
      attemptedCall: number;
    } {
    const runKey = runId || null;
    let previousRunCount = 0;
    if (runKey) {
      previousRunCount = this.runCallCounts.get(runKey) ?? 0;
      if (previousRunCount >= this.callLimits.maxToolCallsPerRun) {
        return {
          allowed: false,
          scope: "run",
          limit: this.callLimits.maxToolCallsPerRun,
          attemptedCall: previousRunCount + 1,
        };
      }
      this.runCallCounts.set(runKey, previousRunCount + 1);
    }

    const planKey = planId ?? `thread:${runId ?? "default"}`;
    const previousPlanCount = this.planCallCounts.get(planKey) ?? 0;
    if (previousPlanCount >= this.callLimits.maxToolCallsPerPlan) {
      if (runKey) {
        if (previousRunCount === 0) {
          this.runCallCounts.delete(runKey);
        } else {
          this.runCallCounts.set(runKey, previousRunCount);
        }
      }
      return {
        allowed: false,
        scope: "plan",
        limit: this.callLimits.maxToolCallsPerPlan,
        attemptedCall: previousPlanCount + 1,
      };
    }

    this.planCallCounts.set(planKey, previousPlanCount + 1);
    return { allowed: true };
  }

  private emitRetryAttempt(
    step: PlanStep,
    outcome:
      | { kind: "result"; toolResult: ToolResult }
      | { kind: "timeout"; error: string; terminalErrorType: "timeout" }
      | { kind: "exception"; error: string; terminalErrorType: "exception" },
    attempt: number,
    maxAttempts: number,
    backoffMs: number,
    planId?: string,
    runId?: string,
  ): void {
    const error = outcome.kind === "result"
      ? outcome.toolResult.error || "Tool returned failure with no error message"
      : outcome.error;
    const terminalErrorType = outcome.kind === "result"
      ? "tool_failure"
      : outcome.terminalErrorType;

    this.eventBus.emit({
      type: AgentEventType.MetricRecorded,
      timestamp: new Date().toISOString(),
      data: {
        metric: "executor_tool_retry_attempt",
        step_id: step.id,
        action: step.action,
        attempt,
        max_attempts: maxAttempts,
        backoff_ms: backoffMs,
        terminal_error_type: terminalErrorType,
        error,
        plan_id: planId,
        run_id: runId,
      },
    });
  }

  private emitToolLimitViolation(
    step: PlanStep,
    reservation: {
      allowed: false;
      scope: "run" | "plan";
      limit: number;
      attemptedCall: number;
    },
    planId?: string,
    runId?: string,
  ): void {
    this.eventBus.emit({
      type: AgentEventType.MetricRecorded,
      timestamp: new Date().toISOString(),
      data: {
        metric: "executor_tool_call_limit_violation",
        step_id: step.id,
        action: step.action,
        scope: reservation.scope,
        limit: reservation.limit,
        attempted_call: reservation.attemptedCall,
        plan_id: planId,
        run_id: runId,
      },
    });
  }

  private normalizeInteger(value: number | undefined, fallback: number, min: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.floor(value));
  }

  private normalizeFloat(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Format a small subset of params into a one-line log fragment for the
   * dry-run audit. Truncates long values so the log line stays grep-friendly.
   */
  private summarizeParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params).slice(0, 4);
    if (entries.length === 0) return "";
    return entries
      .map(([k, v]) => {
        let str: string;
        try {
          str = typeof v === "string" ? v : JSON.stringify(v);
        } catch {
          str = String(v);
        }
        if (str.length > 64) str = str.slice(0, 61) + "...";
        return `${k}=${str}`;
      })
      .join(" ");
  }

  private readonly defaultSleep = async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  };

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
