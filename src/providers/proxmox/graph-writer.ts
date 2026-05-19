// ============================================================
// RHODES — Proxmox Graph Writer
//
// Bridges the Proxmox REST client into the unified infrastructure
// graph (`src/graph/`). On boot, register the four Proxmox resource
// types so the store will accept writes for them. On discovery,
// read every node / VM / container / storage from the cluster and
// upsert one Resource per substrate object plus the direct edges
// the API gives us (`runs_on`, `mounts`).
//
// This writer is THE thing that makes Proxmox a first-class
// substrate alongside vSphere in v0.6.0. The nested-ESXi lab means
// the same physical box surfaces in both the Proxmox catalog AND
// the vSphere catalog at the same time; running BOTH writers
// against the same `GraphStore` is what proves the substrate-
// agnostic schema actually holds.
//
// Constraints:
//   - The orchestrator must NEVER import a provider client. Writers
//     are the only graph-side code allowed to know about
//     `ProxmoxClient`.
//   - Every relationship we observe through the Proxmox API is
//     `origin: 'direct'` — `inferred` belongs to the resolver.
//   - Timestamps are owned by the `GraphStore`; we never set them.
// ============================================================

import { GraphStore, z } from "../../graph/index.js";
import type {
  ClusterState,
  ComputeNodeState,
  ComputeWorkloadState,
  StorageState,
} from "../../graph/index.js";
import type {
  ProxmoxClusterStatusEntry,
  ProxmoxNode,
  ProxmoxStorage,
  ProxmoxVM,
  ProxmoxVMConfig,
  ProxmoxVersion,
} from "./client.js";

// ── Minimal client surface this writer depends on ─────────────
//
// Declared as a structural interface (not `ProxmoxClient` itself)
// so tests can pass a fake without instantiating the real HTTPS
// client. Order: a discovery run calls `getNodes`, then per-node
// `getVMs` (which already merges QEMU + LXC), then per-node
// `getStorage`, then per-VM `getVMConfig` (only used for `mounts`).
export interface ProxmoxDiscoveryClient {
  getNodes(): Promise<ProxmoxNode[]>;
  getVMs(node?: string): Promise<ProxmoxVM[]>;
  getStorage(node?: string): Promise<ProxmoxStorage[]>;
  getVMConfig(node: string, vmid: number): Promise<ProxmoxVMConfig>;
  /**
   * v0.7.3.2 — Optional. Used by `discover()` to emit a
   * `proxmox_cluster` resource with the PVE software version on its
   * properties so the upgrade resolver has a `pveVersion` to read.
   * When the method is absent (older fakes), cluster discovery is
   * skipped silently — every other resource still flows.
   */
  getVersion?(): Promise<ProxmoxVersion>;
  /**
   * v0.7.3.2 — Optional. Returns the cluster/status array so we can
   * use Proxmox's real cluster name when the installation is part of
   * a quorate cluster. On standalone single-node installs the
   * endpoint returns only node entries; the writer falls back to a
   * synthetic name in that case.
   */
  getClusterStatus?(): Promise<ProxmoxClusterStatusEntry[]>;
}

// ── Resource-type schemas (substrate-specific properties) ─────
//
// Kept tight on purpose — only fields the Proxmox client actually
// populates. Anything we can't fill from a single discovery pass
// stays out of the schema; promote to a typed column when it
// starts showing up in WHERE clauses per the documented protocol.

const proxmoxNodePropertiesSchema = z.object({
  /** Proxmox node name (also serves as the provider_uid). */
  nodeName: z.string(),
  cpuCores: z.number(),
  memoryMb: z.number(),
  diskGb: z.number(),
  uptimeSec: z.number(),
  /** Raw Proxmox status string ("online" | "offline" | "unknown"). */
  rawStatus: z.string(),
});

const proxmoxVmPropertiesSchema = z.object({
  vmid: z.number(),
  node: z.string(),
  /** "qemu" for QEMU VMs, "lxc" for containers. Containers register
   *  separately, but the field is included for VMs to keep the
   *  shape consistent with how the basic list endpoint reports it. */
  vmType: z.literal("qemu"),
  cpuCores: z.number(),
  memoryMb: z.number(),
  diskGb: z.number(),
  uptimeSec: z.number(),
  template: z.boolean().optional(),
  tags: z.string().optional(),
});

const proxmoxContainerPropertiesSchema = z.object({
  vmid: z.number(),
  node: z.string(),
  vmType: z.literal("lxc"),
  cpuCores: z.number(),
  memoryMb: z.number(),
  diskGb: z.number(),
  uptimeSec: z.number(),
  tags: z.string().optional(),
});

