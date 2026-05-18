// ============================================================
// RHODES — vSphere Event Source (Attribution Adapter)
//
// Polls a structural `VsphereEventClient` for new vCenter events,
// normalizes each onto the closed `AttributionEventType` enum, and
// emits an `AttributionEvent` per occurrence. The output feeds the
// AttributionStore via the EventSourceRegistry, so the correlator
// can answer "did anyone trigger this state change?" without the
// incident pipeline needing to know vCenter exists.
//
// Why structural client (not the concrete VSphereClient):
// vCenter event reads only exist on the SOAP API (EventManager.
// QueryEvents) and the newer REST `/api/vcenter/event` endpoint —
// neither of which the v0.5.x VSphereClient implements yet. Tests
// must run without network, and the production wiring needs SOAP
// support in a follow-up. By coupling to a narrowed interface
// (`queryEventsSince`), the adapter is testable today and trivial
// to plug into the real client once it grows the surface area.
//
// Polling cadence + cursor:
// Every `pollIntervalMs` (default 15s) we ask the client for events
// with `key > lastSeenKey`, oldest first. vCenter assigns event
// keys monotonically per session, so the key doubles as both the
// natural event id and the cursor. On startup we don't replay the
// full history — we start from `initialLookbackKey` if supplied
// (else the highest existing key, leaving older events alone).
//
// Cancellation:
// `start()` runs the loop until `stop()` flips the AbortController.
// The sleep between polls is interruptible so `stop()` returns
// promptly even mid-interval. Errors from the client are logged
// (best-effort) and the loop continues — a flaky vCenter must not
// take attribution offline.
// ============================================================

import type { GraphProvider } from "../../graph/types.js";
import type {
  AttributionActor,
  AttributionEvent,
  AttributionEventType,
  EventSource,
} from "../types.js";

// ── Structural client surface ──────────────────────────────

/**
 * Subset of a real vSphere event client the adapter actually needs.
 * Lets unit tests substitute a fake and lets a future SOAP-capable
 * VSphereClient satisfy this contract via a single new method.
 */
export interface VsphereEventClient {
  /**
   * Returns events with `key > sinceKey`, oldest first, up to `limit`.
   * When `sinceKey` is undefined the caller wants a bootstrap page
   * (use `limit` to bound it). Implementations should be safe to
   * call repeatedly; they own paging against the underlying API.
   */
  queryEventsSince(opts: {
    sinceKey?: number;
    limit?: number;
  }): Promise<VsphereEvent[]>;
}

/**
 * Normalized vSphere event shape. Mirrors the union of fields the
 * SOAP `Event` base class and the REST `/api/vcenter/event` payload
 * expose. `vm` / `host` are present when the event is resource-scoped.
 */
export interface VsphereEvent {
  /** Per-session monotonic id (the natural event id). */
  key: number;
  /** Groups related events emitted for a single task. */
  chainId?: number;
  /** ISO-8601 UTC. */
  createdTime: string;
  /** Initiating principal. May be a human, a system actor, or missing. */
  userName?: string;
  /** Event class name (e.g. `VmPoweredOffEvent`). */
  eventTypeId: string;
  /** Human-friendly description. */
  fullFormattedMessage?: string;
  /** Present when VM-scoped. */
  vm?: { moid: string; name?: string };
  /** Present when host-scoped. */
  host?: { moid: string; name?: string };
}

// ── Constructor options ────────────────────────────────────

export interface VsphereEventSourceOptions {
  client: VsphereEventClient;
  /** Default 15_000ms. */
  pollIntervalMs?: number;
  /**
   * Seed the cursor at this key on first start. When undefined the
   * adapter requests up to 100 events to anchor the cursor at the
   * tail (only newer events emit). Pass `0` to replay everything.
   */
  initialLookbackKey?: number;
  /** Page size per poll. Default 200 — generous, well under SOAP caps. */
  pageSize?: number;
  /** Hook for tests / observability. Defaults to a no-op. */
  onError?: (err: unknown) => void;
}

// ── Constants ──────────────────────────────────────────────

const PROVIDER: GraphProvider = "vsphere";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_BOOTSTRAP_LIMIT = 100;

// ── Event-type mapping ─────────────────────────────────────

