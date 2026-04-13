// ============================================================
// vClaw — Dashboard Server
// HTTP + SSE server for the real-time agent dashboard
// ============================================================

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentCore } from "../../agent/core.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { EventBus } from "../../agent/events.js";
import type { AuditLog } from "../../governance/audit.js";
import { AgentEventType } from "../../types.js";
import type { AgentEvent, Goal } from "../../types.js";
import { randomUUID } from "node:crypto";
import { IncidentManager } from "../../healing/incidents.js";
import { getDataDir } from "../../config.js";
import { join } from "node:path";
import { getHTML } from "./template.js";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import type { HealingOrchestrator } from "../../healing/orchestrator.js";
import type { ChaosEngine } from "../../chaos/engine.js";
import type { MigrationAdapter } from "../../migration/adapter.js";
import type { MigrationPlan } from "../../migration/types.js";
import { linearRegression, predictTimeToThreshold } from "../../monitoring/anomaly.js";
import type { DataPoint as AnomalyDataPoint } from "../../monitoring/anomaly.js";
import { metricStore } from "../../monitoring/metric-store.js";
import type { RunTelemetryCollector } from "../../monitoring/run-telemetry.js";

// ── SSE Client Tracking ────────────────────────────────────

interface SSEClient {
  id: number;
  res: ServerResponse;
  connectedAt: number;
}

// ── Dashboard Server ───────────────────────────────────────

export class DashboardServer {
  private server: Server | null = null;
  private clients: Map<number, SSEClient> = new Map();
  private clientIdCounter = 0;
  private eventListener: ((event: AgentEvent) => void) | null = null;
  private incidentManager: IncidentManager;
  healer?: HealingOrchestrator;
  chaosEngine?: ChaosEngine;
  migrationAdapter?: MigrationAdapter;
  private migrationHistory: MigrationPlan[] = [];

  constructor(
    private readonly port: number,
    private readonly agentCore: AgentCore,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventBus: EventBus,
    private readonly audit: AuditLog,
    private readonly runTelemetry?: RunTelemetryCollector,
  ) {
    // Create a read-only IncidentManager that loads persisted incidents from disk
    this.incidentManager = new IncidentManager(eventBus, join(getDataDir(), "healing"));
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

      this.server.listen(this.port, () => {
        console.log(`[DashboardServer] Listening on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    // Unsubscribe from EventBus
    if (this.eventListener) {
      this.eventBus.off("*", this.eventListener);
      this.eventListener = null;
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

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
        case "/api/cluster":
          this.handleCluster(res);
          break;
        case "/api/cluster/all":
          this.handleMultiCluster(res);
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
        default:
          // Dynamic route: /api/incidents/:id/timeline
          if (path.startsWith("/api/incidents/") && path.endsWith("/timeline")) {
            const incidentId = path.replace("/api/incidents/", "").replace("/timeline", "");
            this.handleIncidentTimeline(res, incidentId);
          } else if (this.useReact && path.startsWith("/assets/")) {
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

  private reactDistDir = join(import.meta.dirname || __dirname, "../../../dashboard/dist");
  private useReact = existsSync(join(this.reactDistDir, "index.html"));

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
    const MIME: Record<string, string> = {
      ".js": "application/javascript",
      ".css": "text/css",
      ".html": "text/html",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".json": "application/json",
    };
    const ext = extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    try {
      const fullPath = join(this.reactDistDir, filePath);
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

    this.json(res, {
      mode,
      current_plan: lastPlanEvent?.data ?? null,
      current_step: lastStepEvent?.data ?? null,
      event_count: history.length,
      connected_clients: this.clients.size,
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
      const provider = url.searchParams.get("provider") as "vmware" | "proxmox";
      if (!provider || !["vmware", "proxmox"].includes(provider)) {
        this.json(res, { error: "Invalid provider (vmware or proxmox)" }, 400);
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
      const direction = body.direction as string;
      const vmId = body.vm_id;

      if (!direction || !vmId) {
        this.json(res, { error: "Missing direction or vm_id" }, 400);
        return;
      }

      const toolName = direction === "vmware_to_proxmox"
        ? "plan_migration_vmware_to_proxmox"
        : "plan_migration_proxmox_to_vmware";

      const result = await this.migrationAdapter.execute(toolName, { vm_id: vmId });
      if (!result.success) {
        this.json(res, { error: result.error }, 400);
        return;
      }

      const plan = result.data as MigrationPlan;
      this.json(res, { ...plan, direction });
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
      const direction = body.direction as string;
      const vmId = body.vm_id;

      if (!direction || !vmId) {
        this.json(res, { error: "Missing direction or vm_id" }, 400);
        return;
      }

      const toolName = direction === "vmware_to_proxmox"
        ? "migrate_vmware_to_proxmox"
        : "migrate_proxmox_to_vmware";

      // Emit migration_started event
      this.broadcast({
        type: AgentEventType.MigrationStarted,
        timestamp: new Date().toISOString(),
        data: { direction, vm_id: vmId },
      });

      const result = await this.migrationAdapter.execute(toolName, { vm_id: vmId });

      if (!result.success) {
        this.broadcast({
          type: AgentEventType.MigrationFailed,
          timestamp: new Date().toISOString(),
          data: { direction, vm_id: vmId, error: result.error },
        });
        this.json(res, { error: result.error }, 400);
        return;
      }

      const plan = result.data as MigrationPlan;
      this.migrationHistory.unshift(plan);
      if (this.migrationHistory.length > 50) this.migrationHistory.pop();

      this.broadcast({
        type: AgentEventType.MigrationCompleted,
        timestamp: new Date().toISOString(),
        data: { direction, vm_id: vmId, status: plan.status },
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
