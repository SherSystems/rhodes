import { describe, it, expect } from "vitest";
import {
  evaluateRules,
  DEFAULT_RULES,
  type RuleMatch,
} from "../../src/autopilot/rules.js";
import type {
  AutopilotRule,
  ClusterState,
  VMInfo,
  NodeInfo,
  StorageInfo,
} from "../../src/types.js";

// ── Helpers ──────────────────────────────────────────────────

function makeClusterState(overrides?: Partial<ClusterState>): ClusterState {
  return {
    adapter: "test",
    nodes: [],
    vms: [],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeNode(overrides?: Partial<NodeInfo>): NodeInfo {
  return {
    id: "node1",
    name: "pve1",
    status: "online",
    cpu_cores: 8,
    cpu_usage_pct: 20,
    ram_total_mb: 32768,
    ram_used_mb: 8000,
    disk_total_gb: 500,
    disk_used_gb: 100,
    disk_usage_pct: 20,
    uptime_s: 86400,
    ...overrides,
  };
}

function makeVm(overrides?: Partial<VMInfo>): VMInfo {
  return {
    id: 100,
    name: "test-vm",
    node: "pve1",
    status: "running",
    cpu_cores: 2,
    ram_mb: 2048,
    disk_gb: 32,
    ...overrides,
  };
}

function makeStorage(overrides?: Partial<StorageInfo>): StorageInfo {
  return {
    id: "local-lvm",
    node: "pve1",
    type: "lvmthin",
    total_gb: 500,
    used_gb: 100,
    available_gb: 400,
    content: ["images", "rootdir"],
    ...overrides,
  };
}

function makeRule(overrides?: Partial<AutopilotRule>): AutopilotRule {
  return {
    id: "test_rule",
    name: "Test Rule",
    condition: "vm_was_running_now_stopped",
    action: "start_vm",
    params: {},
    tier: "safe_write",
    enabled: true,
    cooldown_s: 120,
    ...overrides,
  };
}

// ── DEFAULT_RULES ────────────────────────────────────────────

describe("DEFAULT_RULES", () => {
  it("has 6 rules (4 cluster + 2 probe-driven)", () => {
    expect(DEFAULT_RULES).toHaveLength(6);
  });

  it("all rules are enabled", () => {
    for (const rule of DEFAULT_RULES) {
      expect(rule.enabled).toBe(true);
    }
  });

  it("contains the expected rule IDs", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(ids).toEqual([
      "vm_auto_restart",
      "resource_alert_ram",
      "resource_alert_disk",
      "node_offline_alert",
      "service_unreachable_restart",
      "provider_unreachable_alert",
    ]);
  });
});

// ── evaluateRules ────────────────────────────────────────────

describe("evaluateRules", () => {
  it("skips disabled rules", () => {
    const rule = makeRule({ enabled: false });
    const state = makeClusterState();
    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("skips rules within cooldown period", () => {
    const now = new Date();
    const triggeredAt = new Date(now.getTime() - 60_000); // 60s ago
    const rule = makeRule({
      condition: "node_ram_above_90",
      action: "alert",
      cooldown_s: 300,
      last_triggered_at: triggeredAt.toISOString(),
    });

    const state = makeClusterState({
      nodes: [makeNode({ ram_used_mb: 30000, ram_total_mb: 32768 })],
    });

    const matches = evaluateRules([rule], state, null, now);
    expect(matches).toHaveLength(0);
  });

  it("triggers rules after cooldown expires", () => {
    const now = new Date();
    const triggeredAt = new Date(now.getTime() - 400_000); // 400s ago
    const rule = makeRule({
      condition: "node_ram_above_90",
      action: "alert",
      cooldown_s: 300,
      last_triggered_at: triggeredAt.toISOString(),
    });

    const state = makeClusterState({
      nodes: [makeNode({ ram_used_mb: 30000, ram_total_mb: 32768 })],
    });

    const matches = evaluateRules([rule], state, null, now);
    expect(matches).toHaveLength(1);
  });
});

// ── vm_was_running_now_stopped ───────────────────────────────

describe("vm_was_running_now_stopped", () => {
  const rule = makeRule({
    id: "vm_auto_restart",
    condition: "vm_was_running_now_stopped",
    action: "start_vm",
  });

  it("detects a VM that was running and is now stopped", () => {
    const prev = makeClusterState({
      vms: [makeVm({ id: 100, status: "running" })],
    });
    const curr = makeClusterState({
      vms: [makeVm({ id: 100, status: "stopped" })],
    });

    const matches = evaluateRules([rule], curr, prev, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].action).toBe("start_vm");
  });

  it("returns no match when there is no previous state", () => {
    const curr = makeClusterState({
      vms: [makeVm({ id: 100, status: "stopped" })],
    });

    const matches = evaluateRules([rule], curr, null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("returns no match when the VM was already stopped", () => {
    const prev = makeClusterState({
      vms: [makeVm({ id: 100, status: "stopped" })],
    });
    const curr = makeClusterState({
      vms: [makeVm({ id: 100, status: "stopped" })],
    });

    const matches = evaluateRules([rule], curr, prev, new Date());
    expect(matches).toHaveLength(0);
  });

  it("returns correct params (vmid, node, vm_name)", () => {
    const prev = makeClusterState({
      vms: [makeVm({ id: 200, name: "web-srv", node: "pve2", status: "running" })],
    });
    const curr = makeClusterState({
      vms: [makeVm({ id: 200, name: "web-srv", node: "pve2", status: "stopped" })],
    });

    const matches = evaluateRules([rule], curr, prev, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({
      vmid: 200,
      node: "pve2",
      vm_name: "web-srv",
    });
  });
});

// ── node_ram_above_90 ────────────────────────────────────────

describe("node_ram_above_90", () => {
  const rule = makeRule({
    id: "resource_alert_ram",
    condition: "node_ram_above_90",
    action: "alert",
    params: { severity: "warning" },
  });

  it("detects a node with RAM usage above 90%", () => {
    const state = makeClusterState({
      nodes: [makeNode({ ram_used_mb: 30000, ram_total_mb: 32768 })],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].params.severity).toBe("warning");
  });

  it("returns no match when RAM is below 90%", () => {
    const state = makeClusterState({
      nodes: [makeNode({ ram_used_mb: 16000, ram_total_mb: 32768 })],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("skips offline nodes", () => {
    const state = makeClusterState({
      nodes: [
        makeNode({
          status: "offline",
          ram_used_mb: 30000,
          ram_total_mb: 32768,
        }),
      ],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("skips nodes with 0 total RAM", () => {
    const state = makeClusterState({
      nodes: [makeNode({ ram_total_mb: 0, ram_used_mb: 0 })],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });
});

// ── storage_above_95 ─────────────────────────────────────────

describe("storage_above_95", () => {
  const rule = makeRule({
    id: "resource_alert_disk",
    condition: "storage_above_95",
    action: "alert",
    params: { severity: "critical" },
  });

  it("detects storage above 95% used", () => {
    const state = makeClusterState({
      storage: [makeStorage({ total_gb: 500, used_gb: 490, available_gb: 10 })],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].params.severity).toBe("critical");
  });

  it("returns no match when below 95%", () => {
    const state = makeClusterState({
      storage: [makeStorage({ total_gb: 500, used_gb: 400, available_gb: 100 })],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("skips storage with 0 total", () => {
    const state = makeClusterState({
      storage: [makeStorage({ total_gb: 0, used_gb: 0, available_gb: 0 })],
    });

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });
});

// ── node_went_offline ────────────────────────────────────────

describe("node_went_offline", () => {
  const rule = makeRule({
    id: "node_offline_alert",
    condition: "node_went_offline",
    action: "alert",
    params: { severity: "critical" },
  });

  it("detects a node that went from online to offline", () => {
    const prev = makeClusterState({
      nodes: [makeNode({ id: "node1", status: "online" })],
    });
    const curr = makeClusterState({
      nodes: [makeNode({ id: "node1", status: "offline" })],
    });

    const matches = evaluateRules([rule], curr, prev, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].params.severity).toBe("critical");
  });

  it("returns no match without previous state", () => {
    const curr = makeClusterState({
      nodes: [makeNode({ id: "node1", status: "offline" })],
    });

    const matches = evaluateRules([rule], curr, null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("returns no match when node was already offline", () => {
    const prev = makeClusterState({
      nodes: [makeNode({ id: "node1", status: "offline" })],
    });
    const curr = makeClusterState({
      nodes: [makeNode({ id: "node1", status: "offline" })],
    });

    const matches = evaluateRules([rule], curr, prev, new Date());
    expect(matches).toHaveLength(0);
  });
});

// ── Unknown condition ────────────────────────────────────────

describe("unknown condition", () => {
  it("returns empty matches for an unknown condition string", () => {
    const rule = makeRule({ condition: "does_not_exist" });
    const state = makeClusterState();

    const matches = evaluateRules([rule], state, null, new Date());
    expect(matches).toHaveLength(0);
  });
});
