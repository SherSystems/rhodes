import { describe, it, expect, vi } from "vitest";
import { ChaosEngine } from "../../src/chaos/engine.js";
import { AgentEventType } from "../../src/types.js";
import type { VMInfo, ClusterState } from "../../src/types.js";

function makeVm(id: string | number, overrides: Partial<VMInfo> = {}): VMInfo {
  return {
    id,
    name: overrides.name ?? `vm-${id}`,
    node: overrides.node ?? "node-1",
    status: overrides.status ?? "running",
    cpu_cores: overrides.cpu_cores ?? 2,
    ram_mb: overrides.ram_mb ?? 2048,
    disk_gb: overrides.disk_gb ?? 40,
    ip_address: overrides.ip_address ?? "10.0.0.10",
  };
}

function makeCluster(vms: VMInfo[]): ClusterState {
  return {
    adapter: "test",
    nodes: [
      {
        id: "n1",
        name: "node-1",
        status: "online",
        cpu_cores: 16,
        cpu_usage_pct: 20,
        ram_total_mb: 65536,
        ram_used_mb: 16000,
        disk_total_gb: 1000,
        disk_used_gb: 200,
        disk_usage_pct: 20,
        uptime_s: 1000,
      },
    ],
    vms,
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
  };
}

function makeEngine(options: {
  clusterStateSequence?: Array<ClusterState | null>;
} = {}) {
  const execute = vi.fn().mockResolvedValue({ success: true, data: {} });
  const clusterStates = [...(options.clusterStateSequence ?? [null])];
  const getClusterState = vi.fn(async () => {
    if (clusterStates.length === 0) return null;
    if (clusterStates.length === 1) return clusterStates[0];
    return clusterStates.shift() ?? null;
  });
  const toolRegistry = {
    execute,
    getClusterState,
  };
  const emit = vi.fn();
  const eventBus = {
    emit,
    on: vi.fn(),
    off: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  };
  const agentCore = {
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  const healingOrchestrator = {
    incidentManager: {
      getRecent: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(null),
    },
  };

  const engine = new ChaosEngine({
    agentCore: agentCore as any,
    toolRegistry: toolRegistry as any,
    eventBus: eventBus as any,
    healingOrchestrator: healingOrchestrator as any,
  });

  return {
    engine,
    execute,
    emit,
    getClusterState,
    getRecentIncidents: healingOrchestrator.incidentManager.getRecent,
    getIncidentById: healingOrchestrator.incidentManager.getById,
  };
}

describe("ChaosEngine lifecycle and regression coverage", () => {
  it("uses VMware power-off tool for VMware-style VM IDs", async () => {
    const { engine, execute } = makeEngine();
    await (engine as any).stopVM(makeVm("vm-42"));

    expect(execute).toHaveBeenCalledWith("vmware_vm_power_off", { vm_id: "vm-42" });
  });

  it("computes blast radius for cpu_stress with string VM identifiers", () => {
    const { engine } = makeEngine();
    const scenario = {
      id: "cpu_stress",
      expected_recovery: { max_recovery_time_s: 120 },
    };
    const cluster = makeCluster([makeVm("vm-42"), makeVm(101)]);

    const blast = (engine as any).computeBlastRadius(scenario, cluster, { vmid: "vm-42" });
    expect(blast.total_affected).toBe(1);
    expect(blast.affected_vms[0].vmid).toBe("vm-42");
  });

  it("executes stress_cpu using ssh_exec with the target VM IP", async () => {
    const { engine, execute } = makeEngine();
    const scenario = {
      id: "cpu_stress",
      actions: [
        {
          type: "stress_cpu",
          params: { duration_s: 5, workers: 1 },
          description: "cpu stress",
        },
      ],
    };
    const cluster = makeCluster([makeVm("vm-42", { ip_address: "10.2.0.5" })]);

    const steps = await (engine as any).injectFailures(scenario, cluster, { vmid: "vm-42" });
    expect(steps).toBe(1);
    expect(execute).toHaveBeenCalledWith(
      "ssh_exec",
      expect.objectContaining({
        host: "10.2.0.5",
      }),
    );
  });

  it("validates scenario inputs for vm_kill", async () => {
    const cluster = makeCluster([makeVm(101)]);
    const { engine } = makeEngine({ clusterStateSequence: [cluster] });

    await expect(engine.simulate("vm_kill")).rejects.toThrow(
      "vm_kill scenario requires params.vmid",
    );
  });

  it("rejects unknown scenario ids", async () => {
    const { engine } = makeEngine();

    await expect(engine.simulate("not_a_real_scenario", { vmid: 101 })).rejects.toThrow(
      'Unknown scenario "not_a_real_scenario"',
    );
  });

  it("executes vm_kill end-to-end and transitions to completed", async () => {
    const state = makeCluster([makeVm(101, { status: "running" })]);
    const { engine, execute, emit } = makeEngine({
      clusterStateSequence: [state, state, state],
    });
    vi.spyOn(engine as any, "sleep").mockResolvedValue(undefined);

    const run = await engine.execute("vm_kill", { vmid: 101 });

    expect(run.status).toBe("completed");
    expect(run.actual?.all_recovered).toBe(true);
    expect(run.actual?.steps_executed).toBe(1);
    expect(engine.getActiveRun()).toBeNull();
    expect(engine.getHistory()).toHaveLength(1);

    expect(execute).toHaveBeenCalledWith("stop_vm", {
      node: "node-1",
      vmid: 101,
    });

    const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
    expect(eventTypes).toContain(AgentEventType.ChaosSimulated);
    expect(eventTypes).toContain(AgentEventType.ChaosStarted);
    expect(eventTypes).toContain(AgentEventType.ChaosRecoveryDetected);
    expect(eventTypes).toContain(AgentEventType.ChaosCompleted);
  });

  it("detects recovery across polling cycles", async () => {
    const first = makeCluster([
      makeVm(101, { status: "stopped" }),
      makeVm(102, { status: "running" }),
    ]);
    const second = makeCluster([
      makeVm(101, { status: "running" }),
      makeVm(102, { status: "running" }),
    ]);
    const { engine } = makeEngine({ clusterStateSequence: [first, second] });
    vi.spyOn(engine as any, "sleep").mockResolvedValue(undefined);

    const result = await (engine as any).waitForRecovery(["101", "102"], 1_000);

    expect(result.allRecovered).toBe(true);
    expect(result.recovered.sort()).toEqual(["101", "102"]);
    expect(result.notRecovered).toEqual([]);
  });

  it("rejects execution when another chaos run is active", async () => {
    const { engine } = makeEngine();
    (engine as any).activeRun = {
      id: "existing-run",
      scenario: { id: "vm_kill" },
    };

    await expect(engine.execute("vm_kill", { vmid: 101 })).rejects.toThrow(
      "A chaos run is already active",
    );
  });

  it("marks run failed and emits failure event when injection throws", async () => {
    const state = makeCluster([makeVm(101, { status: "running" })]);
    const { engine, emit } = makeEngine({ clusterStateSequence: [state, state] });
    vi.spyOn(engine as any, "injectFailures").mockRejectedValue(
      new Error("injection failed"),
    );

    await expect(engine.execute("vm_kill", { vmid: 101 })).rejects.toThrow(
      "injection failed",
    );

    const history = engine.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("failed");
    expect(engine.getActiveRun()).toBeNull();

    const failureEvent = emit.mock.calls.find(
      ([evt]) => evt.type === AgentEventType.ChaosFailed,
    );
    expect(failureEvent).toBeTruthy();
    expect(failureEvent?.[0].data.error).toContain("injection failed");
  });

  it("rejects high-risk approval-required scenarios when no approval gate is wired (security X-1, fail-safe)", async () => {
    const stressed = makeCluster([
      makeVm(101, { name: "db-primary", status: "running", node: "node-1" }),
      makeVm(102, { name: "api-gateway", status: "running", node: "node-1" }),
    ]);
    stressed.nodes[0].cpu_usage_pct = 92;
    stressed.nodes.push({
      id: "n2",
      name: "node-2",
      status: "offline",
      cpu_cores: 16,
      cpu_usage_pct: 95,
      ram_total_mb: 65536,
      ram_used_mb: 62000,
      disk_total_gb: 1000,
      disk_used_gb: 950,
      disk_usage_pct: 95,
      uptime_s: 1000,
    });

    const { engine, execute } = makeEngine({
      clusterStateSequence: [stressed, stressed, stressed],
    });
    vi.spyOn(engine as any, "sleep").mockResolvedValue(undefined);

    const run = await engine.execute("node_drain", { node: "node-1" });

    // Risk crosses the default 70 threshold.
    expect(run.simulation.risk_score).toBeGreaterThan(70);
    // Recommendation flags approval, not just a cosmetic "[BLOCKED]".
    expect(run.simulation.recommendation).toContain("[APPROVAL REQUIRED]");
    // With no approval gate wired, the engine fails safe — no execution.
    expect(run.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns unrecovered VMs when recovery times out", async () => {
    const { engine } = makeEngine({
      clusterStateSequence: [makeCluster([makeVm(101, { status: "stopped" })])],
    });

    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(engine as any, "sleep").mockImplementation(async () => {
      now += 5_000;
    });

    try {
      const result = await (engine as any).waitForRecovery(["101"], 2_000);
      expect(result.allRecovered).toBe(false);
      expect(result.recovered).toEqual([]);
      expect(result.notRecovered).toEqual(["101"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("scores non-full recovery as partial when at least half recover", () => {
    const { engine, getIncidentById } = makeEngine();
    getIncidentById.mockImplementation((id: string) =>
      id === "inc-1" ? { status: "resolved" } : { status: "open" },
    );

    const score = (engine as any).scoreRun({
      scenario: { expected_recovery: { max_recovery_time_s: 120 } },
      simulation: {
        predicted_recovery_time_s: 60,
        blast_radius: { total_affected: 2 },
      },
      actual: {
        recovery_time_s: 90,
        all_recovered: false,
        incidents_created: ["inc-1", "inc-2"],
      },
    });

    expect(score.resilience_pct).toBe(50);
    expect(score.verdict).toBe("partial");
  });

  it("scores low-resilience outcomes as fail", () => {
    const { engine, getIncidentById } = makeEngine();
    getIncidentById.mockImplementation(() => ({ status: "open" }));

    const score = (engine as any).scoreRun({
      scenario: { expected_recovery: { max_recovery_time_s: 120 } },
      simulation: {
        predicted_recovery_time_s: 60,
        blast_radius: { total_affected: 3 },
      },
      actual: {
        recovery_time_s: 95,
        all_recovered: false,
        incidents_created: ["inc-1"],
      },
    });

    expect(score.resilience_pct).toBe(0);
    expect(score.verdict).toBe("fail");
  });
});
