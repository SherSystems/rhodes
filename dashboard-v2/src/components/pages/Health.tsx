import { useEffect, useState } from "react";
import { fetchHealthz, type Healthz } from "../../api/client";

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export default function Health() {
  const [data, setData] = useState<Healthz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchHealthz();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load health");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Health</h2>
        <p className="page-subtitle">Live status of the RHODES agent. Refreshes every 5 seconds.</p>
      </div>

      {data?.shadow_mode && (
        <div
          style={{
            padding: "12px 16px",
            background: "var(--amber-muted)",
            color: "var(--amber)",
            border: "1px solid var(--amber)",
            borderRadius: 8,
            marginBottom: 16,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontSize: "0.78rem",
          }}
        >
          SHADOW MODE — RHODES is observing only. No state-changing actions will execute.
        </div>
      )}

      {loading && !data && <div className="empty-state">Loading health…</div>}
      {error && (
        <div className="empty-state" style={{ color: "var(--red)" }}>
          Health check failed: {error}
        </div>
      )}

      {data && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          <HealthCard label="Version" value={data.version} />
          <HealthCard label="Uptime" value={formatUptime(data.uptime_s)} />
          <HealthCard
            label="Mode"
            value={data.shadow_mode ? "Shadow (dry-run)" : "Active"}
            tone={data.shadow_mode ? "warn" : "ok"}
          />
          <HealthCard
            label="Providers connected"
            value={String(data.providers_connected)}
            hint="See Infrastructure for per-provider state"
          />
          <HealthCard
            label="Open incidents"
            value={String(data.open_incidents)}
            tone={data.open_incidents > 0 ? "warn" : "ok"}
          />
          <HealthCard label="Registered playbooks" value={String(data.registered_playbooks)} />
          <HealthCard label="SSE clients" value={String(data.sse_clients)} />
          <HealthCard label="Active plans (recent)" value={String(data.active_plans.length)} />
        </div>
      )}

      {data?.last_alert && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 8, fontSize: "0.92rem" }}>Last alert</h3>
          <div
            style={{
              padding: "12px 16px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              display: "grid",
              gap: 4,
            }}
          >
            <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
              {data.last_alert.type} · {new Date(data.last_alert.timestamp).toLocaleString()}
            </div>
            <div>{data.last_alert.summary ?? "(no summary)"}</div>
          </div>
        </div>
      )}

      {data && data.active_plans.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 8, fontSize: "0.92rem" }}>Recent plans</h3>
          <div style={{ display: "grid", gap: 4 }}>
            {data.active_plans.map((plan, i) => (
              <div
                key={`${plan.id ?? "plan"}-${i}`}
                style={{
                  padding: "8px 12px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: "0.82rem",
                  fontFamily: "var(--font-mono, monospace)",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{plan.id ?? "(no id)"} <span style={{ color: "var(--text-secondary)" }}>· {plan.mode ?? "watch"}</span></span>
                <span style={{ color: "var(--text-secondary)" }}>{new Date(plan.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HealthCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  const accentColor = tone === "warn" ? "var(--amber)" : tone === "ok" ? "var(--teal)" : "var(--text-accent)";
  return (
    <div
      style={{
        padding: "16px 18px",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        display: "grid",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: "0.71rem",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.35rem", fontWeight: 600, color: accentColor, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: "0.71rem", color: "var(--text-tertiary, var(--text-secondary))" }}>{hint}</div>}
    </div>
  );
}
