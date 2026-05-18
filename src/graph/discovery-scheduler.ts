// ============================================================
// RHODES — Graph Discovery Scheduler
//
// The scheduler is what makes the graph layer actually populate at
// runtime. Provider writers (VMware, Proxmox, AWS, ...) implement
// the DiscoveryWriter contract and get registered with one of these;
// the scheduler then drives them on a per-writer interval, runs the
// resolver after each pass to maintain cross-provider `manifests_as`
// edges, and surfaces per-writer DiscoveryReports for tests and
// observability.
//
// Design constraints (enforced here, not on the writers):
//   - A single writer NEVER runs concurrently with itself. If
//     Proxmox is wedged on a 5-minute API call, we let it sit;
//     piling overlapping discoveries on top would just multiply
//     the wedge. Per-writer in-flight bool gates this.
//   - Writers DO run concurrently across providers. vSphere and
//     Proxmox should not block each other.
//   - One writer throwing must not crash the scheduler. The error
//     lands in DiscoveryReport.errors and the loop keeps going.
//   - stop() is awaitable and must drain in-flight discoveries —
//     otherwise the next `start()` (or test shutdown) races writers
//     mid-flight against a closed store.
//   - runOnce() exists for tests and for the bootstrap "run on
//     boot" path. It bypasses setInterval entirely.
//
// What the scheduler does NOT do:
//   - It doesn't own the writers' clients. Bootstrap is where the
//     VSphereClient / ProxmoxClient get wired up.
//   - It doesn't decide whether a resource is fresh. That's
//     `FRESHNESS_WINDOW_SEC` + the query layer.
//   - It doesn't aggregate cross-pass metrics. Each pass produces a
//     DiscoveryReport; long-horizon telemetry is a separate job.
// ============================================================

import { runResolver } from "./resolver.js";
import type { GraphStore } from "./store.js";
import { runDiscoveryPass } from "./discovery-loop.js";

// ── Public contract ───────────────────────────────────────────

/**
 * A writer is whatever knows how to translate one provider's API
 * shape into the graph. The vSphere and Proxmox writers in
 * `src/providers/(vmware|proxmox)/graph-writer.ts` satisfy this
 * surface with a thin adapter declared in bootstrap.
 */
export interface DiscoveryWriter {
  /** Human-friendly name for logs. Must be stable; used as a map key. */
  name: string;
  /** Called once at scheduler boot, after the store is open. */
  register(store: GraphStore): void;
  /** Called periodically; should be idempotent + cancellable. */
  discover(): Promise<DiscoveryReport>;
}

export interface DiscoveryReport {
  writer: string;
  startedAt: string;
  finishedAt: string;
  resourcesUpserted: number;
  relationshipsUpserted: number;
  errors: string[];
}

export interface SchedulerOptions {
  /** Per-writer interval in ms. Default: 60000 (60s). */
  intervalMs?: number;
  /** Run on boot (don't wait for first interval tick). Default: true. */
  runOnBoot?: boolean;
  /** Run runResolver() after each discovery pass. Default: true. */
  resolverEnabled?: boolean;
  /** Override the default logger (defaults to console). */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ── Internal entry per registered writer ──────────────────────

interface WriterEntry {
  writer: DiscoveryWriter;
  intervalMs: number;
  inFlight: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** Promise of the currently in-flight pass, if any. Used by stop(). */
  pending: Promise<DiscoveryReport> | null;
}

const DEFAULT_INTERVAL_MS = 60_000;

// ── Scheduler ─────────────────────────────────────────────────

export class DiscoveryScheduler {
  private readonly store: GraphStore;
  private readonly writers = new Map<string, WriterEntry>();
  private readonly defaultIntervalMs: number;
  private readonly runOnBoot: boolean;
  private readonly resolverEnabled: boolean;
  private readonly logger: NonNullable<SchedulerOptions["logger"]>;
  private started = false;

