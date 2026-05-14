// ============================================================
// RHODES — API-driven approval flow tests (v0.4.2)
// Validates that an approval gate blocked under daemon mode
// (no TTY, no CLI handler) can be resolved via the HTTP API:
//   GET  /api/agent/pending-approvals
//   POST /api/agent/approve { plan_id, decision, operator }
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApprovalGate } from "../../src/governance/approval.js";
import { DashboardServer } from "../../src/frontends/dashboard/server.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import type { ApprovalRequest } from "../../src/types.js";

// ── HTTP test helpers (same shape as dashboard-server-static.test.ts) ──

function makeServer(eventBus: EventBus) {
  const toolRegistry = {
    getClusterState: vi.fn(),
    getMultiClusterState: vi.fn(),
  } as any;

  const audit = {
    queryEntries: vi.fn(() => []),
    getStats: vi.fn(() => ({})),
    exportEntries: vi.fn(() => "[]"),
  } as any;

  return new DashboardServer(0, {} as any, toolRegistry, eventBus, audit) as any;
}

function makeGetReq(path: string) {
  return { url: path, method: "GET" } as any;
}

function makeJsonReq(path: string, body: Record<string, unknown>) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req: any = {
    url: path,
    method: "POST",
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return req;
    },
    flush() {
      const payload = Buffer.from(JSON.stringify(body));
      for (const cb of listeners.data ?? []) cb(payload);
      for (const cb of listeners.end ?? []) cb();
    },
  };
  return req;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body: unknown;
  return {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, next?: Record<string, string>) {
      statusCode = code;
      if (next) for (const [k, v] of Object.entries(next)) headers[k.toLowerCase()] = v;
    },
    end(chunk?: unknown) {
      body = chunk;
    },
    getStatusCode() {
      return statusCode;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    getJsonBody() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
  };
}

/** Drive the request lifecycle end-to-end for routes that read req body. */
async function runPost(server: any, path: string, body: Record<string, unknown>) {
  const req = makeJsonReq(path, body);
  const res = makeRes();
  server.handleRequest(req, res);
  req.flush();
  // Let the parseBody promise resolve before assertions.
  await new Promise((r) => setImmediate(r));
  return res;
}

function runGet(server: any, path: string) {
  const req = makeGetReq(path);
  const res = makeRes();
  server.handleRequest(req, res);
  return res;
}

// ── Tests ──────────────────────────────────────────────────

describe("ApprovalGate — API decision plumbing", () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = new ApprovalGate();
  });

  it("registers a pending plan-level entry once a listener subscribes", async () => {
    const seen: string[] = [];
    gate.onAwaitingApproval((e) => seen.push(e.plan_id));

    const promise = gate.requestPlanApproval(
      "plan-A",
      "Goal A",
      [{ id: "s1", action: "stop_vm", description: "stop", tier: "destructive" }],
      "reason",
    );

    // Pending entry must appear in the queue.
    await new Promise((r) => setImmediate(r));
    expect(gate.getPendingApprovals().map((p) => p.plan_id)).toEqual(["plan-A"]);
    expect(seen).toEqual(["plan-A"]);

    // Resolve via API: approve.
    const result = gate.submitApiDecision("plan-A", "approve", "pranav");
    expect(result.ok).toBe(true);

    await expect(promise).resolves.toBe(true);
    expect(gate.isPlanApproved("plan-A")).toBe(true);
    expect(gate.getPendingApprovals()).toHaveLength(0);
  });

  it("a reject decision rejects the awaiting promise and does not approve the plan", async () => {
    gate.onAwaitingApproval(() => undefined);
    const promise = gate.requestPlanApproval("plan-B", "Goal B", [], "reason");

    await new Promise((r) => setImmediate(r));
    gate.submitApiDecision("plan-B", "reject", "pranav");

    await expect(promise).resolves.toBe(false);
    expect(gate.isPlanApproved("plan-B")).toBe(false);
  });

  it("double-approve is idempotent", async () => {
    gate.onAwaitingApproval(() => undefined);
    const promise = gate.requestPlanApproval("plan-C", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const first = gate.submitApiDecision("plan-C", "approve", "pranav");
    const second = gate.submitApiDecision("plan-C", "approve", "pranav");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);
      expect(first.record.timestamp).toBe(second.record.timestamp);
    }
    await expect(promise).resolves.toBe(true);
  });

  it("unknown plan_id returns ok=false with reason=unknown_plan", () => {
    const result = gate.submitApiDecision("does-not-exist", "approve", "pranav");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_plan");
  });

  it("step-level requestApproval also resolves via API when plan_id is set", async () => {
    gate.onAwaitingApproval(() => undefined);

    const request: ApprovalRequest = {
      id: "req-1",
      action: "delete_vm",
      tier: "destructive",
      params: { vmid: 999 },
      reasoning: "needs deletion",
      plan_id: "plan-D",
      timestamp: new Date().toISOString(),
    };

    const promise = gate.requestApproval(request);
    await new Promise((r) => setImmediate(r));

    expect(gate.getPendingApprovals().map((p) => p.plan_id)).toEqual(["plan-D"]);

    gate.submitApiDecision("plan-D", "approve", "pranav");
    const response = await promise;

    expect(response.approved).toBe(true);
    expect(response.method).toBe("dashboard");
    expect(response.approved_by).toBe("pranav");
  });
});

