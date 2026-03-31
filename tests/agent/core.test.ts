// ============================================================
// Tests for AgentCore — the plan/execute/observe/replan loop
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";

// ── Module mocks (must be before imports that use them) ─────

vi.mock("../../src/agent/llm.js", () => ({
  callLLM: vi.fn().mockResolvedValue("{}"),
}));

vi.mock("../../src/agent/planner.js", () => {
  return {
    Planner: class MockPlanner {
      plan = vi.fn().mockResolvedValue({
        id: "plan-1",
        goal_id: "goal-1",
        steps: [
          {
            id: "s1",
            action: "list_vms",
            params: {},
            description: "List VMs",
            depends_on: [],
            status: "pending",
            tier: "read",
          },
        ],
        created_at: new Date().toISOString(),
        status: "pending",
        resource_estimate: {
          ram_mb: 0,
          disk_gb: 0,
          cpu_cores: 0,
          vms_created: 0,
          containers_created: 0,
        },
        reasoning: "Test plan",
        revision: 1,
      });
      replan = vi.fn().mockResolvedValue({
        id: "plan-2",
        goal_id: "goal-1",
        steps: [],
        created_at: new Date().toISOString(),
        status: "pending",
        resource_estimate: {
          ram_mb: 0,
          disk_gb: 0,
          cpu_cores: 0,
          vms_created: 0,
          containers_created: 0,
        },
        reasoning: "Cannot recover",
        revision: 2,
        previous_plan_id: "plan-1",
      });
    },
  };
});

vi.mock("../../src/agent/observer.js", () => {
  return {
    Observer: class MockObserver {
      observe = vi
        .fn()
        .mockResolvedValue({ matches: true, discrepancies: [], severity: "none" });
    },
  };
});

vi.mock("../../src/agent/investigator.js", () => {
  return {
    Investigator: class MockInvestigator {
      investigate = vi.fn().mockResolvedValue({
        id: "inv-1",
        trigger: "test trigger",
        findings: [{ source: "test", detail: "found it", severity: "info" }],
        root_cause: "misconfigured NIC",
        proposed_fix: null,
        timestamp: new Date().toISOString(),
      });
    },
  };
});

// ── Imports (after mocks) ───────────────────────────────────

import { AgentCore } from "../../src/agent/core.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import type { Goal } from "../../src/types.js";

// ── Helpers ─────────────────────────────────────────────────

function makeMockToolRegistry() {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getAllTools: vi.fn().mockReturnValue([
      {
        name: "list_vms",
        tier: "read",
        adapter: "test",
        description: "",
        params: [],
        returns: "",
      },
    ]),
    getClusterState: vi.fn().mockResolvedValue({
      adapter: "test",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    }),
    getMultiClusterState: vi.fn().mockResolvedValue({
      providers: [],
      timestamp: new Date().toISOString(),
    }),
    getTool: vi.fn().mockReturnValue(undefined),
  } as any;
}

function makeMockGovernance() {
  return {
    evaluate: vi.fn().mockResolvedValue({
      allowed: true,
      tier: "read",
      needs_approval: false,
      reason: "auto",
    }),
    logAction: vi.fn(),
    circuitBreaker: {
      track: vi.fn(),
      isTripped: vi.fn().mockReturnValue(false),
    },
    approvalGate: {
      requestPlanApproval: vi.fn().mockResolvedValue(true),
    },
  } as any;
}

const mockGoal: Goal = {
  id: "goal-1",
  mode: "watch",
  description: "List VMs",
  raw_input: "list vms",
  created_at: new Date().toISOString(),
};

const mockConfig = {
  provider: "anthropic" as const,
  apiKey: "test",
  model: "test",
};

// ── Test Suite ──────────────────────────────────────────────

