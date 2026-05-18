// ============================================================
// RHODES — Graph Types (Infrastructure Ontology)
//
// The graph is the agent's working memory of the customer's
// entire on-prem + cloud infrastructure. Adapters discover
// Resources (typed) and Relationships (typed edges) and write
// them into the graph; the orchestrator queries the graph
// before generating plans.
//
// Identity model (Decision #1 — manifests_as edges):
// Each provider gets its own Resource record. When the same
// logical thing appears in multiple providers (e.g., a Proxmox
// VM that runs a nested ESXi host visible to vCenter), an
// explicit `manifests_as` edge connects the perspectives.
// Shared *interface labels* (e.g., `ComputeWorkload`) let
// cross-provider queries skip the traversal for the common case.
//
// State model (Decision #3 — per-type closed enums + sidecar):
// Each resource type carries an `observed_state` from a closed
// enum that includes `unknown` as the safe fallback. Pair every
// state with `state_observed_at`. Orthogonal signals that one
// enum slot can't carry (e.g., "running per hypervisor AND
// unreachable from our probe") live in optional `conditions[]`.
//
// Schema registry (Decision #2 — JSON properties guardrails):
// Substrate-specific fields live in a JSON `properties` blob.
// Every (provider, type) combo MUST register a JSON schema; the
// store rejects writes that violate it. Without write-time
// validation the schema rots — adapters silently drift on type,
// nobody notices, queries break six months later.
//
// Freshness (Decision #4 — per-type windows + query modes):
// Each resource type declares a freshness window in code. Queries
// pick a mode: `fresh` (within window only), `stale-allowed` (all,
// annotated), `historical` (include never-seen-recently).
// ============================================================

// ── Provider identity ──────────────────────────────────────

/** Provider type — matches `ProviderType` in `src/providers/types.ts`. */
export type GraphProvider =
  | "proxmox"
  | "vsphere"
  | "aws"
  | "azure"
  | "kubernetes"
  | "ssh";

// ── Resource type vocabulary ───────────────────────────────

/**
 * Concrete substrate-specific resource type. Format: snake_case,
 * single canonical value per (provider, real-world-thing) pair.
 * The store rejects writes for unregistered types.
 */
export type ResourceType =
  // vSphere
  | "vsphere_vm"
  | "vsphere_host"
  | "vsphere_cluster"
  | "vsphere_datastore"
  | "vsphere_network"
  | "vsphere_vcenter"
  // Proxmox
  | "proxmox_vm"
  | "proxmox_container"
  | "proxmox_node"
  | "proxmox_storage"
  | "proxmox_network"
  // AWS (placeholders for v0.6.5)
  | "aws_ec2_instance"
  | "aws_rds_instance"
  | "aws_s3_bucket"
  | "aws_vpc"
  // Azure (placeholders)
  | "azure_vm"
  | "azure_storage_account"
  // K8s (placeholders for v0.7)
  | "k8s_cluster"
  | "k8s_node"
  | "k8s_pod"
  | "k8s_deployment";

/**
 * Interface label — Cartography-style polymorphic label that lets
 * cross-provider queries skip `manifests_as` traversal for the
 * common cases. Multiple labels per resource are allowed.
 */
export type InterfaceLabel =
  | "ComputeWorkload" // VM, container, pod — anything that runs apps
  | "ComputeNode" // hypervisor host, K8s node, bare metal
  | "Storage" // datastore, volume, bucket, blob
  | "NetworkSegment" // vSwitch, VPC, vlan, subnet
  | "ControlPlane" // vCenter, EKS control plane, AKS, k8s api server
  | "Cluster"; // vSphere cluster, K8s cluster, EKS cluster

// ── State enums (per interface label) ──────────────────────

/** State for any `ComputeWorkload` (VMs, containers, pods). */
export type ComputeWorkloadState =
  | "running"
  | "stopped"
  | "paused"
  | "error"
  | "unreachable"
  | "unknown";

/** State for any `ComputeNode` (hypervisor hosts, K8s nodes). */
export type ComputeNodeState =
  | "running"
  | "maintenance"
  | "disconnected"
  | "error"
  | "unknown";

/** State for any `Storage` (datastores, volumes, buckets). */
export type StorageState =
  | "accessible"
  | "degraded"
  | "inaccessible"
  | "unknown";

/** State for any `NetworkSegment`. */
export type NetworkSegmentState = "up" | "partial" | "down" | "unknown";

/** State for any `ControlPlane` (vCenter, EKS API, etc.). */
export type ControlPlaneState =
  | "running"
  | "degraded"
  | "unreachable"
  | "unknown";

/** State for any `Cluster`. */
export type ClusterState =
  | "healthy"
  | "degraded"
  | "critical"
  | "unknown";

/** Union of all possible states. Persisted as TEXT in SQLite. */
export type AnyResourceState =
  | ComputeWorkloadState
  | ComputeNodeState
  | StorageState
  | NetworkSegmentState
  | ControlPlaneState
  | ClusterState;

// ── Relationship vocabulary ────────────────────────────────

/**
 * Closed set of edge types. Adding a new type requires a deliberate
 * schema decision — don't extend ad-hoc.
 */
export type RelationshipType =
  | "manifests_as" // cross-provider identity: Proxmox VM IS this vSphere host
  | "runs_on" // workload runs on a compute node
  | "member_of" // node is member of cluster
  | "mounts" // workload/host mounts storage
  | "attached_to" // workload attached to network segment
  | "depends_on" // app-level dependency (one workload talks to another)
  | "managed_by" // cluster managed by control plane
  | "replicates_to" // storage replicates to another storage
  | "owned_by"; // resource has logical owner (team/app)

