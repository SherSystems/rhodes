// ============================================================
// End-to-end: Proxmox writer + VMware writer + resolver on
// synthetic dual-perspective data shaped like the actual nested
// lab (the pranavlab Proxmox box runs nested ESXi VMs that
// vCenter also sees as hypervisor hosts).
//
// This proves the substrate-agnostic schema actually holds for
// the dual-perspective case: a single Proxmox VM (vmid 200) and
// a single vSphere host (host-1) get linked by manifests_as, and
// a "what runs on this physical Proxmox node" query crosses the
// edge into the vSphere perspective.
//
// All fakes are inline — no real Proxmox or vSphere is touched.
//
// Companion to:
//   - tests/graph/integration-manifests-as.test.ts (resolver alone)
//   - tests/providers/proxmox-graph-writer.test.ts (Proxmox writer)
//   - tests/providers/vmware-graph-writer.test.ts  (VMware writer)
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GraphStore,
  queryResources,
  runResolver,
} from "../../src/graph/index.js";
import type {
  ProxmoxNode,
  ProxmoxStorage,
  ProxmoxVM,
  ProxmoxVMConfig,
} from "../../src/providers/proxmox/client.js";
import {
  ProxmoxGraphWriter,
  nodeResourceId,
  vmResourceId,
  type ProxmoxDiscoveryClient,
} from "../../src/providers/proxmox/graph-writer.js";
import {
  VmwareGraphWriter,
  type HostPlacement,
  type VmPlacement,
  type VmwareDiscoveryClient,
} from "../../src/providers/vmware/graph-writer.js";
import type {
  ClusterSummary,
  DatastoreSummary,
  HostSummary,
  VmSummary,
} from "../../src/providers/vmware/types.js";

// ── Fake Proxmox client (subset shape) ──────────────────────

class FakeProxmoxClient implements ProxmoxDiscoveryClient {
  constructor(
    private readonly seed: {
      nodes: ProxmoxNode[];
      vmsByNode: Record<string, ProxmoxVM[]>;
      storageByNode?: Record<string, ProxmoxStorage[]>;
      configByVmid?: Record<number, ProxmoxVMConfig>;
    },
  ) {}
  async getNodes() {
    return this.seed.nodes;
  }
  async getVMs(node?: string) {
    return this.seed.vmsByNode[node ?? ""] ?? [];
  }
  async getStorage(node?: string) {
    return this.seed.storageByNode?.[node ?? ""] ?? [];
  }
  async getVMConfig(_node: string, vmid: number) {
    return this.seed.configByVmid?.[vmid] ?? {};
  }
}

// ── Fake vSphere client ─────────────────────────────────────

class FakeVmwareClient implements VmwareDiscoveryClient {
  constructor(
    private readonly seed: {
      hosts: HostSummary[];
      vms: VmSummary[];
      datastores: DatastoreSummary[];
      clusters: ClusterSummary[];
      vmPlacements: Record<string, VmPlacement>;
      hostPlacements: Record<string, HostPlacement>;
    },
  ) {}
  async listHosts() {
    return this.seed.hosts;
  }
  async listVMs() {
    return this.seed.vms;
  }
  async listDatastores() {
    return this.seed.datastores;
  }
  async listClusters() {
    return this.seed.clusters;
  }
  async getVmPlacement(vmId: string) {
    return (
      this.seed.vmPlacements[vmId] ?? { hostId: "", datastoreIds: [] }
    );
  }
  async getHostPlacement(hostId: string) {
    return this.seed.hostPlacements[hostId] ?? {};
  }
}

// ── Synthetic nested-lab fixtures ───────────────────────────
//
// Mirrors the real pranavlab topology in shape:
//   Proxmox node `pranavlab` runs:
//     - vmid 200 (nested ESXi host `esxi-01`)
//     - vmid 201 (nested ESXi host `esxi-02`)
//     - vmid 101 (jellyfin, a normal workload — NOT a nested ESXi)
//   vCenter sees the two nested ESXi hosts as hypervisor hosts
//   in a single cluster, plus a vSphere VM `win11-tester` running
//   on host-1.

