// ============================================================
// VMware Graph Writer — registration is idempotent, discovery
// upserts the right resource types, edges have origin: 'direct',
// empty client returns don't crash.
//
// All tests run against an in-process GraphStore pointed at a temp
// SQLite file plus a hand-rolled FakeVmwareDiscoveryClient. No real
// vSphere connection is ever attempted.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GraphStore } from "../../src/graph/index.js";
import {
  VmwareGraphWriter,
  type VmPlacement,
  type HostPlacement,
  type VmwareDiscoveryClient,
} from "../../src/providers/vmware/graph-writer.js";
import type {
  ClusterSummary,
  DatastoreSummary,
  HostSummary,
  VmSummary,
} from "../../src/providers/vmware/types.js";

// ── Fake client ────────────────────────────────────────────

interface FakeClientSeed {
  hosts?: HostSummary[];
  vms?: VmSummary[];
  datastores?: DatastoreSummary[];
  clusters?: ClusterSummary[];
  vmPlacements?: Record<string, VmPlacement>;
  hostPlacements?: Record<string, HostPlacement>;
}

class FakeVmwareDiscoveryClient implements VmwareDiscoveryClient {
  constructor(private readonly seed: FakeClientSeed) {}
  async listHosts(): Promise<HostSummary[]> {
    return this.seed.hosts ?? [];
  }
  async listVMs(): Promise<VmSummary[]> {
    return this.seed.vms ?? [];
  }
  async listDatastores(): Promise<DatastoreSummary[]> {
    return this.seed.datastores ?? [];
  }
  async listClusters(): Promise<ClusterSummary[]> {
    return this.seed.clusters ?? [];
  }
  async getVmPlacement(vmId: string): Promise<VmPlacement> {
    return (
      this.seed.vmPlacements?.[vmId] ?? { hostId: "", datastoreIds: [] }
    );
  }
  async getHostPlacement(hostId: string): Promise<HostPlacement> {
    return this.seed.hostPlacements?.[hostId] ?? {};
  }
}

// ── Fixtures ───────────────────────────────────────────────

const FIXTURE: FakeClientSeed = {
  clusters: [
    {
      cluster: "domain-c100",
      name: "lab-cluster",
      ha_enabled: true,
      drs_enabled: false,
    },
  ],
  hosts: [
    {
      host: "host-10",
      name: "esxi-01.lab.local",
      connection_state: "CONNECTED",
      power_state: "POWERED_ON",
    },
    {
      host: "host-11",
      name: "esxi-02.lab.local",
      connection_state: "NOT_RESPONDING",
    },
  ],
  datastores: [
    {
      datastore: "datastore-50",
      name: "ds-shared",
      type: "VMFS",
      capacity: 1024 * 1024 * 1024 * 1024,
      free_space: 500 * 1024 * 1024 * 1024,
    },
    {
      datastore: "datastore-51",
      name: "ds-local-01",
      type: "VMFS",
    },
  ],
  vms: [
    {
      vm: "vm-200",
      name: "win11-tester",
      power_state: "POWERED_ON",
      cpu_count: 4,
      memory_size_MiB: 8192,
    },
    {
      vm: "vm-201",
      name: "nested-esxi",
      power_state: "POWERED_OFF",
    },
  ],
  vmPlacements: {
    "vm-200": { hostId: "host-10", datastoreIds: ["datastore-50"] },
    "vm-201": {
      hostId: "host-11",
      datastoreIds: ["datastore-50", "datastore-51"],
    },
  },
  hostPlacements: {
    "host-10": { clusterId: "domain-c100" },
    "host-11": { clusterId: "domain-c100" },
  },
};

// ── Test harness ───────────────────────────────────────────

