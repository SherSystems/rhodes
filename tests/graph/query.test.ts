// ============================================================
// Graph Query — 3-mode queries, freshness annotation, label filtering
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FRESHNESS_WINDOW_SEC,
  GraphStore,
  queryResources,
  z,
} from "../../src/graph/index.js";

describe("queryResources", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-q-test-"));
    store = new GraphStore(join(dir, "graph.db"));
    store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({ vmid: z.number() }),
    });
    store.registerResourceType({
      provider: "vsphere",
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "maintenance", "unknown"],
      propertiesSchema: z.object({ cpuCores: z.number() }),
    });
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200 },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-esxi-01",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01",
      observedState: "running",
      properties: { cpuCores: 8 },
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters by provider", () => {
    const proxmox = queryResources(store, { provider: "proxmox" });
    expect(proxmox).toHaveLength(1);
    expect(proxmox[0].provider).toBe("proxmox");
  });

  it("filters by interfaceLabel via JSON traversal", () => {
    const workloads = queryResources(store, {
      interfaceLabel: "ComputeWorkload",
    });
    const nodes = queryResources(store, { interfaceLabel: "ComputeNode" });
    expect(workloads).toHaveLength(1);
    expect(workloads[0].type).toBe("proxmox_vm");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("vsphere_host");
  });

  it("filters by observedState", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:201",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-02",
      observedState: "stopped",
      properties: { vmid: 201 },
    });
    const running = queryResources(store, {
      provider: "proxmox",
      observedState: "running",
    });
    expect(running).toHaveLength(1);
    expect(running[0].name).toBe("esxi-01");
  });

  it("annotates ageSec and isStale on every row (staleAllowed mode)", () => {
    const all = queryResources(store, { mode: "staleAllowed" });
    for (const r of all) {
      expect(typeof r.ageSec).toBe("number");
      expect(typeof r.isStale).toBe("boolean");
      // Just-written rows should be fresh
      expect(r.isStale).toBe(false);
      expect(r.ageSec).toBeLessThan(5);
    }
  });

  it("'fresh' mode filters out stale rows; 'staleAllowed' includes them", () => {
    // Force a row to appear stale by rewinding its last_observed_at far past
    // the freshness window. Reach into the db directly only because tests own
    // their fixture.
    const oldIso = new Date(
      Date.now() -
        (FRESHNESS_WINDOW_SEC.proxmox_vm + 60) * 1000,
    ).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db as import("better-sqlite3").Database;
    db.prepare(
      "UPDATE resources SET last_observed_at = ? WHERE id = ?",
    ).run(oldIso, "proxmox:proxmox_vm:200");

    const fresh = queryResources(store, { mode: "fresh" });
    const allowed = queryResources(store, { mode: "staleAllowed" });
    expect(fresh.find((r) => r.id === "proxmox:proxmox_vm:200")).toBeUndefined();
    const stale = allowed.find((r) => r.id === "proxmox:proxmox_vm:200");
    expect(stale).toBeDefined();
    expect(stale!.isStale).toBe(true);
  });
});
