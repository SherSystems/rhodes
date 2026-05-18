// ============================================================
// RHODES — VMware Graph Writer
//
// Reads from the existing VSphereClient and upserts the discovered
// vSphere topology (vCenter → clusters → hosts → VMs → datastores)
// into the GraphStore. Owns the per-type schema registration for
// every vSphere resource type the writer can produce.
//
// Why this lives in the provider tree (not the orchestrator):
// the orchestrator is substrate-agnostic and MUST NOT import a
// provider-specific client. The graph writer is the seam: it knows
// vSphere's REST shape, knows the graph's typed contract, and
// translates one to the other.
//
// Relationship origin (Decision #1 / #2 supporting):
// Every edge this writer asserts is `origin: 'direct'` — we observed
// it from the substrate API. The 'inferred' origin is reserved for
// the cross-provider resolver (e.g., manifests_as bindings) and the
// writer must never claim inferred evidence as its own.
//
// Client surface:
// The writer talks to a narrowed `VmwareDiscoveryClient` interface
// (a subset of VSphereClient plus a placement helper) so the unit
// tests can substitute a fake without spinning up vCenter. The
// real VSphereClient satisfies the read-only methods directly;
// the placement helper exists because the vSphere REST API doesn't
// expose VM→host or VM→datastore mappings on the VM detail object
// in a single call, so callers (or a future enhancement to the
// client) must supply that side-channel.
// ============================================================

import {
  GraphStore,
  z,
  type GraphProvider,
  type ResourceType,
} from "../../graph/index.js";
import type {
  ClusterSummary,
  DatastoreSummary,
  HostSummary,
  VmSummary,
} from "./types.js";

// ── Provider identity ──────────────────────────────────────

const PROVIDER: GraphProvider = "vsphere";

/**
 * Stable id for a resource record. The shape — `{provider}:{type}:{moid}`
 * — is the contract the resolver also relies on; do not change it
 * without updating `src/graph/resolver.ts`.
 */
function rid(type: ResourceType, moid: string): string {
  return `${PROVIDER}:${type}:${moid}`;
}

// ── Discovery client surface ───────────────────────────────

/**
 * Per-VM placement record. vSphere's REST `GET /api/vcenter/vm/{vm}`
 * does NOT include the host moid or the datastore moid list in a
 * single roundtrip (the disk backing only carries a `vmdk_file` path,
 * not a datastore reference). Callers therefore must supply this
 * mapping. Production code can build it from `vmware_get_vm` +
 * the SOAP API; the unit tests build it inline.
 */
export interface VmPlacement {
  /** Host moid the VM is running on. */
  hostId: string;
  /** Datastore moids the VM has disks on. May be empty. */
  datastoreIds: string[];
}

/**
 * Per-host cluster placement. As with VM placement, vSphere REST
 * does not surface a host's parent cluster moid on the host detail
 * object — it's discoverable via the SOAP API or by querying clusters
 * and walking their resource pools. Caller supplies the mapping.
 */
export interface HostPlacement {
  /** Cluster moid this host is a member of, if any. */
  clusterId?: string;
}

/**
 * Narrowed view of `VSphereClient` that the writer actually depends on.
 * Keeping this explicit lets tests substitute a fake and lets us spot
 * accidental new client coupling at the type level.
 */
export interface VmwareDiscoveryClient {
  listHosts(): Promise<HostSummary[]>;
  listVMs(): Promise<VmSummary[]>;
  listDatastores(): Promise<DatastoreSummary[]>;
  listClusters(): Promise<ClusterSummary[]>;
  /** Return placement for a VM. Caller decides how to obtain it. */
  getVmPlacement(vmId: string): Promise<VmPlacement>;
  /** Return cluster placement for a host. Caller decides how to obtain it. */
  getHostPlacement(hostId: string): Promise<HostPlacement>;
}

// ── vCenter identity ───────────────────────────────────────

/**
 * vCenter is a logical resource (not a moid we discover) — the writer
 * needs to know which vCenter instance these reads came from so it
 * can upsert a `vsphere_vcenter` node and root the topology.
 */
export interface VCenterIdentity {
  /** Stable identifier for this vCenter — the hostname / FQDN works. */
  uid: string;
  /** Human-readable name for the vCenter (defaults to uid). */
  name?: string;
  /** Marketing/product version, if known. */
  version?: string;
}

// ── Property schemas (Decision #2 — minimal, tight) ────────

const HOST_PROPERTIES = z.object({
  moid: z.string(),
  connectionState: z.enum(["CONNECTED", "DISCONNECTED", "NOT_RESPONDING"]),
  powerState: z
    .enum(["POWERED_ON", "POWERED_OFF", "STANDBY"])
    .optional(),
});

