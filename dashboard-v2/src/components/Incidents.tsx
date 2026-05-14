import { useStore } from "../store";
import { timeAgo, formatDuration } from "../hooks/useFormatters";
import { sendAgentCommand, fetchPendingApprovals } from "../api/client";
import { buildRemediatePrompt } from "../lib/remediate";
import type { Incident } from "../types";

function renderTimeline(incident: Incident) {
  return (
    <div className="incident-timeline">
      <div className="timeline-entry">
        <div className="timeline-gutter">
          <span className="timeline-dot detected" />
          <span className="timeline-line" />
        </div>
        <div className="timeline-content">
          <span className="timeline-label">Detected</span>
          <span className="timeline-detail">{incident.description}</span>
          <span className="timeline-time">{timeAgo(incident.detected_at)}</span>
        </div>
      </div>

      {incident.actions_taken?.map((action, idx) => (
        <div className="timeline-entry" key={idx}>
          <div className="timeline-gutter">
            <span
              className={`timeline-dot action ${action.success ? "success" : "fail"}`}
            />
            <span className="timeline-line" />
          </div>
          <div className="timeline-content">
            <span className="timeline-label">{action.action}</span>
            {action.detail && (
              <span className="timeline-detail">{action.detail}</span>
            )}
            <span className="timeline-time">{timeAgo(action.timestamp)}</span>
          </div>
        </div>
      ))}

      {incident.status === "resolved" && incident.resolved_at && (
        <div className="timeline-entry">
          <div className="timeline-gutter">
            <span className="timeline-dot resolved" />
            <span className="timeline-line" />
          </div>
          <div className="timeline-content">
            <span className="timeline-label">Resolved</span>
            <span className="timeline-detail">
              {incident.resolution || "Incident resolved"}
            </span>
            <span className="timeline-time">{timeAgo(incident.resolved_at)}</span>
          </div>
        </div>
      )}

      {incident.status === "failed" && (
        <div className="timeline-entry">
          <div className="timeline-gutter">
            <span className="timeline-dot failed" />
            <span className="timeline-line" />
          </div>
          <div className="timeline-content">
            <span className="timeline-label">Failed</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RemediateButton({ incident }: { incident: Incident }) {
  const remediateState = useStore((s) => s.remediateState[incident.id]);
  const setRemediateState = useStore((s) => s.setRemediateState);
  const setPendingApprovals = useStore((s) => s.setPendingApprovals);
  const addToast = useStore((s) => s.addToast);

  const onClick = async (e: React.MouseEvent) => {
    // Prevent the parent card's expand/collapse handler from firing.
    e.stopPropagation();
    if (remediateState === "pending") return;
    setRemediateState(incident.id, "pending");
    const prompt = buildRemediatePrompt(incident);
    try {
      await sendAgentCommand(prompt);
      setRemediateState(incident.id, "done");
      // Refresh pending approvals so the new plan shows up immediately.
      try {
        const rows = await fetchPendingApprovals();
        setPendingApprovals(rows);
      } catch {
        /* non-fatal — SSE / 10s poll will catch up */
      }
    } catch (err) {
      setRemediateState(incident.id, null);
      const msg = err instanceof Error ? err.message : "Remediation request failed";
      addToast({ type: "error", title: "Remediation Failed", message: msg });
    }
  };

  if (remediateState === "done") {
    return (
      <span
        className="incident-remediate-done"
        onClick={(e) => e.stopPropagation()}
      >
        Plan requested — check Pending Approvals
      </span>
    );
  }

  return (
    <button
      type="button"
      className="incident-remediate-btn"
      disabled={remediateState === "pending"}
      onClick={onClick}
    >
      {remediateState === "pending" ? (
        <>
          <span className="approval-spinner" /> Planning…
        </>
      ) : (
        "Remediate"
      )}
    </button>
  );
}

export default function Incidents() {
  const activeIncidents = useStore((s) => s.activeIncidents);
  const recentIncidents = useStore((s) => s.recentIncidents);
  const healingBanners = useStore((s) => s.healingBanners);
  const expandedIncidents = useStore((s) => s.expandedIncidents);
  const toggleIncidentExpanded = useStore((s) => s.toggleIncidentExpanded);

  return (
    <div className="incidents">
      {healingBanners.map((banner) => (
        <div key={banner.id} className={`healing-banner ${banner.type}`}>
          <span>{banner.type === "paused" ? "⚠" : "☠"}</span>
          <span>{banner.message}</span>
        </div>
      ))}

      <div className="incidents-section-title">Active Incidents</div>
      {activeIncidents.length === 0 ? (
        <div className="empty-state empty-state--card">
          <img
            className="empty-state-mark"
            src="/brand/rhodes-mark-white.svg"
            alt=""
            aria-hidden="true"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = "/rhodes-mark.png";
            }}
          />
          <div className="empty-state-text">No active incidents — RHODES is watching.</div>
        </div>
      ) : (
        <div className="incident-card-grid">
          {activeIncidents.map((incident) => {
            const isOpen = incident.status === "open" || incident.status === "healing";
            return (
              <div
                key={incident.id}
                className="incident-card"
                onClick={() => toggleIncidentExpanded(incident.id)}
              >
                <div className="incident-card-header">
                  <span className={`status-rect severity-${incident.severity}`}>
                    {incident.severity === "critical" ? "CRITICAL" : "WARNING"}
                  </span>
                  <span className={`status-rect incident-status-${incident.status}`}>
                    {incident.status.toUpperCase()}
                  </span>
                  {isOpen && <RemediateButton incident={incident} />}
                </div>
                <div className="incident-desc">{incident.description}</div>
                {((incident.metric || incident.metric_name) || incident.trigger_value != null) && (
                  <div className="incident-card-meta">
                    {incident.metric || incident.metric_name}
                    {incident.trigger_value != null && ` = ${incident.trigger_value}`}
                  </div>
                )}
                {incident.status === "healing" && incident.playbook_name && (
                  <div className="incident-playbook">
                    <span className="spinner" />
                    {incident.playbook_name}
                  </div>
                )}
                <div className="incident-time-ago">{timeAgo(incident.detected_at)}</div>
                {expandedIncidents[incident.id] && renderTimeline(incident)}
              </div>
            );
          })}
        </div>
      )}

      <div className="incidents-section-title">Recent Incidents</div>
      {recentIncidents.length === 0 ? (
        <div className="empty-state empty-state--inline">No recent incidents.</div>
      ) : (
        recentIncidents.map((incident) => (
          <div
            key={incident.id}
            className="incident-row"
            onClick={() => toggleIncidentExpanded(incident.id)}
          >
            <span className={`incident-sev-dot ${incident.severity}`} />
            <span className="incident-row-desc">{incident.description}</span>
            {incident.pattern_id && (
              <span className="incident-pattern-tag">{incident.pattern_id}</span>
            )}
            {incident.duration_ms != null && (
              <span className="incident-row-duration">
                {formatDuration(incident.duration_ms)}
              </span>
            )}
            {incident.resolution && (
              <span className="incident-row-resolution">{incident.resolution}</span>
            )}
            <span
              className={`incident-row-result ${
                incident.status === "resolved" ? "resolved" : "failed"
              }`}
            />
            {expandedIncidents[incident.id] && renderTimeline(incident)}
          </div>
        ))
      )}
    </div>
  );
}
