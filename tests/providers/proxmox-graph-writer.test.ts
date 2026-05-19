// ============================================================
// Proxmox Graph Writer — registration, discovery, edge synthesis
//
// Everything here runs against an in-memory fake ProxmoxClient.
// We never touch a real Proxmox cluster — the writer's contract
// is with the typed client surface, so a structural fake covers
// the same surface area as the real one.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GraphStore } from "../../src/graph/index.js";
import type {
  ProxmoxClusterStatusEntry,
  ProxmoxNode,
  ProxmoxStorage,
  ProxmoxVM,
  ProxmoxVMConfig,
  ProxmoxVersion,
} from "../../src/providers/proxmox/client.js";
import {
  ProxmoxGraphWriter,
  clusterResourceId,
  containerResourceId,
  extractStorageRefsFromConfig,
  nodeResourceId,
  storageResourceId,
  vmResourceId,
  type ProxmoxDiscoveryClient,
} from "../../src/providers/proxmox/graph-writer.js";

// ── Fixture helpers ───────────────────────────────────────────

function node(name: string, overrides: Partial<ProxmoxNode> = {}): ProxmoxNode {
  return {
    node: name,
    status: "online",
    cpu: 0.1,
    maxcpu: 8,
    mem: 4 * 1024 * 1024 * 1024,
    maxmem: 16 * 1024 * 1024 * 1024,
    disk: 100 * 1024 * 1024 * 1024,
    maxdisk: 500 * 1024 * 1024 * 1024,
    uptime: 3600,
    id: `node/${name}`,
    type: "node",
    ...overrides,
  };
}

function vm(
  vmid: number,
  name: string,
  nodeName: string,
  overrides: Partial<ProxmoxVM> = {},
): ProxmoxVM {
  return {
    vmid,
    name,
    node: nodeName,
    status: "running",
    mem: 2 * 1024 * 1024 * 1024,
    maxmem: 4 * 1024 * 1024 * 1024,
    cpu: 0.05,
    cpus: 4,
    maxdisk: 32 * 1024 * 1024 * 1024,
    disk: 0,
    netin: 0,
    netout: 0,
    uptime: 100,
    type: "qemu",
    ...overrides,
  };
}

function container(
  vmid: number,
  name: string,
  nodeName: string,
  overrides: Partial<ProxmoxVM> = {},
): ProxmoxVM {
  return vm(vmid, name, nodeName, { type: "lxc", ...overrides });
}

function storage(
  storageName: string,
  overrides: Partial<ProxmoxStorage> = {},
): ProxmoxStorage {
  return {
    storage: storageName,
    type: "lvmthin",
    content: "images,rootdir",
    total: 500 * 1024 * 1024 * 1024,
    used: 100 * 1024 * 1024 * 1024,
    avail: 400 * 1024 * 1024 * 1024,
    active: 1,
    enabled: 1,
    shared: 0,
    ...overrides,
  };
}

interface FakeClientInputs {
  nodes?: ProxmoxNode[];
  vmsByNode?: Record<string, ProxmoxVM[]>;
  storageByNode?: Record<string, ProxmoxStorage[]>;
  configByVmid?: Record<number, ProxmoxVMConfig>;
  /** Per-node-name predicates that throw on access (simulate outage). */
  errorOnGetVMs?: Set<string>;
  errorOnGetStorage?: Set<string>;
  errorOnGetVMConfig?: Set<number>;
  /** v0.7.3.2 — when set, getVersion returns this; omitting it
   *  simulates an older client (the writer skips cluster discovery). */
  version?: ProxmoxVersion;
  /** v0.7.3.2 — when set, getClusterStatus returns this. */
  clusterStatus?: ProxmoxClusterStatusEntry[];
  /** Throw inside getVersion (simulates a transient cluster outage). */
  errorOnGetVersion?: boolean;
  /** Throw inside getClusterStatus (writer falls back to synthetic name). */
  errorOnGetClusterStatus?: boolean;
}

class FakeProxmoxClient implements ProxmoxDiscoveryClient {
  constructor(private readonly inputs: FakeClientInputs) {}

  async getNodes(): Promise<ProxmoxNode[]> {
    return this.inputs.nodes ?? [];
  }