/**
 * vSphere event class → normalized AttributionEventType. The mapping
 * is intentionally narrow: anything not listed falls through to
 * `unknown_event` so the raw `eventTypeId` is still recoverable from
 * `rawSource` for the postmortem. Adding a mapping is a deliberate
 * schema change — don't extend speculatively.
 */
const EVENT_TYPE_MAP: Record<string, AttributionEventType> = {
  // VM lifecycle
  VmPoweredOffEvent: "vm_stop",
  VmStoppingEvent: "vm_stop",
  VmPoweredOnEvent: "vm_start",
  VmStartingEvent: "vm_start",
  VmResettingEvent: "vm_reboot",
  VmSuspendedEvent: "vm_suspend",
  VmSuspendingEvent: "vm_suspend",
  VmCreatedEvent: "vm_create",
  VmRemovedEvent: "vm_delete",
  VmMigratedEvent: "vm_migrate",
  DrsVmMigratedEvent: "vm_migrate",
  VmRelocatedEvent: "vm_migrate",
  // Host lifecycle
  HostEnteredMaintenanceModeEvent: "host_enter_maintenance",
  HostExitMaintenanceModeEvent: "host_exit_maintenance",
  HostShutdownEvent: "host_reboot",
  HostDisconnectedEvent: "host_disconnect",
  HostNotRespondingEvent: "host_disconnect",
  HostConnectedEvent: "host_connect",
};

/**
 * userName values vCenter uses for non-human originators. Matching is
 * case-insensitive and tolerates the common `DOMAIN\\name` prefix
 * (e.g. `VSPHERE.LOCAL\\vpxd-extension`).
 */
const SYSTEM_USER_IDENTITIES = new Set([
  "drs",
  "vc",
  "vpxd",
  "vpxd-extension",
  "vpxd-extension-1",
  "system",
  "ha",
]);

/**
 * vSphere event classes that are intrinsically system-initiated even
 * when the userName is misleading or absent — DRS migrations and HA
 * restarts are the canonical examples.
 */
const SYSTEM_EVENT_TYPES = new Set([
  "DrsVmMigratedEvent",
  "DrsVmPoweredOnEvent",
  "HaRestartedVmEvent",
]);

// ── Adapter ────────────────────────────────────────────────

export class VsphereEventSource implements EventSource {
  readonly name = "vsphere-events";
  readonly provider: GraphProvider = PROVIDER;

  private readonly client: VsphereEventClient;
  private readonly pollIntervalMs: number;
  private readonly pageSize: number;
  private readonly initialLookbackKey?: number;
  private readonly onError: (err: unknown) => void;

  private lastSeenKey?: number;
  private abort?: AbortController;
  private running = false;
  private loopDone?: Promise<void>;

  constructor(opts: VsphereEventSourceOptions) {
    this.client = opts.client;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.initialLookbackKey = opts.initialLookbackKey;
    this.onError =
      opts.onError ??
      ((err) => {
        // Best-effort default: log but never throw out of the loop.
        // The registry can supply a richer hook (metrics, structured log).
        // eslint-disable-next-line no-console
        console.warn("[vsphere-events] poll error:", err);
      });
  }

  async start(emit: (e: AttributionEvent) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.lastSeenKey = this.initialLookbackKey;

    // If the caller didn't pin a cursor, bootstrap by reading a short
    // tail and advancing past it — only events emitted AFTER startup
    // should flow downstream. Without this, every restart would replay
    // history into the correlator.
    if (this.lastSeenKey === undefined) {
      try {
        const bootstrap = await this.client.queryEventsSince({
          limit: DEFAULT_BOOTSTRAP_LIMIT,
        });
        if (bootstrap.length > 0) {
          this.lastSeenKey = maxKey(bootstrap);
        }
      } catch (err) {
        this.onError(err);
      }
    }

    this.loopDone = this.runLoop(emit);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    if (this.loopDone) {
      try {
        await this.loopDone;
      } catch {
        // The loop is supposed to swallow errors; defensive catch in
        // case a future change lets one slip out.
      }
    }
    this.abort = undefined;
    this.loopDone = undefined;
  }

  // ── Loop ──────────────────────────────────────────────────

  private async runLoop(
    emit: (e: AttributionEvent) => void,
  ): Promise<void> {
    const signal = this.abort?.signal;
    while (this.running && signal && !signal.aborted) {
      try {
        await this.pollOnce(emit);
      } catch (err) {
        this.onError(err);
      }
      if (!this.running || signal.aborted) break;
      await sleepInterruptible(this.pollIntervalMs, signal);
    }
  }

