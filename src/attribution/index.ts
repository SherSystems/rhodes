// ============================================================
// RHODES — Attribution (Silence-mode / Event-Source) public exports
// ============================================================

export type {
  ActorKind,
  Attribution,
  AttributionActor,
  AttributionEvent,
  AttributionEventType,
  EventSource,
  MatchConfidence,
  StateChangeObservation,
} from "./types.js";

export {
  DEFAULT_CORRELATION_LOOKBACK_SEC,
  EVENT_RETENTION_SEC,
} from "./types.js";

export { AttributionStore } from "./store.js";

export type { CorrelatorOptions } from "./correlator.js";

export {
  AttributionCorrelator,
  expectedEventTypesFor,
  transitionKey,
} from "./correlator.js";

export { EventSourceRegistry } from "./registry.js";

// ── Per-substrate event sources ────────────────────────────

export { ProxmoxTaskLogSource } from "./sources/proxmox-task-log.js";
export type {
  ProxmoxTask,
  ProxmoxTaskClient,
} from "./sources/proxmox-task-log.js";

export { VsphereEventSource } from "./sources/vsphere-events.js";
export type {
  VsphereEvent,
  VsphereEventClient,
} from "./sources/vsphere-events.js";