  async getVMs(nodeName?: string): Promise<ProxmoxVM[]> {
    if (!nodeName) {
      // The writer always passes a node; if it ever doesn't, fail loudly.
      throw new Error("FakeProxmoxClient.getVMs called without nodeName");
    }
    if (this.inputs.errorOnGetVMs?.has(nodeName)) {
      throw new Error(`simulated getVMs failure for ${nodeName}`);
    }
    return this.inputs.vmsByNode?.[nodeName] ?? [];
  }

  async getStorage(nodeName?: string): Promise<ProxmoxStorage[]> {
    if (!nodeName) {
      throw new Error("FakeProxmoxClient.getStorage called without nodeName");
    }
    if (this.inputs.errorOnGetStorage?.has(nodeName)) {
      throw new Error(`simulated getStorage failure for ${nodeName}`);
    }
    return this.inputs.storageByNode?.[nodeName] ?? [];
  }

  async getVMConfig(_node: string, vmid: number): Promise<ProxmoxVMConfig> {
    if (this.inputs.errorOnGetVMConfig?.has(vmid)) {
      throw new Error(`simulated getVMConfig failure for vmid=${vmid}`);
    }
    return this.inputs.configByVmid?.[vmid] ?? {};
  }
}

/**
 * v0.7.3.2 — a client variant that exposes the cluster + version
 * endpoints. Used by the cluster-discovery tests; the existing
 * cluster-free tests still use FakeProxmoxClient so we keep proof that
 * the writer is graceful when those methods are absent.
 */
class FakeProxmoxClientWithCluster
  extends FakeProxmoxClient
  implements ProxmoxDiscoveryClient
{
  constructor(private readonly clusterInputs: FakeClientInputs) {
    super(clusterInputs);
  }

  async getVersion(): Promise<ProxmoxVersion> {
    if (this.clusterInputs.errorOnGetVersion) {
      throw new Error("simulated getVersion failure");
    }
    return (
      this.clusterInputs.version ?? {
        version: "8.0.4",
        release: "8.0",
        repoid: "test",
      }
    );
  }

  async getClusterStatus(): Promise<ProxmoxClusterStatusEntry[]> {
    if (this.clusterInputs.errorOnGetClusterStatus) {
      throw new Error("simulated getClusterStatus failure");
    }
    return this.clusterInputs.clusterStatus ?? [];
  }
}

// ── Test bed ──────────────────────────────────────────────────

