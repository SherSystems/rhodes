// ============================================================
// RHODES — /healthz endpoint tests
// Verifies the standalone health server returns the expected
// shape and surfaces dryRun + last-alert info.
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HealthzServer } from "../../src/notifications/healthz.js";
import { Notifier } from "../../src/notifications/notifier.js";

describe("HealthzServer.snapshot", () => {
  it("returns the documented shape", () => {
    const fetchMock = vi.fn();
    const notifier = new Notifier({
      provider: "none",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const h = new HealthzServer({
      port: 0,
      version: "0.3.0",
      dryRun: true,
      providersConnected: () => ["proxmox", "azure"],
      activePlans: () => 0,
      notifier,
    });

    const snap = h.snapshot();
    expect(snap).toMatchObject({
      status: "ok",
      version: "0.3.0",
      dryRun: true,
      providers_connected: ["proxmox", "azure"],
      active_plans: 0,
      last_alert: null,
    });
    expect(typeof snap.uptime_seconds).toBe("number");
  });

  it("reflects last_alert after a notifier send", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const notifier = new Notifier({ provider: "none" });
    await notifier.send({ title: "RHODES boom", body: "x", kind: "execution_failed" });
    const h = new HealthzServer({
      port: 0,
      version: "0.3.0",
      dryRun: false,
      providersConnected: () => [],
      activePlans: () => 0,
      notifier,
    });
    const snap = h.snapshot();
    const last = snap.last_alert as { title: string; kind: string; delivered: boolean } | null;
    expect(last).not.toBeNull();
    expect(last!.title).toBe("RHODES boom");
    expect(last!.kind).toBe("execution_failed");
    expect(last!.delivered).toBe(true);
  });

  it("survives a throwing providersConnected() callback", () => {
    const h = new HealthzServer({
      port: 0,
      version: "0.3.0",
      dryRun: false,
      providersConnected: () => {
        throw new Error("boom");
      },
      activePlans: () => 0,
    });
    expect(() => h.snapshot()).not.toThrow();
    expect(h.snapshot().providers_connected).toEqual([]);
  });
});

describe("HealthzServer HTTP", () => {
  let h: HealthzServer;
  const PORT = 17411; // unlikely to clash; off the documented default.

  beforeEach(async () => {
    h = new HealthzServer({
      port: PORT,
      version: "0.3.0",
      dryRun: true,
      providersConnected: () => ["proxmox"],
      activePlans: () => 0,
    });
    await h.start();
  });

  afterEach(async () => {
    await h.stop();
  });

  it("serves GET /healthz with the expected payload", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.3.0");
    expect(body.dryRun).toBe(true);
    expect(body.providers_connected).toEqual(["proxmox"]);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(res.status).toBe(404);
  });
});
