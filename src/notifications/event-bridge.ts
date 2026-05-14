// ============================================================
// RHODES — Notifications: EventBus → Notifier bridge
// Subscribes to the agent EventBus once and forwards relevant
// events through the Notifier. Keeps autopilot/incident hooks
// from caring about alert delivery details.
// ============================================================

import type { AgentEvent, AgentEventType } from "../types.js";
import type { EventBus } from "../agent/events.js";
import type { Notifier } from "./notifier.js";
import {
  formatApprovalNeeded,
  formatAutopilotEvent,
  formatExecutionOutcome,
  formatHealthCheckFailure,
  formatPlanGenerated,
} from "./format.js";

export interface AlertBridgeOptions {
  notifier: Notifier;
  /** Used to build deep links into the dashboard. Optional. */
  dashboardUrl?: string;
  /**
   * Filter for which events to alert on. Default emits the full set
   * documented in the brief: plan generated, approval needed, execution
   * outcome, health-check failure, and rule-fired (autopilot events).
   */
  emitOn?: Set<AgentEventType>;
}

const DEFAULT_EMIT_ON: ReadonlyArray<AgentEventType> = [
  "plan_created" as AgentEventType,
  "approval_requested" as AgentEventType,
  "step_completed" as AgentEventType,
  "step_failed" as AgentEventType,
  "incident_opened" as AgentEventType,
  "incident_resolved" as AgentEventType,
  "incident_failed" as AgentEventType,
  "autopilot_rule_fired" as AgentEventType,
  "probe_failed" as AgentEventType,
  "provider_unreachable" as AgentEventType,
  // Chaos gate decisions — surface every gate event so the operator
  // sees blocked/approved/rejected/timed-out runs alongside incidents.
  "chaos_approved" as AgentEventType,
  "chaos_rejected" as AgentEventType,
  "chaos_approval_timeout" as AgentEventType,
  "chaos_blocked" as AgentEventType,
  "chaos_audited" as AgentEventType,
];

/**
 * Attach the bridge to an EventBus and return an unsubscribe function.
 * Failure modes (network error, rate-limit) are absorbed inside the
 * notifier — the bridge never throws.
 */
export function attachAlertBridge(bus: EventBus, options: AlertBridgeOptions): () => void {
  const emitOn = options.emitOn ?? new Set(DEFAULT_EMIT_ON);
  const listener = (event: AgentEvent) => {
    if (!emitOn.has(event.type)) return;
    const alert = renderAlertForEvent(event, options.dashboardUrl);
    if (!alert) return;
    // Fire-and-forget — alerting is best-effort by design.
    void options.notifier.send(alert);
  };
  bus.on("*", listener);
  return () => bus.off("*", listener);
}

function renderAlertForEvent(
  event: AgentEvent,
  dashboardUrl: string | undefined,
): ReturnType<typeof formatPlanGenerated> | null {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "plan_created": {
      return formatPlanGenerated(
        {
          planId: String(data.plan_id ?? data.id ?? "unknown"),
          goal: String(data.goal ?? data.description ?? "unknown goal"),
          stepCount: Number(data.step_count ?? (Array.isArray(data.steps) ? data.steps.length : 0)),
          mode: data.mode ? String(data.mode) : undefined,
        },
        dashboardUrl,
      );
    }
    case "approval_requested": {
      return formatApprovalNeeded({
        planId: String(data.plan_id ?? "unknown"),
        action: String(data.action ?? "unknown"),
        description: data.description ? String(data.description) : undefined,
        tier: String(data.tier ?? "unknown"),
        dashboardUrl,
      });
    }
    case "step_completed":
    case "step_failed": {
      return formatExecutionOutcome({
        planId: data.plan_id ? String(data.plan_id) : undefined,
        action: String(data.action ?? "unknown"),
        success: event.type === "step_completed",
        durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
        error: data.error ? String(data.error) : undefined,
      });
    }
    case "probe_failed": {
      return formatHealthCheckFailure({
        probeId: String(data.probe_id ?? data.id ?? "unknown"),
        reason: String(data.reason ?? data.error ?? "probe failed"),
        consecutiveFailures: typeof data.consecutive_failures === "number" ? data.consecutive_failures : undefined,
      });
    }
    case "provider_unreachable": {
      return formatHealthCheckFailure({
        probeId: `provider:${String(data.provider ?? "unknown")}`,
        reason: String(data.reason ?? "provider unreachable"),
      });
    }
    case "autopilot_rule_fired": {
      return formatAutopilotEvent({
        ruleId: String(data.rule_id ?? "unknown"),
        ruleClass: String(data.rule_class ?? data.rule_id ?? "AUTOPILOT_EVENT").toUpperCase(),
        target: data.target ? String(data.target) : undefined,
        summary: String(data.summary ?? data.message ?? "autopilot event fired"),
        recoversBytes: typeof data.recovers_bytes === "number" ? data.recovers_bytes : undefined,
        planId: data.plan_id ? String(data.plan_id) : undefined,
        dashboardUrl,
      });
    }
    case "incident_opened":
    case "incident_resolved":
    case "incident_failed": {
      const verb =
        event.type === "incident_opened"
          ? "opened"
          : event.type === "incident_resolved"
            ? "resolved"
            : "failed";
      return {
        kind: event.type === "incident_failed" ? "execution_failed" : "event",
        title: `RHODES incident ${verb}`,
        body: [
          `RHODES — incident ${verb}`,
          `Incident: ${String(data.incident_id ?? data.id ?? "unknown")}`,
          data.severity ? `Severity: ${String(data.severity)}` : undefined,
          data.summary ? String(data.summary) : undefined,
        ]
          .filter((x): x is string => Boolean(x))
          .join("\n"),
        timestamp: event.timestamp,
        context: data,
      };
    }
    case "chaos_blocked":
    case "chaos_approved":
    case "chaos_rejected":
    case "chaos_approval_timeout":
    case "chaos_audited": {
      const verb =
        event.type === "chaos_blocked"
          ? "BLOCKED (NEVER list)"
          : event.type === "chaos_approved"
            ? "approved"
            : event.type === "chaos_rejected"
              ? "rejected"
              : event.type === "chaos_approval_timeout"
                ? "approval timed out"
                : "audited";
      const lines = [
        `RHODES — chaos ${verb}`,
        `Scenario: ${String(data.scenario ?? data.scenario_id ?? "unknown")}`,
      ];
      if (data.risk_score !== undefined) {
        lines.push(`Risk: ${String(data.risk_score)}/100`);
      }
      if (data.approval_decision) {
        lines.push(`Approval: ${String(data.approval_decision)}`);
      }
      if (data.reason) lines.push(`Reason: ${String(data.reason)}`);
      return {
        kind: event.type === "chaos_rejected" || event.type === "chaos_blocked"
          ? "execution_failed"
          : "event",
        title: `RHODES chaos ${verb}`,
        body: lines.join("\n"),
        timestamp: event.timestamp,
        context: data,
      };
    }
    default:
      return null;
  }
}
