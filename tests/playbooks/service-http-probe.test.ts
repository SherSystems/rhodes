import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runProbeIteration,
  diagnose,
  buildRemediationPlan,
  detectRestartLoop,
  verifyRecovery,
  runServiceProbePlaybook,
  isProbeHealthy,
  freshState,
  jellyfinConfigFromEnv,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RESTART_BACKOFF_WINDOW_MINS,
  type ServiceProbeConfig,
  type ServiceProbeExecutor,
  type ProbeResult,
  type RestartHistoryEntry,
} from "../../src/playbooks/service-http-probe.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";

// ── Fakes ───────────────────────────────────────────────────

interface FakeOptions {
  probeResults?: ProbeResult[];
  ping?: boolean | (() => boolean);
  systemctlActive?: string | (() => string);
  systemctlStatus?: string;
  restartOk?: boolean | (() => boolean);
  /** Frozen time for the restart-loop guard. */
  now?: Date;
}

function makeFakeExecutor(opts: FakeOptions = {}): ServiceProbeExecutor & {
  probeCalls: number;
  pingCalls: number;
  systemctlIsActiveCalls: number;
  systemctlStatusCalls: number;
  restartCalls: number;
  sleeps: number[];
} {
  const probes = opts.probeResults ?? [];
  let probeIdx = 0;
  const counters = {
    probeCalls: 0,
    pingCalls: 0,
    systemctlIsActiveCalls: 0,
    systemctlStatusCalls: 0,
    restartCalls: 0,
    sleeps: [] as number[],
  };
  const exec = {
    async httpProbe(_url: string, _t: number) {
      counters.probeCalls++;
      if (probeIdx < probes.length) {
        return probes[probeIdx++];
      }
      // Default: success after probes exhausted
      return {
        ok: true,
        status: 200,
        body: "Healthy",
        elapsed_ms: 5,
        timestamp: new Date().toISOString(),
      };
    },
    async ping() {
      counters.pingCalls++;
      if (typeof opts.ping === "function") return opts.ping();
      return opts.ping ?? true;
    },
    async systemctlIsActive() {
      counters.systemctlIsActiveCalls++;
      const v =
        typeof opts.systemctlActive === "function"
          ? opts.systemctlActive()
          : opts.systemctlActive ?? "active";
      return { state: v, ok: true };
    },
    async systemctlStatus() {
      counters.systemctlStatusCalls++;
      return {
        stdout: opts.systemctlStatus ?? "● jellyfin.service - Jellyfin\n   Active: active (running)\n",
        ok: true,
      };
    },
    async systemctlRestart() {
      counters.restartCalls++;
      const ok =
        typeof opts.restartOk === "function"
          ? opts.restartOk()
          : opts.restartOk ?? true;
      return { ok };
    },
    async sleep(ms: number) {
      counters.sleeps.push(ms);
    },
    now() {
      return opts.now ?? new Date("2026-05-12T12:00:00Z");
    },
  };
  // Live counter accessors so assertions see the up-to-date values.
  return new Proxy(exec, {
    get(target, prop, receiver) {
      if (prop in counters) {
        return (counters as Record<string | symbol, unknown>)[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ServiceProbeExecutor & typeof counters;
}

function makeConfig(overrides: Partial<ServiceProbeConfig> = {}): ServiceProbeConfig {
  return {
    name: "jellyfin-service-probe",
    service_name: "jellyfin",
    probe_url: "http://10.0.0.1:8096/health",
    ssh_target: "user@host",
    probe_timeout_ms: 1000,
    failure_threshold: 3,
    restart_backoff_window_mins: 30,
    max_restarts_in_window: 3,
    healthy_body_match: "Healthy",
    ...overrides,
  };
}

function ok(): ProbeResult {
  return {
    ok: true,
    status: 200,
    body: "Healthy",
    elapsed_ms: 5,
    timestamp: new Date().toISOString(),
  };
}

function fail(error = "ECONNREFUSED"): ProbeResult {
  return {
    ok: false,
    error,
    elapsed_ms: 1000,
    timestamp: new Date().toISOString(),
  };
}

// ── isProbeHealthy ──────────────────────────────────────────

describe("isProbeHealthy", () => {
  it("treats 200 + matching body as healthy", () => {
    expect(isProbeHealthy(ok(), "Healthy")).toBe(true);
  });

  it("treats 200 + missing body match as unhealthy", () => {
    expect(
      isProbeHealthy({ ...ok(), body: "different content" }, "Healthy"),
    ).toBe(false);
  });

  it("treats non-200 as unhealthy", () => {
    expect(
      isProbeHealthy({ ...ok(), status: 503, body: "Healthy" }, "Healthy"),
    ).toBe(false);
  });

  it("treats network errors as unhealthy", () => {
    expect(isProbeHealthy(fail(), "Healthy")).toBe(false);
  });
});

// ── runProbeIteration ───────────────────────────────────────

describe("runProbeIteration", () => {
  it("successful probe → no event, state cleared", async () => {
    const exec = makeFakeExecutor({ probeResults: [ok()] });
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on("*", (e) => events.push(e));

    const result = await runProbeIteration(
      exec,
      makeConfig(),
      freshState(),
      bus,
    );

    expect(result.state.consecutive_failures).toBe(0);
    expect(result.threshold_crossed).toBe(false);
    expect(events.filter((e: any) => e.type === AgentEventType.ServiceUnreachable)).toHaveLength(0);
  });

  it("1 probe failure → no event yet (under threshold)", async () => {
    const exec = makeFakeExecutor({ probeResults: [fail()] });
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on(AgentEventType.ServiceUnreachable, (e) => events.push(e));

    const result = await runProbeIteration(exec, makeConfig(), freshState(), bus);

    expect(result.state.consecutive_failures).toBe(1);
    expect(result.threshold_crossed).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("3 probe failures → ServiceUnreachable event fires", async () => {
    const exec = makeFakeExecutor();
    // Each iteration uses 1 probe so we route them per-iteration.
    let s = freshState();
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on(AgentEventType.ServiceUnreachable, (e) => events.push(e));

    // Inject 3 failing probes by replacing httpProbe.
    let count = 0;
    (exec as any).httpProbe = async () => {
      count++;
      return fail();
    };

    s = (await runProbeIteration(exec, makeConfig(), s, bus)).state;
    s = (await runProbeIteration(exec, makeConfig(), s, bus)).state;
    const last = await runProbeIteration(exec, makeConfig(), s, bus);
    s = last.state;

    expect(count).toBe(3);
    expect(s.consecutive_failures).toBe(3);
    expect(last.threshold_crossed).toBe(true);
    expect(events).toHaveLength(1);
    expect((events[0] as any).data.service_name).toBe("jellyfin");
  });

  it("does NOT re-fire ServiceUnreachable until probe recovers", async () => {
    const exec = makeFakeExecutor();
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on(AgentEventType.ServiceUnreachable, (e) => events.push(e));

    (exec as any).httpProbe = async () => fail();

    let s = freshState();
    for (let i = 0; i < 5; i++) {
      s = (await runProbeIteration(exec, makeConfig(), s, bus)).state;
    }

    expect(events).toHaveLength(1);
  });
});

// ── diagnose ────────────────────────────────────────────────

describe("diagnose", () => {
  it("ping fail → VM_UNREACHABLE", async () => {
    const exec = makeFakeExecutor({ ping: false });
    const d = await diagnose(exec, makeConfig());
    expect(d.classification).toBe("VM_UNREACHABLE");
    expect(d.ping_ok).toBe(false);
    expect(exec.systemctlIsActiveCalls).toBe(0); // didn't ssh
  });

  it("ping ok + inactive → SERVICE_DOWN", async () => {
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "inactive",
    });
    const d = await diagnose(exec, makeConfig());
    expect(d.classification).toBe("SERVICE_DOWN");
    expect(d.systemctl_state).toBe("inactive");
  });

  it("ping ok + failed → SERVICE_DOWN", async () => {
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "failed",
    });
    const d = await diagnose(exec, makeConfig());
    expect(d.classification).toBe("SERVICE_DOWN");
  });

  it("ping ok + active (but probe failing) → SERVICE_UNHEALTHY", async () => {
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "active",
    });
    const d = await diagnose(exec, makeConfig());
    expect(d.classification).toBe("SERVICE_UNHEALTHY");
    expect(d.notes.join(" ")).toMatch(/deadlock|hang|application/i);
  });
});

// ── buildRemediationPlan ────────────────────────────────────

describe("buildRemediationPlan", () => {
  it("SERVICE_DOWN → restart plan, Tier 2", () => {
    const plan = buildRemediationPlan(makeConfig(), {
      classification: "SERVICE_DOWN",
      ping_ok: true,
      notes: [],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].command).toBe("sudo systemctl restart jellyfin");
    expect(plan.steps[0].tier).toBe("safe_write");
    expect(plan.hand_off).toBe(false);
  });

  it("SERVICE_UNHEALTHY → restart plan with stronger description", () => {
    const plan = buildRemediationPlan(makeConfig(), {
      classification: "SERVICE_UNHEALTHY",
      ping_ok: true,
      notes: [],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toMatch(/deadlock|hang|self-reported/i);
  });

  it("VM_UNREACHABLE → hand off, no steps", () => {
    const plan = buildRemediationPlan(makeConfig(), {
      classification: "VM_UNREACHABLE",
      ping_ok: false,
      notes: [],
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.hand_off).toBe(true);
    expect(plan.hand_off_reason).toMatch(/VM-level|ping/i);
  });
});

// ── detectRestartLoop ───────────────────────────────────────

describe("detectRestartLoop", () => {
  const baseTime = new Date("2026-05-12T12:30:00Z");
  function entry(minutesAgo: number): RestartHistoryEntry {
    return {
      service: "jellyfin",
      at: new Date(baseTime.getTime() - minutesAgo * 60_000).toISOString(),
      success: true,
    };
  }

  it("returns loop_detected=true when ≥3 restarts in 30 min", () => {
    const result = detectRestartLoop({
      config: makeConfig(),
      history: [entry(1), entry(10), entry(20)],
      now: baseTime,
    });
    expect(result.loop_detected).toBe(true);
    expect(result.restarts_in_window).toBe(3);
  });

  it("returns loop_detected=false when only 2 restarts in window", () => {
    const result = detectRestartLoop({
      config: makeConfig(),
      history: [entry(1), entry(10)],
      now: baseTime,
    });
    expect(result.loop_detected).toBe(false);
  });

  it("backoff window slides — 4th restart at 31 min is allowed", () => {
    // 3 restarts in the last 30 min trips the guard; once one ages
    // out past 30 min, the 4th restart is allowed.
    const result = detectRestartLoop({
      config: makeConfig(),
      // 31, 20, 10 min ago — only the 20+10 are within window
      history: [entry(31), entry(20), entry(10)],
      now: baseTime,
    });
    expect(result.loop_detected).toBe(false);
    expect(result.restarts_in_window).toBe(2);
  });

  it("scopes history by service name", () => {
    const result = detectRestartLoop({
      config: makeConfig(),
      history: [
        { service: "other", at: entry(1).at, success: true },
        { service: "other", at: entry(5).at, success: true },
        { service: "other", at: entry(10).at, success: true },
      ],
      now: baseTime,
    });
    expect(result.loop_detected).toBe(false);
  });
});

// ── verifyRecovery ──────────────────────────────────────────

describe("verifyRecovery", () => {
  it("3 healthy re-probes → recovered=true, ServiceRecovered semantics covered downstream", async () => {
    const exec = makeFakeExecutor({
      probeResults: [ok(), ok(), ok()],
    });
    const v = await verifyRecovery(exec, makeConfig(), {
      initial_delay_ms: 0,
      reprobe_interval_ms: 0,
      reprobe_count: 3,
    });
    expect(v.recovered).toBe(true);
    expect(v.probes).toHaveLength(3);
  });

  it("one flap then stable → recovered=true", async () => {
    const exec = makeFakeExecutor({
      probeResults: [fail(), ok(), ok()],
    });
    const v = await verifyRecovery(exec, makeConfig(), {
      initial_delay_ms: 0,
      reprobe_interval_ms: 0,
      reprobe_count: 3,
    });
    expect(v.recovered).toBe(true);
  });

  it("majority fail → recovered=false", async () => {
    const exec = makeFakeExecutor({
      probeResults: [fail(), fail(), ok()],
    });
    const v = await verifyRecovery(exec, makeConfig(), {
      initial_delay_ms: 0,
      reprobe_interval_ms: 0,
      reprobe_count: 3,
    });
    expect(v.recovered).toBe(false);
  });

  it("last probe fails → recovered=false even if majority succeeded", async () => {
    const exec = makeFakeExecutor({
      probeResults: [ok(), ok(), fail()],
    });
    const v = await verifyRecovery(exec, makeConfig(), {
      initial_delay_ms: 0,
      reprobe_interval_ms: 0,
      reprobe_count: 3,
    });
    expect(v.recovered).toBe(false);
  });
});

// ── runServiceProbePlaybook end-to-end ──────────────────────

describe("runServiceProbePlaybook", () => {
  it("VM_UNREACHABLE → no restart, hand off to VM playbook", async () => {
    const exec = makeFakeExecutor({ ping: false });
    const history: RestartHistoryEntry[] = [];
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on("*", (e) => events.push(e));

    const result = await runServiceProbePlaybook(
      exec,
      { config: makeConfig(), restart_history: history },
      bus,
    );

    expect(result.diagnostic.classification).toBe("VM_UNREACHABLE");
    expect(result.restart_executed).toBe(false);
    expect(exec.restartCalls).toBe(0);
    expect(result.plan.hand_off).toBe(true);
    // No ServiceDown/Unhealthy/RestartLoop events for VM-unreachable.
    expect(
      events.filter((e: any) =>
        [
          AgentEventType.ServiceDown,
          AgentEventType.ServiceUnhealthy,
          AgentEventType.ServiceRestartLoopDetected,
        ].includes(e.type),
      ),
    ).toHaveLength(0);
  });

  it("SERVICE_DOWN → restart + verify → ServiceRecovered event", async () => {
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "inactive",
      restartOk: true,
      probeResults: [ok(), ok(), ok()],
    });
    const history: RestartHistoryEntry[] = [];
    const bus = new EventBus();
    const recoveredEvents: unknown[] = [];
    const downEvents: unknown[] = [];
    bus.on(AgentEventType.ServiceRecovered, (e) => recoveredEvents.push(e));
    bus.on(AgentEventType.ServiceDown, (e) => downEvents.push(e));

    const config = {
      ...makeConfig(),
    };
    // Speed up the verify phase
    const result = await runServiceProbePlaybook(
      exec,
      {
        config,
        restart_history: history,
      },
      bus,
    );

    // ServiceDown should have fired
    expect(downEvents).toHaveLength(1);
    // Restart executed
    expect(exec.restartCalls).toBe(1);
    expect(result.restart_executed).toBe(true);
    expect(result.recovered).toBe(true);
    // ServiceRecovered should have fired
    expect(recoveredEvents).toHaveLength(1);
    // Restart appended to history
    expect(history).toHaveLength(1);
  });

  it("SERVICE_UNHEALTHY (systemd 'active' but HTTP failing) → restart anyway", async () => {
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "active",
      restartOk: true,
      probeResults: [ok(), ok(), ok()],
    });
    const history: RestartHistoryEntry[] = [];
    const bus = new EventBus();
    const unhealthyEvents: unknown[] = [];
    bus.on(AgentEventType.ServiceUnhealthy, (e) => unhealthyEvents.push(e));

    const result = await runServiceProbePlaybook(
      exec,
      { config: makeConfig(), restart_history: history },
      bus,
    );

    expect(unhealthyEvents).toHaveLength(1);
    expect(result.diagnostic.classification).toBe("SERVICE_UNHEALTHY");
    expect(exec.restartCalls).toBe(1);
  });

  it("restart-loop guard tripped → no restart, ServiceRestartLoopDetected event", async () => {
    const now = new Date("2026-05-12T13:00:00Z");
    const history: RestartHistoryEntry[] = [
      { service: "jellyfin", at: new Date(now.getTime() - 5 * 60_000).toISOString(), success: true },
      { service: "jellyfin", at: new Date(now.getTime() - 15 * 60_000).toISOString(), success: true },
      { service: "jellyfin", at: new Date(now.getTime() - 25 * 60_000).toISOString(), success: true },
    ];
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "inactive",
      now,
    });
    const bus = new EventBus();
    const loopEvents: unknown[] = [];
    bus.on(AgentEventType.ServiceRestartLoopDetected, (e) =>
      loopEvents.push(e),
    );

    const result = await runServiceProbePlaybook(
      exec,
      { config: makeConfig(), restart_history: history },
      bus,
    );

    expect(loopEvents).toHaveLength(1);
    expect(result.restart_executed).toBe(false);
    expect(exec.restartCalls).toBe(0);
    expect(result.plan.hand_off).toBe(true);
    expect(result.loop_guard.loop_detected).toBe(true);
  });

  it("approval rejection → no restart", async () => {
    const exec = makeFakeExecutor({
      ping: true,
      systemctlActive: "inactive",
    });
    const result = await runServiceProbePlaybook(
      exec,
      {
        config: makeConfig(),
        restart_history: [],
        approve_restart: async () => false,
      },
    );
    expect(result.restart_executed).toBe(false);
    expect(exec.restartCalls).toBe(0);
  });
});

// ── DEFAULT_FAILURE_THRESHOLD sanity ────────────────────────

describe("constants", () => {
  it("default failure threshold is 3", () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
  });
  it("default backoff window is 30 min", () => {
    expect(DEFAULT_RESTART_BACKOFF_WINDOW_MINS).toBe(30);
  });
});
