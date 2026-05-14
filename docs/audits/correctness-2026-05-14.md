# RHODES correctness audit — 2026-05-14

**Audit branch:** `audit/correctness-quality-2026-05-14`
**Base:** `ca9a15f` (v0.4.4)
**Auditor:** Claude (senior-engineer pass)
**Scope:** healing engine, governance/approval, agent loop, playbooks, SSH sudo-ladder, provider adapters, dashboard SSE, test gaps, TS strictness.

---

## Executive summary

The v0.4.4 codebase is structurally sound. Type-check is clean (`tsc --noEmit` exits 0) and the test suite reproduces the released baseline exactly: **2090 passing, 1 pre-existing failure** in `dashboard-server-static.test.ts` (the dashboard-v2 static-asset test that has reproduced on every revision since v0.4.3 and is unrelated to anything in this release). No regressions.

That said, this audit found **one HIGH-severity correctness bug** in the approval gate: per-step approvals can be silently auto-resolved by a prior plan-level decision because `decisions` is keyed only by `plan_id`. There is also a **HIGH-severity gap** in the agent loop: no plan-, step-, or LLM-call timeout exists, so a hung Anthropic/OpenAI request stalls the entire heal indefinitely. Several MEDIUM-severity findings cluster around SSE/eventBus backpressure, restart-loop guard persistence, and `setInterval`-driven tick overlap.

**Live state correction:** the task brief stated `shadow_mode` is OFF, but `http://localhost:7412/api/agent/status` currently returns `"dry_run":true, "shadow_mode":true` — i.e. shadow is ON, not OFF. The release notes also state shadow ON for the production NUC. **Under the actual live config, RHODES is safe to leave running overnight: tier-2+ actions are short-circuited at the executor (`src/agent/executor.ts:363-378`) and only tier-1 reads execute against the real cluster.** If shadow_mode were actually flipped to OFF tonight, the HIGH findings below would become operationally relevant and I would recommend deferring the flip until at least the approval-gate plan-vs-step bug is fixed.

