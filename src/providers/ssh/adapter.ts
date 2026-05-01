// ============================================================
// vClaw — SSH Adapter
//
// First-class shell-execution surface against a registry of named
// SSH targets. Every command flows through the safety classifier
// and (in production) the GovernanceEngine before being dispatched
// to the SSH client.
//
// Discriminator: "service" — this adapter does NOT own cluster state
// (no nodes, VMs, or storage). It's a utility surface, alongside
// system/migration/topology/provisioning.
// ============================================================

import type {
  AdapterKind,
  ClusterState,
  InfraAdapter,
  ToolCallResult,
  ToolDefinition,
} from "../types.js";
import type {
  SshAdapterOptions,
  SshClassification,
  SshExecResult,
  SshTarget,
} from "./types.js";
import type { SpawnFn } from "./client.js";
import { runRemoteCommand } from "./client.js";
import { applyTierOverrides, classifyCommand } from "./safety.js";
import { AgentEventType, type AgentEvent } from "../../types.js";

/**
 * Minimal event-bus surface the SSH adapter depends on. Avoids a
 * circular import on the concrete `EventBus` class — anything with an
 * `emit(AgentEvent)` will satisfy us (real EventBus, test fakes, etc.).
 */
export interface SshEventEmitter {
  emit(event: AgentEvent): void;
}

// ── Governance hook ──────────────────────────────────────────
//
// The adapter is constructed with an optional `governanceEvaluator`.
// The real GovernanceEngine.evaluate() lives in src/governance/index.ts
// and depends on a PolicyConfig + AgentMode that the *agent* owns —
// not the adapter. To keep the adapter testable in isolation we
// inject a thin function that returns approval. In production this
// is wired up by the agent (see src/agent/executor.ts integration
// in a future iteration); for now the adapter still classifies and
// surfaces tier in the result so the executor's existing governance
// path picks it up (the executor calls the same classifyAction()).
//
// CRITICAL CONSTRAINT: even with the kill-switch on, destructive
// commands MUST still be approved per-call. The kill-switch only
// permits them to be PROPOSED at all.

export type SshGovernanceEvaluator = (
  classification: SshClassification,
  request: { target_id: string; command: string },
) => Promise<{ allowed: boolean; reason: string }>;

// ── Tool definitions ────────────────────────────────────────

const ADAPTER_NAME = "ssh";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object",
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

// We register the *base* tier of `ssh_exec` as `risky_write` so the
// agent's standard tool-list view conveys "this is not free". The
// runtime tier is decided per-call by the safety classifier and can
// elevate all the way to `destructive`.
const TOOL_DEFINITIONS: ToolDefinition[] = [
  tool(
    "ssh_exec",
    "Execute a shell command on a registered SSH target. The command is classified by the SSH safety classifier and run through governance. Read-only commands auto-approve under most modes; risky/destructive commands require human approval. Output is capped at the configured byte limit.",
    "risky_write",
    [
      { name: "target_id", type: "string", required: true, description: "Id of a registered SSH target (see ssh_list_targets)." },
      { name: "command", type: "string", required: true, description: "The exact shell command to run on the remote host. No shell metacharacters allowed for safe tiers." },
      { name: "timeout_s", type: "number", required: false, description: "Override the per-call timeout in seconds." },
    ],
    "SshExecResult",
  ),
  tool(
    "ssh_list_targets",
    "List all configured SSH targets with their (non-secret) connection details. Used by the agent to discover what hosts it can shell into.",
    "read",
    [],
    "SshTarget[]",
  ),
  tool(
    "ssh_dry_run",
    "Classify a shell command without executing it. Returns the inferred governance tier and the reason. Use this BEFORE ssh_exec so the agent can plan around the safety budget. If target_id is supplied, per-target tier overrides are applied so the result reflects the actual tier the same command would run at on that host.",
    "read",
    [
      { name: "command", type: "string", required: true, description: "The command to classify." },
      { name: "target_id", type: "string", required: false, description: "Optional target id — when set, per-target tier_overrides are applied to the result." },
    ],
    "SshClassification",
  ),
];

// ── Adapter ──────────────────────────────────────────────────

