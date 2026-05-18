// ============================================================
// RHODES — Graph Schema (DDL)
//
// Schema is applied idempotently on every store boot, matching
// the existing pattern in `src/healing/ticket-store.ts` and
// `src/topology/store.ts`. No external migration runner.
//
// Promotion protocol (Decision #2):
// Fields living in `properties` JSON blob can be promoted to
// (a) Postgres-style generated columns (when we migrate to PG),
// or (b) first-class typed columns via expand-and-contract.
// For now, on SQLite, we rely on GIN-equivalent indexing patterns
// (json_extract expression indexes) for hot fields as they emerge.
// ============================================================

/**
 * Apply (idempotently) the graph schema. Safe to call on every boot.
 */
export const GRAPH_SCHEMA_SQL = `
-- ── resources ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
  id                  TEXT PRIMARY KEY,         -- {provider}:{type}:{provider_uid}
  provider            TEXT NOT NULL,
  type                TEXT NOT NULL,
  interface_labels    TEXT NOT NULL,            -- JSON array
  name                TEXT NOT NULL,
  observed_state      TEXT NOT NULL,            -- closed enum per type
  desired_state       TEXT,                     -- NULL = no opinion
  properties          TEXT NOT NULL,            -- JSON blob (validated at write time)
  last_observed_at    TEXT NOT NULL,            -- ISO-8601 UTC
  last_changed_at     TEXT NOT NULL,            -- ISO-8601 UTC
  discovered_at       TEXT NOT NULL,            -- ISO-8601 UTC
  CHECK (json_valid(interface_labels)),
  CHECK (json_valid(properties))
);

CREATE INDEX IF NOT EXISTS idx_resources_provider_type
  ON resources(provider, type);

CREATE INDEX IF NOT EXISTS idx_resources_observed_state
  ON resources(observed_state);

CREATE INDEX IF NOT EXISTS idx_resources_last_observed
  ON resources(last_observed_at);

-- ── relationships ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relationships (
  id                  TEXT PRIMARY KEY,         -- UUID
  from_id             TEXT NOT NULL,
  to_id               TEXT NOT NULL,
  type                TEXT NOT NULL,            -- closed enum (RelationshipType)
  properties          TEXT NOT NULL,            -- JSON blob
  observed_at         TEXT NOT NULL,
  origin              TEXT NOT NULL,            -- 'direct' | 'inferred'
  FOREIGN KEY (from_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES resources(id) ON DELETE CASCADE,
  CHECK (origin IN ('direct', 'inferred')),
  CHECK (json_valid(properties)),
  UNIQUE (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id, type);
CREATE INDEX IF NOT EXISTS idx_rel_to   ON relationships(to_id, type);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type);

-- ── conditions (Decision #3 sidecar) ───────────────────────
CREATE TABLE IF NOT EXISTS conditions (
  resource_id         TEXT NOT NULL,
  type                TEXT NOT NULL,            -- ConditionType enum
  status              TEXT NOT NULL,            -- 'true' | 'false' | 'unknown'
  reason              TEXT,
  message             TEXT,
  last_transition_at  TEXT NOT NULL,
  PRIMARY KEY (resource_id, type),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  CHECK (status IN ('true', 'false', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_cond_status ON conditions(type, status);

-- ── resource_type_registry (Decision #2 schema registry) ───
CREATE TABLE IF NOT EXISTS resource_type_registry (
  provider             TEXT NOT NULL,
  type                 TEXT NOT NULL,
  interface_labels     TEXT NOT NULL,           -- JSON array
  allowed_states       TEXT NOT NULL,           -- JSON array
  properties_schema    TEXT NOT NULL,           -- JSON Schema
  freshness_window_sec INTEGER,                 -- NULL = use global default
  registered_at        TEXT NOT NULL,
  PRIMARY KEY (provider, type),
  CHECK (json_valid(interface_labels)),
  CHECK (json_valid(allowed_states)),
  CHECK (json_valid(properties_schema))
);
`;
