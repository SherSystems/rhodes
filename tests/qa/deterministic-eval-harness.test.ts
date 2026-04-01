import { describe, it, expect } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { GovernanceEngine } from "../../src/governance/index.js";
import type { PolicyConfig, ToolDefinition } from "../../src/types.js";

type HarnessScenario = {
  id: string;
  class: "golden" | "adversarial";
  mode: "build" | "watch" | "investigate";
  action: string;
  params: Record<string, unknown>;
  approvalResult?: boolean;
  policyOverride?: Partial<PolicyConfig>;
  prepare?: (engine: GovernanceEngine) => Promise<void>;
  expected: {
    allowed: boolean;
    tier: "read" | "safe_write" | "risky_write" | "destructive" | "never";
    needsApproval: boolean;
    reasonIncludes?: string;
  };
};

const TOOLS: ToolDefinition[] = [
  {
    name: "list_vms",
    description: "List VMs",
    tier: "read",
    adapter: "test",
    params: [],
    returns: "VMInfo[]",
  },
  {
    name: "create_vm",
    description: "Create VM",
    tier: "safe_write",
    adapter: "test",
    params: [],
    returns: "VMInfo",
  },
  {
    name: "restart_vm",
    description: "Restart VM",
    tier: "risky_write",
    adapter: "test",
    params: [],
    returns: "StepResult",
  },
  {
    name: "delete_vm",
    description: "Delete VM",
    tier: "destructive",
    adapter: "test",
    params: [],
    returns: "StepResult",
  },
];

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  const base: PolicyConfig = {
    version: 1,
    approval: {
      build_mode: "auto",
      watch_mode: "approve_risky",
      investigate_mode: "approve_all",
    },
    orchestration: {
      approval: {
        explicit_tiers: ["destructive", "never"],
      },
      rollback: {
        enabled: true,
        trigger_tiers: ["risky_write", "destructive"],
        timeout_s: 60,
      },
    },
    guardrails: {
      max_vms_per_action: 5,
      max_ram_allocation_pct: 80,
      max_disk_allocation_pct: 80,
      require_snapshot_before_modify: true,
      cooldown_between_restarts_s: 60,
      max_restart_attempts: 3,
    },
    boundaries: {
      allowed_networks: ["vmbr0", "vmbr1"],
      allowed_storage: ["local-lvm", "ceph-pool"],
      forbidden_vmids: [100, 101],
      forbidden_actions: [],
    },
    audit: {
      log_all_actions: true,
      log_reasoning: true,
      log_rejected_plans: true,
      retention_days: 90,
    },
  };

  return {
    ...base,
    ...overrides,
    approval: { ...base.approval, ...overrides.approval },
    orchestration: {
      approval: {
        ...base.orchestration.approval,
        ...overrides.orchestration?.approval,
      },
      rollback: {
        ...base.orchestration.rollback,
        ...overrides.orchestration?.rollback,
      },
    },
    guardrails: { ...base.guardrails, ...overrides.guardrails },
    boundaries: { ...base.boundaries, ...overrides.boundaries },
    audit: { ...base.audit, ...overrides.audit },
  };
}

function dbPathFor(id: string): string {
  return `/tmp/vclaw-deterministic-harness-${id}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.db`;
}

function removeDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        // no-op in tests
      }
    }
  }
}

