// ============================================================
// Attribution Store — idempotent upserts, time-window queries,
// retention pruning.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AttributionStore,
  EVENT_RETENTION_SEC,
  type AttributionEvent,
} from "../../src/attribution/index.js";

function ev(over: Partial<AttributionEvent> = {}): AttributionEvent {
  return {
    id: `proxmox:e-${Math.random().toString(36).slice(2)}`,
    provider: "proxmox",
    eventType: "vm_stop",
    targetResourceId: "proxmox:proxmox_vm:200",
    actor: { kind: "human", identity: "pranav", via: "proxmox_ui" },
    occurredAt: new Date().toISOString(),
    rawSource: { task: "qm stop 200" },
    ...over,
  };
}

describe("AttributionStore", () => {
  let dir: string;
  let store: AttributionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-attr-store-"));
    store = new AttributionStore(join(dir, "attribution.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsertEvent persists with all fields", () => {
    const e = ev({ id: "proxmox:42" });
    store.upsertEvent(e);
    const all = store.listEvents();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("proxmox:42");
    expect(all[0].actor.kind).toBe("human");
    expect(all[0].actor.identity).toBe("pranav");
    expect(all[0].actor.via).toBe("proxmox_ui");
    expect(all[0].rawSource).toEqual({ task: "qm stop 200" });
  });

  it("upsertEvent is idempotent — same id, no duplicate", () => {
    store.upsertEvent(ev({ id: "proxmox:42" }));
    store.upsertEvent(ev({ id: "proxmox:42" }));
    store.upsertEvent(ev({ id: "proxmox:42" }));
    expect(store.listEvents()).toHaveLength(1);
  });

  it("eventsForResource filters by resource id and time window", () => {
    const now = Date.now();
    store.upsertEvent(
      ev({
        id: "in-window",
        occurredAt: new Date(now - 60_000).toISOString(),
      }),
    );
    store.upsertEvent(
      ev({
        id: "before-window",
        occurredAt: new Date(now - 600_000).toISOString(),
      }),
    );
    store.upsertEvent(
      ev({
        id: "after-window",
        occurredAt: new Date(now + 60_000).toISOString(),
      }),
    );
    store.upsertEvent(
      ev({
        id: "wrong-resource",
        targetResourceId: "proxmox:proxmox_vm:999",
        occurredAt: new Date(now - 30_000).toISOString(),
      }),
    );

    const since = new Date(now - 120_000).toISOString();
    const until = new Date(now).toISOString();
    const hits = store.eventsForResource(
      "proxmox:proxmox_vm:200",
      since,
      until,
    );
    expect(hits.map((h) => h.id)).toEqual(["in-window"]);
  });

  it("eventsByProvider returns only events with NULL target_resource_id", () => {
    const now = Date.now();
    store.upsertEvent(
      ev({
        id: "scoped",
        // has targetResourceId → not returned by eventsByProvider
        occurredAt: new Date(now - 30_000).toISOString(),
      }),
    );
    store.upsertEvent(
      ev({
        id: "provider-level",
        targetResourceId: undefined,
        occurredAt: new Date(now - 30_000).toISOString(),
      }),
    );
    const since = new Date(now - 60_000).toISOString();
    const until = new Date(now).toISOString();
    const hits = store.eventsByProvider("proxmox", since, until);
    expect(hits.map((h) => h.id)).toEqual(["provider-level"]);
  });

  it("pruneStale deletes events older than EVENT_RETENTION_SEC", () => {
    const now = Date.now();
    // EVENT_RETENTION_SEC is 86_400 (24h)
    store.upsertEvent(
      ev({
        id: "fresh",
        occurredAt: new Date(now - 1000).toISOString(),
      }),
    );
    store.upsertEvent(
      ev({
        id: "old",
        occurredAt: new Date(
          now - (EVENT_RETENTION_SEC + 3600) * 1000,
        ).toISOString(),
      }),
    );
    expect(store.listEvents()).toHaveLength(2);
    const deleted = store.pruneStale();
    expect(deleted).toBe(1);
    expect(store.listEvents().map((e) => e.id)).toEqual(["fresh"]);
  });
});
