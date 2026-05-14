# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security / Correctness

- **HIGH: Per-step approval gates now scope decisions by `(plan_id, step_id)`** (`feature/per-step-approval-scope`). Closes correctness audit HIGH #1 and security audit H-1 from 2026-05-14: the v0.4.5 `ApprovalGate.decisions` map was keyed only by `plan_id`, so a plan-level approval auto-resolved every later per-step `requestApproval` against the same plan — defeating `policy.orchestration.approval.explicit_tiers`. The 11-step esxi-01 save from 2026-05-13 had a deliberate "approval checkpoint" before the destructive `delete_snapshot` step; under v0.4.5 that gate would have been silently auto-approved by the plan-level decision. **BREAKING (semantics, protocol minor bump):** per-step destructive gates now require their own operator confirmation. `POST /api/agent/approve` accepts an optional `step_id` field to target a specific gate; `awaiting_approval` / `plan_approved` / `plan_rejected` SSE events carry `step_id` when the gate is per-step. The dashboard panel renders per-step gates as separate cards (own `data-step-id` attribute, "step <id>" badge); the `?plan=<id>` deep-link still works and now optionally accepts `&step=<step_id>` for multi-gate plans. Plan-id-only API calls remain backward compatible — a missing `step_id` resolves the plan-level entry as before. +9 governance tests (1 dashboard SSE, 8 unit + dashboard integration). Also fixes correctness MEDIUM #3 as a side effect: two sequential per-step gates against the same plan no longer collide in `pendingResolvers`.

## [0.4.5] - 2026-05-14

### Security

- **CRITICAL: Dashboard server now binds to `127.0.0.1` by default** (was `0.0.0.0`). Opt into network exposure with `RHODES_DASHBOARD_HOST=0.0.0.0` (or a specific interface). Loud warning logged when the binding is non-loopback. Before this fix, anyone on the same LAN or tailnet could `POST /api/agent/command`, `/api/agent/approve`, `/api/chaos/execute`, `/api/migration/execute` without authentication.
- **CRITICAL: `Access-Control-Allow-Origin: *` is only emitted for `GET` / `OPTIONS`, not for mutating methods.** Cross-origin POST / DELETE were a real CSRF vector — any webpage the operator visited could trigger destructive RHODES actions. Browser now blocks the cross-origin mutations as intended.

### Added

- **Planner hard rule: typed Proxmox lifecycle tools over `ssh_exec qm`** (`feature/planner-prefer-pve-api`). New rule #11 in `src/agent/prompts.ts`, modeled on the v0.2.2 AWS-instance-ID hard rule. Captures the actual failure mode from the 2026-05-14 esxi-01 save: planner picked `ssh_exec qm resume 200`, hit exit 255 from the unconfigured SSH path on the NUC. Now the LLM sees the steer both at prompt-construction time and inline in the tool description. Two new typed tools (`suspend_vm` safe_write, `reset_vm` risky_write) close gaps in the Proxmox adapter; the other four lifecycle tools (`resume_vm`, `start_vm`, `stop_vm`, `reboot_vm`, `shutdown_vm`) had their descriptions rewritten to say *"Prefer this over `ssh_exec qm <verb>`"*. Anti-regression test asserts each of the six descriptions still contains `ssh_exec` — rewording back to a stub trips the suite. +3 prompt-rule tests, +3 adapter tests.
- **Telegram approval-pending deep links** (`feature/telegram-approval-deep-link`). When `RHODES_DASHBOARD_URL` is set, every approval-pending Supra/Telegram notification carries `Approve at: <DASHBOARD_URL>/?plan=<urlEncoded(plan_id)>`. The dashboard reads `?plan=<id>` on every Pending Approvals re-render: scrolls the matching card into view, pulses a 2s Rhodes-Blue ring around it, falls back to a toast (`Plan <id> has been <state>`) if the plan was already decided by the time the deep link is tapped. The card-already-renders-data-plan-id attribute from v0.4.4 needed no DOM changes; only the URL path shape changed (was `/plans/<id>`, now `?plan=<id>`). +7 notification-format tests.
- **NUC → pranavlab SSH key bootstrap** (`feature/nuc-ssh-key-runbook`). ed25519 key generated on the NUC at `~/.ssh/rhodes-pranavlab` (mode 600); `~/.config/rhodes/ssh-targets.json` defines the `pranavlab` target with `sudo_allowlist=[systemctl, journalctl, qm]` and tier overrides; `RHODES_SSH_TARGETS_FILE` appended to `~/rhodes/.env`. Operator runbook at `docs/runbooks/nuc-ssh-to-pranavlab-bootstrap.md` (three install paths for the public key, smoke-test instructions, dashboard verification). `scripts/test-ssh-to-pranavlab.ts` smoke-test with distinct exit codes for "no target registered" / "auth failed" / "command failed". Operator still needs to install the public key on pranavlab + restart RHODES — service was deliberately not restarted by the swarm to preserve the live `current_plan` state.