const PROXMOX_FIXTURE = {
  nodes: [
    {
      node: "pranavlab",
      status: "online",
      cpu: 0.1,
      maxcpu: 16,
      mem: 8 * 1024 * 1024 * 1024,
      maxmem: 64 * 1024 * 1024 * 1024,
      disk: 100 * 1024 * 1024 * 1024,
      maxdisk: 2 * 1024 * 1024 * 1024 * 1024,
      uptime: 86400,
      id: "node/pranavlab",
      type: "node",
    } satisfies ProxmoxNode,
  ],
  vmsByNode: {
    pranavlab: [
      {
        vmid: 200,
        name: "esxi-01",
        node: "pranavlab",
        status: "running",
        mem: 16 * 1024 * 1024 * 1024,
        maxmem: 32 * 1024 * 1024 * 1024,
        cpu: 0.4,
        cpus: 8,
        maxdisk: 256 * 1024 * 1024 * 1024,
        disk: 0,
        netin: 0,
        netout: 0,
        uptime: 7200,
        type: "qemu" as const,
      },
      {
        vmid: 201,
        name: "esxi-02",
        node: "pranavlab",
        status: "running",
        mem: 16 * 1024 * 1024 * 1024,
        maxmem: 32 * 1024 * 1024 * 1024,
        cpu: 0.3,
        cpus: 8,
        maxdisk: 256 * 1024 * 1024 * 1024,
        disk: 0,
        netin: 0,
        netout: 0,
        uptime: 7200,
        type: "qemu" as const,
      },
      {
        vmid: 101,
        name: "jellyfin",
        node: "pranavlab",
        status: "running",
        mem: 4 * 1024 * 1024 * 1024,
        maxmem: 8 * 1024 * 1024 * 1024,
        cpu: 0.1,
        cpus: 4,
        maxdisk: 100 * 1024 * 1024 * 1024,
        disk: 0,
        netin: 0,
        netout: 0,
        uptime: 86400,
        type: "qemu" as const,
      },
    ] satisfies ProxmoxVM[],
  },
  storageByNode: {
    pranavlab: [
      {
        storage: "local-lvm",
        type: "lvmthin",
        content: "images,rootdir",
        total: 1024 * 1024 * 1024 * 1024,
        used: 256 * 1024 * 1024 * 1024,
        avail: 768 * 1024 * 1024 * 1024,
        active: 1,
        enabled: 1,
        shared: 0,
      } satisfies ProxmoxStorage,
    ],
  },
  configByVmid: {
    200: { scsi0: "local-lvm:vm-200-disk-0,size=256G" },
    201: { scsi0: "local-lvm:vm-201-disk-0,size=256G" },
    101: { scsi0: "local-lvm:vm-101-disk-0,size=100G" },
  } as Record<number, ProxmoxVMConfig>,
};

const VMWARE_FIXTURE = {
  clusters: [
    {
      cluster: "domain-c1",
      name: "lab-cluster",
      ha_enabled: true,
      drs_enabled: true,
    } satisfies ClusterSummary,
  ],
  hosts: [
    {
      host: "host-1",
      name: "esxi-01.local",
      connection_state: "CONNECTED",
      power_state: "POWERED_ON",
    } satisfies HostSummary,
    {
      host: "host-2",
      name: "esxi-02.local",
      connection_state: "CONNECTED",
      power_state: "POWERED_ON",
    } satisfies HostSummary,
  ],
  datastores: [
    {
      datastore: "datastore-50",
      name: "ds-vsan",
      type: "VSAN",
      capacity: 512 * 1024 * 1024 * 1024,
      free_space: 256 * 1024 * 1024 * 1024,
    } satisfies DatastoreSummary,
  ],
  vms: [
    {
      vm: "vm-9001",
      name: "win11-tester",
      power_state: "POWERED_ON" as const,
      cpu_count: 4,
      memory_size_MiB: 8192,
    },
  ],
  vmPlacements: {
    "vm-9001": { hostId: "host-1", datastoreIds: ["datastore-50"] },
  },
  hostPlacements: {
    "host-1": { clusterId: "domain-c1" },
    "host-2": { clusterId: "domain-c1" },
  },
};

// ── Tests ───────────────────────────────────────────────────

