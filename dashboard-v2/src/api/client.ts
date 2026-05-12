// API client for RHODES dashboard
import { isOnPremProvider } from "../lib/costs";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[$,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readCostNumber(record: Record<string, unknown>): number {
  const candidate = (
    asNumber(record.monthlyCostUsd)
    ?? asNumber(record.monthly_cost_usd)
    ?? asNumber(record.costUsd)
    ?? asNumber(record.cost_usd)
    ?? asNumber(record.totalUsd)
    ?? asNumber(record.total_usd)
    ?? asNumber(record.amountUsd)
    ?? asNumber(record.amount_usd)
    ?? asNumber(record.cost)
    ?? asNumber(record.value)
    ?? 0
  );
  return Math.max(0, candidate);
}

function normalizeCostSummary(payload: unknown): import("../types").ProviderCostSummary[] {
  const record = asRecord(payload);
  const direct = asArray(payload);
  const providers = asArray(record?.providers);
  const nestedProviders = asArray(asRecord(record?.summary)?.providers);
  const rawProviders = direct.length > 0 ? direct : (providers.length > 0 ? providers : nestedProviders);

  if (rawProviders.length > 0) {
    const normalized: import("../types").ProviderCostSummary[] = [];
    for (const entry of rawProviders) {
      const row = asRecord(entry);
      if (!row) continue;
      const provider = asString(row.provider ?? row.name ?? row.id ?? row.key);
      if (!provider) continue;
      normalized.push({
        provider,
        monthlyCostUsd: readCostNumber(row),
        currency: asString(row.currency ?? row.currencyCode) ?? "USD",
      });
    }
    return normalized;
  }

  if (!record) return [];

  const normalized: import("../types").ProviderCostSummary[] = [];
  for (const [provider, value] of Object.entries(record)) {
    if (provider === "providers" || provider === "summary") continue;
    const numeric = asNumber(value);
    if (numeric === null) continue;
    normalized.push({
      provider,
      monthlyCostUsd: Math.max(0, numeric),
      currency: "USD",
    });
  }
  return normalized;
}

function normalizeCostTimeseries(payload: unknown): import("../types").CostTimeseriesPoint[] {
  const record = asRecord(payload);
  const direct = asArray(payload);
  const points = asArray(record?.points);
  const timeseries = asArray(record?.timeseries);
  const series = asArray(record?.series);
  const directRows = direct.length > 0 ? direct : (points.length > 0 ? points : (timeseries.length > 0 ? timeseries : series));

  if (directRows.length > 0) {
    const normalized: import("../types").CostTimeseriesPoint[] = [];
    for (const rowValue of directRows) {
      const row = asRecord(rowValue);
      if (!row) continue;
      const date = asString(row.date ?? row.day ?? row.timestamp);
      const provider = asString(row.provider ?? row.name ?? row.providerName);
      if (date && provider) {
        normalized.push({
          date,
          provider,
          costUsd: readCostNumber(row),
        });
        continue;
      }

      if (date) {
        for (const [key, value] of Object.entries(row)) {
          if (key === "date" || key === "day" || key === "timestamp" || key === "total" || key === "totalUsd" || key === "total_usd") {
            continue;
          }
          const amount = asNumber(value);
          if (amount === null) continue;
          normalized.push({
            date,
            provider: key,
            costUsd: Math.max(0, amount),
          });
        }
      }
    }
    return normalized;
  }

  const nestedSeries = asRecord(record?.series);
  if (!nestedSeries) return [];

  const normalized: import("../types").CostTimeseriesPoint[] = [];
  for (const [provider, providerSeries] of Object.entries(nestedSeries)) {
    for (const pointValue of asArray(providerSeries)) {
      const point = asRecord(pointValue);
      if (!point) continue;
      const date = asString(point.date ?? point.day ?? point.timestamp);
      if (!date) continue;
      normalized.push({
        date,
        provider,
        costUsd: readCostNumber(point),
      });
    }
  }
  return normalized;
}

function normalizeCostTopResources(payload: unknown): import("../types").CostTopResource[] {
  const record = asRecord(payload);
  const direct = asArray(payload);
  const resources = asArray(record?.resources);
  const items = asArray(record?.items);
  const topResources = asArray(record?.topResources);
  const rows = direct.length > 0 ? direct : (resources.length > 0 ? resources : (items.length > 0 ? items : topResources));
  const normalized: import("../types").CostTopResource[] = [];
  rows.forEach((entry, idx) => {
    const row = asRecord(entry);
    if (!row) return;
    const provider = asString(row.provider ?? row.providerName ?? row.cloud ?? row.platform) ?? "unknown";
    const id = asString(row.id ?? row.resourceId ?? row.resource_id) ?? `${provider}-${idx}`;
    const name = asString(row.name ?? row.resourceName ?? row.resource_name ?? row.label) ?? id;
    const resourceType = asString(row.resourceType ?? row.resource_type ?? row.type) ?? "resource";
    const monthlyCostUsd = readCostNumber(row);
    normalized.push({
      id,
      name,
      provider,
      resourceType,
      monthlyCostUsd,
      comparisonCostUsd: asNumber(row.comparisonCostUsd ?? row.comparison_cost_usd) ?? undefined,
      deltaUsd: asNumber(row.deltaUsd ?? row.delta_usd) ?? undefined,
    });
  });
  return normalized;
}

function filterByComparison<T extends { provider: string }>(
  rows: T[],
  comparison: import("../types").CostComparisonMode,
): T[] {
  if (comparison === "hybrid") return rows;
  return rows.filter((row) => !isOnPremProvider(row.provider));
}

function normalizeChaosSimulation(payload: unknown): import("../types").ChaosSimulation {
  const run = asRecord(payload) ?? {};
  const simulation = asRecord(run.simulation) ?? run;
  const blastRadius = asRecord(simulation.blast_radius);
  const affectedRaw = Array.isArray(blastRadius?.affected_vms)
    ? blastRadius.affected_vms
    : [];
  const affected = affectedRaw
    .map((item) => {
      const vm = asRecord(item);
      if (!vm) return null;
      const rawImpact = typeof vm.impact === "string" ? vm.impact : null;
      const impact = rawImpact ?? (vm.will_be_affected === true ? "direct" : "safe");
      return {
        vmid: String(vm.vmid ?? vm.id ?? ""),
        name: String(vm.name ?? vm.vmid ?? vm.id ?? "Unknown VM"),
        impact,
      };
    })
    .filter((vm): vm is { vmid: string; name: string; impact: string } => vm !== null);

  const scenario = asRecord(run.scenario);
  return {
    scenario_id: String(
      simulation.scenario_id ??
      scenario?.id ??
      run.scenario_id ??
      "",
    ),
    affected_vms: affected,
    predicted_recovery_time_s: Number(simulation.predicted_recovery_time_s ?? 0),
    risk_score: Number(simulation.risk_score ?? 0),
    recommendation: String(
      simulation.recommendation ??
      run.recommendation ??
      "Review blast radius before execution.",
    ),
  };
}

function normalizeChaosRun(payload: unknown): import("../types").ChaosRun {
  const run = asRecord(payload) ?? {};
  const scenario = asRecord(run.scenario);
  const score = asRecord(run.score);
  const actual = asRecord(run.actual);
  const simulation = normalizeChaosSimulation(run);
  const rawStatus = String(run.status ?? "executing");
  const validStatuses = new Set([
    "simulating",
    "pending",
    "simulated",
    "executing",
    "recovering",
    "verifying",
    "completed",
    "failed",
  ]);

  return {
    id: String(run.id ?? ""),
    scenario: {
      id: String(scenario?.id ?? run.scenario_id ?? ""),
      name: String(scenario?.name ?? run.scenario_name ?? run.scenario_id ?? "Unknown scenario"),
      description: String(scenario?.description ?? ""),
      severity: (scenario?.severity as import("../types").ChaosScenario["severity"]) ?? "medium",
      target_type: (scenario?.target_type as import("../types").ChaosScenario["target_type"]) ?? "vm",
      requires_approval: Boolean(scenario?.requires_approval),
      reversible: Boolean(scenario?.reversible),
    },
    status: (validStatuses.has(rawStatus) ? rawStatus : "executing") as import("../types").ChaosRun["status"],
    started_at: String(run.started_at ?? new Date().toISOString()),
    completed_at: typeof run.completed_at === "string" ? run.completed_at : undefined,
    blast_radius: simulation,
    actual_recovery_time_s: Number(run.actual_recovery_time_s ?? actual?.recovery_time_s ?? 0) || undefined,
    resilience_score: Number(run.resilience_score ?? score?.resilience_pct ?? 0) || undefined,
    verdict: (run.verdict ?? score?.verdict ?? undefined) as import("../types").ChaosRun["verdict"],
    predicted_vs_actual_recovery:
      typeof score?.predicted_vs_actual_recovery === "string"
        ? score.predicted_vs_actual_recovery
        : undefined,
    incidents_created: Array.isArray(actual?.incidents_created)
      ? actual.incidents_created.map((i: unknown) => String(i))
      : undefined,
    steps_executed: typeof actual?.steps_executed === "number" ? actual.steps_executed : undefined,
    all_recovered: typeof actual?.all_recovered === "boolean" ? actual.all_recovered : undefined,
  };
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

export interface IncidentTimelineEntry {
  timestamp: string;
  event: "detected" | "action" | "resolved" | "failed" | string;
  detail: string;
  success?: boolean;
}

export const fetchIncidentTimeline = (incidentId: string) =>
  request<{
    incident: import("../types").Incident;
    timeline: IncidentTimelineEntry[];
  }>(`/api/incidents/${encodeURIComponent(incidentId)}/timeline`);

// Audit
export const fetchAudit = (limit = 100) =>
  request<import("../types").AuditEntry[]>(`/api/audit?limit=${limit}`);

export const fetchAuditStats = () =>
  request<Record<string, unknown>>("/api/audit/stats");

export const fetchRunTelemetry = (days = 7) =>
  request<import("../types").RunTelemetrySummary>(
    `/api/telemetry/runs?days=${encodeURIComponent(String(days))}`,
  );

// Costs
export const fetchCostSummary = async (comparison: import("../types").CostComparisonMode) => {
  const payload = await request<unknown>(`/api/costs/summary?comparison=${encodeURIComponent(comparison)}`);
  return filterByComparison(normalizeCostSummary(payload), comparison);
};

export const fetchCostTimeseries = async (comparison: import("../types").CostComparisonMode) => {
  const payload = await request<unknown>(`/api/costs/timeseries?window=30d&comparison=${encodeURIComponent(comparison)}`);
  return filterByComparison(normalizeCostTimeseries(payload), comparison);
};

export const fetchCostTopResources = async (
  comparison: import("../types").CostComparisonMode,
  limit = 10,
) => {
  const payload = await request<unknown>(
    `/api/costs/top-resources?comparison=${encodeURIComponent(comparison)}&limit=${encodeURIComponent(String(limit))}`,
  );
  return filterByComparison(normalizeCostTopResources(payload), comparison);
};

// Health & Playbooks
export interface Healthz {
  ok: boolean;
  version: string;
  uptime_s: number;
  process_uptime_s: number;
  dry_run: boolean;
  shadow_mode: boolean;
  providers_connected: number;
  sse_clients: number;
  open_incidents: number;
  registered_playbooks: number;
  last_alert: { type: string; timestamp: string; summary: string | null } | null;
  active_plans: Array<{ id: string | null; mode: string | null; created_at: string }>;
  timestamp: string;
}

export const fetchHealthz = () => request<Healthz>("/healthz");

export interface PlaybookSummary {
  id: string;
  name: string;
  description: string;
  trigger: { metric: string; type: string; severity?: string };
  requires_approval: boolean;
  cooldown_minutes: number;
  enabled: boolean;
  last_triggered_at: string | null;
}

export const fetchPlaybooks = () =>
  request<{ playbooks: PlaybookSummary[] }>("/api/playbooks");

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

export const fetchChaosStatus = async () => {
  const run = await request<unknown>("/api/chaos/status");
  if (run == null) return null;
  return normalizeChaosRun(run);
};

export const fetchChaosHistory = async () => {
  const payload = await request<unknown>("/api/chaos/history");
  if (!Array.isArray(payload)) return [];
  return payload.map((run) => normalizeChaosRun(run));
};

export const simulateChaos = async (scenario: string, params: Record<string, unknown>) => {
  const payload = await request<unknown>("/api/chaos/simulate", {
    method: "POST",
    body: JSON.stringify({ scenario, params }),
  });
  return normalizeChaosSimulation(payload);
};

export const executeChaos = async (scenario: string, params: Record<string, unknown>) => {
  const payload = await request<unknown>("/api/chaos/execute", {
    method: "POST",
    body: JSON.stringify({ scenario, params }),
  });
  return normalizeChaosRun(payload);
};

export const cancelChaos = () =>
  request<{ ok: boolean; run_id: string }>("/api/chaos/cancel");

// Migration
export const fetchMigrationVMs = (provider: "vmware" | "proxmox" | "aws" | "azure") =>
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

export const fetchMigrationStatus = (migrationId: string) =>
  request<unknown>(`/api/migration/status/${encodeURIComponent(migrationId)}`);

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
