import { useEffect, useState } from "react";
import { fetchPlaybooks, type PlaybookSummary } from "../../api/client";

export default function Playbooks() {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Local enabled-state overlay. Persistence lives server-side once the
  // playbook registry exposes toggles — for now the UI tracks intent.
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
    const id = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
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
        <h2>Playbooks</h2>
        <p className="page-subtitle">
          Event classes RHODES can recognize and respond to. Toggles are local-only until the
          registry exposes server-side persistence.
        </p>
      </div>

      {loading && !playbooks && <div className="empty-state">Loading playbooks…</div>}
      {error && (
        <div className="empty-state" style={{ color: "var(--red)" }}>
          Failed to load playbooks: {error}
        </div>
      )}
      {playbooks && playbooks.length === 0 && (
        <div className="empty-state">
          No playbooks registered. The healing orchestrator may not be wired in this mode.
        </div>
      )}

      {playbooks && playbooks.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {playbooks.map((p) => {
            const disabled = disabledIds.has(p.id);
            return (
              <div
                key={p.id}
                style={{
                  padding: "14px 16px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 12,
                  alignItems: "start",
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <code
                      style={{
                        fontSize: "0.71rem",
                        color: "var(--text-secondary)",
                        fontFamily: "var(--font-mono, monospace)",
                      }}
                    >
                      {p.id}
                    </code>
                    {p.requires_approval && (
                      <span
                        style={{
                          fontSize: "0.64rem",
                          padding: "1px 6px",
                          borderRadius: 3,
                          background: "var(--amber-muted)",
                          color: "var(--amber)",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                        }}
                      >
                        Approval
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>{p.description}</div>
                  <div
                    style={{
                      fontSize: "0.71rem",
                      color: "var(--text-tertiary, var(--text-secondary))",
                      display: "flex",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      Trigger: <code>{p.trigger.metric}</code> ({p.trigger.type}
                      {p.trigger.severity ? `, ${p.trigger.severity}` : ""})
                    </span>
                    <span>Cooldown: {p.cooldown_minutes}m</span>
                    <span>
                      Last triggered:{" "}
                      {p.last_triggered_at
                        ? new Date(p.last_triggered_at).toLocaleString()
                        : "never"}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => toggle(p.id)}
                  style={{
                    padding: "6px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: disabled ? "transparent" : "var(--teal-muted)",
                    color: disabled ? "var(--text-secondary)" : "var(--teal)",
                    cursor: "pointer",
                    fontSize: "0.78rem",
                    fontWeight: 500,
                  }}
                >
                  {disabled ? "Disabled" : "Enabled"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
