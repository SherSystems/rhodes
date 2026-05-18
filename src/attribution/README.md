# Attribution — Silence-mode / Event-Source

The attribution module answers the question RHODES asks before opening every incident: **"did anyone/anything trigger this state change?"** If yes, suppress the incident (or open it with attribution context so the postmortem says "operator-initiated, not a crash"). If no, open the incident normally — something genuinely unexpected happened.

This is the v0.6.5 piece that fixes:
- The v0.5.1 **RCA-hallucination bug** — operator-initiated VM shutdowns currently look like crashes
- The hard blocker for v0.7 **upgrade orchestration** — RHODES would self-alarm during every host maintenance window without attribution

## Architecture

```
   ┌──────────────────────────────────────────────────────────┐
   │  Per-substrate adapters (EventSource interface)          │
   │                                                          │
   │  - Proxmox task log poll                                 │
   │  - vCenter event API poll/stream                         │
   │  - AWS CloudTrail                                        │
   │  - Azure Activity Log                                    │
   │  - K8s audit log                                         │
   └──────────────────┬───────────────────────────────────────┘
                      │ emit AttributionEvent
                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │  EventSourceRegistry  →  AttributionStore (SQLite)       │
   └──────────────────────────────────────────────────────────┘
                      │
                      │ queries (by target_resource_id + window)
                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │  AttributionCorrelator                                   │
   │                                                          │
   │  findBestMatch(observation) → high | medium | low | null │
   │  shouldSuppress(observation) → suppression decision      │
   └──────────────────┬───────────────────────────────────────┘
                      │
                      │ "should we open this incident?"
                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Existing incident pipeline (src/healing/)               │
   └──────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|---|---|
| `types.ts` | `AttributionEvent`, `EventSource`, `Attribution`, state-change-observation types, event-type closed enum, default tunables |
| `schema.ts` | SQL DDL (idempotent), single `attribution_events` table with the right indexes for the correlator's hot queries |
| `store.ts` | `AttributionStore` — typed upsert/query/prune. Mirrors `src/healing/ticket-store.ts` patterns. |
| `correlator.ts` | `AttributionCorrelator` — finds the best-matching event for a state-change observation. Confidence ladder: high/medium/low/null. |
| `registry.ts` | `EventSourceRegistry` — starts/stops all per-substrate event sources together |
| `index.ts` | public exports |

## Match confidence ladder

| Confidence | When | Used for |
|---|---|---|
| **high** | Exact target_resource_id match + event_type matches the observed transition + tight time window (default 30s) | Auto-suppress the incident. Postmortem still records the attribution as context. |
| **medium** | Resource-id match within the full lookback window but event_type doesn't perfectly match the transition | Surface as context — incident still opens. Operator can investigate. |
| **low** | Provider-level activity without specific resource id (e.g., vCenter SSO login burst that might indicate a deploy is happening) | Reserved for future. Not used by default — too easy to mis-attribute. |
| **null** | Nothing matched within the lookback window | Incident opens normally. RHODES treats it as unattributed. |

## Adapter contract (each substrate implements this)

```ts
export interface EventSource {
  name: string;          // human-friendly for logs
  provider: GraphProvider;
  start(emit: (e: AttributionEvent) => void): Promise<void>;
  stop(): Promise<void>;
}
```

Adapters poll or stream from their substrate, NORMALIZE the substrate's native event vocabulary onto the closed `AttributionEventType` enum, and call `emit` for each event. Unknown events should be mapped to `'unknown_event'` rather than guessed.

## Usage from the incident pipeline

```ts
import { AttributionCorrelator } from "../attribution/index.js";

// When a state-change observation arrives:
const obs: StateChangeObservation = {
  resourceId: "proxmox:proxmox_vm:200",
  fromState: "running",
  toState: "stopped",
  observedAt: new Date().toISOString(),
};

const suppress = correlator.shouldSuppress(obs);
if (suppress) {
  // Don't open an incident — log the attribution context for audit
  log.info("incident suppressed", {
    actor: suppress.event.actor,
    via: suppress.event.actor.via,
    reason: suppress.matchReason,
  });
} else {
  // Open the incident as usual, optionally with attribution context
  const context = correlator.contextualize(obs);
  openIncident(obs, { attributionContext: context });
}
```

## What's NOT in v0.6.5

- **Per-substrate event-source adapters beyond Proxmox + vCenter** — AWS CloudTrail, Azure Activity Log, K8s audit log land in v0.6.5+ as those providers' graph-writers mature.
- **Background sweeper for `pruneStale()`** — exposed as a method; wire to a cron/timer when retention pressure shows up.
- **`low`-confidence policy** — surfaced via `contextualize()` but `shouldSuppress()` only suppresses on `high`. Lower the bar later if attribution proves accurate.
- **Cross-resource attribution chains** — e.g., "host_enter_maintenance attributes the VM_migrate of every VM that was on the host." Useful but adds graph-traversal complexity. v0.7 work alongside the orchestrator.

## Storage location

`getDataDir()/attribution.db` (default: `~/.rhodes/data/attribution.db`). WAL journal mode. Single table, three indexes. Pruned at the `EVENT_RETENTION_SEC` boundary (24h default).
