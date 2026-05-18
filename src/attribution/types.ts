// ============================================================
// RHODES — Attribution Types (Silence-mode / Event-Source)
//
// The problem this module solves:
//   When RHODES observes a state change (proxmox_vm:200 went from
//   `running` → `stopped`), did anyone/anything trigger it? If yes,
//   we have attribution: suppress the incident, log the postmortem
//   as "operator-initiated, not a crash." If no, it's unattributed
//   — open an incident as usual.
//
// Without attribution, RHODES treats every operator-initiated
// shutdown as a crash (the v0.5.1 RCA-hallucination bug) AND
// self-alarms during every host maintenance window (the hard
// blocker for v0.7 upgrade orchestration). Both go away once the
// correlator can answer "did anything trigger this?"
//
// Per-substrate adapters (Proxmox task log, vCenter event API,
// CloudTrail, Azure Activity Log, K8s audit log) poll or stream
// events into the attribution store. The correlator matches state-
// change observations against stored events within a time window.
// The incident pipeline asks the correlator before opening incidents.
//
// Design notes:
// - Normalized `AttributionEvent` shape across all substrates so the
//   correlator is provider-agnostic.
// - Events store target resource_id (graph Resource.id when known)
//   for direct resource-level matching.
// - Actor breakdown lets postmortems be specific: "Pranav stopped this
//   via the Proxmox UI at 14:32" beats "stopped by something."
// - Events expire after 24h — attribution is moot once the state
//   change is integrated into the graph's established state.
// ============================================================

import type { GraphProvider } from "../graph/types.js";

// ── Normalized event from any substrate's event source ─────

export interface AttributionEvent {
  /** Stable globally-unique id. Format: `{provider}:{event_uid}`. */
  id: string;
  provider: GraphProvider;
  /**
   * Substrate-agnostic event class. Adapters map their native event
   * vocabulary onto this closed set so the correlator can reason
   * about transitions uniformly.
   */
  eventType: AttributionEventType;
  /** Resource.id from the graph that this event targets (when known). */
  targetResourceId?: string;
  /** Who/what triggered this event. */
  actor: AttributionActor;
  /** When the event occurred at the substrate (ISO-8601 UTC). */
  occurredAt: string;
  /**
   * Original substrate-specific payload, kept for audit + postmortem
   * generation. Stored as JSON blob; never queried structurally.
   */
  rawSource: Record<string, unknown>;
}

/**
 * Closed set of event classes. New event types require a deliberate
 * schema decision — don't extend ad-hoc. Adapters that see an event
 * they can't map should emit `unknown_event` rather than guessing.
 */
export type AttributionEventType =
  // VM lifecycle
  | "vm_start"
  | "vm_stop"
  | "vm_reboot"
  | "vm_suspend"
  | "vm_resume"
  | "vm_create"
  | "vm_delete"
  | "vm_migrate"
  // Host lifecycle
  | "host_enter_maintenance"
  | "host_exit_maintenance"
  | "host_reboot"
  | "host_disconnect"
  | "host_connect"
  // Config changes
  | "config_change"
  | "snapshot_create"
  | "snapshot_restore"
  | "snapshot_delete"
  // Catch-all
  | "unknown_event";

// ── Actor: who/what triggered the event ────────────────────

export interface AttributionActor {
  kind: ActorKind;
  /** Username, system name, plan id, etc. — depends on `kind`. */
  identity?: string;
  /** How the actor triggered the event (e.g., 'proxmox_ui', 'vcenter_api'). */
  via?: string;
}

export type ActorKind =
  /** A real human, via UI or CLI. Most common attribution target. */
  | "human"
  /** A system/service that isn't RHODES (HA, DRS, vendor automation). */
  | "system"
  /** RHODES itself, via one of its plans/playbooks. */
  | "rhodes"
  /** Adapter saw the event but couldn't determine the actor. */
  | "unknown";

// ── Correlation result ─────────────────────────────────────

/**
 * What the correlator returns when it finds an event that could
 * explain a state-change observation. Multiple events may match;
 * the correlator returns the BEST match (highest confidence).
 */
export interface Attribution {
  event: AttributionEvent;
  matchConfidence: MatchConfidence;
  matchReason: string;
}

export type MatchConfidence =
  /** Resource id match + event type matches the transition + tight time window (~30s). */
  | "high"
  /** Resource id match within reasonable window, but event type ambiguous. */
  | "medium"
  /** Provider-level activity without specific resource link. Treat as soft signal. */
  | "low";

// ── State-change observation: what the incident pipeline asks about ──

export interface StateChangeObservation {
  resourceId: string;
  fromState: string;
  toState: string;
  /** When RHODES observed the change (ISO-8601 UTC). */
  observedAt: string;
}

// ── Event source contract (each substrate's adapter implements) ──

export interface EventSource {
  /** Human-friendly name for logs. */
  name: string;
  provider: GraphProvider;
  /**
   * Long-running: poll or stream events from the substrate, call
   * `emit` for each one. Must be cancellable via `stop()`.
   */
  start(emit: (e: AttributionEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

// ── Tunables ───────────────────────────────────────────────

/**
 * Default lookback window for correlation. Events older than this
 * relative to a state-change observation are not considered matches.
 * 5 minutes is generous enough to cover slow polling + clock skew but
 * tight enough to avoid spurious matches.
 */
export const DEFAULT_CORRELATION_LOOKBACK_SEC = 300;

/**
 * Events older than this are pruned from storage. After 24h the
 * state change has been integrated into the graph's established
 * state; attribution is moot.
 */
export const EVENT_RETENTION_SEC = 86_400;
