import { useState, useEffect, useCallback } from "react";
import { fetchApps, createApp, deleteApp } from "../api/client";
import type { Application, AppMember, AppDependency } from "../types";

function tierColor(tier: string): string {
  switch (tier) {
    case "production": return "var(--red)";
    case "staging": return "var(--amber)";
    case "development": return "#3b82f6";
    case "test": return "var(--text-tertiary)";
    default: return "var(--text-tertiary)";
  }
}

function tierBgColor(tier: string): string {
  switch (tier) {
    case "production": return "rgba(239,68,68,0.15)";
    case "staging": return "rgba(245,158,11,0.15)";
    case "development": return "rgba(59,130,246,0.15)";
    case "test": return "rgba(148,163,184,0.15)";
    default: return "rgba(148,163,184,0.15)";
  }
}

function providerNodeColor(provider: string): string {
  switch (provider) {
    case "vmware": return "#4B91E2";
    case "proxmox": return "#2dd4bf";
    case "aws": return "#FF9900";
    case "kubernetes": return "#326CE5";
    default: return "#2dd4bf";
  }
}

const ROLE_LAYERS: Record<string, number> = {
  gateway: 0, web: 0, api: 0,
  cache: 1, worker: 1, queue: 1,
  database: 2, storage: 2,
};

function getNodeLayer(role: string): number {
  return ROLE_LAYERS[role] ?? 1;
}

