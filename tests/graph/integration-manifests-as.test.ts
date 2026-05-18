// ============================================================
// Graph Integration — manifests_as resolver end-to-end
//
// The canonical nested-lab scenario: a Proxmox VM (vmid 200) IS
// a vSphere ESXi host (esxi-01). Both providers discover their
// own perspective; the resolver infers the `manifests_as` edge;
// a query can traverse from one perspective to the other.
//
// This is the killer demo for substrate-agnostic schema
// validation — if this test passes against synthetic data
// shaped like the actual nested lab, we know the schema can
// represent the dual-perspective reality our adapters will
// produce in v0.6.0.
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

describe("manifests_as resolver — nested-lab scenario", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-integ-"));
    store = new GraphStore(join(dir, "graph.db"));

    // Both providers register their resource types
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
      provider: "vsphere",
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "maintenance", "disconnected", "unknown"],
      propertiesSchema: z.object({
        moid: z.string(),
        connectionState: z.string(),
      }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links Proxmox vmid 200 to vSphere host esxi-01 via name match", () => {
    // Proxmox sees: VM named "esxi-01" with vmid 200 running on pranavlab
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    // vSphere sees: a hypervisor host named "esxi-01.local"
    store.upsertResource({
      id: "vsphere:vsphere_host:host-1",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01.local",
      observedState: "running",
      properties: { moid: "host-1", connectionState: "connected" },
    });

    const { matches, edgesUpserted } = runResolver(store);
    expect(matches).toHaveLength(1);
    expect(edgesUpserted).toBe(1);
    expect(matches[0].fromId).toBe("proxmox:proxmox_vm:200");
    expect(matches[0].toId).toBe("vsphere:vsphere_host:host-1");

    // The edge exists and traverses cleanly in both directions
    const outgoing = store.edgesFrom(
      "proxmox:proxmox_vm:200",
      "manifests_as",
    );
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toId).toBe("vsphere:vsphere_host:host-1");
    expect(outgoing[0].origin).toBe("inferred");

    const incoming = store.edgesTo(
      "vsphere:vsphere_host:host-1",
      "manifests_as",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0].fromId).toBe("proxmox:proxmox_vm:200");
  });

  it("re-running the resolver is idempotent (no duplicate edges)", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-1",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01",
      observedState: "running",
      properties: { moid: "host-1", connectionState: "connected" },
    });
    runResolver(store);
    runResolver(store);
    runResolver(store);
    expect(store.listRelationships()).toHaveLength(1);
  });

  it("doesn't link unrelated resources (no false-positive matches)", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:101",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "jellyfin",
      observedState: "running",
      properties: { vmid: 101, node: "pranavlab" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-1",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01",
      observedState: "running",
      properties: { moid: "host-1", connectionState: "connected" },
    });
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(0);
    expect(store.listRelationships()).toHaveLength(0);
  });

  it("answers the unified-view query: list all ComputeNode-shaped things in the lab", () => {
    // Multiple Proxmox VMs that happen to be ESXi hosts in the nested cluster
    store.upsertResource({
      id: "proxmox:proxmox_vm:200",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-01",
      observedState: "running",
      properties: { vmid: 200, node: "pranavlab" },
    });
    store.upsertResource({
      id: "proxmox:proxmox_vm:201",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-02",
      observedState: "running",
      properties: { vmid: 201, node: "pranavlab" },
    });
    // The vSphere perspective: it sees both as hosts
    store.upsertResource({
      id: "vsphere:vsphere_host:host-1",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-01",
      observedState: "running",
      properties: { moid: "host-1", connectionState: "connected" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-2",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-02",
      observedState: "running",
      properties: { moid: "host-2", connectionState: "connected" },
    });

    runResolver(store);

    // ComputeNode interface label returns vSphere hosts only — the
    // Proxmox-VM perspective doesn't carry that label (it's a workload,
    // not a node, from Proxmox's POV). manifests_as bridges the gap.
    const computeNodes = queryResources(store, {
      interfaceLabel: "ComputeNode",
    });
    expect(computeNodes).toHaveLength(2);
    expect(computeNodes.map((r) => r.name).sort()).toEqual([
      "esxi-01",
      "esxi-02",
    ]);

    // ComputeWorkload returns the Proxmox-side perspective
    const workloads = queryResources(store, {
      interfaceLabel: "ComputeWorkload",
    });
    expect(workloads).toHaveLength(2);

    // The graph has 2 manifests_as edges connecting the perspectives
    expect(store.listRelationships()).toHaveLength(2);
  });
});
