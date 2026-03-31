import { afterEach, describe, expect, it, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import {
  PersistentRunTelemetryStore,
  RunTelemetryCollector,
} from "../../src/monitoring/run-telemetry.js";

function tmpDbPath(): string {
  return `/tmp/vclaw-test-run-telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("PersistentRunTelemetryStore", () => {
  let dbPath = "";
  let store: PersistentRunTelemetryStore | null = null;

  afterEach(() => {
    try {
      store?.close();
    } catch {
      /* ignore */
    }

    if (dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          /* ignore */
        }
      }
    }

    vi.useRealTimers();
  });

  it("computes 7-day latency/success SLO stats and envelope completeness", () => {
    dbPath = tmpDbPath();
    store = new PersistentRunTelemetryStore(dbPath);

    vi.useFakeTimers();
    const base = new Date("2026-03-31T00:00:00.000Z").getTime();

    vi.setSystemTime(base);
    store.startRun({ runId: "run-1" });
    store.completeRun({ runId: "run-1", success: true, durationMs: 1000, approvalWaitMs: 200, retryCount: 0 });

    vi.setSystemTime(base + 1000);
    store.startRun({ runId: "run-2" });
    store.completeRun({ runId: "run-2", success: true, durationMs: 2000, approvalWaitMs: 300, retryCount: 1, escalated: true });

    vi.setSystemTime(base + 2000);
    store.startRun({ runId: "run-3" });
    store.completeRun({ runId: "run-3", success: false, durationMs: 4000, approvalWaitMs: 0, retryCount: 2 });

    vi.setSystemTime(base + 3000);
    store.startRun({ runId: "run-4" }); // incomplete envelope

    const summary = store.getSummary(7);

    expect(summary.totals.runs_started).toBe(4);
    expect(summary.totals.runs_completed).toBe(3);
    expect(summary.totals.successful_runs).toBe(2);
    expect(summary.totals.failed_runs).toBe(1);
    expect(summary.totals.success_rate_pct).toBeCloseTo(66.67, 2);
    expect(summary.totals.envelope_completeness_pct).toBe(75);

    expect(summary.latency.p50_ms).toBe(2000);
    expect(summary.latency.p95_ms).toBe(3800);
    expect(summary.latency.avg_ms).toBe(Math.round((1000 + 2000 + 4000) / 3));

    expect(summary.approval.total_wait_ms).toBe(500);
    expect(summary.retries.total).toBe(3);
    expect(summary.escalations.total).toBe(1);
    expect(summary.slo.success_rate_breached).toBe(true);
  });
});

describe("RunTelemetryCollector", () => {
  let dbPath = "";
  let collector: RunTelemetryCollector | null = null;

  afterEach(() => {
    try {
      collector?.close();
    } catch {
      /* ignore */
    }

    if (dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("records run lifecycle, retries, approvals, and escalation from event stream", () => {
    dbPath = tmpDbPath();
    const bus = new EventBus();
    collector = new RunTelemetryCollector(bus, dbPath);

    const ts = new Date("2026-03-31T12:00:00.000Z").toISOString();

    bus.emit({
      type: AgentEventType.RunStarted,
      timestamp: ts,
      data: { run_id: "run-evt", goal_id: "goal-1", mode: "build" },
    });
    bus.emit({
      type: AgentEventType.ApprovalReceived,
      timestamp: ts,
      data: { run_id: "run-evt", wait_ms: 1400, approved: true },
    });
    bus.emit({
      type: AgentEventType.Replan,
      timestamp: ts,
      data: { run_id: "run-evt" },
    });
    bus.emit({
      type: AgentEventType.RunEscalated,
      timestamp: ts,
      data: { run_id: "run-evt", reason: "replan_triggered" },
    });
    bus.emit({
      type: AgentEventType.RunCompleted,
      timestamp: ts,
      data: {
        run_id: "run-evt",
        success: true,
        duration_ms: 5100,
        retry_count: 1,
        approval_wait_ms: 1400,
        escalated: true,
      },
    });

    const summary = collector.getSummary(7);

    expect(summary.totals.runs_started).toBe(1);
    expect(summary.totals.runs_completed).toBe(1);
    expect(summary.totals.success_rate_pct).toBe(100);
    expect(summary.latency.p95_ms).toBe(5100);
    expect(summary.approval.total_wait_ms).toBe(1400);
    expect(summary.retries.total).toBe(1);
    expect(summary.escalations.total).toBe(1);
  });
});
