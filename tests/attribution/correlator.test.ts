// ============================================================
// Attribution Correlator — confidence ladder, time-window match,
// transition-aware matching, suppression policy.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AttributionCorrelator,
  AttributionStore,
  expectedEventTypesFor,
  type AttributionEvent,
  type StateChangeObservation,
} from "../../src/attribution/index.js";

const RESOURCE = "proxmox:proxmox_vm:200";

function evt(over: Partial<AttributionEvent> = {}): AttributionEvent {
  return {
    id: `proxmox:e-${Math.random().toString(36).slice(2)}`,
    provider: "proxmox",
    eventType: "vm_stop",
    targetResourceId: RESOURCE,
    actor: { kind: "human", identity: "pranav", via: "proxmox_ui" },
    occurredAt: new Date().toISOString(),
    rawSource: { task: "qm stop 200" },
    ...over,
  };
}

function obs(over: Partial<StateChangeObservation> = {}): StateChangeObservation {
  return {
    resourceId: RESOURCE,
    fromState: "running",
    toState: "stopped",
    observedAt: new Date().toISOString(),
    ...over,
  };
}

describe("AttributionCorrelator", () => {
  let dir: string;
  let store: AttributionStore;
  let correlator: AttributionCorrelator;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-attr-test-"));
    store = new AttributionStore(join(dir, "attribution.db"));
    correlator = new AttributionCorrelator(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when nothing is in the store", () => {
    expect(correlator.findBestMatch(obs())).toBeNull();
  });

  it("returns high-confidence when event type matches transition + tight window", () => {
    store.upsertEvent(
      evt({
        eventType: "vm_stop",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const m = correlator.findBestMatch(obs());
    expect(m).not.toBeNull();
    expect(m!.matchConfidence).toBe("high");
    expect(m!.event.eventType).toBe("vm_stop");
  });

  it("returns medium when event is recent but wrong type for the transition", () => {
    store.upsertEvent(
      evt({
        eventType: "config_change",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const m = correlator.findBestMatch(obs());
    expect(m).not.toBeNull();
    expect(m!.matchConfidence).toBe("medium");
  });

  it("returns medium when type matches but window is past the tight high-confidence threshold", () => {
    store.upsertEvent(
      evt({
        eventType: "vm_stop",
        occurredAt: new Date(Date.now() - 120_000).toISOString(),
      }),
    );
    const m = correlator.findBestMatch(obs());
    expect(m).not.toBeNull();
    // Beyond highConfidenceWindowSec (30s default) → medium, not high
    expect(m!.matchConfidence).toBe("medium");
  });

  it("returns null when nothing is within the lookback window", () => {
    store.upsertEvent(
      evt({
        eventType: "vm_stop",
        // 10 minutes ago — past the default 300s lookback
        occurredAt: new Date(Date.now() - 600_000).toISOString(),
      }),
    );
    expect(correlator.findBestMatch(obs())).toBeNull();
  });

  it("ignores events for a different resource", () => {
    store.upsertEvent(
      evt({
        targetResourceId: "proxmox:proxmox_vm:201",
        eventType: "vm_stop",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    expect(correlator.findBestMatch(obs())).toBeNull();
  });

  it("ignores events targeting a resource without target_resource_id (provider-level only)", () => {
    store.upsertEvent(
      evt({
        targetResourceId: undefined,
        eventType: "vm_stop",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    // v0 policy: don't soft-correlate on provider-only events
    expect(correlator.findBestMatch(obs())).toBeNull();
  });

  it("among multiple matches, picks the most recent (DESC by occurredAt)", () => {
    store.upsertEvent(
      evt({
        id: "proxmox:older",
        eventType: "vm_stop",
        actor: { kind: "human", identity: "alice" },
        occurredAt: new Date(Date.now() - 20_000).toISOString(),
      }),
    );
    store.upsertEvent(
      evt({
        id: "proxmox:newer",
        eventType: "vm_stop",
        actor: { kind: "human", identity: "bob" },
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const m = correlator.findBestMatch(obs());
    expect(m!.event.id).toBe("proxmox:newer");
    expect(m!.event.actor.identity).toBe("bob");
  });

  it("shouldSuppress returns the attribution ONLY for high confidence", () => {
    store.upsertEvent(
      evt({
        eventType: "vm_stop",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const high = correlator.shouldSuppress(obs());
    expect(high).not.toBeNull();
    expect(high!.matchConfidence).toBe("high");

    // Reset to a medium-only scenario
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "rhodes-attr-test-"));
    store = new AttributionStore(join(dir, "attribution.db"));
    correlator = new AttributionCorrelator(store);
    store.upsertEvent(
      evt({
        eventType: "config_change",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const medium = correlator.shouldSuppress(obs());
    expect(medium).toBeNull(); // medium-confidence does NOT suppress
  });

  it("contextualize surfaces the best match at any confidence", () => {
    store.upsertEvent(
      evt({
        eventType: "config_change",
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const ctx = correlator.contextualize(obs());
    expect(ctx).not.toBeNull();
    expect(ctx!.matchConfidence).toBe("medium");
  });

  it("uses transition table for maintenance transitions on hosts", () => {
    const hostObs = obs({
      resourceId: "vsphere:vsphere_host:host-esxi-01",
      fromState: "running",
      toState: "maintenance",
    });
    store.upsertEvent(
      evt({
        id: "vsphere:maint",
        provider: "vsphere",
        targetResourceId: "vsphere:vsphere_host:host-esxi-01",
        eventType: "host_enter_maintenance",
        actor: { kind: "rhodes", identity: "plan-2026-05-18", via: "rhodes_orchestrator" },
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const m = correlator.findBestMatch(hostObs);
    expect(m).not.toBeNull();
    expect(m!.matchConfidence).toBe("high");
    expect(m!.event.actor.kind).toBe("rhodes");
  });

  it("custom highConfidenceWindowSec changes the high/medium boundary", () => {
    const strict = new AttributionCorrelator(store, {
      highConfidenceWindowSec: 5,
    });
    store.upsertEvent(
      evt({
        eventType: "vm_stop",
        occurredAt: new Date(Date.now() - 10_000).toISOString(),
      }),
    );
    const m = strict.findBestMatch(obs());
    expect(m).not.toBeNull();
    expect(m!.matchConfidence).toBe("medium"); // 10s > 5s window → demoted
  });

  it("expectedEventTypesFor returns the transition table entry (or empty)", () => {
    expect(expectedEventTypesFor("running", "stopped")).toContain("vm_stop");
    expect(expectedEventTypesFor("nonsense", "blah")).toEqual([]);
  });
});
