import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { EventBus } from "../../src/agent/events.js";
import { HealingOrchestrator } from "../../src/healing/orchestrator.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { GovernanceEngine } from "../../src/governance/index.js";
import type { AgentCore, AgentRunResult } from "../../src/agent/core.js";
import type { Anomaly } from "../../src/monitoring/anomaly.js";
import type { Playbook } from "../../src/healing/playbooks.js";

vi.mock("../../src/agent/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent/llm.js")>(
    "../../src/agent/llm.js",
  );
  return {
    ...actual,
    callLLM: vi.fn(),
  };
});

import { callLLM } from "../../src/agent/llm.js";

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "anomaly-1",
    type: "threshold",
    severity: "critical",
    metric: "vm_status",
    labels: { vmid: "101", node: "pve1", name: "web-01" },
    current_value: 0,
    message: "VM crashed",
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunResult(success = true): AgentRunResult {
  return {
    success,
    plan: {
      id: "plan-1",
      goal_id: "goal-1",
      steps: [],
      created_at: new Date().toISOString(),
      status: success ? "completed" : "failed",
      resource_estimate: {
        ram_mb: 0,
        disk_gb: 0,
        cpu_cores: 0,
        vms_created: 0,
        containers_created: 0,
      },
      reasoning: "test",
      revision: 1,
    },
    steps_completed: success ? 1 : 0,
    steps_failed: success ? 0 : 1,
    replans: 0,
    duration_ms: 25,
    errors: success ? [] : ["failed"],
    outputs: [],
  };
}

function makeSummary() {
  return {
    timestamp: new Date().toISOString(),
    anomaliesDetected: 0,
    healingsStarted: 0,
    healingsCompleted: 0,
    healingsFailed: 0,
    openIncidents: 0,
    activeHeals: 0,
    circuitBreakerPaused: false,
  };
}

