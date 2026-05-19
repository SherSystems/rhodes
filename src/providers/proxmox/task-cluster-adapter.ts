// ============================================================
// RHODES — Proxmox cluster-tasks adapter
//
// Bridges the existing `ProxmoxClient.getTasks(node)` per-node API
// to the cluster-wide `ProxmoxTaskClient.listClusterTasks()` shape
// the attribution `ProxmoxTaskLogSource` expects (per the v0.6.5
// shipped-memo follow-up note).
//
// Why an adapter rather than extending the client: keeps the
// attribution module free of provider-client incidental fields, and
// keeps the production wiring isolated so a stuck attribution poll
// can't lock up the tool-call path. Mirrors the same separation as
// the graph-writer's discovery clients.
//
// Strategy: fan-out per online node. Pull each node's task log,
// merge, filter by `since`, optional type filter, optional limit.
// Per-node errors (offline node, transient API failure) are swallowed
// and logged — one bad node must not break attribution for the rest.
// ============================================================

import type {
  ProxmoxTask,
  ProxmoxTaskClient,
} from "../../attribution/sources/proxmox-task-log.js";

/**
 * Minimal surface we need from a `ProxmoxClient`. Structural —
 * the real client satisfies this; tests inject a fake.
 */
export interface ClusterTaskSourceClient {
  getNodes(): Promise<Array<{ node: string; status: string }>>;
  getTasks(
    node: string,
    limit?: number,
  ): Promise<
    Array<{
      upid: string;
      node: string;
      pid: number;
      pstart: number;
      starttime: number;
      type: string;
      id: string;
      user: string;
      status?: string;
      exitstatus?: string;
      endtime?: number;
    }>
  >;
}

export interface ClusterTaskAdapterOptions {
  /** Optional logger for per-node failures (otherwise console.warn). */
  warn?: (message: string) => void;
}

/**
 * Wrap a `ProxmoxClient`-shaped instance into a
 * `ProxmoxTaskClient` that the attribution `ProxmoxTaskLogSource`
 * can drive directly.
 */
export function proxmoxTaskClientFromCluster(
  client: ClusterTaskSourceClient,
  opts: ClusterTaskAdapterOptions = {},
): ProxmoxTaskClient {
  const warn = opts.warn ?? ((m: string) => console.warn(`[proxmox-task-cluster] ${m}`));
  return {
    async listClusterTasks({
      since = 0,
      typefilter,
      limit,
    }): Promise<ProxmoxTask[]> {
      const nodes = await client.getNodes();
      const online = nodes.filter((n) => n.status === "online");

      const collected: ProxmoxTask[] = [];
      for (const n of online) {
        try {
          const tasks = await client.getTasks(n.node, limit);
          for (const t of tasks) {
            // since-filter (inclusive)
            if (t.starttime < since) continue;
            // optional type allowlist
            if (typefilter && !typefilter.includes(t.type)) continue;
            collected.push({
              upid: t.upid,
              node: t.node,
              type: t.type,
              id: t.id || undefined,
              user: t.user,
              starttime: t.starttime,
              endtime: t.endtime,
              status: t.status,
            });
          }
        } catch (err) {
          // One bad node must not poison the cluster-wide scan.
          warn(
            `getTasks failed for node '${n.node}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Sort newest-first so consumers can apply their own limit.
      collected.sort((a, b) => b.starttime - a.starttime);
      return limit !== undefined ? collected.slice(0, limit) : collected;
    },
  };
}
