// ============================================================
// RHODES — Graph Store
//
// Typed CRUD over the resources / relationships / conditions /
// resource_type_registry tables. Write-time JSON schema validation
// per Decision #2 (without enforcement, the schema rots in 18 months).
//
// Connection model matches the rest of the codebase: a single
// better-sqlite3 instance owned by the store, WAL journal mode,
// idempotent DDL run in the constructor.
// ============================================================

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z, type ZodType } from "zod";
import { getDataDir } from "../config.js";
import { GRAPH_SCHEMA_SQL } from "./schema.js";
import type {
  AnyResourceState,
  Condition,
  ConditionType,
  GraphProvider,
  InterfaceLabel,
  Relationship,
  RelationshipType,
  Resource,
  ResourceType,
  ResourceTypeRegistration,
} from "./types.js";
import { FRESHNESS_WINDOW_SEC } from "./types.js";

// ── Raw row shapes (what SQLite returns) ───────────────────

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

interface RelationshipRow {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: string;
  observed_at: string;
  origin: string;
}

interface ConditionRow {
  resource_id: string;
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  last_transition_at: string;
}

// ── Registration-time variant: takes a zod schema directly ─

export interface ResourceTypeRegistrationInput<
  TProps extends Record<string, unknown> = Record<string, unknown>,
> extends Omit<ResourceTypeRegistration, "propertiesSchema"> {
  /** Zod schema used to validate `properties` at write time. */
  propertiesSchema: ZodType<TProps>;
}

// ── Errors ─────────────────────────────────────────────────

export class GraphSchemaError extends Error {
  constructor(message: string, public readonly resourceId?: string) {
    super(message);
    this.name = "GraphSchemaError";
  }
}

export class GraphNotRegisteredError extends GraphSchemaError {
  constructor(provider: string, type: string) {
    super(
      `Resource type (${provider}, ${type}) is not registered. Call registerResourceType() before writing resources of this type.`,
    );
    this.name = "GraphNotRegisteredError";
  }
}

// ── Store class ────────────────────────────────────────────

export class GraphStore {
  private db: Database.Database;
  /** In-memory registry of zod schemas (the DB row is for audit). */
  private registry = new Map<string, ResourceTypeRegistrationInput>();

