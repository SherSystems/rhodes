// API client for vClaw dashboard

const BASE = "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Cluster
export const fetchCluster = () =>
  request<import("../types").ClusterState>("/api/cluster");

export const fetchMultiCluster = () =>
  request<import("../types").MultiClusterState>("/api/cluster/all");

// Incidents
export const fetchIncidents = () =>
  request<{
    open: import("../types").Incident[];
    recent: import("../types").Incident[];
    patterns: unknown[];
  }>("/api/incidents");

// Audit
export const fetchAudit = (limit = 100) =>
  request<import("../types").AuditEntry[]>(`/api/audit?limit=${limit}`);

export const fetchAuditStats = () =>
  request<Record<string, unknown>>("/api/audit/stats");

export const fetchRunTelemetry = (days = 7) =>
  request<import("../types").RunTelemetrySummary>(
    `/api/telemetry/runs?days=${encodeURIComponent(String(days))}`,
  );

// Health
export const fetchPredictions = () =>
  request<{ predictions: import("../types").Prediction[] }>("/api/health/predictions");

export const fetchRightsizing = () =>
  request<{ recommendations: import("../types").RightsizingRec[] }>("/api/health/rightsizing");

// Metric history
export const fetchMetricHistory = (node: string, metric: string, range: string) =>
  request<{ points: { timestamp: number; value: number }[] }>(
    `/api/metrics/history?node=${encodeURIComponent(node)}&metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`,
  );

// Chaos
export const fetchChaosScenarios = () =>
  request<import("../types").ChaosScenario[]>("/api/chaos/scenarios");

export const fetchChaosStatus = () =>
  request<import("../types").ChaosRun | null>("/api/chaos/status");

export const fetchChaosHistory = () =>
  request<import("../types").ChaosRun[]>("/api/chaos/history");

export const simulateChaos = (scenario: string, params: Record<string, unknown>) =>
  request<import("../types").ChaosSimulation>("/api/chaos/simulate", {
    method: "POST",
    body: JSON.stringify({ scenario, params }),
  });

export const executeChaos = (scenario: string, params: Record<string, unknown>) =>
  request<import("../types").ChaosRun>("/api/chaos/execute", {
    method: "POST",
    body: JSON.stringify({ scenario, params }),
  });

export const cancelChaos = () =>
  request<{ ok: boolean; run_id: string }>("/api/chaos/cancel");

// Migration
export const fetchMigrationVMs = (provider: "vmware" | "proxmox" | "aws") =>
  request<{ vms: import("../types").MigrationVM[] }>(`/api/migration/vms?provider=${provider}`);

export const planMigration = (direction: import("../types").MigrationDirection, vmId: string | number) =>
  request<import("../types").MigrationPlan>("/api/migration/plan", {
    method: "POST",
    body: JSON.stringify({ direction, vm_id: vmId }),
  });

export const executeMigration = (direction: import("../types").MigrationDirection, vmId: string | number) =>
  request<import("../types").MigrationPlan>("/api/migration/execute", {
    method: "POST",
    body: JSON.stringify({ direction, vm_id: vmId }),
  });

export const fetchMigrationHistory = () =>
  request<{ migrations: import("../types").MigrationPlan[] }>("/api/migration/history");

// Agent command
export const sendAgentCommand = (command: string) =>
  request<Record<string, unknown>>("/api/agent/command", {
    method: "POST",
    body: JSON.stringify({ command }),
  });

// Topology
export const fetchApps = () =>
  request<import("../types").Application[]>("/api/topology/apps");

export const fetchApp = (id: string) =>
  request<import("../types").Application>(`/api/topology/apps/${id}`);

export const createApp = (data: { name: string; tier: string; owner?: string; description?: string; tags?: string[] }) =>
  request<import("../types").Application>("/api/topology/apps", { method: "POST", body: JSON.stringify(data) });

export const deleteApp = (id: string) =>
  request<void>(`/api/topology/apps/${id}`, { method: "DELETE" });

export const addAppMember = (appId: string, member: { workload_id: string; workload_type: string; provider: string; role: string; critical?: boolean }) =>
  request<any>(`/api/topology/apps/${appId}/members`, { method: "POST", body: JSON.stringify(member) });

export const removeAppMember = (appId: string, workloadId: string) =>
  request<void>(`/api/topology/apps/${appId}/members/${workloadId}`, { method: "DELETE" });

export const addAppDependency = (appId: string, dep: { from_workload: string; to_workload: string; port: number; service: string; protocol?: string }) =>
  request<any>(`/api/topology/apps/${appId}/dependencies`, { method: "POST", body: JSON.stringify(dep) });

export const fetchTopologyGraph = () =>
  request<import("../types").TopologyGraph>("/api/topology/graph");

export const fetchImpactAnalysis = (workloadId: string) =>
  request<import("../types").ImpactReport>(`/api/topology/impact/${workloadId}`);
