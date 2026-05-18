// ============================================================
// RHODES — Attribution Store
//
// SQLite-backed persistence for normalized AttributionEvents.
// Matches the better-sqlite3 + WAL + idempotent-DDL pattern used
// across the codebase (src/healing/ticket-store.ts, src/graph/store.ts).
// ============================================================

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { getDataDir } from "../config.js";
import { ATTRIBUTION_SCHEMA_SQL } from "./schema.js";
import type { GraphProvider } from "../graph/types.js";
import type {
  ActorKind,
  AttributionEvent,
  AttributionEventType,
} from "./types.js";
import { EVENT_RETENTION_SEC } from "./types.js";

interface EventRow {
  id: string;
  provider: string;
  event_type: string;
  target_resource_id: string | null;
  actor_kind: string;
  actor_identity: string | null;
  actor_via: string | null;
  occurred_at: string;
  raw_source: string;
  ingested_at: string;
}

export class AttributionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const path = dbPath ?? join(dataDir, "attribution.db");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(ATTRIBUTION_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Idempotent insert. Re-asserting an event with the same id is a
   * no-op (event sources may re-emit during reconnect / resync).
   */
  upsertEvent(event: AttributionEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attribution_events
         (id, provider, event_type, target_resource_id,
          actor_kind, actor_identity, actor_via,
          occurred_at, raw_source, ingested_at)
         VALUES (@id, @provider, @event_type, @target_resource_id,
                 @actor_kind, @actor_identity, @actor_via,
                 @occurred_at, @raw_source, @ingested_at)`,
      )
      .run({
        id: event.id,
        provider: event.provider,
        event_type: event.eventType,
        target_resource_id: event.targetResourceId ?? null,
        actor_kind: event.actor.kind,
        actor_identity: event.actor.identity ?? null,
        actor_via: event.actor.via ?? null,
        occurred_at: event.occurredAt,
        raw_source: JSON.stringify(event.rawSource),
        ingested_at: new Date().toISOString(),
      });
  }

  /**
   * Events targeting a specific resource within a time window. Used
   * by the correlator's primary lookup path.
   */
  eventsForResource(
    resourceId: string,
    sinceIso: string,
    untilIso: string,
  ): AttributionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attribution_events
         WHERE target_resource_id = ?
           AND occurred_at >= ?
           AND occurred_at <= ?
         ORDER BY occurred_at DESC`,
      )
      .all(resourceId, sinceIso, untilIso) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Provider-level events within a window (no resource scoping).
   * Used for soft-signal correlation when a resource-level match
   * isn't found. Rare path.
   */
  eventsByProvider(
    provider: GraphProvider,
    sinceIso: string,
    untilIso: string,
  ): AttributionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attribution_events
         WHERE provider = ?
           AND target_resource_id IS NULL
           AND occurred_at >= ?
           AND occurred_at <= ?
         ORDER BY occurred_at DESC`,
      )
      .all(provider, sinceIso, untilIso) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** All events (mostly for tests + debugging). */
  listEvents(): AttributionEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM attribution_events ORDER BY occurred_at DESC")
      .all() as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Prune events older than EVENT_RETENTION_SEC. Returns the number
   * of rows deleted. Callable from a background sweeper.
   */
  pruneStale(): number {
    const cutoffIso = new Date(
      Date.now() - EVENT_RETENTION_SEC * 1000,
    ).toISOString();
    return this.db
      .prepare("DELETE FROM attribution_events WHERE occurred_at < ?")
      .run(cutoffIso).changes;
  }
}

function rowToEvent(row: EventRow): AttributionEvent {
  return {
    id: row.id,
    provider: row.provider as GraphProvider,
    eventType: row.event_type as AttributionEventType,
    targetResourceId: row.target_resource_id ?? undefined,
    actor: {
      kind: row.actor_kind as ActorKind,
      identity: row.actor_identity ?? undefined,
      via: row.actor_via ?? undefined,
    },
    occurredAt: row.occurred_at,
    rawSource: JSON.parse(row.raw_source),
  };
}