describe("VmwareGraphWriter", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-vmware-graph-test-"));
    store = new GraphStore(join(dir, "graph.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeWriter(seed: FakeClientSeed = FIXTURE): VmwareGraphWriter {
    return new VmwareGraphWriter(
      store,
      new FakeVmwareDiscoveryClient(seed),
      { uid: "vcenter.lab.local", name: "lab-vcenter", version: "8.0.2" },
    );
  }

  // ── Registration ──────────────────────────────────────────

  describe("registerTypes()", () => {
    it("registers all five vSphere resource types", () => {
      const w = makeWriter();
      w.registerTypes();

      for (const type of [
        "vsphere_host",
        "vsphere_vm",
        "vsphere_cluster",
        "vsphere_datastore",
        "vsphere_vcenter",
      ] as const) {
        expect(store.getRegistration("vsphere", type)).toBeDefined();
      }
    });

    it("registers correct interface labels per type", () => {
      const w = makeWriter();
      w.registerTypes();

      expect(
        store.getRegistration("vsphere", "vsphere_host")?.interfaceLabels,
      ).toEqual(["ComputeNode"]);
      expect(
        store.getRegistration("vsphere", "vsphere_vm")?.interfaceLabels,
      ).toEqual(["ComputeWorkload"]);
      expect(
        store.getRegistration("vsphere", "vsphere_cluster")?.interfaceLabels,
      ).toEqual(["Cluster"]);
      expect(
        store.getRegistration("vsphere", "vsphere_datastore")?.interfaceLabels,
      ).toEqual(["Storage"]);
      expect(
        store.getRegistration("vsphere", "vsphere_vcenter")?.interfaceLabels,
      ).toEqual(["ControlPlane"]);
    });

    it("is idempotent — re-registering doesn't throw or duplicate", () => {
      const w = makeWriter();
      w.registerTypes();
      expect(() => w.registerTypes()).not.toThrow();
      expect(() => w.registerTypes()).not.toThrow();

      // Still exactly one registration per (provider, type).
      expect(store.getRegistration("vsphere", "vsphere_vm")).toBeDefined();
    });
  });

  // ── Discovery — preconditions ─────────────────────────────

  describe("discover() preconditions", () => {
    it("throws if registerTypes() was not called first", async () => {
      const w = makeWriter();
      await expect(w.discover()).rejects.toThrow(/registerTypes/);
    });
  });

  // ── Discovery — happy path ────────────────────────────────

  describe("discover() with full fixture", () => {
    it("upserts vCenter as a vsphere_vcenter resource", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const vc = store.getResource(
        "vsphere:vsphere_vcenter:vcenter.lab.local",
      );
      expect(vc).not.toBeNull();
      expect(vc?.type).toBe("vsphere_vcenter");
      expect(vc?.interfaceLabels).toEqual(["ControlPlane"]);
      expect(vc?.observedState).toBe("running");
      expect(vc?.properties).toMatchObject({
        uid: "vcenter.lab.local",
        version: "8.0.2",
      });
    });

    it("upserts every cluster as a vsphere_cluster resource", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const c = store.getResource("vsphere:vsphere_cluster:domain-c100");
      expect(c).not.toBeNull();
      expect(c?.type).toBe("vsphere_cluster");
      expect(c?.interfaceLabels).toEqual(["Cluster"]);
      expect(c?.properties).toMatchObject({
        moid: "domain-c100",
        haEnabled: true,
        drsEnabled: false,
      });
    });

    it("upserts every host as a vsphere_host resource with mapped state", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const h1 = store.getResource("vsphere:vsphere_host:host-10");
      expect(h1?.observedState).toBe("running"); // CONNECTED → running
      expect(h1?.properties).toMatchObject({
        moid: "host-10",
        connectionState: "CONNECTED",
        powerState: "POWERED_ON",
      });

      const h2 = store.getResource("vsphere:vsphere_host:host-11");
      expect(h2?.observedState).toBe("disconnected"); // NOT_RESPONDING → disconnected
    });

    it("upserts every datastore as a vsphere_datastore resource", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const d = store.getResource("vsphere:vsphere_datastore:datastore-50");
      expect(d).not.toBeNull();
      expect(d?.interfaceLabels).toEqual(["Storage"]);
      expect(d?.observedState).toBe("accessible");
      expect(d?.properties).toMatchObject({
        moid: "datastore-50",
        type: "VMFS",
        capacityBytes: 1024 * 1024 * 1024 * 1024,
      });
    });

    it("upserts every VM as a vsphere_vm resource with mapped power state", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const v1 = store.getResource("vsphere:vsphere_vm:vm-200");
      expect(v1?.observedState).toBe("running");
      expect(v1?.interfaceLabels).toEqual(["ComputeWorkload"]);
      expect(v1?.properties).toMatchObject({
        moid: "vm-200",
        powerState: "POWERED_ON",
        cpuCount: 4,
        memoryMiB: 8192,
      });

      const v2 = store.getResource("vsphere:vsphere_vm:vm-201");
      expect(v2?.observedState).toBe("stopped");
    });

    // ── Relationships ──────────────────────────────────────

    it("upserts runs_on edges from VM to host", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const edges = store.edgesFrom(
        "vsphere:vsphere_vm:vm-200",
        "runs_on",
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].toId).toBe("vsphere:vsphere_host:host-10");
      expect(edges[0].origin).toBe("direct");

      const e2 = store.edgesFrom("vsphere:vsphere_vm:vm-201", "runs_on");
      expect(e2[0].toId).toBe("vsphere:vsphere_host:host-11");
    });

    it("upserts mounts edges from VM to each of its datastores", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const v200 = store.edgesFrom(
        "vsphere:vsphere_vm:vm-200",
        "mounts",
      );
      expect(v200).toHaveLength(1);
      expect(v200[0].toId).toBe("vsphere:vsphere_datastore:datastore-50");
      expect(v200[0].origin).toBe("direct");

      const v201 = store.edgesFrom(
        "vsphere:vsphere_vm:vm-201",
        "mounts",
      );
      expect(v201).toHaveLength(2);
      const targets = v201.map((e) => e.toId).sort();
      expect(targets).toEqual([
        "vsphere:vsphere_datastore:datastore-50",
        "vsphere:vsphere_datastore:datastore-51",
      ]);
      expect(v201.every((e) => e.origin === "direct")).toBe(true);
    });

    it("upserts member_of edges from host to cluster", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      for (const hostId of ["host-10", "host-11"]) {
        const edges = store.edgesFrom(
          `vsphere:vsphere_host:${hostId}`,
          "member_of",
        );
        expect(edges).toHaveLength(1);
        expect(edges[0].toId).toBe("vsphere:vsphere_cluster:domain-c100");
        expect(edges[0].origin).toBe("direct");
      }
    });

    it("upserts managed_by edges from cluster to vCenter", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const edges = store.edgesFrom(
        "vsphere:vsphere_cluster:domain-c100",
        "managed_by",
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].toId).toBe(
        "vsphere:vsphere_vcenter:vcenter.lab.local",
      );
      expect(edges[0].origin).toBe("direct");
    });

    it("returns a discovery report with correct counts", async () => {
      const w = makeWriter();
      w.registerTypes();
      const report = await w.discover();

      expect(report).toEqual({
        vcenters: 1,
        clusters: 1,
        hosts: 2,
        datastores: 2,
        vms: 2,
        // 1 managed_by + 2 member_of + 2 runs_on + 3 mounts = 8
        relationships: 8,
      });
    });

    it("never marks a discovered edge as inferred", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();

      const all = store.listRelationships();
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((r) => r.origin === "direct")).toBe(true);
    });

    it("is idempotent — calling discover() twice doesn't duplicate edges", async () => {
      const w = makeWriter();
      w.registerTypes();
      await w.discover();
      const firstCount = store.listRelationships().length;
      const firstResources = store.listResources().length;

      await w.discover();
      expect(store.listRelationships().length).toBe(firstCount);
      expect(store.listResources().length).toBe(firstResources);
    });
  });

  // ── Empty lists ────────────────────────────────────────────

  describe("discover() with empty client responses", () => {
    it("doesn't crash and still upserts the vCenter root", async () => {
      const w = makeWriter({});
      w.registerTypes();
      const report = await w.discover();

      expect(report).toEqual({
        vcenters: 1,
        clusters: 0,
        hosts: 0,
        datastores: 0,
        vms: 0,
        relationships: 0,
      });
      expect(
        store.getResource("vsphere:vsphere_vcenter:vcenter.lab.local"),
      ).not.toBeNull();
      expect(store.listRelationships()).toEqual([]);
    });

    it("skips member_of edge when host has no cluster placement", async () => {
      const w = makeWriter({
        clusters: [],
        hosts: [
          {
            host: "host-orphan",
            name: "standalone.lab",
            connection_state: "CONNECTED",
          },
        ],
        hostPlacements: { "host-orphan": {} }, // no clusterId
      });
      w.registerTypes();
      await w.discover();

      expect(
        store.edgesFrom("vsphere:vsphere_host:host-orphan", "member_of"),
      ).toHaveLength(0);
      // host itself was still created
      expect(
        store.getResource("vsphere:vsphere_host:host-orphan"),
      ).not.toBeNull();
    });
  });
});
