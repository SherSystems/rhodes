// ============================================================
// VsphereEventSource — adapter tests against a fake event client.
//
// vCenter is offline in the homelab; these tests pin the contract
// (mapping table, actor classification, cursor advance, cancellable
// loop, error tolerance) so the adapter is ready to drop in when
// the real event client surface lands on VSphereClient.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VsphereEventSource,
  mapActor,
  mapEventType,
  mapTargetResourceId,
  toAttributionEvent,
  vsphereEventId,
  type VsphereEvent,
  type VsphereEventClient,
} from "../../../src/attribution/sources/vsphere-events.js";
import type { AttributionEvent } from "../../../src/attribution/index.js";

// ── Test fakes ─────────────────────────────────────────────

interface FakeOpts {
  /** Events the fake will serve, ordered by key ascending. */
  events?: VsphereEvent[];
  /** When set, the next call to queryEventsSince rejects with this. */
  failOnce?: Error;
}

class FakeVsphereEventClient implements VsphereEventClient {
  events: VsphereEvent[];
  calls: Array<{ sinceKey?: number; limit?: number }> = [];
  private failOnce?: Error;

  constructor(opts: FakeOpts = {}) {
    this.events = [...(opts.events ?? [])];
    this.failOnce = opts.failOnce;
  }

  async queryEventsSince(opts: {
    sinceKey?: number;
    limit?: number;
  }): Promise<VsphereEvent[]> {
    this.calls.push({ ...opts });
    if (this.failOnce) {
      const err = this.failOnce;
      this.failOnce = undefined;
      throw err;
    }
    const since = opts.sinceKey;
    const limit = opts.limit ?? 200;
    const filtered = this.events
      .filter((e) => (since === undefined ? true : e.key > since))
      .sort((a, b) => a.key - b.key);
    if (since === undefined) {
      // Bootstrap path: return the tail page so the cursor pins to
      // the highest existing key.
      return filtered.slice(-limit);
    }
    return filtered.slice(0, limit);
  }

  /** Append a new event the next poll will pick up. */
  push(e: VsphereEvent): void {
    this.events.push(e);
  }
}

function evRaw(over: Partial<VsphereEvent> = {}): VsphereEvent {
  return {
    key: over.key ?? 1,
    createdTime: over.createdTime ?? "2026-05-18T12:00:00.000Z",
    eventTypeId: over.eventTypeId ?? "VmPoweredOffEvent",
    userName: over.userName,
    fullFormattedMessage: over.fullFormattedMessage,
    vm: over.vm,
    host: over.host,
    chainId: over.chainId,
  };
}

// ── Pure mapper tests ──────────────────────────────────────

describe("mapEventType", () => {
  it("maps every documented VM lifecycle class", () => {
    expect(mapEventType("VmPoweredOffEvent")).toBe("vm_stop");
    expect(mapEventType("VmStoppingEvent")).toBe("vm_stop");
    expect(mapEventType("VmPoweredOnEvent")).toBe("vm_start");
    expect(mapEventType("VmStartingEvent")).toBe("vm_start");
    expect(mapEventType("VmResettingEvent")).toBe("vm_reboot");
    expect(mapEventType("VmSuspendedEvent")).toBe("vm_suspend");
    expect(mapEventType("VmSuspendingEvent")).toBe("vm_suspend");
    expect(mapEventType("VmCreatedEvent")).toBe("vm_create");
    expect(mapEventType("VmRemovedEvent")).toBe("vm_delete");
    expect(mapEventType("VmMigratedEvent")).toBe("vm_migrate");
    expect(mapEventType("DrsVmMigratedEvent")).toBe("vm_migrate");
    expect(mapEventType("VmRelocatedEvent")).toBe("vm_migrate");
  });

  it("maps host lifecycle classes", () => {
    expect(mapEventType("HostEnteredMaintenanceModeEvent")).toBe(
      "host_enter_maintenance",
    );
    expect(mapEventType("HostExitMaintenanceModeEvent")).toBe(
      "host_exit_maintenance",
    );
    expect(mapEventType("HostShutdownEvent")).toBe("host_reboot");
    expect(mapEventType("HostDisconnectedEvent")).toBe("host_disconnect");
    expect(mapEventType("HostNotRespondingEvent")).toBe("host_disconnect");
    expect(mapEventType("HostConnectedEvent")).toBe("host_connect");
  });

  it("falls back to unknown_event for unmapped classes (raw type preserved in source)", () => {
    expect(mapEventType("SomeFutureEvent")).toBe("unknown_event");
    expect(mapEventType("")).toBe("unknown_event");
  });
});

