// ============================================================
// RHODES — Orchestrator route handlers (v0.7.2.1)
//
// HTTP surface for the cluster upgrade orchestrator. Operators
// create UpgradePlans here, approve them, and read the resulting
// UpgradeRuns. The actual run-driving (calling primitives in
// sequence) is the runner's job — these endpoints just persist
// state through the OrchestratorStore.
//
// Routes:
//   POST   /api/orchestrator/plans                — create
//   GET    /api/orchestrator/plans                — list
//   GET    /api/orchestrator/plans/:id            — get one
//   POST   /api/orchestrator/plans/:id/approve    — approve + create run
//   GET    /api/orchestrator/plans/:id/runs       — list runs for plan
//   GET    /api/orchestrator/runs/:id             — get run by id
//
// Pattern mirrors tickets-routes.ts: a `dispatch(req, res, path)
// → Promise<boolean>` interface that returns true when handled,
// false to let the dashboard server fall through to 404.
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  OrchestratorStore,
  UpgradePlan,
  UpgradeRun,
} from "../../orchestrator/index.js";

export interface OrchestratorRouterCtx {
  store: OrchestratorStore;
  /**
   * Optional hook fired after an approval succeeds (and the
   * accompanying UpgradeRun is created). Use this in production to
   * kick the UpgradeRunner; tests can omit it.
   */
  onApproved?: (plan: UpgradePlan, run: UpgradeRun) => void | Promise<void>;
}

export interface OrchestratorRouter {
  dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean>;
}

export function createOrchestratorRouter(
  ctx: OrchestratorRouterCtx,
): OrchestratorRouter {
  return new OrchestratorRouterImpl(ctx);
}

class OrchestratorRouterImpl implements OrchestratorRouter {
  constructor(private readonly ctx: OrchestratorRouterCtx) {}

  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean> {
    if (!path.startsWith("/api/orchestrator/")) return false;

    // /api/orchestrator/runs/:id
    if (path.startsWith("/api/orchestrator/runs/")) {
      const runId = path.replace("/api/orchestrator/runs/", "");
      if (!runId || runId.includes("/")) return this.notFound(res);
      if (req.method !== "GET") return this.method405(res);
      this.handleGetRun(res, runId);
      return true;
    }

    // /api/orchestrator/plans  or  /api/orchestrator/plans/:id[/sub]
    if (path === "/api/orchestrator/plans") {
      if (req.method === "GET") {
        this.handleListPlans(res, req);
        return true;
      }
      if (req.method === "POST") {
        await this.handleCreatePlan(req, res);
        return true;
      }
      return this.method405(res);
    }

    if (path.startsWith("/api/orchestrator/plans/")) {
      const rest = path.replace("/api/orchestrator/plans/", "");
      const [planId, sub, ...extra] = rest.split("/");
      if (!planId || extra.length > 0) return this.notFound(res);

      if (!sub) {
        if (req.method !== "GET") return this.method405(res);
        this.handleGetPlan(res, planId);
        return true;
      }
      if (sub === "approve") {
        if (req.method !== "POST") return this.method405(res);
        await this.handleApprovePlan(req, res, planId);
        return true;
      }
      if (sub === "runs") {
        if (req.method !== "GET") return this.method405(res);
        this.handleListRunsForPlan(res, planId);
        return true;
      }
      return this.notFound(res);
    }

    // Anything else under /api/orchestrator/ that we don't recognize
    // is our problem to 404 — the URL is in our namespace.
    return this.notFound(res);
  }

  // ── POST /api/orchestrator/plans ──────────────────────────

  private async handleCreatePlan(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (!body) {
      return this.badRequest(res, "invalid JSON body");
    }

    const err = validateCreatePlanBody(body);
    if (err) return this.badRequest(res, err);

    const plan = this.ctx.store.createPlan({
      clusterResourceId: String(body.clusterResourceId),
      targetVersion: String(body.targetVersion),
      sourceVersion: String(body.sourceVersion),
      hostResourceIds: body.hostResourceIds as string[],
      evacuationMode: body.evacuationMode as
        | "live_migrate"
        | "evict"
        | "replace",
      createdBy: String(body.createdBy),
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(plan));
  }

  // ── GET /api/orchestrator/plans (list) ────────────────────

  private handleListPlans(res: ServerResponse, req: IncomingMessage): void {
    const url = new URL(req.url || "/", "http://localhost");
    const cluster = url.searchParams.get("cluster");
    const plans = cluster
      ? this.ctx.store.listPlansForCluster(cluster)
      : this.ctx.store.listAllPlans();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(plans));
  }

