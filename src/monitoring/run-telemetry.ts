import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { getDataDir } from "../config.js";
import type { AgentEvent } from "../types.js";
import { AgentEventType } from "../types.js";
import type { EventBus } from "../agent/events.js";

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_P95_SLO_MS = 60_000;
const DEFAULT_SUCCESS_RATE_SLO_PCT = 95;

const RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

interface RunTelemetryRow {
  duration_ms: number;
  success: number;
  approval_wait_ms: number;
  retry_count: number;
  escalated: number;
}

interface RunCountsRow {
  runs_started: number;
  complete_envelopes: number;
}

export interface RunTelemetrySummary {
  window: {
    from: string;
    to: string;
    days: number;
  };
  totals: {
    runs_started: number;
    runs_completed: number;
    successful_runs: number;
    failed_runs: number;
    success_rate_pct: number;
    complete_envelopes: number;
    envelope_completeness_pct: number;
  };
  latency: {
    p50_ms: number | null;
    p95_ms: number | null;
    avg_ms: number | null;
  };
  approval: {
    total_wait_ms: number;
    avg_wait_ms: number;
  };
  retries: {
    total: number;
    avg_per_run: number;
  };
  escalations: {
    total: number;
    rate_pct: number;
  };
  slo: {
    targets: {
      p95_latency_ms: number;
      success_rate_pct: number;
    };
    breached: boolean;
    latency_p95_breached: boolean;
    success_rate_breached: boolean;
  };
}

export interface RunStartPayload {
  runId: string;
  goalId?: string;
  mode?: string;
  startedAtMs?: number;
}

