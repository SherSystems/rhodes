import { useEffect, useState } from "react";
import { useStore } from "../store";
import { fetchHealthz, type Healthz } from "../api/client";

function formatUptime(seconds: number | undefined): string {
  if (!Number.isFinite(seconds) || (seconds ?? 0) <= 0) return "0s";
  const s = Math.round(seconds as number);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : `${h}h`;
}

export function Header() {
  const connected = useStore((s) => s.connected);
  const [health, setHealth] = useState<Healthz | null>(null);

  // Poll /healthz every 10s to keep version, shadow_mode, and provider count
  // fresh. This is the only place we need it — keep the request cheap.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchHealthz();
        if (!cancelled) setHealth(data);
      } catch {
        /* non-fatal — header gracefully degrades */
      }
    };
    load();
    const id = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const shadowOn = health?.shadow_mode ?? false;
  const version = health?.version ?? "—";
  const uptime = formatUptime(health?.uptime_s);
  const providers = health?.providers_connected ?? 0;
  const sseClients = health?.sse_clients ?? 0;

  return (
    <header className="rhodes-header">
      <div className="rhodes-header-brand">
        <img
          className="rhodes-header-lockup"
          src="/brand/rhodes-lockup.png"
          alt="RHODES"
          onError={(e) => {
            // /brand/ serves the SVG/PNG copies; fall back to the bundled
            // PNG in dashboard-v2/public/ if the static route 404s.
            const el = e.currentTarget as HTMLImageElement;
            if (!el.dataset.fallback) {
              el.dataset.fallback = "1";
              el.src = "/rhodes-lockup.png";
            }
          }}
        />
        <span className="rhodes-header-tagline">Infrastructure, executed.</span>
      </div>

      <div className="rhodes-header-status">
        <span className="status-rect status-rect--version" title={`RHODES v${version}`}>
          v{version}
        </span>

        <span
          className={`status-rect ${shadowOn ? "status-rect--shadow-on" : "status-rect--shadow-off"}`}
          title={shadowOn ? "Shadow mode active — actions are dry-run" : "Shadow mode off — live execution"}
        >
          <span
            className={`shadow-dot${shadowOn ? " shadow-dot--on" : " shadow-dot--off"}`}
            aria-hidden="true"
          />
          {shadowOn ? "SHADOW ON" : "SHADOW OFF"}
        </span>

        <span className="status-rect" title="Process uptime">
          UPTIME&nbsp;<span className="status-rect-num">{uptime}</span>
        </span>

        <span className="status-rect" title="Connected providers">
          PROV&nbsp;<span className="status-rect-num">{providers}</span>
        </span>

        <span className="status-rect" title="Connected SSE clients">
          SSE&nbsp;<span className="status-rect-num">{sseClients}</span>
        </span>

        <span
          className={`status-rect status-rect--conn ${connected ? "is-live" : "is-down"}`}
          title={connected ? "Live event stream" : "Reconnecting…"}
        >
          <span className={`conn-dot${connected ? " live" : ""}`} aria-hidden="true" />
          {connected ? "LIVE" : "DOWN"}
        </span>
      </div>
    </header>
  );
}

export default Header;