const proxmoxClusterPropertiesSchema = z.object({
  /** Proxmox cluster name. Real cluster name when the install is
   *  quorate, synthetic ("proxmox-<host>") when standalone. */
  clusterName: z.string(),
  /** PVE software version (e.g. "8.0.4"). The resolver reads this
   *  from `pveVersion` as the sourceVersion of an UpgradePlan. */
  pveVersion: z.string(),
  /** Major.minor release line (e.g. "8.0"). */
  pveRelease: z.string(),
  /** Number of member nodes Proxmox reports (or 1 for standalone). */
  nodeCount: z.number(),
  /** True only when Proxmox reports the cluster as quorate (real
   *  multi-node cluster). False for standalone single-node installs. */
  quorate: z.boolean(),
});

const proxmoxStoragePropertiesSchema = z.object({
  storageName: z.string(),
  node: z.string(),
  storageType: z.string(),
  /** Comma-joined content types Proxmox reports (e.g. "images,iso"). */
  content: z.string(),
  totalGb: z.number(),
  usedGb: z.number(),
  availableGb: z.number(),
  /** True when Proxmox reports the storage as active on this node. */
  active: z.boolean(),
});

// Allowed-state enums per type. Subset of the interface-label-wide
// unions in `src/graph/types.ts` — we narrow to the values the
// Proxmox API can actually produce.
const PROXMOX_NODE_STATES: readonly ComputeNodeState[] = [
  "running",
  "maintenance",
  "disconnected",
  "error",
  "unknown",
];

const PROXMOX_WORKLOAD_STATES: readonly ComputeWorkloadState[] = [
  "running",
  "stopped",
  "paused",
  "error",
  "unreachable",
  "unknown",
];

const PROXMOX_STORAGE_STATES: readonly StorageState[] = [
  "accessible",
  "degraded",
  "inaccessible",
  "unknown",
];

const PROXMOX_CLUSTER_STATES: readonly ClusterState[] = [
  "healthy",
  "degraded",
  "critical",
  "unknown",
];

// ── Public API ────────────────────────────────────────────────

export interface ProxmoxGraphWriterOptions {
  store: GraphStore;
  client: ProxmoxDiscoveryClient;
}

export interface ProxmoxDiscoveryStats {
  nodes: number;
  vms: number;
  containers: number;
  storage: number;
  runsOnEdges: number;
  mountsEdges: number;
  /** v0.7.3.2 — 1 when a proxmox_cluster resource was emitted, 0 otherwise. */
  clusters: number;
  /** v0.7.3.2 — node → cluster member_of edges emitted. */
  memberOfEdges: number;
}

export class ProxmoxGraphWriter {
  private readonly store: GraphStore;
  private readonly client: ProxmoxDiscoveryClient;
  private registered = false;

  constructor(opts: ProxmoxGraphWriterOptions) {
    this.store = opts.store;
    this.client = opts.client;
  }

