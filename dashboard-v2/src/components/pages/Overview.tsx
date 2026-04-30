import { useMemo } from "react";
import type { ReactElement } from "react";
import { useStore } from "../../store";
import type { TabId } from "../../types";

/* ── Ring Gauge ──────────────────────────────────────── */
function Ring({
  value,
  max,
  color,
  size = 110,
}: {
  value: number;
  max: number;
  color: string;
  size?: number;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth="7"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dy="0.35em"
        fill="var(--text-primary)"
        fontSize="22"
        fontWeight="700"
      >
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

function ringColor(pct: number): string {
  if (pct >= 80) return "var(--red)";
  if (pct >= 60) return "var(--amber)";
  return "var(--green)";
}

/* ── Helpers ─────────────────────────────────────────── */
function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function eventIcon(type: string): string {
  const map: Record<string, string> = {
    health_check: "pulse",
    plan_created: "plan",
    step_completed: "check",
    step_failed: "x",
    incident_detected: "alert",
    incident_resolved: "shield",
    cluster_state: "server",
    mode_change: "toggle",
    migration_completed: "move",
    chaos_started: "zap",
  };
  return map[type] || "dot";
}

function eventLabel(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── Overview Page ───────────────────────────────────── */
export default function Overview() {
  const connected = useStore((s) => s.connected);
  const multiCluster = useStore((s) => s.multiCluster);
  const cluster = useStore((s) => s.cluster);
  const lastHealth = useStore((s) => s.lastHealth);
  const activeIncidents = useStore((s) => s.activeIncidents);
  const events = useStore((s) => s.events);
  const setActiveTab = useStore((s) => s.setActiveTab);

  /* ── Aggregate metrics across all providers ─────────
   *
   * NOTE: This mirrors the backend aggregator at
   *   src/providers/aggregator.ts (aggregateClusterSummary)
   * which is the single source of truth. The same bugs were
   * fixed in both spots:
   *   - Skip "topology" + "system" pseudo-providers
   *   - Cores-weighted CPU avg, ignoring nodes that report 0%
   *     (e.g. k8s without metrics-server) so they don't drag
   *     the average down
   *   - Track containers (k8s pods, proxmox LXC) separately
   *     so VM totals stay = real VMs only
   *   - All values default to 0 (never NaN) on missing data
   */
  const agg = useMemo(() => {
    let totalCpuCores = 0;
    let weightedCpuPct = 0;
    let weightedCpuDenom = 0;
    let totalRamMb = 0;
    let usedRamMb = 0;
    let totalDiskGb = 0;
    let usedDiskGb = 0;
    let totalVms = 0;
    let runningVms = 0;
    let totalContainers = 0;
    let runningContainers = 0;
    let totalNodes = 0;

    const providers = (multiCluster?.providers ?? []).filter(
      (p) => p.type !== "topology" && (p.type as string) !== "system"
    );

    const accumulate = (state: {
      nodes: ReadonlyArray<{
        cpu_cores?: number;
        cpu_usage_pct?: number;
        cpu_pct?: number;
        ram_total_mb?: number;
        ram_used_mb?: number;
        disk_total_gb?: number;
        disk_used_gb?: number;
      }>;
      vms: ReadonlyArray<{ status?: string }>;
      containers?: ReadonlyArray<{ status?: string }>;
    }) => {
      for (const node of state.nodes) {
        const cores = Number.isFinite(node.cpu_cores) ? (node.cpu_cores as number) : 0;
        const cpuPct = Number.isFinite(node.cpu_usage_pct ?? node.cpu_pct)
          ? ((node.cpu_usage_pct ?? node.cpu_pct) as number)
          : 0;
        totalCpuCores += cores;
        if (cores > 0 && cpuPct > 0) {
          weightedCpuPct += cpuPct * cores;
          weightedCpuDenom += cores;
        }
        totalRamMb += Number.isFinite(node.ram_total_mb) ? (node.ram_total_mb as number) : 0;
        usedRamMb += Number.isFinite(node.ram_used_mb) ? (node.ram_used_mb as number) : 0;
        totalDiskGb += Number.isFinite(node.disk_total_gb) ? (node.disk_total_gb as number) : 0;
        usedDiskGb += Number.isFinite(node.disk_used_gb) ? (node.disk_used_gb as number) : 0;
        totalNodes++;
      }
      for (const vm of state.vms) {
        totalVms++;
        if (vm.status === "running") runningVms++;
      }
      for (const ct of state.containers ?? []) {
        totalContainers++;
        if (ct.status === "running") runningContainers++;
      }
    };

    if (providers.length > 0) {
      for (const prov of providers) accumulate(prov.state);
    } else if (cluster) {
      accumulate(cluster);
    }

    // Fall back to lastHealth only when we genuinely have no signal
    const cpuPct =
      weightedCpuDenom > 0
        ? weightedCpuPct / weightedCpuDenom
        : lastHealth?.resources?.cpu_usage_pct ?? 0;
    const ramPct =
      totalRamMb > 0
        ? (usedRamMb / totalRamMb) * 100
        : lastHealth?.resources?.ram_usage_pct ?? 0;
    const diskPct =
      totalDiskGb > 0
        ? (usedDiskGb / totalDiskGb) * 100
        : lastHealth?.resources?.disk_usage_pct ?? 0;

    return {
      totalCpuCores,
      cpuPct,
      totalRamMb,
      usedRamMb,
      ramPct,
      totalDiskGb,
      usedDiskGb,
      diskPct,
      totalVms,
      runningVms,
      totalContainers,
      runningContainers,
      totalNodes,
    };
  }, [multiCluster, cluster, lastHealth]);

  /* ── Provider summaries ───────────────────────────── */
  const providerSummaries = useMemo(() => {
    const providers = (multiCluster?.providers ?? []).filter(
      (p) => p.type !== "topology"
    );
    return providers.map((prov) => {
      const st = prov.state;
      const nodeCount = st.nodes.length;
      const vmTotal = st.vms.length;
      const vmRunning = st.vms.filter((v) => v.status === "running").length;
      let storageUsed = 0;
      let storageTotal = 0;
      for (const node of st.nodes) {
        storageUsed += node.disk_used_gb || 0;
        storageTotal += node.disk_total_gb || 0;
      }
      const allOnline = st.nodes.every(
        (n) => n.status === "online" || n.status === "running"
      );
      return {
        name: prov.name,
        type: prov.type,
        nodeCount,
        vmTotal,
        vmRunning,
        storageUsed,
        storageTotal,
        healthy: allOnline,
      };
    });
  }, [multiCluster]);

  const nonTopoProviders = (multiCluster?.providers ?? []).filter(
    (p) => p.type !== "topology"
  );
  const providerCount = nonTopoProviders.length || (cluster ? 1 : 0);
  const providerNames = nonTopoProviders.map((p) => p.name);

  const criticalCount = activeIncidents.filter(
    (i) => i.severity === "critical"
  ).length;
  const warningCount = activeIncidents.filter(
    (i) => i.severity === "warning"
  ).length;

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const recentEvents = events.slice(-8).reverse();

  const nav = (tab: TabId) => () => setActiveTab(tab);

  /* ── Provider color dot ───────────────────────────── */
  function providerColor(type: string): string {
    const map: Record<string, string> = {
      proxmox: "#FF9500",
      vmware: "#4B91E2",
      aws: "#FF9900",
      azure: "#4B91E2",
      gcp: "#22c55e",
      kubernetes: "#326CE5",
    };
    return map[type.toLowerCase()] || "var(--text-secondary)";
  }

  return (
    <div className="overview">
      {/* ── Row 1: Status Cards ─────────────────────── */}
      <div className="ov-stats">
        {/* Providers */}
        <div className="ov-stat-card">
          <div className="ov-stat-accent" style={{ background: "var(--blue)" }} />
          <div className="ov-stat-body">
            <div className="ov-stat-value">{providerCount}</div>
            <div className="ov-stat-label">Providers</div>
            {providerNames.length > 0 && (
              <div className="ov-stat-tags">
                {providerNames.map((n) => (
                  <span key={n} className="ov-tag">{n}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Total VMs */}
        <div className="ov-stat-card">
          <div className="ov-stat-accent" style={{ background: "var(--teal)" }} />
          <div className="ov-stat-body">
            <div className="ov-stat-value">
              {agg.totalVms}
              <span className="ov-stat-sub">
                {" "}
                / {agg.runningVms} running
              </span>
            </div>
            <div className="ov-stat-label">Total VMs</div>
            {agg.totalVms > 0 && (
              <div className="ov-running-bar">
                <div
                  className="ov-running-fill"
                  style={{
                    width: `${(agg.runningVms / agg.totalVms) * 100}%`,
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Active Incidents */}
        <div className="ov-stat-card">
          <div
            className="ov-stat-accent"
            style={{
              background:
                activeIncidents.length > 0 ? "var(--red)" : "var(--green)",
            }}
          />
          <div className="ov-stat-body">
            <div
              className="ov-stat-value"
              style={{
                color:
                  activeIncidents.length > 0 ? "var(--red)" : "var(--green)",
              }}
            >
              {activeIncidents.length}
            </div>
            <div className="ov-stat-label">Active Incidents</div>
            {activeIncidents.length > 0 && (
              <div className="ov-stat-tags">
                {criticalCount > 0 && (
                  <span className="ov-tag ov-tag-red">
                    {criticalCount} critical
                  </span>
                )}
                {warningCount > 0 && (
                  <span className="ov-tag ov-tag-amber">
                    {warningCount} warning
                  </span>
                )}
              </div>
            )}
            {activeIncidents.length === 0 && (
              <div className="ov-stat-hint">All clear</div>
            )}
          </div>
        </div>

        {/* Agent Status */}
        <div className="ov-stat-card">
          <div
            className="ov-stat-accent"
            style={{
              background: connected ? "var(--green)" : "var(--red)",
            }}
          />
          <div className="ov-stat-body">
            <div className="ov-stat-value">
              <span
                className="ov-agent-dot"
                style={{
                  background: connected ? "var(--green)" : "var(--red)",
                }}
              />
              {connected ? "Online" : "Offline"}
            </div>
            <div className="ov-stat-label">Agent Status</div>
            {lastEvent && (
              <div className="ov-stat-hint">
                Last event {timeAgo(lastEvent.timestamp)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2: Resource Gauges ──────────────────── */}
      <div className="ov-gauges">
        <div className="ov-gauge-card">
          <Ring
            value={agg.cpuPct}
            max={100}
            color={ringColor(agg.cpuPct)}
            size={110}
          />
          <div className="ov-gauge-label">CPU</div>
          <div className="ov-gauge-detail">
            {agg.totalCpuCores} cores total
          </div>
        </div>

        <div className="ov-gauge-card">
          <Ring
            value={agg.usedRamMb}
            max={agg.totalRamMb}
            color={ringColor(agg.ramPct)}
            size={110}
          />
          <div className="ov-gauge-label">Memory</div>
          <div className="ov-gauge-detail">
            {(agg.usedRamMb / 1024).toFixed(1)} /{" "}
            {(agg.totalRamMb / 1024).toFixed(1)} GB
          </div>
        </div>

        <div className="ov-gauge-card">
          <Ring
            value={agg.usedDiskGb}
            max={agg.totalDiskGb}
            color={ringColor(agg.diskPct)}
            size={110}
          />
          <div className="ov-gauge-label">Storage</div>
          <div className="ov-gauge-detail">
            {agg.usedDiskGb.toFixed(1)} / {agg.totalDiskGb.toFixed(1)} GB
          </div>
        </div>
      </div>

      {/* ── Row 3: Split — Providers + Activity ─────── */}
      <div className="ov-split">
        {/* Left: Provider Overview */}
        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-card-title">Provider Overview</span>
            <span className="ov-card-badge">{providerSummaries.length}</span>
          </div>
          <div className="ov-card-body">
            {providerSummaries.length === 0 ? (
              <div className="ov-empty">No providers connected</div>
            ) : (
              <div className="ov-provider-list">
                {providerSummaries.map((prov) => (
                  <div key={prov.name} className="ov-provider-row" style={{ borderLeft: `3px solid ${providerColor(prov.type)}` }}>
                    <div className="ov-provider-name">
                      <span
                        className="ov-provider-dot"
                        style={{ background: providerColor(prov.type) }}
                      />
                      <span>{prov.name}</span>
                      <span
                        className={`ov-health-badge ${
                          prov.healthy ? "healthy" : "degraded"
                        }`}
                      >
                        {prov.healthy ? "healthy" : "degraded"}
                      </span>
                    </div>
                    <div className="ov-provider-metrics">
                      <span>
                        <strong>{prov.vmRunning}</strong>/{prov.vmTotal} VMs
                      </span>
                      <span>
                        <strong>{prov.nodeCount}</strong> nodes
                      </span>
                      <span>
                        {prov.storageUsed.toFixed(0)}/{prov.storageTotal.toFixed(0)} GB
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Recent Activity */}
        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-card-title">Recent Activity</span>
            <span className="ov-card-badge">{events.length} total</span>
          </div>
          <div className="ov-card-body ov-activity-body">
            {recentEvents.length === 0 ? (
              <div className="ov-empty ov-empty-pulse">Waiting for events...</div>
            ) : (
              <div className="ov-activity-list">
                {recentEvents.map((ev, i) => (
                  <div key={i} className="ov-activity-item">
                    <span className={`ov-activity-icon ${eventIcon(ev.type)}`}>
                      {eventIconSvg(ev.type)}
                    </span>
                    <div className="ov-activity-text">
                      <span className="ov-activity-type">
                        {eventLabel(ev.type)}
                      </span>
                      {ev.data?.description != null && (
                        <span className="ov-activity-desc">
                          {String(ev.data.description as string).slice(0, 60)}
                        </span>
                      )}
                    </div>
                    <span className="ov-activity-time">
                      {timeAgo(ev.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 4: Quick Actions ────────────────────── */}
      <div className="ov-actions">
        <button className="ov-action-btn" onClick={nav("infrastructure")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
          View Topology
        </button>
        <button className="ov-action-btn" onClick={nav("migrations")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          Plan Migration
        </button>
        <button className="ov-action-btn" onClick={nav("applications")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          View Applications
        </button>
        <button className="ov-action-btn" onClick={nav("chaos")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          Run Chaos Test
        </button>
      </div>
    </div>
  );
}

/* ── Tiny SVG icons for event types ─────────────────── */
function eventIconSvg(type: string): ReactElement {
  const icon = eventIcon(type);
  const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (icon) {
    case "pulse":
      return (
        <svg {...props}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      );
    case "plan":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
    case "check":
      return (
        <svg {...props}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case "x":
      return (
        <svg {...props}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case "alert":
      return (
        <svg {...props}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "shield":
      return (
        <svg {...props}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "server":
      return (
        <svg {...props}>
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        </svg>
      );
    case "toggle":
      return (
        <svg {...props}>
          <rect x="1" y="5" width="22" height="14" rx="7" ry="7" />
          <circle cx="16" cy="12" r="3" />
        </svg>
      );
    case "move":
      return (
        <svg {...props}>
          <polyline points="15 3 21 3 21 9" />
          <line x1="21" y1="3" x2="14" y2="10" />
        </svg>
      );
    case "zap":
      return (
        <svg {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}
