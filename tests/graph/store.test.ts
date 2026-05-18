// ============================================================
// Graph Store — write-time validation, upsert semantics, edges,
// conditions, registry enforcement.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GraphNotRegisteredError,
  GraphSchemaError,
  GraphStore,
  z,
} from "../../src/graph/index.js";

describe("GraphStore", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-test-"));
    store = new GraphStore(join(dir, "graph.db"));

    // Minimal registrations used across tests
    store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "paused", "unknown"],
      propertiesSchema: z.object({
        vmid: z.number(),
        node: z.string(),
      }),
    });
    store.registerResourceType({
      provider: "vsphere",
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "maintenance", "disconnected", "unknown"],
      propertiesSchema: z.object({
        cpuCores: z.number(),
      }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects writes for unregistered (provider, type)", () => {
    expect(() =>
      store.upsertResource({
        id: "aws:aws_ec2_instance:i-abc",
        provider: "aws",
        type: "aws_ec2_instance",
        name: "demo",
        observedState: "running",
        properties: {},
      }),
    ).toThrow(GraphNotRegisteredError);
  });

  it("rejects writes whose state is not in allowedStates", () => {
    expect(() =>
      store.upsertResource({
        id: "proxmox:proxmox_vm:200",
        provider: "proxmox",
        type: "proxmox_vm",
        name: "esxi-01",
        observedState: "error" /* not in allowedStates */,
        properties: { vmid: 200, node: "pranavlab" },
      }),
    ).toThrow(GraphSchemaError);
  });

  it("rejects writes whose properties fail zod schema", () => {
    expect(() =>
      store.upsertResource({
        id: "proxmox:proxmox_vm:200",
        provider: "proxmox",
        type: "proxmox_vm",
        name: "esxi-01",
        observedState: "running",
        // missing required `vmid` field
        properties: { node: "pranavlab" },
      }),
    ).toThrow(GraphSchemaError);
  });

  it("upserts a resource and preserves discovered_at on re-write", async () => {
    const first = store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });

    // Wait a moment so timestamps would differ if mismanaged
    await new Promise((r) => setTimeout(r, 10));

    const second = store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });

    expect(second.discoveredAt).toBe(first.discoveredAt);
    expect(second.lastObservedAt).not.toBe(first.lastObservedAt);
    // State didn't change → lastChangedAt is preserved
    expect(second.lastChangedAt).toBe(first.lastChangedAt);
  });

  it("bumps last_changed_at when observed_state transitions", async () => {
    const first = store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const second = store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "stopped",
      properties: { vmid: 200, node: "pranavlab" },
    });
    expect(second.lastChangedAt).not.toBe(first.lastChangedAt);
  });

  it("upserts a relationship idempotently (no duplicates on re-assert)", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-esxi-01",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01",
      observedState: "running",
      properties: { cpuCores: 8 },
    });
    store.upsertRelationship({
      fromId: "proxmox:proxmox_vm:200",
      toId: "vsphere:vsphere_host:host-esxi-01",
      type: "manifests_as",
      origin: "inferred",
    });
    store.upsertRelationship({
      fromId: "proxmox:proxmox_vm:200",
      toId: "vsphere:vsphere_host:host-esxi-01",
      type: "manifests_as",
      origin: "inferred",
    });
    expect(store.listRelationships()).toHaveLength(1);
  });

  it("cascades delete: removing a resource removes its edges", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-esxi-01",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01",
      observedState: "running",
      properties: { cpuCores: 8 },
    });
    store.upsertRelationship({
      fromId: "proxmox:proxmox_vm:200",
      toId: "vsphere:vsphere_host:host-esxi-01",
      type: "manifests_as",
      origin: "inferred",
    });
    store.deleteResource("proxmox:proxmox_vm:200");
    expect(store.listRelationships()).toHaveLength(0);
  });

  it("conditions: orthogonal signals don't collide with observedState", async () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    const cond1 = store.upsertCondition({
      resourceId: "proxmox:proxmox_vm:200",
      type: "Reachable",
      status: "true",
    });
    await new Promise((r) => setTimeout(r, 10));
    const cond2 = store.upsertCondition({
      resourceId: "proxmox:proxmox_vm:200",
      type: "Reachable",
      status: "true", // unchanged → lastTransitionAt preserved
    });
    expect(cond2.lastTransitionAt).toBe(cond1.lastTransitionAt);

    const cond3 = store.upsertCondition({
      resourceId: "proxmox:proxmox_vm:200",
      type: "Reachable",
      status: "false", // changed
      reason: "ping_failed",
    });
    expect(cond3.lastTransitionAt).not.toBe(cond1.lastTransitionAt);
    expect(store.conditionsFor("proxmox:proxmox_vm:200")).toHaveLength(1);
  });
});