  /**
   * Register the four Proxmox resource types with the graph store.
   * Idempotent: re-registration is allowed (the store treats it as
   * a schema refresh) so callers can invoke this at every boot
   * without coordinating state.
   */
  register(): void {
    this.store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_node",
      interfaceLabels: ["ComputeNode"],
      allowedStates: PROXMOX_NODE_STATES,
      propertiesSchema: proxmoxNodePropertiesSchema,
    });
    this.store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: PROXMOX_WORKLOAD_STATES,
      propertiesSchema: proxmoxVmPropertiesSchema,
    });
    this.store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_container",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: PROXMOX_WORKLOAD_STATES,
      propertiesSchema: proxmoxContainerPropertiesSchema,
    });
    this.store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_storage",
      interfaceLabels: ["Storage"],
      allowedStates: PROXMOX_STORAGE_STATES,
      propertiesSchema: proxmoxStoragePropertiesSchema,
    });
    this.store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_cluster",
      interfaceLabels: ["Cluster"],
      allowedStates: PROXMOX_CLUSTER_STATES,
      propertiesSchema: proxmoxClusterPropertiesSchema,
    });
    this.registered = true;
  }

  /**
   * Pull the current cluster state from Proxmox and upsert it into
   * the graph. Returns a small stats object so a scheduler can log
   * what it observed without re-querying the store.
   *
   * Behaviour on partial failures: each per-node block is wrapped
   * in try/catch so one bad node (e.g. mid-reboot) doesn't poison
   * the whole sync — the rest of the cluster still gets through.
   */
  async discover(): Promise<ProxmoxDiscoveryStats> {
    if (!this.registered) {
      this.register();
    }

    const stats: ProxmoxDiscoveryStats = {
      nodes: 0,
      vms: 0,
      containers: 0,
      storage: 0,
      runsOnEdges: 0,
      mountsEdges: 0,
      clusters: 0,
      memberOfEdges: 0,
    };

    const nodes = await this.client.getNodes();

    // 1. Nodes — must come first so VM `runs_on` edges find their target.
    const knownNodeNames = new Set<string>();
    for (const node of nodes) {
      this.upsertNode(node);
      knownNodeNames.add(node.node);
      stats.nodes += 1;
    }

    // 1b. v0.7.3.2 — synthesize a proxmox_cluster resource so the
    // upgrade resolver has a `member_of` target with a `pveVersion`
    // property. Only emitted when `getVersion` is available on the
    // client (older fakes don't implement it; we skip silently to
    // keep them green). The cluster name comes from cluster/status
    // when the install is part of a quorate cluster; otherwise we
    // synthesize "proxmox-<firstNodeName>" so multi-install setups
    // stay distinguishable.
    if (typeof this.client.getVersion === "function" && nodes.length > 0) {
      try {
        const version = await this.client.getVersion();
        const clusterStatus =
          typeof this.client.getClusterStatus === "function"
            ? await this.client.getClusterStatus().catch(() => [] as ProxmoxClusterStatusEntry[])
            : [];
        const clusterMeta = deriveClusterMeta(
          clusterStatus,
          nodes[0]?.node ?? "default",
          nodes.length,
        );
        this.upsertCluster(clusterMeta, version, clusterStatus);
        stats.clusters = 1;
        // member_of edges: each node → the cluster.
        for (const node of nodes) {
          this.store.upsertRelationship({
            fromId: nodeResourceId(node.node),
            toId: clusterResourceId(clusterMeta.name),
            type: "member_of",
            origin: "direct",
          });
          stats.memberOfEdges += 1;
        }
      } catch {
        // Version endpoint is fundamental — if it fails we just skip
        // cluster discovery this cycle. Resources/edges already
        // upserted above stay intact.
      }
    }

    // 2. VMs + containers per node, and the runs_on edges.
    for (const node of nodes) {
      let vms: ProxmoxVM[] = [];
      try {
        vms = await this.client.getVMs(node.node);
      } catch {
        // Node may be offline / unreachable; the node itself is
        // already upserted with its `rawStatus`, so skip its
        // workloads quietly.
        continue;
      }

      for (const vm of vms) {
        const nodeName = vm.node ?? node.node;
        const vmType = vm.type ?? "qemu";
        const workloadResourceId =
          vmType === "lxc"
            ? containerResourceId(vm.vmid)
            : vmResourceId(vm.vmid);

        if (vmType === "lxc") {
          this.upsertContainer(vm, nodeName);
          stats.containers += 1;
        } else {
          this.upsertVm(vm, nodeName);
          stats.vms += 1;
        }

        // runs_on: workload → node
        this.store.upsertRelationship({
          fromId: workloadResourceId,
          toId: nodeResourceId(nodeName),
          type: "runs_on",
          origin: "direct",
        });
        stats.runsOnEdges += 1;
      }
    }

    // 3. Storage per node. Storage is namespaced per-node in our id
    // scheme so the same shared pool surfaces once per node that
    // mounts it — matches what `client.getStorage(node)` returns.
    const knownStorageKeys = new Set<string>();
    for (const node of nodes) {
      let pools: ProxmoxStorage[] = [];
      try {
        pools = await this.client.getStorage(node.node);
      } catch {
        continue;
      }
      for (const pool of pools) {
        this.upsertStorage(pool, node.node);
        knownStorageKeys.add(storageKey(node.node, pool.storage));
        stats.storage += 1;
      }
    }

    // 4. mounts edges: for each VM/container, parse its config and
    // emit a `mounts` edge for every disk whose storage we know.
    for (const node of nodes) {
      let vms: ProxmoxVM[] = [];
      try {
        vms = await this.client.getVMs(node.node);
      } catch {
        continue;
      }

      for (const vm of vms) {
        const nodeName = vm.node ?? node.node;
        const vmType = vm.type ?? "qemu";
        const workloadResourceId =
          vmType === "lxc"
            ? containerResourceId(vm.vmid)
            : vmResourceId(vm.vmid);

        let config: ProxmoxVMConfig;
        try {
          config = await this.client.getVMConfig(nodeName, vm.vmid);
        } catch {
          // Config endpoint occasionally 500s mid-state-change. Skip
          // the VM rather than failing the whole discovery.
          continue;
        }

        const storageNames = extractStorageRefsFromConfig(config);
        for (const storageName of storageNames) {
          const key = storageKey(nodeName, storageName);
          if (!knownStorageKeys.has(key)) {
            // The disk references storage we didn't see on this
            // node (shared pool surfaced elsewhere, or stale config).
            // Emit nothing rather than dangle an edge.
            continue;
          }
          this.store.upsertRelationship({
            fromId: workloadResourceId,
            toId: storageResourceId(nodeName, storageName),
            type: "mounts",
            origin: "direct",
          });
          stats.mountsEdges += 1;
        }
      }
    }

    return stats;
  }

  // ── Per-resource upsert helpers ─────────────────────────────

  private upsertNode(node: ProxmoxNode): void {
    this.store.upsertResource({
      id: nodeResourceId(node.node),
      provider: "proxmox",
      type: "proxmox_node",
      name: node.node,
      observedState: mapNodeStatus(node.status),
      properties: {
        nodeName: node.node,
        cpuCores: node.maxcpu ?? 0,
        memoryMb: node.maxmem ? Math.round(node.maxmem / 1024 / 1024) : 0,
        diskGb: node.maxdisk
          ? Math.round((node.maxdisk / 1024 / 1024 / 1024) * 100) / 100
          : 0,
        uptimeSec: node.uptime ?? 0,
        rawStatus: node.status ?? "unknown",
      },
    });
  }

  private upsertVm(vm: ProxmoxVM, nodeName: string): void {
    this.store.upsertResource({
      id: vmResourceId(vm.vmid),
      provider: "proxmox",
      type: "proxmox_vm",
      name: vm.name || `vm-${vm.vmid}`,
      observedState: mapWorkloadStatus(vm.status),
      properties: {
        vmid: vm.vmid,
        node: nodeName,
        vmType: "qemu" as const,
        cpuCores: vm.cpus ?? 0,
        memoryMb: vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : 0,
        diskGb: vm.maxdisk
          ? Math.round((vm.maxdisk / 1024 / 1024 / 1024) * 10) / 10
          : 0,
        uptimeSec: vm.uptime ?? 0,
        template: vm.template,
        tags: vm.tags,
      },
    });
  }

  private upsertContainer(ct: ProxmoxVM, nodeName: string): void {
    this.store.upsertResource({
      id: containerResourceId(ct.vmid),
      provider: "proxmox",
      type: "proxmox_container",
      name: ct.name || `ct-${ct.vmid}`,
      observedState: mapWorkloadStatus(ct.status),
      properties: {
        vmid: ct.vmid,
        node: nodeName,
        vmType: "lxc" as const,
        cpuCores: ct.cpus ?? 0,
        memoryMb: ct.maxmem ? Math.round(ct.maxmem / 1024 / 1024) : 0,
        diskGb: ct.maxdisk
          ? Math.round((ct.maxdisk / 1024 / 1024 / 1024) * 10) / 10
          : 0,
        uptimeSec: ct.uptime ?? 0,
        tags: ct.tags,
      },
    });
  }

  private upsertCluster(
    meta: { name: string; quorate: boolean; nodeCount: number },
    version: ProxmoxVersion,
    status: ProxmoxClusterStatusEntry[],
  ): void {
    this.store.upsertResource({
      id: clusterResourceId(meta.name),
      provider: "proxmox",
      type: "proxmox_cluster",
      name: meta.name,
      observedState: mapClusterState(status, meta.quorate, meta.nodeCount),
      properties: {
        clusterName: meta.name,
        pveVersion: version.version,
        pveRelease: version.release,
        nodeCount: meta.nodeCount,
        quorate: meta.quorate,
      },
    });
  }

  private upsertStorage(pool: ProxmoxStorage, nodeName: string): void {
    this.store.upsertResource({
      id: storageResourceId(nodeName, pool.storage),
      provider: "proxmox",
      type: "proxmox_storage",
      name: pool.storage,
      observedState: mapStorageStatus(pool),
      properties: {
        storageName: pool.storage,
        node: nodeName,
        storageType: pool.type,
        content: pool.content ?? "",
        totalGb: pool.total
          ? Math.round((pool.total / 1024 / 1024 / 1024) * 10) / 10
          : 0,
        usedGb: pool.used
          ? Math.round((pool.used / 1024 / 1024 / 1024) * 10) / 10
          : 0,
        availableGb: pool.avail
          ? Math.round((pool.avail / 1024 / 1024 / 1024) * 10) / 10
          : 0,
        active: pool.active === 1,
      },
    });
  }
}

