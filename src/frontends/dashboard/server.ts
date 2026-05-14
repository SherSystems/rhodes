// ============================================================
// RHODES — Dashboard Server
// HTTP + SSE server for the real-time agent dashboard
// ============================================================

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentCore } from "../../agent/core.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { EventBus } from "../../agent/events.js";
import type { AuditLog } from "../../governance/audit.js";
import type {
  ApprovalGate,
  PendingApprovalEntry,
} from "../../governance/approval.js";
import { AgentEventType } from "../../types.js";
import type { AgentEvent, Goal } from "../../types.js";
import { randomUUID } from "node:crypto";
import { IncidentManager } from "../../healing/incidents.js";
import { getDataDir } from "../../config.js";
import { join } from "node:path";
import { getHTML } from "./template.js";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { HealingOrchestrator } from "../../healing/orchestrator.js";
import type { ChaosEngine } from "../../chaos/engine.js";
import type { MigrationAdapter } from "../../migration/adapter.js";
import type { MigrationPlan } from "../../migration/types.js";
import type { TopologyStore } from "../../topology/store.js";
import { linearRegression, predictTimeToThreshold } from "../../monitoring/anomaly.js";
import type { DataPoint as AnomalyDataPoint } from "../../monitoring/anomaly.js";
import { metricStore } from "../../monitoring/metric-store.js";
import type { RunTelemetryCollector } from "../../monitoring/run-telemetry.js";
import { aggregateClusterSummary } from "../../providers/aggregator.js";
import {
  buildSummary as buildCostSummary,
  buildTimeseries as buildCostTimeseries,
  buildTopResources as buildCostTopResources,
} from "./cost-estimator.js";
import type { CostComparisonMode } from "./cost-estimator.js";

const STATIC_MIME: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
};

// ── SSE Client Tracking ────────────────────────────────────

interface SSEClient {
  id: number;
  res: ServerResponse;
  connectedAt: number;
}

// ── Migration Run Tracking ─────────────────────────────────

interface MigrationActiveRun {
  id: string;
  direction: string;
  vmId: unknown;
  startedAt: string;
  status: "pending" | "running";
  stage: string;
  progressPct: number;
}

// ── Dashboard Server ───────────────────────────────────────

export class DashboardServer {
  private server: Server | null = null;
  private clients: Map<number, SSEClient> = new Map();
  private clientIdCounter = 0;
  private eventListener: ((event: AgentEvent) => void) | null = null;
  // Read-only fallback used when no healer is wired (e.g. mcp/cli modes).
  // When `healer` is attached, `incidentManager` resolves to the healer's
  // live instance so /api/incidents reflects in-memory state, not a stale
  // copy of the on-disk file.
  private readonly fallbackIncidentManager: IncidentManager;
  private get incidentManager(): IncidentManager {
    return this.healer?.incidentManager ?? this.fallbackIncidentManager;
  }
  healer?: HealingOrchestrator;
  chaosEngine?: ChaosEngine;
  migrationAdapter?: MigrationAdapter;
  topologyStore?: TopologyStore;
  /** Approval gate. Set via attachApprovalGate() so the dashboard can
   *  surface pending approvals from POST /api/agent/approve. */
  private approvalGate: ApprovalGate | null = null;
  private unsubscribeApproval: (() => void) | null = null;
  private migrationHistory: MigrationPlan[] = [];
  // Active in-flight migrations keyed by run id (server-assigned). The frontend
  // may also pass a client-side `local-*` id which we map to the server id once
  // the underlying adapter returns a plan with its own id.
  private migrationActive: Map<string, MigrationActiveRun> = new Map();
  private readonly startedAt: number = Date.now();

  /**
   * Bind host for the HTTP listener. Defaults to loopback (127.0.0.1) so the
   * unauthenticated dashboard surface is not reachable from the LAN by default.
   * See docs/audits/security-2026-05-14.md (Finding D-1).
   */
  private readonly host: string;

