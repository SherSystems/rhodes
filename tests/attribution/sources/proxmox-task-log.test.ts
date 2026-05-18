// ============================================================
// ProxmoxTaskLogSource — type mapping, actor mapping, resource-id
// construction, UPID dedup, ERROR filtering, clean shutdown, and
// loop resilience to client errors.
//
// Uses a fake ProxmoxTaskClient (no network). The poll loop is
// exercised via start() with a short tick + an injected clock so
// each test stays well under a second.
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProxmoxTaskLogSource,
  mapActor,
  mapEventType,
  targetResourceIdFor,
  type ProxmoxTask,
  type ProxmoxTaskClient,
} from "../../../src/attribution/sources/proxmox-task-log.js";
import type { AttributionEvent } from "../../../src/attribution/index.js";

// ── Test fixtures ─────────────────────────────────────────────

function task(over: Partial<ProxmoxTask> = {}): ProxmoxTask {
  return {
    upid: `UPID:pve:001:${Math.random().toString(36).slice(2)}`,
    node: "pve",
    type: "qmstop",
    id: "200",
    user: "pranav@pve",
    starttime: Math.floor(Date.now() / 1000),
    endtime: Math.floor(Date.now() / 1000) + 2,
    status: "OK",
    ...over,
  };
}

class FakeClient implements ProxmoxTaskClient {
  /** Buckets of tasks returned per call; if exhausted, returns []. */
  responses: ProxmoxTask[][] = [];
  calls: { since?: number }[] = [];
  /** When set, throw on the next call (cleared after one throw). */
  throwOnce?: Error;

  async listClusterTasks(opts: {
    since?: number;
    typefilter?: string[];
    limit?: number;
  }): Promise<ProxmoxTask[]> {
    this.calls.push({ since: opts.since });
    if (this.throwOnce) {
      const err = this.throwOnce;
      this.throwOnce = undefined;
      throw err;
    }
    return this.responses.shift() ?? [];
  }
}

/** Convenience: spin up a source, run it briefly, then stop. */
async function runBriefly(
  source: ProxmoxTaskLogSource,
  emit: (e: AttributionEvent) => void,
  ticks = 2,
  intervalMs = 5,
): Promise<void> {
  await source.start(emit);
  // Wait long enough for `ticks` poll iterations to complete.
  await new Promise((r) => setTimeout(r, intervalMs * ticks + 25));
  await source.stop();
}

// ── Tests ─────────────────────────────────────────────────────

describe("mapEventType", () => {
  it("maps QEMU lifecycle tasks", () => {
    expect(mapEventType("qmstop")).toBe("vm_stop");
    expect(mapEventType("qmstart")).toBe("vm_start");
    expect(mapEventType("qmreboot")).toBe("vm_reboot");
    expect(mapEventType("qmsuspend")).toBe("vm_suspend");
    expect(mapEventType("qmresume")).toBe("vm_resume");
    expect(mapEventType("qmcreate")).toBe("vm_create");
    expect(mapEventType("qmdestroy")).toBe("vm_delete");
    expect(mapEventType("qmigrate")).toBe("vm_migrate");
    expect(mapEventType("qmclone")).toBe("vm_migrate");
  });

  it("maps LXC lifecycle tasks", () => {
    expect(mapEventType("lxc_stop")).toBe("vm_stop");
    expect(mapEventType("lxc_start")).toBe("vm_start");
    expect(mapEventType("lxc_reboot")).toBe("vm_reboot");
    expect(mapEventType("lxc_destroy")).toBe("vm_delete");
  });

  it("falls back to unknown_event for unrecognized types", () => {
    expect(mapEventType("vzdump")).toBe("unknown_event");
    expect(mapEventType("aptupdate")).toBe("unknown_event");
    expect(mapEventType("")).toBe("unknown_event");
  });
});

describe("mapActor", () => {
  it("maps a Proxmox user to a human actor via proxmox_api", () => {
    expect(mapActor("pranav@pve")).toEqual({
      kind: "human",
      identity: "pranav@pve",
      via: "proxmox_api",
    });
    expect(mapActor("root@pam")).toEqual({
      kind: "human",
      identity: "root@pam",
      via: "proxmox_api",
    });
  });

  it("returns unknown for empty/missing user", () => {
    expect(mapActor(undefined)).toEqual({ kind: "unknown", via: "proxmox_api" });
    expect(mapActor("")).toEqual({ kind: "unknown", via: "proxmox_api" });
    expect(mapActor("   ")).toEqual({ kind: "unknown", via: "proxmox_api" });
  });
});

describe("targetResourceIdFor", () => {
  it("builds proxmox_vm:<vmid> for QEMU tasks", () => {
    expect(
      targetResourceIdFor(task({ type: "qmstop", id: "200" })),
    ).toBe("proxmox:proxmox_vm:200");
    expect(
      targetResourceIdFor(task({ type: "qmstart", id: "201" })),
    ).toBe("proxmox:proxmox_vm:201");
  });

  it("builds proxmox_container:<vmid> for LXC tasks", () => {
    expect(
      targetResourceIdFor(task({ type: "lxc_start", id: "101" })),
    ).toBe("proxmox:proxmox_container:101");
    expect(
      targetResourceIdFor(task({ type: "lxc_destroy", id: "150" })),
    ).toBe("proxmox:proxmox_container:150");
  });

  it("returns undefined for cluster-level tasks with no vmid", () => {
    expect(targetResourceIdFor(task({ type: "aptupdate", id: undefined }))).toBeUndefined();
  });
});