// ── Resource-id construction ──────────────────────────────────

export function nodeResourceId(nodeName: string): string {
  return `proxmox:proxmox_node:${nodeName}`;
}

export function vmResourceId(vmid: number): string {
  return `proxmox:proxmox_vm:${vmid}`;
}

export function containerResourceId(vmid: number): string {
  return `proxmox:proxmox_container:${vmid}`;
}

export function clusterResourceId(clusterName: string): string {
  return `proxmox:proxmox_cluster:${clusterName}`;
}

/**
 * Decide the cluster name + quorate flag the writer will use.
 * Prefers the real Proxmox cluster name when the install is part of
 * a quorate multi-node cluster; otherwise synthesizes a deterministic
 * name from the first node so two standalone installs don't collide
 * in the same graph.
 */
function deriveClusterMeta(
  status: ProxmoxClusterStatusEntry[],
  fallbackNode: string,
  nodeCount: number,
): { name: string; quorate: boolean; nodeCount: number } {
  const clusterEntry = status.find((s) => s.type === "cluster");
  if (clusterEntry?.name) {
    return {
      name: clusterEntry.name,
      quorate: clusterEntry.quorate === 1,
      nodeCount: clusterEntry.nodes ?? nodeCount,
    };
  }
  return {
    name: `proxmox-${fallbackNode}`,
    quorate: false,
    nodeCount,
  };
}

