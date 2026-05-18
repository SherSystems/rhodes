// ============================================================
// RHODES — Primitives Module Index
//
// Public surface of the primitives layer. Consumers (the v0.7
// cluster-upgrade orchestrator first and foremost) import EVERY-
// thing they need about substrate operations from here:
//
//   import { capabilities, getPrimitives } from "../primitives/index.js";
//
// Importing this file also runs the adapter side-effects that
// self-register each provider into the registry. Order matters
// only insofar as the adapter imports must execute before the
// first `getPrimitives()` lookup — which is guaranteed by the
// ES-module spec for top-level imports.
// ============================================================

// Type contract.
export type {
  EvacuateMode,
  EvacuateWorkloadInput,
  EnterMaintenanceInput,
  ExitMaintenanceInput,
  RemediateHostInput,
  RollbackInput,
  RollbackStrategy,
  PrimitiveMethod,
  PrimitiveResult,
  Primitives,
  ProviderCapabilities,
} from "./types.js";

export {
  PrimitiveNotImplemented,
  ProviderNotRegistered,
  CapabilityUnsupported,
} from "./types.js";

// Registry surface.
export {
  registerPrimitives,
  getPrimitives,
  capabilities,
  registeredProviders,
  resetRegistry,
} from "./registry.js";

// Adapter side-effect imports — pull these in so the registry is
// populated by the time any consumer calls `getPrimitives()`.
// Named exports are re-published for tests that want to assert on
// the stub bindings directly.
export { vmwarePrimitives } from "./vmware.js";
export { proxmoxPrimitives } from "./proxmox.js";