const VM_PROPERTIES = z.object({
  moid: z.string(),
  powerState: z.enum(["POWERED_ON", "POWERED_OFF", "SUSPENDED"]),
  cpuCount: z.number().optional(),
  memoryMiB: z.number().optional(),
});

const CLUSTER_PROPERTIES = z.object({
  moid: z.string(),
  haEnabled: z.boolean(),
  drsEnabled: z.boolean(),
});

const DATASTORE_PROPERTIES = z.object({
  moid: z.string(),
  type: z.enum(["VMFS", "NFS", "NFS41", "CIFS", "VSAN", "VFFS", "VVOL"]),
  capacityBytes: z.number().optional(),
  freeSpaceBytes: z.number().optional(),
});

const VCENTER_PROPERTIES = z.object({
  uid: z.string(),
  version: z.string().optional(),
});

// ── Writer ─────────────────────────────────────────────────

/**
 * VMware graph writer. One instance per (graph store, vCenter)
 * pairing. Construct once at boot, call `registerTypes()`, then call
 * `discover()` on the cadence dictated by the per-type freshness
 * windows in `FRESHNESS_WINDOW_SEC` (60-300s for vSphere types).
 */
export class VmwareGraphWriter {
  private readonly store: GraphStore;
  private readonly client: VmwareDiscoveryClient;
  private readonly vcenter: VCenterIdentity;
  private typesRegistered = false;

  constructor(
    store: GraphStore,
    client: VmwareDiscoveryClient,
    vcenter: VCenterIdentity,
  ) {
    this.store = store;
    this.client = client;
    this.vcenter = vcenter;
  }

  /**
   * Register every (vsphere, type) combo this writer can produce.
   * Idempotent: GraphStore.registerResourceType replaces prior
   * registrations in-place and we guard the local boolean so callers
   * can invoke this multiple times without penalty.
   */
  registerTypes(): void {
    this.store.registerResourceType({
      provider: PROVIDER,
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: [
        "running",
        "maintenance",
        "disconnected",
        "error",
        "unknown",
      ],
      propertiesSchema: HOST_PROPERTIES,
    });

    this.store.registerResourceType({
      provider: PROVIDER,
      type: "vsphere_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: [
        "running",
        "stopped",
        "paused",
        "error",
        "unreachable",
        "unknown",
      ],
      propertiesSchema: VM_PROPERTIES,
    });

    this.store.registerResourceType({
      provider: PROVIDER,
      type: "vsphere_cluster",
      interfaceLabels: ["Cluster"],
      allowedStates: ["healthy", "degraded", "critical", "unknown"],
      propertiesSchema: CLUSTER_PROPERTIES,
    });

    this.store.registerResourceType({
      provider: PROVIDER,
      type: "vsphere_datastore",
      interfaceLabels: ["Storage"],
      allowedStates: ["accessible", "degraded", "inaccessible", "unknown"],
      propertiesSchema: DATASTORE_PROPERTIES,
    });

    this.store.registerResourceType({
      provider: PROVIDER,
      type: "vsphere_vcenter",
      interfaceLabels: ["ControlPlane"],
      allowedStates: ["running", "degraded", "unreachable", "unknown"],
      propertiesSchema: VCENTER_PROPERTIES,
    });