  constructor(dbPath?: string) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const path = dbPath ?? join(dataDir, "graph.db");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(GRAPH_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ── Schema registration ──────────────────────────────────

  /**
   * Register a (provider, type) combo. Writes for this combo will
   * be validated against `propertiesSchema` and `allowedStates`.
   * Idempotent — re-registration updates the in-memory schema and
   * the audit row but does NOT alter prior-written data.
   */
  registerResourceType<TProps extends Record<string, unknown>>(
    reg: ResourceTypeRegistrationInput<TProps>,
  ): void {
    const key = registryKey(reg.provider, reg.type);
    this.registry.set(key, reg as ResourceTypeRegistrationInput);

    // Audit row in DB. Serialize a human-readable schema description
    // since zod's runtime representation isn't trivially JSON-able.
    const schemaDescription = zodSchemaToShapeJson(reg.propertiesSchema);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO resource_type_registry
         (provider, type, interface_labels, allowed_states, properties_schema, freshness_window_sec, registered_at)
         VALUES (@provider, @type, @interface_labels, @allowed_states, @properties_schema, @freshness_window_sec, @registered_at)`,
      )
      .run({
        provider: reg.provider,
        type: reg.type,
        interface_labels: JSON.stringify(reg.interfaceLabels),
        allowed_states: JSON.stringify(reg.allowedStates),
        properties_schema: JSON.stringify(schemaDescription),
        freshness_window_sec: reg.freshnessWindowSec ?? null,
        registered_at: nowIso(),
      });
  }

  getRegistration(
    provider: GraphProvider,
    type: ResourceType,
  ): ResourceTypeRegistrationInput | undefined {
    return this.registry.get(registryKey(provider, type));
  }

  /** Per-type freshness window resolution. Registration override beats global default. */
  freshnessWindowSecFor(type: ResourceType, provider?: GraphProvider): number {
    if (provider) {
      const reg = this.registry.get(registryKey(provider, type));
      if (reg?.freshnessWindowSec) return reg.freshnessWindowSec;
    }
    return FRESHNESS_WINDOW_SEC[type] ?? 300;
  }

  // ── Resource CRUD ────────────────────────────────────────

  /**
   * Upsert a resource. Validates against the registered schema for
   * (provider, type). Throws GraphNotRegisteredError if not registered,
   * GraphSchemaError if the state or properties fail validation.
   *
   * Returns the resulting Resource. If the observed_state changed from
   * a prior write, last_changed_at is updated to now; otherwise the
   * prior last_changed_at is preserved.
   */
  upsertResource(input: ResourceUpsertInput): Resource {
    const reg = this.registry.get(registryKey(input.provider, input.type));
    if (!reg) {
      throw new GraphNotRegisteredError(input.provider, input.type);
    }

    if (!reg.allowedStates.includes(input.observedState)) {
      throw new GraphSchemaError(
        `state '${input.observedState}' is not in allowedStates [${reg.allowedStates.join(", ")}] for (${input.provider}, ${input.type})`,
        input.id,
      );
    }

    // Validate properties against the registered zod schema
    const parsed = reg.propertiesSchema.safeParse(input.properties);
    if (!parsed.success) {
      throw new GraphSchemaError(
        `properties failed schema validation for (${input.provider}, ${input.type}): ${parsed.error.message}`,
        input.id,
      );
    }

    const now = nowIso();
    const prior = this.getResource(input.id);
    const lastChangedAt =
      prior && prior.observedState === input.observedState
        ? prior.lastChangedAt
        : now;
    const discoveredAt = prior?.discoveredAt ?? now;

    this.db
      .prepare(
        `INSERT INTO resources
         (id, provider, type, interface_labels, name, observed_state, desired_state,
          properties, last_observed_at, last_changed_at, discovered_at)
         VALUES (@id, @provider, @type, @interface_labels, @name, @observed_state, @desired_state,
                 @properties, @last_observed_at, @last_changed_at, @discovered_at)
         ON CONFLICT(id) DO UPDATE SET
           name              = excluded.name,
           interface_labels  = excluded.interface_labels,
           observed_state    = excluded.observed_state,
           desired_state     = excluded.desired_state,
           properties        = excluded.properties,
           last_observed_at  = excluded.last_observed_at,
           last_changed_at   = excluded.last_changed_at`,
      )
      .run({
        id: input.id,
        provider: input.provider,
        type: input.type,
        interface_labels: JSON.stringify(reg.interfaceLabels),
        name: input.name,
        observed_state: input.observedState,
        desired_state: input.desiredState ?? null,
        properties: JSON.stringify(parsed.data),
        last_observed_at: now,
        last_changed_at: lastChangedAt,
        discovered_at: discoveredAt,
      });

    return {
      id: input.id,
      provider: input.provider,
      type: input.type,
      interfaceLabels: reg.interfaceLabels,
      name: input.name,
      observedState: input.observedState,
      desiredState: input.desiredState ?? null,
      properties: parsed.data,
      lastObservedAt: now,
      lastChangedAt,
      discoveredAt,
    };
  }

  getResource(id: string): Resource | null {
    const row = this.db
      .prepare("SELECT * FROM resources WHERE id = ?")
      .get(id) as ResourceRow | undefined;
    return row ? rowToResource(row) : null;
  }

  listResources(): Resource[] {
    const rows = this.db
      .prepare("SELECT * FROM resources")
      .all() as ResourceRow[];
    return rows.map(rowToResource);
  }

  deleteResource(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM resources WHERE id = ?").run(id).changes > 0
    );
  }

  setDesiredState(id: string, state: AnyResourceState | null): void {
    this.db
      .prepare("UPDATE resources SET desired_state = ? WHERE id = ?")
      .run(state, id);
  }

  // ── Relationship CRUD ────────────────────────────────────

  /**
   * Upsert a relationship. The UNIQUE(from_id, to_id, type) constraint
   * makes this idempotent — re-asserting the same edge refreshes
   * properties + observed_at without creating duplicates.
   */
  upsertRelationship(input: RelationshipUpsertInput): Relationship {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO relationships (id, from_id, to_id, type, properties, observed_at, origin)
         VALUES (@id, @from_id, @to_id, @type, @properties, @observed_at, @origin)
         ON CONFLICT(from_id, to_id, type) DO UPDATE SET
           properties   = excluded.properties,
           observed_at  = excluded.observed_at,
           origin       = excluded.origin`,
      )
      .run({
        id,
        from_id: input.fromId,
        to_id: input.toId,
        type: input.type,
        properties: JSON.stringify(input.properties ?? {}),
        observed_at: now,
        origin: input.origin,
      });

    const row = this.db
      .prepare(
        "SELECT * FROM relationships WHERE from_id = ? AND to_id = ? AND type = ?",
      )
      .get(input.fromId, input.toId, input.type) as RelationshipRow;
    return rowToRelationship(row);
  }

