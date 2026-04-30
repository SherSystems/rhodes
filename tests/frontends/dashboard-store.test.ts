import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../dashboard-v2/src/store";
import type { ClusterState, HealthSummary, Incident, Plan } from "../../dashboard-v2/src/types";

const initialState = useStore.getState();

function resetStore() {
  useStore.setState(initialState, true);
}

function makeCluster(cpu: number, ramUsed: number, ramTotal = 1000): ClusterState {
  return {
    nodes: [
      {
        id: "node-1",
        name: "Node 1",
        status: "online",
        cpu_cores: 8,
        cpu_usage_pct: cpu,
        ram_total_mb: ramTotal,
        ram_used_mb: ramUsed,
        disk_total_gb: 100,
        disk_used_gb: 40,
        disk_usage_pct: 40,
        uptime_s: 100,
      },
    ],
    vms: [],
    containers: [],
    storage: [],
    timestamp: "2026-03-31T00:00:00.000Z",
  };
}

function makeHealth(cpu: number | undefined, ram: number | undefined): HealthSummary {
  return {
    resources: {
      cpu_usage_pct: cpu as unknown as number,
      ram_usage_pct: ram as unknown as number,
      disk_usage_pct: 30,
      cpu_cores: 8,
      ram_total_mb: 1000,
      ram_used_mb: 600,
      disk_total_gb: 100,
      disk_used_gb: 30,
    },
    nodes: { total: 1, online: 1 },
    vms: { total: 2, running: 2 },
    timestamp: new Date().toISOString(),
  };
}

describe("dashboard store reducers", () => {
  beforeEach(() => {
    resetStore();
  });

  it("updates node histories and avoids stale aggregate overwrite after health data", () => {
    useStore.getState().setCluster(makeCluster(70, 500));
    let state = useStore.getState();

    expect(state.nodeMetricHistory["node-1"]).toEqual({
      cpu: [70],
      ram: [50],
    });
    expect(state.metricHistory).toEqual({ cpu: [70], ram: [50] });

    state.addHealth(makeHealth(80, 60));
    state.setCluster(makeCluster(10, 100));
    state = useStore.getState();

    expect(state.metricHistory.cpu).toEqual([70, 80]);
    expect(state.metricHistory.ram).toEqual([50, 60]);
    expect(state.nodeMetricHistory["node-1"].cpu.at(-1)).toBe(10);
    expect(state.nodeMetricHistory["node-1"].ram.at(-1)).toBe(10);
  });

  it("resets plan progress and keeps goal history across replans", () => {
    const planOne = {
      id: "plan-1",
      goal_id: "g-1",
      created_at: "2026-03-31T00:00:00.000Z",
      status: "created",
      steps: [],
      goal: "initial-goal",
    } as Plan & { goal: string };
    const planTwo: Plan = {
      id: "plan-2",
      goal_id: "g-1",
      created_at: "2026-03-31T00:01:00.000Z",
      status: "created",
      steps: [],
      reasoning: "fallback reason",
    };

    const state = useStore.getState();
    state.setPlan(planOne);
    state.updateStep("s1", { status: "running" });
    state.incrementCompleted();
    state.incrementFailed();
    state.setPlan(planTwo);

    const next = useStore.getState();
    expect(next.currentPlanId).toBe("plan-2");
    expect(next.planSteps).toEqual({});
    expect(next.planCompleted).toBe(0);
    expect(next.planFailed).toBe(0);
    expect(next.planGoals["plan-1"]).toBe("initial-goal");
    expect(next.planGoals["plan-2"]).toBe("fallback reason");
  });

  it("handles incident reducer edge cases and banner dedupe", () => {
    const incidentA: Incident = {
      id: "inc-1",
      severity: "critical",
      description: "Disk issue",
      status: "open",
      detected_at: "2026-03-31T00:00:00.000Z",
    };
    const incidentB: Incident = {
      id: "inc-2",
      severity: "warning",
      description: "CPU issue",
      status: "open",
      detected_at: "2026-03-31T00:00:10.000Z",
    };

    const state = useStore.getState();
    state.addActiveIncident(incidentA);
    state.addActiveIncident(incidentB);
    state.updateIncident("inc-1", { status: "healing" });
    state.resolveIncident("inc-1", { status: "resolved", resolution: "done" });
    state.resolveIncident("missing", { status: "resolved" });

    state.toggleIncidentExpanded("inc-2");
    state.toggleIncidentExpanded("inc-2");
    state.addHealingBanner({ id: "inc-2", type: "paused", message: "paused" });
    state.addHealingBanner({ id: "inc-2", type: "escalated", message: "escalated" });
    state.removeHealingBanner("inc-2");

    const next = useStore.getState();
    expect(next.activeIncidents.map((i) => i.id)).toEqual(["inc-2"]);
    expect(next.recentIncidents[0]).toEqual(expect.objectContaining({ id: "inc-1", status: "resolved" }));
    expect(next.expandedIncidents["inc-2"]).toBe(false);
    expect(next.healingBanners).toEqual([]);
  });

  it("caps metric history/toast history and preserves missing metric values", () => {
    const state = useStore.getState();
    for (let i = 0; i < 25; i += 1) {
      state.addHealth(makeHealth(i, i + 1));
      state.addToast({
        type: "info",
        title: `Toast ${i}`,
        message: "message",
      });
    }
    state.addHealth(makeHealth(undefined, undefined));

    const next = useStore.getState();
    expect(next.healthHistory).toHaveLength(26);
    expect(next.metricHistory.cpu).toHaveLength(20);
    expect(next.metricHistory.ram).toHaveLength(20);
    expect(next.toasts).toHaveLength(20);
    expect(next.toasts[0].title).toBe("Toast 24");
  });
});