  constructor(
    private readonly port: number,
    private readonly agentCore: AgentCore,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventBus: EventBus,
    private readonly audit: AuditLog,
    private readonly runTelemetry?: RunTelemetryCollector,
    host: string = "127.0.0.1",
  ) {
    this.host = host;
    // Read-only fallback that loads persisted incidents from disk, used only
    // when no healer is attached.
    this.fallbackIncidentManager = new IncidentManager(eventBus, join(getDataDir(), "healing"));
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      // Subscribe to all EventBus events and forward to SSE clients
      this.eventListener = (event: AgentEvent) => {
        this.broadcast(event);
      };
      this.eventBus.on("*", this.eventListener);

      this.server.on("error", (err) => {
        console.error("[DashboardServer] Server error:", err);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(
          `[DashboardServer] Listening on http://${this.host}:${this.port}` +
            (this.host === "0.0.0.0" || this.host === "::"
              ? " (WARNING: bound to all interfaces — dashboard has no authentication)"
              : ""),
        );
        resolve();
      });
    });
  }

  /**
   * Wire the dashboard into the governance ApprovalGate so that
   * approval gates blocking under systemd surface as `AwaitingApproval`
   * SSE events and resolve via POST /api/agent/approve.
   */
  attachApprovalGate(gate: ApprovalGate): void {
    if (this.unsubscribeApproval) this.unsubscribeApproval();
    this.approvalGate = gate;
    this.unsubscribeApproval = gate.onAwaitingApproval((entry) => {
      this.eventBus.emit({
        type: AgentEventType.AwaitingApproval,
        timestamp: entry.requested_at,
        data: entry as unknown as Record<string, unknown>,
      });
    });
  }

  stop(): void {
    // Unsubscribe from EventBus
    if (this.eventListener) {
      this.eventBus.off("*", this.eventListener);
      this.eventListener = null;
    }

    if (this.unsubscribeApproval) {
      this.unsubscribeApproval();
      this.unsubscribeApproval = null;
    }

    // Close all SSE connections
    for (const [id, client] of this.clients) {
      try {
        client.res.end();
      } catch {
        // Client may already be disconnected
      }
      this.clients.delete(id);
    }

    // Close the HTTP server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    console.log("[DashboardServer] Stopped.");
  }

  // ── Request Router ──────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const path = url.pathname;

    // CORS: previously sent `Access-Control-Allow-Origin: *` for every
    // method including POST/DELETE. Combined with the (still unauthenticated)
    // state-mutating endpoints below, that turned any visited webpage on
    // the same browser into a remote control for the dashboard. The fix is
    // narrow: GET reads can still be CORS-shared for tooling, but writes
    // must be same-origin (no ACAO header at all = browser blocks
    // cross-origin reads of the response and blocks pre-flighted methods).
    // See docs/audits/security-2026-05-14.md (Finding D-2).
    if (req.method === "GET" || req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      switch (path) {
        case "/":
          this.serveHTML(res);
          break;
        case "/healthz":
        case "/api/healthz":
          this.handleHealthz(res);
          break;
        case "/api/playbooks":
          this.handlePlaybooks(res);
          break;
        case "/api/cluster":
          this.handleCluster(res);
          break;
        case "/api/cluster/all":
          this.handleMultiCluster(res);
          break;
        case "/api/cluster/summary":
          this.handleClusterSummary(res);
          break;
        case "/api/agent/status":
          this.handleAgentStatus(res);
          break;
        case "/api/agent/events":
          this.handleSSE(req, res);
          break;
        case "/api/audit":
          this.handleAudit(res, url);
          break;
        case "/api/audit/stats":
          this.handleAuditStats(res);
          break;
        case "/api/audit/export":
          this.handleAuditExport(res, url);
          break;
        case "/api/incidents":
          this.handleIncidents(res);
          break;
        case "/api/health/predictions":
          this.handlePredictions(res);
          break;
        case "/api/chaos/simulate":
          if (req.method === "POST") {
            this.handleChaosSimulate(req, res);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          break;
        case "/api/chaos/execute":
          if (req.method === "POST") {
            this.handleChaosExecute(req, res);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          break;
        case "/api/chaos/status":
          this.handleChaosStatus(res);
          break;
        case "/api/chaos/cancel":
          this.handleChaosCancel(res);
          break;
        case "/api/chaos/history":
          this.handleChaosHistory(res);
          break;
        case "/api/chaos/scenarios":
          this.handleChaosScenarios(res);
          break;
        case "/api/health/rightsizing":
          this.handleRightsizing(res);
          break;
        case "/api/metrics/history":
          this.handleMetricsHistory(res, url);
          break;
        case "/api/telemetry/runs":
          this.handleRunTelemetry(res, url);
          break;
        case "/api/migration/vms":
          this.handleMigrationVMs(res, url);
          break;
        case "/api/migration/plan":
          if (req.method === "POST") {
            this.handleMigrationPlan(req, res);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          break;
        case "/api/migration/execute":
          if (req.method === "POST") {
            this.handleMigrationExecute(req, res);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          break;
        case "/api/migration/history":
          this.handleMigrationHistory(res);
          break;
        case "/api/agent/command":
          if (req.method === "POST") {
            this.handleAgentCommand(req, res);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          break;
        case "/api/agent/approve":
          if (req.method === "POST") {
            this.handleAgentApprove(req, res);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          break;
        case "/api/agent/pending-approvals":
          this.handlePendingApprovals(res);
          break;
        case "/api/costs/summary":
          this.handleCostSummary(res, url);
          break;
        case "/api/costs/timeseries":
          this.handleCostTimeseries(res, url);
          break;
        case "/api/costs/top-resources":
          this.handleCostTopResources(res, url);
          break;
        case "/api/topology/apps":
          if (req.method === "POST") {
            this.handleTopologyCreateApp(req, res);
          } else {
            this.handleTopologyListApps(res);
          }
          break;
        case "/api/topology/graph":
          this.handleTopologyGraph(res);
          break;
        default:
          // Dynamic topology routes: /api/topology/apps/:id, /api/topology/apps/:id/members, etc.
          if (path.startsWith("/api/topology/")) {
            this.handleTopologyDynamic(req, res, path);
          } else if (path.startsWith("/api/migration/status/")) {
            this.handleMigrationStatus(res, path);
          } else if (path.startsWith("/api/incidents/") && path.endsWith("/timeline")) {
            const incidentId = path.replace("/api/incidents/", "").replace("/timeline", "");
            this.handleIncidentTimeline(res, incidentId);
          } else if (this.isPathTraversalAttempt(path)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          } else if (path.startsWith("/brand/")) {
            this.serveBrandAsset(res, path);
          } else if (this.isReactStaticAssetPath(path)) {
            this.serveStaticFile(res, path);
          } else if (this.useReact && !path.startsWith("/api/")) {
            // SPA fallback — serve index.html for client-side routing
            this.serveHTML(res);
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          }
      }
    } catch (err) {
      console.error("[DashboardServer] Request error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  // ── Route Handlers ──────────────────────────────────────

  private reactDistDir = join(import.meta.dirname || __dirname, "../../../dashboard-v2/dist");
  private useReact = existsSync(join(this.reactDistDir, "index.html"));

  private isPathTraversalAttempt(requestPath: string): boolean {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestPath);
    } catch {
      return false;
    }
    return decodedPath.includes("\0") || decodedPath.includes("..");
  }

  private isReactStaticAssetPath(requestPath: string): boolean {
    if (!this.useReact || requestPath.startsWith("/api/")) return false;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestPath);
    } catch {
      return false;
    }

    if (decodedPath.includes("\0") || decodedPath.includes("..")) return false;

    const ext = extname(decodedPath).toLowerCase();
    if (!STATIC_MIME[ext]) return false;

    const fullPath = join(this.reactDistDir, decodedPath);
    return existsSync(fullPath);
  }

  private serveHTML(res: ServerResponse): void {
    if (this.useReact) {
      try {
        const html = readFileSync(join(this.reactDistDir, "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(html);
        return;
      } catch { /* fall through to template */ }
    }
    const html = getHTML();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  }

  private serveStaticFile(res: ServerResponse, filePath: string): void {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(filePath);
    } catch {
      res.writeHead(404); res.end("Not found");
      return;
    }

    if (decodedPath.includes("\0") || decodedPath.includes("..")) {
      res.writeHead(404); res.end("Not found");
      return;
    }

    const ext = extname(decodedPath).toLowerCase();
    const contentType = STATIC_MIME[ext];
    if (!contentType) {
      res.writeHead(404); res.end("Not found");
      return;
    }

    try {
      const fullPath = join(this.reactDistDir, decodedPath);
      if (!existsSync(fullPath)) {
        res.writeHead(404); res.end("Not found");
        return;
      }
      const data = readFileSync(fullPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      });
      res.end(data);
    } catch {
      res.writeHead(404); res.end("Not found");
    }
  }

  // ── Brand Assets ──────────────────────────────────────
  //
  // /brand/<file> serves RHODES brand assets (logos, marks, lockups).
  // Two-tier lookup so we ship small committable SVGs (the lockup wordmark,
  // the mark, the favicon) inside the repo, but reach for the higher-res
  // PNG lockups only when they're available on the host.
  //
  // 1. Repo-bundled SVGs live in `src/frontends/dashboard/assets/brand/`.
  //    Resolved relative to project root so it works whether the server
  //    is running via `tsx src/...` (dev) or `node dist/...` (prod) —
  //    dist and src sit at the same depth under the repo root.
  // 2. PNGs / hero lockups live in `RHODES_BRAND_DIR` (defaults to
  //    `/home/pranav/rhodes-brand`). These are gitignored because each
  //    PNG is ~1 MB.
  //
  // Path-traversal protection: each candidate is resolved to an absolute
  // path, then we verify it sits inside the canonical brand dir before
  // reading. `..` and `\0` requests are rejected up-front.
  private readonly bundledBrandDir = resolve(
    import.meta.dirname || __dirname,
    "../../../src/frontends/dashboard/assets/brand",
  );
  private readonly externalBrandDir = resolve(
    process.env.RHODES_BRAND_DIR || "/home/pranav/rhodes-brand",
  );

  private serveBrandAsset(res: ServerResponse, requestPath: string): void {
    let decoded: string;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (decoded.includes("\0") || decoded.includes("..")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Strip the `/brand/` prefix to get a relative file name like
    // `rhodes-lockup.png` or `rhodes-favicon.svg`.
    const fileName = decoded.replace(/^\/brand\//, "");
    if (!fileName || fileName.startsWith("/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const ext = extname(fileName).toLowerCase();
    const contentType = STATIC_MIME[ext];
    if (!contentType || !contentType.startsWith("image/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Tier 1: bundled SVG in src tree (small, committable).
    // Tier 2: external dir for PNGs (large, host-local).
    const candidates: Array<{ dir: string; full: string }> = [
      { dir: this.bundledBrandDir, full: resolve(this.bundledBrandDir, fileName) },
      { dir: this.externalBrandDir, full: resolve(this.externalBrandDir, fileName) },
    ];

    for (const c of candidates) {
      // Canonical containment check — reject any resolved path that escapes
      // the configured dir (defence in depth on top of the `..` filter).
      if (!c.full.startsWith(c.dir + "/") && c.full !== c.dir) {
        continue;
      }
      if (!existsSync(c.full)) continue;
      try {
        const data = readFileSync(c.full);
        res.writeHead(200, {
          "Content-Type": contentType,
          // Brand assets change rarely; cache aggressively but allow revalidation.
          "Cache-Control": "public, max-age=86400",
        });
        res.end(data);
        return;
      } catch {
        // Fall through to next candidate
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ── Health & Playbooks ─────────────────────────────────
  //
  // /healthz is intentionally cheap: no provider calls, no fan-out. It reads
  // process state (uptime, env), in-memory event counts, and registered
  // playbooks. Designed as a landing page for sysadmins / Tailscale checks.

  private getPackageVersion(): string {
    try {
      // src/frontends/dashboard/server.ts → package.json is three levels up.
      // After tsc, dist/frontends/dashboard/server.js is also three levels up.
      const pkgPath = join(import.meta.dirname || __dirname, "../../../package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private handleHealthz(res: ServerResponse): void {
    try {
      const dryRun = (process.env.RHODES_DRY_RUN ?? process.env.VCLAW_DRY_RUN ?? "")
        .toLowerCase() === "true";

      const history = this.eventBus.getHistory(200);
      const lastAlert = [...history]
        .reverse()
        .find(
          (e) =>
            e.type === AgentEventType.AlertFired ||
            e.type === AgentEventType.IncidentOpened ||
            e.type === AgentEventType.HealingEscalated,
        );

      const activePlans = [...history]
        .reverse()
        .filter(
          (e) =>
            e.type === AgentEventType.PlanCreated ||
            e.type === AgentEventType.Replan,
        )
        .slice(0, 5)
        .map((e) => ({
          id: (e.data?.id as string) ?? (e.data?.plan_id as string) ?? null,
          mode: (e.data?.mode as string | undefined) ?? null,
          created_at: e.timestamp,
        }));

      const openIncidents = (() => {
        try { return this.incidentManager.getOpen().length; } catch { return 0; }
      })();

      const playbooks = (() => {
        try {
          const engine = (this.healer as unknown as { playbookEngine?: { getAll?: () => unknown[] } })?.playbookEngine;
          return engine?.getAll ? engine.getAll().length : 0;
        } catch {
          return 0;
        }
      })();

      this.json(res, {
        ok: true,
        version: this.getPackageVersion(),
        uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
        process_uptime_s: Math.round(process.uptime()),
        dry_run: dryRun,
        shadow_mode: dryRun,
        providers_connected: 0, // Aggregated state requires async fan-out — keep healthz cheap.
        sse_clients: this.clients.size,
        open_incidents: openIncidents,
        registered_playbooks: playbooks,
        last_alert: lastAlert
          ? {
              type: lastAlert.type,
              timestamp: lastAlert.timestamp,
              summary:
                (lastAlert.data?.message as string) ??
                (lastAlert.data?.description as string) ??
                null,
            }
          : null,
        active_plans: activePlans,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[DashboardServer] healthz error:", err);
      this.json(res, { ok: false, error: "healthz failed" }, 500);
    }
  }

  private handlePlaybooks(res: ServerResponse): void {
    try {
      // Cross-cast: the orchestrator stores playbookEngine privately. We expose
      // it via a typed accessor here so the dashboard can render the registry
      // without leaking healer internals. When no healer is wired we return [].
      const engine = (this.healer as unknown as {
        playbookEngine?: {
          getAll?: () => Array<{
            id: string;
            name: string;
            description: string;
            requires_approval: boolean;
            cooldown_minutes: number;
            trigger: { metric: string; type: string; severity?: string };
          }>;
        };
      })?.playbookEngine;

      const playbooks = engine?.getAll?.() ?? [];

      // Last-triggered is best-effort: scan recent event history for a
      // playbook_matched event referencing each playbook.
      const history = this.eventBus.getHistory(500);
      const lastTriggered = new Map<string, string>();
      for (const evt of history) {
        const ids = (evt.data?.playbook_ids as string[] | undefined) ?? [];
        const singleId = evt.data?.playbook_id as string | undefined;
        const allIds = singleId ? [singleId, ...ids] : ids;
        for (const id of allIds) {
          if (!lastTriggered.has(id)) lastTriggered.set(id, evt.timestamp);
        }
      }

      const enriched = playbooks.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        trigger: p.trigger,
        requires_approval: p.requires_approval,
        cooldown_minutes: p.cooldown_minutes,
        enabled: true, // No disabled state today; field reserved for future toggles.
        last_triggered_at: lastTriggered.get(p.id) ?? null,
      }));

      this.json(res, { playbooks: enriched });
    } catch (err) {
      console.error("[DashboardServer] playbooks error:", err);
      this.json(res, { error: "Failed to fetch playbooks" }, 500);
    }
  }

  private async handleCluster(res: ServerResponse): Promise<void> {
    try {
      const state = await this.toolRegistry.getClusterState();
      this.json(res, state ?? { nodes: [], vms: [], containers: [], storage: [], timestamp: new Date().toISOString() });
    } catch (err) {
      this.json(res, { error: "Failed to fetch cluster state" }, 500);
    }
  }

  private async handleMultiCluster(res: ServerResponse): Promise<void> {
    try {
      const state = await this.toolRegistry.getMultiClusterState();
      this.json(res, state);
    } catch (err) {
      this.json(res, { error: "Failed to fetch multi-cluster state" }, 500);
    }
  }

  private async handleClusterSummary(res: ServerResponse): Promise<void> {
    try {
      const state = await this.toolRegistry.getMultiClusterState();
      const summary = aggregateClusterSummary(state);
      this.json(res, summary);
    } catch (err) {
      this.json(res, { error: "Failed to compute cluster summary" }, 500);
    }
  }

  // ── Cost endpoints ──────────────────────────────────────
  // Cost data is derived from current provider state via static
  // per-instance-type rate maps (see cost-rates.ts). These are
  // defensible ballpark estimates, not billing-grade numbers.

  private parseComparison(url: URL): CostComparisonMode {
    const raw = (url.searchParams.get("comparison") ?? "").toLowerCase();
    return raw === "hybrid" ? "hybrid" : "cloud";
  }

  private async handleCostSummary(res: ServerResponse, url: URL): Promise<void> {
    try {
      const comparison = this.parseComparison(url);
      const state = await this.toolRegistry.getMultiClusterState();
      const providers = buildCostSummary(state, comparison);
      this.json(res, { providers, comparison });
    } catch (err) {
      console.error("[DashboardServer] handleCostSummary error:", err);
      this.json(res, { error: "Failed to compute cost summary" }, 500);
    }
  }

  private async handleCostTimeseries(res: ServerResponse, url: URL): Promise<void> {
    try {
      const comparison = this.parseComparison(url);
      const state = await this.toolRegistry.getMultiClusterState();
      const points = buildCostTimeseries(state, comparison, 30);
      this.json(res, { points, comparison, window: "30d" });
    } catch (err) {
      console.error("[DashboardServer] handleCostTimeseries error:", err);
      this.json(res, { error: "Failed to compute cost timeseries" }, 500);
    }
  }

  private async handleCostTopResources(res: ServerResponse, url: URL): Promise<void> {
    try {
      const comparison = this.parseComparison(url);
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10;
      const state = await this.toolRegistry.getMultiClusterState();
      const resources = buildCostTopResources(state, comparison, limit);
      this.json(res, { resources, comparison, limit });
    } catch (err) {
      console.error("[DashboardServer] handleCostTopResources error:", err);
      this.json(res, { error: "Failed to compute cost top resources" }, 500);
    }
  }

  private handleAgentStatus(res: ServerResponse): void {
    // Gather current agent state from the event bus history
    const history = this.eventBus.getHistory(100);

    // Find the most recent plan
    const lastPlanEvent = [...history]
      .reverse()
      .find((e) => e.type === "plan_created" || e.type === "replan");

    // Find the most recent step event
    const lastStepEvent = [...history]
      .reverse()
      .find((e) =>
        e.type === "step_started" ||
        e.type === "step_completed" ||
        e.type === "step_failed",
      );

    // Determine current mode from the most recent plan
    const mode = lastPlanEvent?.data?.mode ?? "watch";

    // Shadow / dry-run flag is sourced from the same env var the executor
    // reads. Surfacing it on agent/status lets the dashboard render the
    // SHADOW MODE banner without a separate fetch.
    const dryRun = (process.env.RHODES_DRY_RUN ?? process.env.VCLAW_DRY_RUN ?? "")
      .toLowerCase() === "true";

    this.json(res, {
      mode,
      current_plan: lastPlanEvent?.data ?? null,
      current_step: lastStepEvent?.data ?? null,
      event_count: history.length,
      connected_clients: this.clients.size,
      dry_run: dryRun,
      shadow_mode: dryRun,
    });
  }

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    const clientId = ++this.clientIdCounter;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering if proxied
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

    // Send recent history so the client can catch up
    const recentEvents = this.eventBus.getHistory(50);
    for (const event of recentEvents) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    const client: SSEClient = { id: clientId, res, connectedAt: Date.now() };
    this.clients.set(clientId, client);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    // Clean up on disconnect
    req.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(clientId);
    });
  }

  private handleAudit(res: ServerResponse, url: URL): void {
    const filters: Record<string, unknown> = {};
    const action = url.searchParams.get("action");
    const tier = url.searchParams.get("tier");
    const result = url.searchParams.get("result");
    const since = url.searchParams.get("since");
    const limit = url.searchParams.get("limit");

    if (action) filters.action = action;
    if (tier) filters.tier = tier;
    if (result) filters.result = result;
    if (since) filters.since = since;
    if (limit) filters.limit = parseInt(limit, 10);

    try {
      const entries = this.audit.query(filters as any);
      this.json(res, entries);
    } catch (err) {
      this.json(res, { error: "Failed to query audit log" }, 500);
    }
  }

  private handleAuditStats(res: ServerResponse): void {
    try {
      const stats = this.audit.getStats();
      this.json(res, stats);
    } catch (err) {
      this.json(res, { error: "Failed to get audit stats" }, 500);
    }
  }

  private handleAuditExport(res: ServerResponse, url: URL): void {
    const formatRaw = (url.searchParams.get("format") ?? "json").toLowerCase();
    if (formatRaw !== "json" && formatRaw !== "csv") {
      this.json(res, { error: "Invalid format; expected json or csv" }, 400);
      return;
    }

    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;

    if (from && Number.isNaN(Date.parse(from))) {
      this.json(res, { error: "Invalid from timestamp (expected ISO8601)" }, 400);
      return;
    }

    if (to && Number.isNaN(Date.parse(to))) {
      this.json(res, { error: "Invalid to timestamp (expected ISO8601)" }, 400);
      return;
    }

    if (from && to && Date.parse(from) > Date.parse(to)) {
      this.json(res, { error: "from must be <= to" }, 400);
      return;
    }

    try {
      const payload = this.audit.exportEntries(formatRaw, { from, to });
      if (formatRaw === "csv") {
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(payload);
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    } catch (err) {
      this.json(res, { error: "Failed to export audit log" }, 500);
    }
  }

  private handleIncidents(res: ServerResponse): void {
    try {
      const open = this.incidentManager.getOpen();
      const recent = this.incidentManager.getRecent(20);
      const patterns = this.incidentManager.getPatterns();
      this.json(res, { open, recent, patterns });
    } catch (err) {
      this.json(res, { error: "Failed to fetch incidents" }, 500);
    }
  }

  private handleIncidentTimeline(res: ServerResponse, incidentId: string): void {
    try {
      const incident = this.incidentManager.getById(incidentId);
      if (!incident) {
        this.json(res, { error: "Incident not found" }, 404);
        return;
      }
      const timeline = this.incidentManager.getTimeline(incidentId);
      this.json(res, { incident, timeline });
    } catch (err) {
      this.json(res, { error: "Failed to fetch incident timeline" }, 500);
    }
  }

  private handlePredictions(res: ServerResponse): void {
    try {
      const store = this.healer?.getHealthMonitor().store;
      if (!store) {
        this.json(res, { predictions: [] });
        return;
      }

      const CRITICAL_THRESHOLD = 90;
      const targetMetrics = ["node_cpu_pct", "node_mem_pct", "node_disk_pct"];
      const predictions: unknown[] = [];

      for (const metric of targetMetrics) {
        const allLatest = store.getAllLatest(metric);
        for (const { value: currentValue, labels } of allLatest) {
          const rawPoints = store.query(metric, labels, 30);
          // Need at least 5 data points (~2.5 minutes) for meaningful regression
          if (rawPoints.length < 5) continue;

          // Convert health.ts DataPoints (numeric ts) to anomaly.ts DataPoints (string ts)
          const anomalyPoints: AnomalyDataPoint[] = rawPoints.map((p) => ({
            timestamp: new Date(p.timestamp).toISOString(),
            value: p.value,
            labels: p.labels,
          }));

          const { slope } = linearRegression(anomalyPoints);
          const slopePerHour = slope * 60; // slope is per minute from linearRegression
          const hoursToThreshold = predictTimeToThreshold(currentValue, slope, CRITICAL_THRESHOLD);

          const projected1h = Math.min(100, Math.max(0, currentValue + slopePerHour * 1));
          const projected6h = Math.min(100, Math.max(0, currentValue + slopePerHour * 6));
          const projected24h = Math.min(100, Math.max(0, currentValue + slopePerHour * 24));

          // Don't flag warnings when current usage is low — noise in regression
          let status: string;
          if (currentValue < 50 || hoursToThreshold === null || hoursToThreshold > 48) {
            status = "healthy";
          } else if (hoursToThreshold > 6) {
            status = "warning";
          } else {
            status = "critical";
          }

          predictions.push({
            metric,
            labels,
            current: Math.round(currentValue * 10) / 10,
            slope_per_hour: Math.round(slopePerHour * 100) / 100,
            projected_1h: Math.round(projected1h * 10) / 10,
            projected_6h: Math.round(projected6h * 10) / 10,
            projected_24h: Math.round(projected24h * 10) / 10,
            hours_to_critical: hoursToThreshold !== null ? Math.round(hoursToThreshold * 10) / 10 : null,
            status,
          });
        }
      }

      this.json(res, { predictions });
    } catch (err) {
      console.error("[DashboardServer] Predictions error:", err);
      this.json(res, { error: "Failed to generate predictions" }, 500);
    }
  }

  // ── Right-sizing Recommendations ────────────────────

  private async handleRightsizing(res: ServerResponse): Promise<void> {
    try {
      const store = this.healer?.getHealthMonitor().store;
      if (!store) {
        this.json(res, { recommendations: [], message: "Metric store not available" });
        return;
      }

      const state = await this.toolRegistry.getClusterState();
      if (!state) {
        this.json(res, { recommendations: [], message: "Cluster state unavailable" });
        return;
      }

      const recommendations: Array<{
        vmid: string | number;
        name: string;
        node: string;
        cpu_allocated: number;
        cpu_avg_pct: number;
        cpu_peak_pct: number;
        cpu_recommended: number;
        ram_allocated_mb: number;
        ram_avg_pct: number;
        ram_peak_pct: number;
        ram_recommended_mb: number;
        savings_pct: number;
      }> = [];

      const runningVMs = state.vms.filter((vm) => vm.status === "running");

      for (const vm of runningVMs) {
        const labels = { vmid: String(vm.id), node: vm.node, name: vm.name };

        const cpuPoints = store.query("vm_cpu_pct", labels, 60);
        const memPoints = store.query("vm_mem_pct", labels, 60);

        // Need at least some data to make recommendations
        if (cpuPoints.length < 2 && memPoints.length < 2) continue;

        const cpuValues = cpuPoints.map((p) => p.value);
        const memValues = memPoints.map((p) => p.value);

        const cpuAvg = cpuValues.length > 0
          ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length
          : 0;
        const cpuPeak = cpuValues.length > 0 ? Math.max(...cpuValues) : 0;
        const memAvg = memValues.length > 0
          ? memValues.reduce((a, b) => a + b, 0) / memValues.length
          : 0;
        const memPeak = memValues.length > 0 ? Math.max(...memValues) : 0;

        const isOverprovisionedCpu = cpuAvg < 20;
        const isOverprovisionedRam = memAvg < 30;

        if (!isOverprovisionedCpu && !isOverprovisionedRam) continue;

        // Recommend: use peak usage + 30% headroom, minimum 1 core / 256 MB
        const cpuRecommended = Math.max(
          1,
          Math.ceil(vm.cpu_cores * (cpuPeak / 100) * 1.3)
        );
        const ramRecommended = Math.max(
          256,
          Math.ceil((vm.ram_mb * (memPeak / 100) * 1.3) / 128) * 128 // round to 128MB
        );

        // Calculate savings as percentage of total allocated resources saved
        const cpuSaved = Math.max(0, vm.cpu_cores - cpuRecommended);
        const ramSaved = Math.max(0, vm.ram_mb - ramRecommended);
        const savingsPct =
          vm.cpu_cores + vm.ram_mb > 0
            ? ((cpuSaved / Math.max(1, vm.cpu_cores) + ramSaved / Math.max(1, vm.ram_mb)) / 2) * 100
            : 0;

        recommendations.push({
          vmid: vm.id,
          name: vm.name,
          node: vm.node,
          cpu_allocated: vm.cpu_cores,
          cpu_avg_pct: Math.round(cpuAvg * 10) / 10,
          cpu_peak_pct: Math.round(cpuPeak * 10) / 10,
          cpu_recommended: cpuRecommended,
          ram_allocated_mb: vm.ram_mb,
          ram_avg_pct: Math.round(memAvg * 10) / 10,
          ram_peak_pct: Math.round(memPeak * 10) / 10,
          ram_recommended_mb: ramRecommended,
          savings_pct: Math.round(savingsPct * 10) / 10,
        });
      }

      // Sort by savings potential (highest first)
      recommendations.sort((a, b) => b.savings_pct - a.savings_pct);

      this.json(res, { recommendations });
    } catch (err) {
      console.error("[DashboardServer] Rightsizing error:", err);
      this.json(res, { error: "Failed to generate rightsizing recommendations" }, 500);
    }
  }

  // ── Metric History Handler ──────────────────────────

  private handleMetricsHistory(res: ServerResponse, url: URL): void {
    try {
      const node = url.searchParams.get("node");
      const metric = url.searchParams.get("metric");
      const range = url.searchParams.get("range") ?? "1h";

      if (!node || !metric) {
        this.json(res, { error: "Missing required params: node, metric" }, 400);
        return;
      }

      const rangeMap: Record<string, number> = {
        "1h": 60 * 60 * 1000,
        "6h": 6 * 60 * 60 * 1000,
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
      };

      const timeRangeMs = rangeMap[range] ?? rangeMap["1h"];
      const rawPoints = metricStore.query(node, metric, timeRangeMs);

      // Downsample to ~100 points using averaging
      const MAX_POINTS = 100;
      let points = rawPoints;
      if (rawPoints.length > MAX_POINTS) {
        const bucketSize = Math.ceil(rawPoints.length / MAX_POINTS);
        points = [];
        for (let i = 0; i < rawPoints.length; i += bucketSize) {
          const bucket = rawPoints.slice(i, i + bucketSize);
          const avgTs = Math.round(
            bucket.reduce((s, p) => s + p.timestamp, 0) / bucket.length,
          );
          const avgVal =
            bucket.reduce((s, p) => s + p.value, 0) / bucket.length;
          points.push({ timestamp: avgTs, value: Math.round(avgVal * 100) / 100 });
        }
      }

      this.json(res, { points });
    } catch (err) {
      console.error("[DashboardServer] Metrics history error:", err);
      this.json(res, { error: "Failed to fetch metric history" }, 500);
    }
  }

  private handleRunTelemetry(res: ServerResponse, url: URL): void {
    try {
      if (!this.runTelemetry) {
        this.json(res, { error: "Run telemetry is not available" }, 503);
        return;
      }

      const daysParam = url.searchParams.get("days");
      const days = daysParam ? parseInt(daysParam, 10) : 7;
      if (!Number.isFinite(days) || days <= 0 || days > 90) {
        this.json(res, { error: "Invalid days parameter; expected integer 1-90" }, 400);
        return;
      }

      const summary = this.runTelemetry.getSummary(days);
      this.json(res, summary);
    } catch (err) {
      console.error("[DashboardServer] Run telemetry error:", err);
      this.json(res, { error: "Failed to fetch run telemetry" }, 500);
    }
  }

  // ── Chaos Engineering Handlers ──────────────────────

  private async parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve({}); }
      });
      req.on('error', reject);
    });
  }

  private async handleChaosSimulate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.chaosEngine) {
        this.json(res, { error: "Chaos engine not available" }, 503);
        return;
      }
      const body = await this.parseBody(req);
      const scenario = body.scenario as string;
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (!scenario) {
        this.json(res, { error: "Missing required field: scenario" }, 400);
        return;
      }
      const result = await this.chaosEngine.simulate(scenario, params);
      this.json(res, result);
    } catch (err) {
      console.error("[DashboardServer] Chaos simulate error:", err);
      this.json(res, { error: "Failed to simulate chaos scenario" }, 500);
    }
  }

  private async handleChaosExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.chaosEngine) {
        this.json(res, { error: "Chaos engine not available" }, 503);
        return;
      }
      const body = await this.parseBody(req);
      const scenario = body.scenario as string;
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (!scenario) {
        this.json(res, { error: "Missing required field: scenario" }, 400);
        return;
      }
      const result = await this.chaosEngine.execute(scenario, params);
      this.json(res, result);
    } catch (err) {
      console.error("[DashboardServer] Chaos execute error:", err);
      this.json(res, { error: "Failed to execute chaos scenario" }, 500);
    }
  }

  private handleChaosStatus(res: ServerResponse): void {
    try {
      if (!this.chaosEngine) {
        this.json(res, { error: "Chaos engine not available" }, 503);
        return;
      }
      const activeRun = this.chaosEngine.getActiveRun();
      this.json(res, activeRun ?? null);
    } catch (err) {
      console.error("[DashboardServer] Chaos status error:", err);
      this.json(res, { error: "Failed to get chaos status" }, 500);
    }
  }

  private handleChaosCancel(res: ServerResponse): void {
    try {
      if (!this.chaosEngine) {
        this.json(res, { error: "Chaos engine not available" }, 503);
        return;
      }
      const cancelled = this.chaosEngine.cancel();
      if (!cancelled) {
        this.json(res, { error: "No active chaos run to cancel" }, 404);
        return;
      }
      this.json(res, { ok: true, run_id: cancelled.id });
    } catch (err) {
      console.error("[DashboardServer] Chaos cancel error:", err);
      this.json(res, { error: "Failed to cancel chaos run" }, 500);
    }
  }

  private handleChaosHistory(res: ServerResponse): void {
    try {
      if (!this.chaosEngine) {
        this.json(res, { error: "Chaos engine not available" }, 503);
        return;
      }
      const history = this.chaosEngine.getHistory();
      this.json(res, history);
    } catch (err) {
      console.error("[DashboardServer] Chaos history error:", err);
      this.json(res, { error: "Failed to get chaos history" }, 500);
    }
  }

  private handleChaosScenarios(res: ServerResponse): void {
    try {
      if (!this.chaosEngine) {
        this.json(res, { error: "Chaos engine not available" }, 503);
        return;
      }
      const scenarios = this.chaosEngine.listScenarios();
      this.json(res, scenarios);
    } catch (err) {
      console.error("[DashboardServer] Chaos scenarios error:", err);
      this.json(res, { error: "Failed to get chaos scenarios" }, 500);
    }
  }

  // ── Migration ───────────────────────────────────────────

  private async handleMigrationVMs(res: ServerResponse, url: URL): Promise<void> {
    try {
      if (!this.migrationAdapter) {
        this.json(res, { error: "Migration not configured" }, 503);
        return;
      }
      const provider = url.searchParams.get("provider") as "vmware" | "proxmox" | "aws" | "azure";
      if (!provider || !["vmware", "proxmox", "aws", "azure"].includes(provider)) {
        this.json(res, { error: "Invalid provider (vmware, proxmox, aws, or azure)" }, 400);
        return;
      }

      // Get VMs from the cluster state of the appropriate provider
      const state = await this.toolRegistry.getMultiClusterState();
      const providerState = state.providers.find(
        (p) => p.type === provider
      );

      const vms = (providerState?.state?.vms || []).map((vm) => ({
        id: vm.id,
        name: vm.name,
        provider,
        status: vm.status,
        cpu: vm.cpu_cores || 0,
        memoryMiB: vm.ram_mb || 0,
        diskGB: vm.disk_gb || 0,
      }));

      this.json(res, { vms });
    } catch (err) {
      console.error("[DashboardServer] Migration VMs error:", err);
      this.json(res, { error: "Failed to fetch VMs" }, 500);
    }
  }

  private async handleMigrationPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.migrationAdapter) {
        this.json(res, { error: "Migration not configured" }, 503);
        return;
      }
      const body = await this.parseBody(req);
      const direction = this.normalizeMigrationDirection(body.direction);
      const vmId = body.vm_id;

      if (!direction || vmId === undefined || vmId === null || vmId === "") {
        this.json(res, { error: "Missing direction or vm_id" }, 400);
        return;
      }

      const planToolMap: Record<string, { tool: string; idParam: "vm_id" | "instance_id" }> = {
        vmware_to_proxmox: { tool: "plan_migration_vmware_to_proxmox", idParam: "vm_id" },
        proxmox_to_vmware: { tool: "plan_migration_proxmox_to_vmware", idParam: "vm_id" },
        vmware_to_aws: { tool: "plan_migration_vmware_to_aws", idParam: "vm_id" },
        aws_to_vmware: { tool: "plan_migration_aws_to_vmware", idParam: "instance_id" },
        proxmox_to_aws: { tool: "plan_migration_proxmox_to_aws", idParam: "vm_id" },
        aws_to_proxmox: { tool: "plan_migration_aws_to_proxmox", idParam: "instance_id" },
        vmware_to_azure: { tool: "plan_migration_vmware_to_azure", idParam: "vm_id" },
        azure_to_vmware: { tool: "plan_migration_azure_to_vmware", idParam: "vm_id" },
        proxmox_to_azure: { tool: "plan_migration_proxmox_to_azure", idParam: "vm_id" },
        azure_to_proxmox: { tool: "plan_migration_azure_to_proxmox", idParam: "vm_id" },
        aws_to_azure: { tool: "plan_migration_aws_to_azure", idParam: "instance_id" },
        azure_to_aws: { tool: "plan_migration_azure_to_aws", idParam: "vm_id" },
      };
      const mapping = planToolMap[direction];
      if (!mapping) {
        this.json(res, { error: `Unsupported migration direction: ${direction}` }, 400);
        return;
      }

      const result = await this.migrationAdapter.execute(mapping.tool, { [mapping.idParam]: vmId });
      if (!result.success) {
        this.json(res, { error: result.error }, 400);
        return;
      }

      const data = result.data as any;
      // AWS plan tools return { plan, analysis }, others return the plan directly
      const plan = data.plan || data;
      const analysis = data.analysis || null;
      const executability = this.getPlanExecutability(direction);
      this.json(res, { ...plan, direction, analysis, ...executability });
    } catch (err) {
      console.error("[DashboardServer] Migration plan error:", err);
      this.json(res, { error: "Failed to create migration plan" }, 500);
    }
  }

  private async handleMigrationExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.migrationAdapter) {
        this.json(res, { error: "Migration not configured" }, 503);
        return;
      }
      const body = await this.parseBody(req);
      const direction = this.normalizeMigrationDirection(body.direction);
      const vmId = body.vm_id;

      if (!direction || vmId === undefined || vmId === null || vmId === "") {
        this.json(res, { error: "Missing direction or vm_id" }, 400);
        return;
      }

      const execToolMap: Record<string, { tool: string; idParam: "vm_id" | "instance_id" }> = {
        vmware_to_proxmox: { tool: "migrate_vmware_to_proxmox", idParam: "vm_id" },
        proxmox_to_vmware: { tool: "migrate_proxmox_to_vmware", idParam: "vm_id" },
        vmware_to_aws: { tool: "migrate_vmware_to_aws", idParam: "vm_id" },
        aws_to_vmware: { tool: "migrate_aws_to_vmware", idParam: "instance_id" },
        proxmox_to_aws: { tool: "migrate_proxmox_to_aws", idParam: "vm_id" },
        aws_to_proxmox: { tool: "migrate_aws_to_proxmox", idParam: "instance_id" },
        vmware_to_azure: { tool: "migrate_vmware_to_azure", idParam: "vm_id" },
        azure_to_vmware: { tool: "migrate_azure_to_vmware", idParam: "vm_id" },
        proxmox_to_azure: { tool: "migrate_proxmox_to_azure", idParam: "vm_id" },
        azure_to_proxmox: { tool: "migrate_azure_to_proxmox", idParam: "vm_id" },
        aws_to_azure: { tool: "migrate_aws_to_azure", idParam: "instance_id" },
        azure_to_aws: { tool: "migrate_azure_to_aws", idParam: "vm_id" },
      };
      const mapping = execToolMap[direction];
      if (!mapping) {
        this.json(res, { error: `Unsupported migration direction: ${direction}` }, 400);
        return;
      }

      // Track active run so /api/migration/status/:id can report progress
      // even if the client refreshes mid-flight. The id is server-assigned and
      // the frontend learns it via the response body once execute resolves.
      const activeId = this.generateMigrationRunId();
      const startedAt = new Date().toISOString();
      this.migrationActive.set(activeId, {
        id: activeId,
        direction,
        vmId,
        startedAt,
        status: "running",
        stage: "starting",
        progressPct: 0,
      });

      // Emit migration_started event
      this.broadcast({
        type: AgentEventType.MigrationStarted,
        timestamp: new Date().toISOString(),
        data: { direction, vm_id: vmId, migration_id: activeId },
      });

      let result;
      try {
        result = await this.migrationAdapter.execute(mapping.tool, { [mapping.idParam]: vmId });
      } finally {
        this.migrationActive.delete(activeId);
      }

      if (!result.success) {
        // Persist a synthetic failed plan so /api/migration/status/:id can
        // report the failure after refresh.
        const failedPlan: MigrationPlan = {
          id: activeId,
          source: { provider: "vmware", vmId: String(vmId), vmName: "", host: "" },
          target: { provider: "proxmox", node: "", host: "", storage: "" },
          vmConfig: { name: "", cpuCount: 0, coresPerSocket: 0, memoryMiB: 0, guestOS: "", disks: [], nics: [], firmware: "bios" },
          status: "failed",
          steps: [],
          startedAt,
          completedAt: new Date().toISOString(),
          error: result.error,
        };
        this.migrationHistory.unshift(failedPlan);
        if (this.migrationHistory.length > 50) this.migrationHistory.pop();

        this.broadcast({
          type: AgentEventType.MigrationFailed,
          timestamp: new Date().toISOString(),
          data: { direction, vm_id: vmId, migration_id: activeId, error: result.error },
        });
        this.json(res, { error: result.error, migration_id: activeId }, 400);
        return;
      }

      const plan = result.data as MigrationPlan;
      // Some adapters return their own plan.id; if missing, stamp our active id.
      if (!plan.id) {
        plan.id = activeId;
      }
      this.migrationHistory.unshift(plan);
      if (this.migrationHistory.length > 50) this.migrationHistory.pop();

      this.broadcast({
        type: AgentEventType.MigrationCompleted,
        timestamp: new Date().toISOString(),
        data: { direction, vm_id: vmId, migration_id: plan.id, status: plan.status },
      });

      this.json(res, plan);
    } catch (err) {
      console.error("[DashboardServer] Migration execute error:", err);
      this.broadcast({
        type: AgentEventType.MigrationFailed,
        timestamp: new Date().toISOString(),
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      this.json(res, { error: "Migration failed" }, 500);
    }
  }

  private handleMigrationHistory(res: ServerResponse): void {
    this.json(res, { migrations: this.migrationHistory });
  }

  /**
   * GET /api/migration/status/:id — used by the dashboard to rehydrate
   * progress for an in-flight or recently-completed migration after a refresh.
   *
   * Lookup order:
   *   1. Active in-flight runs (server-assigned id)
   *   2. migrationHistory (terminal state)
   * Returns 404 JSON when neither matches.
   */
  private handleMigrationStatus(res: ServerResponse, path: string): void {
    const rawId = path.replace("/api/migration/status/", "");
    let migrationId: string;
    try {
      migrationId = decodeURIComponent(rawId);
    } catch {
      this.json(res, { error: "migration not found" }, 404);
      return;
    }

    if (!migrationId) {
      this.json(res, { error: "migration not found" }, 404);
      return;
    }

    const active = this.migrationActive.get(migrationId);
    if (active) {
      this.json(res, {
        migrationId: active.id,
        status: active.status,
        stage: active.stage,
        progressPct: active.progressPct,
        startedAt: active.startedAt,
        direction: active.direction,
        terminal: false,
      });
      return;
    }

    const plan = this.migrationHistory.find((p) => p.id === migrationId);
    if (plan) {
      const progressPct = plan.status === "completed" ? 100 : plan.status === "failed" ? 0 : 50;
      const lastStep = plan.steps[plan.steps.length - 1];
      this.json(res, {
        migrationId: plan.id,
        status: plan.status,
        stage: lastStep?.name ?? plan.status,
        progressPct,
        startedAt: plan.startedAt,
        completedAt: plan.completedAt,
        error: plan.error,
        terminal: plan.status === "completed" || plan.status === "failed",
        plan,
      });
      return;
    }

    this.json(res, { error: "migration not found" }, 404);
  }

  private generateMigrationRunId(): string {
    return `mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private normalizeMigrationDirection(direction: unknown): string {
    if (typeof direction !== "string") return "";
    return direction.trim().toLowerCase().replaceAll("-", "_");
  }

  private getPlanExecutability(_direction: string): { executable: boolean; executable_reason?: string } {
    return { executable: true };
  }

  // ── Topology Handlers ──────────────────────────────────

  private handleTopologyListApps(res: ServerResponse): void {
    if (!this.topologyStore) {
      this.json(res, { error: "Topology store not available" }, 503);
      return;
    }
    try {
      const apps = this.topologyStore.listApps();
      this.json(res, apps);
    } catch (err) {
      console.error("[DashboardServer] Topology list apps error:", err);
      this.json(res, { error: "Failed to list applications" }, 500);
    }
  }

  private async handleTopologyCreateApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.topologyStore) {
      this.json(res, { error: "Topology store not available" }, 503);
      return;
    }
    try {
      const body = await this.parseBody(req);
      const name = body.name as string;
      const tier = body.tier as string;
      if (!name || !tier) {
        this.json(res, { error: "Missing required fields: name, tier" }, 400);
        return;
      }
      const app = this.topologyStore.createApp(
        name,
        tier as any,
        body.owner as string | undefined,
        body.description as string | undefined,
        body.tags as string[] | undefined,
      );
      this.json(res, app, 201);
    } catch (err) {
      console.error("[DashboardServer] Topology create app error:", err);
      this.json(res, { error: "Failed to create application" }, 500);
    }
  }

  private handleTopologyGraph(res: ServerResponse): void {
    if (!this.topologyStore) {
      this.json(res, { error: "Topology store not available" }, 503);
      return;
    }
    try {
      const graph = this.topologyStore.getTopologyGraph();
      this.json(res, graph);
    } catch (err) {
      console.error("[DashboardServer] Topology graph error:", err);
      this.json(res, { error: "Failed to get topology graph" }, 500);
    }
  }

  private async handleTopologyDynamic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.topologyStore) {
      this.json(res, { error: "Topology store not available" }, 503);
      return;
    }

    try {
      // /api/topology/impact/:vmId
      if (path.startsWith("/api/topology/impact/")) {
        const workloadId = path.replace("/api/topology/impact/", "");
        const report = this.topologyStore.getImpactReport(workloadId);
        this.json(res, report);
        return;
      }

      // /api/topology/apps/:id/members/:workloadId (DELETE)
      const memberDeleteMatch = path.match(/^\/api\/topology\/apps\/([^/]+)\/members\/([^/]+)$/);
      if (memberDeleteMatch && req.method === "DELETE") {
        this.topologyStore.removeMember(memberDeleteMatch[1], memberDeleteMatch[2]);
        this.json(res, { ok: true });
        return;
      }

      // /api/topology/apps/:id/members (POST)
      const memberMatch = path.match(/^\/api\/topology\/apps\/([^/]+)\/members$/);
      if (memberMatch && req.method === "POST") {
        const body = await this.parseBody(req);
        const appId = memberMatch[1];
        const member = this.topologyStore.addMember(appId, {
          workloadId: body.workload_id as string,
          workloadType: body.workload_type as any,
          provider: body.provider as any,
          role: body.role as string,
          critical: (body.critical as boolean) ?? false,
          name: body.name as string | undefined,
          ipAddress: body.ip_address as string | undefined,
        });
        this.json(res, member, 201);
        return;
      }

      // /api/topology/apps/:id/dependencies (POST)
      const depMatch = path.match(/^\/api\/topology\/apps\/([^/]+)\/dependencies$/);
      if (depMatch && req.method === "POST") {
        const body = await this.parseBody(req);
        const appId = depMatch[1];
        const dep = this.topologyStore.addDependency(appId, {
          fromWorkloadId: body.from_workload as string,
          toWorkloadId: body.to_workload as string,
          port: body.port as number,
          service: body.service as string,
          protocol: (body.protocol as string) ?? "tcp",
          latencyRequirement: ((body.latency_requirement as string) ?? "any") as any,
          description: body.description as string | undefined,
        });
        this.json(res, dep, 201);
        return;
      }

      // /api/topology/apps/:id (GET or DELETE)
      const appMatch = path.match(/^\/api\/topology\/apps\/([^/]+)$/);
      if (appMatch) {
        const appId = appMatch[1];
        if (req.method === "DELETE") {
          this.topologyStore.deleteApp(appId);
          this.json(res, { ok: true });
          return;
        }
        // GET
        const app = this.topologyStore.getApp(appId);
        if (!app) {
          this.json(res, { error: "Application not found" }, 404);
          return;
        }
        this.json(res, app);
        return;
      }

      this.json(res, { error: "Not found" }, 404);
    } catch (err) {
      console.error("[DashboardServer] Topology dynamic error:", err);
      this.json(res, { error: "Topology operation failed" }, 500);
    }
  }

  // ── Agent Command (Cmd+K palette) ──────────────────────

  private async handleAgentCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req);
      const command = body.command as string;

      if (!command || typeof command !== "string" || !command.trim()) {
        this.json(res, { error: "Missing required field: command" }, 400);
        return;
      }

      const goal: Goal = {
        id: randomUUID(),
        mode: "build",
        description: command.trim(),
        raw_input: command.trim(),
        created_at: new Date().toISOString(),
      };

      const result = await this.agentCore.run(goal);
      this.json(res, result);
    } catch (err) {
      console.error("[DashboardServer] Agent command error:", err);
      this.json(res, { error: "Failed to execute agent command" }, 500);
    }
  }

  /**
   * GET /api/agent/pending-approvals — every plan currently blocked at
   * an approval gate, in the order returned by the ApprovalGate. The
   * dashboard polls this on mount to catch up after a refresh, and
   * thereafter relies on the AwaitingApproval SSE stream.
   */
  private handlePendingApprovals(res: ServerResponse): void {
    const pending = this.approvalGate?.getPendingApprovals() ?? [];
    this.json(
      res,
      pending.map((p) => ({
        plan_id: p.plan_id,
        request_id: p.request_id,
        action: p.action,
        tier: p.tier,
        params: p.params,
        reasoning: p.reasoning,
        requested_at: p.requested_at,
        scope: p.scope,
      })),
    );
  }

  /**
   * POST /api/agent/approve — operator decision for a blocking approval
   * gate. Body: { plan_id, decision: "approve"|"reject", operator }.
   * Returns the updated plan status. Idempotent — a second call with the
   * same decision returns the original record. A 404 is returned when the
   * plan_id is not currently pending and has no prior decision.
   */
  private async handleAgentApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.approvalGate) {
      this.json(res, { error: "Approval gate not attached" }, 503);
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.parseBody(req);
    } catch {
      this.json(res, { error: "Invalid request body" }, 400);
      return;
    }

    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    const decisionRaw = typeof body.decision === "string" ? body.decision.trim().toLowerCase() : "";
    const operator = typeof body.operator === "string" && body.operator.trim().length > 0
      ? body.operator.trim()
      : "api_operator";

    if (!planId) {
      this.json(res, { error: "Missing required field: plan_id" }, 400);
      return;
    }
    if (decisionRaw !== "approve" && decisionRaw !== "reject") {
      this.json(res, { error: "decision must be 'approve' or 'reject'" }, 400);
      return;
    }

    const outcome = this.approvalGate.submitApiDecision(
      planId,
      decisionRaw as "approve" | "reject",
      operator,
    );

    if (!outcome.ok) {
      this.json(res, { error: "Unknown plan_id" }, 404);
      return;
    }

    const status = outcome.record.decision === "approve" ? "approved" : "rejected";

    // Mirror the decision onto the SSE stream so all dashboards update.
    this.eventBus.emit({
      type: outcome.record.decision === "approve"
        ? AgentEventType.PlanApproved
        : AgentEventType.PlanRejected,
      timestamp: outcome.record.timestamp,
      data: {
        plan_id: outcome.record.plan_id,
        operator: outcome.record.operator,
        decision: outcome.record.decision,
        idempotent: !outcome.resolved,
        source: "api",
      },
    });

    this.json(res, {
      plan_id: outcome.record.plan_id,
      status,
      decision: outcome.record.decision,
      operator: outcome.record.operator,
      timestamp: outcome.record.timestamp,
      idempotent: !outcome.resolved,
    });
  }

  // ── SSE Broadcasting ────────────────────────────────────

  private broadcast(event: AgentEvent): void {
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const [id, client] of this.clients) {
      try {
        client.res.write(data);
      } catch {
        // Client disconnected — clean up
        this.clients.delete(id);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}
