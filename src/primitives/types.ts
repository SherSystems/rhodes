// ============================================================
// RHODES — Substrate-Agnostic Primitives Contract
//
// The v0.7 cluster-upgrade orchestrator composes plans out of a
// tiny vocabulary of substrate-agnostic verbs: evacuate a
// workload, enter/exit maintenance, remediate a host, roll back.
// Each verb is a *primitive* — a strongly-typed function whose
// implementation is provided by the underlying provider adapter
// (vSphere, Proxmox, AWS, Kubernetes, …).
//
// ARCHITECTURAL RULE (NON-NEGOTIABLE):
// The orchestrator NEVER imports a provider-specific client. It
// only ever talks to the registry exposed by this module. That
// is the discipline that makes RHODES the "AI brain for infra"
// — substrate-agnostic by construction, not by aspiration.
//
// CAPABILITY DISCOVERY (anti-LCD-trap):
// Substrates are NOT semantically equivalent. vSphere has true
// hypervisor maintenance mode; Proxmox doesn't (we emulate via
// HA-cordon). vSphere supports vMotion; Proxmox supports it for
// QEMU but not for LXC. The planner MUST query `capabilities()`
// and plan around what's actually possible — never assume the
// lowest common denominator, never assume cross-substrate
// equivalence. Each adapter publishes an honest capability shape
// even when its primitive bodies are still stubs.
// ============================================================

import type { GraphProvider } from "../graph/types.js";

// ── Primitive input shapes ─────────────────────────────────

/** Modes for moving workloads off a target.
 *  - `live_migrate`: zero-downtime move (vMotion, `qm migrate --online`).
 *  - `evict`: stop on source, restart on destination (acceptable downtime).
 *  - `replace`: cordon source, surge a fresh workload elsewhere, retire source.
 *
 *  Not every substrate supports every mode — that's why capability
 *  discovery exists. */
export type EvacuateMode = "live_migrate" | "evict" | "replace";

export interface EvacuateWorkloadInput {
  /** Resource id (graph-style: `{provider}:{type}:{uid}`) of the workload
   *  to move. */
  targetId: string;
  provider: GraphProvider;
  mode: EvacuateMode;
  /** Optional destination node/host id. If omitted, the substrate's
   *  scheduler (DRS, Proxmox HA, K8s scheduler) picks. */
  destination?: string;
}

export interface EnterMaintenanceInput {
  /** Resource id of the host/node to put into maintenance. */
  hostId: string;
  provider: GraphProvider;
  /** Whether to evacuate workloads as part of entering maintenance.
   *  On vSphere this maps to DRS evacuation; on Proxmox we drain HA
   *  placements and trigger a separate evacuate pass. */
  evacuate: boolean;
}

export interface ExitMaintenanceInput {
  hostId: string;
  provider: GraphProvider;
}

export interface RemediateHostInput {
  hostId: string;
  provider: GraphProvider;
  /** Optional desired image / version identifier. On vSphere this is
   *  the LCM cluster image; on Proxmox it's a target package manifest
   *  (or undefined for "apt full-upgrade to current channel"). */
  image?: string;
}

/** Rollback ladder strategies. Each adapter declares which it
 *  supports via `capabilities().rollbackStrategies`. */
export type RollbackStrategy =
  | "blue_green"
  | "surge_teardown"
  | "snapshot_restore"
  | "inverse_mutation";

export interface RollbackInput {
  /** The plan that produced the failing step. */
  planId: string;
  /** The specific step within the plan that needs to be undone. */
  stepId: string;
  provider: GraphProvider;
  strategy: RollbackStrategy;
}

// ── Primitive result shape ─────────────────────────────────

/**
 * Every primitive returns this envelope. Async/long-running work
 * (vMotion, LCM remediate) returns an `operationId` the orchestrator
 * can poll; synchronous primitives just set `success: true`.
 */
export interface PrimitiveResult {
  success: boolean;
  /** Substrate-side task / operation handle for async polling. */
  operationId?: string;
  /** Free-form message — surfaced to the planner and to operators. */
  message?: string;
  /** Substrate-side payload (vSphere task object, Proxmox UPID, …). */
  data?: unknown;
}

// ── Capability shape ───────────────────────────────────────

/**
 * Honest capability advertisement from a provider adapter. The
 * orchestrator's planner queries this BEFORE assembling a plan and
 * routes around things the substrate genuinely can't do.
 *
 * Adapters MUST keep this in sync with reality — lying here is
 * worse than not implementing the primitive at all, because the
 * planner will commit to a plan it can't execute.
 */
