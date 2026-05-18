// ============================================================
// RHODES — Primitives Registry
//
// Provider → Primitives binding lives here. Adapter modules call
// `registerPrimitives(provider, impl)` at module-load time; the
// orchestrator calls `getPrimitives(provider)` / `capabilities(
// provider)` to dispatch. The orchestrator has no other coupling
// to any provider-specific code — this is the seam.
//
// Why a process-global Map and not DI?
// The set of installed adapters is fixed at deploy time (the
// admin enables vSphere or Proxmox or both via config). The
// registry is therefore a deploy-time singleton, not a per-request
// dependency. Tests get a `resetRegistry()` to clear state.
//
// Why no auto-discovery / dynamic import?
// Static imports are what make the substrate-agnostic guarantee
// visible to the type checker. Adding a new provider means adding
// a new file under `src/primitives/` AND importing it from
// `index.ts` — that's the audit trail.
// ============================================================

import type { GraphProvider } from "../graph/types.js";
import {
  ProviderNotRegistered,
  type Primitives,
  type ProviderCapabilities,
} from "./types.js";

// ── Internal storage ───────────────────────────────────────

const registry = new Map<GraphProvider, Primitives>();

// ── Public API ─────────────────────────────────────────────

/**
 * Register a primitives implementation for a provider. Called by
 * each adapter module at import time. Re-registering overwrites the
 * previous binding (tests rely on this; in production every adapter
 * registers exactly once).
 */
export function registerPrimitives(
  provider: GraphProvider,
  impl: Primitives,
): void {
  registry.set(provider, impl);
}

/**
 * Look up the primitives implementation for a provider. Throws
 * `ProviderNotRegistered` if nothing has bound — this surfaces
 * config errors loudly at the seam rather than letting a `null`
 * propagate into the orchestrator.
 */
export function getPrimitives(provider: GraphProvider): Primitives {
  const impl = registry.get(provider);
  if (!impl) throw new ProviderNotRegistered(provider);
  return impl;
}

/**
 * Capability lookup convenience. The orchestrator's planner calls
 * this BEFORE assembling a plan to learn what the substrate can
 * actually do — see the anti-LCD-trap note in `types.ts`.
 *
 * `capabilities()` itself MUST NOT throw on a registered provider
 * (the adapter's responsibility); we only throw here when nothing
 * is registered at all.
 */
export function capabilities(provider: GraphProvider): ProviderCapabilities {
  return getPrimitives(provider).capabilities();
}

/**
 * List every provider that currently has a primitives binding.
 * Used by the dashboard / `rhodes capabilities` CLI to show the
 * operator what's available in this deployment.
 */
export function registeredProviders(): GraphProvider[] {
  return Array.from(registry.keys());
}

/**
 * Test-only: wipe the registry. Production code never calls this.
 * Exported (not internal-only) because vitest test files need it
 * across module boundaries.
 */
export function resetRegistry(): void {
  registry.clear();
}