// ── Resource record ────────────────────────────────────────

/**
 * A single resource as seen by ONE provider. The same logical
 * thing seen by another provider is a SEPARATE Resource linked
 * via a `manifests_as` edge.
 */
export interface Resource {
  /** Stable globally-unique id. Format: `{provider}:{type}:{provider_uid}`. */
  id: string;
  provider: GraphProvider;
  type: ResourceType;
  /** Polymorphic interface labels — Cartography pattern. */
  interfaceLabels: InterfaceLabel[];
  /** Human-readable name. Not guaranteed unique. */
  name: string;
  /** Observed state from the substrate's most recent discovery. */
  observedState: AnyResourceState;
  /** What RHODES/policy WANTS this to be. Null = no opinion. */
  desiredState?: AnyResourceState | null;
  /** Substrate-specific fields. Validated against the per-type schema registry. */
  properties: Record<string, unknown>;
  /** When the adapter last observed this resource. */
  lastObservedAt: string; // ISO-8601
  /** When `observedState` last differed from its prior value. */
  lastChangedAt: string; // ISO-8601
  /** First time we ever saw this resource. */
  discoveredAt: string; // ISO-8601
}

/**
 * Per-type freshness contract. Adapters / consumers use this to
 * decide whether a `lastObservedAt` is fresh or stale.
 *
 * IMPORTANT: this is the consumer CONTRACT, not the collector's
 * polling interval. AWS Config separates these explicitly — the
 * collector can use any mix of events + polls as long as it hits
 * the contract.
 */
export const FRESHNESS_WINDOW_SEC: Record<ResourceType, number> = {
  // vSphere — polled tight; control-plane heartbeat
  vsphere_vm: 60,
  vsphere_host: 60,
  vsphere_cluster: 120,
  vsphere_datastore: 300,
  vsphere_network: 600,
  vsphere_vcenter: 120,
  // Proxmox — similar shape
  proxmox_vm: 60,
  proxmox_container: 60,
  proxmox_node: 60,
  proxmox_storage: 300,
  proxmox_network: 600,
  // AWS — polled via API + event-driven via CloudWatch
  aws_ec2_instance: 120,
  aws_rds_instance: 300,
  aws_s3_bucket: 3600,
  aws_vpc: 1800,
  // Azure
  azure_vm: 120,
  azure_storage_account: 3600,
  // K8s — informer + 10h resync, but practical default 60s
  k8s_cluster: 60,
  k8s_node: 60,
  k8s_pod: 30,
  k8s_deployment: 60,
};

// ── Relationship record ────────────────────────────────────

export interface Relationship {
  id: string; // UUID
  fromId: string; // Resource.id
  toId: string; // Resource.id
  type: RelationshipType;
  /** Optional edge properties (e.g., mount path, port, dependency latency). */
  properties: Record<string, unknown>;
  observedAt: string; // ISO-8601
  /**
   * Which subsystem produced this edge. Direct = the discovering
   * adapter saw it explicitly (e.g., vSphere told us VM runs on host).
   * Inferred = the resolver inferred it (e.g., manifests_as matching
   * Proxmox vmid → vSphere host by hostname/IP).
   */
  origin: "direct" | "inferred";
}

// ── Condition sidecar (Decision #3) ────────────────────────

/**
 * K8s-style condition for orthogonal signals one enum slot can't
 * carry. Example: a VM is `running` per the hypervisor AND
 * `unreachable` from our network probe — two independent facts
 * that the single `observedState` enum can't both hold.
 */
export interface Condition {
  resourceId: string;
  type: ConditionType;
  status: "true" | "false" | "unknown";
  reason?: string;
  message?: string;
  lastTransitionAt: string; // ISO-8601
}

export type ConditionType =
  | "Reachable" // network probe sees it
  | "AdapterHealthy" // adapter can talk to the substrate API at all
  | "InSync" // observed matches desired
  | "PolicyCompliant"; // resource matches its declared policy

// ── Schema registry (Decision #2) ──────────────────────────

/**
 * Per-type schema registration. Adapters MUST register before they
 * can write resources of that type. The store rejects writes whose
 * `properties` blob fails JSON-schema validation.
 *
 * `propertiesSchema` is a JSON Schema (draft-07ish). Keep it tight —
 * fields that appear in WHERE clauses more than monthly should be
 * promoted to typed columns (or generated columns) per the documented
 * promotion protocol; substrate-specific knobs and quirks stay here.
 */
export interface ResourceTypeRegistration {
  provider: GraphProvider;
  type: ResourceType;
  interfaceLabels: InterfaceLabel[];
  allowedStates: readonly AnyResourceState[];
  /** JSON Schema for the `properties` blob. */
  propertiesSchema: Record<string, unknown>;
  /** Optional override of the global `FRESHNESS_WINDOW_SEC`. */
  freshnessWindowSec?: number;
}

// ── Query API types ────────────────────────────────────────

/**
 * Query mode. Default to `fresh` for orchestrator plans (don't make
 * upgrade decisions on stale data); default to `staleAllowed` for
 * dashboards (give the operator visibility with explicit staleness).
 */
export type QueryMode = "fresh" | "staleAllowed" | "historical";

export interface QueryOptions {
  mode?: QueryMode; // default: 'fresh'
  provider?: GraphProvider;
  type?: ResourceType;
  interfaceLabel?: InterfaceLabel;
  observedState?: AnyResourceState;
}

/** Result row — adds `isStale` annotation for staleAllowed mode. */
export interface ResourceWithFreshness extends Resource {
  /** True when `lastObservedAt` is older than the type's freshness window. */
  isStale: boolean;
  /** Seconds since `lastObservedAt`. */
  ageSec: number;
}