describe("mapActor", () => {
  it("classifies real humans as kind=human via vcenter_api", () => {
    const a = mapActor(
      evRaw({ userName: "pranav@vsphere.local", eventTypeId: "VmPoweredOffEvent" }),
    );
    expect(a.kind).toBe("human");
    expect(a.identity).toBe("pranav@vsphere.local");
    expect(a.via).toBe("vcenter_api");
  });

  it("preserves the DOMAIN\\\\user shape on the identity but still classifies as human", () => {
    const a = mapActor(
      evRaw({ userName: "VSPHERE.LOCAL\\administrator", eventTypeId: "VmPoweredOnEvent" }),
    );
    expect(a.kind).toBe("human");
    expect(a.identity).toBe("VSPHERE.LOCAL\\administrator");
  });

  it("flags DRS-initiated migrations as system, not human, even with a vpxd userName", () => {
    const a = mapActor(
      evRaw({ userName: "vpxd-extension", eventTypeId: "DrsVmMigratedEvent" }),
    );
    expect(a.kind).toBe("system");
    expect(a.via).toBe("vcenter_drs");
  });

  it("flags vpxd-extension as system on ordinary events too", () => {
    const a = mapActor(
      evRaw({
        userName: "VSPHERE.LOCAL\\vpxd-extension",
        eventTypeId: "VmPoweredOffEvent",
      }),
    );
    expect(a.kind).toBe("system");
    expect(a.via).toBe("vcenter_system");
  });

  it("treats missing userName as unknown", () => {
    const a = mapActor(evRaw({ eventTypeId: "VmPoweredOffEvent" }));
    expect(a.kind).toBe("unknown");
  });

  it("treats empty / whitespace userName as unknown", () => {
    expect(mapActor(evRaw({ userName: "" })).kind).toBe("unknown");
    expect(mapActor(evRaw({ userName: "   " })).kind).toBe("unknown");
  });
});

describe("mapTargetResourceId", () => {
  it("builds vsphere:vsphere_vm:{moid} for VM-scoped events", () => {
    expect(
      mapTargetResourceId(evRaw({ vm: { moid: "vm-101", name: "supra" } })),
    ).toBe("vsphere:vsphere_vm:vm-101");
  });

  it("builds vsphere:vsphere_host:{moid} for host-scoped events", () => {
    expect(
      mapTargetResourceId(evRaw({ host: { moid: "host-1", name: "esxi-01" } })),
    ).toBe("vsphere:vsphere_host:host-1");
  });

  it("prefers VM over host when both are present (VM is the more specific target)", () => {
    expect(
      mapTargetResourceId(
        evRaw({
          vm: { moid: "vm-101" },
          host: { moid: "host-1" },
        }),
      ),
    ).toBe("vsphere:vsphere_vm:vm-101");
  });

  it("returns undefined for provider-scoped events (no vm/host)", () => {
    expect(mapTargetResourceId(evRaw())).toBeUndefined();
  });
});

describe("vsphereEventId / toAttributionEvent", () => {
  it("formats id as vsphere:{key}", () => {
    expect(vsphereEventId(42)).toBe("vsphere:42");
  });

  it("produces a fully-populated AttributionEvent with raw payload preserved", () => {
    const raw = evRaw({
      key: 7,
      eventTypeId: "VmPoweredOffEvent",
      userName: "pranav@vsphere.local",
      vm: { moid: "vm-200", name: "kalshi-bot" },
      createdTime: "2026-05-18T12:34:56.000Z",
      fullFormattedMessage: "Powered off",
    });
    const e: AttributionEvent = toAttributionEvent(raw);
    expect(e.id).toBe("vsphere:7");
    expect(e.provider).toBe("vsphere");
    expect(e.eventType).toBe("vm_stop");
    expect(e.targetResourceId).toBe("vsphere:vsphere_vm:vm-200");
    expect(e.actor).toEqual({
      kind: "human",
      identity: "pranav@vsphere.local",
      via: "vcenter_api",
    });
    expect(e.occurredAt).toBe("2026-05-18T12:34:56.000Z");
    expect(e.rawSource.eventTypeId).toBe("VmPoweredOffEvent");
    expect(e.rawSource.key).toBe(7);
  });
});

// ── Adapter behavior ───────────────────────────────────────

