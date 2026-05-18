// ============================================================
// DiscoveryScheduler — unit tests
//
// Covers the behavioral contract described in src/graph/
// discovery-scheduler.ts:
//   - runOnce() invokes every registered writer's discover() once
//   - A stuck writer doesn't block other writers' next ticks
//   - A throwing writer is logged + reported; scheduler keeps going
//   - stop() cleanly cancels intervals + drains in-flight passes
//   - runOnBoot: false skips the initial pass
//   - resolverEnabled: true causes runResolver to run after the pass
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore, z } from "../../src/graph/index.js";
import {
  DiscoveryScheduler,
  type DiscoveryWriter,
} from "../../src/graph/discovery-scheduler.js";

// ── Test helpers ──────────────────────────────────────────────

interface FakeWriter extends DiscoveryWriter {
  callCount: number;
  registerCount: number;
}

/**
 * Build a fake writer whose discover() does whatever `behavior`
 * dictates (default: upsert one resource quickly). Returns the writer
 * AND a `callCount` we can introspect from the test body.
 */
function makeWriter(
  name: string,
  behavior: (writer: FakeWriter, store: GraphStore) => Promise<void>,
): FakeWriter {
  const w: FakeWriter = {
    name,
    callCount: 0,
    registerCount: 0,
    register(store) {
      w.registerCount += 1;
      // Register a unique provider+type pair per writer so writers
      // don't trample each other's schema in the registry.
      store.registerResourceType({
        provider: "proxmox",
        type: "proxmox_vm",
        interfaceLabels: ["ComputeWorkload"],
        allowedStates: ["running", "stopped", "unknown"],
        propertiesSchema: z.object({
          vmid: z.number(),
          node: z.string(),
        }),
      });
    },
    async discover() {
      w.callCount += 1;
      await behavior(w, store);
      // Required by the interface — the scheduler ignores the value
      // (it builds its own report from store deltas), so a stub is fine.
      return {
        writer: name,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        resourcesUpserted: 0,
        relationshipsUpserted: 0,
        errors: [],
      };
    },
  };
  return w;
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let dir: string;
let store: GraphStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhodes-scheduler-test-"));
  store = new GraphStore(join(dir, "graph.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Cases ─────────────────────────────────────────────────────

describe("DiscoveryScheduler", () => {
  it("runOnce() invokes every registered writer's discover() exactly once", async () => {
    const scheduler = new DiscoveryScheduler(store, {
      runOnBoot: false,
      resolverEnabled: false,
      logger: silentLogger(),
    });
    const a = makeWriter("a", async () => undefined);
    const b = makeWriter("b", async () => undefined);
    scheduler.add(a);
    scheduler.add(b);

    const reports = await scheduler.runOnce();

    expect(a.callCount).toBe(1);
    expect(b.callCount).toBe(1);
    expect(reports.map((r) => r.writer).sort()).toEqual(["a", "b"]);
    expect(a.registerCount).toBe(1);
    expect(b.registerCount).toBe(1);
  });

  it("a stuck writer does not block other writers' progress", async () => {
    // 'stuck' returns a never-resolving promise to simulate a wedged
    // provider API. 'fast' must still complete normally on the same
    // runOnce() call.
    const stuck = makeWriter(
      "stuck",
      () => new Promise<void>(() => undefined /* never resolves */),
    );
    const fast = makeWriter("fast", async () => undefined);

    const scheduler = new DiscoveryScheduler(store, {
      runOnBoot: false,
      resolverEnabled: false,
      logger: silentLogger(),
    });
    scheduler.add(stuck);
    scheduler.add(fast);

    // Kick off runOnce; race it against a finished marker for `fast`.
    const passes = scheduler.runOnce();
    // Give the event loop a turn so fast's microtask completes.
    await new Promise((r) => setImmediate(r));
    expect(fast.callCount).toBe(1);
    // stuck has been called but never resolves
    expect(stuck.callCount).toBe(1);
    // Don't await `passes` — it would block forever on stuck. The
    // important assertion is that `fast` already ran to completion.
    void passes;
  });

  it("a writer that throws is logged + reported; scheduler continues", async () => {
    const logger = silentLogger();
    const explodes = makeWriter("explodes", async () => {
      throw new Error("simulated provider 500");
    });
    const healthy = makeWriter("healthy", async () => undefined);

    const scheduler = new DiscoveryScheduler(store, {
      runOnBoot: false,
      resolverEnabled: false,
      logger,
    });
    scheduler.add(explodes);
    scheduler.add(healthy);

    const reports = await scheduler.runOnce();

    const explodedReport = reports.find((r) => r.writer === "explodes");
    const healthyReport = reports.find((r) => r.writer === "healthy");
    expect(explodedReport).toBeDefined();
    expect(explodedReport!.errors).toContain("simulated provider 500");
    expect(healthyReport).toBeDefined();
    expect(healthyReport!.errors).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stop() cancels intervals + waits for in-flight discoveries", async () => {
    let resolveDiscover: (() => void) | undefined;
    const slow = makeWriter("slow", () => {
      return new Promise<void>((resolve) => {
        resolveDiscover = resolve;
      });
    });

    const scheduler = new DiscoveryScheduler(store, {
      // Short interval to make sure setInterval was actually wired up.
      intervalMs: 25,
      runOnBoot: true,
      resolverEnabled: false,
      logger: silentLogger(),
    });
    scheduler.add(slow);
    scheduler.start();

    // Wait until discover() has been entered (runOnBoot path).
    while (slow.callCount === 0) {
      await new Promise((r) => setImmediate(r));
    }

    const stopPromise = scheduler.stop();
    // stop() must not have resolved yet — slow is still in flight.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);

    // Release the discover() promise; stop() should now resolve.
    resolveDiscover!();
    await stopPromise;
    expect(stopped).toBe(true);

    // Confirm the interval was cancelled — callCount should not grow
    // after a comfortable wait.
    const finalCount = slow.callCount;
    await new Promise((r) => setTimeout(r, 100));
    expect(slow.callCount).toBe(finalCount);
  });

  it("runOnBoot: false skips the initial pass", async () => {
    const w = makeWriter("w", async () => undefined);
    const scheduler = new DiscoveryScheduler(store, {
      runOnBoot: false,
      resolverEnabled: false,
      intervalMs: 60_000,
      logger: silentLogger(),
    });
    scheduler.add(w);
    scheduler.start();

    // Let the event loop turn so any accidental scheduled work fires.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 25));

    expect(w.callCount).toBe(0);
    await scheduler.stop();
  });

  it("resolverEnabled: true runs runResolver after each discovery pass", async () => {
    // Seed the writers so the resolver has a candidate match:
    // a Proxmox VM whose name matches a vSphere host. The
    // PROXMOX_VM_IS_VSPHERE_HOST rule should emit a manifests_as edge.
    const writer: DiscoveryWriter = {
      name: "lab",
      register(s) {
        s.registerResourceType({
          provider: "proxmox",
          type: "proxmox_vm",
          interfaceLabels: ["ComputeWorkload"],
          allowedStates: ["running", "stopped", "unknown"],
          propertiesSchema: z.object({ vmid: z.number(), node: z.string() }),
        });
        s.registerResourceType({
          provider: "vsphere",
          type: "vsphere_host",
          interfaceLabels: ["ComputeNode"],
          allowedStates: ["running", "disconnected", "unknown"],
          propertiesSchema: z.object({ moid: z.string() }),
        });
      },
      async discover() {
        store.upsertResource({
          id: "proxmox:proxmox_vm:200",
          provider: "proxmox",
          type: "proxmox_vm",
          name: "esxi-01",
          observedState: "running",
          properties: { vmid: 200, node: "pve" },
        });
        store.upsertResource({
          id: "vsphere:vsphere_host:host-9",
          provider: "vsphere",
          type: "vsphere_host",
          name: "esxi-01",
          observedState: "running",
          properties: { moid: "host-9" },
        });
        return {
          writer: "lab",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          resourcesUpserted: 2,
          relationshipsUpserted: 0,
          errors: [],
        };
      },
    };

    const scheduler = new DiscoveryScheduler(store, {
      runOnBoot: false,
      resolverEnabled: true,
      logger: silentLogger(),
    });
    scheduler.add(writer);

    await scheduler.runOnce();

    const edges = store.listRelationships();
    const manifestEdges = edges.filter((e) => e.type === "manifests_as");
    expect(manifestEdges.length).toBeGreaterThan(0);
    expect(manifestEdges[0].origin).toBe("inferred");
  });

  it("a writer's in-flight pass is not started a second time on a fast tick", async () => {
    let resolveDiscover: (() => void) | undefined;
    const slow = makeWriter("slow", () => {
      return new Promise<void>((resolve) => {
        resolveDiscover = resolve;
      });
    });
    const logger = silentLogger();
    const scheduler = new DiscoveryScheduler(store, {
      runOnBoot: false,
      resolverEnabled: false,
      logger,
    });
    scheduler.add(slow);

    // First call starts in-flight; second call should be dropped.
    void scheduler.runOnce();
    await new Promise((r) => setImmediate(r));
    void scheduler.runOnce();
    await new Promise((r) => setImmediate(r));

    expect(slow.callCount).toBe(1);
    expect(logger.warn).toHaveBeenCalled();

    // Cleanup so the test process can exit.
    resolveDiscover!();
  });
});