export interface RunCompletePayload {
  runId: string;
  success: boolean;
  durationMs: number;
  errorCount?: number;
  approvalWaitMs?: number;
  retryCount?: number;
  escalated?: boolean;
  completedAtMs?: number;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export class PersistentRunTelemetryStore {
  private db: Database.Database;

  constructor(dbPath: string = resolve(getDataDir(), "telemetry.db")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.initialize();
  }

  startRun(payload: RunStartPayload): void {
    const startedAt = payload.startedAtMs ?? Date.now();

    this.db
      .prepare(
        `
        INSERT INTO run_telemetry (run_id, goal_id, mode, started_at, envelope_complete)
        VALUES (@run_id, @goal_id, @mode, @started_at, 0)
        ON CONFLICT(run_id) DO UPDATE SET
          goal_id = COALESCE(excluded.goal_id, run_telemetry.goal_id),
          mode = COALESCE(excluded.mode, run_telemetry.mode),
          started_at = excluded.started_at
      `,
      )
      .run({
        run_id: payload.runId,
        goal_id: payload.goalId ?? null,
        mode: payload.mode ?? null,
        started_at: startedAt,
      });

    this.pruneOldRows(startedAt);
  }

  addApprovalWait(runId: string, waitMs: number): void {
    const safeWait = Number.isFinite(waitMs) ? Math.max(0, Math.floor(waitMs)) : 0;
    this.db
      .prepare(
        `
        UPDATE run_telemetry
        SET approval_wait_ms = approval_wait_ms + @wait_ms
        WHERE run_id = @run_id
      `,
      )
      .run({ run_id: runId, wait_ms: safeWait });
  }

  incrementRetry(runId: string, count = 1): void {
    const safeCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
    this.db
      .prepare(
        `
        UPDATE run_telemetry
        SET retry_count = retry_count + @retry_count
        WHERE run_id = @run_id
      `,
      )
      .run({ run_id: runId, retry_count: safeCount });
  }

  markEscalated(runId: string): void {
    this.db
      .prepare(
        `
        UPDATE run_telemetry
        SET escalated = 1
        WHERE run_id = @run_id
      `,
      )
      .run({ run_id: runId });
  }

  completeRun(payload: RunCompletePayload): void {
    const completedAt = payload.completedAtMs ?? Date.now();
    const safeDuration = Math.max(0, Math.floor(payload.durationMs));
    const safeApprovalWait = Math.max(0, Math.floor(payload.approvalWaitMs ?? 0));
    const safeRetryCount = Math.max(0, Math.floor(payload.retryCount ?? 0));
    const safeErrorCount = Math.max(0, Math.floor(payload.errorCount ?? 0));

    this.db
      .prepare(
        `
        INSERT INTO run_telemetry (
          run_id,
          started_at,
          completed_at,
          duration_ms,
          success,
          approval_wait_ms,
          retry_count,
          escalated,
          envelope_complete,
          error_count
        ) VALUES (
          @run_id,
          @started_at,
          @completed_at,
          @duration_ms,
          @success,
          @approval_wait_ms,
          @retry_count,
          @escalated,
          1,
          @error_count
        )
        ON CONFLICT(run_id) DO UPDATE SET
          completed_at = @completed_at,
          duration_ms = @duration_ms,
          success = @success,
          approval_wait_ms = MAX(run_telemetry.approval_wait_ms, @approval_wait_ms),
          retry_count = MAX(run_telemetry.retry_count, @retry_count),
          escalated = CASE WHEN @escalated = 1 THEN 1 ELSE run_telemetry.escalated END,
          envelope_complete = 1,
          error_count = @error_count
      `,
      )
      .run({
        run_id: payload.runId,
        started_at: completedAt,
        completed_at: completedAt,
        duration_ms: safeDuration,
        success: payload.success ? 1 : 0,
        approval_wait_ms: safeApprovalWait,
        retry_count: safeRetryCount,
        escalated: payload.escalated ? 1 : 0,
        error_count: safeErrorCount,
      });
  }

  getSummary(days = DEFAULT_WINDOW_DAYS): RunTelemetrySummary {
    const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : DEFAULT_WINDOW_DAYS;
    const now = Date.now();
    const windowMs = safeDays * 24 * 60 * 60 * 1000;
    const cutoff = now - windowMs;

    const counts = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS runs_started,
          SUM(CASE WHEN envelope_complete = 1 THEN 1 ELSE 0 END) AS complete_envelopes
        FROM run_telemetry
        WHERE started_at >= @cutoff
      `,
      )
      .get({ cutoff }) as RunCountsRow | undefined;

    const rows = this.db
      .prepare(
        `
        SELECT
          duration_ms,
          success,
          approval_wait_ms,
          retry_count,
          escalated
        FROM run_telemetry
        WHERE completed_at IS NOT NULL
          AND completed_at >= @cutoff
      `,
      )
      .all({ cutoff }) as RunTelemetryRow[];

    const completedRuns = rows.length;
    const successfulRuns = rows.filter((row) => row.success === 1).length;
    const failedRuns = completedRuns - successfulRuns;

    const durations = rows.map((row) => row.duration_ms).sort((a, b) => a - b);
    const totalDuration = durations.reduce((sum, value) => sum + value, 0);

    const totalApprovalWait = rows.reduce((sum, row) => sum + row.approval_wait_ms, 0);
    const totalRetries = rows.reduce((sum, row) => sum + row.retry_count, 0);
    const totalEscalations = rows.reduce((sum, row) => sum + row.escalated, 0);

    const p50 = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);

    const successRate = completedRuns > 0 ? (successfulRuns / completedRuns) * 100 : 100;
    const envelopeCompleteness = (counts?.runs_started ?? 0) > 0
      ? ((counts?.complete_envelopes ?? 0) / (counts?.runs_started ?? 0)) * 100
      : 100;

    const p95Target = parseInt(process.env.VCLAW_SLO_P95_LATENCY_MS || "", 10) || DEFAULT_P95_SLO_MS;
    const successTarget = parseInt(process.env.VCLAW_SLO_SUCCESS_RATE_PCT || "", 10) || DEFAULT_SUCCESS_RATE_SLO_PCT;

    const latencyBreached = p95 !== null && p95 > p95Target;
    const successBreached = successRate < successTarget;

    return {
      window: {
        from: new Date(cutoff).toISOString(),
        to: new Date(now).toISOString(),
        days: safeDays,
      },
      totals: {
        runs_started: counts?.runs_started ?? 0,
        runs_completed: completedRuns,
        successful_runs: successfulRuns,
        failed_runs: failedRuns,
        success_rate_pct: round(successRate),
        complete_envelopes: counts?.complete_envelopes ?? 0,
        envelope_completeness_pct: round(envelopeCompleteness),
      },
      latency: {
        p50_ms: p50 !== null ? Math.round(p50) : null,
        p95_ms: p95 !== null ? Math.round(p95) : null,
        avg_ms: completedRuns > 0 ? Math.round(totalDuration / completedRuns) : null,
      },
      approval: {
        total_wait_ms: totalApprovalWait,
        avg_wait_ms: completedRuns > 0 ? Math.round(totalApprovalWait / completedRuns) : 0,
      },
      retries: {
        total: totalRetries,
        avg_per_run: completedRuns > 0 ? round(totalRetries / completedRuns) : 0,
      },
      escalations: {
        total: totalEscalations,
        rate_pct: completedRuns > 0 ? round((totalEscalations / completedRuns) * 100) : 0,
      },
      slo: {
        targets: {
          p95_latency_ms: p95Target,
          success_rate_pct: successTarget,
        },
        breached: latencyBreached || successBreached,
        latency_p95_breached: latencyBreached,
        success_rate_breached: successBreached,
      },
    };
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_telemetry (
        run_id TEXT PRIMARY KEY,
        goal_id TEXT,
        mode TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        success INTEGER,
        approval_wait_ms INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        envelope_complete INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_run_telemetry_started_at
        ON run_telemetry(started_at);

      CREATE INDEX IF NOT EXISTS idx_run_telemetry_completed_at
        ON run_telemetry(completed_at);
    `);
  }

