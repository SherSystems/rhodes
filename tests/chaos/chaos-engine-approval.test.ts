// ============================================================
// RHODES — Chaos approval-gate enforcement tests (security X-1)
//
// Verifies that ChaosEngine.execute() actually awaits ApprovalGate
// instead of just mutating a recommendation string. Covers:
//   1. high-risk + reject → no execution
//   2. high-risk + approve → execution proceeds
//   3. low-risk → no approval requested
//   4. NEVER list → unconditionally blocked, gate never called
//   5. approval timeout → treated as reject
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChaosEngine } from "../../src/chaos/engine.js";
import { AgentEventType } from "../../src/types.js";
import type { VMInfo, ClusterState, ApprovalResponse, ApprovalRequest } from "../../src/types.js";
import { BUILTIN_SCENARIOS } from "../../src/chaos/scenarios.js";

// ── Helpers ─────────────────────────────────────────────────

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

/** Cluster sized + stressed so node_drain crosses the risk threshold. */
function makeStressedCluster(): ClusterState {
  return {
    adapter: "test",
    nodes: [
      {
        id: "n1",
        name: "node-1",
        status: "online",
        cpu_cores: 16,
        cpu_usage_pct: 92,
        ram_total_mb: 65536,
        ram_used_mb: 60000,
        disk_total_gb: 1000,
        disk_used_gb: 800,
        disk_usage_pct: 80,
        uptime_s: 1000,
      },
      {
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
      },
    ],
    vms: [
      makeVm(101, { name: "db-primary", node: "node-1" }),
      makeVm(102, { name: "api-gateway", node: "node-1" }),
      makeVm(103, { name: "auth-svc", node: "node-1" }),
    ],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
  };
}

