// ============================================================
// RHODES — /healthz HTTP endpoint
// Tiny standalone Node HTTP server (no framework) that surfaces
// liveness + a thin slice of operational state. Kept here next to
// the notifier because /healthz returns last-alert info.
// ============================================================

import { createServer, type Server } from "node:http";
import type { Notifier } from "./notifier.js";

export interface HealthzOptions {
  port: number;
  version: string;
  dryRun: boolean;
  providersConnected: () => string[];
  activePlans: () => number;
  notifier?: Notifier;
}

export class HealthzServer {
  private server: Server | null = null;
  private readonly startedAt: number;
  constructor(private readonly options: HealthzOptions) {
    this.startedAt = Date.now();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        // Only respond to GET /healthz; anything else is 404.
        if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/healthz") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }
        const status = this.snapshot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(status));
      });
      this.server.on("error", reject);
      this.server.listen(this.options.port, () => {
        console.log(`[healthz] Listening on :${this.options.port}/healthz`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }

  /** Build the JSON payload returned by GET /healthz. Exposed for tests. */
  snapshot(): Record<string, unknown> {
    let providersConnected: string[] = [];
    try {
      providersConnected = this.options.providersConnected();
    } catch {
      providersConnected = [];
    }
    let activePlans = 0;
    try {
      activePlans = this.options.activePlans();
    } catch {
      activePlans = 0;
    }
    return {
      status: "ok",
      version: this.options.version,
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      dryRun: this.options.dryRun,
      providers_connected: providersConnected,
      active_plans: activePlans,
      last_alert: this.options.notifier?.getStatus().lastAlert ?? null,
    };
  }
}
