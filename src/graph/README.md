# Graph — Infrastructure Ontology

The graph is RHODES' working memory of the customer's entire on-prem + cloud infrastructure. Adapters (VMware, Proxmox, AWS, Azure, K8s) discover Resources and Relationships and write them here; the orchestrator queries the graph before generating plans.

This is the **substrate that makes RHODES "AI brain for infra" actually true.** Without the graph, the orchestrator has to ad-hoc adapter calls every time it reasons; with it, a single typed contract gives the agent context about what exists, what depends on what, and how recently we observed it.

## Locked design decisions

Four decisions, each validated by external research (see `~/rhodes-strategy/research-archive/`):

1. **Cross-provider identity via `manifests_as` edges** (JupiterOne `IS` pattern). Each provider gets its own Resource record. When the same logical thing appears in multiple providers (e.g., a Proxmox VM that runs a nested ESXi host), an explicit edge connects them. Shared interface labels (Cartography polymorphic-label trick) let common queries skip the traversal.
2. **Universal typed fields + JSON `properties` blob**, with mandatory write-time schema validation. Adapters MUST register every (provider, type) combo before writing. The store throws `GraphNotRegisteredError` / `GraphSchemaError` otherwise.
3. **Per-type closed state enums + optional `conditions[]` sidecar.** State carries `state_observed_at`; orthogonal signals one enum slot can't carry (e.g., "running per hypervisor AND unreachable from probe") live as K8s-style Conditions.
4. **Per-type freshness windows + 3 query modes** (`fresh` / `staleAllowed` / `historical`). The orchestrator defaults to `fresh` (don't plan on stale data); dashboards default to `staleAllowed` (give the operator visibility with explicit annotations).

## Files

| File | Purpose |
|---|---|
| `types.ts` | All public types — `Resource`, `Relationship`, `Condition`, state enums per interface label, `FRESHNESS_WINDOW_SEC` table |
| `schema.ts` | SQL DDL (idempotent `CREATE TABLE IF NOT EXISTS` + indexes), applied on every store boot |
| `store.ts` | `GraphStore` class — typed CRUD with write-time schema validation. Uses better-sqlite3 + zod, matches `src/healing/ticket-store.ts` patterns |
| `query.ts` | `queryResources()` — 3-mode query API, annotates each row with `isStale` + `ageSec` |
| `resolver.ts` | `runResolver()` — infers `manifests_as` edges from rules (separate subsystem, NOT entangled with ingestion) |
| `index.ts` | Public exports |

## Adapter usage pattern

```ts
import { GraphStore, z } from "../graph/index.js";

const store = new GraphStore(); // opens ~/.rhodes/data/graph.db

// 1. Register every resource type ONCE at boot
store.registerResourceType({
  provider: "vsphere",
  type: "vsphere_host",
  interfaceLabels: ["ComputeNode"],
  allowedStates: ["running", "maintenance", "disconnected", "error", "unknown"],
  propertiesSchema: z.object({
    cpuCores: z.number(),
    memoryMb: z.number(),
    connectionState: z.enum(["connected", "notResponding", "disconnected"]),
  }),
});

// 2. Discover and upsert resources
for (const host of await vsphereClient.listHosts()) {
  store.upsertResource({
    id: `vsphere:vsphere_host:${host.moid}`,
    provider: "vsphere",
    type: "vsphere_host",
    name: host.hostname,
    observedState: mapVSphereStateToOurs(host),
    properties: {
      cpuCores: host.numCpuCores,
      memoryMb: host.memorySize / 1024 / 1024,
      connectionState: host.runtime.connectionState,
    },
  });
}

// 3. Upsert direct relationships the adapter observes
for (const vm of vms) {
  store.upsertRelationship({
    fromId: `vsphere:vsphere_vm:${vm.moid}`,
    toId: `vsphere:vsphere_host:${vm.runtime.host.moid}`,
    type: "runs_on",
    origin: "direct",
  });
}
```

## Querying

```ts
import { queryResources } from "../graph/index.js";

// Orchestrator: only fresh data
const runningHosts = queryResources(store, {
  interfaceLabel: "ComputeNode",
  observedState: "running",
  mode: "fresh", // default
});

// Dashboard: include stale, annotated
const allWorkloads = queryResources(store, {
  interfaceLabel: "ComputeWorkload",
  mode: "staleAllowed",
});
// allWorkloads[i].isStale tells you whether to color it red
```

## What's NOT in this module

- **Promotion to typed columns** — when a `properties` field starts appearing in WHERE clauses more than monthly, promote it (JSONB → generated column → typed column). Track candidates via `pg_stat_statements` after we migrate to Postgres; on SQLite, manual.
- **Live-fetch escape hatch for fresh mode** — when a fresh-mode query returns empty for a resource that SHOULD exist (the ARG 404 problem), the caller should be able to opt into a synchronous fetch from the source adapter. The hook is unimplemented in v0; each adapter wires it in v0.6.5.
- **Periodic full reconciliation** — needed for collectors that mix events + polls (AWS, K8s). Lives in adapter code; the graph just exposes `last_observed_at` and `last_changed_at` for adapters to base GC decisions on.
- **Soft delete / retention** — Resources that haven't been observed for N days should age out. For v0, leave them; add a background job in v0.6.5+.

## Storage location

`getDataDir()/graph.db` (default: `~/.rhodes/data/graph.db`). WAL journal mode, foreign keys ON.