I did **not** commit any fix — none of the findings cross the CRITICAL threshold (production currently can't write).

---

## Findings table

| # | Severity | Class | Location | Description |
|---|---|---|---|---|
| 1 | HIGH | governance | `src/governance/approval.ts:301-317` | Prior plan-level decision auto-resolves subsequent per-step gates for the same `plan_id`, bypassing per-step approval for tiers requiring explicit review |
| 2 | HIGH | agent loop | `src/agent/llm.ts:31-61`, `src/agent/executor.ts:525-574` | No plan-, step-, or LLM-level timeout for non-rollback-required actions. A hung Anthropic/OpenAI call stalls `agentCore.run` indefinitely |
| 3 | MEDIUM | governance | `src/governance/approval.ts:212, 315` | `pendingResolvers` is keyed by `plan_id` for both plan-level and per-step gates; if a plan ever queues two step-level gates back-to-back they collide and one promise leaks |
| 4 | MEDIUM | dashboard | `src/frontends/dashboard/server.ts:1763-1773` | SSE broadcast uses `client.res.write(data)` without checking the boolean return — a slow/stalled client buffers without backpressure, growing the per-socket queue unboundedly |
| 5 | MEDIUM | playbooks | `src/playbooks/service-http-probe.ts:368-407` | Restart-loop guard history is in-memory only; an `rhodes.service` restart resets the 3-restart/30-min counter to zero. Acknowledged in code comments but a real flap risk |
| 6 | MEDIUM | playbook engine | `src/healing/healing-engine.ts:151-153` | `playbookEngine.match()[0]` takes only the first matching playbook. `jellyfin-service-probe` and `vm_in_guest_diagnostic` share the same trigger so the release-notes narrative "the two playbooks share the same trigger so they fire together" is incorrect — only `jellyfin-service-probe` fires for jellyfin; `vm_in_guest_diagnostic` only fires for non-jellyfin services |
| 7 | MEDIUM | healing engine | `src/healing/healing-engine.ts:470-477` | `setInterval` doesn't await prior tick completion. If a tick stalls (e.g. on the agent-loop timeout finding above), subsequent ticks pile up |
| 8 | LOW | playbooks | `src/playbooks/proxmox-storage-pause.ts:955-972` | `await executor.qmTakeSnapshot(...)` has no try/catch; a rejected promise propagates out of `runProxmoxStoragePausePlaybook`. Only ever invoked from tests today (no production caller), so academic |
| 9 | LOW | TS strictness | various | 9 `as any` and ~15 bare `: any` in production paths. Mostly defensive casts on cross-module objects (e.g. `dashboard as unknown as { healer ... }` in `src/index.ts`); `src/migration/adapter.ts` has the worst concentration (6× untyped VMware info) |
| 10 | LOW | tests | `tests/governance/api-approval.test.ts` | No test exercises two sequential per-step `requestApproval` calls on the same `plan_id` — the exact path that surfaces finding #1 |
| 11 | LOW | tests | `tests/playbooks/proxmox-storage-pause.test.ts` | Covers `qmTakeSnapshot` returning `{ ok: false }` but not the case where the executor's mock throws (caller behavior on rejection is unspecified) |
| 12 | LOW | release notes | `docs/releases/v0.4.4.md:87` | Release notes claim "shadow mode on" but the prompt for this audit said "shadow_mode OFF". The live API confirms shadow is currently ON. Just a documentation/communication drift |

---

## Per-finding detail

### 1. HIGH — Plan-level decision shadows per-step approval

**File:** `src/governance/approval.ts:299-317` (per-step `requestApproval`) and `src/governance/approval.ts:140-163` (`submitApiDecision`).

**Excerpt** (`src/governance/approval.ts:301-303`):
```ts
const prior = this.decisions.get(planId);
const approved = await (prior
  ? Promise.resolve(prior.decision === "approve")
  : new Promise<boolean>((resolve) => { … }));
```

**Failure scenario.**
1. Operator approves a plan via `POST /api/agent/approve` → `submitApiDecision("plan-X", "approve", ...)` records `decisions.set("plan-X", record)`, resolves the plan-level promise.
2. The plan executes. One of its steps is classified at a tier in `policy.orchestration.approval.explicit_tiers` (typically `destructive`), so `GovernanceEngine.evaluate` (`src/governance/index.ts:164-182`) does **not** short-circuit on `isPlanApproved` — it calls `approvalGate.requestApproval()` for that step.
3. `requestApproval` checks `decisions.get(planId)` and finds the prior plan-level decision. It auto-resolves `approved = true` (line 302) **without ever surfacing the step to the operator**, returning `approved_by = operator ?? "api_operator"`.

The intent of `policy.explicit_tiers` is to force human review *per step* regardless of plan-level coverage. This bug defeats that intent.

**Why tests miss it.** `tests/governance/api-approval.test.ts` exercises plan-level approval and a single step-level approval, but never the combination (plan-level approve → execute → step-level requests approval).

**Recommended fix** (do not implement now; documented for the operator):
- Track decisions keyed by `(plan_id, request_id)` or — simpler — distinguish `plan_decisions` from `step_decisions` maps, and **never** reuse a plan-level decision to satisfy a step-level request.
- Add a regression test that:
  1. Calls `gate.requestPlanApproval("p", …)` and `submitApiDecision("p","approve",…)`.
  2. Then calls `gate.requestApproval({ id: "step-A", plan_id: "p", …, tier: "destructive" })` and asserts that the second call **does** wait on a new `submitApiDecision` (i.e. emits a new AwaitingApproval, resolves only after a second `submitApiDecision("p","approve",…)`).

**Operational impact under current shadow_mode=ON:** none. Executor short-circuits tier-2+ writes anyway. Under shadow_mode=OFF this becomes immediately exploitable.

---

### 2. HIGH — No plan/step/LLM timeout for normal execution

**Files:**
- `src/agent/llm.ts:31-86` — `callLLM` awaits the SDK call directly with no `signal`/timeout.
- `src/agent/executor.ts:525-574` — `executeToolWithTimeout` applies a timeout **only** when the caller passes `timeoutMs`. The caller (`executeToolWithPolicies` line 396) sets `timeoutMs` only when `rollbackRequired === true`, which is itself controlled by `policy.orchestration.rollback.trigger_tiers`. So tier-1 reads and any tier whose rollback isn't required get **no timeout at all**.
- `src/healing/healing-engine.ts:261-265` — `const promise = this.agentCore.run(goal); … const result = await promise;` is unbounded.

**Failure scenario.** Anthropic's API hangs (this happens — observed real incidents during long retry storms) or the underlying HTTP stalls without an EOF. `callLLM` never resolves. `planner.createPlan` therefore never resolves. `agentCore.run` is awaited in `HealingExecutor.executeHealing`. The active heal sits in `activeHeals` forever; `maxConcurrentHeals` (default 3 per `HealingEngineConfig`) gets exhausted; subsequent anomalies get dropped at the `if (this.activeHeals.size >= this.config.maxConcurrentHeals) return;` check (line 165). RHODES looks healthy from outside (tick is firing, `lastTick.healingsStarted` increments once and never again) but is effectively wedged.

The Anthropic SDK has its own default request timeout (10 minutes), so this is more "ten minutes of degradation per stuck call" than truly forever — but ten minutes of being unable to handle a paused VM is operationally meaningful.

**Recommended fix.**
- Pass `signal: AbortSignal.timeout(120_000)` (or a configurable ms) into both `client.messages.create` (Anthropic) and `client.chat.completions.create` (OpenAI) in `src/agent/llm.ts`.
- Wrap `agentCore.run(goal)` in a `Promise.race` against a wall-clock plan timeout in `HealingExecutor.executeHealing`. On timeout, fail the heal and let the circuit breaker count it.

---

### 3. MEDIUM — `pendingResolvers` key collision

**File:** `src/governance/approval.ts:200-218` (plan-level) and `src/governance/approval.ts:305-316` (per-step).

Both code paths call `this.pendingResolvers.set(planId, …)`. If a plan ever produces two simultaneous per-step gates (e.g. by interleaving with `requestPlanApproval`, or by an early code change that lets multiple per-step gates queue), the second `set` overwrites the first **without resolving its promise**, leaking it forever.

This is dormant today because the plan executor (`src/agent/core.ts:288-300`) runs ready steps **sequentially**, so only one per-step gate is ever live at a time. A future change to parallelize independent steps would surface it immediately.

**Recommended fix.** Key by a tuple of `(plan_id, request_id)` and have `submitApiDecision` resolve every pending entry with matching `plan_id`.

---

### 4. MEDIUM — SSE broadcast ignores backpressure

**File:** `src/frontends/dashboard/server.ts:1763-1773`.

```ts
for (const [id, client] of this.clients) {
  try {
    client.res.write(data);
  } catch {
    this.clients.delete(id);
  }
}
```

`res.write` returns `false` when the kernel buffer is full; the recommended pattern is to wait for `'drain'` before writing more. Today's code blasts every event to every connected client unconditionally, so a slow consumer can balloon the per-socket buffer (the eventBus emits frequently — `HealingTick` alone fires every poll interval).

In practice the dashboard is local to the NUC over Tailscale so this is mostly hypothetical, but it deserves a fix when convenient. A simple bounded queue per client with a drop-oldest policy + an "events dropped" counter in `/api/agent/status` would close it.

---

### 5. MEDIUM — Restart-loop guard is in-memory only

**File:** `src/playbooks/service-http-probe.ts:368-407`, comment at line 372: "The history is intentionally in-memory + injected; the autopilot owns persistence if it cares to survive restarts of RHODES itself."

Today nobody persists it. An operator restarts `rhodes.service` (deploy, reboot, anything) and the 3-restart-per-30-min counter resets. A genuinely flapping service can therefore be restarted 3× → daemon restart → 3× more → and so on.

**Recommended fix.** Persist `restart_history` per-service into the same JSON store as `incidents.json` (`src/healing/incidents.ts:427`). 30-min window + small number of services = negligible footprint.

---

### 6. MEDIUM — Two playbooks share a trigger but only one fires

**File:** `src/healing/playbooks.ts:407-472` (definitions), `src/healing/healing-engine.ts:151-153` (match-selection).

Both `jellyfin-service-probe` (label filter `service_name: jellyfin`) and `vm_in_guest_diagnostic` (no label filter) register for `metric: service_http_status, type: state_change, severity: critical`. `playbookEngine.match()` returns the list of all matches, but `HealingExecutor.handleAnomaly` reads only `match(anomaly)[0]`. Effect:

- For jellyfin's HTTP probe failures, only `jellyfin-service-probe` fires (it's registered first in `DEFAULT_PLAYBOOKS`). The release-notes claim "the two playbooks share the same trigger so they fire together — the http-probe handles the simple 'just restart it' case, the diagnostic playbook handles everything underneath" is therefore **wrong** for jellyfin. It's correct only for non-jellyfin services where the label-filtered playbook doesn't match.

