// ============================================================
// RHODES — VMware vSphere Primitives (stub for v0.6.0)
//
// Contract-only implementation of the substrate-agnostic
// primitives for vSphere. The bodies of the verb methods throw
// `PrimitiveNotImplemented` because the real wiring (vMotion via
// DRS, host maintenance mode, LCM remediate) lands in v0.6.5+.
//
// `capabilities()` is fully populated and HONEST — the v0.7
// orchestrator planner reads it to make routing decisions, so we
// publish what vSphere actually can do today even though the
// bodies are stubs:
//
//   - evacuate_workload: live_migrate (vMotion via DRS), evict
//     (power-off + register elsewhere). `replace` is NOT supported
//     on raw vSphere VMs — that's a K8s/cloud pattern.
//   - enter/exit_maintenance: full support, with DRS evacuation
//     when `evacuate: true`.
//   - remediate_host: vLCM cluster-image remediation.
//   - rollback: blue_green (parallel surge then cut), snapshot
//     restore (VM snapshot revert), inverse_mutation (replay the
//     reverse spec we recorded in the plan). `surge_teardown` is
//     not supported — it's a cloud/K8s autoscaling pattern.
//
// The `manifests_as` graph edge means a vSphere VM running on
// nested Proxmox iron may bind to BOTH adapters' primitives at
// different layers — but each adapter only speaks to its own
// substrate.
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

const PROVIDER: GraphProvider = "vsphere";
const EXPECTED_IN = "v0.6.5";

export const vmwarePrimitives: Primitives = {
  capabilities(): ProviderCapabilities {
    return {
      provider: PROVIDER,
      // vSphere supports live (vMotion) and cold (evict) moves;
      // `replace` requires immutable workload images and is not a
      // raw-vSphere pattern.
      evacuateModes: ["live_migrate", "evict"],
      maintenanceModeSupported: true,
      // vLCM cluster-image remediation.
      hostRemediationSupported: true,
      rollbackStrategies: ["blue_green", "snapshot_restore", "inverse_mutation"],
      notes:
        "vMotion requires shared storage or vSAN; DRS automation level " +
        "must be fully-automated for evacuate-on-maintenance to work " +
        "without operator approval. vLCM remediation is cluster-wide; " +
        "per-host remediation requires staging an image first.",
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

// Self-register at module load. The orchestrator never imports
// this file directly — it pulls in `src/primitives/index.ts`,
// which re-exports adapters so the side-effect runs exactly once.
registerPrimitives(PROVIDER, vmwarePrimitives);
