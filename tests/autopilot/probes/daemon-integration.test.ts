// ============================================================
// Boot the autopilot daemon end-to-end with a probe targeting
// 127.0.0.1:1 (a port no service ever binds — always fails),
// and confirm that:
//   - the daemon starts the probe scheduler
//   - the probe accumulates failures
//   - once failures_to_alert is reached, the
//     `service_unreachable_restart` rule fires
//   - governance is consulted with tier=risky_write
//   - cooldown prevents an immediate second fire
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutopilotDaemon } from "../../../src/autopilot/daemon.js";
import { EventBus } from "../../../src/agent/events.js";
import {
  AgentEventType,
  type AgentEvent,
  type ClusterState,
  type VMInfo,
} from "../../../src/types.js";
import type { ToolRegistry } from "../../../src/tools/registry.js";
import type { GovernanceEngine } from "../../../src/governance/index.js";
import type { ProbeRunner } from "../../../src/autopilot/probes/probers.js";

function makeVm(overrides?: Partial<VMInfo>): VMInfo {
  return {
    id: 201,
    name: "esxi-nested",
    node: "pve1",
    status: "running",
    cpu_cores: 4,
    ram_mb: 8192,
    disk_gb: 64,
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

function createMockToolRegistry(state: ClusterState): ToolRegistry {
  return {
    getClusterState: vi.fn().mockResolvedValue(state),
    execute: vi.fn().mockResolvedValue({ success: true }),
    getAllTools: vi.fn().mockReturnValue([]),
    // Used by the scheduler — empty list keeps provider polling a no-op
    getHypervisorAdapters: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
}

function createMockGovernance(): GovernanceEngine {
  return {
    evaluate: vi.fn().mockResolvedValue({
      allowed: true,
      tier: "risky_write",
      reason: "auto",
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

describe("AutopilotDaemon end-to-end with probes", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires service_unreachable rule after threshold against 127.0.0.1:1", async () => {
    const fired = collect(eventBus, AgentEventType.AutopilotRuleFired);
    const probeFailed = collect(eventBus, AgentEventType.ProbeFailed);

    // Simulate the always-fails port using a mock runner — the brief
    // calls out 127.0.0.1:1 specifically as "always fails"; we encode
    // that semantic with a runner that always reports ok=false.
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "tcp 127.0.0.1:1 connect ECONNREFUSED",
      error_code: "ECONNREFUSED",
    });

    const registry = createMockToolRegistry(
      makeClusterState({ vms: [makeVm()] }),
    );
    const governance = createMockGovernance();

    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1_000,
      probesEnabled: true,
      probes: [
        {
          id: "always_fails",
          target_vm_id: 201,
          target_node: "pve1",
          target_host: "loopback-port-1",
          kind: "tcp",
          host: "127.0.0.1",
          port: 1,
          interval_s: 5,
          timeout_ms: 1_000,
          failures_to_alert: 3,
          cooldown_s: 600,
          insecure: true,
          enabled: true,
        },
      ],
      probeRunnerOverrides: { tcp },
    });

    daemon.start();

    // Drain the immediate first probe + first daemon poll.
    await vi.advanceTimersByTimeAsync(0);
    expect(probeFailed.length).toBeGreaterThanOrEqual(1);

    // Tick forward — additional probes at 5s intervals.
    await vi.advanceTimersByTimeAsync(5_000); // probe #2
    await vi.advanceTimersByTimeAsync(5_000); // probe #3 — alerting

    // Daemon poll happens at 1s intervals. The next poll after probe
    // #3 should evaluate rules, see the alerting probe, and fire.
    await vi.advanceTimersByTimeAsync(1_000);

    daemon.stop();

    expect(probeFailed.length).toBeGreaterThanOrEqual(3);
    const serviceFires = fired.filter(
      (e) => e.data.rule_id === "service_unreachable_restart",
    );
    expect(serviceFires.length).toBeGreaterThanOrEqual(1);
    expect(serviceFires[0].data.tier).toBe("risky_write");
    expect(serviceFires[0].data.action).toBe("restart_vm");

    // Governance should have been consulted at least once for the
    // risky_write restart_vm action.
    expect(
      (governance.evaluate as unknown as { mock: { calls: unknown[][] } }).mock
        .calls.length,
    ).toBeGreaterThanOrEqual(1);

    // ToolRegistry execute should have been called with stop_vm and
    // start_vm in some order (the daemon power-cycles).
    const executed = (
      registry.execute as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => c[0]);
    expect(executed).toContain("stop_vm");
    expect(executed).toContain("start_vm");
  });

  it("emits ProbeFailed events to the event bus so the dashboard can render them", async () => {
    const probeFailed = collect(eventBus, AgentEventType.ProbeFailed);
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });

    const registry = createMockToolRegistry(makeClusterState());
    const governance = createMockGovernance();
    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 30_000,
      probesEnabled: true,
      probes: [
        {
          id: "p1",
          target_host: "host",
          kind: "tcp",
          host: "127.0.0.1",
          port: 1,
          interval_s: 60,
          timeout_ms: 1_000,
          failures_to_alert: 3,
          cooldown_s: 60,
          insecure: true,
          enabled: true,
        },
      ],
      probeRunnerOverrides: { tcp },
    });

    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    daemon.stop();

    expect(probeFailed.length).toBeGreaterThanOrEqual(1);
    expect(probeFailed[0].data.probe_id).toBe("p1");
    expect(probeFailed[0].data.error_code).toBe("ECONNREFUSED");
  });

  it("respects probe cooldown: fires once, suppresses subsequent fires", async () => {
    const fired = collect(eventBus, AgentEventType.AutopilotRuleFired);
    const suppressed = collect(
      eventBus,
      AgentEventType.AutopilotRuleSuppressed,
    );

    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });

    const registry = createMockToolRegistry(
      makeClusterState({ vms: [makeVm()] }),
    );
    const governance = createMockGovernance();
    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1_000,
      probesEnabled: true,
      probes: [
        {
          id: "always_fails",
          target_vm_id: 201,
          target_node: "pve1",
          kind: "tcp",
          host: "127.0.0.1",
          port: 1,
          interval_s: 5,
          timeout_ms: 1_000,
          failures_to_alert: 1,
          cooldown_s: 600,
          insecure: true,
          enabled: true,
        },
      ],
      probeRunnerOverrides: { tcp },
    });

    daemon.start();
    await vi.advanceTimersByTimeAsync(0); // probe + poll
    await vi.advanceTimersByTimeAsync(1_000); // poll #2 — should suppress
    await vi.advanceTimersByTimeAsync(1_000); // poll #3 — still suppressed
    daemon.stop();

    const serviceFires = fired.filter(
      (e) => e.data.rule_id === "service_unreachable_restart",
    );
    const serviceSuppressed = suppressed.filter(
      (e) => e.data.rule_id === "service_unreachable_restart",
    );

    expect(serviceFires.length).toBe(1);
    // After the first fire, subsequent matches must be suppressed by
    // the rule-state per-entity cooldown.
    expect(serviceSuppressed.length).toBeGreaterThanOrEqual(1);
  });

  it("getProbeStateSnapshot/getProviderHealthSnapshot expose state for the dashboard", async () => {
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });
    const registry = createMockToolRegistry(makeClusterState());
    const governance = createMockGovernance();
    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 30_000,
      probesEnabled: true,
      probes: [
        {
          id: "p1",
          target_host: "h",
          kind: "tcp",
          host: "127.0.0.1",
          port: 1,
          interval_s: 60,
          timeout_ms: 1_000,
          failures_to_alert: 3,
          cooldown_s: 60,
          insecure: true,
          enabled: true,
        },
      ],
      probeRunnerOverrides: { tcp },
    });

    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    daemon.stop();

    const snap = daemon.getProbeStateSnapshot();
    expect(snap.length).toBeGreaterThan(0);
    expect(snap[0].consecutiveFailures).toBeGreaterThanOrEqual(1);

    // Provider snapshot is empty because the mock registry has no
    // hypervisor adapters — just verify the call shape works.
    expect(daemon.getProviderHealthSnapshot()).toEqual([]);
  });

  it("does not start the scheduler when probesEnabled=false", async () => {
    const tcp: ProbeRunner = vi.fn();
    const registry = createMockToolRegistry(makeClusterState());
    const governance = createMockGovernance();
    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 30_000,
      probesEnabled: false,
      probes: [
        {
          id: "p",
          kind: "tcp",
          host: "127.0.0.1",
          port: 1,
          interval_s: 60,
          timeout_ms: 1_000,
          failures_to_alert: 3,
          cooldown_s: 60,
          insecure: true,
          enabled: true,
        },
      ],
      probeRunnerOverrides: { tcp },
    });

    expect(daemon.getProbeScheduler()).toBeNull();
    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    daemon.stop();
    expect(tcp).not.toHaveBeenCalled();
  });
});
