import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProbeScheduler } from "../../../src/autopilot/probes/scheduler.js";
import type { ProbeDef } from "../../../src/autopilot/probes/schema.js";
import type { ProbeRunner } from "../../../src/autopilot/probes/probers.js";
import { EventBus } from "../../../src/agent/events.js";
import { AgentEventType, type AgentEvent } from "../../../src/types.js";
import type { ToolRegistry } from "../../../src/tools/registry.js";
import type { InfraAdapter } from "../../../src/providers/types.js";

function makeProbe(overrides?: Partial<ProbeDef>): ProbeDef {
  return {
    id: "probe1",
    target_vm_id: 201,
    target_node: "pve1",
    kind: "tcp",
    host: "127.0.0.1",
    port: 22,
    interval_s: 60,
    timeout_ms: 5_000,
    failures_to_alert: 3,
    cooldown_s: 60,
    insecure: true,
    enabled: true,
    ...overrides,
  };
}

function makeFakeAdapter(
  name: string,
  connected: boolean,
  isConnectedThrows = false,
): InfraAdapter {
  return {
    name,
    kind: "hypervisor",
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => {
      if (isConnectedThrows) throw new Error("isConnected boom");
      return connected;
    }),
    getTools: vi.fn(() => []),
    execute: vi.fn(),
    getClusterState: vi.fn(),
  } as unknown as InfraAdapter;
}

function makeFakeRegistry(adapters: InfraAdapter[]): ToolRegistry {
  return {
    getHypervisorAdapters: vi.fn(() => adapters),
  } as unknown as ToolRegistry;
}

function collect(eventBus: EventBus, type: AgentEventType): AgentEvent[] {
  const out: AgentEvent[] = [];
  eventBus.on(type, (e) => out.push(e));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Lifecycle ───────────────────────────────────────────────

describe("ProbeScheduler lifecycle", () => {
  it("start() schedules each enabled probe", () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = vi
      .fn()
      .mockResolvedValue({ ok: true, duration_ms: 1, detail: "ok" });

    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ id: "a" }), makeProbe({ id: "b" })],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    // Two immediate probes (one per probe) should have been triggered.
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("skips disabled probes", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = vi
      .fn()
      .mockResolvedValue({ ok: true, duration_ms: 1, detail: "ok" });

    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [
        makeProbe({ id: "off", enabled: false }),
        makeProbe({ id: "on" }),
      ],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    // Only one probe ran.
    expect(tcp).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent", () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: true,
      duration_ms: 1,
      detail: "ok",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe()],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
  });
});

// ── Event emission ──────────────────────────────────────────

describe("ProbeScheduler events", () => {
  it("emits ProbeSucceeded on success", async () => {
    const eventBus = new EventBus();
    const succeeded = collect(eventBus, AgentEventType.ProbeSucceeded);
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: true,
      duration_ms: 5,
      detail: "tcp ok",
    });

    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe()],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();

    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded[0].data.probe_id).toBe("probe1");
    expect(succeeded[0].data.kind).toBe("tcp");
  });

  it("emits ProbeFailed with consecutive_failures and crossed_threshold", async () => {
    const eventBus = new EventBus();
    const failed = collect(eventBus, AgentEventType.ProbeFailed);
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 5,
      detail: "boom",
      error_code: "ECONNREFUSED",
    });

    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ failures_to_alert: 3 })],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0); // immediate probe = fail #1
    await vi.advanceTimersByTimeAsync(60_000); // fail #2
    await vi.advanceTimersByTimeAsync(60_000); // fail #3 — crosses

    scheduler.stop();

    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed[0].data.consecutive_failures).toBe(1);
    expect(failed[0].data.crossed_threshold).toBe(false);
    expect(failed[2].data.consecutive_failures).toBe(3);
    expect(failed[2].data.crossed_threshold).toBe(true);
    expect(failed[2].data.error_code).toBe("ECONNREFUSED");
  });

  it("emits ProbeRecovered when transitioning from alerting back to healthy", async () => {
    const eventBus = new EventBus();
    const recovered = collect(eventBus, AgentEventType.ProbeRecovered);

    let calls = 0;
    const tcp: ProbeRunner = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) {
        return {
          ok: false,
          duration_ms: 5,
          detail: "down",
          error_code: "ECONNREFUSED",
        };
      }
      return { ok: true, duration_ms: 5, detail: "back up" };
    });

    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ failures_to_alert: 2 })],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0); // fail #1
    await vi.advanceTimersByTimeAsync(60_000); // fail #2 — alerting
    await vi.advanceTimersByTimeAsync(60_000); // success — recovery
    scheduler.stop();

    expect(recovered.length).toBe(1);
    expect(recovered[0].data.probe_id).toBe("probe1");
  });

  it("does NOT emit ProbeRecovered for routine successes", async () => {
    const eventBus = new EventBus();
    const recovered = collect(eventBus, AgentEventType.ProbeRecovered);
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: true,
      duration_ms: 5,
      detail: "ok",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe()],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.stop();
    expect(recovered.length).toBe(0);
  });
});