export default function AppTopology() {
  const [apps, setApps] = useState<Application[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createTier, setCreateTier] = useState<string>("production");
  const [createOwner, setCreateOwner] = useState("");
  const [loading, setLoading] = useState(true);

  const loadApps = useCallback(async () => {
    try {
      const data = await fetchApps();
      setApps(data);
    } catch {
      // silent — API might not be ready
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadApps();
    const interval = setInterval(loadApps, 15000);
    return () => clearInterval(interval);
  }, [loadApps]);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    try {
      const app = await createApp({
        name: createName.trim(),
        tier: createTier,
        owner: createOwner.trim() || undefined,
      });
      setApps((prev) => [...prev, app]);
      setSelectedAppId(app.id);
      setShowCreate(false);
      setCreateName("");
      setCreateOwner("");
    } catch {
      // error handled silently
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteApp(id);
      setApps((prev) => prev.filter((a) => a.id !== id));
      if (selectedAppId === id) setSelectedAppId(null);
    } catch {
      // error handled silently
    }
  };

  const selectedApp = apps.find((a) => a.id === selectedAppId) ?? null;

  return (
    <div style={{ display: "flex", gap: 0, minHeight: 500 }}>
      {/* Left panel — app list */}
      <div style={{
        width: 300,
        minWidth: 300,
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-secondary)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            Applications
          </span>
          <button
            onClick={() => setShowCreate(!showCreate)}
            style={{
              background: showCreate ? "var(--border)" : "var(--teal)",
              color: showCreate ? "var(--text-primary)" : "#000",
              border: "none",
              borderRadius: 6,
              width: 28,
              height: 28,
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {showCreate ? "\u00d7" : "+"}
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "var(--bg-card)",
          }}>
            <input
              placeholder="App name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              style={{
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 10px",
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
              }}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
            <select
              value={createTier}
              onChange={(e) => setCreateTier(e.target.value)}
              style={{
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 10px",
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
              }}
            >
              <option value="production">Production</option>
              <option value="staging">Staging</option>
              <option value="development">Development</option>
              <option value="test">Test</option>
            </select>
            <input
              placeholder="Owner (optional)"
              value={createOwner}
              onChange={(e) => setCreateOwner(e.target.value)}
              style={{
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 10px",
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleCreate}
                style={{
                  flex: 1,
                  background: "var(--teal)",
                  color: "#000",
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 0",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Save
              </button>
              <button
                onClick={() => { setShowCreate(false); setCreateName(""); setCreateOwner(""); }}
                style={{
                  flex: 1,
                  background: "var(--bg-tertiary)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 0",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* App list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              Loading...
            </div>
          )}
          {!loading && apps.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              No applications defined yet.
            </div>
          )}
          {apps.map((app) => (
            <div
              key={app.id}
              onClick={() => setSelectedAppId(app.id)}
              style={{
                padding: "10px 16px",
                cursor: "pointer",
                borderBottom: "1px solid var(--border)",
                background: selectedAppId === app.id ? "rgba(45,212,191,0.08)" : "transparent",
                borderLeft: selectedAppId === app.id ? "3px solid var(--teal)" : "3px solid transparent",
                transition: "background 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>
                  {app.name}
                </span>
                <span style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: tierBgColor(app.tier),
                  color: tierColor(app.tier),
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}>
                  {app.tier === "production" ? "PROD" : app.tier === "development" ? "DEV" : app.tier.toUpperCase()}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(app.id); }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-tertiary)",
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "0 2px",
                    lineHeight: 1,
                  }}
                  title="Delete app"
                >
                  &times;
                </button>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-tertiary)" }}>
                <span>{app.members.length} member{app.members.length !== 1 ? "s" : ""}</span>
                <span>{app.dependencies.length} dep{app.dependencies.length !== 1 ? "s" : ""}</span>
                {app.owner && <span>@{app.owner}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — graph visualization */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        {!selectedApp && (
          <div style={{ color: "var(--text-tertiary)", fontSize: 14, textAlign: "center", padding: 40 }}>
            Select an application to view its topology
          </div>
        )}
        {selectedApp && selectedApp.members.length === 0 && (
          <div style={{ color: "var(--text-tertiary)", fontSize: 13, textAlign: "center", padding: 40, maxWidth: 420, lineHeight: 1.6 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
              No members yet
            </div>
            <div>
              Use the CLI to add VMs:
            </div>
            <code style={{
              display: "inline-block",
              marginTop: 8,
              padding: "6px 12px",
              borderRadius: 6,
              background: "var(--bg-tertiary)",
              color: "var(--teal)",
              fontSize: 12,
            }}>
              vclaw cli 'add vm-123 to app {selectedApp.name} as web server'
            </code>
          </div>
        )}
        {selectedApp && selectedApp.members.length > 0 && (
          <AppGraph app={selectedApp} />
        )}
      </div>
    </div>
  );
}

function AppGraph({ app }: { app: Application }) {
  const members = app.members;
  const deps = app.dependencies;

  // Group members by layer
  const layers: AppMember[][] = [[], [], []];
  for (const m of members) {
    const layer = getNodeLayer(m.role);
    layers[layer].push(m);
  }

  const nodeW = 160;
  const nodeH = 70;
  const hSpacing = 200;
  const vSpacing = 120;
  const padX = 40;
  const padY = 40;

  // Calculate positions
  const maxPerRow = Math.max(1, ...layers.map((l) => l.length));
  const svgWidth = Math.max(500, maxPerRow * hSpacing + padX * 2);
  const svgHeight = 3 * vSpacing + padY * 2 + nodeH;

  const positions: Record<string, { x: number; y: number }> = {};
  for (let row = 0; row < 3; row++) {
    const rowMembers = layers[row];
    const rowWidth = rowMembers.length * hSpacing;
    const startX = (svgWidth - rowWidth) / 2 + hSpacing / 2;
    for (let col = 0; col < rowMembers.length; col++) {
      positions[rowMembers[col].workloadId] = {
        x: startX + col * hSpacing,
        y: padY + row * vSpacing + nodeH / 2,
      };
    }
  }

  // Build edges
  const edges: { dep: AppDependency; from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
  for (const dep of deps) {
    const from = positions[dep.fromWorkloadId];
    const to = positions[dep.toWorkloadId];
    if (from && to) {
      edges.push({ dep, from, to });
    }
  }

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      style={{ maxWidth: "100%", overflow: "visible" }}
    >
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="var(--text-tertiary)" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge, i) => {
        const dx = edge.to.x - edge.from.x;
        const dy = edge.to.y - edge.from.y;
        const midY = (edge.from.y + edge.to.y) / 2;
        const labelX = (edge.from.x + edge.to.x) / 2;
        return (
          <g key={`edge-${i}`}>
            <path
              d={`M ${edge.from.x},${edge.from.y + nodeH / 2} C ${edge.from.x},${midY + nodeH / 4} ${edge.to.x},${midY + nodeH / 4} ${edge.to.x},${edge.to.y - nodeH / 2}`}
              fill="none"
              stroke="var(--text-tertiary)"
              strokeWidth={1.5}
              opacity={0.5}
              markerEnd="url(#arrowhead)"
            />
            <text
              x={labelX}
              y={midY + 4}
              textAnchor="middle"
              fill="var(--text-tertiary)"
              fontSize={10}
            >
              {edge.dep.service}:{edge.dep.port}
            </text>
          </g>
        );
      })}

      {/* Nodes */}
      {members.map((member) => {
        const pos = positions[member.workloadId];
        if (!pos) return null;
        const color = providerNodeColor(member.provider);
        const rx = pos.x - nodeW / 2;
        const ry = pos.y - nodeH / 2;

        return (
          <g key={member.workloadId}>
            <rect
              x={rx}
              y={ry}
              width={nodeW}
              height={nodeH}
              rx={10}
              fill="var(--bg-card)"
              stroke={color}
              strokeWidth={member.critical ? 2 : 1.5}
            />
            {/* Provider color bar */}
            <rect
              x={rx}
              y={ry}
              width={4}
              height={nodeH}
              rx={2}
              fill={color}
            />
            {/* Name */}
            <text
              x={pos.x + 4}
              y={pos.y - 6}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize={12}
              fontWeight={600}
            >
              {(member.name ?? member.workloadId).length > 18
                ? (member.name ?? member.workloadId).slice(0, 18) + "\u2026"
                : member.name ?? member.workloadId}
            </text>
            {/* Role */}
            <text
              x={pos.x + 4}
              y={pos.y + 10}
              textAnchor="middle"
              fill="var(--text-tertiary)"
              fontSize={10}
            >
              {member.role}
            </text>
            {/* Critical badge */}
            {member.critical && (
              <>
                <rect
                  x={rx + nodeW - 46}
                  y={ry + 4}
                  width={40}
                  height={16}
                  rx={4}
                  fill="rgba(239,68,68,0.15)"
                />
                <text
                  x={rx + nodeW - 26}
                  y={ry + 15}
                  textAnchor="middle"
                  fill="var(--red)"
                  fontSize={9}
                  fontWeight={700}
                >
                  CRIT
                </text>
              </>
            )}
            {/* Provider label */}
            <text
              x={pos.x + 4}
              y={pos.y + 24}
              textAnchor="middle"
              fill={color}
              fontSize={9}
              opacity={0.7}
            >
              {member.provider}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
