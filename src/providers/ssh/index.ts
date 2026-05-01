// ============================================================
// vClaw — SSH Adapter exports
// ============================================================

export { SshAdapter } from "./adapter.js";
export type { SshEventEmitter, SshGovernanceEvaluator } from "./adapter.js";
export { applyTierOverrides, classifyCommand } from "./safety.js";
export { runRemoteCommand, buildSshArgs } from "./client.js";
export type { SpawnFn, SpawnedProcess, RunCommandOptions } from "./client.js";
export type {
  SshAdapterOptions,
  SshClassification,
  SshExecRequest,
  SshExecResult,
  SshTarget,
  SshTierOverrides,
} from "./types.js";

import type { ToolDefinition } from "../types.js";

/**
 * Static tool definitions for the SSH adapter. The adapter instance
 * still owns the canonical list (returned from getTools()), but this
 * export lets non-runtime call sites (docs generators, the agent's
 * tool-discovery harness) introspect the surface without booting an
 * adapter.
 */
export const sshTools: ToolDefinition[] = [
  {
    name: "ssh_exec",
    description: "Execute a shell command on a registered SSH target.",
    tier: "risky_write",
    adapter: "ssh",
    params: [
      { name: "target_id", type: "string", required: true, description: "Id of a registered SSH target." },
      { name: "command", type: "string", required: true, description: "The shell command to run." },
      { name: "timeout_s", type: "number", required: false, description: "Per-call timeout override." },
    ],
    returns: "SshExecResult",
  },
  {
    name: "ssh_list_targets",
    description: "List all configured SSH targets.",
    tier: "read",
    adapter: "ssh",
    params: [],
    returns: "SshTarget[]",
  },
  {
    name: "ssh_dry_run",
    description: "Classify a shell command without executing it.",
    tier: "read",
    adapter: "ssh",
    params: [
      { name: "command", type: "string", required: true, description: "The command to classify." },
      { name: "target_id", type: "string", required: false, description: "Optional target id — when set, per-target tier_overrides are applied." },
    ],
    returns: "SshClassification",
  },
];