/** Plain cluster with one VM — risk stays low. */
function makePlainCluster(): ClusterState {
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
    vms: [makeVm(101)],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build the engine with a stub approval gate. The gate exposes the same
 * `requestApproval(request) => Promise<ApprovalResponse>` shape used by
 * the real ApprovalGate, so we exercise the actual API path — not a
 * string mutation.
 */
function buildEngineWithGate(opts: {
  cluster: ClusterState | ClusterState[];
  approvalGate?: {
    requestApproval: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  };
  approvalRiskThreshold?: number;
  approvalTimeoutMs?: number;
}) {
  const states = Array.isArray(opts.cluster) ? [...opts.cluster] : [opts.cluster];
  const execute = vi.fn().mockResolvedValue({ success: true, data: {} });
  const getClusterState = vi.fn(async () => {
    if (states.length === 0) return null;
    if (states.length === 1) return states[0];
    return states.shift() ?? null;
  });
  const emit = vi.fn();
  const engine = new ChaosEngine({
    agentCore: { run: vi.fn().mockResolvedValue({ success: true }) } as any,
    toolRegistry: { execute, getClusterState } as any,
    eventBus: { emit, on: vi.fn(), off: vi.fn(), getHistory: vi.fn().mockReturnValue([]) } as any,
    healingOrchestrator: {
      incidentManager: {
        getRecent: vi.fn().mockReturnValue([]),
        getById: vi.fn().mockReturnValue(null),
      },
    } as any,
    approvalGate: opts.approvalGate as any,
    approvalRiskThreshold: opts.approvalRiskThreshold,
    approvalTimeoutMs: opts.approvalTimeoutMs,
  });
  // Bypass real sleeps in recovery polling
  vi.spyOn(engine as any, "sleep").mockResolvedValue(undefined);
  return { engine, execute, emit, getClusterState };
}

// ── Tests ───────────────────────────────────────────────────

describe("ChaosEngine approval gate (security X-1)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects high-risk scenario when operator rejects → does NOT execute mutations", async () => {
    const cluster = makeStressedCluster();
    const requestApproval = vi.fn(async (req: ApprovalRequest) => ({
      request_id: req.id,
      approved: false,
      method: "dashboard" as const,
      timestamp: new Date().toISOString(),
    }));
    const { engine, execute, emit } = buildEngineWithGate({
      cluster,
      approvalGate: { requestApproval },
    });

    const run = await engine.execute("node_drain", { node: "node-1" });

    // The simulator computes risk; stressed cluster + node_drain should cross 70.
    expect(run.simulation.risk_score).toBeGreaterThan(70);

    // Approval gate API actually invoked — not just a string mutation.
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const callArg = requestApproval.mock.calls[0][0];
    expect(callArg.action).toBe("chaos:execute:node_drain");
    expect(callArg.tier).toBe("destructive");
    expect(callArg.plan_id).toMatch(/^chaos:/);

    // Engine bailed out — no failure-injection tools fired.
    expect(execute).not.toHaveBeenCalled();

    // Run status reflects rejection.
    expect(run.status).toBe("rejected");
    expect(run.approval?.decision).toBe("rejected");
    expect(run.approval?.required).toBe(true);

    // The ChaosStarted event must NOT have fired.
    const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
    expect(eventTypes).not.toContain(AgentEventType.ChaosStarted);
    expect(eventTypes).toContain(AgentEventType.ChaosRejected);
    expect(eventTypes).toContain(AgentEventType.ChaosAudited);

    // History records the rejected run.
    expect(engine.getHistory()).toHaveLength(1);
    expect(engine.getHistory()[0].status).toBe("rejected");
  });

  it("proceeds when operator approves a high-risk scenario", async () => {
    const cluster = makeStressedCluster();
    const requestApproval = vi.fn(async (req: ApprovalRequest) => ({
      request_id: req.id,
      approved: true,
      approved_by: "alice@ops",
      method: "dashboard" as const,
      timestamp: new Date().toISOString(),
    }));
    const { engine, execute, emit } = buildEngineWithGate({
      cluster,
      approvalGate: { requestApproval },
    });

    const run = await engine.execute("node_drain", { node: "node-1" });

    // Approval was awaited.
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Execution actually happened — at least one stop_vm call.
    expect(execute).toHaveBeenCalled();
    const stopCalls = execute.mock.calls.filter(([toolName]) => toolName === "stop_vm");
    expect(stopCalls.length).toBeGreaterThan(0);

    // Approval metadata propagated.
    expect(run.approval?.decision).toBe("approved");
    expect(run.approval?.operator).toBe("alice@ops");
    expect(run.status).toBe("completed");

    const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
    expect(eventTypes).toContain(AgentEventType.ChaosApproved);
    expect(eventTypes).toContain(AgentEventType.ChaosStarted);
    expect(eventTypes).toContain(AgentEventType.ChaosCompleted);
    expect(eventTypes).toContain(AgentEventType.ChaosAudited);
  });

  it("does NOT request approval when risk is below threshold", async () => {
    const cluster = makePlainCluster();
    const requestApproval = vi.fn();
    const { engine, execute, emit } = buildEngineWithGate({
      cluster,
      approvalGate: { requestApproval: requestApproval as any },
    });

    // vm_kill on this cluster has risk_score well under 70 and
    // requires_approval=false anyway, so no gate call.
    const run = await engine.execute("vm_kill", { vmid: 101 });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(run.approval?.required).toBe(false);
    expect(run.approval?.decision).toBe("not_required");
    expect(run.status).toBe("completed");

    // Execution proceeded.
    expect(execute).toHaveBeenCalledWith("stop_vm", expect.objectContaining({ vmid: 101 }));

    const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
    expect(eventTypes).not.toContain(AgentEventType.ChaosApproved);
    expect(eventTypes).not.toContain(AgentEventType.ChaosRejected);
  });

  it("requests approval for every approval-flagged scenario when threshold is 0", async () => {
    // memory_pressure: requires_approval=true, severity=high.
    // On a plain single-VM cluster it scores well below 70, so under the
    // default threshold approval would NOT be requested. With threshold=0
    // it MUST be requested.
    const cluster = makePlainCluster();
    const requestApproval = vi.fn(async (req: ApprovalRequest) => ({
      request_id: req.id,
      approved: false,
      method: "dashboard" as const,
      timestamp: new Date().toISOString(),
    }));
    const { engine, execute } = buildEngineWithGate({
      cluster,
      approvalGate: { requestApproval },
      approvalRiskThreshold: 0,
    });

    const run = await engine.execute("memory_pressure", { vmid: 101 });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks NEVER-list scenarios unconditionally — approval gate is never called", async () => {
    // Inject a scenario that hits the NEVER list. We re-use vm_kill but
    // mutate its registered ID to "vm_destroy" via the in-memory registry
    // for the duration of the test.
    const cluster = makePlainCluster();
    const requestApproval = vi.fn();
    const { engine, execute, emit } = buildEngineWithGate({
      cluster,
      approvalGate: { requestApproval: requestApproval as any },
    });

    // Add a synthetic "vm_destroy" scenario to the registry for this test.
    const synthetic = {
      ...BUILTIN_SCENARIOS[0],
      id: "vm_destroy",
      name: "VM Destroy (synthetic)",
      requires_approval: true,
    };
    BUILTIN_SCENARIOS.push(synthetic);
    try {
      const run = await engine.execute("vm_destroy", { vmid: 101 });

      // Gate never invoked.
      expect(requestApproval).not.toHaveBeenCalled();
      // No mutation fired.
      expect(execute).not.toHaveBeenCalled();

      expect(run.status).toBe("blocked");
      expect(run.approval?.decision).toBe("blocked");
      expect(run.simulation.recommendation).toMatch(/BLOCKED-NEVER/);

      const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
      expect(eventTypes).toContain(AgentEventType.ChaosBlocked);
      expect(eventTypes).toContain(AgentEventType.ChaosAudited);
      expect(eventTypes).not.toContain(AgentEventType.ChaosStarted);
    } finally {
      // Remove the synthetic scenario.
      const idx = BUILTIN_SCENARIOS.findIndex((s) => s.id === "vm_destroy");
      if (idx >= 0) BUILTIN_SCENARIOS.splice(idx, 1);
    }
  });

  it("treats approval timeout as rejection — executor not called", async () => {
    const cluster = makeStressedCluster();
    // Gate that never resolves — we want the timeout to fire.
    const requestApproval = vi.fn(
      () => new Promise<ApprovalResponse>(() => { /* never resolves */ }),
    );
    const { engine, execute, emit } = buildEngineWithGate({
      cluster,
      approvalGate: { requestApproval },
      approvalTimeoutMs: 25, // tight window for the test
    });

    const run = await engine.execute("node_drain", { node: "node-1" });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("rejected");
    expect(run.approval?.decision).toBe("timeout");
    expect(execute).not.toHaveBeenCalled();

    const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
    expect(eventTypes).toContain(AgentEventType.ChaosApprovalTimeout);
    expect(eventTypes).toContain(AgentEventType.ChaosAudited);
    expect(eventTypes).not.toContain(AgentEventType.ChaosStarted);
  });

  it("auto-rejects when approvalGate is missing (fail-safe, not fail-open)", async () => {
    const cluster = makeStressedCluster();
    // No approvalGate provided.
    const { engine, execute, emit } = buildEngineWithGate({ cluster });

    const run = await engine.execute("node_drain", { node: "node-1" });

    expect(run.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();

    const eventTypes = emit.mock.calls.map(([evt]) => evt.type);
    expect(eventTypes).toContain(AgentEventType.ChaosRejected);
    expect(eventTypes).toContain(AgentEventType.ChaosAudited);
  });

  it("emits ChaosAudited with executed=false on rejection and executed=true on completion", async () => {
    // Rejection path
    const requestApproval = vi.fn(async (req: ApprovalRequest) => ({
      request_id: req.id,
      approved: false,
      method: "dashboard" as const,
      timestamp: new Date().toISOString(),
    }));
    const rejected = buildEngineWithGate({
      cluster: makeStressedCluster(),
      approvalGate: { requestApproval },
    });
    await rejected.engine.execute("node_drain", { node: "node-1" });
    const rejectedAudit = rejected.emit.mock.calls.find(
      ([evt]) => evt.type === AgentEventType.ChaosAudited,
    );
    expect(rejectedAudit).toBeTruthy();
    expect(rejectedAudit?.[0].data.executed).toBe(false);
    expect(rejectedAudit?.[0].data.approval_required).toBe(true);
    expect(rejectedAudit?.[0].data.approval_decision).toBe("rejected");
    expect(rejectedAudit?.[0].data.scenario).toBe("node_drain");

    // Completion path
    const approved = buildEngineWithGate({
      cluster: makePlainCluster(),
    });
    await approved.engine.execute("vm_kill", { vmid: 101 });
    const completedAudit = approved.emit.mock.calls.find(
      ([evt]) => evt.type === AgentEventType.ChaosAudited,
    );
    expect(completedAudit).toBeTruthy();
    expect(completedAudit?.[0].data.executed).toBe(true);
    expect(completedAudit?.[0].data.approval_required).toBe(false);
    expect(completedAudit?.[0].data.approval_decision).toBe("not_required");
  });
});
