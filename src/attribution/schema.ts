// ============================================================
// RHODES — Attribution Store Schema (DDL)
//
// Single table for normalized events. Indexed on the columns the
// correlator queries: (target_resource_id, occurred_at) for direct
// matches, occurred_at alone for window scans + retention pruning.
//
// Applied idempotently on every store boot, matching the pattern
// from src/graph/schema.ts and src/healing/ticket-store.ts.
// ============================================================

export const ATTRIBUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS attribution_events (
  id                  TEXT PRIMARY KEY,         -- {provider}:{event_uid}
  provider            TEXT NOT NULL,
  event_type          TEXT NOT NULL,            -- closed enum (AttributionEventType)
  target_resource_id  TEXT,                     -- graph Resource.id; NULL if event isn't resource-scoped
  actor_kind          TEXT NOT NULL,            -- 'human' | 'system' | 'rhodes' | 'unknown'
  actor_identity      TEXT,
  actor_via           TEXT,
  occurred_at         TEXT NOT NULL,            -- ISO-8601 UTC
  raw_source          TEXT NOT NULL,            -- JSON blob, audit only
  ingested_at         TEXT NOT NULL,            -- when WE wrote the row
  CHECK (json_valid(raw_source)),
  CHECK (actor_kind IN ('human', 'system', 'rhodes', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_attribution_target_time
  ON attribution_events(target_resource_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_attribution_occurred_at
  ON attribution_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_attribution_event_type
  ON attribution_events(event_type);
`;