describe("HealingOrchestrator", () => {
  let dataDir: string;
  let eventBus: EventBus;
  let runMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataDir = `/tmp/rhodes-healing-orchestrator-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    eventBus = new EventBus();
    runMock = vi.fn().mockResolvedValue(makeRunResult(true));
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify({
        root_cause: "CPU steal caused VM watchdog reset",
        confidence: "high",
        contributing_factors: ["host saturation"],
        recommended_action: "rebalance workloads",
      }),
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeOrchestrator(configOverrides?: Partial<{ healingEnabled: boolean; maxConcurrentHeals: number; bootEvalEnabled: boolean }>) {
    const toolRegistry = {
      execute: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getClusterState: vi.fn().mockResolvedValue(null),
      getAllTools: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    const governance = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true, reason: "ok" }),
      circuitBreaker: { isTripped: vi.fn().mockReturnValue(false) },
    } as unknown as GovernanceEngine;

    const agentCore = {
      run: runMock,
      aiConfig: { provider: "openai", apiKey: "test", model: "gpt-test" },
    } as unknown as AgentCore;

    return new HealingOrchestrator({
      agentCore,
      toolRegistry,
      eventBus,
      governance,
      dataDir,
      config: {
        pollIntervalMs: 1000,
        healingEnabled: configOverrides?.healingEnabled ?? true,
        maxConcurrentHeals: configOverrides?.maxConcurrentHeals ?? 2,
        bootEvalEnabled: configOverrides?.bootEvalEnabled,
      },
    });
  }

  it("does not create duplicate incidents when tick() runs concurrently", async () => {
    const orchestrator = makeOrchestrator({ healingEnabled: false });
    const anomaly = makeAnomaly();
    (orchestrator as any).anomalyDetector.detect = vi.fn().mockReturnValue([anomaly]);

    await Promise.all([
      (orchestrator as any).tick(),
      (orchestrator as any).tick(),
    ]);

    const open = orchestrator.incidentManager.getOpen();
    expect(open).toHaveLength(1);
    expect(open[0].metric).toBe("vm_status");
  });

  it("deduplicates concurrent handleAnomaly calls for the same anomaly key", async () => {
    const orchestrator = makeOrchestrator();
    const anomaly = makeAnomaly();
    const openSpy = vi.spyOn((orchestrator as any).incidentManager, "open");
    const summary = makeSummary();
    let resolveRun: ((value: AgentRunResult) => void) | null = null;
    runMock.mockImplementation(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );

    const first = (orchestrator as any).handleAnomaly(anomaly, summary);
    await Promise.resolve();
    const second = (orchestrator as any).handleAnomaly(anomaly, summary);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
    resolveRun?.(makeRunResult(true));
    await Promise.all([first, second]);
  });

  it("does not block healing when RCA hangs", async () => {
    const orchestrator = makeOrchestrator();
    const anomaly = makeAnomaly();
    (orchestrator as any).anomalyDetector.detect = vi.fn().mockReturnValue([anomaly]);
    vi.mocked(callLLM).mockImplementation(
      () => new Promise<string>(() => undefined),
    );

    await Promise.race([
      (orchestrator as any).tick(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("tick timed out")), 250),
      ),
    ]);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(orchestrator.incidentManager.getOpen()).toHaveLength(0);
    const recent = orchestrator.incidentManager.getRecent(1);
    expect(recent[0]?.status).toBe("resolved");
  });

  it("fires every matching playbook (v0.4.6 trigger-collision fix) and runs full incident lifecycle", async () => {
    // Before v0.4.6 the engine took `match(anomaly)[0]` and dropped the
    // rest, so two playbooks with the same trigger only fired one. After
    // the fix both fire concurrently, each respecting its own approval /
    // cooldown / max_retries. With maxConcurrentHeals=2 (test default)
    // both pb-a and pb-b reach executeHealing.
    const orchestrator = makeOrchestrator();
    const anomaly = makeAnomaly({
      id: "anomaly-custom",
      metric: "custom_metric",
      labels: { node: "pve1" },
      message: "Custom anomaly",
    });

    const playbookA: Playbook = {
      id: "pb-a",
      name: "Playbook A",
      description: "first",
      trigger: { metric: "custom_metric", type: "threshold", severity: "critical" },
      actions: [{ type: "custom_goal", params: {}, description: "a" }],
      cooldown_minutes: 1,
      requires_approval: false,
      max_retries: 1,
    };

    const playbookB: Playbook = {
      ...playbookA,
      id: "pb-b",
      name: "Playbook B",
      description: "second",
    };

    (orchestrator as any).incidentManager.suggestPlaybook = vi.fn().mockReturnValue(undefined);
    (orchestrator as any).playbookEngine.match = vi.fn().mockReturnValue([playbookA, playbookB]);

    const summary = makeSummary();
    await (orchestrator as any).handleAnomaly(anomaly, summary);

    // Both playbooks fired against the same anomaly.
    expect(runMock).toHaveBeenCalledTimes(2);
    const playbookIds = runMock.mock.calls.map((call) => {
      const goal = call[0] as { raw_input: string };
      return JSON.parse(goal.raw_input).playbook_id;
    });
    expect(playbookIds.sort()).toEqual(["pb-a", "pb-b"]);

    expect(summary.healingsStarted).toBe(2);
    expect(summary.healingsCompleted).toBe(2);
    expect(summary.healingsFailed).toBe(0);

    const recent = orchestrator.incidentManager.getRecent(1)[0];
    expect(recent.status).toBe("resolved");
    expect(recent.actions_taken.length).toBeGreaterThanOrEqual(2);

    const eventTypes = eventBus.getHistory().map((e) => e.type);
    expect(eventTypes).toContain("incident_opened");
    expect(eventTypes).toContain("healing_started");
    expect(eventTypes).toContain("incident_resolved");
    expect(eventTypes).toContain("healing_completed");
  });

  describe("boot-time state evaluation", () => {
    it("fires storage-pause playbook for a VM already in paused_io_error at boot", async () => {
      const orchestrator = makeOrchestrator();
      const store = (orchestrator as any).healthMonitor.store;

      // Seed the metric store with a VM that's already paused (io-error).
      // The boot-eval pass walks store.getAllLatest("vm_status") and
      // synthesizes a discovered_state_change anomaly when it sees a
      // bad runtime_status.
      store.record("vm_status", 1, {
        vmid: "101",
        node: "pve1",
        name: "jellyfin",
        runtime_status: "paused_io_error",
        reason: "paused_io_error",
      });

      const matchSpy = vi.spyOn(
        (orchestrator as any).playbookEngine,
        "match",
      );

      await (orchestrator as any).tick();

      // The playbook engine should have been asked about the synthetic
      // state_change anomaly, and the storage-pause playbook should
      // match on `metric=vm_status, type=state_change, reason=paused_io_error`.
      const matchedTypes = matchSpy.mock.calls.map(
        (call) => (call[0] as any).type,
      );
      expect(matchedTypes).toContain("state_change");
      const storageCall = matchSpy.mock.calls.find(
        (call) =>
          (call[0] as any).type === "state_change" &&
          (call[0] as any).labels?.reason === "paused_io_error",
      );
      expect(storageCall).toBeDefined();
    });

    it("triggers no playbooks when all observed VMs are healthy at boot", async () => {
      const orchestrator = makeOrchestrator();
      const store = (orchestrator as any).healthMonitor.store;
      store.record("vm_status", 1, {
        vmid: "100",
        node: "pve1",
        name: "web-01",
        runtime_status: "running",
      });
      store.record("vm_status", 1, {
        vmid: "101",
        node: "pve1",
        name: "web-02",
        runtime_status: "running",
      });

      // Stub anomaly detector so it doesn't fire its own anomalies.
      (orchestrator as any).anomalyDetector.detect = vi.fn().mockReturnValue([]);

      const matchSpy = vi.spyOn((orchestrator as any).playbookEngine, "match");

      await (orchestrator as any).tick();

      // No state_change anomalies were synthesized for healthy VMs.
      const stateChangeCalls = matchSpy.mock.calls.filter(
        (call) => (call[0] as any).type === "state_change",
      );
      expect(stateChangeCalls).toHaveLength(0);
    });

    it("skips boot-eval entirely when bootEvalEnabled=false", async () => {
      const orchestrator = makeOrchestrator({ bootEvalEnabled: false });
      const store = (orchestrator as any).healthMonitor.store;

      store.record("vm_status", 1, {
        vmid: "101",
        node: "pve1",
        name: "jellyfin",
        runtime_status: "paused_io_error",
        reason: "paused_io_error",
      });

      (orchestrator as any).anomalyDetector.detect = vi.fn().mockReturnValue([]);
      const matchSpy = vi.spyOn((orchestrator as any).playbookEngine, "match");

      await (orchestrator as any).tick();

      const stateChangeCalls = matchSpy.mock.calls.filter(
        (call) => (call[0] as any).type === "state_change",
      );
      expect(stateChangeCalls).toHaveLength(0);
    });

    it("only runs boot-eval on the first tick — subsequent ticks skip it", async () => {
      const orchestrator = makeOrchestrator();
      const store = (orchestrator as any).healthMonitor.store;
      store.record("vm_status", 1, {
        vmid: "101",
        node: "pve1",
        name: "jellyfin",
        runtime_status: "paused_io_error",
        reason: "paused_io_error",
      });

      (orchestrator as any).anomalyDetector.detect = vi.fn().mockReturnValue([]);
      const matchSpy = vi.spyOn((orchestrator as any).playbookEngine, "match");

      await (orchestrator as any).tick();
      const firstTickStateChanges = matchSpy.mock.calls.filter(
        (call) => (call[0] as any).type === "state_change",
      ).length;
      expect(firstTickStateChanges).toBeGreaterThanOrEqual(1);

      matchSpy.mockClear();
      await (orchestrator as any).tick();
      const secondTickStateChanges = matchSpy.mock.calls.filter(
        (call) => (call[0] as any).type === "state_change",
      ).length;
      expect(secondTickStateChanges).toBe(0);
    });
  });

  it("proxies lifecycle and status accessors to the healing engine", () => {
    const orchestrator = makeOrchestrator();
    const engine = (orchestrator as any).engine;
    const startSpy = vi.spyOn(engine, "start").mockImplementation(() => undefined);
    const stopSpy = vi.spyOn(engine, "stop").mockImplementation(() => undefined);
    const expectedStatus = {
      running: true,
      healingEnabled: true,
      activeHeals: [],
      openIncidents: [],
      circuitBreaker: {
        consecutiveFailures: 0,
        paused: false,
      },
    };
    const statusSpy = vi.spyOn(engine, "getStatus").mockReturnValue(expectedStatus);

    orchestrator.start();
    orchestrator.stop();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(orchestrator.getStatus()).toBe(expectedStatus);
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(orchestrator.getHealthMonitor()).toBe((orchestrator as any).healthMonitor);
    expect((orchestrator as any).openIncidents).toEqual([]);
  });
});
