// ============================================================
// RHODES — Attribution Event Source: Proxmox Task Log
//
// Polls the Proxmox cluster task log and emits one normalized
// AttributionEvent per task. The AttributionStore deduplicates by
// id, the correlator matches by target_resource_id + time window,
// and the incident pipeline asks "should we suppress this state
// change?" before opening an incident.
//
// Why polling and not streaming: Proxmox exposes no push channel
// for the task log — `GET /api2/json/cluster/tasks?since=<unix>` is
// the only first-class option. A 30s tick lines up with the default
// correlator lookback (300s) and the typical incident-detection
// latency of the metrics pipeline, so by the time a state-change
// observation lands, the originating task has already been ingested.
//
// Mapping rules (proxmox task `type` → AttributionEventType):
//   qmstop, lxc_stop          → vm_stop
//   qmstart, lxc_start        → vm_start
//   qmreboot, lxc_reboot      → vm_reboot
//   qmsuspend                 → vm_suspend
//   qmresume                  → vm_resume
//   qmcreate                  → vm_create
//   qmdestroy, lxc_destroy    → vm_delete
//   qmigrate, qmclone         → vm_migrate
//   *                         → unknown_event (kept, not dropped)
//
// Status filter: only emit tasks whose `status` is `OK` or
// `RUNNING`. `ERROR` tasks did NOT mutate state — the operator hit
// shutdown, Proxmox refused, the VM is still running, and a real
// incident might still need to open if the VM later crashes.
//
// Constraints:
// - Never throw out of the poll loop. Errors are logged (via the
//   injected logger or console) and the next tick proceeds.
// - `stop()` must cleanly cancel any pending wait so process
//   shutdown isn't blocked on a 30s timer.
// - Structural client interface: tests pass a fake; production
//   wires the real ProxmoxClient once `listClusterTasks` lands on
//   it. The existing `getTasks(node)` is per-node, not cluster-wide,
//   so an adapter wrapper is part of the production follow-up.
// ============================================================

import type { GraphProvider } from "../../graph/types.js";
import type {
  AttributionActor,
  AttributionEvent,
  AttributionEventType,
  EventSource,
} from "../types.js";

// ── Minimal Proxmox client surface this source depends on ─────
//
// Declared as a structural interface (not `ProxmoxClient` itself)
// so tests can pass a fake without instantiating the real HTTPS
// client. The real client currently exposes `getTasks(node)`; the
// cluster-wide `listClusterTasks` form is a thin wrapper added in a
// follow-up commit. Keeping the dependency narrow here avoids
// pinning the source to incidental fields of the full client.
export interface ProxmoxTaskClient {
  /** GET /api2/json/cluster/tasks?since=<unixtime> */
  listClusterTasks(opts: {
    since?: number;
    typefilter?: string[];
    limit?: number;
  }): Promise<ProxmoxTask[]>;
}

export interface ProxmoxTask {
  /** Unique Proxmox ID — natural event id, never collides. */
  upid: string;
  node: string;
  /** Proxmox task type — `qmstop`, `qmstart`, `lxc_start`, etc. */
  type: string;
  /** VMID as a string. Absent for cluster-level tasks. */
  id?: string;
  /** Initiating user, e.g. `root@pam`, `pranav@pve`. */
  user: string;
  /** Unix seconds at task start. */
  starttime: number;
  /** Unix seconds at task end (absent while RUNNING). */
  endtime?: number;
  /** `OK`, `ERROR`, `RUNNING`. */
  status?: string;
}

