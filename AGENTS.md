# AGENTS.md

This repository is designed to work well with coding agents such as Codex and Claude. Use this file as the default operating guide before making changes.

## Project Overview

vClaw is an autonomous AI infrastructure agent with multi-provider support (Proxmox, VMware, and more). The backend is a TypeScript Node.js application that plans actions with an LLM, routes them through governance checks, executes tools via provider adapters, observes outcomes, and exposes multiple frontends.

Primary runtime modes:

- `cli`: interactive or one-shot terminal frontend
- `telegram`: Telegram bot frontend
- `dashboard`: HTTP + SSE dashboard server
- `mcp`: MCP server for tool-based AI integration
- `autopilot`: continuous monitoring loop
- `full`: dashboard + telegram + autopilot together

## Important Directories

- `src/index.ts`: main entrypoint and mode bootstrap
- `src/agent/`: planner, executor, observer, LLM abstraction, memory
- `src/governance/`: policy loading, action classification, approvals, audit, circuit breaker
- `src/providers/`: provider abstraction layer
- `src/providers/types.ts`: InfraAdapter interface and shared types
- `src/providers/registry.ts`: tool registry and multi-provider routing
- `src/providers/proxmox/`: Proxmox adapter and REST client
- `src/providers/system/`: SSH/local/system tools
- `src/tools/`: backwards-compatible re-exports (use `src/providers/` for new work)
- `src/migration/`: cross-provider VM migration (VMware ↔ Proxmox)
- `src/healing/`: incident management, playbooks, healing orchestrator
- `src/monitoring/`: health metric collection and anomaly detection
- `src/chaos/`: chaos simulation and execution
- `src/frontends/`: CLI, Telegram, MCP, backend dashboard server
- `dashboard-v2/`: React + Vite dashboard frontend
- `policies/default.yaml`: default governance policy
- `tests/`: vitest test suite
- `data/`: runtime persistence for audit and healing state

## Working Rules For Agents

- Read the relevant module before editing it. This repo has shared concepts across agent, governance, healing, and dashboard code.
- Prefer editing `src/` and `dashboard-v2/src/`. Do not hand-edit `dist/`; it is build output.
- Keep governance behavior explicit. Any new action path should preserve tiering, approval flow, audit logging, and circuit-breaker behavior.
- Assume provider access may be real. Avoid destructive defaults and do not weaken guardrails casually.
- Preserve existing event emissions when changing execution or healing flows. The dashboard depends on them.
- New providers must implement the `InfraAdapter` interface in `src/providers/types.ts`.
- If adding a new backend capability, consider whether it affects:
  - tool definitions
  - governance classification
  - dashboard API or SSE events
  - incident/healing behavior
- Prefer small, targeted changes over broad rewrites.

## Local Commands

Backend:

- `npm run dev`
- `npm run dev:cli`
- `npm run dev:dashboard`
- `npm run dev:telegram`
- `npm run dev:mcp`
- `npm run dev:autopilot`
- `npm run build`
- `npm run lint`
- `npm test` (vitest)

Dashboard frontend:

- `cd dashboard-v2 && npm run dev`
- `cd dashboard-v2 && npm run build`

## Environment

Important env vars live in `.env.example`:

- Proxmox: `PROXMOX_HOST`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`
- VMware: `VMWARE_HOST`, `VMWARE_USER`, `VMWARE_PASSWORD`, `VMWARE_INSECURE`
- AI: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`
- Dashboard: `DASHBOARD_PORT`
- Autopilot: `AUTOPILOT_ENABLED`, `AUTOPILOT_POLL_INTERVAL_MS`
- Chaos: `CHAOS_PROTECTED_VMIDS`
- Migration: `MIGRATION_ESXI_HOST`, `MIGRATION_ESXI_USER`, `MIGRATION_PROXMOX_HOST`, `MIGRATION_PROXMOX_USER`, `MIGRATION_PROXMOX_NODE`, `MIGRATION_PROXMOX_STORAGE`

The backend supports both `anthropic` and `openai` providers via `src/agent/llm.ts`.

## Dashboard Architecture

The dashboard frontend (`dashboard-v2/`) is a React 19 + Vite 6 app using Zustand for state management. Key patterns:

- **SSE (Server-Sent Events)** for real-time updates. The backend pushes events (`health_check`, `incident`, `healing`, `chaos`, `task`, `governance`) and the frontend consumes them via `EventSource` in `src/store.ts`.
- **Zustand store** (`src/store.ts`) is the single source of truth. Components subscribe to slices of state, not props.
- **Cluster API fallback**: when SSE health events aren't flowing, components fall back to cluster API data (e.g. `useStore(s => s.cluster)`) so the UI still populates.
- **CSS lives in `src/styles/index.css`** with CSS custom properties for theming (`--bg`, `--teal`, `--red`, `--amber`, etc.).
- Components: `Header`, `Topology`, `Resources`, `Nodes`, `Incidents`, `Governance`, `Chaos`, `Migrations`, `EventStream`, `CommandPalette`.
- The gauge SVG pattern uses a `div.gauge-svg > svg` wrapper structure. Do not render `<svg className="gauge-svg">` directly as the CSS expects the div wrapper.

## Provider Architecture

vClaw uses a provider abstraction pattern:

- `InfraAdapter` interface: `connect()`, `disconnect()`, `getTools()`, `execute()`, `getClusterState()`
- `ToolRegistry`: routes tool execution to the correct adapter based on tool→adapter mapping
- Each provider registers its tools with tiers (read, safe_write, risky_write, destructive, never)
- `getMultiClusterState()` aggregates state from all connected providers

## Repo-Specific Notes

- The backend dashboard server serves `dashboard-v2/dist` if it exists; otherwise it falls back to an inline HTML template.
- The default policy accepts `approve_fix` in YAML and normalizes it to `approve_risky` in `src/governance/policy.ts`.
- Test suite: `npm test` runs vitest across `tests/`.
- `ToolRegistry.getClusterState()` returns the first connected adapter's cluster state; `getMultiClusterState()` aggregates all providers.
- The migration engine (`src/migration/`) uses SSH for cross-host file transfer and disk conversion. It requires both providers configured plus migration env vars (`MIGRATION_ESXI_HOST`, etc.).
- The system adapter exposes powerful commands like `local_exec`, `ssh_exec`, and `run_script`; keep these governed and avoid bypassing the normal execution path.

## Preferred Change Workflow

When working on a task:

1. Identify the user-facing entrypoint and the affected subsystem.
2. Read the surrounding code before editing.
3. Make the smallest coherent change.
4. Run the narrowest useful verification command.
5. Summarize what changed, what was verified, and any remaining risks.

## Commit Messages

Always append a co-author trailer to commit messages so GitHub shows proper attribution:

- **Codex**: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- **Claude**: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

## Good Defaults For Codex And Claude

- Be explicit about assumptions.
- Call out infra risk before changing behavior that could affect live systems.
- Do not revert unrelated local changes.
- If a change touches runtime behavior, mention which mode(s) it affects.
- If a change adds or alters events, API shapes, or tool names, document that clearly in the final summary.