This is a behavioral mismatch with the documented design more than a bug per se — but it means the v0.4.4 "service-probe-restart-fails → vm-diagnostic-fires" chain narrative is incorrect. The chain currently only fires for services without a dedicated probe playbook.

**Recommended fix.** Either (a) explicitly chain (after jellyfin-service-probe fails, fire vm_in_guest_diagnostic as a follow-up), or (b) have `match()` return *all* playbooks and the executor fire them in sequence respecting `requires_approval`. Don't ship the chain narrative as-is.

---

### 7. MEDIUM — `setInterval` tick overlap

**File:** `src/healing/healing-engine.ts:474-477`.

```ts
this.pollTimer = setInterval(() => {
  this.tick().catch((err) => console.error("[healing] Tick failed:", err));
}, this.config.pollIntervalMs);
```

`setInterval` fires on schedule regardless of whether the previous tick has resolved. If a tick takes longer than `pollIntervalMs` (it can, when the LLM is in the loop — see finding #2), ticks accumulate. Combined with finding #2 this is how RHODES could pile up dozens of overlapping ticks while one is stuck.

**Recommended fix.** Use `setTimeout` self-rescheduling: each `tick()` schedules the next on completion. Standard pattern; the migration is mechanical.

---

### 8. LOW — `qmTakeSnapshot` rejection path

**File:** `src/playbooks/proxmox-storage-pause.ts:955-972`.

```ts
if (kind === "take_safety_snapshot") {
  const r = await executor.qmTakeSnapshot(options.node, step.vmid, step.snapname, …);
  if (!r.ok) { /* abort cleanly */ }
}
```

The `await` has no surrounding try/catch. If the executor's `qmTakeSnapshot` rejects (network error, etc.), `runProxmoxStoragePausePlaybook` propagates the exception to its caller. **Not currently a production hazard** — `grep` shows no production caller of `runProxmoxStoragePausePlaybook` outside tests; the LLM agent uses the spec but executes tools individually. Worth a try/catch for symmetry with the rest of the runner if/when something does adopt it.

---

### 9. LOW — `any` / `as unknown as` density

9 `as any` casts and ~15 bare `: any` parameter annotations in production code. The worst concentration is `src/migration/adapter.ts` (~6 untyped `vmInfo: any` casts in the VMware → target mapping path). `src/index.ts` has 8 `as unknown as { … }` casts to attach runtime fields to `dashboard` — these are documented hatches, not hiding bugs. `src/frontends/cli.ts` has untyped table-row builders that won't bite at runtime but make the CLI harder to refactor. None of these are immediate correctness issues.

---

### 10–11. LOW — Test gaps

See per-finding sections. Both gaps are direct sibs to findings #1 and #8 respectively. Closing them is a 30-min job each.

---

### 12. LOW — Shadow-mode communication drift

The task brief stated "running on production homelab NUC right now with shadow_mode OFF". The live API (`/api/agent/status`) and release notes (`docs/releases/v0.4.4.md:87`) both say shadow is ON. Confirm with the operator before relying on either side of this. The audit answer below assumes the live state (`shadow_mode=ON`).

---

## Test-state confirmation

```
Test Files: 1 failed | 111 passed | 3 skipped (115)
Tests:      1 failed | 2090 passed | 16 skipped (2107)
Duration:   25.18s
Pre-existing failure: tests/frontends/dashboard-server-static.test.ts > "serves root-level static assets from dashboard-v2 dist"
```

This is **exactly** the v0.4.4 baseline. No drift. The single failure is the dashboard-v2 static-asset test that has reproduced on every revision since v0.4.3 (per CHANGELOG.md note for both v0.4.3 and v0.4.4). No coverage tool is wired in `vitest.config.ts`; I skipped the optional coverage run.

`npx tsc --noEmit` — exit 0, clean.

---

## Out-of-scope notes

- **Did not audit:** chaos engine, autopilot probes scheduler, migration adapter internals, MCP frontend, k8s adapter internals, dashboard React frontend (only the server). The scope kept me on the autonomous-remediation hot path.
- **Did not run:** `npx vitest run --coverage` — no coverage config is present in `vitest.config.ts` and the brief said "skip if not configured".
- **Did not commit any fix.** None of the findings cross the CRITICAL threshold given live state (`shadow_mode=ON`). If shadow_mode is flipped OFF before findings #1 and #2 are addressed, I would recommend reclassifying both to CRITICAL and committing minimal fixes (timeout wrappers for #2; a `(plan_id, request_id)` key for the decisions map for #1) prior to the flip.
- **Stashed pre-existing changes.** When the audit started, branch `audit/security-injection-secrets-2026-05-14` had uncommitted edits to `src/providers/proxmox/adapter.ts` and `client.ts` from a prior parallel audit. I stashed them (`stash@{0}` with message `audit-security-injection-2026-05-14-uncommitted`) before creating the new branch so no work was lost. The stash is recoverable via `git stash pop` on the original branch.

---

## Bottom line

Run RHODES overnight with `shadow_mode=ON` (the actual current state) — safe. Tier-2+ writes are blocked at the executor and the worst this audit can imagine is a wedged LLM call that fails to plan a heal; the cluster keeps observing.

Do **not** flip `shadow_mode=OFF` tonight without first patching at least finding #1 (per-step approval shadow) and ideally #2 (timeouts). Both have minimal-risk fixes (~50 lines each). The other findings are real but tolerable.
