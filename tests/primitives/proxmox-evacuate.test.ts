// ============================================================
// Proxmox evacuateWorkload — happy path, round-robin destination,
// no-running, no-targets, LXC skip, migration-failure aggregation.
// ============================================================

import { describe, expect, it } from "vitest";
import { createProxmoxPrimitives } from "../../src/primitives/proxmox.js";
import {
  InMemoryMaintenanceTracker,
} from "../../src/primitives/proxmox-maintenance.js";
import { PrimitiveNotImplemented } from "../../src/primitives/index.js";
import type { ProxmoxPrimitivesClient } from "../../src/primitives/proxmox.js";

interface FakeOpts {
  /** node → VMs returned by getVMs */
  vms: Record<string, Array<{
    vmid: number;
    name: string;
    status: string;
    type?: "qemu" | "lxc";
    template?: boolean;
  }>>;
  /** Cluster nodes returned by getNodes */
  nodes: Array<{ node: string; status: string }>;
  /** Optional: map (sourceNode|vmid|target) → throw the given message */
  migrateFailures?: Record<string, string>;
  /** Captures every migrate call for assertions. */
  migrateCalls?: Array<{
    node: string;
    vmid: number;
    target: string;
    online?: boolean;
  }>;
}

function fakeClient(opts: FakeOpts): ProxmoxPrimitivesClient {
  return {
    async getNodes() {
      return opts.nodes;
    },
    async getVMs(node: string) {
      return (opts.vms[node] ?? []).map((vm) => ({ ...vm, node }));
    },
    async migrateVM(params) {
      opts.migrateCalls?.push({
        node: params.node,
        vmid: params.vmid,
        target: params.target,
        online: params.online,
      });
      const key = `${params.node}|${params.vmid}|${params.target}`;
      const fail = opts.migrateFailures?.[key];
      if (fail) throw new Error(fail);
      return `UPID:test:0:${params.vmid}:migrate:`;
    },
  };
}

describe("evacuateWorkload — happy paths", () => {
  it("migrates all running QEMU VMs from source to the only other online node", async () => {
    const calls: FakeOpts["migrateCalls"] = [];
    const client = fakeClient({
      vms: {
        nodeA: [
          { vmid: 100, name: "vm-a", status: "running", type: "qemu" },
          { vmid: 101, name: "vm-b", status: "running", type: "qemu" },
        ],
      },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
      ],
      migrateCalls: calls,
    });
    const prims = createProxmoxPrimitives({
      client,
      tracker: new InMemoryMaintenanceTracker(),
    });

    const result = await prims.evacuateWorkload({
      targetId: "proxmox:proxmox_node:nodeA",
      provider: "proxmox",
      mode: "live_migrate",
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.node === "nodeA")).toBe(true);
    expect(calls.every((c) => c.target === "nodeB")).toBe(true);
    expect(calls.every((c) => c.online === true)).toBe(true); // live_migrate
    const data = result.data as { migrated: number; sourceNode: string };
    expect(data.migrated).toBe(2);
    expect(data.sourceNode).toBe("nodeA");
  });

  it("respects explicit destination over auto-selection", async () => {
    const calls: FakeOpts["migrateCalls"] = [];
    const client = fakeClient({
      vms: {
        nodeA: [{ vmid: 100, name: "vm-a", status: "running", type: "qemu" }],
      },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
        { node: "nodeC", status: "online" },
      ],
      migrateCalls: calls,
    });
    const prims = createProxmoxPrimitives({ client });
    await prims.evacuateWorkload({
      targetId: "proxmox:proxmox_node:nodeA",
      provider: "proxmox",
      mode: "live_migrate",
      destination: "nodeC",
    });
    expect(calls[0].target).toBe("nodeC");
  });

  it("round-robins across available online destinations", async () => {
    const calls: FakeOpts["migrateCalls"] = [];
    const client = fakeClient({
      vms: {
        nodeA: [
          { vmid: 100, name: "v1", status: "running", type: "qemu" },
          { vmid: 101, name: "v2", status: "running", type: "qemu" },
          { vmid: 102, name: "v3", status: "running", type: "qemu" },
          { vmid: 103, name: "v4", status: "running", type: "qemu" },
        ],
      },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
        { node: "nodeC", status: "online" },
      ],
      migrateCalls: calls,
    });
    const prims = createProxmoxPrimitives({ client });
    await prims.evacuateWorkload({
      targetId: "proxmox:proxmox_node:nodeA",
      provider: "proxmox",
      mode: "live_migrate",
    });
    // First two VMs alternate, fifth would wrap — verify the alternation.
    expect(calls[0].target).toBe("nodeB");
    expect(calls[1].target).toBe("nodeC");
    expect(calls[2].target).toBe("nodeB");
    expect(calls[3].target).toBe("nodeC");
  });

  it("evict mode passes online=false", async () => {
    const calls: FakeOpts["migrateCalls"] = [];
    const client = fakeClient({
      vms: { nodeA: [{ vmid: 100, name: "v", status: "running", type: "qemu" }] },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
      ],
      migrateCalls: calls,
    });
    const prims = createProxmoxPrimitives({ client });
    await prims.evacuateWorkload({
      targetId: "proxmox:proxmox_node:nodeA",
      provider: "proxmox",
      mode: "evict",
    });
    expect(calls[0].online).toBe(false);
  });
});

