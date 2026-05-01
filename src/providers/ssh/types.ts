// ============================================================
// vClaw — SSH Adapter Types
// First-class shell-execution surface against registered SSH targets.
// ============================================================

import type { ActionTier } from "../types.js";

/**
 * Per-target overrides applied AFTER the base classifier produces a tier.
 * Two shapes are supported and may be combined:
 *
 *   - `default`: a floor tier applied to every command on this target.
 *     If the classifier returns a tier strictly lower than `default`,
 *     the result is bumped up. This lets an operator declare a target
 *     "this host is risky_write even for normally-safe commands"
 *     (e.g. a fragile production box where even an `ls` deserves a
 *     human in the loop).
 *
 *   - `commands`: a per-tag override map. Keys match either the
 *     classifier `match` tag (e.g. `"systemctl-mutate"`) OR the
 *     trimmed command string verbatim. Values are the tier to apply.
 *     Lets an operator unlock a specific allowlisted command on an
 *     otherwise-locked target, OR bump a specific safe command up.
 *
 * Overrides can lower a tier (e.g. unlock `systemctl restart nginx`
 * to `safe_write` on a sandbox host) but they can NEVER lower a
 * `never`-tier classification — that one is non-negotiable.
 */
export interface SshTierOverrides {
  /** Floor tier — every command on this target is at least this risky. */
  default?: ActionTier;
  /** Per-command/tag overrides. Keys match classifier tag OR exact command. */
  commands?: Record<string, ActionTier>;
}

/**
 * A registered SSH target. Targets are configured up front (via env or
 * config file) and addressed by stable id thereafter — tools never take
 * raw host strings, only target ids. This gives operators a single
 * inventory surface and prevents the agent from SSH'ing to arbitrary
 * hosts at will.
 */
export interface SshTarget {
  /** Stable identifier used by tools (e.g. "pve-01", "esxi-lab"). */
  id: string;
  /** Hostname or IP. */
  host: string;
  /** Optional port (defaults to 22). */
  port?: number;
  /** SSH user. */
  user: string;
  /**
   * Optional path to private key. Never logged. If unset, falls back
   * to the system ssh-agent / ~/.ssh defaults.
   */
  identity_file?: string;
  /**
   * Optional jump host (`-J user@host`). Useful for reaching ESXi /
   * Proxmox boxes that aren't directly reachable from the agent host.
   */
  jump_host?: string;
  /** Free-form description shown to operators in approval prompts. */
  description?: string;
  /**
   * Optional per-target tier overrides — see {@link SshTierOverrides}.
   * Lets operators harden (or selectively relax) the global classifier
   * on a target-by-target basis.
   */
  tier_overrides?: SshTierOverrides;
}

export interface SshExecRequest {
  /** Id of a registered target. */
  target_id: string;
  /** Shell command to execute. */
  command: string;
  /** Override the default timeout (seconds). */
  timeout_s?: number;
}

export interface SshExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** True if either stdout or stderr was truncated at max_output_bytes. */
  truncated: boolean;
  duration_ms: number;
  /** Whether the command was killed by the timeout. */
  timed_out: boolean;
}

/** Result of classifying a command without executing it. */
export interface SshClassification {
  tier: ActionTier;
  /** Human-readable reason matching the chosen tier. */
  reason: string;
  /**
   * Optional tag identifying which heuristic fired
   * (used by tests, logged for audit).
   */
  match?: string;
  /**
   * The tier the base classifier returned BEFORE any per-target
   * override was applied. Set only when `applyTierOverrides` was
   * called and the override actually changed the tier. Useful for
   * audit so operators can see "this would have been read but the
   * target's `tier_overrides.default` bumped it to risky_write".
   */
  base_tier?: ActionTier;
  /**
   * The override key that fired (matches a key in
   * `SshTierOverrides.commands` or the literal `"default"`). Set
   * alongside `base_tier`.
   */
  override?: string;
}

export interface SshAdapterOptions {
  targets: SshTarget[];
  /** Cap on total stdout+stderr captured. Defaults to 64 KiB. */
  max_output_bytes?: number;
  /** Per-call timeout default in seconds. Defaults to 30. */
  default_timeout_s?: number;
  /**
   * Global kill-switch. When false, destructive-tier commands are
   * refused outright and never even forwarded to governance for
   * approval. Defaults to false (fail closed).
   */
  allow_destructive?: boolean;
  /**
   * Strict host-key checking. Defaults to true. If false, falls back
   * to UserKnownHostsFile=/dev/null (homelab convenience only).
   */
  strict_host_key_checking?: boolean;
}
