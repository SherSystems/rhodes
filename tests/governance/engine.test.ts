import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { GovernanceEngine } from "../../src/governance/index.js";
import type { PolicyConfig, ToolDefinition, AuditEntry } from "../../src/types.js";

// ── Mock Policy ─────────────────────────────────────────────

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    version: 1,
    approval: {
      build_mode: "auto",
      watch_mode: "approve_risky",
      investigate_mode: "approve_all",
      ...overrides.approval,
    },
    orchestration: {
      approval: {
        explicit_tiers: ["destructive", "never"],
        ...overrides.orchestration?.approval,
      },
      rollback: {
        enabled: true,
        trigger_tiers: ["risky_write", "destructive"],
        timeout_s: 60,
        ...overrides.orchestration?.rollback,
      },
    },
    guardrails: {
      max_vms_per_action: 5,
      max_ram_allocation_pct: 80,
      max_disk_allocation_pct: 80,
      require_snapshot_before_modify: true,
      cooldown_between_restarts_s: 60,
      max_restart_attempts: 3,
      ...overrides.guardrails,
    },
    boundaries: {
      allowed_networks: ["vmbr0", "vmbr1"],
      allowed_storage: ["local-lvm", "ceph-pool"],
      forbidden_vmids: [100, 101],
      forbidden_actions: ["nuke_everything"],
      ...overrides.boundaries,
    },
    audit: {
      log_all_actions: true,
      log_reasoning: true,
      log_rejected_plans: true,
      retention_days: 90,
      ...overrides.audit,
    },
  };
}

// ── Mock Tools ──────────────────────────────────────────────

const mockTools: ToolDefinition[] = [
  {
    name: "list_vms",
    description: "List all VMs",
    tier: "read",
    adapter: "proxmox",
    params: [],
    returns: "VMInfo[]",
  },
  {
    name: "create_vm",
    description: "Create a VM",
    tier: "safe_write",
    adapter: "proxmox",
    params: [],
    returns: "VMInfo",
  },
  {
    name: "stop_vm",
    description: "Stop a VM",
    tier: "risky_write",
    adapter: "proxmox",
    params: [],
    returns: "StepResult",
  },
  {
    name: "delete_vm",
    description: "Delete a VM",
    tier: "destructive",
    adapter: "proxmox",
    params: [],
    returns: "StepResult",
  },
];

// ── Helpers ─────────────────────────────────────────────────

