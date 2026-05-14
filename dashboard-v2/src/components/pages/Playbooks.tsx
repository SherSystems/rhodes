import { useEffect, useState } from "react";
import { fetchPlaybooks, type PlaybookSummary } from "../../api/client";

/* ── Per-trigger visual treatment ──────────────────────────
 *
 * Each trigger metric gets a distinct icon + accent so the operator can
 * scan a wall of playbooks and immediately see "this is storage vs VM
 * status vs HTTP probe." Colors come from the BRAND_BIBLE palette.
 */
type TriggerStyle = {
  color: string;
  bg: string;
  icon: React.ReactElement;
  label: string;
};

const TRIGGER_STYLES: Record<string, TriggerStyle> = {
  node_cpu_pct: {
    color: "var(--blue)",
    bg: "rgba(77, 163, 247, 0.10)",
    label: "CPU",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="10" height="10" rx="1" />
        <rect x="6" y="6" width="4" height="4" />
        <line x1="1" y1="6" x2="3" y2="6" /><line x1="1" y1="10" x2="3" y2="10" />
        <line x1="13" y1="6" x2="15" y2="6" /><line x1="13" y1="10" x2="15" y2="10" />
        <line x1="6" y1="1" x2="6" y2="3" /><line x1="10" y1="1" x2="10" y2="3" />
        <line x1="6" y1="13" x2="6" y2="15" /><line x1="10" y1="13" x2="10" y2="15" />
      </svg>
    ),
  },
  node_mem_pct: {
    color: "var(--amber)",
    bg: "rgba(245, 166, 35, 0.10)",
    label: "MEMORY",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1" y="5" width="14" height="6" rx="0.5" />
        <line x1="4" y1="5" x2="4" y2="11" /><line x1="8" y1="5" x2="8" y2="11" /><line x1="12" y1="5" x2="12" y2="11" />
      </svg>
    ),
  },
  node_disk_pct: {
    color: "var(--purple)",
    bg: "rgba(167, 139, 250, 0.10)",
    label: "STORAGE",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="8" cy="4" rx="6" ry="2" />
        <path d="M2 4 v8 a6 2 0 0 0 12 0 V4" />
        <path d="M2 8 a6 2 0 0 0 12 0" />
      </svg>
    ),
  },
  vm_status: {
    color: "var(--red)",
    bg: "rgba(239, 68, 68, 0.10)",
    label: "VM STATUS",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="12" rx="1" />
        <circle cx="8" cy="8" r="2" />
      </svg>
    ),
  },
  service_http_status: {
    color: "var(--green)",
    bg: "rgba(34, 197, 94, 0.10)",
    label: "HTTP PROBE",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" />
        <line x1="2" y1="8" x2="14" y2="8" />
        <path d="M8 2 a8 8 0 0 1 0 12 a8 8 0 0 1 0 -12" />
      </svg>
    ),
  },
};

const DEFAULT_STYLE: TriggerStyle = {
  color: "var(--text-secondary)",
  bg: "rgba(255, 255, 255, 0.06)",
  label: "GENERIC",
  icon: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="5" x2="8" y2="9" />
      <line x1="8" y1="11" x2="8" y2="11.5" />
    </svg>
  ),
};

function styleFor(metric: string): TriggerStyle {
  return TRIGGER_STYLES[metric] ?? DEFAULT_STYLE;
}

export default function Playbooks() {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabledIds, setDisabledIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { playbooks: data } = await fetchPlaybooks();
        if (cancelled) return;
        setPlaybooks(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load playbooks");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const toggle = (id: string) => {
    setDisabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Playbooks</h2>
          <p className="page-subtitle">
            Event classes RHODES can recognize and respond to. Toggles are local-only until the
            registry exposes server-side persistence.
          </p>
        </div>
      </div>

      {loading && !playbooks && (
        <div className="empty-state empty-state--inline">Loading playbooks…</div>
      )}
      {error && (
        <div className="empty-state empty-state--inline" style={{ color: "var(--red)" }}>
          Failed to load playbooks: {error}
        </div>
      )}
      {playbooks && playbooks.length === 0 && (
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
          <div className="empty-state-text">
            No playbooks registered. The healing orchestrator may not be wired in this mode.
          </div>
        </div>
      )}

      {playbooks && playbooks.length > 0 && (
        <div className="playbook-grid">
          {playbooks.map((p) => {
            const disabled = disabledIds.has(p.id);
            const style = styleFor(p.trigger.metric);
            return (
              <article key={p.id} className={`playbook-card${disabled ? " is-disabled" : ""}`}>
                <div className="playbook-card-head">
                  <span
                    className="playbook-card-icon"
                    style={{ color: style.color, background: style.bg }}
                  >
                    {style.icon}
                  </span>
                  <div className="playbook-card-title-row">
                    <span className="playbook-card-name">{p.name}</span>
                    <code className="playbook-card-id">{p.id}</code>
                  </div>
                  {p.requires_approval && (
                    <span className="status-rect status-rect--approval">APPROVAL</span>
                  )}
                </div>
                <div className="playbook-card-desc">{p.description}</div>
                <div className="playbook-card-meta">
                  <span className="status-rect" style={{ color: style.color, background: style.bg }}>
                    {style.label}
                  </span>
                  <span className="playbook-card-trigger">
                    on <code>{p.trigger.metric}</code>
                    {p.trigger.severity ? ` · ${p.trigger.severity}` : ""}
                  </span>
                  <span className="playbook-card-cooldown">cooldown {p.cooldown_minutes}m</span>
                  <span className="playbook-card-last">
                    last:&nbsp;
                    {p.last_triggered_at
                      ? new Date(p.last_triggered_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "never"}
                  </span>
                </div>
                <button
                  type="button"
                  className={`playbook-card-toggle${disabled ? " is-disabled" : ""}`}
                  onClick={() => toggle(p.id)}
                >
                  {disabled ? "Disabled" : "Enabled"}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
