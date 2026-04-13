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
  MigrationPlan,
} from "../types";

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
  setActiveMigration: (m: MigrationPlan | null) => void;
  updateMigrationStep: (stepName: string, updates: Partial<MigrationPlan["steps"][0]>) => void;
  completeMigration: (m: MigrationPlan) => void;
  setMigrationHistory: (h: MigrationPlan[]) => void;

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

  activeTab: "topology",
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

  totalActions: 0,
  failures: 0,
  startTime: Date.now(),
  incrementActions: () => set((s) => ({ totalActions: s.totalActions + 1 })),
  incrementFailures: () => set((s) => ({ failures: s.failures + 1 })),
}));
