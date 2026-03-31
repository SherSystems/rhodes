import { useEffect, useState } from "react";
import { useStore } from "../store";
import { fetchAudit, fetchAuditStats, fetchRunTelemetry } from "../api/client";
import { formatDuration } from "../hooks/useFormatters";
import type { AuditEntry, RunTelemetrySummary } from "../types";

export default function Governance() {
  const { totalActions, failures, replans, startTime } = useStore();

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditStats, setAuditStats] = useState<Record<string, unknown>>({});
  const [runTelemetry, setRunTelemetry] = useState<RunTelemetrySummary | null>(null);
  const [expandedPlans, setExpandedPlans] = useState<Record<string, boolean>>({});
  const [expandedEntries, setExpandedEntries] = useState<Record<number, boolean>>({});

  useEffect(() => {
    fetchAudit().then(setAuditEntries).catch(() => {});
    fetchAuditStats().then(setAuditStats).catch(() => {});
    fetchRunTelemetry(7).then(setRunTelemetry).catch(() => {});
  }, []);

  const togglePlan = (planId: string) =>
    setExpandedPlans((prev) => ({ ...prev, [planId]: !prev[planId] }));

  const toggleEntry = (index: number) =>
    setExpandedEntries((prev) => ({ ...prev, [index]: !prev[index] }));

  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  };

  const resultClass = (result: string): string => {
    switch (result) {
      case "success":
        return "ok";
      case "failed":
        return "fail";
      case "blocked":
        return "warn";
      case "rolled_back":
        return "warn";
      default:
        return "neutral";
    }
  };

  const tierClass = (tier: string): string => {
    switch (tier) {
      case "read":
        return "tier-read";
      case "safe_write":
        return "tier-safe";
      case "risky_write":
        return "tier-risky";
      case "destructive":
        return "tier-destructive";
      case "never":
        return "tier-never";
      default:
        return "";
    }
  };

  const formatMs = (value: number | null): string =>
    value === null ? "-" : formatDuration(value);

  // Group entries by plan_id
  const grouped: { planId: string | null; entries: { entry: AuditEntry; index: number }[] }[] = [];
  const planOrder: string[] = [];
  const planMap = new Map<string, { entry: AuditEntry; index: number }[]>();
  const ungrouped: { entry: AuditEntry; index: number }[] = [];

  auditEntries.forEach((entry, index) => {
    if (entry.plan_id) {
      if (!planMap.has(entry.plan_id)) {
        planMap.set(entry.plan_id, []);
        planOrder.push(entry.plan_id);
      }
      planMap.get(entry.plan_id)!.push({ entry, index });
    } else {
      ungrouped.push({ entry, index });
    }
  });

  for (const planId of planOrder) {
    grouped.push({ planId, entries: planMap.get(planId)! });
  }
  if (ungrouped.length > 0) {
    grouped.push({ planId: null, entries: ungrouped });
  }

  return (
    <>
      {/* Card 1: Governance & Safety */}
      <div className="card">
        <div className="card-head">
          <h3>Governance &amp; Safety</h3>
        </div>
        <div className="card-body">
          <div className="gov-grid">
            <div className="gov-item">
              <span className="gov-label">Circuit Breaker</span>
              <span className="gov-value ok">Closed</span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Total Actions</span>
              <span className="gov-value neutral">{totalActions}</span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Failures</span>
              <span className={`gov-value ${failures > 0 ? "warn" : "ok"}`}>
                {failures}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Approvals Pending</span>
              <span className="gov-value neutral">0</span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Replans</span>
              <span className={`gov-value ${replans > 0 ? "warn" : ""}`}>
                {replans}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Uptime</span>
              <span className="gov-value">{formatDuration(Date.now() - startTime)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Execution SLO (7d)</h3>
          <span className={`badge ${runTelemetry?.slo.breached ? "warn" : ""}`}>
            {runTelemetry?.slo.breached ? "Breach" : "Healthy"}
          </span>
        </div>
        <div className="card-body">
          <div className="gov-grid">
            <div className="gov-item">
              <span className="gov-label">Success Rate</span>
              <span className={`gov-value ${runTelemetry?.slo.success_rate_breached ? "warn" : "ok"}`}>
                {runTelemetry ? `${runTelemetry.totals.success_rate_pct}%` : "-"}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Latency p50 / p95</span>
              <span className={`gov-value ${runTelemetry?.slo.latency_p95_breached ? "warn" : "neutral"}`}>
                {runTelemetry
                  ? `${formatMs(runTelemetry.latency.p50_ms)} / ${formatMs(runTelemetry.latency.p95_ms)}`
                  : "-"}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">SLO Targets</span>
              <span className="gov-value neutral">
                {runTelemetry
                  ? `p95 <= ${formatMs(runTelemetry.slo.targets.p95_latency_ms)}, success >= ${runTelemetry.slo.targets.success_rate_pct}%`
                  : "-"}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Runs Completed</span>
              <span className="gov-value neutral">
                {runTelemetry?.totals.runs_completed ?? "-"}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Envelope Completeness</span>
              <span className={`gov-value ${(runTelemetry?.totals.envelope_completeness_pct ?? 100) < 95 ? "warn" : "ok"}`}>
                {runTelemetry ? `${runTelemetry.totals.envelope_completeness_pct}%` : "-"}
              </span>
            </div>
            <div className="gov-item">
              <span className="gov-label">Avg Approval Wait</span>
              <span className="gov-value neutral">
                {runTelemetry ? formatMs(runTelemetry.approval.avg_wait_ms) : "-"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Card 2: Audit Trail */}
      <div className="card">
        <div className="card-head">
          <h3>Audit Trail</h3>
          <span className="badge">{auditEntries.length}</span>
        </div>
        <div className="card-body">
          <div className="audit-list">
            {grouped.map((group) => {
              if (group.planId === null) {
                // Ungrouped entries rendered directly
                return group.entries.map(({ entry, index }) => (
                  <div
                    key={`ungrouped-${index}`}
                    className={`audit-row${expandedEntries[index] ? " open" : ""}`}
                  >
                    <div className="audit-header" onClick={() => toggleEntry(index)}>
                      <span className="audit-chevron">
                        {expandedEntries[index] ? "▾" : "▸"}
                      </span>
                      <span className="audit-time">{formatTime(entry.timestamp)}</span>
                      <span className="audit-action">{entry.action}</span>
                      <span className={`audit-tier ${tierClass(entry.tier)}`}>
                        {entry.tier}
                      </span>
                      <span className={`audit-result-dot ${resultClass(entry.result)}`} />
                    </div>
                    {expandedEntries[index] && (
                      <div className="audit-detail">
                        <div className="audit-detail-grid">
                          <div>
                            <span className="gov-label">Result</span>
                            <span className={`gov-value ${resultClass(entry.result)}`}>
                              {entry.result}
                            </span>
                          </div>
                          {entry.duration_ms !== undefined && (
                            <div>
                              <span className="gov-label">Duration</span>
                              <span className="gov-value">{formatDuration(entry.duration_ms)}</span>
                            </div>
                          )}
                          <div>
                            <span className="gov-label">Tier</span>
                            <span className="gov-value">{entry.tier}</span>
                          </div>
                          {entry.approval && (
                            <div>
                              <span className="gov-label">Approval</span>
                              <span className="gov-value">{entry.approval}</span>
                            </div>
                          )}
                        </div>
                        {entry.reasoning && (
                          <div className="audit-reasoning">{entry.reasoning}</div>
                        )}
                        {entry.params && (
                          <pre className="audit-params">
                            {JSON.stringify(entry.params, null, 2)}
                          </pre>
                        )}
                        {entry.error && (
                          <div className="audit-error">{entry.error}</div>
                        )}
                      </div>
                    )}
                  </div>
                ));
              }

              const planId = group.planId!;
              const isOpen = expandedPlans[planId] ?? false;
              const successCount = group.entries.filter(
                ({ entry }) => entry.result === "success"
              ).length;
              const failCount = group.entries.filter(
                ({ entry }) => entry.result === "failed"
              ).length;
              const overallResult =
                failCount > 0 ? "failed" : successCount === group.entries.length ? "success" : "warn";
              // Derive a readable label from first entry's action/reasoning
              const firstEntry = group.entries[0]?.entry;
              const actions = [...new Set(group.entries.map(({ entry }) => entry.action))];
              const actionLabel = actions.map((a) => a.replace(/_/g, " ")).join(" → ");
              const goalText = firstEntry?.reasoning
                ? firstEntry.reasoning.length > 80
                  ? firstEntry.reasoning.slice(0, 80) + "…"
                  : firstEntry.reasoning
                : actionLabel || "Direct action";

              return (
                <div
                  key={planId}
                  className={`audit-plan-group${isOpen ? " open" : ""}`}
                >
                  <div className="audit-plan-header" onClick={() => togglePlan(planId)}>
                    <span className="audit-plan-chevron">{isOpen ? "▾" : "▸"}</span>
                    <span className="audit-plan-goal">{goalText}</span>
                    <span className="audit-plan-summary">
                      {group.entries.length} step{group.entries.length !== 1 ? "s" : ""}
                    </span>
                    <span className="audit-plan-stat">
                      {successCount} ok / {failCount} fail
                    </span>
                    <span
                      className={`audit-plan-result ${resultClass(overallResult)}`}
                    />
                  </div>
                  {isOpen && (
                    <div className="audit-plan-steps">
                      {group.entries.map(({ entry, index }) => (
                        <div
                          key={index}
                          className={`audit-row${expandedEntries[index] ? " open" : ""}`}
                        >
                          <div
                            className="audit-header"
                            onClick={() => toggleEntry(index)}
                          >
                            <span className="audit-chevron">
                              {expandedEntries[index] ? "▾" : "▸"}
                            </span>
                            <span className="audit-time">
                              {formatTime(entry.timestamp)}
                            </span>
                            <span className="audit-action">{entry.action}</span>
                            <span className={`audit-tier ${tierClass(entry.tier)}`}>
                              {entry.tier}
                            </span>
                            <span
                              className={`audit-result-dot ${resultClass(entry.result)}`}
                            />
                          </div>
                          {expandedEntries[index] && (
                            <div className="audit-detail">
                              <div className="audit-detail-grid">
                                <div>
                                  <span className="gov-label">Result</span>
                                  <span
                                    className={`gov-value ${resultClass(entry.result)}`}
                                  >
                                    {entry.result}
                                  </span>
                                </div>
                                {entry.duration_ms !== undefined && (
                                  <div>
                                    <span className="gov-label">Duration</span>
                                    <span className="gov-value">
                                      {formatDuration(entry.duration_ms)}
                                    </span>
                                  </div>
                                )}
                                <div>
                                  <span className="gov-label">Tier</span>
                                  <span className="gov-value">{entry.tier}</span>
                                </div>
                                {entry.approval && (
                                  <div>
                                    <span className="gov-label">Approval</span>
                                    <span className="gov-value">{entry.approval}</span>
                                  </div>
                                )}
                              </div>
                              {entry.reasoning && (
                                <div className="audit-reasoning">{entry.reasoning}</div>
                              )}
                              {entry.params && (
                                <pre className="audit-params">
                                  {JSON.stringify(entry.params, null, 2)}
                                </pre>
                              )}
                              {entry.error && (
                                <div className="audit-error">{entry.error}</div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
