// ============================================================
// Tests for the proxmox cluster-tasks adapter — fan-out across
// online nodes, since/type/limit filtering, per-node error tolerance.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  proxmoxTaskClientFromCluster,
  type ClusterTaskSourceClient,
} from "../../src/providers/proxmox/task-cluster-adapter.js";

function fakeNode(node: string, status = "online"): { node: string; status: string } {
  return { node, status };
}

function fakeTask(
  partial: Partial<Parameters<ClusterTaskSourceClient["getTasks"]>[number]> & {
    upid: string;
    starttime: number;
  },
) {
  return {
    upid: partial.upid,
    node: partial.node ?? "n1",
    pid: 1,
    pstart: 0,
    starttime: partial.starttime,
    type: partial.type ?? "qmstop",
    id: partial.id ?? "101",
    user: partial.user ?? "root@pam",
    status: partial.status ?? "OK",
    endtime: partial.endtime,
    exitstatus: undefined,
    ...partial,
  };
}

interface FakeOpts {
  nodes: Array<{ node: string; status: string }>;
  tasksByNode?: Record<string, ReturnType<typeof fakeTask>[]>;
  failOnNode?: string;
  warnings?: string[];
}

function fakeClient(opts: FakeOpts): ClusterTaskSourceClient {
  return {
    async getNodes() {
      return opts.nodes;
    },
    async getTasks(node: string, _limit?: number) {
      if (opts.failOnNode === node) {
        throw new Error(`node ${node} unreachable`);
      }
      return opts.tasksByNode?.[node] ?? [];
    },
  };
}

describe("proxmoxTaskClientFromCluster", () => {
  it("fans out across all online nodes and merges their tasks", async () => {
    const client = fakeClient({
      nodes: [fakeNode("n1"), fakeNode("n2")],
      tasksByNode: {
        n1: [fakeTask({ upid: "UPID:n1:1:qmstop:101", starttime: 100, node: "n1" })],
        n2: [fakeTask({ upid: "UPID:n2:1:qmstart:201", starttime: 200, node: "n2" })],
      },
    });
    const adapter = proxmoxTaskClientFromCluster(client);
    const tasks = await adapter.listClusterTasks({});
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.upid).sort()).toEqual([
      "UPID:n1:1:qmstop:101",
      "UPID:n2:1:qmstart:201",
    ]);
  });

  it("skips offline nodes — never calls getTasks on them", async () => {
    const calls: string[] = [];
    const client: ClusterTaskSourceClient = {
      async getNodes() {
        return [fakeNode("on"), fakeNode("offline", "offline")];
      },
      async getTasks(node) {
        calls.push(node);
        return [fakeTask({ upid: `UPID:${node}:1:t:1`, starttime: 50, node })];
      },
    };
    await proxmoxTaskClientFromCluster(client).listClusterTasks({});
    expect(calls).toEqual(["on"]);
  });

  it("respects the `since` filter inclusively", async () => {
    const client = fakeClient({
      nodes: [fakeNode("n1")],
      tasksByNode: {
        n1: [
          fakeTask({ upid: "old", starttime: 100, node: "n1" }),
          fakeTask({ upid: "fresh", starttime: 200, node: "n1" }),
          fakeTask({ upid: "boundary", starttime: 150, node: "n1" }),
        ],
      },
    });
    const tasks = await proxmoxTaskClientFromCluster(client).listClusterTasks({ since: 150 });
    expect(tasks.map((t) => t.upid).sort()).toEqual(["boundary", "fresh"]);
  });

  it("respects the `typefilter` allowlist", async () => {
    const client = fakeClient({
      nodes: [fakeNode("n1")],
      tasksByNode: {
        n1: [
          fakeTask({ upid: "stop", starttime: 1, type: "qmstop" }),
          fakeTask({ upid: "start", starttime: 2, type: "qmstart" }),
          fakeTask({ upid: "backup", starttime: 3, type: "vzdump" }),
        ],
      },
    });
    const tasks = await proxmoxTaskClientFromCluster(client).listClusterTasks({
      typefilter: ["qmstop", "qmstart"],
    });
    expect(tasks.map((t) => t.upid).sort()).toEqual(["start", "stop"]);
  });

  it("respects the `limit` (newest-first)", async () => {
    const client = fakeClient({
      nodes: [fakeNode("n1"), fakeNode("n2")],
      tasksByNode: {
        n1: [fakeTask({ upid: "older1", starttime: 100, node: "n1" })],
        n2: [
          fakeTask({ upid: "newer1", starttime: 300, node: "n2" }),
          fakeTask({ upid: "newer2", starttime: 200, node: "n2" }),
        ],
      },
    });
    const tasks = await proxmoxTaskClientFromCluster(client).listClusterTasks({ limit: 2 });
    expect(tasks.map((t) => t.upid)).toEqual(["newer1", "newer2"]);
  });

  it("tolerates per-node failures — collects from the survivors", async () => {
    const warnings: string[] = [];
    const client = fakeClient({
      nodes: [fakeNode("ok"), fakeNode("broken")],
      tasksByNode: {
        ok: [fakeTask({ upid: "ok-1", starttime: 100, node: "ok" })],
      },
      failOnNode: "broken",
    });
    const tasks = await proxmoxTaskClientFromCluster(client, {
      warn: (m) => warnings.push(m),
    }).listClusterTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].upid).toBe("ok-1");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/broken.*unreachable/);
  });

  it("returns empty when the cluster has no online nodes", async () => {
    const client = fakeClient({
      nodes: [fakeNode("a", "offline"), fakeNode("b", "offline")],
    });
    expect(
      await proxmoxTaskClientFromCluster(client).listClusterTasks({}),
    ).toEqual([]);
  });

  it("maps empty string id to undefined (cluster-level tasks have no vmid)", async () => {
    const client = fakeClient({
      nodes: [fakeNode("n1")],
      tasksByNode: {
        n1: [
          fakeTask({ upid: "cluster-task", starttime: 1, type: "vzdump", id: "" }),
        ],
      },
    });
    const [task] = await proxmoxTaskClientFromCluster(client).listClusterTasks({});
    expect(task.id).toBeUndefined();
  });
});
