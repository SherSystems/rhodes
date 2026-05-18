// ============================================================
// Graph Concurrency — racing writes against the same resource id.
//
// SQLite is single-writer; better-sqlite3 serializes per-database
// at the API level. But the GraphStore.upsertResource path does a
// READ (getResource → prior) followed by a WRITE (UPSERT) without
// a wrapping transaction. Two concurrent calls can interleave such
// that both observe the same "prior" snapshot. We pin down the
// observable end state: deterministic last-write-wins, no row
// corruption, no orphaned columns.
//
// Companion to:
//   - tests/graph/store.test.ts (single-writer correctness)
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore, z } from "../../src/graph/index.js";

describe("GraphStore concurrent writes", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-concurrency-"));
    store = new GraphStore(join(dir, "graph.db"));

    store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "paused", "unknown"],
      propertiesSchema: z.object({
        vmid: z.number(),
        node: z.string(),
        writer: z.string().optional(),
      }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("two racing writers leave a single coherent row (no corruption)", async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() =>
        store.upsertResource({
          id: "proxmox:proxmox_vm:200",
          provider: "proxmox",
          type: "proxmox_vm",
          name: "esxi-01",
          observedState: i % 2 === 0 ? "running" : "stopped",
          properties: { vmid: 200, node: "pranavlab", writer: `w-${i}` },
        }),
      ),
    );
    await Promise.all(writes);

    const final = store.getResource("proxmox:proxmox_vm:200");
    expect(final).not.toBeNull();
    // Whatever the last write was, the row is internally consistent.
    expect(final!.id).toBe("proxmox:proxmox_vm:200");
    expect(final!.properties.vmid).toBe(200);
    expect(final!.properties.node).toBe("pranavlab");
    // The writer tag should match one of the writers we issued.
    expect(typeof final!.properties.writer).toBe("string");
    expect(String(final!.properties.writer)).toMatch(/^w-\d+$/);
    // Only one physical row exists.
    expect(store.listResources()).toHaveLength(1);
  });

  it("racing observedState transitions converge to a value from the input set", async () => {
    const states: Array<"running" | "stopped" | "paused"> = [
      "running",
      "stopped",
      "paused",
    ];
    const writes = Array.from({ length: 30 }, (_, i) =>
      Promise.resolve().then(() =>
        store.upsertResource({
          id: "proxmox:proxmox_vm:300",
          provider: "proxmox",
          type: "proxmox_vm",
          name: "vm-300",
          observedState: states[i % states.length],
          properties: { vmid: 300, node: "pranavlab" },
        }),
      ),
    );
    await Promise.all(writes);

    const final = store.getResource("proxmox:proxmox_vm:300");
    expect(final).not.toBeNull();
    expect(states).toContain(final!.observedState);
  });

  it("racing writes to DIFFERENT ids do not interfere", async () => {
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(
        Promise.resolve().then(() =>
          store.upsertResource({
            id: `proxmox:proxmox_vm:${1000 + i}`,
            provider: "proxmox",
            type: "proxmox_vm",
            name: `vm-${i}`,
            observedState: "running",
            properties: { vmid: 1000 + i, node: "pranavlab" },
          }),
        ),
      );
    }
    await Promise.all(writes);

    const all = store.listResources();
    expect(all.length).toBe(50);
    // All ids unique
    expect(new Set(all.map((r) => r.id)).size).toBe(50);
  });

  it("racing relationship upserts against the same edge dedupes via UNIQUE", async () => {
    // Seed the endpoints first.
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    store.registerResourceType({
      provider: "vsphere",
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "unknown"],
      propertiesSchema: z.object({ moid: z.string() }),
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-1",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01.local",
      observedState: "running",
      properties: { moid: "host-1" },
    });

    const writes = Array.from({ length: 25 }, () =>
      Promise.resolve().then(() =>
        store.upsertRelationship({
          fromId: "proxmox:proxmox_vm:200",
          toId: "vsphere:vsphere_host:host-1",
          type: "manifests_as",
          origin: "inferred",
        }),
      ),
    );
    await Promise.all(writes);

    expect(store.listRelationships()).toHaveLength(1);
  });
});