export class SshAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  readonly kind: AdapterKind = "service";

  private connected = false;
  private readonly targets: Map<string, SshTarget>;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutS: number;
  private readonly allowDestructive: boolean;
  private readonly strictHostKeyChecking: boolean;
  private readonly governanceEvaluator: SshGovernanceEvaluator | undefined;
  /** Test seam — let test inject a fake child_process.spawn. */
  private readonly spawnFn: SpawnFn | undefined;
  /**
   * Optional event-bus sink for the audit-trail integration. When set,
   * every `ssh_exec` invocation emits a single `AgentEventType.SshExec`
   * event covering target id, command, classifier tier, dry-run flag,
   * and (if executed) exit code + duration. See `emitAuditEvent` below.
   */
  private readonly eventBus: SshEventEmitter | undefined;

  constructor(
    options: SshAdapterOptions,
    deps: {
      governanceEvaluator?: SshGovernanceEvaluator;
      spawnFn?: SpawnFn;
      eventBus?: SshEventEmitter;
    } = {},
  ) {
    this.targets = new Map(options.targets.map((t) => [t.id, normalizeTarget(t)]));
    this.maxOutputBytes = options.max_output_bytes ?? 64 * 1024;
    this.defaultTimeoutS = options.default_timeout_s ?? 30;
    this.allowDestructive = options.allow_destructive ?? false;
    this.strictHostKeyChecking = options.strict_host_key_checking ?? true;
    this.governanceEvaluator = deps.governanceEvaluator;
    this.spawnFn = deps.spawnFn;
    this.eventBus = deps.eventBus;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    try {
      switch (toolName) {
        case "ssh_list_targets":
          return { success: true, data: this.listTargets() };
        case "ssh_dry_run":
          return this.dryRun(cleanParams);
        case "ssh_exec":
          return await this.execCommand(cleanParams);
        default:
          return { success: false, error: `Unknown SSH tool: ${toolName}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Service adapter — no cluster state. */
  async getClusterState(): Promise<ClusterState> {
    return {
      adapter: ADAPTER_NAME,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Tool implementations ──────────────────────────────────

  /**
   * Return targets stripped of any sensitive fields (identity_file).
   * Operators or the agent should never see filesystem paths to keys.
   */
  listTargets(): Array<Omit<SshTarget, "identity_file"> & { has_identity_file: boolean }> {
    return Array.from(this.targets.values()).map((t) => ({
      id: t.id,
      host: t.host,
      port: t.port,
      user: t.user,
      jump_host: t.jump_host,
      description: t.description,
      tier_overrides: t.tier_overrides,
      has_identity_file: !!t.identity_file,
    }));
  }

  private dryRun(params: Record<string, unknown>): ToolCallResult {
    const command = params.command as string | undefined;
    const targetId = params.target_id as string | undefined;
    if (typeof command !== "string") {
      return { success: false, error: "command (string) is required" };
    }

    let classification = classifyCommand(command);

    // Per-target overrides — only applied when caller passed a target.
    // Unknown ids are surfaced as an error so the agent doesn't think
    // it dry-ran against a real target when it didn't.
    if (targetId !== undefined) {
      const target = this.targets.get(targetId);
      if (!target) {
        return {
          success: false,
          error: `Unknown SSH target: "${targetId}". Configured targets: ${this.listTargetIds().join(", ") || "(none)"}.`,
        };
      }
      classification = applyTierOverrides(classification, command, target.tier_overrides);
    }

    this.emitAuditEvent({
      target_id: targetId,
      command,
      classification,
      dry_run: true,
    });

    return { success: true, data: classification };
  }

  private async execCommand(params: Record<string, unknown>): Promise<ToolCallResult> {
    const targetId = params.target_id as string | undefined;
    const command = params.command as string | undefined;
    const timeoutOverride = params.timeout_s as number | undefined;

    if (!targetId || typeof targetId !== "string") {
      return { success: false, error: "target_id (string) is required" };
    }
    if (!command || typeof command !== "string") {
      return { success: false, error: "command (string) is required" };
    }

    const target = this.targets.get(targetId);
    if (!target) {
      return {
        success: false,
        error: `Unknown SSH target: "${targetId}". Configured targets: ${this.listTargetIds().join(", ") || "(none)"}.`,
      };
    }

    // 1. Classify, then apply per-target tier overrides.
    const classification = applyTierOverrides(
      classifyCommand(command),
      command,
      target.tier_overrides,
    );

    // 2. Forbidden tier — never executes, no approval flow.
    if (classification.tier === "never") {
      const refusal = `Command refused: ${classification.reason}`;
      this.emitAuditEvent({
        target_id: targetId,
        command,
        classification,
        dry_run: false,
        outcome: "refused",
        error: refusal,
      });
      return {
        success: false,
        error: refusal,
        data: { classification },
      };
    }

    // 3. Kill-switch for destructive — refuse outright unless enabled.
    if (classification.tier === "destructive" && !this.allowDestructive) {
      const refusal =
        `Command classified as destructive (${classification.match}) ` +
        `and ssh.allow_destructive is false. Enable the kill-switch in config to allow ` +
        `destructive commands to be PROPOSED — they still require explicit per-call approval.`;
      this.emitAuditEvent({
        target_id: targetId,
        command,
        classification,
        dry_run: false,
        outcome: "refused",
        error: refusal,
      });
      return {
        success: false,
        error: refusal,
        data: { classification },
      };
    }

    // 4. Governance gate. If no evaluator was injected we trust the
    //    surrounding executor (which calls classifyAction on the tool
    //    metadata) — but we always surface the tier so audit logs are
    //    accurate.
    if (this.governanceEvaluator) {
      const decision = await this.governanceEvaluator(classification, {
        target_id: targetId,
        command,
      });
      if (!decision.allowed) {
        const denial = `Governance denied: ${decision.reason}`;
        this.emitAuditEvent({
          target_id: targetId,
          command,
          classification,
          dry_run: false,
          outcome: "denied",
          error: denial,
        });
        return {
          success: false,
          error: denial,
          data: { classification },
        };
      }
    }

    // 5. Execute via SSH client.
    const timeoutS = clampTimeout(timeoutOverride ?? this.defaultTimeoutS);
    const result = await runRemoteCommand({
      target,
      command,
      timeoutMs: timeoutS * 1000,
      maxOutputBytes: this.maxOutputBytes,
      strictHostKeyChecking: this.strictHostKeyChecking,
      spawnFn: this.spawnFn,
    });

    this.emitAuditEvent({
      target_id: targetId,
      command,
      classification,
      dry_run: false,
      outcome: result.exit_code === 0 ? "executed" : "failed",
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      truncated: result.truncated,
    });

    return {
      success: result.exit_code === 0,
      data: {
        ...result,
        classification,
        target_id: targetId,
      } satisfies SshExecResult & {
        classification: SshClassification;
        target_id: string;
      },
      error: result.exit_code !== 0
        ? `ssh_exec exit_code=${result.exit_code}${result.timed_out ? " (timed out)" : ""}`
        : undefined,
    };
  }

  // ── Audit-trail integration ───────────────────────────────
  //
  // Every ssh_exec / ssh_dry_run call emits one event on the injected
  // bus. The shape mirrors what the probes scheduler emits for
  // ProbeFailed / ProbeSucceeded: a flat `data` record with the
  // operationally interesting fields. Listener exceptions are
  // swallowed — audit MUST NOT break the execution path.

  private emitAuditEvent(payload: {
    target_id: string | undefined;
    command: string;
    classification: SshClassification;
    dry_run: boolean;
    outcome?: "executed" | "failed" | "refused" | "denied";
    exit_code?: number;
    duration_ms?: number;
    timed_out?: boolean;
    truncated?: boolean;
    error?: string;
  }): void {
    if (!this.eventBus) return;

    const data: Record<string, unknown> = {
      target_id: payload.target_id ?? null,
      command: payload.command,
      tier: payload.classification.tier,
      match: payload.classification.match,
      dry_run: payload.dry_run,
    };

    if (payload.classification.base_tier) {
      data.base_tier = payload.classification.base_tier;
      data.override = payload.classification.override;
    }

    if (payload.outcome !== undefined) data.outcome = payload.outcome;
    if (payload.exit_code !== undefined) data.exit_code = payload.exit_code;
    if (payload.duration_ms !== undefined) data.duration_ms = payload.duration_ms;
    if (payload.timed_out !== undefined) data.timed_out = payload.timed_out;
    if (payload.truncated !== undefined) data.truncated = payload.truncated;
    if (payload.error !== undefined) data.error = payload.error;

    try {
      this.eventBus.emit({
        type: AgentEventType.SshExec,
        timestamp: new Date().toISOString(),
        data,
      });
    } catch (err) {
      // Audit failure must never break execution.
      console.error("[ssh] audit event emit failed:", err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private listTargetIds(): string[] {
    return Array.from(this.targets.keys()).sort();
  }
}

function normalizeTarget(t: SshTarget): SshTarget {
  return {
    id: t.id,
    host: t.host,
    user: t.user,
    port: t.port,
    identity_file: t.identity_file,
    jump_host: t.jump_host,
    description: t.description,
    tier_overrides: t.tier_overrides,
  };
}

function clampTimeout(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 30;
  // Keep a hard ceiling so a runaway plan can't stall the executor.
  return Math.min(seconds, 600);
}
