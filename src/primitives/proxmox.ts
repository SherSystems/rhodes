// ============================================================
// RHODES — Proxmox Primitives
//
// Substrate-agnostic primitives implemented against the existing
// ProxmoxClient. The capability matrix (declared by capabilities())
// is honest and locked from v0.6 — adapters can read it before
// dispatching to know what to expect.
//
// Two registration shapes:
//
// 1. Default `proxmoxPrimitives` (auto-registered on module load).
//    Capability discovery works fully. Verb bodies that REQUIRE a
//    live ProxmoxClient throw `PrimitiveNotImplemented` with a
//    "configureProxmoxPrimitives() first" hint. Verb bodies that
//    only need local-state (enter/exit maintenance tracker) work
//    against an in-memory tracker so tests and dev-mode demos work
//    out of the box.
//
// 2. `configureProxmoxPrimitives({ client, tracker? })` REPLACES
//    the registry entry with a fully-wired implementation. Called
//    once at bootstrap when a ProxmoxClient is available. Tests use
//    the same factory with a fake client.
//
// PROXMOX-SPECIFIC TRUTH (the things the planner must respect):
//
//   - QEMU VMs support `qm migrate <vmid> <target> --online` for
//     live migration. LXC containers DO NOT — `pct migrate` is
//     cold. Mixed-workload clusters therefore can't promise live
//     evacuation cluster-wide; the planner has to inspect the
//     workload type before picking `live_migrate`.
//
//   - There is NO native host-level "maintenance mode" in Proxmox.
//     We EMULATE one via FileMaintenanceTracker (see
//     proxmox-maintenance.ts). Operator-facing surfaces read this
//     tracker to display the maintenance state; the graph writer
//     populates an `InMaintenance` Condition from it on each
//     discovery pass.
//
//   - Host remediation is `apt full-upgrade` + reboot. There's no
//     LCM-equivalent cluster image, so `image` in
//     `RemediateHostInput` maps to a repository/channel selector,
//     not an immutable image hash.
//
//   - Rollback ladder: snapshot_restore (qm rollback / pct rollback)
//     is first-class. inverse_mutation works for any spec we
//     recorded the reverse of. blue_green and surge_teardown are
//     NOT raw-Proxmox patterns — they're K8s/cloud territory.
// ============================================================

import type { GraphProvider } from "../graph/types.js";
import { registerPrimitives } from "./registry.js";
import {
  InMemoryMaintenanceTracker,
  type MaintenanceTracker,
} from "./proxmox-maintenance.js";
import {
  PrimitiveNotImplemented,
  type EnterMaintenanceInput,
  type EvacuateWorkloadInput,
  type ExitMaintenanceInput,
  type PrimitiveMethod,
  type PrimitiveResult,
  type Primitives,
  type ProviderCapabilities,
  type RemediateHostInput,
  type RollbackInput,
} from "./types.js";

const PROVIDER: GraphProvider = "proxmox";

/**
 * Minimal subset of the real ProxmoxClient that the primitives need.
 * Structural — the real client satisfies this without modification.
 * Tests inject a fake.
 *
 * Methods are added as each v0.7.1.x phase needs them. Adapter
 * mismatches (real client missing a method) surface at bootstrap
 * configureProxmoxPrimitives() — not at first primitive call.
 */
export interface ProxmoxPrimitivesClient {
  /** Cluster nodes with their online/offline status. */
  getNodes?(): Promise<Array<{ node: string; status: string }>>;
  /**
   * VMs on a specific node. Each entry should have at least
   * `vmid`, `name`, `status`, optional `type` ('qemu'|'lxc') and
   * `template`.
   */
  getVMs?(node: string): Promise<
    Array<{
      vmid: number;
      name: string;
      status: string;
      type?: "qemu" | "lxc";
      template?: boolean;
      node?: string;
    }>
  >;
  /** Live or cold migrate a QEMU VM. Returns the Proxmox UPID. */
  migrateVM?(params: {
    node: string;
    vmid: number;
    target: string;
    online?: boolean;
    with_local_disks?: boolean;
  }): Promise<string>;
}

export interface ProxmoxPrimitivesDeps {
  /**
   * Live Proxmox client. Required for any primitive that calls into
   * the Proxmox API. The default in-process registration leaves this
   * undefined and falls back to PrimitiveNotImplemented for those
   * verbs.
   */
  client?: ProxmoxPrimitivesClient;
  /**
   * Maintenance tracker. Defaults to an in-memory tracker —
   * production bootstrap should pass a FileMaintenanceTracker so the
   * state survives restarts.
   */
  tracker?: MaintenanceTracker;
}

