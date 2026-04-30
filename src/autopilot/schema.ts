// ============================================================
// vClaw — Autopilot Rule Schema
// Zod schemas for validating AutopilotRule definitions before
// they are loaded into the engine. Catches typos in condition
// strings, malformed cooldowns, and bad tier values up front.
// ============================================================

import { z } from "zod";
import type { AutopilotRule } from "../types.js";

// ── Constants ───────────────────────────────────────────────

/** Conditions the engine knows how to evaluate. */
export const KNOWN_CONDITIONS = [
  "vm_was_running_now_stopped",
  "node_ram_above_90",
  "storage_above_95",
  "node_went_offline",
  "service_unreachable",
  "provider_unreachable",
] as const;

/** Actions the daemon knows how to dispatch. */
export const KNOWN_ACTIONS = ["alert", "start_vm", "restart_vm"] as const;

// Mirrors the canonical ActionTier from providers/types.ts. The two
// previously diverged (this file used "approval_write"/"forbidden",
// the provider type used "risky_write"/"never"); we now keep them in
// sync so AutopilotRule.tier matches the rest of the engine.
const ACTION_TIERS = [
  "read",
  "safe_write",
  "risky_write",
  "destructive",
  "never",
] as const;

// ── Schema ──────────────────────────────────────────────────

export const autopilotRuleSchema = z
  .object({
    id: z.string().min(1, "id must be non-empty"),
    name: z.string().min(1, "name must be non-empty"),
    condition: z.string().min(1, "condition must be non-empty"),
    action: z.string().min(1, "action must be non-empty"),
    params: z.record(z.unknown()).default({}),
    tier: z.enum(ACTION_TIERS),
    enabled: z.boolean(),
    cooldown_s: z.number().int().nonnegative("cooldown_s must be >= 0"),
    last_triggered_at: z.string().optional(),
    per_entity_cooldown_s: z
      .number()
      .int()
      .nonnegative("per_entity_cooldown_s must be >= 0")
      .optional(),
    rate_limit_max: z
      .number()
      .int()
      .positive("rate_limit_max must be > 0")
      .optional(),
    rate_limit_window_s: z
      .number()
      .int()
      .positive("rate_limit_window_s must be > 0")
      .optional(),
  })
  .superRefine((rule, ctx) => {
    // Both rate-limit fields are required together.
    const hasMax = rule.rate_limit_max !== undefined;
    const hasWindow = rule.rate_limit_window_s !== undefined;
    if (hasMax !== hasWindow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "rate_limit_max and rate_limit_window_s must be set together",
        path: hasMax ? ["rate_limit_window_s"] : ["rate_limit_max"],
      });
    }
  });

// ── Validation Result ───────────────────────────────────────

export interface RuleValidationError {
  index: number;
  ruleId?: string;
  path: string;
  message: string;
}

export interface RuleValidationResult {
  valid: AutopilotRule[];
  errors: RuleValidationError[];
}

/**
 * Validate a single rule definition. Throws a descriptive error when invalid.
 */
export function validateRule(rule: unknown): AutopilotRule {
  const parsed = autopilotRuleSchema.parse(rule);
  return parsed as AutopilotRule;
}

/**
 * Validate a list of rule definitions. Unlike `validateRule`, this never
 * throws — it returns the valid rules and a structured list of errors so
 * a partially-broken config can still drive the engine while the operator
 * fixes the bad entries.
 */
export function validateRules(rules: unknown[]): RuleValidationResult {
  const valid: AutopilotRule[] = [];
  const errors: RuleValidationError[] = [];

  rules.forEach((rule, index) => {
    const result = autopilotRuleSchema.safeParse(rule);
    if (result.success) {
      valid.push(result.data as AutopilotRule);
      return;
    }

    const ruleId =
      rule && typeof rule === "object" && "id" in rule
        ? String((rule as { id: unknown }).id)
        : undefined;

    for (const issue of result.error.issues) {
      errors.push({
        index,
        ruleId,
        path: issue.path.join("."),
        message: issue.message,
      });
    }
  });

  return { valid, errors };
}

/**
 * Strict variant that throws if any rule in the list is invalid. Returns
 * the typed rules on success.
 */
export function validateRulesStrict(rules: unknown[]): AutopilotRule[] {
  const result = validateRules(rules);
  if (result.errors.length > 0) {
    const formatted = result.errors
      .map(
        (e) =>
          `  [${e.index}${e.ruleId ? ` ${e.ruleId}` : ""}] ${e.path || "(root)"}: ${e.message}`,
      )
      .join("\n");
    throw new Error(
      `Invalid autopilot rule definitions:\n${formatted}`,
    );
  }
  return result.valid;
}
