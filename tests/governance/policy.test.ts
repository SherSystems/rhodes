import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "../../src/governance/policy.js";

describe("loadPolicy", () => {
  const tmpFiles: string[] = [];

  function writeTmpYaml(name: string, content: string): string {
    const p = join("/tmp", `vclaw-test-${name}-${Date.now()}.yaml`);
    writeFileSync(p, content, "utf-8");
    tmpFiles.push(p);
    return p;
  }

  afterAll(() => {
    for (const f of tmpFiles) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  });

  it("loads the default policy file successfully", () => {
    const policy = loadPolicy();
    expect(policy).toBeDefined();
    expect(policy.version).toBe(1);
  });

  it("returns correct version, guardrails, boundaries, and audit values", () => {
    const policy = loadPolicy();

    // version
    expect(policy.version).toBe(1);

    // guardrails
    expect(policy.guardrails).toEqual({
      max_vms_per_action: 5,
      max_ram_allocation_pct: 80,
      max_disk_allocation_pct: 90,
      require_snapshot_before_modify: true,
      cooldown_between_restarts_s: 60,
      max_restart_attempts: 3,
    });

    // boundaries
    expect(policy.boundaries.allowed_networks).toEqual([]);
    expect(policy.boundaries.allowed_storage).toEqual([]);
    expect(policy.boundaries.forbidden_vmids).toEqual([]);
    expect(policy.boundaries.forbidden_actions).toEqual([
      "delete_all",
      "modify_host_config",
      "disable_firewall",
      "format_storage",
    ]);

    // audit
    expect(policy.audit).toEqual({
      log_all_actions: true,
      log_reasoning: true,
      log_rejected_plans: true,
      retention_days: 90,
    });

    // orchestration
    expect(policy.orchestration.approval.explicit_tiers).toEqual([
      "destructive",
      "never",
    ]);
    expect(policy.orchestration.rollback).toEqual({
      enabled: true,
      trigger_tiers: ["risky_write", "destructive"],
      timeout_s: 60,
    });
  });

  it('normalizes "approve_fix" to "approve_risky" in investigate_mode', () => {
    // The default YAML has investigate_mode: approve_fix
    const policy = loadPolicy();
    expect(policy.approval.investigate_mode).toBe("approve_risky");
  });

  it("returns correct approval modes for build_mode and watch_mode", () => {
    const policy = loadPolicy();
    expect(policy.approval.build_mode).toBe("approve_plan");
    expect(policy.approval.watch_mode).toBe("approve_risky");
  });

  it("loads a custom YAML file", () => {
    const yamlContent = `
version: 2
approval:
  build_mode: auto
  watch_mode: approve_all
  investigate_mode: approve_plan
guardrails:
  max_vms_per_action: 10
  max_ram_allocation_pct: 95
  max_disk_allocation_pct: 95
  require_snapshot_before_modify: false
  cooldown_between_restarts_s: 30
  max_restart_attempts: 5
boundaries:
  allowed_networks:
    - vmbr0
  allowed_storage:
    - local-lvm
  forbidden_vmids:
    - 100
  forbidden_actions:
    - delete_all
audit:
  log_all_actions: false
  log_reasoning: true
  log_rejected_plans: false
  retention_days: 30
`;
    const p = writeTmpYaml("custom", yamlContent);
    const policy = loadPolicy(p);

    expect(policy.version).toBe(2);
    expect(policy.approval.build_mode).toBe("auto");
    expect(policy.approval.watch_mode).toBe("approve_all");
    expect(policy.approval.investigate_mode).toBe("approve_plan");
    expect(policy.guardrails.max_vms_per_action).toBe(10);
    expect(policy.boundaries.allowed_networks).toEqual(["vmbr0"]);
    expect(policy.boundaries.forbidden_vmids).toEqual([100]);
    expect(policy.audit.retention_days).toBe(30);
  });

  it("normalizes approve_fix in a custom YAML file", () => {
    const yamlContent = `
version: 1
approval:
  build_mode: approve_fix
  watch_mode: approve_fix
  investigate_mode: approve_fix
guardrails:
  max_vms_per_action: 1
  max_ram_allocation_pct: 50
  max_disk_allocation_pct: 50
  require_snapshot_before_modify: true
  cooldown_between_restarts_s: 0
  max_restart_attempts: 0
boundaries:
  allowed_networks: []
  allowed_storage: []
  forbidden_vmids: []
  forbidden_actions: []
audit:
  log_all_actions: true
  log_reasoning: true
  log_rejected_plans: true
  retention_days: 1
`;
    const p = writeTmpYaml("normalize", yamlContent);
    const policy = loadPolicy(p);

    expect(policy.approval.build_mode).toBe("approve_risky");
    expect(policy.approval.watch_mode).toBe("approve_risky");
    expect(policy.approval.investigate_mode).toBe("approve_risky");
  });

  it("throws on invalid YAML (missing required field)", () => {
    const yamlContent = `
version: 1
approval:
  build_mode: auto
`;
    const p = writeTmpYaml("invalid", yamlContent);
    expect(() => loadPolicy(p)).toThrow();
  });

  it("throws on non-existent file path", () => {
    expect(() => loadPolicy("/tmp/nonexistent-policy-file-xyz.yaml")).toThrow();
  });
});