  private pruneOldRows(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    this.db
      .prepare(
        `
        DELETE FROM run_telemetry
        WHERE started_at < @cutoff
      `,
      )
      .run({ cutoff });
  }
}

export class RunTelemetryCollector {
  private readonly store: PersistentRunTelemetryStore;
  private readonly listener: (event: AgentEvent) => void;

  constructor(private readonly eventBus: EventBus, dbPath?: string) {
    this.store = new PersistentRunTelemetryStore(dbPath);
    this.listener = (event: AgentEvent) => this.handleEvent(event);
    this.eventBus.on("*", this.listener);
  }

  getSummary(days = DEFAULT_WINDOW_DAYS): RunTelemetrySummary {
    return this.store.getSummary(days);
  }

  stop(): void {
    this.eventBus.off("*", this.listener);
  }

  close(): void {
    this.stop();
    this.store.close();
  }

  private handleEvent(event: AgentEvent): void {
    const data = event.data;

    switch (event.type) {
      case AgentEventType.RunStarted: {
        const runId = typeof data.run_id === "string" ? data.run_id : null;
        if (!runId) return;

        this.store.startRun({
          runId,
          goalId: typeof data.goal_id === "string" ? data.goal_id : undefined,
          mode: typeof data.mode === "string" ? data.mode : undefined,
          startedAtMs: Date.parse(event.timestamp),
        });
        break;
      }

      case AgentEventType.ApprovalReceived: {
        const runId = typeof data.run_id === "string" ? data.run_id : null;
        const waitMs = typeof data.wait_ms === "number" ? data.wait_ms : 0;
        if (!runId) return;
        this.store.addApprovalWait(runId, waitMs);
        break;
      }

      case AgentEventType.Replan: {
        const runId = typeof data.run_id === "string" ? data.run_id : null;
        if (!runId) return;
        this.store.incrementRetry(runId, 1);
        break;
      }

      case AgentEventType.RunEscalated: {
        const runId = typeof data.run_id === "string" ? data.run_id : null;
        if (!runId) return;
        this.store.markEscalated(runId);
        break;
      }

      case AgentEventType.RunCompleted: {
        const runId = typeof data.run_id === "string" ? data.run_id : null;
        const success = typeof data.success === "boolean" ? data.success : false;
        const durationMs = typeof data.duration_ms === "number" ? data.duration_ms : 0;
        if (!runId) return;

        this.store.completeRun({
          runId,
          success,
          durationMs,
          errorCount: typeof data.errors === "number" ? data.errors : 0,
          approvalWaitMs: typeof data.approval_wait_ms === "number" ? data.approval_wait_ms : undefined,
          retryCount: typeof data.retry_count === "number" ? data.retry_count : undefined,
          escalated: typeof data.escalated === "boolean" ? data.escalated : undefined,
          completedAtMs: Date.parse(event.timestamp),
        });
        break;
      }
    }
  }
}