const SCENARIOS: HarnessScenario[] = [
  {
    id: "G01",
    class: "golden",
    mode: "build",
    action: "list_vms",
    params: {},
    expected: { allowed: true, tier: "read", needsApproval: false },
  },
  {
    id: "G02",
    class: "golden",
    mode: "build",
    action: "create_vm",
    params: { network: "vmbr0", storage: "local-lvm" },
    expected: { allowed: true, tier: "safe_write", needsApproval: false },
  },
  {
    id: "G03",
    class: "golden",
    mode: "build",
    action: "restart_vm",
    params: { vmid: 200 },
    expected: { allowed: true, tier: "risky_write", needsApproval: false },
  },
  {
    id: "G04",
    class: "golden",
    mode: "build",
    action: "delete_vm",
    params: { vmid: 200 },
    approvalResult: true,
    expected: { allowed: true, tier: "destructive", needsApproval: true },
  },
  {
    id: "A01",
    class: "adversarial",
    mode: "build",
    action: "delete_vm",
    params: { vmid: 200 },
    approvalResult: false,
    expected: {
      allowed: false,
      tier: "destructive",
      needsApproval: true,
      reasonIncludes: "rejected",
    },
  },
  {
    id: "G05",
    class: "golden",
    mode: "watch",
    action: "list_vms",
    params: {},
    expected: { allowed: true, tier: "read", needsApproval: false },
  },
  {
    id: "G06",
    class: "golden",
    mode: "watch",
    action: "create_vm",
    params: { network: "vmbr1", storage: "ceph-pool" },
    expected: { allowed: true, tier: "safe_write", needsApproval: false },
  },
  {
    id: "G07",
    class: "golden",
    mode: "watch",
    action: "restart_vm",
    params: { vmid: 201 },
    approvalResult: true,
    expected: { allowed: true, tier: "risky_write", needsApproval: true },
  },
  {
    id: "A02",
    class: "adversarial",
    mode: "watch",
    action: "restart_vm",
    params: { vmid: 201 },
    approvalResult: false,
    expected: {
      allowed: false,
      tier: "risky_write",
      needsApproval: true,
      reasonIncludes: "rejected",
    },
  },
  {
    id: "G08",
    class: "golden",
    mode: "investigate",
    action: "create_vm",
    params: { vmid: 202, network: "vmbr0", storage: "local-lvm" },
    approvalResult: true,
    expected: { allowed: true, tier: "safe_write", needsApproval: true },
  },
  {
    id: "A03",
    class: "adversarial",
    mode: "investigate",
    action: "create_vm",
    params: { vmid: 202, network: "vmbr0", storage: "local-lvm" },
    approvalResult: false,
    expected: {
      allowed: false,
      tier: "safe_write",
      needsApproval: true,
      reasonIncludes: "rejected",
    },
  },
  {
    id: "A04",
    class: "adversarial",
    mode: "build",
    action: "delete_all",
    params: {},
    expected: {
      allowed: false,
      tier: "never",
      needsApproval: false,
      reasonIncludes: "forbidden",
    },
  },
  {
    id: "A05",
    class: "adversarial",
    mode: "build",
    action: "create_vm",
    params: {},
    policyOverride: {
      boundaries: { forbidden_actions: ["create_vm"] },
    },
    expected: {
      allowed: false,
      tier: "safe_write",
      needsApproval: false,
      reasonIncludes: "forbidden actions list",
    },
  },
  {
    id: "A06",
    class: "adversarial",
    mode: "build",
    action: "create_vm",
    params: { count: 6 },
    expected: {
      allowed: false,
      tier: "risky_write",
      needsApproval: false,
      reasonIncludes: "max_vms_per_action",
    },
  },
  {
    id: "A07",
    class: "adversarial",
    mode: "build",
    action: "restart_vm",
    params: { vmid: 100 },
    expected: {
      allowed: false,
      tier: "risky_write",
      needsApproval: false,
      reasonIncludes: "forbidden list",
    },
  },
  {
    id: "A08",
    class: "adversarial",
    mode: "build",
    action: "create_vm",
    params: { network: "vmbr99" },
    expected: {
      allowed: false,
      tier: "safe_write",
      needsApproval: false,
      reasonIncludes: "allowed networks",
    },
  },
  {
    id: "A09",
    class: "adversarial",
    mode: "build",
    action: "create_vm",
    params: { storage: "nfs-untrusted" },
    expected: {
      allowed: false,
      tier: "safe_write",
      needsApproval: false,
      reasonIncludes: "allowed storage",
    },
  },
  {
    id: "G09",
    class: "golden",
    mode: "watch",
    action: "create_vm",
    params: { count: 2 },
    approvalResult: true,
    expected: { allowed: true, tier: "risky_write", needsApproval: true },
  },
  {
    id: "G10",
    class: "golden",
    mode: "build",
    action: "create_vm",
    params: { force: true },
    approvalResult: true,
    expected: { allowed: true, tier: "destructive", needsApproval: true },
  },
  {
    id: "G11",
    class: "golden",
    mode: "watch",
    action: "restart_vm",
    params: { _plan_id: "plan-approved", vmid: 204 },
    prepare: async (engine) => {
      await engine.approvalGate.requestPlanApproval(
        "plan-approved",
        "restart unhealthy vm",
        [],
        "deterministic harness plan-level approval",
      );
    },
    expected: {
      allowed: true,
      tier: "risky_write",
      needsApproval: false,
      reasonIncludes: "plan-level approval",
    },
  },
  {
    id: "A10",
    class: "adversarial",
    mode: "watch",
    action: "delete_vm",
    params: { _plan_id: "plan-approved", vmid: 204 },
    prepare: async (engine) => {
      await engine.approvalGate.requestPlanApproval(
        "plan-approved",
        "destructive action still needs explicit approval",
        [],
        "deterministic harness destructive plan test",
      );
    },
    approvalResult: false,
    expected: {
      allowed: false,
      tier: "destructive",
      needsApproval: true,
      reasonIncludes: "rejected",
    },
  },
  {
    id: "A11",
    class: "adversarial",
    mode: "build",
    action: "restart_vm",
    params: { _plan_id: "strict-plan", vmid: 205 },
    policyOverride: {
      approval: {
        build_mode: "auto",
      },
      orchestration: {
        approval: {
          explicit_tiers: ["risky_write", "destructive", "never"],
        },
      },
    },
    prepare: async (engine) => {
      await engine.approvalGate.requestPlanApproval(
        "strict-plan",
        "ensure explicit tiers cannot bypass",
        [],
        "explicit tier gate",
      );
    },
    approvalResult: false,
    expected: {
      allowed: false,
      tier: "risky_write",
      needsApproval: true,
      reasonIncludes: "rejected",
    },
  },
];

describe("QA deterministic eval harness", () => {
  it("enforces deterministic scenario gate coverage", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    const goldenCount = SCENARIOS.filter(
      (scenario) => scenario.class === "golden",
    ).length;
    const adversarialCount = SCENARIOS.filter(
      (scenario) => scenario.class === "adversarial",
    ).length;

    expect(new Set(ids).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(goldenCount).toBeGreaterThanOrEqual(8);
    expect(adversarialCount).toBeGreaterThanOrEqual(8);
  });

  it.each(SCENARIOS)("$id: $action in $mode mode", async (scenario) => {
    const dbPath = dbPathFor(scenario.id);
    const engine = new GovernanceEngine(
      makePolicy(scenario.policyOverride),
      dbPath,
    );

    engine.approvalGate.setExternalHandler(async () => {
      return scenario.approvalResult ?? true;
    });

    try {
      if (scenario.prepare) {
        await scenario.prepare(engine);
      }

      const decision = await engine.evaluate(
        scenario.action,
        scenario.params,
        scenario.mode,
        TOOLS,
      );

      expect(decision.allowed).toBe(scenario.expected.allowed);
      expect(decision.tier).toBe(scenario.expected.tier);
      expect(decision.needs_approval).toBe(scenario.expected.needsApproval);

      if (scenario.expected.reasonIncludes) {
        expect(decision.reason).toContain(scenario.expected.reasonIncludes);
      }
    } finally {
      engine.close();
      removeDb(dbPath);
    }
  });
});
