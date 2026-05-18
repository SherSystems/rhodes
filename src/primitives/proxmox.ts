// ============================================================
// RHODES — Proxmox Primitives (stub for v0.6.0)
//
// Contract-only implementation of the substrate-agnostic
// primitives for Proxmox VE. As with the vSphere stub, the verb
// bodies throw `PrimitiveNotImplemented`; `capabilities()` is
// honest and complete.
//
// PROXMOX-SPECIFIC TRUTH (the things the planner must respect):
//
//   - QEMU VMs support `qm migrate <vmid> <target> --online` for
//     live migration. LXC containers DO NOT — `pct migrate` is
//     cold (stop, send rootfs, start). Mixed-workload clusters
//     therefore can't promise live evacuation cluster-wide; the
//     planner has to inspect the workload type before picking
//     `live_migrate`.
//
//   - There is NO native host-level "maintenance mode" in Proxmox.
//     We EMULATE one by (a) draining the node's role in HA so the
//     HA manager won't place workloads on it, (b) tagging the node
//     in our own state store as cordoned. This is the documented
//     pattern from the research and is faithful enough that the
//     planner can treat it as a real maintenance mode.
//
//   - Host remediation is `apt full-upgrade` + reboot, optionally
//     pinning to a specific PVE channel. There's no LCM-equivalent
//     cluster image, so `image` in `RemediateHostInput` maps to a
//     repository/channel selector, not an immutable image hash.
//
//   - Rollback ladder: snapshot_restore (qm rollback / pct rollback)
//     is first-class. inverse_mutation works for any spec we
//     recorded the reverse of. blue_green and surge_teardown are
//     NOT raw-Proxmox patterns — they're K8s/cloud territory.
// ============================================================

import type { GraphProvider } from "../graph/types.js";
import { registerPrimitives } from "./registry.js";
import {
  PrimitiveNotImplemented,
  type EnterMaintenanceInput,
  type EvacuateWorkloadInput,
  type ExitMaintenanceInput,
  type PrimitiveResult,
  type Primitives,
  type ProviderCapabilities,
  type RemediateHostInput,
  type RollbackInput,
} from "./types.js";

const PROVIDER: GraphProvider = "proxmox";
const EXPECTED_IN = "v0.6.5";

export const proxmoxPrimitives: Primitives = {
  capabilities(): ProviderCapabilities {
    return {
      provider: PROVIDER,
      // QEMU VMs live-migrate; LXC is cold. We advertise both modes
      // and rely on the planner to dispatch per workload type — see
      // the `notes` field.
      evacuateModes: ["live_migrate", "evict"],
      // Emulated via HA cordon + own-state tagging — the contract
      // still holds for the orchestrator.
      maintenanceModeSupported: true,
      // `apt full-upgrade` + reboot.
      hostRemediationSupported: true,
      rollbackStrategies: ["snapshot_restore", "inverse_mutation"],
      notes:
        "Live migration only works for QEMU VMs; LXC containers fall " +
        "back to cold migration (evict mode). 'maintenance mode' is " +
        "emulated via HA cordon + RHODES-side tagging — there is no " +
        "native Proxmox equivalent. Host remediation = apt full-upgrade " +
        "on the PVE channel; pinning a specific image requires a custom " +
        "repository.",
    };
  },

  async evacuateWorkload(input: EvacuateWorkloadInput): Promise<PrimitiveResult> {
    void input;
    throw new PrimitiveNotImplemented(PROVIDER, "evacuateWorkload", EXPECTED_IN);
  },

  async enterMaintenance(input: EnterMaintenanceInput): Promise<PrimitiveResult> {
    void input;
    throw new PrimitiveNotImplemented(PROVIDER, "enterMaintenance", EXPECTED_IN);
  },

  async exitMaintenance(input: ExitMaintenanceInput): Promise<PrimitiveResult> {
    void input;
    throw new PrimitiveNotImplemented(PROVIDER, "exitMaintenance", EXPECTED_IN);
  },

  async remediateHost(input: RemediateHostInput): Promise<PrimitiveResult> {
    void input;
    throw new PrimitiveNotImplemented(PROVIDER, "remediateHost", EXPECTED_IN);
  },

  async rollback(input: RollbackInput): Promise<PrimitiveResult> {
    void input;
    throw new PrimitiveNotImplemented(PROVIDER, "rollback", EXPECTED_IN);
  },
};

registerPrimitives(PROVIDER, proxmoxPrimitives);