describe("evacuateWorkload — no-op cases", () => {
  it("returns success with migrated=0 when no VMs are running", async () => {
    const client = fakeClient({
      vms: {
        nodeA: [
          { vmid: 100, name: "stopped", status: "stopped", type: "qemu" },
          { vmid: 101, name: "tmpl", status: "running", type: "qemu", template: true },
        ],
      },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
      ],
    });
    const prims = createProxmoxPrimitives({ client });
    const result = await prims.evacuateWorkload({
      targetId: "proxmox:proxmox_node:nodeA",
      provider: "proxmox",
      mode: "live_migrate",
    });
    expect(result.success).toBe(true);
    const data = result.data as { migrated: number };
    expect(data.migrated).toBe(0);
  });
});

describe("evacuateWorkload — failure paths", () => {
  it("throws when no other online destination nodes exist", async () => {
    const client = fakeClient({
      vms: { nodeA: [{ vmid: 100, name: "v", status: "running", type: "qemu" }] },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "offline" }, // not eligible
      ],
    });
    const prims = createProxmoxPrimitives({ client });
    await expect(
      prims.evacuateWorkload({
        targetId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(/no online destination/);
  });

  it("aggregates per-VM migration failures into a single thrown error", async () => {
    const calls: FakeOpts["migrateCalls"] = [];
    const client = fakeClient({
      vms: {
        nodeA: [
          { vmid: 100, name: "ok", status: "running", type: "qemu" },
          { vmid: 101, name: "broken", status: "running", type: "qemu" },
        ],
      },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
      ],
      migrateFailures: { "nodeA|101|nodeB": "DRS rejected target" },
      migrateCalls: calls,
    });
    const prims = createProxmoxPrimitives({ client });
    await expect(
      prims.evacuateWorkload({
        targetId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(/1\/2 migrations failed/);
    expect(calls).toHaveLength(2); // both attempted, error only after
  });

  it("LXC containers report as failed (cold-migrate not wrapped yet)", async () => {
    const calls: FakeOpts["migrateCalls"] = [];
    const client = fakeClient({
      vms: {
        nodeA: [
          { vmid: 200, name: "lxc-ct", status: "running", type: "lxc" },
        ],
      },
      nodes: [
        { node: "nodeA", status: "online" },
        { node: "nodeB", status: "online" },
      ],
      migrateCalls: calls,
    });
    const prims = createProxmoxPrimitives({ client });
    await expect(
      prims.evacuateWorkload({
        targetId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(/LXC/);
    // No migrate calls because LXC short-circuits before migrate.
    expect(calls).toHaveLength(0);
  });

  it("throws PrimitiveNotImplemented when no client is configured", async () => {
    const prims = createProxmoxPrimitives(); // no client
    await expect(
      prims.evacuateWorkload({
        targetId: "proxmox:proxmox_node:any",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(PrimitiveNotImplemented);
  });

  it("throws PrimitiveNotImplemented when client is missing a required method", async () => {
    // Client without getVMs
    const stuntedClient: ProxmoxPrimitivesClient = {
      async getNodes() {
        return [{ node: "nodeA", status: "online" }];
      },
      // getVMs intentionally absent
      async migrateVM() {
        return "UPID:";
      },
    };
    const prims = createProxmoxPrimitives({ client: stuntedClient });
    await expect(
      prims.evacuateWorkload({
        targetId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(PrimitiveNotImplemented);
  });

  it("throws on malformed hostId (nodeNameFromHostId guards the input)", async () => {
    const client = fakeClient({
      vms: {},
      nodes: [{ node: "nodeA", status: "online" }],
    });
    const prims = createProxmoxPrimitives({ client });
    await expect(
      prims.evacuateWorkload({
        targetId: "vsphere:vsphere_host:wrong",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(/proxmox:proxmox_node:/);
  });
});