### Audits

- **`docs/audits/security-2026-05-14.md`** — comprehensive injection / secrets / governance-bypass audit. 2 CRITICAL findings (fixed above). 3 HIGH documented: dashboard has zero authentication (loopback narrows blast radius but doesn't close it); `SystemAdapter.configureService` shell-interpolates without going through the SSH safety classifier; `ChaosEngine.execute` checks `requires_approval && risk_score > 70` but only updates a string instead of gating execution. 4 MEDIUM documented. Confirmed clean: zero SQL injection (`better-sqlite3` parameterized bindings throughout), no hardcoded credentials, no identity-file logging, MCP server is stdio-only. 9 transitive dependency CVEs flagged for `npm audit fix` hygiene.
- **`docs/audits/correctness-2026-05-14.md`** — error-handling / race-condition / test-gap audit. 0 CRITICAL under the actual live state. 2 HIGH: `src/governance/approval.ts` keys decisions by `plan_id` only (prior plan-level approval auto-resolves later per-step `requestApproval` on the same plan, defeats `policy.explicit_tiers`); no LLM-call timeout (hung Anthropic/OpenAI call wedges `agentCore.run` for up to 10 min). 4 MEDIUM: SSE backpressure ignored, restart-loop guard in-memory only, **trigger collision between `jellyfin-service-probe` and `vm_in_guest_diagnostic`** (both match `service_http_status / state_change / critical`, only one fires per anomaly — the v0.4.4 release notes were wrong about auto-chaining), `setInterval` tick overlap. Both audits state the codebase is safe to keep running overnight under the apparently-current `shadow_mode: true` live state. Fixes for the HIGH findings are queued for v0.4.6 before the next shadow-off run.

### Notes

- Total tests: **2101 passing** (up from 2090 in v0.4.4, +11 net — security audit + planner agent both added tests).
- Same pre-existing failure in `tests/frontends/dashboard-server-static.test.ts` (root-level static asset serving), unrelated to this release.
- No new npm dependencies.
- Five branches merged: `audit/security-injection-secrets-2026-05-14`, `feature/planner-prefer-pve-api`, `feature/telegram-approval-deep-link`, `feature/nuc-ssh-key-runbook`, `audit/correctness-quality-2026-05-14`.
- Audit-process artifact: two stashes left by the security audit are preserved (`stash@{1}` and `stash@{2}`) and recoverable. Safe to drop after a smoke-test of the merged code.
- Customer-voice release notes at [docs/releases/v0.4.5.md](docs/releases/v0.4.5.md).

## [0.4.4] - 2026-05-13

### Added

- **Pending Approvals dashboard panel** (`feature/dashboard-approval-remediate`). New section above the tab bar, hidden when empty. Renders each plan from `/api/agent/pending-approvals` as a card with action (JetBrains Mono), tier-colored badge (read/safe_write/risky_write/destructive), agent reasoning, a key:value params grid, and Approve/Reject buttons that POST to `/api/agent/approve`. Live via the existing `awaiting_approval` / `plan_approved` / `plan_rejected` SSE events plus a 10s catch-up poll. Plan steps whose `params.snapname` (or sibling fields) match `rhodes-safety-*` render with a 🛡️ "SAFETY SNAPSHOT" badge and a green border instead of teal, distinguishing the v0.4.3 retention-floor pre-snapshot step from destructive deletes at a glance.
- **Remediate button on incident cards.** Open / healing incidents (not "recent" / resolved) gain a small Rhodes-Blue pill in the card header. Click templates a natural-language prompt from the incident's `metric` + `labels` and POSTs to `/api/agent/command`, kicking the agent to plan a recovery. Button disables to "Planning…" during the call; on success it replaces itself with "Plan requested — check Pending Approvals above". Failures pop a red error toast and re-enable the button. Mappings: `vm_status` + `paused_io_error` → storage-pause prompt; `vm_status` other → generic VM anomaly prompt; `service_http_status` → in-VM diagnostic prompt; otherwise → generic anomaly prompt.
- **`vm_in_guest_diagnostic` playbook registered** (`feature/healing-recovery-and-wiring`). The v0.4.3 in-VM diagnostic module (`src/playbooks/vm-diagnostic.ts`) is now wired into `src/healing/playbooks.ts` as an auto-firing rule. Trigger: `metric: service_http_status, type: state_change, severity: critical` (no label filter). `cooldown_minutes: 15`, `requires_approval: true`, `max_retries: 1`. Positioned immediately after `jellyfin-service-probe` so the natural chain is service-probe-restart-fails → vm-diagnostic-fires. Registry count: 8 → 9.

### Fixed

- **State-change incidents on `vm_status` now auto-resolve when the VM returns to a healthy state.** `resolveRecoveredIncidents` in `src/healing/incident-coordinator.ts` had a real bug: boot-eval-synthesized incidents (the Agent G fix from v0.4.2) used the numeric-threshold recovery path (`latest.value < trigger_value * 0.7`), which is meaningless for state_change markers (value is always 1). New path: when `incident.metric === "vm_status"` and `incident.labels.reason` is one of `{paused_io_error, paused_other, locked, error}`, RHODES scans `store.getAllLatest("vm_status")` filtered by `vmid+node` (cannot use `getLatest` because the recovered sample has a different series-key — no `reason` label, different `runtime_status`); if any current series shows `runtime_status ∈ {running, ok}`, the incident resolves with `"VM <name> state recovered: <before> → <after>"` and emits `AlertResolved`. The numeric path is intact for non-state-change metrics. Two new tests cover the positive and negative cases.
- **Boot-eval → playbook firing verified end-to-end.** The pipeline was already symmetric (boot-eval anomalies flow through the same `executor.handleAnomaly` → `playbookEngine.match(anomaly)` path as real transitions, via `HealingEngine.tick()`), but no test asserted it. The yesterday miss (two paused VMs caught at boot but no pending-approvals visible) was UX-side, not engine-side — the dashboard had nowhere to render the pending plans. New test `tests/healing/healing-engine-boot-eval.test.ts` seeds a paused_io_error sample, calls `engine.tick()`, asserts `PlaybookMatched` fires with `proxmox_storage_exhaustion_pause`, `HealingEscalated` fires (approval required), and an open incident is created. Plus a dedup test that confirms the boot-eval pass doesn't re-fire on subsequent ticks.

### Notes

- Total tests: **2090 passing** (up from 2084 in v0.4.3). +6 from healing fixes.
- One pre-existing failure in `tests/frontends/dashboard-server-static.test.ts` continues to reproduce on every revision; tracked separately, unrelated to this release.
- No new npm dependencies. No server-side endpoint additions — the dashboard wiring reuses `/api/agent/pending-approvals`, `/api/agent/approve`, and `/api/agent/command`, all of which shipped in v0.4.2.
- Customer-voice release notes at [docs/releases/v0.4.4.md](docs/releases/v0.4.4.md). Demo storyboard for the next video at `/home/pranav/rhodes-video/RHODES Esxi Save/design.md`.

## [0.4.3] - 2026-05-13

### Added

- **SSH per-target tier overrides + audit-trail emission** (`swarm4/ssh-polish`). `SshTarget.tier_overrides` accepts `default` (a floor that bumps low-risk commands up) and `commands` (a per-tag/per-command map that can raise OR lower the classifier verdict). `never` is never overridable. The classification result carries `base_tier` + `override` keys so audit logs can show what fired. Adapter emits an `SshExec` AgentEvent on every invocation.
- **Sudo-fallback ladder for SSH** (`feature/ssh-sudo-ladder`). New `runSshCommandWithSudoFallback` retries with `sudo -n <cmd>` when the original invocation fails with a permission-denied / operation-not-permitted / must-be-root / sudo-needs-password pattern AND the leading verb is in the target's `sudo_allowlist`. If the sudo'd version classifies as a higher tier than the unprivileged form, the ladder REFUSES the retry and returns `requiresApproval: true` — the caller's governance approval was for the lower tier only. Classifier now strips one leading `sudo` / `sudo -n` so allowlisted reads stay at the read tier. New `ufw allow|deny|delete|reload|enable|disable` rule (risky_write).
- **`SshSudoPolicy` config schema** — per-target NOPASSWD verb allowlist threaded from env-file JSON through `SshTargetSchema` to the adapter normalizer.
- **Snapshot retention floor** in the Proxmox storage-pause playbook (`feature/snapshot-retention`). `filterDeletableCandidates` excludes the newest non-`current` snapshot; with only one snapshot in scope, the plan is empty. Entries without `created_at` are treated as oldest for safety. Opt-in via `apply_retention_floor` so the thin-pool monitor's pure-observation mode is unchanged.
- **Pre-remediation safety snapshot.** `buildRemediationPlan` now prepends a `qm snapshot <vmid> rhodes-safety-<ISO>` step (Tier 2 safe_write) before any delete and appends a cleanup step for the *previous* `rhodes-safety-*` snap. Cleanup runs ONLY after a successful resume + verify; on failed resume, the prior safety snap is preserved. `validateRemediationCandidate` hard-rules deletion of `rhodes-safety-*` snaps unless invoked via the exact-name cleanup path. New executor method `qmTakeSnapshot(node, vmid, name, description?)`. New `RemediationStepKind` discriminator on plan steps.
- **In-VM diagnostic playbook** (`src/playbooks/vm-diagnostic.ts`, `feature/vm-diagnostic-playbook`). Pure decision module + `VmDiagnosticExecutor` interface mirroring the storage-pause architecture. Gather phase runs nine commands in parallel over SSH (`df -h`, `free -h`, `uptime`, `systemctl --failed`, `journalctl --since=10min -p err` system-wide + per-unit, `dmesg -T --level=err,crit,alert,emerg`, `ss -tlnp`, `systemctl status <service>`). Nine deterministic parsers reduce outputs to typed structs. Classifier produces a priority-ordered set of ten failure modes: `IO_ERROR > DISK_FULL > MEMORY_OOM > BOOT_LOOP > SERVICE_CRASHED > SERVICE_NOT_LISTENING > KERNEL_ERROR > DISK_PRESSURE > MEMORY_PRESSURE > UNDETERMINED`. Planner emits tier-classified remediation steps per mode (`journalctl --vacuum-size=500M`, `apt-get clean`, `systemctl restart`, etc.) with explicit operator-only escalations for BOOT_LOOP, KERNEL_ERROR, and DISK_FULL on `/` or unknown mounts. IO_ERROR signals are reported to the caller for cross-playbook handoff to storage-pause rather than auto-executed. End-to-end runner re-probes the app between steps and stops early on recovery.

### Fixed

- Classifier-leading-sudo regression — `sudo -n df` previously fell through to the fail-closed destructive default because the read rules anchor at start-of-string. Strip is bounded to one level so `sudo sudo rm -rf /` still classifies destructive.

### Notes

- Total tests: **2084 passing** (up from 1922 in v0.4.2). One pre-existing failure in `tests/frontends/dashboard-server-static.test.ts` (root-level static asset serving) reproduces on `main` prior to this release and is unrelated.
- No breaking API changes. `SshExecResult` shape is unchanged — the wider `SshExecWithEscalationResult` is returned by the new ladder function; `ssh_exec` adapter wrapping preserves backward compatibility.
- The vm-diagnostic playbook is registered in `src/playbooks/` but is not yet wired into `src/healing/playbooks.ts` as an auto-firing rule — operators can invoke it programmatically. Wiring into the healing orchestrator is queued for a follow-up so the service-http-probe → vm-diagnostic chain becomes automatic.

## [0.3.0] - 2026-05-11

### Changed

- **Renamed to RHODES** — Reasoning, Hybrid Orchestration, Deployment & Execution System. Tagline: "Infrastructure, executed." The product, package, CLI binary, systemd unit, banner, prompt prefix, help layout, and product copy are all rebranded. Historical changelog entries below retain the legacy "vClaw" name for accuracy.
- **CLI invocation:** `rhodes` (with alias `rho`). The legacy `vclaw` command is retained as a temporary alias and prints a one-line deprecation notice on invocation.
- **Prompt prefix:** `rhodes@mission:~$`.
- **Welcome banner:** ASCII wordmark + subtitle "Reasoning, Hybrid Orchestration, Deployment & Execution System".
- **Help layout** now follows the brand bible's OPERATIONS / PROVIDERS / WORKSPACES structure.
- **Config files:** primary workspace config is now `.rhodes.yaml`; per-user env at `~/.rhodes/.env`. `.vclaw.yaml` and `~/.vclaw/.env` continue to work but emit a deprecation warning encouraging rename.
- **Environment variables** renamed `VCLAW_*` → `RHODES_*` (e.g. `RHODES_SSH_TARGETS_FILE`, `RHODES_VAULT_KEY`, `RHODES_SLO_P95_LATENCY_MS`). Legacy `VCLAW_*` names continue to work as fallbacks.
- **Systemd unit** renamed `vclaw.service` → `rhodes.service`.
- **Internal defaults** renamed: S3 prefix `vclaw-migration/` → `rhodes-migration/`; scratch dir `/tmp/vclaw-migration` → `/tmp/rhodes-migration`; default Azure resource group `vclaw-migrations` → `rhodes-migrations`; provisioning default username `vclaw` → `rhodes`; MCP server name `vclaw` → `rhodes`; MCP URI scheme `vclaw://` → `rhodes://`.
- **Voice update**: success/error messages aligned with the brand bible (direct, technical, calm).

### Notes

- Dashboards under `dashboard/` and `dashboard-v2/` are tracked for a separate rebrand pass and are not changed in this release. The embedded `src/frontends/dashboard/template.ts` retains a small number of legacy "vClaw" strings pending that follow-up. The static logo asset `vclaw-logo.png` is left in place to avoid breaking dashboard builds.
- No changes to provider tool surface, agent core behavior, governance, or migration semantics. This release is rebrand only.

## [0.2.4] - 2026-05-07

### Fixed

- **Planner now tolerates LLM responses wrapped in markdown fences.** Models frequently emit ```` ```json ... ``` ```` even when the prompt forbids them — the parser now strips fences (with or without language tag) and falls back to slicing the first `{` to last `}` if prose surrounds the JSON object. Previously this surfaced as `Failed to parse LLM plan response as JSON` and aborted the whole goal.
- 3 new tests covering `​```json` fences, bare `​```` fences, and prose-before-JSON cases.

### Notes

- Total tests: 1777 passing.

## [0.2.3] - 2026-05-07

### Added

- **Step-reference resolver** (`src/agent/step-references.ts`) — multi-step plans can now thread output between steps using `${step_X.field}` syntax. Supports nested paths, array indices (`${step_2.vms[0].id}`), whole-step references (`${step_3}`), and preserves native types when the entire param value is a single placeholder. Resolves at orchestration time, before each step's params hit the executor.
- 14 unit tests covering happy paths, deeply-nested resolution, replan IDs (`step_r1`), and every error path (unknown step, failed dependency, primitive descent, missing field) — error messages are deliberately verbose so the next replan can self-correct.
- Planner prompt updated with **hard rules** for the LLM:
  - Use `${step_X.field}` to chain outputs; do NOT invent placeholder IDs.
  - AWS instance IDs are `i-` + 17 hex chars; never construct `i-<name>`.
  - Omit `subnet_id` on `aws_launch_instance` to use the default VPC's first subnet.

### Fixed

- Multi-step plans that reference prior step outputs no longer fail with "Invalid id: '${step_1.instance_id}'". The literal placeholder string is now resolved to the actual prior-step value before the tool call fires.

### Notes

- Total tests: 1774 passing (+14 from the resolver suite).

## [0.2.2] - 2026-05-07

### Fixed

- **AWS `launch_instance` no longer fails on hallucinated subnet IDs.** When `subnet_id` is omitted, the AWS client now auto-discovers the default VPC's first subnet and uses it. The `aws_launch_instance` tool description was hardened so the planner stops emitting placeholders like `subnet-12345678`. Clear error message surfaced when no default VPC exists.
- **Replan no longer crashes with "Step depends on unknown step".** When the LLM emits a replan whose `depends_on` references step IDs from the previous plan revision, those stale references are now stripped before dependency-graph validation. Replan recovery actually works end-to-end.

### Notes

- Total tests: 1760 passing (+2 covering the AWS auto-discovery + no-default-VPC paths).

## [0.2.1] - 2026-05-07

### Added

- **Cost adapter** (`src/providers/cost/`) — service adapter exposing three new tools the planner calls automatically when a goal mentions cost, budget, or migration:
  - `estimate_vm_cost` — workload + provider → monthly $ with compute / storage / license breakdown
  - `estimate_migration_cost` — source/target spec → delta, one-time cost, payback period, and a recommendation string
  - `compare_providers` — same workload across AWS, Azure, Proxmox, vSphere, ranked cheapest → most expensive
- Pricing tables for AWS (T3/M5/C5/R5), Azure (B/Dsv3/Esv3), Proxmox (TCO baseline), vSphere (TCO + Broadcom per-vCPU license at $11.25/mo).
- `.env` discovery — `vclaw` now finds its config from `$VCLAW_ENV_FILE`, then `./.env`, then `~/.vclaw/.env`, then the install dir. Run `vclaw` from anywhere; it just works.
- Claude Code / Codex-style interactive banner — `▌ vClaw` headline in brand orange, tagline beneath, version + provider + tool counts, `cwd:` line.
- Brand-orange `›` prompt replaces the cyan `vclaw>` prompt.
- Curated formatters for `get_vm_config`, `get_vm_status`, and the three cost tools — replaces raw object dumps with two-line scannable summaries. Long planner reasoning blocks truncated to 160 chars with a `(/plan for full)` hint.
- 25 new unit tests for the cost adapter.

### Fixed

- Suppressed Node.js DEP0040 punycode deprecation warnings emitted by transitive deps — they were interleaving with readline input and corrupting slash commands.
- Old "InfraWrap" ASCII banner that had been left over from the upstream port now correctly reads "vClaw".

### Notes

- Total tests: 1758 passing (up from 1338 in 0.2.0).
- No breaking API changes. `vclaw cli` and `vclaw` (no args) both drop into the new banner.

## [0.2.0] - 2026-04-30

### Added

- Azure provider support using ARM SDK clients for Compute, Network, and Resources.
- Azure quickstart coverage in `docs/quickstart.md` (service principal bootstrap + required env vars).
- README setup examples now include Azure credentials and dashboard-v2 context.
- Proxmox -> Azure end-to-end execute path (`migrate_proxmox_to_azure`) with rollback cleanup for VM/disk/blob resources.
- Cloud uploader migration path that streams disk bytes over SSH through vClaw into AWS S3 / Azure page blobs (no `aws` / `az` CLI required on source hosts).

### Changed

- Dashboard server now serves the redesigned `dashboard-v2/dist` frontend by default.
- Dashboard screenshots in `docs/screenshots/topology.png` and `docs/screenshots/resources.png` were refreshed for dashboard-v2.
- Cross-provider migration coverage now includes executed Proxmox -> Azure runs plus AWS/VMware/Proxmox flows.
- AWS importer now prefers ImportSnapshot for raw-disk paths, registers AMIs with HVM/ENA/UEFI-preferred defaults, and keeps ImportImage fallback.
- Multipart upload tuning for migration artifacts (`queueSize=8`, `partSize=64 MiB`) improves large-disk ingest throughput.
- Agent reliability updates: planner schema validation (Zod) and executor retry/backoff/limit controls.
- Verified release test baseline at `1338 passed / 20 skipped` (`npm test -- --run` on 2026-04-19).

### Testing

- Added 65 AWS tests across `tests/providers/aws-adapter.test.ts` and `tests/providers/aws-client.test.ts`.
- Added 58 Azure tests across `tests/providers/azure-adapter.test.ts` and `tests/providers/azure-client.test.ts`.
- Added targeted migration tests: `tests/migration/cloud-uploader.test.ts`, `tests/migration/azure-workload-analyzer.test.ts`, `tests/migration/adapter-azure-routes.test.ts`, `tests/migration/aws-importer.test.ts`.
- Added dashboard migration-progress coverage in `tests/frontends/dashboard-v2-migration-progress.test.ts`.

### Fixed

- Fixed flaky monitoring date-window behavior in `tests/monitoring/run-telemetry.test.ts` by aligning timer control in test setup.