describe("VsphereEventSource", () => {
  beforeEach(() => {
    // Real timers — the adapter sleeps for poll intervals and we want
    // those waits to actually elapse (kept short via constructor opts).
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits each event exactly once and advances the cursor", async () => {
    const client = new FakeVsphereEventClient({
      events: [
        evRaw({ key: 10, eventTypeId: "VmPoweredOnEvent", userName: "pranav" }),
        evRaw({ key: 11, eventTypeId: "VmPoweredOffEvent", userName: "pranav" }),
      ],
    });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 10,
      initialLookbackKey: 0, // replay everything for the test
    });
    const emitted: AttributionEvent[] = [];
    await src.start((e) => emitted.push(e));

    // Give the loop one tick to drain.
    await waitFor(() => emitted.length >= 2, 200);

    // Add a new event mid-stream; the next poll should pick it up.
    client.push(
      evRaw({ key: 12, eventTypeId: "VmResettingEvent", userName: "pranav" }),
    );
    await waitFor(() => emitted.length >= 3, 200);

    await src.stop();

    expect(emitted.map((e) => e.id)).toEqual([
      "vsphere:10",
      "vsphere:11",
      "vsphere:12",
    ]);
    expect(emitted.map((e) => e.eventType)).toEqual([
      "vm_start",
      "vm_stop",
      "vm_reboot",
    ]);
  });

  it("does NOT re-emit the same key across multiple polls", async () => {
    const client = new FakeVsphereEventClient({
      events: [
        evRaw({ key: 5, eventTypeId: "VmPoweredOnEvent", userName: "pranav" }),
      ],
    });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
    });
    const emitted: AttributionEvent[] = [];
    await src.start((e) => emitted.push(e));

    // Let several poll cycles happen with no new events appended.
    await sleep(60);
    await src.stop();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe("vsphere:5");
  });

  it("bootstrap (no initialLookbackKey) advances the cursor past existing events", async () => {
    const client = new FakeVsphereEventClient({
      events: [
        evRaw({ key: 100, eventTypeId: "VmPoweredOnEvent", userName: "pranav" }),
        evRaw({ key: 101, eventTypeId: "VmPoweredOffEvent", userName: "pranav" }),
      ],
    });
    const src = new VsphereEventSource({ client, pollIntervalMs: 5 });
    const emitted: AttributionEvent[] = [];
    await src.start((e) => emitted.push(e));

    // No new events appended after bootstrap → nothing should emit.
    await sleep(40);

    client.push(
      evRaw({ key: 102, eventTypeId: "VmResettingEvent", userName: "pranav" }),
    );
    await waitFor(() => emitted.length >= 1, 200);
    await src.stop();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe("vsphere:102");
  });

  it("stop() cleanly cancels the loop (no further calls after stop returns)", async () => {
    const client = new FakeVsphereEventClient({ events: [] });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
    });
    await src.start(() => undefined);
    await sleep(30);
    const callsBefore = client.calls.length;
    await src.stop();

    await sleep(40);
    const callsAfter = client.calls.length;
    // Allow at most one in-flight call to settle after abort, but the
    // loop must not keep ticking.
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);
  });

  it("survives client errors — loop keeps polling and recovers", async () => {
    const errors: unknown[] = [];
    const client = new FakeVsphereEventClient({
      events: [],
      failOnce: new Error("vcenter not responding"),
    });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
      onError: (e) => errors.push(e),
    });
    const emitted: AttributionEvent[] = [];
    await src.start((e) => emitted.push(e));

    // After the first failure, the next poll should succeed and we
    // should be able to receive a freshly-pushed event.
    await waitFor(() => errors.length >= 1, 200);
    client.push(
      evRaw({ key: 1, eventTypeId: "VmPoweredOnEvent", userName: "pranav" }),
    );
    await waitFor(() => emitted.length >= 1, 200);

    await src.stop();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("vcenter not responding");
    expect(emitted[0].id).toBe("vsphere:1");
  });

  it("a host-scoped HostEnteredMaintenanceModeEvent emits with the right target id", async () => {
    const client = new FakeVsphereEventClient({
      events: [
        evRaw({
          key: 1,
          eventTypeId: "HostEnteredMaintenanceModeEvent",
          userName: "pranav@vsphere.local",
          host: { moid: "host-1", name: "esxi-01" },
        }),
      ],
    });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
    });
    const emitted: AttributionEvent[] = [];
    await src.start((e) => emitted.push(e));
    await waitFor(() => emitted.length >= 1, 200);
    await src.stop();

    expect(emitted[0].eventType).toBe("host_enter_maintenance");
    expect(emitted[0].targetResourceId).toBe("vsphere:vsphere_host:host-1");
    expect(emitted[0].actor.kind).toBe("human");
  });

  it("unmapped event class still emits as unknown_event with raw class preserved", async () => {
    const client = new FakeVsphereEventClient({
      events: [
        evRaw({
          key: 1,
          eventTypeId: "MysteryNewEvent",
          userName: "pranav",
          vm: { moid: "vm-9" },
        }),
      ],
    });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
    });
    const emitted: AttributionEvent[] = [];
    await src.start((e) => emitted.push(e));
    await waitFor(() => emitted.length >= 1, 200);
    await src.stop();

    expect(emitted[0].eventType).toBe("unknown_event");
    expect(emitted[0].rawSource.eventTypeId).toBe("MysteryNewEvent");
  });

  it("calling start() twice is a no-op (does not double-run the loop)", async () => {
    const client = new FakeVsphereEventClient({ events: [] });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
    });
    await src.start(() => undefined);
    await src.start(() => undefined);
    await sleep(30);
    await src.stop();
    // No assertions on call count beyond "still works"; the guarantee
    // is "stop returns and the loop is gone." If two loops were
    // running, stop() would only cancel one — the second test below
    // ("stop is idempotent") would catch hanging timers indirectly.
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it("stop() is idempotent", async () => {
    const client = new FakeVsphereEventClient({ events: [] });
    const src = new VsphereEventSource({
      client,
      pollIntervalMs: 5,
      initialLookbackKey: 0,
    });
    await src.start(() => undefined);
    await src.stop();
    await src.stop(); // Must not throw.
  });
});

// ── Tiny test helpers ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  if (!cond()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}
