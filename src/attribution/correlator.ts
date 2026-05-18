// ============================================================
// RHODES — Attribution Correlator
//
// Given a state-change observation, find the AttributionEvent that
// best explains it. The incident pipeline calls this BEFORE opening
// an incident: if a high-confidence attribution exists, suppress the
// incident (or open it with the attribution attached for postmortem
// context).
//
// Match precedence (best → worst):
//   1. high   — exact target_resource_id + event_type matches the
//               transition + within tight window (default 30s)
//   2. medium — exact target_resource_id within reasonable window
//               but event_type doesn't perfectly match the transition
//   3. low    — provider-level activity within window but no
//               specific resource id (soft signal; don't suppress
//               on this alone)
//
// Returns the SINGLE best match; if multiple high-confidence events
// exist (rare — two operators clicking shutdown simultaneously), the
// most recent wins.
// ============================================================

import type { AttributionStore } from "./store.js";
import type {
  Attribution,
  AttributionEvent,
  AttributionEventType,
  StateChangeObservation,
} from "./types.js";
import { DEFAULT_CORRELATION_LOOKBACK_SEC } from "./types.js";

/**
 * Map of (fromState → toState) transitions to the event types we'd
 * expect to attribute them. Used for the tight-window high-confidence
 * match check.
 *
 * Generic across substrates — VM states (running/stopped/paused) are
 * uniform via the graph's ComputeWorkloadState enum.
 */
const TRANSITION_TO_EVENT_TYPES: Record<string, AttributionEventType[]> = {
  "running→stopped": ["vm_stop", "vm_delete"],
  "running→paused": ["vm_suspend"],
  "running→error": ["vm_stop"], // operator-initiated stop sometimes shows as error
  "running→unreachable": ["vm_migrate", "host_disconnect"],
  "stopped→running": ["vm_start", "vm_resume"],
  "paused→running": ["vm_resume"],
  "stopped→unknown": ["vm_delete"],
  // Host transitions
  "running→maintenance": ["host_enter_maintenance"],
  "maintenance→running": ["host_exit_maintenance"],
  "running→disconnected": ["host_disconnect", "host_reboot"],
  "disconnected→running": ["host_connect"],
};

export interface CorrelatorOptions {
  /** Window (in seconds) BEFORE observedAt to look back. Default 300. */
  lookbackSec?: number;
  /** Tight-match window for `high` confidence (seconds). Default 30. */
  highConfidenceWindowSec?: number;
}

export class AttributionCorrelator {
  constructor(
    private readonly store: AttributionStore,
    private readonly opts: CorrelatorOptions = {},
  ) {}

  /**
   * Find the best attribution for a state-change observation.
   * Returns null if nothing in the window plausibly explains it.
   */
  findBestMatch(obs: StateChangeObservation): Attribution | null {
    const lookbackSec = this.opts.lookbackSec ?? DEFAULT_CORRELATION_LOOKBACK_SEC;
    const highWindowSec = this.opts.highConfidenceWindowSec ?? 30;

    const observedMs = Date.parse(obs.observedAt);
    const sinceIso = new Date(observedMs - lookbackSec * 1000).toISOString();
    const untilIso = obs.observedAt;

    // 1. Direct resource-scoped lookup
    const candidates = this.store.eventsForResource(
      obs.resourceId,
      sinceIso,
      untilIso,
    );

    if (candidates.length === 0) {
      // No resource-scoped events. Soft-signal path (low confidence)
      // is skipped for v0 — we don't want to suppress incidents on
      // mere provider-level activity. Adapters can opt-in later.
      return null;
    }

    const expectedTypes =
      TRANSITION_TO_EVENT_TYPES[`${obs.fromState}→${obs.toState}`] ?? [];

    // 2. Look for a high-confidence match: type matches + tight window
    const highMatch = candidates.find((e) => {
      const ageSec = (observedMs - Date.parse(e.occurredAt)) / 1000;
      return ageSec <= highWindowSec && expectedTypes.includes(e.eventType);
    });
    if (highMatch) {
      return {
        event: highMatch,
        matchConfidence: "high",
        matchReason: `event type '${highMatch.eventType}' matches transition '${obs.fromState}→${obs.toState}' within ${highWindowSec}s`,
      };
    }

    // 3. Medium: resource match within full window (any event type)
    // Take the most recent (sorted DESC by store).
    const mediumMatch = candidates[0];
    return {
      event: mediumMatch,
      matchConfidence: "medium",
      matchReason: `event on same resource within ${lookbackSec}s window (event type '${mediumMatch.eventType}' didn't perfectly match transition '${obs.fromState}→${obs.toState}')`,
    };
  }

  /**
   * Convenience: should the incident pipeline suppress an incident
   * for this observation? Returns the suppressing attribution if so,
   * null if the incident should proceed normally.
   *
   * Policy for v0: suppress on `high` confidence only. `medium` and
   * `low` are surfaced to the incident pipeline as context but don't
   * block the incident from opening. Operators can lower the bar
   * later via config if false-negative incidents are too noisy.
   */
  shouldSuppress(obs: StateChangeObservation): Attribution | null {
    const attribution = this.findBestMatch(obs);
    if (attribution && attribution.matchConfidence === "high") {
      return attribution;
    }
    return null;
  }

  /**
   * Lighter call when the caller wants context but isn't asking for
   * a suppression decision. Returns the best attribution at any
   * confidence (or null).
   */
  contextualize(obs: StateChangeObservation): Attribution | null {
    return this.findBestMatch(obs);
  }
}

/**
 * Helper: format a transition key for the precedence map. Exposed
 * for tests and potential downstream uses.
 */
export function transitionKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/**
 * Helper: known expected event types for a transition (or empty array).
 * Tests use this to verify the transition table without hardcoding.
 */
export function expectedEventTypesFor(
  from: string,
  to: string,
): AttributionEventType[] {
  return TRANSITION_TO_EVENT_TYPES[transitionKey(from, to)] ?? [];
}
