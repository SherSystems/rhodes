# Graph Discovery Scheduler

The discovery scheduler is the runtime component that drives provider
graph writers on a periodic cadence. Without it, the graph layer
(`src/graph/`) is dormant — the writers exist and are testable, but
nothing calls them.

## Why a separate scheduler

Each provider writer (`src/providers/vmware/graph-writer.ts`,
`src/providers/proxmox/graph-writer.ts`, ...) already knows how to
read its substrate and upsert resources into a `GraphStore`. What
they don't know:

- How often to run (different resource types have different freshness
  windows — see `FRESHNESS_WINDOW_SEC` in `src/graph/types.ts`).
- How to avoid piling overlapping discoveries on top of a stuck API
  call.
- When to invoke the cross-provider resolver that infers
  `manifests_as` edges.
- How to keep one bad provider from crashing the whole loop.

The scheduler owns those concerns so the writers stay simple.

## Lifecycle

```
new DiscoveryScheduler(store, opts)
        │
        ├─ add(writer, { intervalMs })   ← writer.register(store) runs immediately
        │
        ├─ start()                       ← timers begin; runOnBoot fires immediate pass
        │
        ├─ runOnce()                     ← test/observability hook; one pass for each writer
        │
        └─ await stop()                  ← clear intervals + drain in-flight passes
```

`stop()` is awaitable on purpose. The next thing bootstrap typically
does after shutdown is `store.close()` — running that against an
in-flight INSERT would explode. Drain first.

## Per-writer in-flight guard

Each registered writer has an `inFlight` bool. When a tick fires and
the writer is already running, the tick is dropped and a warning is
logged. This is the rule that stops a wedged Proxmox API call from
queueing N overlapping discoveries.

Writers run **concurrently across providers** but **never with
themselves**. vSphere and Proxmox don't block each other; if one
provider takes 90s while its interval is 60s, you get every-90s
discovery, not piled-up overlapping calls.

## Error handling

A `discover()` that throws is caught inside `runDiscoveryPass()`. The
error lands in the resulting `DiscoveryReport.errors[]` rather than
propagating. The scheduler never crashes from a writer fault.

The genuinely exceptional cases (store fault, OOM in a transaction)
are caught one level up in `DiscoveryScheduler.runEntryOnce()` and
also produce a `DiscoveryReport` with the error captured. The
scheduler still continues — the next tick will retry.

## Resolver integration

After every `runOnce()` pass (and after every per-writer interval
tick once the writer completes), `runResolver(store)` runs if
`resolverEnabled` is true (the default). This is what materializes
the cross-provider `manifests_as` edges that bind a Proxmox VM to
the vSphere ESXi host it carries.

The resolver lives in `src/graph/resolver.ts` and is locked — the
scheduler treats it as a black box.

## Bootstrap wiring

Discovery is **opt-in** behind the env var `RHODES_GRAPH_DISCOVERY`.
Set it to `on` (or `1`, `true`, `yes`) to enable. Default is OFF so
existing v0.5.x deployments don't surprise their operators with a
new background loop.

When enabled, `src/index.ts` instantiates a `GraphStore`, wraps each
configured provider's existing client into the `DiscoveryWriter`
contract, registers them with the scheduler, and calls `start()`.
The scheduler is wired into SIGINT/SIGTERM shutdown alongside the
other long-lived services so it drains cleanly.

When disabled, none of this code runs — there is no allocation, no
DB open, no background work.

## Tuning

| Knob                       | Default | Notes                                           |
| -------------------------- | ------- | ----------------------------------------------- |
| `intervalMs` (per writer)  | 60_000  | Override per-writer in `add(writer, { … })`     |
| `runOnBoot`                | true    | Set false to wait for the first interval tick   |
| `resolverEnabled`          | true    | Disable for pure write-throughput benchmarking  |

Per-type freshness windows from `FRESHNESS_WINDOW_SEC` are the
**consumer contract**, not the polling interval — see the comment in
`src/graph/types.ts`. The scheduler's per-writer interval is the
collector cadence; choose it so the collected data fits inside the
declared freshness window with margin for slow runs.

## Test hooks

`DiscoveryScheduler.runOnce()` is the official test seam. It runs
each writer once, awaits all in parallel, runs the resolver, and
returns the reports. No `setInterval` magic — tests don't need fake
timers.

For inspecting the per-pass deltas, the returned `DiscoveryReport`
carries `resourcesUpserted` and `relationshipsUpserted` computed by
diffing the store before and after. Per-writer per-resource counters
can be added later via a `writer.lastStats` hook without changing
the public scheduler API.
