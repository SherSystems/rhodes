import { describe, it, expect } from "vitest";
import {
  PLANNER_PROMPT,
  REPLANNER_PROMPT,
  INVESTIGATOR_PROMPT,
  OBSERVER_PROMPT,
  formatMultiClusterState,
} from "../../src/agent/prompts.js";
import type { MultiClusterState, ClusterState } from "../../src/types.js";

describe("PLANNER_PROMPT", () => {
  it("returns a string containing planning engine, tool descriptions, cluster state, and memory context", () => {
    const result = PLANNER_PROMPT({
      toolDescriptions: "tool: create_vm — creates a VM",
      clusterStateSummary: "3 nodes, 16GB free RAM",
      memoryContext: "User prefers Ubuntu images",
    });

    expect(result).toContain("planning engine");
    expect(result).toContain("tool: create_vm — creates a VM");
    expect(result).toContain("3 nodes, 16GB free RAM");
    expect(result).toContain("User prefers Ubuntu images");
  });

  it("uses fallback strings when context values are empty", () => {
    const result = PLANNER_PROMPT({
      toolDescriptions: "",
      clusterStateSummary: "",
      memoryContext: "",
    });

    expect(result).toContain("planning engine");
    expect(result).toContain("No tools registered.");
    expect(result).toContain("No cluster state available.");
    expect(result).toContain("No prior memory.");
  });

  it("includes the Proxmox VM lifecycle hard rule that steers the planner to typed tools over ssh_exec qm", () => {
    // Background: tonight RHODES picked `ssh_exec qm resume 200` over the
    // typed `resume_vm` tool, SSH had no key, and the recovery stalled.
    // The rule below should keep the planner on the API path even when
    // an SSH tool is registered alongside the Proxmox provider.
    const result = PLANNER_PROMPT({
      toolDescriptions: "tool: resume_vm — resume a paused Proxmox VM\ntool: ssh_exec — run a shell command",
      clusterStateSummary: "",
      memoryContext: "",
    });

    expect(result).toContain("Proxmox VM lifecycle");
    expect(result).toContain("resume_vm");
    expect(result).toContain("start_vm");
    expect(result).toContain("stop_vm");
    expect(result).toContain("reboot_vm");
    expect(result).toContain("suspend_vm");
    expect(result).toContain("reset_vm");
    // The crucial steering: never use ssh_exec when a typed tool exists.
    expect(result).toContain("Do NOT use `ssh_exec`");
    expect(result).toContain("exit 255");
    expect(result).toContain("API token");
  });
});

describe("REPLANNER_PROMPT", () => {
  it("returns a string containing replanning engine, original plan, failed step, and failure error", () => {
    const result = REPLANNER_PROMPT({
      toolDescriptions: "tool: create_vm",
      clusterStateSummary: "2 nodes online",
      originalPlan: '{"steps": []}',
      failedStep: "step_2: start_vm",
      failureError: "VM 101 not found",
      completedSteps: "step_1: create_vm completed",
      remainingSteps: "step_3: configure_vm",
    });

    expect(result).toContain("replanning engine");
    expect(result).toContain('{"steps": []}');
    expect(result).toContain("step_2: start_vm");
    expect(result).toContain("VM 101 not found");
    expect(result).toContain("step_1: create_vm completed");
    expect(result).toContain("step_3: configure_vm");
  });

  it("uses 'None' fallback when completedSteps and remainingSteps are empty", () => {
    const result = REPLANNER_PROMPT({
      toolDescriptions: "tool: create_vm",
      clusterStateSummary: "2 nodes online",
      originalPlan: '{"steps": []}',
      failedStep: "step_1: create_vm",
      failureError: "timeout",
      completedSteps: "",
      remainingSteps: "",
    });

    expect(result).toContain("replanning engine");
    // The prompt uses "None" as fallback for empty completed/remaining steps
    const completedSection = result.split("## Steps Already Completed")[1].split("##")[0];
    expect(completedSection.trim()).toBe("None");

    const remainingSection = result.split("## Remaining Steps (not yet executed)")[1].split("##")[0];
    expect(remainingSection.trim()).toBe("None");
  });
});

describe("INVESTIGATOR_PROMPT", () => {
  it("returns a string containing investigation engine, cluster state, events, and audit", () => {
    const result = INVESTIGATOR_PROMPT({
      clusterStateSummary: "node1: degraded",
      recentEvents: "VM 102 crashed at 14:00",
      recentAudit: "user admin deleted snapshot",
    });

    expect(result).toContain("investigation engine");
    expect(result).toContain("node1: degraded");
    expect(result).toContain("VM 102 crashed at 14:00");
    expect(result).toContain("user admin deleted snapshot");
  });
});

describe("OBSERVER_PROMPT", () => {
  it("returns a string containing observation engine, action, params, and state before/after", () => {
    const result = OBSERVER_PROMPT({
      stepDescription: "Create a new VM with 4GB RAM",
      action: "create_vm",
      params: '{"node": "pve1", "ram": 4096}',
      stateBefore: "3 VMs running",
      stateAfter: "4 VMs running",
      clusterStateSummary: "pve1: healthy",
    });

    expect(result).toContain("observation engine");
    expect(result).toContain("create_vm");
    expect(result).toContain('{"node": "pve1", "ram": 4096}');
    expect(result).toContain("3 VMs running");
    expect(result).toContain("4 VMs running");
    expect(result).toContain("Create a new VM with 4GB RAM");
  });
});

