# `src/primitives/` — Substrate-Agnostic Primitives

This module defines the **only** vocabulary the v0.7 cluster-upgrade
orchestrator (and any future cross-substrate planner) is allowed to
speak when it needs the underlying infrastructure to do something.

## The architectural rule

> The orchestrator NEVER imports a provider-specific client.

If you find yourself reaching for `VSphereClient` or `ProxmoxClient`
inside `src/autopilot/`, `src/healing/`, `src/governance/`, or any
future `src/orchestrator/` module — stop. Add (or extend) a primitive
here instead, then implement the body inside the provider adapter.

This is the discipline that makes RHODES the "AI brain for infra"
rather than a VMware-flavored automation tool. Hybrid-substrate is
NOT a feature you bolt on later; it is an invariant you maintain from
day one by routing all substrate effects through this seam.

## The five primitives

| Primitive | Verb | Where the real impl will live |
|-----------|------|--------------------------------|
| `evacuateWorkload` | move a VM/container off a target | provider adapter (v0.6.5) |
| `enterMaintenance` | put a host into maintenance mode | provider adapter (v0.6.5) |
| `exitMaintenance` | bring a host back online | provider adapter (v0.6.5) |
| `remediateHost` | apply pending image/patches to a host | provider adapter (v0.6.5) |
| `rollback` | execute a substrate-specific rollback strategy | provider adapter (v0.6.5) |

That's it. Every higher-level operation (cluster upgrade, rolling
patch, blast-radius-limited remediation, …) composes these five
verbs. If a use case can't be expressed in this vocabulary, the right
answer is almost always to widen ONE of these — not to bypass the
seam.

## Capability discovery (and why it exists)

Substrates are NOT semantically equivalent. The biggest mistake a
multi-cloud / multi-hypervisor abstraction can make is "lowest common
denominator": flatten away the differences, treat every backend as
the same, and watch reliability plummet because the abstraction lied
about what was possible.

We reject that explicitly. Every adapter publishes a
`ProviderCapabilities` shape via `capabilities()`:

```ts
interface ProviderCapabilities {
  provider: GraphProvider;
  evacuateModes: Array<"live_migrate" | "evict" | "replace">;
  maintenanceModeSupported: boolean;
  hostRemediationSupported: boolean;
  rollbackStrategies: Array<"blue_green" | "surge_teardown" | "snapshot_restore" | "inverse_mutation">;
  notes?: string;
}
```

The orchestrator's planner MUST read this BEFORE generating a plan
and route around things the substrate can't do. Example: a Proxmox
cluster with mixed QEMU/LXC workloads can't promise live evacuation
for the LXC subset — the planner reads `notes`, sees the LXC caveat,
and dispatches `evict` mode for those workloads instead of failing
mid-plan.

## What each adapter must do

A new provider adapter under `src/primitives/` MUST:

1. Implement the full `Primitives` interface from `./types.ts`.
2. Publish an HONEST `ProviderCapabilities`. Lying here is worse than
   not implementing the primitive — the planner will commit to a
   plan it can't execute. If a strategy is unsupported, leave it out
   of the array.
3. Call `registerPrimitives(provider, impl)` at module load time.
4. Be re-exported from `./index.ts` so its side-effect runs before
   any consumer lookup.

Stubs (like the v0.6.0 versions of `vmware.ts` and `proxmox.ts`) are
allowed to throw `PrimitiveNotImplemented` from the verb methods —
but `capabilities()` must always return a fully-populated, accurate
shape. The planner needs to plan even when the bodies aren't wired
yet.

## Current capability matrix (v0.6.0)

| | vSphere | Proxmox |
|---|---|---|
| `live_migrate` | yes (vMotion / DRS) | yes (QEMU only) |
| `evict` | yes | yes (LXC cold-migration path) |
| `replace` | no | no |
| `maintenanceModeSupported` | yes (native) | yes (emulated via HA cordon) |
| `hostRemediationSupported` | yes (vLCM cluster image) | yes (`apt full-upgrade`) |
| `blue_green` rollback | yes | no |
| `surge_teardown` rollback | no | no |
| `snapshot_restore` rollback | yes | yes |
| `inverse_mutation` rollback | yes | yes |

When AWS / Azure / Kubernetes adapters land (v0.6.5, v0.7), this
table grows — and the `replace` and `surge_teardown` columns light
up where they belong (immutable-workload substrates).

## Errors

- `PrimitiveNotImplemented` — adapter stub, not wired yet.
- `ProviderNotRegistered` — no adapter bound for this provider; the
  operator's config is broken.
- `CapabilityUnsupported` — caller asked for a mode/strategy the
  adapter's `capabilities()` does NOT advertise; the planner has a
  bug.

All three are exported from `./index.ts` and the orchestrator catches
them explicitly. None of them should ever silently no-op.
