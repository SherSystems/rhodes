// ============================================================
// RHODES — Graph (Infrastructure Ontology) public exports
// ============================================================

export type {
  AnyResourceState,
  ClusterState,
  ComputeNodeState,
  ComputeWorkloadState,
  Condition,
  ConditionType,
  ControlPlaneState,
  GraphProvider,
  InterfaceLabel,
  NetworkSegmentState,
  QueryMode,
  QueryOptions,
  Relationship,
  RelationshipType,
  Resource,
  ResourceType,
  ResourceTypeRegistration,
  ResourceWithFreshness,
  StorageState,
} from "./types.js";

export { FRESHNESS_WINDOW_SEC } from "./types.js";

export type {
  ConditionUpsertInput,
  RelationshipUpsertInput,
  ResourceTypeRegistrationInput,
  ResourceUpsertInput,
} from "./store.js";

export {
  GraphNotRegisteredError,
  GraphSchemaError,
  GraphStore,
  z,
} from "./store.js";

export { queryResources } from "./query.js";

export type { ResolverMatch, ResolverRule } from "./resolver.js";

export { PROXMOX_VM_IS_VSPHERE_HOST, runResolver } from "./resolver.js";

export type {
  DiscoveryReport,
  DiscoveryWriter,
  SchedulerOptions,
} from "./discovery-scheduler.js";

export { DiscoveryScheduler } from "./discovery-scheduler.js";