/**
 * Map the cluster-level health signal into our `ClusterState` enum.
 * - quorate (real cluster) + all nodes online → healthy
 * - quorate but some nodes offline → degraded
 * - not quorate (or never quorate / standalone) with >1 expected node → critical
 * - standalone single-node install with the node online → healthy
 * - everything else → unknown
 */
function mapClusterState(
  status: ProxmoxClusterStatusEntry[],
  quorate: boolean,
  nodeCount: number,
): ClusterState {
  const nodeEntries = status.filter((s) => s.type === "node");
  const onlineNodes = nodeEntries.filter((n) => n.online === 1).length;

  // Standalone install (no cluster entry, single node): healthy if the
  // one node we know about is reachable. cluster/status returns the
  // local node with online=1 in that case.
  if (nodeEntries.length === 0) {
    return "unknown";
  }
  if (!quorate && nodeCount > 1) return "critical";
  if (onlineNodes === nodeEntries.length) return "healthy";
  if (onlineNodes > 0) return "degraded";
  return "critical";
}

export function storageResourceId(nodeName: string, storageName: string): string {
  return `proxmox:proxmox_storage:${nodeName}:${storageName}`;
}

function storageKey(nodeName: string, storageName: string): string {
  return `${nodeName}:${storageName}`;
}

// ── Status mapping ────────────────────────────────────────────

function mapNodeStatus(status: string | undefined): ComputeNodeState {
  switch (status) {
    case "online":
      return "running";
    case "offline":
      return "disconnected";
    default:
      return "unknown";
  }
}

function mapWorkloadStatus(status: string | undefined): ComputeWorkloadState {
  switch (status) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "paused":
    case "suspended":
      return "paused";
    default:
      return "unknown";
  }
}

function mapStorageStatus(pool: ProxmoxStorage): StorageState {
  // Proxmox exposes `active` (0/1) and `enabled` (0/1). `active === 1`
  // is the only thing that means "RHODES can actually read/write
  // here right now"; everything else degrades the contract.
  if (pool.active === 1) return "accessible";
  if (pool.enabled === 0) return "inaccessible";
  return "degraded";
}

// ── Disk-config parsing ───────────────────────────────────────

/**
 * The keys in a Proxmox VM config that describe attached disks. We
 * scan QEMU's full bus matrix (scsiN / virtioN / sataN / ideN) plus
 * LXC rootfs and mpN. Each value looks like `<storage>:<volume>,...`
 * (e.g. `local-lvm:vm-200-disk-0,size=32G`). We only need the
 * storage prefix.
 */
const DISK_KEY_PATTERN =
  /^(scsi\d+|virtio\d+|sata\d+|ide\d+|rootfs|mp\d+)$/;

export function extractStorageRefsFromConfig(
  config: ProxmoxVMConfig,
): string[] {
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (!DISK_KEY_PATTERN.test(key)) continue;
    if (typeof value !== "string") continue;

    // `ide2` is also where cloud-init CDROMs live; we still want to
    // record the storage mount because the volume sits on that pool.
    const colon = value.indexOf(":");
    if (colon <= 0) continue;
    const storageName = value.slice(0, colon);

    // Skip the special "none" sentinel and obvious URL forms; only
    // real storage pool names should land in the set.
    if (storageName === "none" || storageName.includes("/")) continue;

    seen.add(storageName);
  }
  return [...seen];
}
