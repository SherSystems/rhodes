// ============================================================
// RHODES — Notifier + EventBus bridge tests
// Verifies the bridge transforms events into alerts and pushes
// them through the configured provider (mocked fetch).
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { Notifier } from "../../src/notifications/notifier.js";
import { attachAlertBridge } from "../../src/notifications/event-bridge.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";

describe("Notifier facade", () => {
  it("'none' provider records last alert and never calls fetch", async () => {
    const fetchMock = vi.fn();
    const n = new Notifier({ provider: "none", fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await n.send({
      title: "test",
      body: "test body",
      kind: "event",
    });
    expect(result.delivered).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const status = n.getStatus();
    expect(status.provider).toBe("none");
    expect(status.lastAlert?.title).toBe("test");
  });

  it("falls back to 'none' if supra is selected without a URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const n = new Notifier({
      provider: "supra",
      supra: { url: "", userId: "rhodes-bot" },
    });
    expect(n.provider.id).toBe("none");
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to 'none' if telegram lacks credentials", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const n = new Notifier({
      provider: "telegram_direct",
      telegram: { botToken: "", chatId: "" },
    });
    expect(n.provider.id).toBe("none");
  });

  it("absorbs provider exceptions and reports them in the result", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const n = new Notifier({
      provider: "supra",
      supra: { url: "http://localhost:3100", userId: "rhodes-bot" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await n.send({ title: "x", body: "y", kind: "event" });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("network");
  });
});

describe("attachAlertBridge", () => {
  it("forwards plan_created events as plan-generated alerts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    });
    const notifier = new Notifier({
      provider: "supra",
      supra: { url: "http://localhost:3100", userId: "rhodes-bot" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const bus = new EventBus();
    attachAlertBridge(bus, { notifier, dashboardUrl: "https://rhodes.local:7411" });

    bus.emit({
      type: AgentEventType.PlanCreated,
      timestamp: new Date().toISOString(),
      data: { plan_id: "abc123", goal: "free up storage", step_count: 4, mode: "heal" },
    });

    // Bridge fires async; wait one tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.message).toContain("plan generated");
    expect(body.message).toContain("free up storage");
    expect(body.message).toContain("rhodes.local");
    expect(body.metadata.kind).toBe("plan_generated");
  });

  it("forwards approval_requested events with the dashboard URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    });
    const notifier = new Notifier({
      provider: "supra",
      supra: { url: "http://localhost:3100", userId: "rhodes-bot" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const bus = new EventBus();
    attachAlertBridge(bus, { notifier, dashboardUrl: "https://rhodes.local:7411" });

    bus.emit({
      type: AgentEventType.ApprovalRequested,
      timestamp: new Date().toISOString(),
      data: { plan_id: "abc123", action: "qm_delsnapshot", tier: "risky_write" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.message).toContain("approval needed");
    expect(body.message).toContain("rhodes.local");
    expect(body.message).toContain("qm_delsnapshot");
  });

  it("forwards step_failed events as execution_failed alerts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    });
    const notifier = new Notifier({
      provider: "supra",
      supra: { url: "http://localhost:3100", userId: "rhodes-bot" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const bus = new EventBus();
    attachAlertBridge(bus, { notifier });

    bus.emit({
      type: AgentEventType.StepFailed,
      timestamp: new Date().toISOString(),
      data: { action: "start_vm", error: "VM 100 not found", duration_ms: 42 },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.metadata.kind).toBe("execution_failed");
    expect(body.message).toContain("VM 100 not found");
  });

  it("does NOT fire alerts for unrelated event types", async () => {
    const fetchMock = vi.fn();
    const notifier = new Notifier({
      provider: "supra",
      supra: { url: "http://localhost:3100", userId: "rhodes-bot" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const bus = new EventBus();
    attachAlertBridge(bus, { notifier });

    bus.emit({
      type: AgentEventType.HealthCheck,
      timestamp: new Date().toISOString(),
      data: { ok: true },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("'none' provider keeps the autopilot offline-safe (no fetch ever)", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const notifier = new Notifier({ provider: "none", fetchImpl: fetchMock as unknown as typeof fetch });
    const bus = new EventBus();
    attachAlertBridge(bus, { notifier });

    bus.emit({
      type: AgentEventType.PlanCreated,
      timestamp: new Date().toISOString(),
      data: { plan_id: "x", goal: "y", step_count: 1 },
    });
    bus.emit({
      type: AgentEventType.ApprovalRequested,
      timestamp: new Date().toISOString(),
      data: { plan_id: "x", action: "y", tier: "risky_write" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