  // ── GET /api/orchestrator/plans/:id ──────────────────────

  private handleGetPlan(res: ServerResponse, planId: string): void {
    const plan = this.ctx.store.getPlan(planId);
    if (!plan) {
      this.notFound(res, "plan not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(plan));
  }

  // ── POST /api/orchestrator/plans/:id/approve ─────────────

  private async handleApprovePlan(
    req: IncomingMessage,
    res: ServerResponse,
    planId: string,
  ): Promise<void> {
    const plan = this.ctx.store.getPlan(planId);
    if (!plan) {
      this.notFound(res, "plan not found");
      return;
    }

    const body = await readJsonBody<{ approvedBy?: string }>(req);
    if (!body || !body.approvedBy || typeof body.approvedBy !== "string") {
      this.badRequest(res, "approvedBy (string) is required");
      return;
    }

    if (plan.approvedAt) {
      this.conflict(
        res,
        `plan ${planId} already approved at ${plan.approvedAt} by ${plan.approvedBy ?? "(unknown)"}`,
      );
      return;
    }

    const approvedPlan = this.ctx.store.recordApproval(planId, body.approvedBy);
    const run = this.ctx.store.createRun(approvedPlan.id);

    // Hook for the runner kickoff. Run async so the HTTP response
    // returns immediately even if the runner takes time to spin up.
    if (this.ctx.onApproved) {
      void Promise.resolve()
        .then(() => this.ctx.onApproved!(approvedPlan, run))
        .catch((err) => {
          console.error(
            "[orchestrator-routes] onApproved hook failed:",
            err,
          );
        });
    }

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ plan: approvedPlan, run }));
  }

  // ── GET /api/orchestrator/plans/:id/runs ─────────────────

  private handleListRunsForPlan(res: ServerResponse, planId: string): void {
    const plan = this.ctx.store.getPlan(planId);
    if (!plan) {
      this.notFound(res, "plan not found");
      return;
    }
    const runs = this.ctx.store.listRunsForPlan(planId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(runs));
  }

  // ── GET /api/orchestrator/runs/:id ───────────────────────

  private handleGetRun(res: ServerResponse, runId: string): void {
    const run = this.ctx.store.getRun(runId);
    if (!run) {
      this.notFound(res, "run not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(run));
  }

  // ── Response helpers ─────────────────────────────────────

  private badRequest(res: ServerResponse, message: string): void {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  private notFound(res: ServerResponse, message = "not found"): true {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return true;
  }

  private method405(res: ServerResponse): true {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return true;
  }

  private conflict(res: ServerResponse, message: string): void {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

// ── Validation ─────────────────────────────────────────────

const VALID_EVAC_MODES = new Set(["live_migrate", "evict", "replace"]);

function validateCreatePlanBody(body: Record<string, unknown>): string | null {
  const required = [
    "clusterResourceId",
    "targetVersion",
    "sourceVersion",
    "hostResourceIds",
    "evacuationMode",
    "createdBy",
  ];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null) {
      return `missing required field '${k}'`;
    }
  }
  if (typeof body.clusterResourceId !== "string" || !body.clusterResourceId) {
    return "clusterResourceId must be a non-empty string";
  }
  if (typeof body.targetVersion !== "string" || !body.targetVersion) {
    return "targetVersion must be a non-empty string";
  }
  if (typeof body.sourceVersion !== "string" || !body.sourceVersion) {
    return "sourceVersion must be a non-empty string";
  }
  if (
    !Array.isArray(body.hostResourceIds) ||
    body.hostResourceIds.length === 0 ||
    !(body.hostResourceIds as unknown[]).every(
      (h) => typeof h === "string" && h.length > 0,
    )
  ) {
    return "hostResourceIds must be a non-empty array of strings";
  }
  if (
    typeof body.evacuationMode !== "string" ||
    !VALID_EVAC_MODES.has(body.evacuationMode)
  ) {
    return `evacuationMode must be one of: live_migrate, evict, replace`;
  }
  if (typeof body.createdBy !== "string" || !body.createdBy) {
    return "createdBy must be a non-empty string";
  }
  return null;
}

// ── Body parser ────────────────────────────────────────────

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX = 1024 * 1024; // 1MB cap
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(null);
        resolve(JSON.parse(raw) as T);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
