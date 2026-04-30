import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as ReactRuntime from "../../dashboard-v2/node_modules/react/index.js";

const hookHarness = vi.hoisted(() => {
  const store = {
    setConnected: vi.fn(),
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

  const useStoreMock = vi.fn(() => store) as unknown as {
    (): typeof store;
    getState: () => typeof store;
    mockClear: () => void;
  };
  useStoreMock.getState = vi.fn(() => store);

  const cleanups: Array<() => void> = [];

  return { store, useStoreMock, cleanups };
});

vi.mock("../../dashboard-v2/src/store", () => ({
  useStore: hookHarness.useStoreMock,
}));

type ReactInternals = {
  H: null | {
    useRef: <T>(initialValue: T) => { current: T };
    useEffect: (effect: () => void | (() => void)) => void;
  };
};

class MockEventSource {
  static instances: MockEventSource[] = [];

  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;

  public closed = false;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emitMessage(data: string) {
    this.onmessage?.({ data });
  }

  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

function resetHarness() {
  for (const value of Object.values(hookHarness.store)) {
    if (typeof value === "function" && "mockReset" in value) {
      (value as { mockReset: () => void }).mockReset();
    }
  }
  hookHarness.useStoreMock.mockClear();
  (hookHarness.useStoreMock.getState as unknown as { mockClear: () => void }).mockClear();
  hookHarness.cleanups.length = 0;
  MockEventSource.instances = [];
}

describe("useSSE hook", () => {
  let previousDispatcher: ReactInternals["H"];

  beforeEach(() => {
    vi.resetModules();
    resetHarness();
    vi.useFakeTimers();
    (globalThis as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;

    const internals = (ReactRuntime as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactInternals;
    }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    previousDispatcher = internals.H;
    internals.H = {
      useRef: <T>(initialValue: T) => ({ current: initialValue }),
      useEffect: (effect) => {
        const cleanup = effect();
        if (typeof cleanup === "function") hookHarness.cleanups.push(cleanup);
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    const internals = (ReactRuntime as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactInternals;
    }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    internals.H = previousDispatcher;
  });

  it("reconnects after SSE errors and continues processing events", async () => {
    const { useSSE } = await import("../../dashboard-v2/src/hooks/useSSE");
    useSSE();

    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0];
    expect(first.url).toBe("/api/agent/events");

    first.onopen?.();
    expect(hookHarness.store.setConnected).toHaveBeenCalledWith(true);

    first.emitMessage("{malformed");
    expect(hookHarness.store.addEvent).not.toHaveBeenCalled();

    first.emitMessage(
      JSON.stringify({
        type: "step_started",
        timestamp: "2026-03-31T00:00:00.000Z",
        data: { step_id: "s1" },
      }),
    );
    first.emitMessage(
      JSON.stringify({
        type: "step_completed",
        timestamp: "2026-03-31T00:00:01.000Z",
        data: { step_id: "s1", duration_ms: 15, result: { ok: true } },
      }),
    );
    expect(hookHarness.store.updateStep).toHaveBeenNthCalledWith(1, "s1", { status: "running" });
    expect(hookHarness.store.updateStep).toHaveBeenNthCalledWith(2, "s1", {
      status: "success",
      duration_ms: 15,
      output: { ok: true },
    });

    first.onerror?.();
    expect(hookHarness.store.setConnected).toHaveBeenCalledWith(false);
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(3000);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1];
    second.emit(
      "health_check",
      JSON.stringify({
        resources: { cpu_usage_pct: 33, ram_usage_pct: 44, disk_usage_pct: 12 },
        nodes: { total: 1, online: 1 },
        vms: { total: 2, running: 2 },
        timestamp: "2026-03-31T00:00:02.000Z",
      }),
    );

    expect(hookHarness.store.addHealth).toHaveBeenCalledTimes(1);
    expect(hookHarness.store.addEvent).toHaveBeenCalledTimes(3);
  });

  it("closes the active EventSource on cleanup", async () => {
    const { useSSE } = await import("../../dashboard-v2/src/hooks/useSSE");
    useSSE();

    const first = MockEventSource.instances[0];
    first.onerror?.();
    vi.advanceTimersByTime(3000);

    const second = MockEventSource.instances[1];
    expect(second.closed).toBe(false);

    expect(hookHarness.cleanups).toHaveLength(1);
    hookHarness.cleanups[0]();

    expect(second.closed).toBe(true);
  });
});
