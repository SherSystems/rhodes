import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutopilotDaemon } from "../../src/autopilot/daemon.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { GovernanceEngine } from "../../src/governance/index.js";
import type {
  ClusterState,
  NodeInfo,
  VMInfo,
  AgentEvent,
} from "../../src/types.js";

// ── Helpers ──────────────────────────────────────────────────

function makeNode(overrides?: Partial<NodeInfo>): NodeInfo {
  return {
    id: "node1",
    name: "pve1",
    status: "online",
    cpu_cores: 8,
    cpu_usage_pct: 20,
    ram_total_mb: 32768,
    ram_used_mb: 8000,
    disk_total_gb: 500,
    disk_used_gb: 100,
    disk_usage_pct: 20,
    uptime_s: 86400,
    ...overrides,
  };
}

function makeVm(overrides?: Partial<VMInfo>): VMInfo {
  return {
    id: 100,
    name: "test-vm",
    node: "pve1",
    status: "running",
    cpu_cores: 2,
    ram_mb: 2048,
    disk_gb: 32,
    ...overrides,
  };
}

function makeClusterState(overrides?: Partial<ClusterState>): ClusterState {
  return {
    adapter: "test",
    nodes: [],
    vms: [],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createMockToolRegistry(
  states: ClusterState[],
): ToolRegistry {
  let i = 0;
  return {
    getClusterState: vi.fn().mockImplementation(async () => {
      const s = states[Math.min(i, states.length - 1)];
      i++;
      return s;
    }),
    execute: vi.fn().mockResolvedValue({ success: true }),
    getAllTools: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
}

function createMockGovernance(allowed = true): GovernanceEngine {
  return {
    evaluate: vi
      .fn()
      .mockResolvedValue({
        allowed,
        tier: "safe_write",
        reason: allowed ? "auto" : "blocked",
        needs_approval: false,
      }),
    circuitBreaker: { isTripped: vi.fn().mockReturnValue(false) },
  } as unknown as GovernanceEngine;
}

function collect(eventBus: EventBus, type: AgentEventType): AgentEvent[] {
  const out: AgentEvent[] = [];
  eventBus.on(type, (e) => out.push(e));
  return out;
}

// ── Tests ────────────────────────────────────────────────────

describe("AutopilotDaemon event emission", () => {
  let eventBus: EventBus;
  let governance: GovernanceEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    governance = createMockGovernance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits AutopilotRuleEvaluated each poll with rule counts", async () => {
    const evaluated = collect(eventBus, AgentEventType.AutopilotRuleEvaluated);
    const registry = createMockToolRegistry([makeClusterState()]);

    const daemon = new AutopilotDaemon(registry, governance, eventBus);
    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    daemon.stop();

    expect(evaluated.length).toBeGreaterThanOrEqual(1);
    const data = evaluated[0].data;
    expect(typeof data.rules).toBe("number");
    expect(typeof data.enabled).toBe("number");
    expect(typeof data.matches).toBe("number");
    // 6 default rules ship now (4 cluster + 2 probe-driven); all enabled.
    expect(data.rules).toBe(6);
    expect(data.enabled).toBe(6);
    expect(data.matches).toBe(0);
  });

  it("emits AutopilotRuleFired when a rule matches and is admitted", async () => {
    const fired = collect(eventBus, AgentEventType.AutopilotRuleFired);
    const prev = makeClusterState({ vms: [makeVm({ status: "running" })] });
    const curr = makeClusterState({ vms: [makeVm({ status: "stopped" })] });
    const registry = createMockToolRegistry([prev, curr]);

    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1000,
    });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0); // first poll, no prev state -> no fire
    await vi.advanceTimersByTimeAsync(1000); // second poll, vm went stopped
    daemon.stop();

    expect(fired.length).toBeGreaterThanOrEqual(1);
    const data = fired[0].data;
    expect(data.rule_id).toBe("vm_auto_restart");
    expect(data.action).toBe("start_vm");
    expect(data.entity_key).toBe("vm_auto_restart:100");
    expect(data.tier).toBe("safe_write");
  });

  it("emits AutopilotActionGoverned with the governance decision", async () => {
    const governed = collect(eventBus, AgentEventType.AutopilotActionGoverned);
    const prev = makeClusterState({ vms: [makeVm({ status: "running" })] });
    const curr = makeClusterState({ vms: [makeVm({ status: "stopped" })] });
    const registry = createMockToolRegistry([prev, curr]);

    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1000,
    });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    daemon.stop();

    expect(governed.length).toBe(1);
    expect(governed[0].data.allowed).toBe(true);
    expect(governed[0].data.action).toBe("start_vm");
    expect(governed[0].data.vmid).toBe(100);
  });

  it("emits AutopilotRuleSuppressed instead of firing when entity is in cooldown", async () => {
    const fired = collect(eventBus, AgentEventType.AutopilotRuleFired);
    const suppressed = collect(
      eventBus,
      AgentEventType.AutopilotRuleSuppressed,
    );

    // Set up: VM goes stopped twice within cooldown.
    const running = makeClusterState({ vms: [makeVm({ status: "running" })] });
    const stopped = makeClusterState({ vms: [makeVm({ status: "stopped" })] });
    // Sequence: running -> stopped (fires) -> running -> stopped (suppressed by cooldown)
    const registry = createMockToolRegistry([
      running,
      stopped,
      running,
      stopped,
    ]);

    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1000,
    });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0); // running
    await vi.advanceTimersByTimeAsync(1000); // stopped: fires
    await vi.advanceTimersByTimeAsync(1000); // running
    await vi.advanceTimersByTimeAsync(1000); // stopped: should suppress (within 120s cooldown)
    daemon.stop();

    expect(fired.length).toBe(1);
    expect(suppressed.length).toBeGreaterThanOrEqual(1);
    expect(suppressed[0].data.rule_id).toBe("vm_auto_restart");
    expect(suppressed[0].data.entity_key).toBe("vm_auto_restart:100");
    expect(typeof suppressed[0].data.retry_after_ms).toBe("number");
  });

  it("does NOT block other entities when one entity is in cooldown", async () => {
    const fired = collect(eventBus, AgentEventType.AutopilotRuleFired);

    const running = makeClusterState({
      vms: [
        makeVm({ id: 100, status: "running" }),
        makeVm({ id: 200, name: "other", status: "running" }),
      ],
    });
    const oneStopped = makeClusterState({
      vms: [
        makeVm({ id: 100, status: "stopped" }),
        makeVm({ id: 200, name: "other", status: "running" }),
      ],
    });
    const bothStopped = makeClusterState({
      vms: [
        makeVm({ id: 100, status: "stopped" }),
        makeVm({ id: 200, name: "other", status: "stopped" }),
      ],
    });
    const registry = createMockToolRegistry([
      running,
      oneStopped,
      bothStopped,
    ]);

    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1000,
    });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0); // running (no fire)
    await vi.advanceTimersByTimeAsync(1000); // vm 100 goes stopped: fires for 100
    await vi.advanceTimersByTimeAsync(1000); // vm 200 also goes stopped: should fire for 200 even while 100 in cooldown
    daemon.stop();

    const entities = fired.map((e) => e.data.entity_key);
    expect(entities).toContain("vm_auto_restart:100");
    expect(entities).toContain("vm_auto_restart:200");
  });

  it("exposes rule-state snapshot for observability", async () => {
    const prev = makeClusterState({ vms: [makeVm({ status: "running" })] });
    const curr = makeClusterState({ vms: [makeVm({ status: "stopped" })] });
    const registry = createMockToolRegistry([prev, curr]);

    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1000,
    });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    daemon.stop();

    const snap = daemon.getRuleStateSnapshot();
    expect(snap.length).toBeGreaterThan(0);
    const entry = snap.find((s) => s.key === "vm_auto_restart:100");
    expect(entry).toBeDefined();
    expect(entry!.recentFireCount).toBeGreaterThanOrEqual(1);
  });
});