// ── formatMultiClusterState ─────────────────────────────────

function makeClusterState(adapter: string, overrides: Partial<ClusterState> = {}): ClusterState {
  return {
    adapter,
    nodes: [],
    vms: [],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("formatMultiClusterState", () => {
  it("formats single provider correctly", () => {
    const state: MultiClusterState = {
      providers: [
        {
          name: "proxmox",
          type: "proxmox",
          state: makeClusterState("proxmox", {
            nodes: [
              { id: "n1", name: "pve1", status: "online", cpu_cores: 16, cpu_usage_pct: 45, ram_total_mb: 65536, ram_used_mb: 40632, disk_total_gb: 2000, disk_used_gb: 800, disk_usage_pct: 40, uptime_s: 86400 },
            ],
            vms: [
              { id: 100, name: "vm-1", node: "pve1", status: "running", cpu_cores: 2, ram_mb: 2048, disk_gb: 20 },
              { id: 101, name: "vm-2", node: "pve1", status: "stopped", cpu_cores: 1, ram_mb: 1024, disk_gb: 10 },
            ],
            storage: [
              { id: "local", node: "pve1", type: "dir", total_gb: 2048, used_gb: 800, available_gb: 1248, content: ["images"] },
            ],
          }),
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const result = formatMultiClusterState(state);

    expect(result).toContain("## Connected Providers");
    expect(result).toContain("### proxmox (Proxmox)");
    expect(result).toContain("pve1: online");
    expect(result).toContain("1 running");
    expect(result).toContain("1 stopped");
    expect(result).toContain("CPU:");
    expect(result).toContain("Memory:");
    expect(result).toContain("Storage:");
  });

  it("formats multiple providers", () => {
    const state: MultiClusterState = {
      providers: [
        {
          name: "proxmox",
          type: "proxmox",
          state: makeClusterState("proxmox", {
            nodes: [{ id: "n1", name: "pve1", status: "online", cpu_cores: 16, cpu_usage_pct: 40, ram_total_mb: 32768, ram_used_mb: 16384, disk_total_gb: 1000, disk_used_gb: 400, disk_usage_pct: 40, uptime_s: 86400 }],
            vms: [{ id: 100, name: "vm-1", node: "pve1", status: "running", cpu_cores: 2, ram_mb: 2048, disk_gb: 20 }],
          }),
        },
        {
          name: "vmware",
          type: "vmware",
          state: makeClusterState("vmware", {
            nodes: [{ id: "h1", name: "esxi1", status: "online", cpu_cores: 32, cpu_usage_pct: 60, ram_total_mb: 131072, ram_used_mb: 98304, disk_total_gb: 4000, disk_used_gb: 2400, disk_usage_pct: 60, uptime_s: 172800 }],
            vms: [{ id: "vm-1", name: "win-server", node: "esxi1", status: "running", cpu_cores: 4, ram_mb: 8192, disk_gb: 100 }],
          }),
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const result = formatMultiClusterState(state);

    expect(result).toContain("### proxmox (Proxmox)");
    expect(result).toContain("### vmware (VMware)");
    expect(result).toContain("Nodes:");
    expect(result).toContain("Hosts:");
  });

  it("handles empty state (no providers)", () => {
    const state: MultiClusterState = {
      providers: [],
      timestamp: new Date().toISOString(),
    };

    const result = formatMultiClusterState(state);

    expect(result).toBe("No providers connected.");
  });

  it("handles provider with no VMs or nodes", () => {
    const state: MultiClusterState = {
      providers: [
        {
          name: "empty-proxmox",
          type: "proxmox",
          state: makeClusterState("empty-proxmox"),
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const result = formatMultiClusterState(state);

    expect(result).toContain("### empty-proxmox (Proxmox)");
    expect(result).toContain("Nodes: 0");
    expect(result).toContain("0 running");
  });
});

describe("PLANNER_PROMPT with multiClusterSummary", () => {
  it("includes multi-provider section when multiClusterSummary is provided", () => {
    const result = PLANNER_PROMPT({
      toolDescriptions: "tool: create_vm",
      clusterStateSummary: "single cluster",
      memoryContext: "memory",
      multiClusterSummary: "## Connected Providers\n### proxmox (Proxmox)\n- Nodes: 2",
    });

    expect(result).toContain("## Multi-Provider Infrastructure State");
    expect(result).toContain("## Connected Providers");
    expect(result).toContain("### proxmox (Proxmox)");
    expect(result).toContain("Multi-Provider Planning");
  });

  it("omits multi-provider section when multiClusterSummary is not provided", () => {
    const result = PLANNER_PROMPT({
      toolDescriptions: "tool: create_vm",
      clusterStateSummary: "single cluster",
      memoryContext: "memory",
    });

    expect(result).not.toContain("## Multi-Provider Infrastructure State");
  });
});