const CAPS: ProviderCapabilities = {
  provider: PROVIDER,
  evacuateModes: ["live_migrate", "evict"],
  maintenanceModeSupported: true,
  hostRemediationSupported: true,
  rollbackStrategies: ["snapshot_restore", "inverse_mutation"],
  notes:
    "Live migration only works for QEMU VMs; LXC containers fall " +
    "back to cold migration (evict mode). 'maintenance mode' is " +
    "emulated via FileMaintenanceTracker — there is no native Proxmox " +
    "equivalent. Host remediation = apt full-upgrade on the PVE " +
    "channel; pinning a specific image requires a custom repository.",
};

/**
 * Factory for fully-configured Proxmox primitives. Returns an
 * implementation that uses the provided deps. Use at bootstrap +
 * tests.
 */
export function createProxmoxPrimitives(
  deps: ProxmoxPrimitivesDeps = {},
): Primitives {
  const tracker = deps.tracker ?? new InMemoryMaintenanceTracker();
  return {
    capabilities(): ProviderCapabilities {
      return CAPS;
    },

    async enterMaintenance(
      input: EnterMaintenanceInput,
    ): Promise<PrimitiveResult> {
      const node = nodeNameFromHostId(input.hostId);
      if (input.evacuate) {
        // Evacuation is the workload-evacuation primitive's job. We
        // accept the flag in the contract so callers can pass it
        // through, but we throw here so the orchestrator's runner
        // catches it as a host_step_failed event — surfacing the
        // sequencing mistake explicitly. The v0.7-alpha FSM splits
        // entering_maintenance and evacuating into distinct
        // sub-states anyway, so well-formed runs never set this true.
        throw new Error(
          "enterMaintenance(evacuate=true) is not supported in v0.7.1.1; " +
            "call evacuateWorkload() as a separate step. Set evacuate=false here.",
        );
      }
      const meta = await tracker.markIn(node);
      return {
        success: true,
        message: `node '${node}' marked in maintenance`,
        data: { node, enteredAt: meta.enteredAt },
      };
    },

    async exitMaintenance(
      input: ExitMaintenanceInput,
    ): Promise<PrimitiveResult> {
      const node = nodeNameFromHostId(input.hostId);
      const wasIn = await tracker.markOut(node);
      return {
        success: true,
        message: wasIn
          ? `node '${node}' exited maintenance`
          : `node '${node}' was not in maintenance`,
        data: { node, wasInMaintenance: wasIn },
      };
    },

    async evacuateWorkload(
      input: EvacuateWorkloadInput,
    ): Promise<PrimitiveResult> {
      const sourceNode = nodeNameFromHostId(input.targetId);
      const client = requireClient(deps.client, "evacuateWorkload");
      requireMethod(client, "getVMs", "evacuateWorkload");
      requireMethod(client, "getNodes", "evacuateWorkload");
      requireMethod(client, "migrateVM", "evacuateWorkload");

      // 1. List workloads on the source node, filter to running non-templates.
      const allVms = await client.getVMs!(sourceNode);
      const running = allVms.filter(
        (vm) => vm.status === "running" && !vm.template,
      );
      if (running.length === 0) {
        return {
          success: true,
          message: `no running workloads on '${sourceNode}'`,
          data: { sourceNode, migrated: 0, details: [] },
        };
      }

      // 2. Pick destination candidates (round-robin across remaining online nodes).
      let candidates: string[];
      if (input.destination) {
        candidates = [input.destination];
      } else {
        const nodes = await client.getNodes!();
        candidates = nodes
          .filter((n) => n.node !== sourceNode && n.status === "online")
          .map((n) => n.node);
      }
      if (candidates.length === 0) {
        throw new Error(
          `evacuateWorkload: no online destination nodes available ` +
            `(source='${sourceNode}', mode='${input.mode}'). ` +
            `Add a second node to the cluster or specify destination explicitly.`,
        );
      }

      // 3. Migrate each VM. Round-robin across candidates for load distribution.
      type Result = {
        vmid: number;
        type: "qemu" | "lxc" | "unknown";
        to: string;
        upid?: string;
        error?: string;
      };
      const results: Result[] = [];
      let candidateIdx = 0;

      for (const vm of running) {
        const target = candidates[candidateIdx % candidates.length];
        candidateIdx++;
        const vmType = vm.type ?? "unknown";

        // LXC live migration is not supported by Proxmox (cold-only).
        // Our existing client.migrateVM hits the /qemu/ path; LXC
        // would need a separate /lxc/<vmid>/migrate endpoint we don't
        // wrap yet. Surface the limitation explicitly.
        if (vmType === "lxc") {
          results.push({
            vmid: vm.vmid,
            type: "lxc",
            to: target,
            error:
              "LXC container migration is not supported in v0.7.1.2 " +
              "(requires client.migrateLXC — track as follow-up)",
          });
          continue;
        }

        try {
          const wantLive = input.mode === "live_migrate";
          const upid = await client.migrateVM!({
            node: sourceNode,
            vmid: vm.vmid,
            target,
            online: wantLive,
            with_local_disks: true,
          });
          results.push({ vmid: vm.vmid, type: vmType, to: target, upid });
        } catch (err) {
          results.push({
            vmid: vm.vmid,
            type: vmType,
            to: target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        const details = failed
          .map((f) => `vmid=${f.vmid} type=${f.type}: ${f.error}`)
          .join("; ");
        throw new Error(
          `evacuateWorkload: ${failed.length}/${results.length} migrations failed on '${sourceNode}'. ${details}`,
        );
      }

      return {
        success: true,
        message: `evacuated ${results.length} workloads from '${sourceNode}'`,
        data: {
          sourceNode,
          migrated: results.length,
          mode: input.mode,
          details: results,
        },
      };
    },

    async remediateHost(
      input: RemediateHostInput,
    ): Promise<PrimitiveResult> {
      void input;
      throw new PrimitiveNotImplemented(PROVIDER, "remediateHost", "v0.7.1.3");
    },

    async rollback(input: RollbackInput): Promise<PrimitiveResult> {
      void input;
      throw new PrimitiveNotImplemented(PROVIDER, "rollback", "v0.7.1.4");
    },
  };
}

/**
 * REPLACE the registry entry for "proxmox" with a fully-wired
 * implementation. Call once at bootstrap after the ProxmoxClient is
 * connected + the FileMaintenanceTracker is open.
 */
export function configureProxmoxPrimitives(
  deps: ProxmoxPrimitivesDeps,
): Primitives {
  const impl = createProxmoxPrimitives(deps);
  registerPrimitives(PROVIDER, impl);
  return impl;
}

// Default registration on module load — uses an in-memory tracker
// and no client. enter/exitMaintenance work; the rest throw
// PrimitiveNotImplemented until configureProxmoxPrimitives() is
// called at bootstrap.
export const proxmoxPrimitives: Primitives = createProxmoxPrimitives();
registerPrimitives(PROVIDER, proxmoxPrimitives);

// ── Helpers ────────────────────────────────────────────────

/**
 * Throws PrimitiveNotImplemented when the primitive needs a wired
 * client but configureProxmoxPrimitives() hasn't been called.
 * Returns the client for chaining.
 */
function requireClient(
  client: ProxmoxPrimitivesClient | undefined,
  verb: PrimitiveMethod,
): ProxmoxPrimitivesClient {
  if (!client) {
    throw new PrimitiveNotImplemented(
      PROVIDER,
      verb,
      "configureProxmoxPrimitives({ client }) at bootstrap",
    );
  }
  return client;
}

/**
 * Asserts a structural-client interface method exists at runtime
 * (the type says `?` since adapters may grow the surface
 * incrementally; the verb-side wants a concrete failure).
 */
function requireMethod<K extends keyof ProxmoxPrimitivesClient>(
  client: ProxmoxPrimitivesClient,
  method: K,
  verb: PrimitiveMethod,
): void {
  if (typeof client[method] !== "function") {
    throw new PrimitiveNotImplemented(
      PROVIDER,
      verb,
      `ProxmoxPrimitivesClient.${String(method)}() — extend the wrapper / client to provide it`,
    );
  }
}

/**
 * Resource.id format for proxmox nodes: `proxmox:proxmox_node:{node}`.
 * Extract the node name from the hostId the orchestrator passes.
 */
export function nodeNameFromHostId(hostId: string): string {
  // Match the writer's id scheme. Format: `proxmox:proxmox_node:<name>`.
  const prefix = `${PROVIDER}:proxmox_node:`;
  if (!hostId.startsWith(prefix)) {
    throw new Error(
      `nodeNameFromHostId: expected '${prefix}<node>' but got '${hostId}'`,
    );
  }
  const name = hostId.slice(prefix.length);
  if (!name) {
    throw new Error(
      `nodeNameFromHostId: empty node name in hostId '${hostId}'`,
    );
  }
  return name;
}