describe("AgentCore", () => {
  let dbPath: string;
  let agent: AgentCore;
  let eventBus: EventBus;
  let toolRegistry: ReturnType<typeof makeMockToolRegistry>;
  let governance: ReturnType<typeof makeMockGovernance>;

  beforeEach(() => {
    dbPath = `/tmp/vclaw-test-core-${Date.now()}.db`;
    eventBus = new EventBus();
    toolRegistry = makeMockToolRegistry();
    governance = makeMockGovernance();

    agent = new AgentCore({
      toolRegistry,
      governance,
      eventBus,
      config: mockConfig,
      memoryDbPath: dbPath,
    });
  });

  afterEach(() => {
    try {
      agent.memory.close();
    } catch {
      // already closed or never opened
    }
    try {
      unlinkSync(dbPath);
    } catch {
      // file may not exist
    }
    try {
      unlinkSync(`${dbPath}-wal`);
    } catch {
      // WAL file may not exist
    }
    try {
      unlinkSync(`${dbPath}-shm`);
    } catch {
      // SHM file may not exist
    }
  });

  // ── run() ───────────────────────────────────────────────

  describe("run()", () => {
    it("success path: read-only plan completes all steps", async () => {
      const result = await agent.run(mockGoal);

      expect(result.success).toBe(true);
      expect(result.steps_completed).toBe(1);
      expect(result.steps_failed).toBe(0);
      expect(result.replans).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0].success).toBe(true);
      expect(result.plan.status).toBe("completed");
    });

    it("planning failure: returns success:false with 'Planning failed' error", async () => {
      agent.planner.plan = vi
        .fn()
        .mockRejectedValue(new Error("LLM unavailable"));

      const result = await agent.run(mockGoal);

      expect(result.success).toBe(false);
      expect(result.steps_completed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Planning failed");
      expect(result.errors[0]).toContain("LLM unavailable");
    });

    it("step execution failure + empty replan: returns success:false", async () => {
      // Make the tool execution fail
      toolRegistry.execute.mockResolvedValue({
        success: false,
        error: "VM not found",
      });

      const result = await agent.run(mockGoal);

      expect(result.success).toBe(false);
      expect(result.steps_failed).toBe(1);
      expect(result.replans).toBe(1);
      expect(result.errors.some((e) => e.includes("Replan produced no steps"))).toBe(
        true,
      );
    });

    it("circuit breaker tripped during execution: aborts with event", async () => {
      // Make the tool execution fail
      toolRegistry.execute.mockResolvedValue({
        success: false,
        error: "timeout",
      });

      // Trip the circuit breaker after the first failure
      let callCount = 0;
      governance.circuitBreaker.isTripped.mockImplementation(() => {
        callCount++;
        // First call is from executor.executeStep (before governance check) — returns false
        // Second call is from core.ts after failure — returns true
        return callCount >= 2;
      });

      const events: any[] = [];
      eventBus.on(AgentEventType.CircuitBreakerTripped, (e) => events.push(e));

      const result = await agent.run(mockGoal);

      expect(result.success).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0].data.plan_id).toBeDefined();
    });

    it("plan approval denied (build mode with write steps): returns success:false", async () => {
      // Plan with a write step
      agent.planner.plan = vi.fn().mockResolvedValue({
        id: "plan-w",
        goal_id: "goal-1",
        steps: [
          {
            id: "s1",
            action: "create_vm",
            params: {},
            description: "Create VM",
            depends_on: [],
            status: "pending",
            tier: "safe_write",
          },
        ],
        created_at: new Date().toISOString(),
        status: "pending",
        resource_estimate: {
          ram_mb: 1024,
          disk_gb: 10,
          cpu_cores: 2,
          vms_created: 1,
          containers_created: 0,
        },
        reasoning: "Create a VM",
        revision: 1,
      });

      // Deny the plan approval
      governance.approvalGate.requestPlanApproval.mockResolvedValue(false);

      const buildGoal: Goal = {
        ...mockGoal,
        mode: "build",
        description: "Create a VM",
      };

      const result = await agent.run(buildGoal);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Plan denied");
    });

    it("build mode read-only plan skips approval", async () => {
      // Default plan has only read-tier steps — approval should be skipped
      const buildGoal: Goal = {
        ...mockGoal,
        mode: "build",
        description: "List VMs in build mode",
      };

      const result = await agent.run(buildGoal);

      expect(result.success).toBe(true);
      // approvalGate.requestPlanApproval should NOT have been called
      expect(governance.approvalGate.requestPlanApproval).not.toHaveBeenCalled();
    });

    it("saves success memory with type 'pattern'", async () => {
      const saveSpy = vi.spyOn(agent.memory, "save");

      await agent.run(mockGoal);

      expect(saveSpy).toHaveBeenCalled();
      const call = saveSpy.mock.calls.find((c) => c[0].type === "pattern");
      expect(call).toBeDefined();
      expect(call![0].key).toContain("goal:");
    });

    it("saves failure memory with type 'failure'", async () => {
      // To reach saveRunMemories with a failure, the observer must report a
      // major discrepancy. The step execution succeeds, but the observer
      // downgrades it to "failed", so the finalize block is reached (no
      // early returns from replan/circuit-breaker paths).
      agent.observer.observe = vi.fn().mockResolvedValue({
        matches: false,
        discrepancies: ["Expected VM list but got empty"],
        severity: "major",
      });

      const saveSpy = vi.spyOn(agent.memory, "save");

      const result = await agent.run(mockGoal);

      expect(result.success).toBe(false);
      expect(saveSpy).toHaveBeenCalled();
      const failCall = saveSpy.mock.calls.find((c) => c[0].type === "failure");
      expect(failCall).toBeDefined();
      expect(failCall![0].key).toContain("fail:");
    });

    it("emits plan_created event", async () => {
      const events: any[] = [];
      eventBus.on(AgentEventType.PlanCreated, (e) => events.push(e));

      await agent.run(mockGoal);

      expect(events).toHaveLength(1);
      expect(events[0].data.plan_id).toBe("plan-1");
      expect(events[0].data.step_count).toBe(1);
      expect(events[0].data.goal).toBe("List VMs");
    });

    it("emits run_started and run_completed with the same run_id", async () => {
      const started: any[] = [];
      const completed: any[] = [];
      eventBus.on(AgentEventType.RunStarted, (e) => started.push(e));
      eventBus.on(AgentEventType.RunCompleted, (e) => completed.push(e));

      await agent.run(mockGoal);

      expect(started).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(started[0].data.run_id).toBeDefined();
      expect(completed[0].data.run_id).toBe(started[0].data.run_id);
      expect(completed[0].data.success).toBe(true);
    });
  });

  // ── investigate() ─────────────────────────────────────────

  describe("investigate()", () => {
    it("returns investigation result", async () => {
      const result = await agent.investigate("VM unreachable");

      expect(result.id).toBe("inv-1");
      expect(result.root_cause).toBe("misconfigured NIC");
      expect(result.findings).toHaveLength(1);
    });

    it("emits investigation_started and investigation_complete events", async () => {
      const started: any[] = [];
      const completed: any[] = [];
      eventBus.on(AgentEventType.InvestigationStarted, (e) => started.push(e));
      eventBus.on(AgentEventType.InvestigationComplete, (e) => completed.push(e));

      await agent.investigate("high CPU usage");

      expect(started).toHaveLength(1);
      expect(started[0].data.trigger).toBe("high CPU usage");

      expect(completed).toHaveLength(1);
      expect(completed[0].data.investigation_id).toBe("inv-1");
      expect(completed[0].data.root_cause).toBe("misconfigured NIC");
    });
  });

  // ── Properties ────────────────────────────────────────────

  describe("properties", () => {
    it("aiConfig getter returns the config", () => {
      expect(agent.aiConfig).toEqual(mockConfig);
      expect(agent.aiConfig.provider).toBe("anthropic");
      expect(agent.aiConfig.apiKey).toBe("test");
      expect(agent.aiConfig.model).toBe("test");
    });
  });
});
