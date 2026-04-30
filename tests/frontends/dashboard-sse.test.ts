import { describe, it, expect, vi } from "vitest";
import {
  safeParseSseData,
  parseAgentSseMessage,
  applySseEvent,
} from "../../dashboard-v2/src/hooks/useSSE";
import type { AgentEvent } from "../../dashboard-v2/src/types";

function makeStoreStub() {
  return {
    addEvent: vi.fn(),
    addHealth: vi.fn(),
    setPlan: vi.fn(),
    setMode: vi.fn(),
    incrementReplans: vi.fn(),
    updateStep: vi.fn(),
    incrementActions: vi.fn(),
    incrementCompleted: vi.fn(),
    addToast: vi.fn(),
    incrementFailed: vi.fn(),
    incrementFailures: vi.fn(),
    addActiveIncident: vi.fn(),
    updateIncident: vi.fn(),
    resolveIncident: vi.fn(),
    removeHealingBanner: vi.fn(),
    addHealingBanner: vi.fn(),
  };
}

function makeEvent(type: string, data: Record<string, unknown>): AgentEvent {
  return {
    type,
    timestamp: "2026-03-31T00:00:00.000Z",
    data,
  };
}

describe("Dashboard SSE handling", () => {
  it("returns null for malformed JSON SSE payloads", () => {
    expect(safeParseSseData("{bad-json")).toBeNull();
    expect(parseAgentSseMessage("{still-bad")).toBeNull();
  });

  it("rejects malformed AgentEvent payload shapes", () => {
    expect(parseAgentSseMessage(JSON.stringify({ timestamp: "2026-03-31T00:00:00.000Z", data: {} }))).toBeNull();
    expect(parseAgentSseMessage(JSON.stringify({ type: "health_check", data: {} }))).toBeNull();
    expect(parseAgentSseMessage(JSON.stringify({ type: "health_check", timestamp: "2026-03-31T00:00:00.000Z", data: null }))).toBeNull();
    expect(parseAgentSseMessage(JSON.stringify({ type: "health_check", timestamp: "2026-03-31T00:00:00.000Z", data: "oops" }))).toBeNull();
  });

  it("parses valid SSE payloads into AgentEvent objects", () => {
    const raw = JSON.stringify({
      type: "health_check",
      timestamp: "2026-03-30T00:00:00.000Z",
      data: { total: 1, healthy: 1, degraded: 0, unhealthy: 0 },
    });

    const parsed = parseAgentSseMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("health_check");
    expect(parsed?.data).toEqual({
      total: 1,
      healthy: 1,
      degraded: 0,
      unhealthy: 0,
    });
  });

  it("applies health events without crashing and updates store", () => {
    const store = makeStoreStub();
    const event = parseAgentSseMessage(
      JSON.stringify({
        type: "health_check",
        timestamp: "2026-03-30T00:00:00.000Z",
        data: { total: 3, healthy: 2, degraded: 1, unhealthy: 0 },
      }),
    );

    expect(event).not.toBeNull();
    expect(() => applySseEvent(event!, store as any)).not.toThrow();
    expect(store.addEvent).toHaveBeenCalledTimes(1);
    expect(store.addHealth).toHaveBeenCalledWith({
      total: 3,
      healthy: 2,
      degraded: 1,
      unhealthy: 0,
    });
  });

  it("applies step lifecycle events in order", () => {
    const store = makeStoreStub();

    applySseEvent(makeEvent("step_started", { step_id: "s1" }), store as any);
    applySseEvent(makeEvent("step_completed", { step_id: "s1", duration_ms: 42, result: { ok: true } }), store as any);
    applySseEvent(makeEvent("step_failed", { step_id: "s2", duration_ms: 10, error: "boom" }), store as any);

    expect(store.updateStep).toHaveBeenNthCalledWith(1, "s1", { status: "running" });
    expect(store.updateStep).toHaveBeenNthCalledWith(2, "s1", {
      status: "success",
      duration_ms: 42,
      output: { ok: true },
    });
    expect(store.updateStep).toHaveBeenNthCalledWith(3, "s2", {
      status: "failed",
      duration_ms: 10,
      error: "boom",
    });
    expect(store.incrementActions).toHaveBeenCalledTimes(1);
    expect(store.incrementCompleted).toHaveBeenCalledTimes(1);
    expect(store.incrementFailed).toHaveBeenCalledTimes(1);
    expect(store.incrementFailures).toHaveBeenCalledTimes(1);
    expect(store.addToast).toHaveBeenCalledTimes(2);
  });

  it("applies plan and replan events while preserving valid defaults", () => {
    const store = makeStoreStub();
    const newPlan = { id: "p2", steps: [] };

    applySseEvent(makeEvent("plan_created", { id: "p1", steps: [], mode: "watch" }), store as any);
    applySseEvent(makeEvent("replan", { new_plan: newPlan }), store as any);

    expect(store.setPlan).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "p1" }));
    expect(store.setMode).toHaveBeenCalledWith("watch");
    expect(store.incrementReplans).toHaveBeenCalledTimes(1);
    expect(store.setPlan).toHaveBeenNthCalledWith(2, newPlan);
  });

  it("handles incident and healing event families", () => {
    const store = makeStoreStub();

    applySseEvent(makeEvent("incident_opened", { id: "inc-1", severity: "critical", description: "Disk full" }), store as any);
    applySseEvent(makeEvent("incident_action", { incident_id: "inc-1", actions_taken: [{ action: "cleanup", success: true }] }), store as any);
    applySseEvent(makeEvent("incident_resolved", { incident_id: "inc-1", resolved_at: "2026-03-31T00:00:01.000Z", duration_ms: 1000, resolution: "cleaned" }), store as any);
    applySseEvent(makeEvent("healing_paused", { incident_id: "inc-1", message: "paused" }), store as any);
    applySseEvent(makeEvent("healing_escalated", { incident_id: "inc-1", message: "escalated" }), store as any);
    applySseEvent(makeEvent("healing_completed", { incident_id: "inc-1", message: "done" }), store as any);
    applySseEvent(makeEvent("healing_failed", { incident_id: "inc-2", message: "failed" }), store as any);

    expect(store.addActiveIncident).toHaveBeenCalledTimes(1);
    expect(store.updateIncident).toHaveBeenCalledWith("inc-1", {
      actions_taken: [{ action: "cleanup", success: true }],
    });
    expect(store.resolveIncident).toHaveBeenCalledWith("inc-1", {
      status: "resolved",
      resolved_at: "2026-03-31T00:00:01.000Z",
      duration_ms: 1000,
      resolution: "cleaned",
    });
    expect(store.addHealingBanner).toHaveBeenCalledTimes(2);
    expect(store.removeHealingBanner).toHaveBeenCalledTimes(2);
  });

  it("records unknown events in stream without side effects", () => {
    const store = makeStoreStub();
    applySseEvent(makeEvent("nonexistent_event", { a: 1 }), store as any);

    expect(store.addEvent).toHaveBeenCalledTimes(1);
    expect(store.setPlan).not.toHaveBeenCalled();
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.addHealth).not.toHaveBeenCalled();
    expect(store.addToast).not.toHaveBeenCalled();
  });
});