export interface ProviderCapabilities {
  provider: GraphProvider;
  /** Which evacuate modes this substrate actually supports. */
  evacuateModes: EvacuateMode[];
  /** Does this substrate have a real (or faithfully-emulated)
   *  maintenance mode? Proxmox sets this to `true` even though the
   *  implementation is emulated via HA cordon — the contract holds. */
  maintenanceModeSupported: boolean;
  /** Does this substrate support remediating hosts to a target image
   *  (vSphere LCM, `apt upgrade`, K8s node image roll)? */
  hostRemediationSupported: boolean;
  /** Which rollback strategies the adapter knows how to execute. */
  rollbackStrategies: RollbackStrategy[];
  /** Free-form caveats the planner should consider — e.g. "LXC
   *  containers only support cold migration", "DRS required for
   *  evacuate-on-maintenance". */
  notes?: string;
}

// ── Primitive interface ────────────────────────────────────

/**
 * The full contract a provider adapter must implement to participate
 * in the orchestrator's primitive vocabulary. `capabilities()` is the
 * only method that must always succeed; the verb methods may throw
 * `PrimitiveNotImplemented` while the contract is still being wired.
 */
export interface Primitives {
  capabilities(): ProviderCapabilities;
  evacuateWorkload(input: EvacuateWorkloadInput): Promise<PrimitiveResult>;
  enterMaintenance(input: EnterMaintenanceInput): Promise<PrimitiveResult>;
  exitMaintenance(input: ExitMaintenanceInput): Promise<PrimitiveResult>;
  remediateHost(input: RemediateHostInput): Promise<PrimitiveResult>;
  rollback(input: RollbackInput): Promise<PrimitiveResult>;
}

/** Method names exposed by the primitives contract. Useful for the
 *  registry error paths and for tests. */
export type PrimitiveMethod =
  | "evacuateWorkload"
  | "enterMaintenance"
  | "exitMaintenance"
  | "remediateHost"
  | "rollback";

// ── Errors ─────────────────────────────────────────────────

/**
 * Thrown by adapter stubs whose method body isn't wired yet. The
 * orchestrator catches this and either falls back to a different
 * primitive or aborts the plan — it must never silently no-op.
 *
 * The error message MUST name the provider, the method, and the
 * version in which the real implementation is expected.
 */
export class PrimitiveNotImplemented extends Error {
  readonly provider: GraphProvider;
  readonly method: PrimitiveMethod;
  readonly expectedIn?: string;

  constructor(
    provider: GraphProvider,
    method: PrimitiveMethod,
    expectedIn?: string,
  ) {
    const suffix = expectedIn ? ` (expected in ${expectedIn})` : "";
    super(
      `Primitive '${method}' is not yet implemented for provider '${provider}'${suffix}. ` +
        `This is a v0.6.0 contract-only stub; real impl in v0.6.5+.`,
    );
    this.name = "PrimitiveNotImplemented";
    this.provider = provider;
    this.method = method;
    this.expectedIn = expectedIn;
  }
}

/**
 * Thrown by `getPrimitives()` / `capabilities()` when no adapter has
 * registered for the requested provider. The orchestrator catches
 * this and surfaces a configuration error to the operator — it's
 * never recoverable mid-plan.
 */
export class ProviderNotRegistered extends Error {
  readonly provider: GraphProvider;

  constructor(provider: GraphProvider) {
    super(
      `No primitives implementation is registered for provider '${provider}'. ` +
        `Did you forget to import the adapter module?`,
    );
    this.name = "ProviderNotRegistered";
    this.provider = provider;
  }
}

/**
 * Thrown when an adapter's primitive is invoked with a mode/strategy
 * its `capabilities()` does NOT advertise. Surfaces planner bugs at
 * call time instead of letting the substrate return a cryptic API
 * error from deep inside a side-effect.
 */
export class CapabilityUnsupported extends Error {
  readonly provider: GraphProvider;
  readonly method: PrimitiveMethod;
  readonly requested: string;

  constructor(
    provider: GraphProvider,
    method: PrimitiveMethod,
    requested: string,
  ) {
    super(
      `Provider '${provider}' does not support '${requested}' for primitive '${method}'. ` +
        `Check capabilities() before calling.`,
    );
    this.name = "CapabilityUnsupported";
    this.provider = provider;
    this.method = method;
    this.requested = requested;
  }
}