    this.typesRegistered = true;
  }

  /**
   * Discover the full vSphere topology and upsert it into the graph.
   *
   * Order matters because of the relationships table's FK on resources:
   *   1. vCenter and clusters (no inbound edges)
   *   2. Hosts (member_of cluster)
   *   3. Datastores (no parent edge — they're shared)
   *   4. VMs (runs_on host, mounts datastores)
   *   5. Cluster managed_by vCenter
   *
   * Returns a count summary for telemetry/test assertions.
   */
  async discover(): Promise<DiscoveryReport> {
    if (!this.typesRegistered) {
      // Belt-and-suspenders: the store would throw GraphNotRegisteredError
      // anyway, but failing here gives a clearer message at the right layer.
      throw new Error(
        "VmwareGraphWriter.discover() called before registerTypes(). " +
          "Register types once at boot.",
      );
    }

    const report: DiscoveryReport = {
      vcenters: 0,
      clusters: 0,
      hosts: 0,
      datastores: 0,
      vms: 0,
      relationships: 0,
    };

    // 1. vCenter root
    const vcenterId = rid("vsphere_vcenter", this.vcenter.uid);
    this.store.upsertResource({
      id: vcenterId,
      provider: PROVIDER,
      type: "vsphere_vcenter",
      name: this.vcenter.name ?? this.vcenter.uid,
      observedState: "running",
      properties: {
        uid: this.vcenter.uid,
        ...(this.vcenter.version !== undefined && {
          version: this.vcenter.version,
        }),
      },
    });
    report.vcenters = 1;

    // 2. Clusters
    const clusters = await this.client.listClusters();
    for (const c of clusters) {
      this.store.upsertResource({
        id: rid("vsphere_cluster", c.cluster),
        provider: PROVIDER,
        type: "vsphere_cluster",
        name: c.name,
        observedState: "unknown", // cluster health needs vSAN/DRS signals; default safe
        properties: {
          moid: c.cluster,
          haEnabled: c.ha_enabled,
          drsEnabled: c.drs_enabled,
        },
      });

      // cluster → vCenter (managed_by)
      this.store.upsertRelationship({
        fromId: rid("vsphere_cluster", c.cluster),
        toId: vcenterId,
        type: "managed_by",
        origin: "direct",
      });
      report.relationships++;
    }
    report.clusters = clusters.length;

    // 3. Hosts + host → cluster
    const hosts = await this.client.listHosts();
    for (const h of hosts) {
      this.store.upsertResource({
        id: rid("vsphere_host", h.host),
        provider: PROVIDER,
        type: "vsphere_host",
        name: h.name,
        observedState: mapHostState(h),
        properties: {
          moid: h.host,
          connectionState: h.connection_state,
          ...(h.power_state !== undefined && { powerState: h.power_state }),
        },
      });

      const placement = await this.client.getHostPlacement(h.host);
      if (placement.clusterId) {
        this.store.upsertRelationship({
          fromId: rid("vsphere_host", h.host),
          toId: rid("vsphere_cluster", placement.clusterId),
          type: "member_of",
          origin: "direct",
        });
        report.relationships++;
      }
    }
    report.hosts = hosts.length;

    // 4. Datastores
    const datastores = await this.client.listDatastores();
    for (const d of datastores) {
      this.store.upsertResource({
        id: rid("vsphere_datastore", d.datastore),
        provider: PROVIDER,
        type: "vsphere_datastore",
        name: d.name,
        // listDatastores returns the summary, which doesn't include
        // 'accessible'; assume accessible unless a later getDatastore
        // call says otherwise. The detail-level call is opt-in to keep
        // discover() cheap.
        observedState: "accessible",
        properties: {
          moid: d.datastore,
          type: d.type,
          ...(d.capacity !== undefined && { capacityBytes: d.capacity }),
          ...(d.free_space !== undefined && {
            freeSpaceBytes: d.free_space,
          }),
        },
      });
    }
    report.datastores = datastores.length;

    // 5. VMs + VM → host + VM → datastore(s)
    const vms = await this.client.listVMs();
    for (const v of vms) {
      this.store.upsertResource({
        id: rid("vsphere_vm", v.vm),
        provider: PROVIDER,
        type: "vsphere_vm",
        name: v.name,
        observedState: mapVmState(v.power_state),
        properties: {
          moid: v.vm,
          powerState: v.power_state,
          ...(v.cpu_count !== undefined && { cpuCount: v.cpu_count }),
          ...(v.memory_size_MiB !== undefined && {
            memoryMiB: v.memory_size_MiB,
          }),
        },
      });

      const placement = await this.client.getVmPlacement(v.vm);
      this.store.upsertRelationship({
        fromId: rid("vsphere_vm", v.vm),
        toId: rid("vsphere_host", placement.hostId),
        type: "runs_on",
        origin: "direct",
      });
      report.relationships++;

      for (const dsId of placement.datastoreIds) {
        this.store.upsertRelationship({
          fromId: rid("vsphere_vm", v.vm),
          toId: rid("vsphere_datastore", dsId),
          type: "mounts",
          origin: "direct",
        });
        report.relationships++;
      }
    }
    report.vms = vms.length;

    return report;
  }
}

// ── State mapping ──────────────────────────────────────────

/**
 * vSphere VM power state → ComputeWorkloadState. Suspended maps to
 * 'paused' (not 'stopped') because a suspended VM still owns its
 * memory image and is functionally a pause, not a shutdown.
 */
function mapVmState(
  ps: "POWERED_ON" | "POWERED_OFF" | "SUSPENDED",
): "running" | "stopped" | "paused" {
  switch (ps) {
    case "POWERED_ON":
      return "running";
    case "POWERED_OFF":
      return "stopped";
    case "SUSPENDED":
      return "paused";
  }
}

/**
 * Host connection_state → ComputeNodeState. We collapse
 * NOT_RESPONDING into 'disconnected' because to the orchestrator
 * they're indistinguishable for planning purposes (don't schedule
 * here either way); a richer signal can ride on the conditions
 * sidecar if needed.
 */
function mapHostState(h: HostSummary): "running" | "disconnected" {
  if (h.connection_state === "CONNECTED") return "running";
  return "disconnected";
}

// ── Report shape ───────────────────────────────────────────

export interface DiscoveryReport {
  vcenters: number;
  clusters: number;
  hosts: number;
  datastores: number;
  vms: number;
  relationships: number;
}
