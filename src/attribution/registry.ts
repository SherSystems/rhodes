// ============================================================
// RHODES — Attribution Event-Source Registry
//
// Per-substrate event-source adapters (Proxmox task log, vCenter
// event API, CloudTrail, Azure Activity Log, K8s audit log) register
// here. The registry starts/stops them as a group and routes their
// emitted events into the AttributionStore.
//
// Mirrors the discovery-scheduler shape in src/graph/ — adapters
// run their own poll/stream loops; the registry just owns lifecycle.
// ============================================================

import type { AttributionStore } from "./store.js";
import type { AttributionEvent, EventSource } from "./types.js";

export class EventSourceRegistry {
  private sources: EventSource[] = [];
  private started = false;

  constructor(private readonly store: AttributionStore) {}

  add(source: EventSource): void {
    if (this.started) {
      throw new Error(
        `EventSourceRegistry: cannot add source '${source.name}' after start()`,
      );
    }
    this.sources.push(source);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all(
      this.sources.map((src) =>
        src.start((e: AttributionEvent) => this.store.upsertEvent(e)),
      ),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.all(this.sources.map((src) => src.stop()));
  }

  /** For tests / observability. */
  registeredSources(): ReadonlyArray<{ name: string; provider: string }> {
    return this.sources.map((s) => ({ name: s.name, provider: s.provider }));
  }
}
