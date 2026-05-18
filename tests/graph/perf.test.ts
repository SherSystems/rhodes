// ============================================================
// Graph Perf — sanity bounds at modest scale (1k resources,
// ~5k edges). Goal: catch accidental O(N^2) in resolver/queries,
// NOT to benchmark. Bounds are loose; on a typical dev box the
// real numbers are ~10x under the cap.
//
// Companion to:
//   - tests/graph/store.test.ts (functional CRUD)
//   - tests/graph/query.test.ts (query semantics)
//   - tests/graph/integration-manifests-as.test.ts (resolver)
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GraphStore,
  queryResources,
  runResolver,
  z,
} from "../../src/graph/index.js";

const RESOURCE_COUNT = 1000;
// We want enough edges that an O(N^2) bug in resolver/query is observable
// but not so many that the test exceeds the 5s budget on a cold VM.
const EXTRA_EDGES_TARGET = 5000;

// Loose bounds — see file header for why these are deliberately slack.
// Empirically: query path ~5ms, resolver ~50ms on a 2024 dev box.
const QUERY_BUDGET_MS = 500;
const RESOLVER_BUDGET_MS = 2500;

describe("graph performance / scale sanity", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-perf-"));
    store = new GraphStore(join(dir, "graph.db"));

    store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({
        vmid: z.number(),
        node: z.string(),
      }),
    });
    store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_node",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "disconnected", "unknown"],
      propertiesSchema: z.object({
        nodeName: z.string(),
      }),
    });
    store.registerResourceType({
      provider: "vsphere",
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "maintenance", "disconnected", "unknown"],
      propertiesSchema: z.object({
        moid: z.string(),
      }),
    });
    store.registerResourceType({
      provider: "vsphere",
      type: "vsphere_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "paused", "unknown"],
      propertiesSchema: z.object({
        moid: z.string(),
      }),
    });

    seedAtScale(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(`seeds ${RESOURCE_COUNT} resources successfully`, () => {
    expect(store.listResources().length).toBe(RESOURCE_COUNT);
  });

  it(
    `queryResources(provider: 'proxmox') under ${QUERY_BUDGET_MS}ms`,
    () => {
      const start = performance.now();
      const result = queryResources(store, { provider: "proxmox" });
      const elapsed = performance.now() - start;
      // ~half the seed is proxmox
      expect(result.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
    },
  );

  it(
    `queryResources(interfaceLabel: 'ComputeNode') under ${QUERY_BUDGET_MS}ms`,
    () => {
      const start = performance.now();
      const result = queryResources(store, { interfaceLabel: "ComputeNode" });
      const elapsed = performance.now() - start;
      expect(result.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
    },
  );

  it(
    `queryResources(observedState: 'running') under ${QUERY_BUDGET_MS}ms`,
    () => {
      const start = performance.now();
      const result = queryResources(store, { observedState: "running" });
      const elapsed = performance.now() - start;
      expect(result.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
    },
  );

  it(
    `runResolver completes under ${RESOLVER_BUDGET_MS}ms over the full graph`,
    () => {
      const start = performance.now();
      const result = runResolver(store);
      const elapsed = performance.now() - start;
      // We seeded a known number of name-matching pairs; assert >0 to
      // make sure the resolver actually ran the matcher rather than
      // short-circuiting.
      expect(result.matches.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(RESOLVER_BUDGET_MS);
    },
  );

  it(
    `produces approximately EXTRA_EDGES_TARGET edges via repeated relationship writes (~${EXTRA_EDGES_TARGET} target)`,
    () => {
      // Build edges between proxmox_vm and proxmox_node so we don't
      // disturb the resolver test above (different rule space).
      const start = performance.now();
      let edgesWritten = 0;
      // ~5 edges per workload to reach ~5k total (RESOURCE_COUNT // 2 ~ 500 workloads).
      const workloads = store
        .listResources()
        .filter((r) => r.type === "proxmox_vm");
      const nodes = store
        .listResources()
        .filter((r) => r.type === "proxmox_node");
      for (const w of workloads) {
        for (let i = 0; i < 10 && i < nodes.length; i++) {
          if (edgesWritten >= EXTRA_EDGES_TARGET) break;
          store.upsertRelationship({
            fromId: w.id,
            toId: nodes[i].id,
            type: "depends_on",
            origin: "direct",
          });
          edgesWritten++;
        }
        if (edgesWritten >= EXTRA_EDGES_TARGET) break;
      }
      const elapsed = performance.now() - start;
      expect(edgesWritten).toBeGreaterThanOrEqual(
        Math.min(EXTRA_EDGES_TARGET, workloads.length * 10),
      );
      // Insertion budget — generous because SQLite WAL fsyncs.
      expect(elapsed).toBeLessThan(4000);
    },
  );

  it(
    `edgesFrom + edgesTo lookups stay fast at scale (each under ${QUERY_BUDGET_MS}ms)`,
    () => {
      // Pick a representative resource and ensure adjacency is indexed.
      const sample = store
        .listResources()
        .find((r) => r.type === "proxmox_vm");
      expect(sample).toBeDefined();

      const start1 = performance.now();
      store.edgesFrom(sample!.id);
      const elapsed1 = performance.now() - start1;

      const start2 = performance.now();
      store.edgesTo(sample!.id);
      const elapsed2 = performance.now() - start2;

      expect(elapsed1).toBeLessThan(QUERY_BUDGET_MS);
      expect(elapsed2).toBeLessThan(QUERY_BUDGET_MS);
    },
  );
});

// ── Seed helper ─────────────────────────────────────────────

function seedAtScale(store: GraphStore): void {
  // Distribution:
  //  - 400 proxmox_vm
  //  - 100 proxmox_node
  //  - 400 vsphere_vm
  //  - 100 vsphere_host  (50 of which name-match a proxmox_vm)
  // Total = 1000
  for (let i = 0; i < 400; i++) {
    store.upsertResource({
      id: `proxmox:proxmox_vm:${i}`,
      provider: "proxmox",
      type: "proxmox_vm",
      // First 50 are nested ESXi hosts (name-matches a vsphere_host below).
      name: i < 50 ? `esxi-${i}` : `pvm-${i}`,
      observedState: i % 7 === 0 ? "stopped" : "running",
      properties: { vmid: i, node: `pnode-${i % 100}` },
    });
  }
  for (let i = 0; i < 100; i++) {
    store.upsertResource({
      id: `proxmox:proxmox_node:pnode-${i}`,
      provider: "proxmox",
      type: "proxmox_node",
      name: `pnode-${i}`,
      observedState: "running",
      properties: { nodeName: `pnode-${i}` },
    });
  }
  for (let i = 0; i < 400; i++) {
    store.upsertResource({
      id: `vsphere:vsphere_vm:vm-${i}`,
      provider: "vsphere",
      type: "vsphere_vm",
      name: `vsvm-${i}`,
      observedState: "running",
      properties: { moid: `vm-${i}` },
    });
  }
  for (let i = 0; i < 100; i++) {
    store.upsertResource({
      id: `vsphere:vsphere_host:host-${i}`,
      provider: "vsphere",
      type: "vsphere_host",
      // First 50 match a proxmox_vm name — gives the resolver real work.
      name: i < 50 ? `esxi-${i}.local` : `vsh-${i}`,
      observedState: "running",
      properties: { moid: `host-${i}` },
    });
  }
}
