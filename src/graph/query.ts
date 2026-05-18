// ============================================================
// RHODES — Graph Query API
//
// Three-mode queries per Decision #4:
//   - 'fresh'         — only resources observed within freshness window
//   - 'staleAllowed'  — include all, annotated with isStale + ageSec
//   - 'historical'    — same as staleAllowed for v0 (when retention
//                       lands, this will include never-seen-recently)
//
// Per-record `lastObservedAt` is exposed on every result — NOT a
// boolean `isStale` alone. ARG's `x-ms-arg-snapshot-timestamp` is
// the precedent; callers make their own freshness judgments.
//
// Fresh-mode escape hatch (not yet implemented in v0): when `fresh`
// returns "not present or too stale", callers should be able to opt
// into a synchronous live fetch from the source. This is the
// canonical ARG 404 problem for newly-created resources. Stub the
// hook here; live-fetch wiring is per-adapter and lands in v0.6.5.
// ============================================================

import type Database from "better-sqlite3";
import type {
  QueryOptions,
  Resource,
  ResourceWithFreshness,
} from "./types.js";
import type { GraphStore } from "./store.js";

interface ResourceRow {
  id: string;
  provider: string;
  type: string;
  interface_labels: string;
  name: string;
  observed_state: string;
  desired_state: string | null;
  properties: string;
  last_observed_at: string;
  last_changed_at: string;
  discovered_at: string;
}

/**
 * Query the graph. Callers should pass `mode: 'fresh'` for planning
 * decisions (orchestrator), `mode: 'staleAllowed'` for dashboards.
 *
 * IMPORTANT: when `mode = 'fresh'` returns empty for a resource that
 * SHOULD exist (e.g., newly created), the caller should consider
 * calling the adapter's live-fetch path — the graph's freshness
 * contract doesn't guarantee zero indexing lag for new resources.
 */
export function queryResources(
  store: GraphStore,
  opts: QueryOptions = {},
): ResourceWithFreshness[] {
  // Access the underlying db via the store's well-typed methods to
  // avoid coupling to store internals. We build a single SELECT with
  // optional WHERE clauses, then annotate freshness post-hoc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: Database.Database = (store as any).db;
  if (!db) {
    throw new Error("queryResources: store.db not accessible");
  }

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.provider) {
    where.push("provider = @provider");
    params.provider = opts.provider;
  }
  if (opts.type) {
    where.push("type = @type");
    params.type = opts.type;
  }
  if (opts.observedState) {
    where.push("observed_state = @observed_state");
    params.observed_state = opts.observedState;
  }
  // Interface-label filter: stored as JSON array, so use json_each via EXISTS subquery.
  if (opts.interfaceLabel) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(resources.interface_labels) WHERE value = @interface_label)",
    );
    params.interface_label = opts.interfaceLabel;
  }
  const sql =
    "SELECT * FROM resources" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  const rows = db.prepare(sql).all(params) as ResourceRow[];

  const nowMs = Date.now();
  const mode = opts.mode ?? "fresh";
  const annotated = rows.map((row) => annotateRow(store, row, nowMs));

  if (mode === "fresh") {
    return annotated.filter((r) => !r.isStale);
  }
  // 'staleAllowed' and 'historical' both return everything for v0.
  return annotated;
}

function annotateRow(
  store: GraphStore,
  row: ResourceRow,
  nowMs: number,
): ResourceWithFreshness {
  const lastObsMs = Date.parse(row.last_observed_at);
  const ageSec = Math.max(0, Math.floor((nowMs - lastObsMs) / 1000));
  const window = store.freshnessWindowSecFor(
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    row.type as Parameters<GraphStore["freshnessWindowSecFor"]>[0],
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    row.provider as Parameters<GraphStore["freshnessWindowSecFor"]>[1],
  );
  return {
    ...rowToResource(row),
    isStale: ageSec > window,
    ageSec,
  };
}

function rowToResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: row.provider as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type: row.type as any,
    interfaceLabels: JSON.parse(row.interface_labels),
    name: row.name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observedState: row.observed_state as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    desiredState: (row.desired_state ?? null) as any,
    properties: JSON.parse(row.properties),
    lastObservedAt: row.last_observed_at,
    lastChangedAt: row.last_changed_at,
    discoveredAt: row.discovered_at,
  };
}
