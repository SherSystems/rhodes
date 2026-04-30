// ============================================================
// vClaw — Service-Health Probe Schema
// Zod schemas for validating probe definitions before they
// are loaded into the scheduler. Catches malformed kinds,
// missing fields, and bad cooldowns up front.
// ============================================================

import { z } from "zod";

// ── Constants ───────────────────────────────────────────────

/** Probe kinds the scheduler knows how to execute. */
export const PROBE_KINDS = ["tcp", "https", "ping"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

// ── Schema ──────────────────────────────────────────────────

/**
 * Service-health probe definition.
 *
 * Each probe is identified by a stable `id` and targets either a VM
 * (via `target_vm_id` + `target_node`) or a generic `target_host` label.
 * Probes drive the `service_unreachable` autopilot rule; failure runs are
 * tracked by the `ProbeStateTracker` per (id, target) entity.
 */
export const probeDefSchema = z
  .object({
    id: z.string().min(1, "id must be non-empty"),
    /** Optional VM identifier this probe is associated with. Used to
     *  route remediation (restart_vm) at the correct VM. */
    target_vm_id: z.union([z.string(), z.number()]).optional(),
    /** Optional VM node hint for the remediation tool call. */
    target_node: z.string().optional(),
    /** Optional human label for non-VM targets (e.g. "esxi-mgmt"). */
    target_host: z.string().optional(),
    kind: z.enum(PROBE_KINDS),
    /** TCP / ping host. Required for those kinds. */
    host: z.string().optional(),
    /** TCP port. Required for kind=tcp. */
    port: z.number().int().positive().max(65535).optional(),
    /** HTTPS URL. Required for kind=https. */
    url: z.string().url("url must be a valid URL").optional(),
    /** Per-probe poll interval (seconds). Default 60s. */
    interval_s: z.number().int().positive().default(60),
    /** Per-probe TCP/https connect timeout (ms). Default 5000. */
    timeout_ms: z.number().int().positive().default(5_000),
    /** Consecutive failures required before the rule fires. Default 3. */
    failures_to_alert: z.number().int().positive().default(3),
    /** Cooldown (seconds) per (probe, target) between remediation attempts. */
    cooldown_s: z.number().int().nonnegative().default(300),
    /** Allow self-signed certs on https probes. Default true. */
    insecure: z.boolean().default(true),
    /** Whether the probe is enabled. Default true. */
    enabled: z.boolean().default(true),
  })
  .superRefine((probe, ctx) => {
    if (probe.kind === "tcp") {
      if (!probe.host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tcp probe requires `host`",
          path: ["host"],
        });
      }
      if (probe.port === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tcp probe requires `port`",
          path: ["port"],
        });
      }
    } else if (probe.kind === "https") {
      if (!probe.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "https probe requires `url`",
          path: ["url"],
        });
      }
    } else if (probe.kind === "ping") {
      if (!probe.host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ping probe requires `host`",
          path: ["host"],
        });
      }
    }
  });

export type ProbeDef = z.infer<typeof probeDefSchema>;

// ── Service-Health Config Section ───────────────────────────

export const serviceHealthConfigSchema = z.object({
  /** Whether the probe scheduler runs at all. Default true (the daemon's
   * own `enabled` still gates startup). */
  enabled: z.boolean().default(true),
  /** Probe definitions. Empty list disables probing entirely. */
  probes: z.array(probeDefSchema).default([]),
});

export type ServiceHealthConfig = z.infer<typeof serviceHealthConfigSchema>;

// ── Validation result helpers ───────────────────────────────

export interface ProbeValidationError {
  index: number;
  probeId?: string;
  path: string;
  message: string;
}

export interface ProbeValidationResult {
  valid: ProbeDef[];
  errors: ProbeValidationError[];
}

/**
 * Validate a single probe definition. Throws on first error.
 */
export function validateProbe(probe: unknown): ProbeDef {
  return probeDefSchema.parse(probe);
}

/**
 * Validate a list of probe definitions without throwing — returns valid
 * probes alongside structured errors so a partially-broken config can
 * still drive the scheduler while the operator fixes the bad entries.
 */
export function validateProbes(probes: unknown[]): ProbeValidationResult {
  const valid: ProbeDef[] = [];
  const errors: ProbeValidationError[] = [];

  probes.forEach((probe, index) => {
    const result = probeDefSchema.safeParse(probe);
    if (result.success) {
      valid.push(result.data);
      return;
    }

    const probeId =
      probe && typeof probe === "object" && "id" in probe
        ? String((probe as { id: unknown }).id)
        : undefined;

    for (const issue of result.error.issues) {
      errors.push({
        index,
        probeId,
        path: issue.path.join("."),
        message: issue.message,
      });
    }
  });

  return { valid, errors };
}

// ── Default probes ──────────────────────────────────────────

/**
 * Ships with vclaw out of the box. Two example probes:
 *  1. ESXi management endpoint at 192.168.86.46:443 — the real incident
 *     that motivated this subsystem (nested ESXi VM whose mgmt service
 *     crashes while Proxmox still reports the VM as running).
 *  2. Generic localhost self-probe — proves the daemon's own dashboard
 *     port is reachable from the same host.
 *
 * Operators are expected to override this list via config.
 */
export const DEFAULT_PROBES: ProbeDef[] = [
  validateProbe({
    id: "esxi_mgmt_192_168_86_46",
    target_host: "esxi-nested-201",
    kind: "https",
    url: "https://192.168.86.46:443/",
    interval_s: 60,
    failures_to_alert: 3,
    cooldown_s: 600,
    insecure: true,
    enabled: false,
  }),
  validateProbe({
    id: "vclaw_dashboard_self",
    target_host: "localhost",
    kind: "tcp",
    host: "127.0.0.1",
    port: 3099,
    interval_s: 60,
    failures_to_alert: 3,
    cooldown_s: 300,
    enabled: false,
  }),
];

// ── Known conditions/actions wired into the rule schema ────

export const PROBE_KNOWN_CONDITIONS = [
  "service_unreachable",
  "provider_unreachable",
] as const;

export const PROBE_KNOWN_ACTIONS = [
  "restart_vm",
  "alert",
] as const;