describe("ProxmoxGraphWriter", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-proxmox-writer-test-"));
    store = new GraphStore(join(dir, "graph.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Registration ────────────────────────────────────────────

  describe("register()", () => {
    it("registers all five Proxmox resource types", () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({}),
      });
      writer.register();

      expect(store.getRegistration("proxmox", "proxmox_node")).toBeDefined();
      expect(store.getRegistration("proxmox", "proxmox_vm")).toBeDefined();
      expect(
        store.getRegistration("proxmox", "proxmox_container"),
      ).toBeDefined();
      expect(store.getRegistration("proxmox", "proxmox_storage")).toBeDefined();
      // v0.7.3.2 — cluster registration so the upgrade resolver has
      // a target to read `pveVersion` off of.
      expect(store.getRegistration("proxmox", "proxmox_cluster")).toBeDefined();
      expect(
        store.getRegistration("proxmox", "proxmox_cluster")!.interfaceLabels,
      ).toEqual(["Cluster"]);
    });

    it("is idempotent — re-registering does not throw", () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({}),
      });
      writer.register();
      expect(() => writer.register()).not.toThrow();
      // And the registration is still queryable after the second call.
      expect(store.getRegistration("proxmox", "proxmox_node")).toBeDefined();
    });

    it("registers interface labels matching the contract", () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({}),
      });
      writer.register();

      expect(
        store.getRegistration("proxmox", "proxmox_node")!.interfaceLabels,
      ).toEqual(["ComputeNode"]);
      expect(
        store.getRegistration("proxmox", "proxmox_vm")!.interfaceLabels,
      ).toEqual(["ComputeWorkload"]);
      expect(
        store.getRegistration("proxmox", "proxmox_container")!.interfaceLabels,
      ).toEqual(["ComputeWorkload"]);
      expect(
        store.getRegistration("proxmox", "proxmox_storage")!.interfaceLabels,
      ).toEqual(["Storage"]);
    });
  });

  // ── Discovery — happy path ─────────────────────────────────

  describe("discover() — happy path", () => {
    it("auto-registers if discover() is called before register()", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
        }),
      });
      // No explicit register() — discover should handle it.
      await writer.discover();
      expect(store.getRegistration("proxmox", "proxmox_node")).toBeDefined();
    });

    it("upserts nodes with the expected id format and state mapping", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [
            node("pranavlab", { status: "online" }),
            node("nuc-1", { status: "offline" }),
          ],
        }),
      });

      const stats = await writer.discover();
      expect(stats.nodes).toBe(2);

      const pranav = store.getResource(nodeResourceId("pranavlab"));
      expect(pranav).not.toBeNull();
      expect(pranav!.id).toBe("proxmox:proxmox_node:pranavlab");
      expect(pranav!.observedState).toBe("running");
      expect(pranav!.interfaceLabels).toEqual(["ComputeNode"]);
      expect(pranav!.properties.nodeName).toBe("pranavlab");
      expect(pranav!.properties.cpuCores).toBe(8);

      const nuc = store.getResource(nodeResourceId("nuc-1"));
      expect(nuc!.observedState).toBe("disconnected");
    });

    it("upserts VMs with the expected id format and runs_on edges", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
          vmsByNode: {
            pranavlab: [
              vm(200, "esxi-01", "pranavlab"),
              vm(201, "esxi-02", "pranavlab", { status: "stopped" }),
            ],
          },
        }),
      });

      const stats = await writer.discover();
      expect(stats.vms).toBe(2);
      expect(stats.containers).toBe(0);
      expect(stats.runsOnEdges).toBe(2);

      const esxi01 = store.getResource(vmResourceId(200));
      expect(esxi01).not.toBeNull();
      expect(esxi01!.id).toBe("proxmox:proxmox_vm:200");
      expect(esxi01!.name).toBe("esxi-01");
      expect(esxi01!.observedState).toBe("running");
      expect(esxi01!.type).toBe("proxmox_vm");
      expect(esxi01!.interfaceLabels).toEqual(["ComputeWorkload"]);
      expect(esxi01!.properties.vmid).toBe(200);
      expect(esxi01!.properties.node).toBe("pranavlab");
      expect(esxi01!.properties.vmType).toBe("qemu");

      const stopped = store.getResource(vmResourceId(201));
      expect(stopped!.observedState).toBe("stopped");

      // runs_on edges point VM → node, with origin: 'direct'.
      const edges = store.edgesFrom(vmResourceId(200), "runs_on");
      expect(edges).toHaveLength(1);
      expect(edges[0].toId).toBe(nodeResourceId("pranavlab"));
      expect(edges[0].origin).toBe("direct");
    });

    it("upserts containers separately from VMs", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
          vmsByNode: {
            pranavlab: [
              vm(200, "esxi-01", "pranavlab"),
              container(101, "ct-jellyfin", "pranavlab"),
            ],
          },
        }),
      });

      const stats = await writer.discover();
      expect(stats.vms).toBe(1);
      expect(stats.containers).toBe(1);
      expect(stats.runsOnEdges).toBe(2);

      const ct = store.getResource(containerResourceId(101));
      expect(ct).not.toBeNull();
      expect(ct!.id).toBe("proxmox:proxmox_container:101");
      expect(ct!.type).toBe("proxmox_container");
      expect(ct!.properties.vmType).toBe("lxc");

      // The VM id namespace is distinct from the container id namespace
      // — vmid 101 in the container table must NOT appear in the VM
      // table, even though Proxmox shares the integer pool.
      expect(store.getResource(vmResourceId(101))).toBeNull();
    });

    it("upserts storage with per-node id namespacing", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab"), node("nuc-1")],
          // Same logical "local-lvm" pool appears on both nodes — by
          // design, the writer produces ONE resource per (node, pool)
          // so cross-node mount edges stay unambiguous.
          storageByNode: {
            pranavlab: [storage("local-lvm")],
            "nuc-1": [storage("local-lvm")],
          },
        }),
      });

      const stats = await writer.discover();
      expect(stats.storage).toBe(2);

      const pranavStorage = store.getResource(
        storageResourceId("pranavlab", "local-lvm"),
      );
      expect(pranavStorage).not.toBeNull();
      expect(pranavStorage!.id).toBe(
        "proxmox:proxmox_storage:pranavlab:local-lvm",
      );
      expect(pranavStorage!.observedState).toBe("accessible");
      expect(pranavStorage!.properties.node).toBe("pranavlab");

      const nucStorage = store.getResource(
        storageResourceId("nuc-1", "local-lvm"),
      );
      expect(nucStorage).not.toBeNull();
      expect(nucStorage!.id).toBe("proxmox:proxmox_storage:nuc-1:local-lvm");
    });

    it("emits mounts edges from VMs to the storage their disks reference", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
          vmsByNode: {
            pranavlab: [
              vm(200, "esxi-01", "pranavlab"),
              container(101, "ct-jellyfin", "pranavlab"),
            ],
          },
          storageByNode: {
            pranavlab: [storage("local-lvm"), storage("nvme-data")],
          },
          configByVmid: {
            // QEMU VM with two disks on two different storage pools.
            200: {
              scsi0: "local-lvm:vm-200-disk-0,size=32G",
              scsi1: "nvme-data:vm-200-disk-1,size=200G",
              ide2: "none,media=cdrom",
            },
            // LXC rootfs.
            101: {
              rootfs: "local-lvm:subvol-101-disk-0,size=8G",
            },
          },
        }),
      });

      const stats = await writer.discover();
      expect(stats.mountsEdges).toBe(3); // 2 from vmid 200, 1 from ct 101

      const vmMounts = store.edgesFrom(vmResourceId(200), "mounts");
      expect(vmMounts).toHaveLength(2);
      const vmMountTargets = new Set(vmMounts.map((e) => e.toId));
      expect(vmMountTargets).toEqual(
        new Set([
          storageResourceId("pranavlab", "local-lvm"),
          storageResourceId("pranavlab", "nvme-data"),
        ]),
      );
      for (const edge of vmMounts) {
        expect(edge.origin).toBe("direct");
      }

      const ctMounts = store.edgesFrom(containerResourceId(101), "mounts");
      expect(ctMounts).toHaveLength(1);
      expect(ctMounts[0].toId).toBe(
        storageResourceId("pranavlab", "local-lvm"),
      );
    });

    it("does not emit mounts edges for storage it didn't discover", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
          vmsByNode: { pranavlab: [vm(200, "esxi-01", "pranavlab")] },
          storageByNode: { pranavlab: [storage("local-lvm")] },
          configByVmid: {
            // References "ghost-pool" which we never reported via getStorage.
            200: { scsi0: "ghost-pool:vm-200-disk-0,size=32G" },
          },
        }),
      });

      const stats = await writer.discover();
      expect(stats.mountsEdges).toBe(0);
      expect(store.edgesFrom(vmResourceId(200), "mounts")).toHaveLength(0);
    });
  });

  // ── Discovery — empty / failure cases ──────────────────────

  describe("discover() — robustness", () => {
    it("handles an empty cluster without throwing", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({}),
      });

      const stats = await writer.discover();
      expect(stats).toEqual({
        nodes: 0,
        vms: 0,
        containers: 0,
        storage: 0,
        runsOnEdges: 0,
        mountsEdges: 0,
        clusters: 0,
        memberOfEdges: 0,
      });
      expect(store.listResources()).toHaveLength(0);
      expect(store.listRelationships()).toHaveLength(0);
    });

    it("skips workloads for nodes whose getVMs throws", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab"), node("nuc-1")],
          vmsByNode: { pranavlab: [vm(200, "esxi-01", "pranavlab")] },
          errorOnGetVMs: new Set(["nuc-1"]),
        }),
      });

      const stats = await writer.discover();
      // Both nodes are upserted; only the live node contributes VMs.
      expect(stats.nodes).toBe(2);
      expect(stats.vms).toBe(1);
      expect(store.getResource(nodeResourceId("nuc-1"))).not.toBeNull();
      expect(store.getResource(vmResourceId(200))).not.toBeNull();
    });

    it("skips a VM whose getVMConfig throws but still emits its runs_on", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
          vmsByNode: { pranavlab: [vm(200, "esxi-01", "pranavlab")] },
          storageByNode: { pranavlab: [storage("local-lvm")] },
          errorOnGetVMConfig: new Set([200]),
        }),
      });

      const stats = await writer.discover();
      expect(stats.vms).toBe(1);
      expect(stats.runsOnEdges).toBe(1);
      expect(stats.mountsEdges).toBe(0);
    });

    it("is idempotent — running discover() twice does not duplicate edges", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({
          nodes: [node("pranavlab")],
          vmsByNode: { pranavlab: [vm(200, "esxi-01", "pranavlab")] },
          storageByNode: { pranavlab: [storage("local-lvm")] },
          configByVmid: {
            200: { scsi0: "local-lvm:vm-200-disk-0,size=32G" },
          },
        }),
      });

      await writer.discover();
      await writer.discover();

      expect(store.edgesFrom(vmResourceId(200), "runs_on")).toHaveLength(1);
      expect(store.edgesFrom(vmResourceId(200), "mounts")).toHaveLength(1);
    });
  });

  // ── Disk-config parsing (unit) ─────────────────────────────

  describe("extractStorageRefsFromConfig", () => {
    it("extracts the storage pool prefix from QEMU disk keys", () => {
      const refs = extractStorageRefsFromConfig({
        scsi0: "local-lvm:vm-200-disk-0,size=32G",
        virtio1: "nvme-data:vm-200-disk-1,size=100G",
        sata0: "backup-zfs:vm-200-disk-2,size=50G",
        ide0: "another-pool:vm-200-disk-3,size=10G",
      });
      expect(refs.sort()).toEqual([
        "another-pool",
        "backup-zfs",
        "local-lvm",
        "nvme-data",
      ]);
    });

    it("extracts the rootfs and mpN storage prefix for LXC", () => {
      const refs = extractStorageRefsFromConfig({
        rootfs: "local-lvm:subvol-101-disk-0,size=8G",
        mp0: "nvme-data:subvol-101-disk-1,size=50G",
      });
      expect(refs.sort()).toEqual(["local-lvm", "nvme-data"]);
    });

    it("ignores non-disk keys", () => {
      const refs = extractStorageRefsFromConfig({
        name: "esxi-01",
        memory: 4096,
        cores: 4,
        net0: "virtio,bridge=vmbr0",
        agent: "1",
      });
      expect(refs).toEqual([]);
    });

    it("skips the 'none' cdrom sentinel", () => {
      const refs = extractStorageRefsFromConfig({
        ide2: "none,media=cdrom",
      });
      expect(refs).toEqual([]);
    });

    it("deduplicates when multiple disks live on the same pool", () => {
      const refs = extractStorageRefsFromConfig({
        scsi0: "local-lvm:vm-200-disk-0,size=32G",
        scsi1: "local-lvm:vm-200-disk-1,size=100G",
        scsi2: "local-lvm:vm-200-disk-2,size=10G",
      });
      expect(refs).toEqual(["local-lvm"]);
    });
  });

  // ── Cluster discovery (v0.7.3.2) ────────────────────────────

  describe("cluster discovery (v0.7.3.2)", () => {
    it("emits a proxmox_cluster + member_of edges when getVersion is available", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [node("pve-01"), node("pve-02")],
          version: { version: "8.2.4", release: "8.2", repoid: "abc" },
          clusterStatus: [
            { type: "cluster", name: "homelab", nodes: 2, quorate: 1, version: 2 },
            { type: "node", name: "pve-01", online: 1, local: 1, nodeid: 1 },
            { type: "node", name: "pve-02", online: 1, local: 0, nodeid: 2 },
          ],
        }),
      });
      const stats = await writer.discover();

      expect(stats.clusters).toBe(1);
      expect(stats.memberOfEdges).toBe(2);

      const cluster = store.getResource(clusterResourceId("homelab"));
      expect(cluster).toBeDefined();
      expect(cluster!.properties).toMatchObject({
        clusterName: "homelab",
        pveVersion: "8.2.4",
        pveRelease: "8.2",
        nodeCount: 2,
        quorate: true,
      });
      expect(cluster!.observedState).toBe("healthy");

      // Each node has a member_of edge → cluster
      const edges = store.edgesTo(clusterResourceId("homelab"), "member_of");
      const fromIds = edges.map((e) => e.fromId).sort();
      expect(fromIds).toEqual([
        nodeResourceId("pve-01"),
        nodeResourceId("pve-02"),
      ]);
    });

    it("synthesizes a cluster name from the first node when no cluster entry", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [node("pve-solo")],
          version: { version: "8.0.4", release: "8.0", repoid: "test" },
          // Standalone single-node install — cluster/status returns
          // only the node entry, no `type: "cluster"` row.
          clusterStatus: [
            { type: "node", name: "pve-solo", online: 1, local: 1, nodeid: 1 },
          ],
        }),
      });
      const stats = await writer.discover();

      expect(stats.clusters).toBe(1);
      const cluster = store.getResource(
        clusterResourceId("proxmox-pve-solo"),
      );
      expect(cluster).toBeDefined();
      expect(cluster!.properties).toMatchObject({
        clusterName: "proxmox-pve-solo",
        pveVersion: "8.0.4",
        nodeCount: 1,
        quorate: false,
      });
      expect(cluster!.observedState).toBe("healthy");
    });

    it("falls back to synthetic name when getClusterStatus throws", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [node("pve-alpha")],
          version: { version: "8.1.0", release: "8.1", repoid: "x" },
          errorOnGetClusterStatus: true,
        }),
      });
      const stats = await writer.discover();
      expect(stats.clusters).toBe(1);
      const cluster = store.getResource(
        clusterResourceId("proxmox-pve-alpha"),
      );
      expect(cluster).toBeDefined();
      // No cluster/status entries → unknown health
      expect(cluster!.observedState).toBe("unknown");
    });

    it("skips cluster discovery silently when getVersion throws", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [node("pve-01")],
          errorOnGetVersion: true,
        }),
      });
      const stats = await writer.discover();
      expect(stats.clusters).toBe(0);
      expect(stats.memberOfEdges).toBe(0);
      // The node itself still got upserted.
      expect(stats.nodes).toBe(1);
      expect(store.getResource(nodeResourceId("pve-01"))).toBeDefined();
    });

    it("skips cluster discovery entirely when the client doesn't expose getVersion", async () => {
      // FakeProxmoxClient (no cluster mixin) intentionally omits
      // getVersion — simulates an older adapter / test that hasn't
      // been migrated yet. The writer must not crash.
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClient({ nodes: [node("pve-01")] }),
      });
      const stats = await writer.discover();
      expect(stats.clusters).toBe(0);
      expect(stats.memberOfEdges).toBe(0);
      expect(stats.nodes).toBe(1);
    });

    it("marks the cluster degraded when one of two cluster nodes is offline", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [node("pve-01"), node("pve-02", { status: "offline" })],
          version: { version: "8.2.4", release: "8.2", repoid: "abc" },
          clusterStatus: [
            { type: "cluster", name: "homelab", nodes: 2, quorate: 1, version: 2 },
            { type: "node", name: "pve-01", online: 1, local: 1, nodeid: 1 },
            { type: "node", name: "pve-02", online: 0, local: 0, nodeid: 2 },
          ],
        }),
      });
      await writer.discover();
      const cluster = store.getResource(clusterResourceId("homelab"));
      expect(cluster!.observedState).toBe("degraded");
    });

    it("marks the cluster critical when quorum is lost", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [node("pve-01"), node("pve-02"), node("pve-03")],
          version: { version: "8.2.4", release: "8.2", repoid: "abc" },
          clusterStatus: [
            { type: "cluster", name: "homelab", nodes: 3, quorate: 0, version: 2 },
            { type: "node", name: "pve-01", online: 1, local: 1, nodeid: 1 },
            { type: "node", name: "pve-02", online: 0, local: 0, nodeid: 2 },
            { type: "node", name: "pve-03", online: 0, local: 0, nodeid: 3 },
          ],
        }),
      });
      await writer.discover();
      const cluster = store.getResource(clusterResourceId("homelab"));
      expect(cluster!.observedState).toBe("critical");
    });

    it("does not emit a cluster when there are zero nodes", async () => {
      const writer = new ProxmoxGraphWriter({
        store,
        client: new FakeProxmoxClientWithCluster({
          nodes: [],
          version: { version: "8.0.4", release: "8.0", repoid: "x" },
        }),
      });
      const stats = await writer.discover();
      expect(stats.clusters).toBe(0);
      expect(stats.memberOfEdges).toBe(0);
    });
  });
});