  /** Outgoing edges from a resource (optionally filtered by type). */
  edgesFrom(fromId: string, type?: RelationshipType): Relationship[] {
    const rows = (
      type
        ? this.db
            .prepare(
              "SELECT * FROM relationships WHERE from_id = ? AND type = ?",
            )
            .all(fromId, type)
        : this.db
            .prepare("SELECT * FROM relationships WHERE from_id = ?")
            .all(fromId)
    ) as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  /** Incoming edges to a resource. */
  edgesTo(toId: string, type?: RelationshipType): Relationship[] {
    const rows = (
      type
        ? this.db
            .prepare("SELECT * FROM relationships WHERE to_id = ? AND type = ?")
            .all(toId, type)
        : this.db
            .prepare("SELECT * FROM relationships WHERE to_id = ?")
            .all(toId)
    ) as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  listRelationships(): Relationship[] {
    const rows = this.db
      .prepare("SELECT * FROM relationships")
      .all() as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  deleteRelationship(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM relationships WHERE id = ?").run(id)
        .changes > 0
    );
  }

  // ── Condition (sidecar) CRUD ─────────────────────────────

  /**
   * Upsert a condition. Conditions are orthogonal to `observedState`
   * — use them for facts a single state slot can't carry.
   */
  upsertCondition(input: ConditionUpsertInput): Condition {
    const now = nowIso();
    const prior = this.getCondition(input.resourceId, input.type);
    const lastTransitionAt =
      prior && prior.status === input.status ? prior.lastTransitionAt : now;

    this.db
      .prepare(
        `INSERT INTO conditions
         (resource_id, type, status, reason, message, last_transition_at)
         VALUES (@resource_id, @type, @status, @reason, @message, @last_transition_at)
         ON CONFLICT(resource_id, type) DO UPDATE SET
           status              = excluded.status,
           reason              = excluded.reason,
           message             = excluded.message,
           last_transition_at  = excluded.last_transition_at`,
      )
      .run({
        resource_id: input.resourceId,
        type: input.type,
        status: input.status,
        reason: input.reason ?? null,
        message: input.message ?? null,
        last_transition_at: lastTransitionAt,
      });

    return {
      resourceId: input.resourceId,
      type: input.type,
      status: input.status,
      reason: input.reason,
      message: input.message,
      lastTransitionAt,
    };
  }

  getCondition(resourceId: string, type: ConditionType): Condition | null {
    const row = this.db
      .prepare(
        "SELECT * FROM conditions WHERE resource_id = ? AND type = ?",
      )
      .get(resourceId, type) as ConditionRow | undefined;
    return row ? rowToCondition(row) : null;
  }

  conditionsFor(resourceId: string): Condition[] {
    const rows = this.db
      .prepare("SELECT * FROM conditions WHERE resource_id = ?")
      .all(resourceId) as ConditionRow[];
    return rows.map(rowToCondition);
  }
}

// ── Inputs (without computed/timestamp fields) ─────────────

export interface ResourceUpsertInput {
  id: string;
  provider: GraphProvider;
  type: ResourceType;
  name: string;
  observedState: AnyResourceState;
  desiredState?: AnyResourceState | null;
  properties: Record<string, unknown>;
}

export interface RelationshipUpsertInput {
  id?: string;
  fromId: string;
  toId: string;
  type: RelationshipType;
  properties?: Record<string, unknown>;
  origin: "direct" | "inferred";
}

export interface ConditionUpsertInput {
  resourceId: string;
  type: ConditionType;
  status: "true" | "false" | "unknown";
  reason?: string;
  message?: string;
}

// ── Helpers ────────────────────────────────────────────────

function rowToResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    provider: row.provider as GraphProvider,
    type: row.type as ResourceType,
    interfaceLabels: JSON.parse(row.interface_labels) as InterfaceLabel[],
    name: row.name,
    observedState: row.observed_state as AnyResourceState,
    desiredState: (row.desired_state ?? null) as AnyResourceState | null,
    properties: JSON.parse(row.properties),
    lastObservedAt: row.last_observed_at,
    lastChangedAt: row.last_changed_at,
    discoveredAt: row.discovered_at,
  };
}

function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type as RelationshipType,
    properties: JSON.parse(row.properties),
    observedAt: row.observed_at,
    origin: row.origin as "direct" | "inferred",
  };
}

function rowToCondition(row: ConditionRow): Condition {
  return {
    resourceId: row.resource_id,
    type: row.type as ConditionType,
    status: row.status as "true" | "false" | "unknown",
    reason: row.reason ?? undefined,
    message: row.message ?? undefined,
    lastTransitionAt: row.last_transition_at,
  };
}

function registryKey(provider: string, type: string): string {
  return `${provider}:${type}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Cheap human-readable serialization of a zod schema. Zod doesn't ship
 * a stable JSON-Schema serializer; the audit row's `properties_schema`
 * stores this descriptive shape so operators can inspect what was
 * registered without re-deriving from code.
 */
function zodSchemaToShapeJson(schema: ZodType): Record<string, unknown> {
  // Best-effort introspection. Real schema-to-JSON-Schema is non-trivial
  // and not worth a dep for v0; describe-by-typeName covers the common case.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as unknown as { _def?: any })._def;
  if (!def) return { kind: "unknown" };
  if (def.typeName === "ZodObject" && def.shape) {
    const shape = typeof def.shape === "function" ? def.shape() : def.shape;
    const fields: Record<string, string> = {};
    for (const k of Object.keys(shape)) {
      const f = shape[k];
      fields[k] = f?._def?.typeName ?? "unknown";
    }
    return { kind: "object", fields };
  }
  return { kind: def.typeName ?? "unknown" };
}

// Re-export zod for adapter convenience (so adapters don't have to import it themselves)
export { z };
