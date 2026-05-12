// ============================================================
// RHODES — Executor dry-run / shadow mode tests
// Verifies that RHODES_DRY_RUN gates tier-2+ tool calls while
// letting tier-1 reads through.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Executor, type GovernanceEngineRef } from "../../src/agent/executor.js";
import { EventBus } from "../../src/agent/events.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { ActionTier, PlanStep } from "../../src/types.js";

function makeStep(tier: ActionTier = "safe_write", overrides?: Partial<PlanStep>): PlanStep {
  return {
    id: "step_1",
    action: tier === "destructive" ? "qm_destroy_vm" : "create_vm",
    params: { name: "test-vm", vmid: 100 },
    description: "test step",
    depends_on: [],
    status: "pending",
    tier,
    ...overrides,
  };
}

function makeRegistry() {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
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

function makeGovernance(tier: ActionTier): GovernanceEngineRef {
  return {
    evaluate: vi.fn().mockResolvedValue({
      allowed: true,
      tier,
      needs_approval: false,
      reason: "auto",
      explicit_approval_required: false,
      rollback_required: false,
    }),
    logAction: vi.fn(),
    circuitBreaker: { track: vi.fn(), isTripped: vi.fn().mockReturnValue(false) },
  };
}

describe("Executor (dry-run / shadow mode)", () => {
  let registry: ToolRegistry;
  let eventBus: EventBus;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registry = makeRegistry();
    eventBus = new EventBus();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still executes tier-1 (read) actions in dry-run mode", async () => {
    const governance = makeGovernance("read");
    const executor = new Executor(registry, governance, eventBus, undefined, { dryRun: true });

    const result = await executor.executeStep(makeStep("read"), "watch");

    expect(result.success).toBe(true);
    expect(registry.execute).toHaveBeenCalledOnce();
    // No DRY_RUN log line for reads — they ran for real.
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("[DRY_RUN]"))).toBe(false);
  });

  it("blocks tier-2 (safe_write) and returns a synthetic dry-run success", async () => {
    const governance = makeGovernance("safe_write");
    const executor = new Executor(registry, governance, eventBus, undefined, { dryRun: true });

    const result = await executor.executeStep(makeStep("safe_write"), "build");

    expect(result.success).toBe(true);
    expect(registry.execute).not.toHaveBeenCalled();
    expect((result.data as { dryRun?: boolean })?.dryRun).toBe(true);
    expect((result.data as { tier?: string })?.tier).toBe("safe_write");
  });

  it("blocks tier-3 (risky_write) and emits the [DRY_RUN] would-execute log", async () => {
    const governance = makeGovernance("risky_write");
    const executor = new Executor(registry, governance, eventBus, undefined, { dryRun: true });

    await executor.executeStep(
      makeStep("risky_write", { action: "qm_delsnapshot", params: { vmid: 100, name: "snap-1" } }),
      "build",
    );

    expect(registry.execute).not.toHaveBeenCalled();
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const dryLine = lines.find((l) => l.includes("[DRY_RUN]"));
    expect(dryLine).toBeDefined();
    expect(dryLine).toContain("would-execute");
    expect(dryLine).toContain("tier=risky_write");
    expect(dryLine).toContain("action=qm_delsnapshot");
    expect(dryLine).toContain("blocked by RHODES_DRY_RUN");
  });

  it("blocks tier-4 (destructive) writes in dry-run", async () => {
    const governance = makeGovernance("destructive");
    const executor = new Executor(registry, governance, eventBus, undefined, { dryRun: true });

    const result = await executor.executeStep(makeStep("destructive"), "build");

    expect(result.success).toBe(true);
    expect(registry.execute).not.toHaveBeenCalled();
    expect((result.data as { dryRun?: boolean })?.dryRun).toBe(true);
  });

  it("emits step_completed (autopilot plan flow still completes) when blocked", async () => {
    const governance = makeGovernance("safe_write");
    const executor = new Executor(registry, governance, eventBus, undefined, { dryRun: true });
    const emitted: string[] = [];
    eventBus.on("*", (ev) => emitted.push(ev.type));

    await executor.executeStep(makeStep("safe_write"), "build");

    expect(emitted).toContain("step_started");
    expect(emitted).toContain("step_completed");
    expect(emitted).not.toContain("step_failed");
  });

  it("does not gate when dryRun=false (default)", async () => {
    const governance = makeGovernance("destructive");
    const executor = new Executor(registry, governance, eventBus); // no dryRun option

    await executor.executeStep(makeStep("destructive"), "build");
    expect(registry.execute).toHaveBeenCalledOnce();
  });
});
