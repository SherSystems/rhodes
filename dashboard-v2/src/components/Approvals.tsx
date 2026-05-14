import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import {
  fetchPendingApprovals,
  submitApprovalDecision,
  type PendingApproval,
} from "../api/client";
import {
  isSafetySnapshot,
  readDeepLinkPlanId,
  tierClass,
  tierLabel,
} from "../lib/approvals";
import { timeAgo } from "../hooks/useFormatters";

function operatorFromEnv(): string {
  if (typeof window === "undefined") return "dashboard_operator";
  const stored = window.localStorage?.getItem("rhodes_operator");
  return stored && stored.trim().length > 0 ? stored.trim() : "dashboard_operator";
}

interface ApprovalsProps {
  /**
   * When true, render compact cards (used by the floating panel above the
   * page content). When false, render the full sub-tab presentation.
   */
  compact?: boolean;
}

export default function Approvals({ compact = false }: ApprovalsProps) {
  const pending = useStore((s) => s.pendingApprovals);
  const setPendingApprovals = useStore((s) => s.setPendingApprovals);
  const removePendingApproval = useStore((s) => s.removePendingApproval);
  const addToast = useStore((s) => s.addToast);

  const [busy, setBusy] = useState<Record<string, "approve" | "reject" | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Deep-link is read once and cleared after the first successful pulse so
  // it doesn't fire again on every re-render.
  const deepLinkRef = useRef<string | null>(readDeepLinkPlanId());
  const deepLinkResolvedRef = useRef<boolean>(false);
  const deepLinkAuditInFlightRef = useRef<boolean>(false);

  // Initial catch-up: pull anything blocked from before the SSE connected,
  // then re-poll every 10s as a safety net in case an event is missed.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const rows = await fetchPendingApprovals();
        if (!cancelled) setPendingApprovals(rows);
      } catch {
        if (!cancelled) setError("Could not load pending approvals.");
      }
    };

    load();
    const id = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [setPendingApprovals]);

  // ── Deep-link handler (?plan=<id>) ─────────────────────
  // Runs after every render so that a plan landing via SSE *after* page
  // load still gets the highlight pulse + scroll-into-view.
  useEffect(() => {
    const planId = deepLinkRef.current;
    if (!planId || deepLinkResolvedRef.current) return;
    const root = containerRef.current;
    if (!root) return;

    const escaped = (typeof CSS !== "undefined" && CSS.escape)
      ? CSS.escape(planId)
      : planId.replace(/[^a-zA-Z0-9_-]/g, "");
    const card = root.querySelector<HTMLElement>(`[data-plan-id="${escaped}"]`);
    if (card) {
      deepLinkResolvedRef.current = true;
      try {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        card.scrollIntoView();
      }
      card.classList.remove("approval-card--deep-link");
      // force reflow so the animation restarts cleanly
      void card.offsetWidth;
      card.classList.add("approval-card--deep-link");
      window.setTimeout(() => {
        card.classList.remove("approval-card--deep-link");
      }, 2200);
      return;
    }

    // Card not found — could be (a) SSE hasn't delivered the awaiting_approval
    // entry yet, or (b) the plan was already decided. Distinguish via audit.
    if (deepLinkAuditInFlightRef.current) return;
    deepLinkAuditInFlightRef.current = true;
    (async () => {
      try {
        const pendingRows = await fetchPendingApprovals();
        if (pendingRows.some((p) => p.plan_id === planId)) return; // wait for next render
        const auditRes = await fetch("/api/audit?limit=200");
        if (!auditRes.ok) return;
        const entries = (await auditRes.json().catch(() => [])) as Array<Record<string, unknown>>;
        const decided = Array.isArray(entries)
          ? entries.find((e) => e && e.plan_id === planId)
          : null;
        if (decided) {
          let state: string = "resolved";
          const approval = decided.approval as { approved?: boolean } | undefined;
          const result = decided.result as string | undefined;
          if (approval && typeof approval.approved === "boolean") {
            state = approval.approved ? "approved" : "rejected";
          } else if (result === "blocked") {
            state = "rejected";
          } else if (result === "success") {
            state = "approved";
          } else if (result === "rolled_back" || result === "failed") {
            state = result.replace("_", " ");
          }
          addToast({
            type: "info",
            title: "Plan Resolved",
            message: `Plan ${planId.slice(0, 8)} has been ${state}.`,
          });
          deepLinkResolvedRef.current = true;
        }
      } catch {
        /* swallow — try again next render */
      } finally {
        deepLinkAuditInFlightRef.current = false;
      }
    })();
  });

  const decide = async (entry: PendingApproval, decision: "approve" | "reject") => {
    setBusy((b) => ({ ...b, [entry.plan_id]: decision }));
    setError(null);
    try {
      const operator = operatorFromEnv();
      const result = await submitApprovalDecision(entry.plan_id, decision, operator);
      removePendingApproval(entry.plan_id);
      addToast({
        type: decision === "approve" ? "success" : "warning",
        title: decision === "approve" ? "Plan Approved" : "Plan Rejected",
        message: `Plan ${result.plan_id.slice(0, 8)} — ${result.status}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Decision failed";
      setError(msg);
      addToast({ type: "error", title: "Approval Failed", message: msg });
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[entry.plan_id];
        return next;
      });
    }
  };

  const toggleExpanded = (planId: string) => {
    setExpanded((prev) => ({ ...prev, [planId]: !prev[planId] }));
  };

  if (pending.length === 0) {
    if (compact) return null;
    return (
      <div className="approvals-empty">
        <img
          className="approvals-empty-mark"
          src="/brand/rhodes-mark-white.svg"
          alt=""
          aria-hidden="true"
          onError={(e) => {
            // Fall back to the PNG copy bundled inside the dashboard-v2 public/
            // dir if the /brand/ static route can't resolve the SVG.
            (e.currentTarget as HTMLImageElement).src = "/rhodes-mark.png";
          }}
        />
        <div className="approvals-empty-text">All clear — no approvals waiting.</div>
        {error && <div className="approvals-error">{error}</div>}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`approvals-list${compact ? " approvals-list--compact" : ""}`}
    >
      {error && <div className="approvals-error">{error}</div>}
      {pending.map((entry) => {
        const state = busy[entry.plan_id];
        const safety = isSafetySnapshot(entry);
        const cls = tierClass(entry.tier);
        const label = tierLabel(entry.tier);
        const params = entry.params && typeof entry.params === "object" ? entry.params : {};
        const paramKeys = Object.keys(params).filter((k) => k !== "steps");
        const isExpanded = expanded[entry.plan_id] ?? false;

        return (
          <article
            key={entry.plan_id}
            className={`approval-card${safety ? " approval-card--safety" : ""}`}
            data-plan-id={entry.plan_id}
          >
            <header className="approval-card-header">
              <div className="approval-card-header-main">
                <span className="approval-action" title={entry.action}>{entry.action}</span>
                {safety && (
                  <span
                    className="approval-safety-badge"
                    title="Pre-remediation snapshot — non-destructive"
                  >
                    SAFETY SNAPSHOT
                  </span>
                )}
              </div>
              <div className="approval-card-header-meta">
                <span className={`status-rect tier-${cls}`}>{label}</span>
                <span className="approval-time">
                  plan {entry.plan_id.slice(0, 8)}
                  {entry.requested_at ? ` · ${timeAgo(entry.requested_at)}` : ""}
                </span>
              </div>
            </header>

            {entry.reasoning && (
              <button
                type="button"
                className={`approval-reasoning${isExpanded ? " approval-reasoning--expanded" : ""}`}
                onClick={() => toggleExpanded(entry.plan_id)}
                aria-expanded={isExpanded}
              >
                <span className="approval-reasoning-chevron" aria-hidden="true">
                  {isExpanded ? "▾" : "▸"}
                </span>
                {isExpanded ? entry.reasoning : `${entry.reasoning.slice(0, 140)}${entry.reasoning.length > 140 ? "…" : ""}`}
              </button>
            )}

            {isExpanded && paramKeys.length > 0 && (
              <div className="approval-params">
                {paramKeys.map((k) => {
                  const v = (params as Record<string, unknown>)[k];
                  const display = typeof v === "object" ? JSON.stringify(v) : String(v);
                  return (
                    <div key={k} className="approval-param-row">
                      <span className="approval-param-key">{k}</span>
                      <span className="approval-param-value">{display}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <footer className="approval-card-footer">
              <button
                type="button"
                className="approval-btn approval-btn--approve"
                disabled={state !== undefined}
                onClick={() => decide(entry, "approve")}
              >
                {state === "approve" ? (
                  <>
                    <span className="approval-spinner" /> Approving…
                  </>
                ) : (
                  "Approve"
                )}
              </button>
              <button
                type="button"
                className="approval-btn approval-btn--reject"
                disabled={state !== undefined}
                onClick={() => decide(entry, "reject")}
              >
                {state === "reject" ? (
                  <>
                    <span className="approval-spinner" /> Rejecting…
                  </>
                ) : (
                  "Reject"
                )}
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