describe("ProxmoxTaskLogSource", () => {
  let sources: ProxmoxTaskLogSource[] = [];

  afterEach(async () => {
    for (const s of sources) await s.stop();
    sources = [];
    vi.useRealTimers();
  });

  function makeSource(
    client: ProxmoxTaskClient,
    pollIntervalMs = 5,
  ): ProxmoxTaskLogSource {
    const s = new ProxmoxTaskLogSource({
      client,
      pollIntervalMs,
      initialLookbackSec: 300,
      logger: { warn: () => {}, info: () => {} },
    });
    sources.push(s);
    return s;
  }

  it("emits one normalized event per task on the first poll", async () => {
    const client = new FakeClient();
    client.responses.push([
      task({ upid: "UPID:pve:001:A", type: "qmstop", id: "200", user: "pranav@pve" }),
      task({ upid: "UPID:pve:001:B", type: "lxc_start", id: "101", user: "root@pam" }),
    ]);
    const source = makeSource(client);

    const emitted: AttributionEvent[] = [];
    await runBriefly(source, (e) => emitted.push(e));

    expect(emitted).toHaveLength(2);

    const a = emitted.find((e) => e.id === "proxmox:UPID:pve:001:A");
    expect(a).toBeDefined();
    expect(a!.provider).toBe("proxmox");
    expect(a!.eventType).toBe("vm_stop");
    expect(a!.targetResourceId).toBe("proxmox:proxmox_vm:200");
    expect(a!.actor).toEqual({
      kind: "human",
      identity: "pranav@pve",
      via: "proxmox_api",
    });
    expect(a!.rawSource.upid).toBe("UPID:pve:001:A");

    const b = emitted.find((e) => e.id === "proxmox:UPID:pve:001:B");
    expect(b).toBeDefined();
    expect(b!.eventType).toBe("vm_start");
    expect(b!.targetResourceId).toBe("proxmox:proxmox_container:101");
    expect(b!.actor.identity).toBe("root@pam");
  });

  it("does NOT re-emit a UPID it has already seen", async () => {
    const client = new FakeClient();
    const sameTask = task({ upid: "UPID:pve:001:DUP", type: "qmstop", id: "200" });
    // Two consecutive polls return the same task.
    client.responses.push([sameTask]);
    client.responses.push([sameTask]);
    const source = makeSource(client);

    const emitted: AttributionEvent[] = [];
    await runBriefly(source, (e) => emitted.push(e), 3);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe("proxmox:UPID:pve:001:DUP");
    // Ensure we did poll multiple times — otherwise the dedup test
    // is meaningless because we never had a chance to re-see it.
    expect(client.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT emit tasks whose status is ERROR", async () => {
    const client = new FakeClient();
    client.responses.push([
      task({ upid: "UPID:pve:001:OK", status: "OK", type: "qmstop", id: "200" }),
      task({ upid: "UPID:pve:001:ERR", status: "ERROR", type: "qmstop", id: "201" }),
      task({ upid: "UPID:pve:001:RUN", status: "RUNNING", type: "qmstart", id: "202" }),
    ]);
    const source = makeSource(client);

    const emitted: AttributionEvent[] = [];
    await runBriefly(source, (e) => emitted.push(e));

    const ids = emitted.map((e) => e.id).sort();
    expect(ids).toEqual([
      "proxmox:UPID:pve:001:OK",
      "proxmox:UPID:pve:001:RUN",
    ]);
    expect(emitted.find((e) => e.id === "proxmox:UPID:pve:001:ERR")).toBeUndefined();
  });

  it("stop() cleanly cancels the poll loop and resolves quickly", async () => {
    const client = new FakeClient();
    // 1s interval — without abort-aware sleep, stop() would hang.
    const source = makeSource(client, 1000);
    await source.start(() => {});

    const t0 = Date.now();
    await source.stop();
    const elapsed = Date.now() - t0;

    // Generous bound; the AbortController path should resolve in
    // well under 100ms. If it waits for the 1000ms timer, the test
    // fails as intended.
    expect(elapsed).toBeLessThan(500);
  });

  it("client errors do not crash the loop; emit fires only on successful polls", async () => {
    const client = new FakeClient();
    // First poll: throw.
    client.throwOnce = new Error("ECONNREFUSED");
    // Subsequent polls: deliver a task.
    client.responses.push([]); // first poll throws before consuming; queue still has []
    client.responses.push([
      task({ upid: "UPID:pve:001:AFTER", type: "qmstop", id: "200" }),
    ]);

    const source = makeSource(client);
    const emitted: AttributionEvent[] = [];

    // Multiple ticks so the throw + recovery + emit all happen.
    await runBriefly(source, (e) => emitted.push(e), 4);

    // No crash means we got this far. Verify we eventually emitted
    // the post-recovery task.
    const ids = emitted.map((e) => e.id);
    expect(ids).toContain("proxmox:UPID:pve:001:AFTER");
    // And we made more than one call (the loop kept going).
    expect(client.calls.length).toBeGreaterThan(1);
  });

  it("uses the upid as the event id, prefixed with provider", async () => {
    const client = new FakeClient();
    client.responses.push([
      task({ upid: "UPID:pve:00000001:ABCDEF:qmstop:200:pranav@pve:" }),
    ]);
    const source = makeSource(client);

    const emitted: AttributionEvent[] = [];
    await runBriefly(source, (e) => emitted.push(e));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe(
      "proxmox:UPID:pve:00000001:ABCDEF:qmstop:200:pranav@pve:",
    );
  });

  it("name and provider are stable for the registry", () => {
    const client = new FakeClient();
    const s = new ProxmoxTaskLogSource({ client });
    expect(s.name).toBe("proxmox-task-log");
    expect(s.provider).toBe("proxmox");
  });
});