describe("Proxmox writer + VMware writer + resolver — nested-lab e2e", () => {
  let dir: string;
  let store: GraphStore;
  let proxmoxWriter: ProxmoxGraphWriter;
  let vmwareWriter: VmwareGraphWriter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-e2e-resolver-"));
    store = new GraphStore(join(dir, "graph.db"));

    proxmoxWriter = new ProxmoxGraphWriter({
      store,
      client: new FakeProxmoxClient(PROXMOX_FIXTURE),
    });
    vmwareWriter = new VmwareGraphWriter(
      store,
      new FakeVmwareClient(VMWARE_FIXTURE),
      { uid: "vcenter.pranavlab", name: "lab-vcenter", version: "8.0.2" },
    );

    // Both writers do their own type registration as part of register().
    proxmoxWriter.register();
    vmwareWriter.registerTypes();

    await proxmoxWriter.discover();
    await vmwareWriter.discover();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("both perspectives land in the same graph store", () => {
    // Proxmox-side
    expect(store.getResource(nodeResourceId("pranavlab"))).not.toBeNull();
    expect(store.getResource(vmResourceId(200))).not.toBeNull();
    expect(store.getResource(vmResourceId(201))).not.toBeNull();
    expect(store.getResource(vmResourceId(101))).not.toBeNull();

    // vSphere-side
    expect(
      store.getResource("vsphere:vsphere_host:host-1"),
    ).not.toBeNull();
    expect(
      store.getResource("vsphere:vsphere_host:host-2"),
    ).not.toBeNull();
    expect(
      store.getResource("vsphere:vsphere_vcenter:vcenter.pranavlab"),
    ).not.toBeNull();
  });

  it("resolver infers manifests_as edges for both nested ESXi hosts (but NOT for jellyfin)", () => {
    const { matches, edgesUpserted } = runResolver(store);

    // Two matches: esxi-01 → host-1, esxi-02 → host-2.
    expect(matches).toHaveLength(2);
    expect(edgesUpserted).toBe(2);

    const matchPairs = matches.map((m) => [m.fromId, m.toId]).sort();
    expect(matchPairs).toEqual(
      [
        [vmResourceId(200), "vsphere:vsphere_host:host-1"],
        [vmResourceId(201), "vsphere:vsphere_host:host-2"],
      ].sort(),
    );

    // Jellyfin (vmid 101) is NOT linked to anything in vSphere.
    expect(
      store.edgesFrom(vmResourceId(101), "manifests_as"),
    ).toHaveLength(0);
  });

  it("re-running resolver is idempotent across both writer outputs", () => {
    runResolver(store);
    runResolver(store);
    runResolver(store);
    // Two manifests_as plus all direct edges from the two writers.
    const inferred = store
      .listRelationships()
      .filter((r) => r.type === "manifests_as");
    expect(inferred).toHaveLength(2);
  });

  it("'what runs on physical pranavlab' traverses both perspectives", () => {
    runResolver(store);

    // Step 1: every workload `runs_on` pranavlab (Proxmox perspective).
    const directlyOnPranav = store
      .edgesTo(nodeResourceId("pranavlab"), "runs_on")
      .map((e) => e.fromId);
    // 3 workloads upserted (esxi-01, esxi-02, jellyfin).
    expect(directlyOnPranav.sort()).toEqual(
      [vmResourceId(200), vmResourceId(201), vmResourceId(101)].sort(),
    );

    // Step 2: for each nested-ESXi workload, follow its manifests_as to
    // the vSphere-host perspective. From the host, follow incoming
    // runs_on to find vSphere VMs.
    const vsphereVmsOnNestedEsxi = new Set<string>();
    for (const proxmoxVmId of directlyOnPranav) {
      const manifests = store.edgesFrom(proxmoxVmId, "manifests_as");
      for (const m of manifests) {
        const vsphereHostId = m.toId;
        const vms = store
          .edgesTo(vsphereHostId, "runs_on")
          .map((e) => e.fromId);
        for (const v of vms) vsphereVmsOnNestedEsxi.add(v);
      }
    }

    // win11-tester (vm-9001) lives on host-1, which is the nested
    // ESXi sitting on pranavlab vmid 200 — so it counts.
    expect(vsphereVmsOnNestedEsxi.has("vsphere:vsphere_vm:vm-9001")).toBe(
      true,
    );
  });

  it("queryResources(interfaceLabel: 'ComputeWorkload') returns both perspectives' workloads", () => {
    runResolver(store);

    const workloads = queryResources(store, {
      interfaceLabel: "ComputeWorkload",
    });
    // 3 Proxmox VMs + 1 vSphere VM = 4 workloads.
    expect(workloads.length).toBe(4);

    const ids = new Set(workloads.map((w) => w.id));
    expect(ids.has(vmResourceId(200))).toBe(true);
    expect(ids.has(vmResourceId(201))).toBe(true);
    expect(ids.has(vmResourceId(101))).toBe(true);
    expect(ids.has("vsphere:vsphere_vm:vm-9001")).toBe(true);
  });

  it("queryResources(interfaceLabel: 'ComputeNode') sees vSphere hosts AND the Proxmox node", () => {
    runResolver(store);

    const nodes = queryResources(store, { interfaceLabel: "ComputeNode" });
    const ids = new Set(nodes.map((n) => n.id));
    // 1 proxmox_node + 2 vsphere_host = 3.
    expect(nodes.length).toBe(3);
    expect(ids.has(nodeResourceId("pranavlab"))).toBe(true);
    expect(ids.has("vsphere:vsphere_host:host-1")).toBe(true);
    expect(ids.has("vsphere:vsphere_host:host-2")).toBe(true);
  });

  it("direct edges are origin: 'direct'; resolver edges are origin: 'inferred'", () => {
    runResolver(store);

    const direct = store
      .listRelationships()
      .filter((r) => r.origin === "direct");
    const inferred = store
      .listRelationships()
      .filter((r) => r.origin === "inferred");

    // All resolver outputs are manifests_as.
    expect(inferred.every((r) => r.type === "manifests_as")).toBe(true);
    expect(inferred).toHaveLength(2);

    // Every direct edge is one of the writer-asserted types — never manifests_as.
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((r) => r.type !== "manifests_as")).toBe(true);
  });
});
