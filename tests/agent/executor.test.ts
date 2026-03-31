import { describe, it, expect, vi, beforeEach } from "vitest";
import { Executor, type GovernanceEngineRef } from "../../src/agent/executor.js";
import { EventBus } from "../../src/agent/events.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { PlanStep } from "../../src/types.js";

// ── Helpers ─────────────────────────────────────────────────

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    id: "step_1",
    action: "create_vm",
    params: { name: "test-vm" },
    description: "Create a test VM",
    depends_on: [],
    status: "pending",
    tier: "safe_write",
    ...overrides,
  };
}

function makeMockToolRegistry(): ToolRegistry {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, data: { vmid: 100 } }),
    getAllTools: vi.fn().mockReturnValue([]),
    getClusterState: vi.fn().mockResolvedValue({
      adapter: "test",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    }),
  } as unknown as ToolRegistry;
}

function makeMockGovernance(
  overrides?: {
    allowed?: boolean;
    tripped?: boolean;
    needsApproval?: boolean;
    approved?: boolean;
    approvalWaitMs?: number;
  },
): GovernanceEngineRef {
  const {
    allowed = true,
    tripped = false,
    needsApproval = false,
    approved = true,
    approvalWaitMs = 0,
  } = overrides ?? {};
  return {
    evaluate: vi.fn().mockResolvedValue({
      allowed,
      tier: "safe_write",
      needs_approval: needsApproval,
      reason: allowed ? "Auto-approved" : "Blocked by policy",
      approval: needsApproval
        ? { request_id: "req-1", approved }
        : undefined,
      approval_wait_ms: needsApproval ? approvalWaitMs : undefined,
    }),
    logAction: vi.fn(),
    circuitBreaker: {
      track: vi.fn(),
      isTripped: vi.fn().mockReturnValue(tripped),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("Executor", () => {
  let toolRegistry: ToolRegistry;
  let governance: GovernanceEngineRef;
  let eventBus: EventBus;
  let executor: Executor;

  beforeEach(() => {
    toolRegistry = makeMockToolRegistry();
    governance = makeMockGovernance();
    eventBus = new EventBus();
    vi.spyOn(eventBus, "emit");
    executor = new Executor(toolRegistry, governance, eventBus);
  });

  // ── Success path ────────────────────────────────────────

  it("executes tool and returns success on the happy path", async () => {
    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ vmid: 100 });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.state_before).toBeDefined();
    expect(result.state_after).toBeDefined();
    expect(result.timestamp).toBeDefined();
  });

  it("emits step_started and step_completed on success", async () => {
    const step = makeStep();
    await executor.executeStep(step, "build");

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const types = emitCalls.map((c) => c[0].type);

    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).not.toContain("step_failed");
  });

  it("logs audit with 'success' and tracks true in circuit breaker", async () => {
    const step = makeStep();
    await executor.executeStep(step, "build");

    expect(governance.circuitBreaker.track).toHaveBeenCalledWith(true);
    expect(governance.logAction).toHaveBeenCalledTimes(1);

    const auditEntry = (governance.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry.result).toBe("success");
    expect(auditEntry.action).toBe("create_vm");
  });

  // ── Circuit breaker tripped ─────────────────────────────

  it("returns failed result when circuit breaker is tripped", async () => {
    governance = makeMockGovernance({ tripped: true });
    executor = new Executor(toolRegistry, governance, new EventBus());

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Circuit breaker");
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it("logs audit as 'blocked' when circuit breaker is tripped", async () => {
    governance = makeMockGovernance({ tripped: true });
    executor = new Executor(toolRegistry, governance, new EventBus());

    const step = makeStep();
    await executor.executeStep(step, "build");

    expect(governance.logAction).toHaveBeenCalledTimes(1);
    const auditEntry = (governance.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry.result).toBe("blocked");
  });

  // ── Governance blocks ───────────────────────────────────

  it("returns failed result when governance blocks the action", async () => {
    governance = makeMockGovernance({ allowed: false });
    eventBus = new EventBus();
    vi.spyOn(eventBus, "emit");
    executor = new Executor(toolRegistry, governance, eventBus);

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Blocked by governance");
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it("emits step_failed when governance blocks", async () => {
    governance = makeMockGovernance({ allowed: false });
    eventBus = new EventBus();
    vi.spyOn(eventBus, "emit");
    executor = new Executor(toolRegistry, governance, eventBus);

    const step = makeStep();
    await executor.executeStep(step, "build");

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const types = emitCalls.map((c) => c[0].type);
    expect(types).toContain("step_failed");
  });

  it("logs audit as 'blocked' when governance blocks", async () => {
    governance = makeMockGovernance({ allowed: false });
    executor = new Executor(toolRegistry, governance, new EventBus());

    const step = makeStep();
    await executor.executeStep(step, "build");

    const auditEntry = (governance.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry.result).toBe("blocked");
  });

  // ── Needs approval but not granted ──────────────────────

  it("returns failed result when approval is needed but not granted", async () => {
    governance = makeMockGovernance({ needsApproval: true, approved: false });
    eventBus = new EventBus();
    vi.spyOn(eventBus, "emit");
    executor = new Executor(toolRegistry, governance, eventBus);

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Approval required but not granted");
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it("emits approval_requested and step_failed when approval not granted", async () => {
    governance = makeMockGovernance({ needsApproval: true, approved: false, approvalWaitMs: 2300 });
    eventBus = new EventBus();
    vi.spyOn(eventBus, "emit");
    executor = new Executor(toolRegistry, governance, eventBus);

    const step = makeStep();
    await executor.executeStep(step, "build");

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const types = emitCalls.map((c) => c[0].type);
    expect(types).toContain("approval_requested");
    expect(types).toContain("approval_received");
    expect(types).toContain("step_failed");

    const approvalReceived = emitCalls
      .map((c) => c[0])
      .find((e) => e.type === "approval_received");
    expect(approvalReceived?.data.wait_ms).toBe(2300);
  });

  // ── Tool returns failure ────────────────────────────────

  it("returns failed result when tool returns { success: false }", async () => {
    (toolRegistry.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "VM limit reached",
    });

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(false);
    expect(result.error).toBe("VM limit reached");
    expect(result.state_before).toBeDefined();
    expect(result.state_after).toBeDefined();
  });

  it("tracks false in circuit breaker on tool failure", async () => {
    (toolRegistry.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "VM limit reached",
    });

    const step = makeStep();
    await executor.executeStep(step, "build");

    expect(governance.circuitBreaker.track).toHaveBeenCalledWith(false);
  });

  it("logs audit as 'failed' on tool failure", async () => {
    (toolRegistry.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "VM limit reached",
    });

    const step = makeStep();
    await executor.executeStep(step, "build");

    const auditEntry = (governance.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry.result).toBe("failed");
  });

  // ── Tool throws exception ──────────────────────────────

  it("returns failed result when tool throws an exception", async () => {
    (toolRegistry.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection timeout"),
    );

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Tool execution threw");
    expect(result.error).toContain("connection timeout");
  });

  it("tracks false in circuit breaker when tool throws", async () => {
    (toolRegistry.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection timeout"),
    );

    const step = makeStep();
    await executor.executeStep(step, "build");

    expect(governance.circuitBreaker.track).toHaveBeenCalledWith(false);
  });

  // ── Governance evaluate throws ─────────────────────────

  it("returns failed result when governance.evaluate throws", async () => {
    (governance.evaluate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("policy engine down"),
    );

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Governance evaluation failed");
    expect(result.error).toContain("policy engine down");
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  // ── State capture failure is non-fatal ─────────────────

  it("still executes when getClusterState throws", async () => {
    (toolRegistry.getClusterState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("state unavailable"),
    );

    const step = makeStep();
    const result = await executor.executeStep(step, "build");

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ vmid: 100 });
    expect(result.state_before).toBeUndefined();
    expect(result.state_after).toBeUndefined();
  });

  // ── planId passed through ──────────────────────────────

  it("passes planId through to logAction audit entry", async () => {
    const step = makeStep();
    await executor.executeStep(step, "build", "plan_42");

    const auditEntry = (governance.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry.plan_id).toBe("plan_42");
  });

  it("sets plan_id to undefined when planId is not provided", async () => {
    const step = makeStep();
    await executor.executeStep(step, "build");

    const auditEntry = (governance.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry.plan_id).toBeUndefined();
  });

  it("propagates run_id to emitted step events when provided", async () => {
    const step = makeStep();
    await executor.executeStep(step, "build", "plan_42", "run_abc");

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const started = emitCalls.map((c) => c[0]).find((e) => e.type === "step_started");
    const completed = emitCalls.map((c) => c[0]).find((e) => e.type === "step_completed");

    expect(started?.data.run_id).toBe("run_abc");
    expect(started?.data.plan_id).toBe("plan_42");
    expect(completed?.data.run_id).toBe("run_abc");
    expect(completed?.data.plan_id).toBe("plan_42");
  });
});
