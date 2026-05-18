// ============================================================
// Graph Schema Evolution — what happens when an adapter's
// registered zod schema changes between two store boots?
//
// The schema-registry table is durable (audit row), but the
// runtime zod schema lives in memory. The store should:
//   - Read prior rows that were valid under the OLD schema
//     even when the NEW schema would have rejected them.
//   - Validate NEW writes against the NEW schema.
//   - Never corrupt existing rows during the transition.
//
// Companion to:
//   - tests/graph/store.test.ts (validation happens at write time)
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GraphSchemaError,
  GraphStore,
  z,
} from "../../src/graph/index.js";

describe("schema evolution across store re-opens", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-evolution-"));
    dbPath = join(dir, "graph.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adding an optional field (LOOSER schema) preserves old data and accepts new writes", () => {
    // Boot 1 — schema A: { vmid, node }
    const storeA = new GraphStore(dbPath);
    storeA.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({
        vmid: z.number(),
        node: z.string(),
      }),
    });
    storeA.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    storeA.close();

    // Boot 2 — schema B: schema A + an optional `tags` field
    const storeB = new GraphStore(dbPath);
    storeB.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({
        vmid: z.number(),
        node: z.string(),
        tags: z.string().optional(),
      }),
    });

    // Old data reads cleanly — the optional field is absent, no error.
    const old = storeB.getResource("proxmox:proxmox_vm:200");
    expect(old).not.toBeNull();
    expect(old!.properties.vmid).toBe(200);
    expect(old!.properties.node).toBe("pranavlab");
    expect(old!.properties.tags).toBeUndefined();

    // New writes can use the new field.
    storeB.upsertResource({
      id: "proxmox:proxmox_vm:201",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-02",
      observedState: "running",
      properties: { vmid: 201, node: "pranavlab", tags: "prod;esxi" },
    });
    const nw = storeB.getResource("proxmox:proxmox_vm:201");
    expect(nw!.properties.tags).toBe("prod;esxi");
    storeB.close();
  });

  it("TIGHTER schema does not corrupt or delete old rows; reads still succeed", () => {
    // Boot 1 — schema A: vmid + optional `legacy_field`
    const storeA = new GraphStore(dbPath);
    storeA.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({
        vmid: z.number(),
        node: z.string(),
        legacy_field: z.string().optional(),
      }),
    });
    storeA.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: {
        vmid: 200,
        node: "pranavlab",
        legacy_field: "old-and-busted",
      },
    });
    storeA.close();

    // Boot 2 — schema B drops `legacy_field` and requires a new mandatory field.
    const storeB = new GraphStore(dbPath);
    storeB.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z
        .object({
          vmid: z.number(),
          node: z.string(),
          cluster: z.string(), // new mandatory field
        })
        .strict(),
    });

    // The old row STILL reads — store.getResource() does not re-validate
    // on read. The legacy_field is preserved in the persisted JSON.
    const old = storeB.getResource("proxmox:proxmox_vm:200");
    expect(old).not.toBeNull();
    expect(old!.properties.vmid).toBe(200);
    expect(old!.properties.legacy_field).toBe("old-and-busted");

    // A NEW write that omits the now-required `cluster` field is rejected.
    expect(() =>
      storeB.upsertResource({
        id: "proxmox:proxmox_vm:201",
        provider: "proxmox",
        type: "proxmox_vm",
        name: "esxi-02",
        observedState: "running",
        properties: { vmid: 201, node: "pranavlab" },
      }),
    ).toThrow(GraphSchemaError);

    // The original row is untouched after the failed write.
    const still = storeB.getResource("proxmox:proxmox_vm:200");
    expect(still!.properties.legacy_field).toBe("old-and-busted");

    // A new write with the required field succeeds.
    storeB.upsertResource({
      id: "proxmox:proxmox_vm:202",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-03",
      observedState: "running",
      properties: { vmid: 202, node: "pranavlab", cluster: "prod-cluster" },
    });
    const fresh = storeB.getResource("proxmox:proxmox_vm:202");
    expect(fresh!.properties.cluster).toBe("prod-cluster");

    storeB.close();
  });

  it("re-registering with a NEW allowedStates list affects new writes only", () => {
    const storeA = new GraphStore(dbPath);
    storeA.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "paused", "unknown"],
      propertiesSchema: z.object({ vmid: z.number(), node: z.string() }),
    });
    storeA.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "paused",
      properties: { vmid: 200, node: "pranavlab" },
    });
    storeA.close();

    // Boot 2 — allowedStates dropped `paused`.
    const storeB = new GraphStore(dbPath);
    storeB.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({ vmid: z.number(), node: z.string() }),
    });

    // Old row reads — even though its state isn't in the new allowedStates.
    const old = storeB.getResource("proxmox:proxmox_vm:200");
    expect(old).not.toBeNull();
    expect(old!.observedState).toBe("paused");

    // A NEW write with `paused` is rejected.
    expect(() =>
      storeB.upsertResource({
        id: "proxmox:proxmox_vm:201",
        provider: "proxmox",
        type: "proxmox_vm",
        name: "esxi-02",
        observedState: "paused",
        properties: { vmid: 201, node: "pranavlab" },
      }),
    ).toThrow(GraphSchemaError);

    storeB.close();
  });

  it("the audit row in resource_type_registry reflects the latest registration", () => {
    const storeA = new GraphStore(dbPath);
    storeA.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "unknown"],
      propertiesSchema: z.object({ vmid: z.number() }),
    });
    storeA.close();

    const storeB = new GraphStore(dbPath);
    storeB.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({ vmid: z.number(), node: z.string() }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (storeB as any).db as import("better-sqlite3").Database;
    const row = db
      .prepare(
        "SELECT allowed_states FROM resource_type_registry WHERE provider = ? AND type = ?",
      )
      .get("proxmox", "proxmox_vm") as { allowed_states: string };
    const states = JSON.parse(row.allowed_states) as string[];
    expect(states).toEqual(["running", "stopped", "unknown"]);

    storeB.close();
  });
});
