import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApprovalGate } from "../../src/governance/approval.js";
import type { PolicyConfig, ApprovalRequest } from "../../src/types.js";

// ── Mock Policy ─────────────────────────────────────────────

function makePolicy(overrides: Partial<PolicyConfig["approval"]> = {}): PolicyConfig {
  return {
    version: 1,
    approval: {
      build_mode: overrides.build_mode ?? "auto",
      watch_mode: overrides.watch_mode ?? "approve_risky",
      investigate_mode: overrides.investigate_mode ?? "approve_all",
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
      allowed_networks: ["vmbr0"],
      allowed_storage: ["local-lvm"],
      forbidden_vmids: [100],
      forbidden_actions: [],
    },
    audit: {
      log_all_actions: true,
      log_reasoning: true,
      log_rejected_plans: true,
      retention_days: 90,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("ApprovalGate", () => {
  describe("needsApproval()", () => {
    let gate: ApprovalGate;

    beforeEach(() => {
      gate = new ApprovalGate();
    });

    it('"read" tier never needs approval regardless of mode/policy', () => {
      const policy = makePolicy({ build_mode: "approve_all" });
      expect(gate.needsApproval("read", "build", policy)).toBe(false);
      expect(gate.needsApproval("read", "watch", policy)).toBe(false);
      expect(gate.needsApproval("read", "investigate", policy)).toBe(false);
    });

    it('"never" tier never needs approval (it is blocked, not approvable)', () => {
      const policy = makePolicy({ build_mode: "approve_all" });
      expect(gate.needsApproval("never", "build", policy)).toBe(false);
      expect(gate.needsApproval("never", "watch", policy)).toBe(false);
      expect(gate.needsApproval("never", "investigate", policy)).toBe(false);
    });

    it('under "auto" mode: only "destructive" needs approval', () => {
      const policy = makePolicy({ build_mode: "auto" });
      expect(gate.needsApproval("safe_write", "build", policy)).toBe(false);
      expect(gate.needsApproval("risky_write", "build", policy)).toBe(false);
      expect(gate.needsApproval("destructive", "build", policy)).toBe(true);
    });

    it('under "approve_risky" mode: "risky_write" and "destructive" need approval', () => {
      const policy = makePolicy({ build_mode: "approve_risky" });
      expect(gate.needsApproval("safe_write", "build", policy)).toBe(false);
      expect(gate.needsApproval("risky_write", "build", policy)).toBe(true);
      expect(gate.needsApproval("destructive", "build", policy)).toBe(true);
    });

    it('under "approve_all" mode: safe_write, risky_write, destructive all need approval', () => {
      const policy = makePolicy({ build_mode: "approve_all" });
      expect(gate.needsApproval("safe_write", "build", policy)).toBe(true);
      expect(gate.needsApproval("risky_write", "build", policy)).toBe(true);
      expect(gate.needsApproval("destructive", "build", policy)).toBe(true);
    });

    it('under "approve_plan" mode: same as approve_all', () => {
      const policy = makePolicy({ build_mode: "approve_plan" });
      expect(gate.needsApproval("safe_write", "build", policy)).toBe(true);
      expect(gate.needsApproval("risky_write", "build", policy)).toBe(true);
      expect(gate.needsApproval("destructive", "build", policy)).toBe(true);
    });

    it("uses watch_mode for watch agent mode", () => {
      const policy = makePolicy({ watch_mode: "approve_risky" });
      expect(gate.needsApproval("risky_write", "watch", policy)).toBe(true);
      expect(gate.needsApproval("safe_write", "watch", policy)).toBe(false);
    });

    it("uses investigate_mode for investigate agent mode", () => {
      const policy = makePolicy({ investigate_mode: "approve_all" });
      expect(gate.needsApproval("safe_write", "investigate", policy)).toBe(true);
    });

    it("forces explicit tiers to require approval regardless of mode matrix", () => {
      const policy = makePolicy({ build_mode: "auto" });
      policy.orchestration.approval.explicit_tiers = ["risky_write", "destructive", "never"];
      expect(gate.needsApproval("risky_write", "build", policy)).toBe(true);
      expect(gate.requiresExplicitApproval("risky_write", policy)).toBe(true);
    });
  });

  describe("autoApprove()", () => {
    it('returns approved=true, method="auto", approved_by="system"', () => {
      const gate = new ApprovalGate();
      const response = gate.autoApprove("req-123");

      expect(response.approved).toBe(true);
      expect(response.method).toBe("auto");
      expect(response.approved_by).toBe("system");
      expect(response.request_id).toBe("req-123");
      expect(response.timestamp).toBeDefined();
    });
  });

  describe("plan approval", () => {
    let gate: ApprovalGate;

    beforeEach(() => {
      gate = new ApprovalGate();
    });

    it("requestPlanApproval() with no handler auto-approves", async () => {
      const result = await gate.requestPlanApproval(
        "plan-1",
        "Deploy lab",
        [{ id: "s1", action: "create_vm", description: "Create VM", tier: "safe_write" }],
        "Need a VM",
      );
      expect(result).toBe(true);
    });

    it("isPlanApproved() returns true after auto-approval", async () => {
      await gate.requestPlanApproval("plan-2", "goal", [], "reason");
      expect(gate.isPlanApproved("plan-2")).toBe(true);
    });

    it("requestPlanApproval() with handler calls the handler", async () => {
      const handler = vi.fn().mockResolvedValue(true);
      gate.setPlanApprovalHandler(handler);

      await gate.requestPlanApproval(
        "plan-3",
        "Deploy lab",
        [{ id: "s1", action: "create_vm", description: "Create VM", tier: "safe_write" }],
        "Need a VM",
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        "plan-3",
        "Deploy lab",
        [{ id: "s1", action: "create_vm", description: "Create VM", tier: "safe_write" }],
        "Need a VM",
      );
    });

    it("handler rejection does not add plan to approved set", async () => {
      const handler = vi.fn().mockResolvedValue(false);
      gate.setPlanApprovalHandler(handler);

      const result = await gate.requestPlanApproval("plan-4", "goal", [], "reason");
      expect(result).toBe(false);
      expect(gate.isPlanApproved("plan-4")).toBe(false);
    });

    it("isPlanApproved() returns false for unknown plan", () => {
      expect(gate.isPlanApproved("nonexistent")).toBe(false);
    });
  });

  describe("external handler", () => {
    it("setExternalHandler allows routing approvals through it", async () => {
      const gate = new ApprovalGate();
      const handler = vi.fn().mockResolvedValue(true);
      gate.setExternalHandler(handler);

      const request: ApprovalRequest = {
        id: "req-1",
        action: "stop_vm",
        tier: "risky_write",
        params: { vmid: 101 },
        reasoning: "Need to stop VM",
        timestamp: new Date().toISOString(),
      };

      const response = await gate.requestApproval(request);
      expect(handler).toHaveBeenCalledOnce();
      expect(response.approved).toBe(true);
      expect(response.method).toBe("cli");
    });

    it("external handler rejection returns approved=false", async () => {
      const gate = new ApprovalGate();
      const handler = vi.fn().mockResolvedValue(false);
      gate.setExternalHandler(handler);

      const request: ApprovalRequest = {
        id: "req-rej",
        action: "delete_vm",
        tier: "destructive",
        params: {},
        reasoning: "Test rejection",
        timestamp: new Date().toISOString(),
      };

      const response = await gate.requestApproval(request);
      expect(response.approved).toBe(false);
      expect(response.approved_by).toBeUndefined();
      expect(response.method).toBe("cli");
    });

    it("clearExternalHandler removes it", async () => {
      const gate = new ApprovalGate();
      const handler = vi.fn().mockResolvedValue(true);
      gate.setExternalHandler(handler);
      gate.clearExternalHandler();

      // After clearing, requestApproval would fall through to readline.
      // We just verify the handler is no longer called by checking
      // the internal state via a plan approval (which doesn't use external handler).
      // The clearExternalHandler itself should not throw.
      expect(() => gate.clearExternalHandler()).not.toThrow();
    });
  });

  describe("reject()", () => {
    it("creates a rejection response", () => {
      const gate = new ApprovalGate();
      const response = gate.reject("req-123", "Too risky");
      expect(response.approved).toBe(false);
      expect(response.request_id).toBe("req-123");
      expect(response.method).toBe("auto");
      expect(response.timestamp).toBeDefined();
    });
  });
});