  constructor(store: GraphStore, opts: SchedulerOptions = {}) {
    this.store = store;
    this.defaultIntervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.runOnBoot = opts.runOnBoot ?? true;
    this.resolverEnabled = opts.resolverEnabled ?? true;
    this.logger = opts.logger ?? {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
  }

  /**
   * Register a writer. May be called before or after start(); if the
   * scheduler is already running, the writer's timer starts immediately
   * and (if runOnBoot) its first pass kicks off.
   */
  add(writer: DiscoveryWriter, opts: { intervalMs?: number } = {}): void {
    if (this.writers.has(writer.name)) {
      throw new Error(
        `DiscoveryScheduler: writer '${writer.name}' is already registered`,
      );
    }
    writer.register(this.store);
    const entry: WriterEntry = {
      writer,
      intervalMs: opts.intervalMs ?? this.defaultIntervalMs,
      inFlight: false,
      timer: null,
      pending: null,
    };
    this.writers.set(writer.name, entry);
    if (this.started) {
      this.scheduleEntry(entry);
      if (this.runOnBoot) {
        void this.runEntryOnce(entry);
      }
    }
  }

  /**
   * Start all registered writers. Idempotent; calling twice is a no-op.
   * If runOnBoot, fires an immediate pass for each writer in parallel
   * before the first interval tick.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.logger.info(
      `[graph-scheduler] starting with ${this.writers.size} writer(s); resolver=${this.resolverEnabled}, runOnBoot=${this.runOnBoot}`,
    );
    for (const entry of this.writers.values()) {
      this.scheduleEntry(entry);
    }
    if (this.runOnBoot && this.writers.size > 0) {
      // Don't await — the scheduler returns control to the caller
      // immediately. Each pass's errors land in its own report.
      void this.runOnce();
    }
  }

  /**
   * Stop all timers and wait for in-flight discoveries to drain.
   * Safe to call when not started; safe to call multiple times.
   *
   * Drain semantics matter: bootstrap shutdown often follows with
   * `store.close()` which would explode mid-flight INSERTs. We wait.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const pendings: Array<Promise<DiscoveryReport>> = [];
    for (const entry of this.writers.values()) {
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
      if (entry.pending) {
        pendings.push(
          // Swallow — we already logged on the original path.
          entry.pending.catch(() => ({
            writer: entry.writer.name,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            resourcesUpserted: 0,
            relationshipsUpserted: 0,
            errors: ["drained on stop"],
          })),
        );
      }
    }
    await Promise.allSettled(pendings);
  }

  /**
   * Trigger one discovery pass for every registered writer right now,
   * in parallel. Used by tests and by the runOnBoot path; production
   * callers normally rely on the interval timer.
   *
   * Writers already mid-flight are skipped this round (their next
   * interval tick will run them) — same in-flight rule as the timer.
   */
  async runOnce(): Promise<DiscoveryReport[]> {
    const passes: Array<Promise<DiscoveryReport>> = [];
    for (const entry of this.writers.values()) {
      const p = this.runEntryOnce(entry);
      if (p) passes.push(p);
    }
    const results = await Promise.all(passes);
    if (this.resolverEnabled && results.length > 0) {
      try {
        runResolver(this.store);
      } catch (err) {
        this.logger.error(
          `[graph-scheduler] resolver failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return results;
  }

  // ── internals ───────────────────────────────────────────────

  private scheduleEntry(entry: WriterEntry): void {
    if (entry.timer) return;
    entry.timer = setInterval(() => {
      void this.runEntryOnce(entry);
    }, entry.intervalMs);
    // setInterval keeps the event loop alive; in CLI processes that's
    // fine (RHODES is a long-running daemon), but `unref()` matches
    // the healing engine's expectation that timers don't block exit
    // in test contexts where stop() isn't called.
    if (typeof entry.timer.unref === "function") {
      entry.timer.unref();
    }
  }

  /**
   * Run one pass for a single writer, respecting the in-flight guard.
   * Returns the pass promise (or null if the writer was already busy).
   */
  private runEntryOnce(entry: WriterEntry): Promise<DiscoveryReport> | null {
    if (entry.inFlight) {
      // Drop the tick — the writer is already running. This is the
      // exact behavior the "stuck writer doesn't pile up" rule
      // exists to enforce.
      this.logger.warn(
        `[graph-scheduler] ${entry.writer.name}: skipping tick — previous pass still in flight`,
      );
      return null;
    }
    entry.inFlight = true;
    const pass = (async (): Promise<DiscoveryReport> => {
      try {
        const report = await runDiscoveryPass(entry.writer, this.store);
        if (report.errors.length > 0) {
          this.logger.warn(
            `[graph-scheduler] ${entry.writer.name}: pass completed with ${report.errors.length} error(s): ${report.errors.join("; ")}`,
          );
        } else {
          this.logger.info(
            `[graph-scheduler] ${entry.writer.name}: +${report.resourcesUpserted} resources, +${report.relationshipsUpserted} relationships`,
          );
        }
        return report;
      } catch (err) {
        // runDiscoveryPass itself absorbs writer.discover() errors, so
        // this catch is for the truly exceptional case (store fault,
        // OOM serializing rows, ...). Don't crash the scheduler.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[graph-scheduler] ${entry.writer.name}: pass crashed: ${msg}`,
        );
        return {
          writer: entry.writer.name,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          resourcesUpserted: 0,
          relationshipsUpserted: 0,
          errors: [msg],
        };
      } finally {
        entry.inFlight = false;
        entry.pending = null;
      }
    })();
    entry.pending = pass;
    return pass;
  }
}
