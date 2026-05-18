// ============================================================
// Dashboard orchestrator routes — create / list / get plans,
// approve (auto-creates run), get runs.
// ============================================================

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OrchestratorStore } from "../../src/orchestrator/index.js";
import { createOrchestratorRouter } from "../../src/frontends/dashboard/orchestrator-routes.js";

// ── HTTP mocks ────────────────────────────────────────────

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.emit("finish");
  }
  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  // Real Node http requests emit Buffer chunks on 'data'. Use Buffer
  // here so readJsonBody's Buffer.concat path works.
  const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
  const stream = payload ? Readable.from([payload]) : Readable.from([]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
  return req;
}

function mockRes(): MockResponse & ServerResponse {
  return new MockResponse() as MockResponse & ServerResponse;
}

function parseJson<T = unknown>(body: string): T {
  return JSON.parse(body) as T;
}

const FIXTURE_BODY = {
  clusterResourceId: "vsphere:vsphere_cluster:prod-east",
  targetVersion: "8.0u3",
  sourceVersion: "8.0u2",
  hostResourceIds: [
    "vsphere:vsphere_host:h1",
    "vsphere:vsphere_host:h2",
    "vsphere:vsphere_host:h3",
  ],
  evacuationMode: "live_migrate",
  createdBy: "pranav@shersystems.com",
};

// ── Tests ────────────────────────────────────────────────

describe("OrchestratorRouter.dispatch — path matching", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-routes-"));
    store = new OrchestratorStore(join(dir, "orch.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for paths outside /api/orchestrator/", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    const handled = await router.dispatch(
      mockReq("GET", "/api/tickets"),
      res,
      "/api/tickets",
    );
    expect(handled).toBe(false);
  });

  it("returns true with 404 for unknown sub-route inside /api/orchestrator/", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    const handled = await router.dispatch(
      mockReq("GET", "/api/orchestrator/garbage"),
      res,
      "/api/orchestrator/garbage",
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/orchestrator/plans", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-routes-"));
    store = new OrchestratorStore(join(dir, "orch.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a plan and returns 201 + the persisted record", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", "/api/orchestrator/plans", FIXTURE_BODY),
      res,
      "/api/orchestrator/plans",
    );
    expect(res.statusCode).toBe(201);
    const plan = parseJson<{ id: string; createdBy: string }>(res.body);
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.createdBy).toBe("pranav@shersystems.com");
    expect(store.getPlan(plan.id)).not.toBeNull();
  });

  it("returns 400 when required fields are missing", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    const { targetVersion: _t, ...incomplete } = FIXTURE_BODY;
    await router.dispatch(
      mockReq("POST", "/api/orchestrator/plans", incomplete),
      res,
      "/api/orchestrator/plans",
    );
    expect(res.statusCode).toBe(400);
    expect(parseJson<{ error: string }>(res.body).error).toContain(
      "targetVersion",
    );
  });

  it("returns 400 for invalid evacuationMode", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", "/api/orchestrator/plans", {
        ...FIXTURE_BODY,
        evacuationMode: "wat",
      }),
      res,
      "/api/orchestrator/plans",
    );
    expect(res.statusCode).toBe(400);
    expect(parseJson<{ error: string }>(res.body).error).toMatch(
      /evacuationMode/,
    );
  });

  it("returns 400 for empty hostResourceIds", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", "/api/orchestrator/plans", {
        ...FIXTURE_BODY,
        hostResourceIds: [],
      }),
      res,
      "/api/orchestrator/plans",
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    const req = Readable.from([
      Buffer.from("{ this is not json"),
    ]) as unknown as IncomingMessage;
    req.method = "POST";
    req.url = "/api/orchestrator/plans";
    req.headers = { "content-type": "application/json" };
    await router.dispatch(req, res, "/api/orchestrator/plans");
    expect(res.statusCode).toBe(400);
  });

  it("returns 405 for non-POST/GET on the collection endpoint", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("PUT", "/api/orchestrator/plans"),
      res,
      "/api/orchestrator/plans",
    );
    expect(res.statusCode).toBe(405);
  });
});

describe("GET /api/orchestrator/plans (list)", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-routes-"));
    store = new OrchestratorStore(join(dir, "orch.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array when no plans exist", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", "/api/orchestrator/plans"),
      res,
      "/api/orchestrator/plans",
    );
    expect(res.statusCode).toBe(200);
    expect(parseJson<unknown[]>(res.body)).toEqual([]);
  });

  it("filters by cluster query param", async () => {
    store.createPlan({
      ...FIXTURE_BODY,
      clusterResourceId: "vsphere:vsphere_cluster:a",
      evacuationMode: "live_migrate" as const,
    });
    store.createPlan({
      ...FIXTURE_BODY,
      clusterResourceId: "vsphere:vsphere_cluster:b",
      evacuationMode: "live_migrate" as const,
    });
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq(
        "GET",
        "/api/orchestrator/plans?cluster=vsphere:vsphere_cluster:a",
      ),
      res,
      "/api/orchestrator/plans",
    );
    const plans = parseJson<Array<{ clusterResourceId: string }>>(res.body);
    expect(plans).toHaveLength(1);
    expect(plans[0].clusterResourceId).toBe("vsphere:vsphere_cluster:a");
  });
});