// ── Threshold detection (alerting flag) ─────────────────────

describe("ProbeScheduler isProbeAlerting", () => {
  it("flips to alerting after failures_to_alert is reached", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });

    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ failures_to_alert: 2 })],
      runnerOverrides: { tcp },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.isProbeAlerting("probe1")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.isProbeAlerting("probe1")).toBe(true);
    scheduler.stop();
  });
});

// ── Provider polling ────────────────────────────────────────

describe("ProbeScheduler provider polling", () => {
  it("emits ProviderUnreachable after threshold consecutive failures", () => {
    const eventBus = new EventBus();
    const unreachable = collect(eventBus, AgentEventType.ProviderUnreachable);
    const adapter = makeFakeAdapter("proxmox", false);
    const registry = makeFakeRegistry([adapter]);

    const scheduler = new ProbeScheduler(eventBus, registry, {
      probes: [],
      providerFailuresToAlert: 3,
    });

    scheduler.pollProviders();
    expect(unreachable.length).toBe(0);
    scheduler.pollProviders();
    expect(unreachable.length).toBe(0);
    scheduler.pollProviders();
    expect(unreachable.length).toBe(1);
    expect(unreachable[0].data.provider).toBe("proxmox");
    expect(unreachable[0].data.consecutive_failures).toBe(3);
  });

  it("emits ProviderRecovered when adapter starts reporting connected", () => {
    const eventBus = new EventBus();
    const recovered = collect(eventBus, AgentEventType.ProviderRecovered);

    let connected = false;
    const adapter = {
      name: "vmware",
      kind: "hypervisor" as const,
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => connected),
      getTools: vi.fn(() => []),
      execute: vi.fn(),
      getClusterState: vi.fn(),
    } as unknown as InfraAdapter;

    const registry = makeFakeRegistry([adapter]);
    const scheduler = new ProbeScheduler(eventBus, registry, {
      probes: [],
      providerFailuresToAlert: 2,
    });

    scheduler.pollProviders(); // fail
    scheduler.pollProviders(); // fail — alerting
    expect(scheduler.isProviderUnreachable("vmware")).toBe(true);

    connected = true;
    scheduler.pollProviders(); // success — recovery

    expect(recovered.length).toBe(1);
    expect(recovered[0].data.provider).toBe("vmware");
    expect(scheduler.isProviderUnreachable("vmware")).toBe(false);
  });

  it("treats isConnected throwing as a failure", () => {
    const eventBus = new EventBus();
    const adapter = makeFakeAdapter("flaky", false, true);
    const registry = makeFakeRegistry([adapter]);
    const scheduler = new ProbeScheduler(eventBus, registry, {
      probes: [],
      providerFailuresToAlert: 1,
    });
    scheduler.pollProviders();
    expect(scheduler.isProviderUnreachable("flaky")).toBe(true);
  });

  it("is a no-op when no registry is provided", () => {
    const eventBus = new EventBus();
    const scheduler = new ProbeScheduler(eventBus, null, { probes: [] });
    expect(() => scheduler.pollProviders()).not.toThrow();
  });
});

// ── Cooldown / remediation interactions ────────────────────

describe("ProbeScheduler remediation cooldown", () => {
  it("recordRemediation + canRemediate enforce cooldown_s", () => {
    const eventBus = new EventBus();
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ cooldown_s: 60 })],
    });
    const t0 = new Date(0);
    scheduler.recordRemediation("probe1", t0);
    const within = scheduler.canRemediate("probe1", new Date(30_000));
    expect(within.admitted).toBe(false);
    const after = scheduler.canRemediate("probe1", new Date(61_000));
    expect(after.admitted).toBe(true);
  });

  it("canRemediate returns admitted when probe id is unknown", () => {
    const eventBus = new EventBus();
    const scheduler = new ProbeScheduler(eventBus, null, { probes: [] });
    expect(scheduler.canRemediate("nope", new Date()).admitted).toBe(true);
  });
});

// ── runOnce hook ───────────────────────────────────────────

describe("ProbeScheduler.runOnce", () => {
  it("returns null for an unknown probe id", async () => {
    const eventBus = new EventBus();
    const scheduler = new ProbeScheduler(eventBus, null, { probes: [] });
    const result = await scheduler.runOnce("does-not-exist");
    expect(result).toBeNull();
  });

  it("runs the probe and records state without starting timers", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "fail",
      error_code: "ECONNREFUSED",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe()],
      runnerOverrides: { tcp },
    });
    await scheduler.runOnce("probe1");
    expect(scheduler.getProbeStateSnapshot()[0].consecutiveFailures).toBe(1);
  });
});