  private async pollOnce(emit: (e: AttributionEvent) => void): Promise<void> {
    const page = await this.client.queryEventsSince({
      sinceKey: this.lastSeenKey,
      limit: this.pageSize,
    });
    if (page.length === 0) return;

    // The contract is oldest-first; defend against a client that
    // returns out-of-order pages by sorting before iterating so
    // `lastSeenKey` advances monotonically.
    const sorted = [...page].sort((a, b) => a.key - b.key);
    for (const raw of sorted) {
      if (this.lastSeenKey !== undefined && raw.key <= this.lastSeenKey) {
        // Defensive de-dup: a misbehaving client could re-page an
        // already-seen key. emit() is supposed to be idempotent on
        // the event id but we don't need to do the work either.
        continue;
      }
      try {
        emit(toAttributionEvent(raw));
      } catch (err) {
        // A bad raw event must not stall the cursor or kill the loop.
        this.onError(err);
      }
      this.lastSeenKey = raw.key;
    }
  }
}

// ── Pure mappers (exported for unit testing) ───────────────

/**
 * Build a normalized AttributionEvent from a raw vSphere event.
 * Pure function — no I/O, no clock, no global state. Safe to call
 * from outside the adapter (e.g., from a CloudTrail-style replay
 * harness) so long as the input matches `VsphereEvent`.
 */
export function toAttributionEvent(raw: VsphereEvent): AttributionEvent {
  const eventType = mapEventType(raw.eventTypeId);
  const actor = mapActor(raw);
  const targetResourceId = mapTargetResourceId(raw);

  const event: AttributionEvent = {
    id: vsphereEventId(raw.key),
    provider: PROVIDER,
    eventType,
    actor,
    occurredAt: raw.createdTime,
    rawSource: { ...raw },
  };
  if (targetResourceId !== undefined) {
    event.targetResourceId = targetResourceId;
  }
  return event;
}

export function mapEventType(eventTypeId: string): AttributionEventType {
  return EVENT_TYPE_MAP[eventTypeId] ?? "unknown_event";
}

export function mapActor(raw: VsphereEvent): AttributionActor {
  // System-classified event classes win regardless of userName — DRS
  // migrations occasionally surface with a `vpxd-extension` userName
  // and we still want kind: 'system'.
  if (SYSTEM_EVENT_TYPES.has(raw.eventTypeId)) {
    return {
      kind: "system",
      identity: normalizeIdentity(raw.userName) ?? raw.eventTypeId,
      via: "vcenter_drs",
    };
  }

  const identity = normalizeIdentity(raw.userName);

  if (identity === undefined) {
    return { kind: "unknown" };
  }

  if (isSystemUserName(identity)) {
    return {
      kind: "system",
      identity,
      via: "vcenter_system",
    };
  }

  return {
    kind: "human",
    identity,
    via: "vcenter_api",
  };
}

export function mapTargetResourceId(raw: VsphereEvent): string | undefined {
  if (raw.vm?.moid) {
    return `${PROVIDER}:vsphere_vm:${raw.vm.moid}`;
  }
  if (raw.host?.moid) {
    return `${PROVIDER}:vsphere_host:${raw.host.moid}`;
  }
  return undefined;
}

export function vsphereEventId(key: number): string {
  return `${PROVIDER}:${key}`;
}

// ── Internal helpers ───────────────────────────────────────

function normalizeIdentity(userName: string | undefined): string | undefined {
  if (!userName) return undefined;
  const trimmed = userName.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function isSystemUserName(identity: string): boolean {
  // Strip a single `DOMAIN\name` prefix (e.g. `VSPHERE.LOCAL\\vpxd`).
  // vCenter uses both `\\` and `\` depending on the source surface.
  const bare = identity.includes("\\")
    ? identity.split("\\").pop() ?? identity
    : identity;
  return SYSTEM_USER_IDENTITIES.has(bare.toLowerCase());
}

function maxKey(events: VsphereEvent[]): number {
  let m = events[0].key;
  for (const e of events) {
    if (e.key > m) m = e.key;
  }
  return m;
}

/**
 * Promise-based sleep that resolves either after `ms` elapses or as
 * soon as `signal` aborts — whichever comes first. Never throws on
 * abort so the caller's loop can break cleanly on the next check.
 */
function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