describe("GET /api/orchestrator/plans/:id", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-routes-"));
    store = new OrchestratorStore(join(dir, "orch.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 200 with the plan", async () => {
    const created = store.createPlan({
      ...FIXTURE_BODY,
      evacuationMode: "live_migrate" as const,
    });
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", `/api/orchestrator/plans/${created.id}`),
      res,
      `/api/orchestrator/plans/${created.id}`,
    );
    expect(res.statusCode).toBe(200);
    expect(parseJson<{ id: string }>(res.body).id).toBe(created.id);
  });

  it("returns 404 for unknown plan id", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", "/api/orchestrator/plans/no-such-id"),
      res,
      "/api/orchestrator/plans/no-such-id",
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/orchestrator/plans/:id/approve", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-routes-"));
    store = new OrchestratorStore(join(dir, "orch.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("approves the plan + creates a run + invokes the onApproved hook", async () => {
    const created = store.createPlan({
      ...FIXTURE_BODY,
      evacuationMode: "live_migrate" as const,
    });
    let hookFired = false;
    let hookedPlanId: string | undefined;
    const router = createOrchestratorRouter({
      store,
      onApproved: (plan, _run) => {
        hookFired = true;
        hookedPlanId = plan.id;
      },
    });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", `/api/orchestrator/plans/${created.id}/approve`, {
        approvedBy: "pranav@shersystems.com",
      }),
      res,
      `/api/orchestrator/plans/${created.id}/approve`,
    );
    expect(res.statusCode).toBe(201);
    const body = parseJson<{
      plan: { approvedBy: string };
      run: { phase: string };
    }>(res.body);
    expect(body.plan.approvedBy).toBe("pranav@shersystems.com");
    expect(body.run.phase).toBe("pending");

    // Hook fires async — give it a tick.
    await new Promise((r) => setTimeout(r, 5));
    expect(hookFired).toBe(true);
    expect(hookedPlanId).toBe(created.id);
  });

  it("returns 400 when approvedBy is missing", async () => {
    const created = store.createPlan({
      ...FIXTURE_BODY,
      evacuationMode: "live_migrate" as const,
    });
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", `/api/orchestrator/plans/${created.id}/approve`, {}),
      res,
      `/api/orchestrator/plans/${created.id}/approve`,
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown plan id", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", "/api/orchestrator/plans/nope/approve", {
        approvedBy: "x",
      }),
      res,
      "/api/orchestrator/plans/nope/approve",
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when a plan is approved twice", async () => {
    const created = store.createPlan({
      ...FIXTURE_BODY,
      evacuationMode: "live_migrate" as const,
    });
    store.recordApproval(created.id, "first@example.com");

    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("POST", `/api/orchestrator/plans/${created.id}/approve`, {
        approvedBy: "second@example.com",
      }),
      res,
      `/api/orchestrator/plans/${created.id}/approve`,
    );
    expect(res.statusCode).toBe(409);
    expect(parseJson<{ error: string }>(res.body).error).toMatch(
      /already approved/,
    );
  });
});

describe("GET /api/orchestrator/runs/:id and plans/:id/runs", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-routes-"));
    store = new OrchestratorStore(join(dir, "orch.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/orchestrator/runs/:id returns the run", async () => {
    const plan = store.createPlan({
      ...FIXTURE_BODY,
      evacuationMode: "live_migrate" as const,
    });
    const run = store.createRun(plan.id);

    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", `/api/orchestrator/runs/${run.id}`),
      res,
      `/api/orchestrator/runs/${run.id}`,
    );
    expect(res.statusCode).toBe(200);
    expect(parseJson<{ id: string }>(res.body).id).toBe(run.id);
  });

  it("GET /api/orchestrator/runs/:id returns 404 for unknown", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", "/api/orchestrator/runs/nope"),
      res,
      "/api/orchestrator/runs/nope",
    );
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/orchestrator/plans/:id/runs lists the plan's runs", async () => {
    const plan = store.createPlan({
      ...FIXTURE_BODY,
      evacuationMode: "live_migrate" as const,
    });
    store.createRun(plan.id);
    store.createRun(plan.id);

    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", `/api/orchestrator/plans/${plan.id}/runs`),
      res,
      `/api/orchestrator/plans/${plan.id}/runs`,
    );
    expect(res.statusCode).toBe(200);
    expect(parseJson<unknown[]>(res.body)).toHaveLength(2);
  });

  it("GET /api/orchestrator/plans/:id/runs returns 404 for unknown plan", async () => {
    const router = createOrchestratorRouter({ store });
    const res = mockRes();
    await router.dispatch(
      mockReq("GET", "/api/orchestrator/plans/no/runs"),
      res,
      "/api/orchestrator/plans/no/runs",
    );
    expect(res.statusCode).toBe(404);
  });
});
