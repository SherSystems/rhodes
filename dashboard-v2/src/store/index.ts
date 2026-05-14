import { create } from "zustand";
import type {
  AgentMode,
  ClusterState,
  MultiClusterState,
  Plan,
  StepState,
  AgentEvent,
  Incident,
  HealingBanner,
  HealthSummary,
  TabId,
  Toast,
  MigrationDirection,
  MigrationLiveRun,
  MigrationPlan,
} from "../types";
import type { PendingApproval } from "../api/client";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace("%", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeMigrationEventType(type: string): string {
  const snake = type
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

  if (snake === "migrationprogress") return "migration_progress";
  if (snake === "migrationcompleted") return "migration_completed";
  if (snake === "migrationfailed") return "migration_failed";
  return snake;
}

function extractMigrationId(data: Record<string, unknown>): string | undefined {
  return asString(data.migrationId ?? data.migration_id ?? data.id);
}

function extractMigrationVmId(data: Record<string, unknown>): string | undefined {
  return asString(data.vm_id ?? data.vmId);
}

function extractMigrationDirection(data: Record<string, unknown>): MigrationDirection | undefined {
  const direction = asString(data.direction);
  return direction as MigrationDirection | undefined;
}

function extractMigrationStage(data: Record<string, unknown>): string | undefined {
  return asString(data.stage ?? data.step ?? data.currentStep ?? data.step_name);
}

function extractMigrationProgressPct(data: Record<string, unknown>): number | undefined {
  const pct = asNumber(data.progressPct ?? data.progress_pct ?? data.progress ?? data.percentage);
  if (pct === undefined) return undefined;
  return Math.max(0, Math.min(100, pct));
}

function extractRunIdentifiers(data: Record<string, unknown>): {
  amiId?: string;
  instanceId?: string;
  targetVmId?: string;
} {
  const nestedPlan = asRecord(data.plan);
  const nestedTarget = asRecord(nestedPlan?.target);
  return {
    amiId: asString(data.amiId ?? data.ami_id ?? nestedTarget?.amiId),
    instanceId: asString(data.instanceId ?? data.instance_id ?? data.ec2InstanceId ?? data.ec2_instance_id),
    targetVmId: asString(data.targetVmId ?? data.target_vm_id ?? data.vmId ?? nestedTarget?.vmId),
  };
}

function deriveRunStage(plan: MigrationPlan): string {
  const lastCompleted = [...plan.steps].reverse().find((step) => step.status === "completed");
  const failedStep = plan.steps.find((step) => step.status === "failed");
  const activeStep = plan.steps.find((step) => step.status === "pending");
  return failedStep?.name || activeStep?.name || lastCompleted?.name || "queued";
}

function resolveRunId(
  runs: Record<string, MigrationLiveRun>,
  eventType: string,
  data: Record<string, unknown>,
): string {
  const explicitId = extractMigrationId(data);
  if (explicitId) return explicitId;

  const vmId = extractMigrationVmId(data);
  const direction = extractMigrationDirection(data);

  const candidates = Object.values(runs)
    .filter((run) => {
      if (run.status !== "running") return false;
      if (vmId && run.vmId !== vmId) return false;
      if (direction && run.direction !== direction) return false;
      return true;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (candidates[0]) return candidates[0].id;

  const runningRuns = Object.values(runs).filter((run) => run.status === "running");
  if (
    runningRuns.length === 1 &&
    (eventType === "migration_step" || eventType === "migration_progress" || eventType === "migration_completed" || eventType === "migration_failed")
  ) {
    return runningRuns[0].id;
  }

  return `legacy:${direction ?? "unknown"}:${vmId ?? "unknown"}`;
}

interface DashboardState {
  // Connection
  connected: boolean;
  setConnected: (v: boolean) => void;

  // Mode
  mode: AgentMode;
  setMode: (m: AgentMode) => void;

  // Active tab
  activeTab: TabId;
  setActiveTab: (t: TabId) => void;

  // Cluster
  cluster: ClusterState | null;
  setCluster: (c: ClusterState) => void;
  multiCluster: MultiClusterState | null;
  setMultiCluster: (m: MultiClusterState) => void;

  // Plan
  plan: Plan | null;
  planSteps: Record<string, StepState>;
  planCompleted: number;
  planFailed: number;
  replans: number;
  currentPlanId: string | null;
  planGoals: Record<string, string>;
  setPlan: (p: Plan) => void;
  updateStep: (id: string, s: Partial<StepState>) => void;
  incrementCompleted: () => void;
  incrementFailed: () => void;
  incrementReplans: () => void;

  // Events
  events: AgentEvent[];
  addEvent: (e: AgentEvent) => void;

  // Pending approvals (API-driven approval gate)
  pendingApprovals: PendingApproval[];
  setPendingApprovals: (list: PendingApproval[]) => void;
  upsertPendingApproval: (entry: PendingApproval) => void;
  removePendingApproval: (planId: string) => void;

  // Remediate state per incident_id: "pending" while POST in flight, "done" after.
  remediateState: Record<string, "pending" | "done">;
  setRemediateState: (incidentId: string, state: "pending" | "done" | null) => void;

  // Incidents
  activeIncidents: Incident[];
  recentIncidents: Incident[];
  setIncidents: (active: Incident[], recent: Incident[]) => void;
  addActiveIncident: (i: Incident) => void;
  updateIncident: (id: string, updates: Partial<Incident>) => void;
  resolveIncident: (id: string, resolution: Partial<Incident>) => void;
  expandedIncidents: Record<string, boolean>;
  toggleIncidentExpanded: (id: string) => void;

  // Healing
  healingBanners: HealingBanner[];
  addHealingBanner: (b: HealingBanner) => void;
  removeHealingBanner: (id: string) => void;

  // Health
  healthHistory: HealthSummary[];
  lastHealth: HealthSummary | null;
  addHealth: (h: HealthSummary) => void;

  // Metric history (sparklines)
  metricHistory: { cpu: number[]; ram: number[] };
  nodeMetricHistory: Record<string, { cpu: number[]; ram: number[] }>;

  // Toasts
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id" | "timestamp">) => void;
  removeToast: (id: string) => void;

  // Migrations
  activeMigration: MigrationPlan | null;
  migrationHistory: MigrationPlan[];
  migrationRuns: Record<string, MigrationLiveRun>;
  migrationRunOrder: string[];
  setActiveMigration: (m: MigrationPlan | null) => void;
  updateMigrationStep: (stepName: string, updates: Partial<MigrationPlan["steps"][0]>) => void;
  completeMigration: (m: MigrationPlan) => void;
  setMigrationHistory: (h: MigrationPlan[]) => void;
  beginMigrationRun: (params: {
    direction: MigrationDirection;
    vmId: string;
    vmName?: string;
  }) => string;
  registerMigrationRun: (
    plan: MigrationPlan,
    options?: {
      localRunId?: string;
      direction?: MigrationDirection;
      vmId?: string;
      vmName?: string;
    },
  ) => void;
  markMigrationRunFailed: (runId: string, error: string) => void;
  applyMigrationEvent: (eventType: string, payload: Record<string, unknown>, timestamp: string) => void;

  // Governance counters
  totalActions: number;
  failures: number;
  startTime: number;
  incrementActions: () => void;
  incrementFailures: () => void;
}

export const useStore = create<DashboardState>((set) => ({
  connected: false,
  setConnected: (v) => set({ connected: v }),

  mode: "watch",
  setMode: (m) => set({ mode: m }),

  activeTab: "overview",
  setActiveTab: (t) => set({ activeTab: t }),

  cluster: null,
  multiCluster: null,
  setMultiCluster: (m) => set({ multiCluster: m }),
  setCluster: (c) =>
    set((s) => {
      const nodeHist = { ...s.nodeMetricHistory };
      if (c?.nodes) {
        for (const node of c.nodes) {
          const cpuPct = node.cpu_usage_pct || node.cpu_pct || 0;
          const ramPct = node.ram_total_mb ? (node.ram_used_mb / node.ram_total_mb) * 100 : 0;
          const prev = nodeHist[node.id] || { cpu: [], ram: [] };
          nodeHist[node.id] = {
            cpu: [...prev.cpu, cpuPct].slice(-20),
            ram: [...prev.ram, ramPct].slice(-20),
          };
        }
      }
      // Also update aggregate if no health data has provided it yet
      let { cpu, ram } = s.metricHistory;
      if (c?.nodes?.length) {
        const firstNode = c.nodes[0];
        const avgCpu = firstNode.cpu_usage_pct || firstNode.cpu_pct || 0;
        const avgRam = firstNode.ram_total_mb ? (firstNode.ram_used_mb / firstNode.ram_total_mb) * 100 : 0;
        if (s.metricHistory.cpu.length === 0 || !s.lastHealth) {
          cpu = [...cpu, avgCpu].slice(-20);
          ram = [...ram, avgRam].slice(-20);
        }
      }
      return { cluster: c, nodeMetricHistory: nodeHist, metricHistory: { cpu, ram } };
    }),

  plan: null,
  planSteps: {},
  planCompleted: 0,
  planFailed: 0,
  replans: 0,
  currentPlanId: null,
  planGoals: {},
  setPlan: (p) =>
    set((s) => ({
      plan: p,
      currentPlanId: p.id,
      planCompleted: 0,
      planFailed: 0,
      planSteps: {},
      planGoals: { ...s.planGoals, [p.id]: (p as unknown as Record<string, unknown>).goal as string || p.reasoning || "" },
    })),
  updateStep: (id, updates) =>
    set((s) => ({
      planSteps: { ...s.planSteps, [id]: { ...s.planSteps[id], ...updates } as StepState },
    })),
  incrementCompleted: () => set((s) => ({ planCompleted: s.planCompleted + 1 })),
  incrementFailed: () => set((s) => ({ planFailed: s.planFailed + 1 })),
  incrementReplans: () => set((s) => ({ replans: s.replans + 1 })),

  events: [],
  addEvent: (e) => set((s) => ({ events: [...s.events, e] })),

  pendingApprovals: [],
  setPendingApprovals: (list) => set({ pendingApprovals: list }),
  upsertPendingApproval: (entry) =>
    set((s) => {
      const others = s.pendingApprovals.filter((p) => p.plan_id !== entry.plan_id);
      return { pendingApprovals: [entry, ...others] };
    }),
  removePendingApproval: (planId) =>
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.plan_id !== planId),
    })),

  remediateState: {},
  setRemediateState: (incidentId, state) =>
    set((s) => {
      const next = { ...s.remediateState };
      if (state === null) {
        delete next[incidentId];
      } else {
        next[incidentId] = state;
      }
      return { remediateState: next };
    }),

  activeIncidents: [],
  recentIncidents: [],
  setIncidents: (active, recent) => set({ activeIncidents: active, recentIncidents: recent }),
  addActiveIncident: (i) =>
    set((s) => ({ activeIncidents: [i, ...s.activeIncidents] })),
  updateIncident: (id, updates) =>
    set((s) => ({
      activeIncidents: s.activeIncidents.map((i) =>
        i.id === id ? { ...i, ...updates } : i
      ),
    })),
  resolveIncident: (id, resolution) =>
    set((s) => {
      const incident = s.activeIncidents.find((i) => i.id === id);
      if (!incident) return s;
      const resolved = { ...incident, ...resolution };
      return {
        activeIncidents: s.activeIncidents.filter((i) => i.id !== id),
        recentIncidents: [resolved, ...s.recentIncidents].slice(0, 20),
      };
    }),
  expandedIncidents: {},
  toggleIncidentExpanded: (id) =>
    set((s) => ({
      expandedIncidents: { ...s.expandedIncidents, [id]: !s.expandedIncidents[id] },
    })),

  healingBanners: [],
  addHealingBanner: (b) =>
    set((s) => ({
      healingBanners: [...s.healingBanners.filter((x) => x.id !== b.id), b],
    })),
  removeHealingBanner: (id) =>
    set((s) => ({
      healingBanners: s.healingBanners.filter((x) => x.id !== id),
    })),

  healthHistory: [],
  lastHealth: null,
  addHealth: (h) =>
    set((s) => {
      const cpuVal = h.resources?.cpu_usage_pct;
      const ramVal = h.resources?.ram_usage_pct;
      return {
        lastHealth: h,
        healthHistory: [...s.healthHistory, h].slice(-30),
        metricHistory: {
          cpu: cpuVal != null ? [...s.metricHistory.cpu, cpuVal].slice(-20) : s.metricHistory.cpu,
          ram: ramVal != null ? [...s.metricHistory.ram, ramVal].slice(-20) : s.metricHistory.ram,
        },
      };
    }),

  metricHistory: { cpu: [], ram: [] },
  nodeMetricHistory: {},

  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      toasts: [{ ...toast, id, timestamp: new Date().toISOString() }, ...s.toasts].slice(0, 20),
    }));
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  activeMigration: null,
  migrationHistory: [],
  migrationRuns: {},
  migrationRunOrder: [],
  setActiveMigration: (m) => set({ activeMigration: m }),
  updateMigrationStep: (stepName, updates) =>
    set((s) => {
      if (!s.activeMigration) return s;
      return {
        activeMigration: {
          ...s.activeMigration,
          steps: s.activeMigration.steps.map((step) =>
            step.name === stepName ? { ...step, ...updates } : step
          ),
        },
      };
    }),
  completeMigration: (m) =>
    set((s) => ({
      activeMigration: null,
      migrationHistory: [m, ...s.migrationHistory].slice(0, 50),
    })),
  setMigrationHistory: (h) => set({ migrationHistory: h }),
  beginMigrationRun: ({ direction, vmId, vmName }) => {
    const runId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    set((s) => ({
      migrationRuns: {
        ...s.migrationRuns,
        [runId]: {
          id: runId,
          migrationId: runId,
          direction,
          vmId,
          vmName,
          status: "running",
          stage: "queued",
          progressPct: 0,
          startedAt: now,
          updatedAt: now,
        },
      },
      migrationRunOrder: [runId, ...s.migrationRunOrder.filter((id) => id !== runId)].slice(0, 50),
    }));
    return runId;
  },
  registerMigrationRun: (plan, options) =>
    set((s) => {
      const planDirection = asString(asRecord(plan)?.direction) as MigrationDirection | undefined;
      const direction = options?.direction ?? planDirection;
      const vmId = options?.vmId ?? asString(plan.source?.vmId);
      const vmName = options?.vmName ?? plan.vmConfig?.name ?? plan.source?.vmName;
      const runId = asString(plan.id) ?? options?.localRunId ?? `local-${Date.now()}`;

      let sourceRunId = options?.localRunId;
      if (!sourceRunId) {
        sourceRunId = Object.keys(s.migrationRuns).find((candidateId) => {
          if (candidateId === runId) return false;
          const candidate = s.migrationRuns[candidateId];
          if (candidate.status !== "running") return false;
          if (vmId && candidate.vmId !== vmId) return false;
          if (direction && candidate.direction !== direction) return false;
          return true;
        });
      }

      const sourceRun = sourceRunId ? s.migrationRuns[sourceRunId] : undefined;
      const status =
        plan.status === "completed"
          ? "completed"
          : plan.status === "failed"
            ? "failed"
            : "running";

      const identifiers = extractRunIdentifiers(asRecord(plan) ?? {});
      const now = new Date().toISOString();
      const mergedRun: MigrationLiveRun = {
        ...sourceRun,
        id: runId,
        migrationId: runId,
        direction: direction ?? sourceRun?.direction,
        vmId: vmId ?? sourceRun?.vmId,
        vmName: vmName ?? sourceRun?.vmName,
        status,
        stage: deriveRunStage(plan),
        progressPct: status === "completed" ? 100 : sourceRun?.progressPct ?? 0,
        message: plan.error ?? sourceRun?.message,
        startedAt: plan.startedAt ?? sourceRun?.startedAt ?? now,
        updatedAt: now,
        completedAt: plan.completedAt ?? (status === "running" ? undefined : now),
        etaSample: sourceRun?.etaSample,
        amiId: plan.target?.amiId ?? identifiers.amiId ?? sourceRun?.amiId,
        instanceId: identifiers.instanceId ?? sourceRun?.instanceId,
        targetVmId: identifiers.targetVmId ?? sourceRun?.targetVmId,
        error: plan.error ?? sourceRun?.error,
      };

      const nextRuns = { ...s.migrationRuns };
      if (sourceRunId && sourceRunId !== runId) {
        delete nextRuns[sourceRunId];
      }
      nextRuns[runId] = mergedRun;

      return {
        migrationRuns: nextRuns,
        migrationRunOrder: [runId, ...s.migrationRunOrder.filter((id) => id !== runId && id !== sourceRunId)].slice(0, 50),
      };
    }),
  markMigrationRunFailed: (runId, error) =>
    set((s) => {
      const current = s.migrationRuns[runId];
      if (!current) return s;
      const now = new Date().toISOString();
      return {
        migrationRuns: {
          ...s.migrationRuns,
          [runId]: {
            ...current,
            status: "failed",
            error,
            message: error,
            completedAt: now,
            updatedAt: now,
          },
        },
        migrationRunOrder: [runId, ...s.migrationRunOrder.filter((id) => id !== runId)].slice(0, 50),
      };
    }),
  applyMigrationEvent: (eventType, payload, timestamp) =>
    set((s) => {
      const normalizedType = normalizeMigrationEventType(eventType);
      if (!normalizedType.startsWith("migration")) return s;

      const runId = resolveRunId(s.migrationRuns, normalizedType, payload);
      const current = s.migrationRuns[runId];
      const nowIso = timestamp || new Date().toISOString();
      const startedAt = current?.startedAt ?? asString(payload.startedAt ?? payload.started_at) ?? nowIso;
      const nowMs = new Date(nowIso).getTime();
      const startedMs = new Date(startedAt).getTime();
      const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;

      const status =
        normalizedType === "migration_completed"
          ? "completed"
          : normalizedType === "migration_failed"
            ? "failed"
            : "running";
      const progressFromEvent = extractMigrationProgressPct(payload);
      const prevPct = current?.progressPct ?? 0;
      let progressPct = progressFromEvent ?? prevPct;
      if (status === "completed") progressPct = 100;
      progressPct = Math.max(prevPct, progressPct);

      const etaSample =
        current?.etaSample ||
        (status === "running" && progressPct > 0
          ? progressPct <= 20
            ? { progressPct, elapsedMs }
            : { progressPct: 20, elapsedMs: Math.round((elapsedMs * 20) / progressPct) }
          : undefined);

      const ids = extractRunIdentifiers(payload);
      const nextRun: MigrationLiveRun = {
        ...current,
        id: runId,
        migrationId: runId,
        direction: extractMigrationDirection(payload) ?? current?.direction,
        vmId: extractMigrationVmId(payload) ?? current?.vmId,
        vmName: asString(payload.vm_name ?? payload.vmName) ?? current?.vmName,
        status,
        stage: extractMigrationStage(payload) ?? current?.stage ?? (normalizedType === "migration_started" ? "queued" : "processing"),
        progressPct,
        message: asString(payload.message ?? payload.detail ?? payload.status ?? payload.error) ?? current?.message,
        startedAt,
        updatedAt: nowIso,
        completedAt: status === "running" ? current?.completedAt : nowIso,
        etaSample,
        amiId: ids.amiId ?? current?.amiId,
        instanceId: ids.instanceId ?? current?.instanceId,
        targetVmId: ids.targetVmId ?? current?.targetVmId,
        error: asString(payload.error) ?? current?.error,
      };

      return {
        migrationRuns: { ...s.migrationRuns, [runId]: nextRun },
        migrationRunOrder: [runId, ...s.migrationRunOrder.filter((id) => id !== runId)].slice(0, 50),
      };
    }),

  totalActions: 0,
  failures: 0,
  startTime: Date.now(),
  incrementActions: () => set((s) => ({ totalActions: s.totalActions + 1 })),
  incrementFailures: () => set((s) => ({ failures: s.failures + 1 })),
}));