function makeDbPath(): string {
  return `/tmp/vclaw-test-engine-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: overrides.id ?? `entry-${Date.now()}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    action: overrides.action ?? "create_vm",
    tier: overrides.tier ?? "safe_write",
    reasoning: overrides.reasoning ?? "Test",
    params: overrides.params ?? {},
    result: overrides.result ?? "success",
    duration_ms: overrides.duration_ms ?? 100,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("GovernanceEngine", () => {
  let dbPath: string;
  let engine: GovernanceEngine;

  beforeEach(() => {
    dbPath = makeDbPath();
    engine = new GovernanceEngine(makePolicy(), dbPath);
  });

  afterEach(() => {
    engine.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = dbPath + suffix;
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }
  });

  describe("evaluate()", () => {
    it("returns allowed=false when circuit breaker is tripped", async () => {
      // Trip the circuit breaker
      engine.circuitBreaker.track(false);
      engine.circuitBreaker.track(false);
      engine.circuitBreaker.track(false);

      const decision = await engine.evaluate("list_vms", {}, "build", mockTools);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("Circuit breaker");
    });

    it('blocks forbidden actions (tier "never")', async () => {
      const decision = await engine.evaluate("delete_all", {}, "build", mockTools);
      expect(decision.allowed).toBe(false);
      expect(decision.tier).toBe("never");
      expect(decision.reason).toContain("forbidden");
    });

    it("blocks policy forbidden_actions", async () => {
      const decision = await engine.evaluate("nuke_everything", {}, "build", mockTools);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("forbidden actions list");
    });

    it("blocks when VM count exceeds max_vms_per_action guardrail", async () => {
      const decision = await engine.evaluate(
        "create_vm",
        { count: 10 },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("max_vms_per_action");
    });

    it("blocks forbidden VMID", async () => {
      const decision = await engine.evaluate(
        "stop_vm",
        { vmid: 100 },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("forbidden");
    });

    it("blocks network not in allowed list", async () => {
      const decision = await engine.evaluate(
        "create_vm",
        { network: "vmbr99" },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("network");
    });

    it("blocks storage not in allowed list", async () => {
      const decision = await engine.evaluate(
        "create_vm",
        { storage: "nfs-untrusted" },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("storage");
    });

    it("auto-approves read tier in auto mode", async () => {
      const decision = await engine.evaluate("list_vms", {}, "build", mockTools);
      expect(decision.allowed).toBe(true);
      expect(decision.needs_approval).toBe(false);
      expect(decision.tier).toBe("read");
    });

    it("auto-approves safe_write in auto mode", async () => {
      const decision = await engine.evaluate("create_vm", {}, "build", mockTools);
      expect(decision.allowed).toBe(true);
      expect(decision.needs_approval).toBe(false);
      expect(decision.approval?.method).toBe("auto");
    });

    it("plan-level approval skips step approval for non-destructive tier", async () => {
      // First approve the plan
      await engine.approvalGate.requestPlanApproval(
        "plan-abc",
        "Deploy lab",
        [],
        "reason",
      );

      // Use approve_risky so risky_write would normally need approval
      const policyRisky = makePolicy({ approval: { build_mode: "approve_risky", watch_mode: "approve_risky", investigate_mode: "approve_all" } });
      engine.close();
      dbPath = makeDbPath();
      engine = new GovernanceEngine(policyRisky, dbPath);
      await engine.approvalGate.requestPlanApproval("plan-xyz", "goal", [], "reason");

      const decision = await engine.evaluate(
        "stop_vm",
        { _plan_id: "plan-xyz" },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain("plan-level approval");
    });

    it("plan-level approval does NOT skip approval for destructive tier", async () => {
      const policyRisky = makePolicy({ approval: { build_mode: "approve_risky", watch_mode: "approve_risky", investigate_mode: "approve_all" } });
      engine.close();
      dbPath = makeDbPath();
      engine = new GovernanceEngine(policyRisky, dbPath);

      await engine.approvalGate.requestPlanApproval("plan-dest", "goal", [], "reason");

      // Set external handler so we don't block on stdin
      engine.approvalGate.setExternalHandler(async () => false);

      const decision = await engine.evaluate(
        "delete_vm",
        { _plan_id: "plan-dest" },
        "build",
        mockTools,
      );
      // Destructive still requires individual approval even with plan approval
      expect(decision.needs_approval).toBe(true);
    });

    it("explicit approval tiers cannot be bypassed by plan-level approval", async () => {
      const strictPolicy = makePolicy({
        approval: { build_mode: "auto", watch_mode: "auto", investigate_mode: "auto" },
        orchestration: {
          approval: { explicit_tiers: ["risky_write", "destructive", "never"] },
          rollback: { enabled: true, trigger_tiers: ["risky_write", "destructive"], timeout_s: 60 },
        },
      });
      engine.close();
      dbPath = makeDbPath();
      engine = new GovernanceEngine(strictPolicy, dbPath);

      await engine.approvalGate.requestPlanApproval("plan-strict", "goal", [], "reason");

      engine.approvalGate.setExternalHandler(async () => false);
      const decision = await engine.evaluate(
        "stop_vm",
        { _plan_id: "plan-strict", vmid: 102 },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.needs_approval).toBe(true);
      expect(decision.explicit_approval_required).toBe(true);
    });

    it("allows actions with allowed network and storage", async () => {
      const decision = await engine.evaluate(
        "create_vm",
        { network: "vmbr0", storage: "local-lvm" },
        "build",
        mockTools,
      );
      expect(decision.allowed).toBe(true);
    });
  });

  describe("logAction()", () => {
    it("logs to audit when log_all_actions=true", () => {
      const entry = makeAuditEntry({ id: "log-1", result: "success" });
      engine.logAction(entry);

      const results = engine.audit.query();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("log-1");
    });

    it("logs failures even when log_all_actions=false", () => {
      engine.close();
      const policyNoLog = makePolicy({ audit: { log_all_actions: false, log_reasoning: true, log_rejected_plans: true, retention_days: 90 } });
      dbPath = makeDbPath();
      engine = new GovernanceEngine(policyNoLog, dbPath);

      const successEntry = makeAuditEntry({ id: "log-s", result: "success" });
      const failEntry = makeAuditEntry({ id: "log-f", result: "failed" });

      engine.logAction(successEntry);
      engine.logAction(failEntry);

      const results = engine.audit.query();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("log-f");
    });

    it("tracks success in circuit breaker", () => {
      engine.logAction(makeAuditEntry({ result: "success" }));
      const state = engine.circuitBreaker.getState();
      expect(state.consecutive_failures).toBe(0);
    });

    it("tracks failure in circuit breaker", () => {
      engine.logAction(makeAuditEntry({ id: "cb-f1", result: "failed" }));
      engine.logAction(makeAuditEntry({ id: "cb-f2", result: "failed" }));

      const state = engine.circuitBreaker.getState();
      expect(state.consecutive_failures).toBe(2);
    });

    it("circuit breaker trips after enough failed logAction calls", () => {
      engine.logAction(makeAuditEntry({ id: "cb-1", result: "failed" }));
      engine.logAction(makeAuditEntry({ id: "cb-2", result: "failed" }));
      engine.logAction(makeAuditEntry({ id: "cb-3", result: "failed" }));

      expect(engine.circuitBreaker.isTripped()).toBe(true);
    });
  });

  it("getAuditStats() returns stats object", () => {
    engine.logAction(makeAuditEntry({ id: "s1" }));
    const stats = engine.getAuditStats();
    expect(stats).toBeDefined();
    expect((stats as any).total).toBe(1);
  });

  it("getCircuitBreakerState() returns state object", () => {
    const state = engine.getCircuitBreakerState();
    expect(state).toBeDefined();
    expect(state.consecutive_failures).toBe(0);
    expect(state.tripped).toBe(false);
  });
});