describe("Dashboard /api/agent/approve + /api/agent/pending-approvals", () => {
  let gate: ApprovalGate;
  let bus: EventBus;
  let server: any;

  beforeEach(() => {
    gate = new ApprovalGate();
    bus = new EventBus();
    server = makeServer(bus);
    server.attachApprovalGate(gate);
  });

  it("emits an AwaitingApproval event when a gate registers", async () => {
    const events: string[] = [];
    bus.on("*", (e) => events.push(e.type));

    const promise = gate.requestPlanApproval(
      "plan-E",
      "Restart paused VM",
      [{ id: "s1", action: "resume_vm", description: "resume", tier: "destructive" }],
      "reason",
    );

    await new Promise((r) => setImmediate(r));
    expect(events).toContain(AgentEventType.AwaitingApproval);

    // Clean up the dangling promise.
    gate.submitApiDecision("plan-E", "approve", "pranav");
    await promise;
  });

  it("GET /api/agent/pending-approvals returns the queue", async () => {
    const promise = gate.requestPlanApproval(
      "plan-F",
      "Goal F",
      [{ id: "s1", action: "stop_vm", description: "stop", tier: "destructive" }],
      "needs approval",
    );
    await new Promise((r) => setImmediate(r));

    const res = runGet(server, "/api/agent/pending-approvals");
    expect(res.getStatusCode()).toBe(200);
    const body = res.getJsonBody();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].plan_id).toBe("plan-F");
    expect(body[0].action).toBe("plan_approval");
    expect(body[0].tier).toBe("destructive");
    expect(body[0].scope).toBe("plan");

    gate.submitApiDecision("plan-F", "approve", "pranav");
    await promise;
  });

  it("POST /api/agent/approve approves and resolves the plan promise", async () => {
    const promise = gate.requestPlanApproval("plan-G", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-G",
      decision: "approve",
      operator: "pranav",
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getJsonBody();
    expect(body.plan_id).toBe("plan-G");
    expect(body.status).toBe("approved");
    expect(body.operator).toBe("pranav");
    expect(body.idempotent).toBe(false);

    await expect(promise).resolves.toBe(true);
  });

  it("POST /api/agent/approve aborts a plan when decision=reject", async () => {
    const promise = gate.requestPlanApproval("plan-H", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-H",
      decision: "reject",
      operator: "pranav",
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getJsonBody().status).toBe("rejected");
    await expect(promise).resolves.toBe(false);
  });

  it("POST /api/agent/approve is idempotent on repeat", async () => {
    const promise = gate.requestPlanApproval("plan-I", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const first = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-I",
      decision: "approve",
      operator: "pranav",
    });
    const second = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-I",
      decision: "approve",
      operator: "pranav",
    });

    expect(first.getStatusCode()).toBe(200);
    expect(second.getStatusCode()).toBe(200);
    expect(first.getJsonBody().idempotent).toBe(false);
    expect(second.getJsonBody().idempotent).toBe(true);

    await expect(promise).resolves.toBe(true);
  });

  it("POST /api/agent/approve returns 404 for unknown plan_id", async () => {
    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "nope",
      decision: "approve",
      operator: "pranav",
    });
    expect(res.getStatusCode()).toBe(404);
  });

  it("POST /api/agent/approve validates body fields", async () => {
    const noPlan = await runPost(server, "/api/agent/approve", {
      decision: "approve",
      operator: "pranav",
    });
    expect(noPlan.getStatusCode()).toBe(400);

    // Need a pending entry so the decision-validator runs before the
    // unknown-plan check (otherwise 404 would mask the 400).
    const promise = gate.requestPlanApproval("plan-V", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const badDecision = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-V",
      decision: "maybe",
      operator: "pranav",
    });
    expect(badDecision.getStatusCode()).toBe(400);

    gate.submitApiDecision("plan-V", "approve", "pranav");
    await promise;
  });

  it("POST /api/agent/approve broadcasts PlanApproved / PlanRejected on the SSE stream", async () => {
    const types: string[] = [];
    bus.on("*", (e) => types.push(e.type));

    const promise = gate.requestPlanApproval("plan-J", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    await runPost(server, "/api/agent/approve", {
      plan_id: "plan-J",
      decision: "approve",
      operator: "pranav",
    });
    await promise;

    expect(types).toContain(AgentEventType.PlanApproved);
  });
});

