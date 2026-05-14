// ============================================================
// RHODES — Notifications: alert formatting helpers
// Builds the user-visible alert body for each operational moment.
// Kept separate from providers so we can unit-test the rendering
// without touching fetch.
// ============================================================

import type { Alert } from "./types.js";

export interface PlanSummary {
  planId: string;
  goal: string;
  stepCount: number;
  mode?: string;
}

export interface ApprovalContext {
  planId: string;
  action: string;
  description?: string;
  tier: string;
  dashboardUrl?: string;
}

export interface ExecutionOutcomeContext {
  planId?: string;
  action: string;
  success: boolean;
  durationMs?: number;
  error?: string;
}

export interface HealthCheckContext {
  probeId: string;
  reason: string;
  consecutiveFailures?: number;
}

export interface AutopilotEventContext {
  ruleId: string;
  ruleClass: string;
  target?: string;
  summary: string;
  recoversBytes?: number;
  planId?: string;
  dashboardUrl?: string;
}

const PREFIX = "RHODES";

export function formatAutopilotEvent(ctx: AutopilotEventContext): Alert {
  const lines = [
    `${PREFIX} — ${ctx.ruleClass}${ctx.target ? ` on ${ctx.target}` : ""}`,
    ctx.summary,
  ];
  if (typeof ctx.recoversBytes === "number") {
    lines.push(`recovers ~${formatBytes(ctx.recoversBytes)}`);
  }
  if (ctx.planId && ctx.dashboardUrl) {
    lines.push(`Approval needed: ${ctx.dashboardUrl}/plans/${ctx.planId}`);
  } else if (ctx.planId) {
    lines.push(`Plan: ${ctx.planId}`);
  }
  return {
    kind: "event",
    title: `${PREFIX} ${ctx.ruleClass}`,
    body: lines.join("\n"),
    timestamp: new Date().toISOString(),
    context: { rule_id: ctx.ruleId, target: ctx.target },
    link: ctx.planId && ctx.dashboardUrl ? `${ctx.dashboardUrl}/plans/${ctx.planId}` : undefined,
  };
}

export function formatPlanGenerated(p: PlanSummary, dashboardUrl?: string): Alert {
  const link = dashboardUrl ? `${dashboardUrl}/plans/${p.planId}` : undefined;
  const lines = [
    `${PREFIX} — plan generated`,
    `Goal: ${p.goal}`,
    `Steps: ${p.stepCount}${p.mode ? ` (mode=${p.mode})` : ""}`,
  ];
  if (link) lines.push(`Diff: ${link}`);
  return {
    kind: "plan_generated",
    title: `${PREFIX} plan ${p.planId}`,
    body: lines.join("\n"),
    timestamp: new Date().toISOString(),
    context: { plan_id: p.planId },
    link,
  };
}

/**
 * Build a dashboard deep-link URL for a given plan id.
 *
 * The dashboard renders its Pending Approvals panel on the home page and
 * scrolls/highlights the matching card when it sees a `?plan=<id>` query
 * string on page load. We append the query to whatever base URL the
 * operator configured (commonly something like `http://100.73.129.96:7412`
 * on the NUC), normalising any trailing slash so the resulting URL is
 * always `<base>/?plan=<id>`.
 */
export function buildPlanDeepLink(dashboardUrl: string, planId: string): string {
  const trimmed = dashboardUrl.replace(/\/+$/, "");
  return `${trimmed}/?plan=${encodeURIComponent(planId)}`;
}

export function formatApprovalNeeded(ctx: ApprovalContext): Alert {
  const lines = [
    `${PREFIX} — approval needed`,
    `Action: ${ctx.action} [${ctx.tier}]`,
  ];
  if (ctx.description) lines.push(ctx.description);
  const deepLink = ctx.dashboardUrl ? buildPlanDeepLink(ctx.dashboardUrl, ctx.planId) : undefined;
  if (deepLink) {
    lines.push(`Approve at: ${deepLink}`);
  } else {
    lines.push(`Plan: ${ctx.planId}`);
  }
  return {
    kind: "approval_needed",
    title: `${PREFIX} approval ${ctx.planId}`,
    body: lines.join("\n"),
    timestamp: new Date().toISOString(),
    context: { plan_id: ctx.planId, action: ctx.action, tier: ctx.tier },
    link: deepLink,
  };
}

export function formatExecutionOutcome(ctx: ExecutionOutcomeContext): Alert {
  const verb = ctx.success ? "completed" : "failed";
  const lines = [
    `${PREFIX} — execution ${verb}`,
    `Action: ${ctx.action}`,
  ];
  if (typeof ctx.durationMs === "number") {
    lines.push(`Duration: ${ctx.durationMs}ms`);
  }
  if (!ctx.success && ctx.error) {
    lines.push(`Error: ${ctx.error}`);
  }
  return {
    kind: ctx.success ? "execution_complete" : "execution_failed",
    title: `${PREFIX} ${verb}: ${ctx.action}`,
    body: lines.join("\n"),
    timestamp: new Date().toISOString(),
    context: { plan_id: ctx.planId, action: ctx.action, success: ctx.success },
  };
}

export function formatHealthCheckFailure(ctx: HealthCheckContext): Alert {
  const lines = [
    `${PREFIX} — health check FAIL`,
    `Probe: ${ctx.probeId}`,
    `Reason: ${ctx.reason}`,
  ];
  if (typeof ctx.consecutiveFailures === "number") {
    lines.push(`Consecutive failures: ${ctx.consecutiveFailures}`);
  }
  return {
    kind: "health_check_failed",
    title: `${PREFIX} probe ${ctx.probeId} failing`,
    body: lines.join("\n"),
    timestamp: new Date().toISOString(),
    context: { probe_id: ctx.probeId, reason: ctx.reason },
  };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[i]}`;
}