// ── Logger surface ────────────────────────────────────────────
//
// Avoid pulling in the full logger module so this file stays
// trivially injectable in tests. Anything `console`-shaped works.
export interface TaskLogSourceLogger {
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface ProxmoxTaskLogSourceOptions {
  client: ProxmoxTaskClient;
  /** Poll cadence in milliseconds. Defaults to 30s. */
  pollIntervalMs?: number;
  /**
   * On startup, look back this many seconds so the first poll
   * catches recently-completed tasks (default 5 minutes — wider
   * than the correlator's 5-minute lookback by a margin).
   */
  initialLookbackSec?: number;
  /** Optional logger override; defaults to console.warn. */
  logger?: TaskLogSourceLogger;
  /** Optional clock override for tests. Returns Unix seconds. */
  nowSec?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_INITIAL_LOOKBACK_SEC = 300;

// In-memory bound on how many UPIDs we remember as "already emitted".
// The store is the authoritative dedup; this cap just keeps the Set
// from growing without bound across a long-running process.
const SEEN_UPID_CAP = 10_000;

/**
 * Long-running adapter that turns Proxmox task-log entries into
 * AttributionEvents. Implements the `EventSource` contract from
 * `src/attribution/types.ts` so the `EventSourceRegistry` can manage
 * its lifecycle alongside other substrates' sources.
 */
export class ProxmoxTaskLogSource implements EventSource {
  readonly name = "proxmox-task-log";
  readonly provider: GraphProvider = "proxmox";

  private readonly client: ProxmoxTaskClient;
  private readonly pollIntervalMs: number;
  private readonly initialLookbackSec: number;
  private readonly logger: TaskLogSourceLogger;
  private readonly nowSec: () => number;

  private readonly seenUpids = new Set<string>();
  /** Unix seconds; high-water mark across successful polls. */
  private highWaterSec = 0;
  private abortController?: AbortController;
  private loopPromise?: Promise<void>;

  constructor(opts: ProxmoxTaskLogSourceOptions) {
    this.client = opts.client;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.initialLookbackSec =
      opts.initialLookbackSec ?? DEFAULT_INITIAL_LOOKBACK_SEC;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[${this.name}] ${msg}`, ctx ?? {}),
    };
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Begin the poll loop. Resolves once the loop is scheduled — the
   * actual polling continues in the background until `stop()`.
   */
  async start(emit: (e: AttributionEvent) => void): Promise<void> {
    if (this.abortController) {
      // start() called twice — quietly no-op; idempotent boot.
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.highWaterSec = this.nowSec() - this.initialLookbackSec;
    this.loopPromise = this.runLoop(emit, controller.signal);
  }

  async stop(): Promise<void> {
    if (!this.abortController) return;
    this.abortController.abort();
    const pending = this.loopPromise;
    this.abortController = undefined;
    this.loopPromise = undefined;
    if (pending) {
      // Loop swallows AbortError internally, so this just awaits the
      // current poll iteration to drain. Won't reject.
      await pending;
    }
  }

  // ── Internal ───────────────────────────────────────────────

  private async runLoop(
    emit: (e: AttributionEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await this.pollOnce(emit);
      if (signal.aborted) return;
      const interrupted = await sleepOrAbort(this.pollIntervalMs, signal);
      if (interrupted) return;
    }
  }

  /**
   * One poll iteration. Pulls tasks newer than the high-water mark,
   * maps each into an AttributionEvent, and emits. Errors are
   * logged and swallowed so the loop survives transient outages.
   *
   * Exposed (private but stable signature) to make per-tick testing
   * straightforward without spinning up the timer chain.
   */
  private async pollOnce(emit: (e: AttributionEvent) => void): Promise<void> {
    let tasks: ProxmoxTask[];
    try {
      tasks = await this.client.listClusterTasks({
        since: this.highWaterSec,
      });
    } catch (err) {
      this.logger.warn("listClusterTasks failed; will retry next tick", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let maxStart = this.highWaterSec;
    for (const task of tasks) {
      if (task.starttime > maxStart) maxStart = task.starttime;

      // Skip tasks that failed — they did not mutate state, so they
      // are NOT valid attributions for a later state-change
      // observation. RUNNING tasks are kept: the action is in-flight
      // and the state change may have already propagated.
      const status = task.status;
      if (status && status !== "OK" && status !== "RUNNING") continue;

      if (this.seenUpids.has(task.upid)) continue;

      const event = this.toAttributionEvent(task);
      try {
        emit(event);
      } catch (err) {
        this.logger.warn("emit threw; continuing", {
          upid: task.upid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.rememberUpid(task.upid);
    }
    this.highWaterSec = maxStart;
  }

  private rememberUpid(upid: string): void {
    if (this.seenUpids.size >= SEEN_UPID_CAP) {
      // Drop the oldest insertion-order entry. Set iteration order
      // in V8 is insertion order, so the first key is the oldest.
      const oldest = this.seenUpids.values().next().value;
      if (oldest !== undefined) this.seenUpids.delete(oldest);
    }
    this.seenUpids.add(upid);
  }

  private toAttributionEvent(task: ProxmoxTask): AttributionEvent {
    return {
      id: `proxmox:${task.upid}`,
      provider: "proxmox",
      eventType: mapEventType(task.type),
      targetResourceId: targetResourceIdFor(task),
      actor: mapActor(task.user),
      occurredAt: new Date(task.starttime * 1000).toISOString(),
      rawSource: { ...task },
    };
  }
}

// ── Pure mapping helpers (exported for unit testing) ──────────

export function mapEventType(proxmoxType: string): AttributionEventType {
  switch (proxmoxType) {
    case "qmstop":
    case "lxc_stop":
      return "vm_stop";
    case "qmstart":
    case "lxc_start":
      return "vm_start";
    case "qmreboot":
    case "lxc_reboot":
      return "vm_reboot";
    case "qmsuspend":
      return "vm_suspend";
    case "qmresume":
      return "vm_resume";
    case "qmcreate":
      return "vm_create";
    case "qmdestroy":
    case "lxc_destroy":
      return "vm_delete";
    case "qmigrate":
    case "qmclone":
      return "vm_migrate";
    default:
      return "unknown_event";
  }
}

export function mapActor(user: string | undefined): AttributionActor {
  if (!user || user.trim().length === 0) {
    return { kind: "unknown", via: "proxmox_api" };
  }
  return { kind: "human", identity: user, via: "proxmox_api" };
}

/**
 * Compute the graph Resource.id this task targets. Matches the
 * id construction in `src/providers/proxmox/graph-writer.ts` so the
 * correlator can look up by the same key the discovery writer
 * stamped on the resource.
 *
 * `lxc_*` task types are containers; everything else with a VMID is
 * a QEMU VM. Cluster-level tasks (no `id`) get no resource id and
 * land as provider-level activity instead.
 */
export function targetResourceIdFor(task: ProxmoxTask): string | undefined {
  if (!task.id) return undefined;
  const isContainer = task.type.startsWith("lxc_");
  const resourceType = isContainer ? "proxmox_container" : "proxmox_vm";
  return `proxmox:${resourceType}:${task.id}`;
}

// ── AbortController-aware sleep ───────────────────────────────

/**
 * Sleep for `ms`, but resolve immediately if `signal` aborts.
 * Returns true when interrupted by abort, false on normal timeout.
 * Used by the poll loop so `stop()` doesn't block on a 30s timer.
 */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