// ── Per-step gate scoping (correctness HIGH #1 / security H-1) ─────
// Regression suite for the v0.4.6 fix: prior to this commit, an earlier
// plan-level approval auto-resolved later per-step `requestApproval`
// gates for the same plan_id, bypassing `policy.explicit_tiers`. The
// composite (plan_id, step_id) key must now keep them separate.

describe("ApprovalGate — per-step gate scoping (HIGH #1 / H-1)", () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = new ApprovalGate();
  });

  it("plan-level approval does NOT auto-resolve a later per-step requestApproval for the same plan_id", async () => {
    const seen: Array<{ plan_id: string; step_id?: string; scope: string }> = [];
    gate.onAwaitingApproval((e) => seen.push({ plan_id: e.plan_id, step_id: e.step_id, scope: e.scope }));

    // 1. Plan-level gate goes pending.
    const planPromise = gate.requestPlanApproval(
      "plan-K",
      "Multi-tier plan",
      [{ id: "s8", action: "delete_snapshot", description: "delete oldest", tier: "destructive" }],
      "reason",
    );
    await new Promise((r) => setImmediate(r));

    // 2. Operator approves at plan level.
    gate.submitApiDecision("plan-K", "approve", "pranav");
    await expect(planPromise).resolves.toBe(true);
    expect(gate.isPlanApproved("plan-K")).toBe(true);

    // 3. Now executor hits a per-step gate (e.g. the destructive
    //    delete_snapshot step). The prior plan-level decision MUST NOT
    //    satisfy it — a new pending entry must appear.
    const stepRequest: ApprovalRequest = {
      id: "req-step-8",
      action: "delete_snapshot",
      tier: "destructive",
      params: { vmid: 200, snapname: "auto-2025" },
      reasoning: "delete oldest snapshot",
      plan_id: "plan-K",
      step_id: "s8",
      timestamp: new Date().toISOString(),
    };

    const stepPromise = gate.requestApproval(stepRequest);
    // Yield once so the promise machinery enqueues the new entry.
    await new Promise((r) => setImmediate(r));

    // The pending queue should now contain ONLY the step gate.
    // (The plan-level entry resolved earlier and is gone.)
    const pending = gate.getPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].plan_id).toBe("plan-K");
    expect(pending[0].step_id).toBe("s8");
    expect(pending[0].scope).toBe("step");

    // The awaiting listener saw both gates separately.
    expect(seen).toEqual([
      { plan_id: "plan-K", step_id: undefined, scope: "plan" },
      { plan_id: "plan-K", step_id: "s8", scope: "step" },
    ]);

    // Resolve the step gate so the promise doesn't dangle.
    gate.submitApiDecision("plan-K", "approve", "pranav", "s8");
    await expect(stepPromise).resolves.toMatchObject({ approved: true, approved_by: "pranav" });
  });

  it("per-step approval resolves only that step's pending entry; other per-step gates stay queued", async () => {
    gate.onAwaitingApproval(() => undefined);

    const reqA: ApprovalRequest = {
      id: "req-A",
      action: "stop_vm",
      tier: "destructive",
      params: { vmid: 200 },
      reasoning: "stop A",
      plan_id: "plan-L",
      step_id: "s1",
      timestamp: new Date().toISOString(),
    };
    const reqB: ApprovalRequest = {
      id: "req-B",
      action: "delete_vm",
      tier: "destructive",
      params: { vmid: 201 },
      reasoning: "delete B",
      plan_id: "plan-L",
      step_id: "s2",
      timestamp: new Date().toISOString(),
    };

    const pA = gate.requestApproval(reqA);
    const pB = gate.requestApproval(reqB);
    await new Promise((r) => setImmediate(r));

    // Two distinct pending entries (this also covers correctness MEDIUM #3:
    // two sequential per-step gates against the same plan no longer collide).
    expect(gate.getPendingApprovals().map((p) => p.step_id).sort()).toEqual(["s1", "s2"]);

    // Approve only s1 — s2 must stay queued.
    gate.submitApiDecision("plan-L", "approve", "pranav", "s1");
    await expect(pA).resolves.toMatchObject({ approved: true });

    const stillPending = gate.getPendingApprovals();
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].step_id).toBe("s2");

    // Clean up.
    gate.submitApiDecision("plan-L", "approve", "pranav", "s2");
    await pB;
  });

  it("per-step rejection blocks only that step; other steps stay queued", async () => {
    gate.onAwaitingApproval(() => undefined);

    const reqA: ApprovalRequest = {
      id: "req-A",
      action: "stop_vm",
      tier: "destructive",
      params: {},
      reasoning: "stop",
      plan_id: "plan-M",
      step_id: "s1",
      timestamp: new Date().toISOString(),
    };
    const reqB: ApprovalRequest = {
      id: "req-B",
      action: "delete_snapshot",
      tier: "destructive",
      params: {},
      reasoning: "delete",
      plan_id: "plan-M",
      step_id: "s2",
      timestamp: new Date().toISOString(),
    };

    const pA = gate.requestApproval(reqA);
    const pB = gate.requestApproval(reqB);
    await new Promise((r) => setImmediate(r));

    gate.submitApiDecision("plan-M", "reject", "pranav", "s1");
    const respA = await pA;
    expect(respA.approved).toBe(false);

    // s2's gate is still queued. Contract: a step-level rejection lets
    // the caller (the executor) decide plan cancellation; the gate
    // itself only resolves the single step.
    const stillPending = gate.getPendingApprovals();
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].step_id).toBe("s2");

    // Clean up.
    gate.submitApiDecision("plan-M", "reject", "pranav", "s2");
    await pB;
  });

  it("plan_id-only submitApiDecision still works for backward compatibility", async () => {
    gate.onAwaitingApproval(() => undefined);
    const promise = gate.requestPlanApproval("plan-N", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    // No stepId — resolves the plan-level gate.
    const result = gate.submitApiDecision("plan-N", "approve", "pranav");
    expect(result.ok).toBe(true);
    await expect(promise).resolves.toBe(true);
    expect(gate.isPlanApproved("plan-N")).toBe(true);
  });

  it("plan-level approval has no effect on a separately-issued per-step gate created later", async () => {
    gate.onAwaitingApproval(() => undefined);

    // Plan-level pre-approval recorded BEFORE the step gate appears.
    const planPromise = gate.requestPlanApproval("plan-O", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));
    gate.submitApiDecision("plan-O", "approve", "pranav");
    await planPromise;

    // Now a per-step gate. It must NOT be auto-resolved by the plan-level
    // decision — its (plan_id, step_id) key has no prior record.
    const stepReq: ApprovalRequest = {
      id: "req-step",
      action: "delete_snapshot",
      tier: "destructive",
      params: {},
      reasoning: "step",
      plan_id: "plan-O",
      step_id: "s9",
      timestamp: new Date().toISOString(),
    };
    const stepPromise = gate.requestApproval(stepReq);
    await new Promise((r) => setImmediate(r));

    // Pending. The plan-level approval did NOT bleed through.
    expect(gate.getPendingApprovals().map((p) => p.step_id)).toEqual(["s9"]);

    gate.submitApiDecision("plan-O", "reject", "pranav", "s9");
    const resp = await stepPromise;
    expect(resp.approved).toBe(false);
  });

  it("unknown plan/step combination returns ok=false (does not leak a plan-level decision)", () => {
    // Pre-record a plan-level decision.
    const ghostGate = new ApprovalGate();
    ghostGate.onAwaitingApproval(() => undefined);
    // We need an actual pending entry first so submitApiDecision can record.
    // Easiest: register, approve, then ask about a different (plan, step) tuple.
    const promise = ghostGate.requestPlanApproval("plan-P", "g", [], "r");
    return new Promise<void>((done) => {
      setImmediate(() => {
        ghostGate.submitApiDecision("plan-P", "approve", "pranav");
        promise.then(() => {
          // Step-scoped lookup must NOT find the plan-level record.
          const result = ghostGate.submitApiDecision("plan-P", "approve", "pranav", "s-ghost");
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toBe("unknown_plan");
          done();
        });
      });
    });
  });

  it("AwaitingApproval SSE event carries step_id when the gate is per-step", async () => {
    const bus = new EventBus();
    const server = makeServer(bus);
    server.attachApprovalGate(gate);

    const events: Array<{ type: string; data: any }> = [];
    bus.on("*", (e) => events.push({ type: e.type, data: e.data }));

    const req: ApprovalRequest = {
      id: "req-step-sse",
      action: "delete_snapshot",
      tier: "destructive",
      params: {},
      reasoning: "delete",
      plan_id: "plan-Q",
      step_id: "s5",
      timestamp: new Date().toISOString(),
    };
    const promise = gate.requestApproval(req);
    await new Promise((r) => setImmediate(r));

    const awaiting = events.find((e) => e.type === AgentEventType.AwaitingApproval);
    expect(awaiting).toBeDefined();
    expect(awaiting?.data.plan_id).toBe("plan-Q");
    expect(awaiting?.data.step_id).toBe("s5");
    expect(awaiting?.data.scope).toBe("step");

    gate.submitApiDecision("plan-Q", "approve", "pranav", "s5");
    await promise;
  });

  it("POST /api/agent/approve with step_id resolves only that step's gate", async () => {
    const bus = new EventBus();
    const server = makeServer(bus);
    server.attachApprovalGate(gate);

    // Plan-level gate.
    const planPromise = gate.requestPlanApproval("plan-R", "g", [], "r");
    await new Promise((r) => setImmediate(r));
    // Approve plan-level.
    await runPost(server, "/api/agent/approve", {
      plan_id: "plan-R",
      decision: "approve",
      operator: "pranav",
    });
    await planPromise;

    // Now a per-step gate appears.
    const stepReq: ApprovalRequest = {
      id: "req-stepR",
      action: "delete_snapshot",
      tier: "destructive",
      params: {},
      reasoning: "delete",
      plan_id: "plan-R",
      step_id: "s3",
      timestamp: new Date().toISOString(),
    };
    const stepPromise = gate.requestApproval(stepReq);
    await new Promise((r) => setImmediate(r));

    // Approve step gate via dashboard API with explicit step_id.
    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-R",
      step_id: "s3",
      decision: "approve",
      operator: "pranav",
    });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getJsonBody();
    expect(body.plan_id).toBe("plan-R");
    expect(body.step_id).toBe("s3");
    expect(body.status).toBe("approved");

    const resp = await stepPromise;
    expect(resp.approved).toBe(true);
  });

  it("POST /api/agent/approve without step_id does not resolve a per-step gate", async () => {
    const bus = new EventBus();
    const server = makeServer(bus);
    server.attachApprovalGate(gate);

    // ONLY a per-step gate (no plan-level approval first).
    const stepReq: ApprovalRequest = {
      id: "req-stepS",
      action: "delete_snapshot",
      tier: "destructive",
      params: {},
      reasoning: "delete",
      plan_id: "plan-S",
      step_id: "s7",
      timestamp: new Date().toISOString(),
    };
    const stepPromise = gate.requestApproval(stepReq);
    await new Promise((r) => setImmediate(r));

    // Try to approve as if it were plan-level. No matching gate — 404.
    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-S",
      decision: "approve",
      operator: "pranav",
    });
    expect(res.getStatusCode()).toBe(404);

    // The step gate is still pending.
    expect(gate.getPendingApprovals()).toHaveLength(1);

    // Resolve with the proper step_id.
    gate.submitApiDecision("plan-S", "approve", "pranav", "s7");
    await stepPromise;
  });
});

