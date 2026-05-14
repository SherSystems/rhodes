import { describe, expect, it } from "vitest";
import {
  isSafetySnapshot,
  tierClass,
  tierLabel,
  TIER_LABEL,
} from "../../dashboard-v2/src/lib/approvals";
import { buildRemediatePrompt } from "../../dashboard-v2/src/lib/remediate";
import type { PendingApproval } from "../../dashboard-v2/src/api/client";
import type { Incident } from "../../dashboard-v2/src/types";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    plan_id: "plan-1234",
    request_id: "req-1",
    action: "qm migrate 200",
    tier: "destructive",
    params: {},
    reasoning: "",
    requested_at: "2026-05-13T12:00:00.000Z",
    scope: "step",
    ...overrides,
  };
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "inc-1",
    severity: "critical",
    description: "VM rhodes-vm-200 paused",
    status: "open",
    detected_at: "2026-05-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("approvals helpers — isSafetySnapshot", () => {
  it("flags a step whose snapname starts with rhodes-safety-", () => {
    const entry = makeApproval({
      action: "qm snapshot",
      params: { snapname: "rhodes-safety-2026-05-13T10-15-00" },
    });
    expect(isSafetySnapshot(entry)).toBe(true);
  });

  it("flags a step where action contains qm snapshot + rhodes-safety- inline", () => {
    const entry = makeApproval({
      action: "qm snapshot 200 rhodes-safety-2026-05-13T10-15-00",
      params: {},
    });
    expect(isSafetySnapshot(entry)).toBe(true);
  });

  it("does not flag arbitrary qm snapshots without the rhodes-safety- prefix", () => {
    const entry = makeApproval({
      action: "qm snapshot",
      params: { snapname: "before-update" },
    });
    expect(isSafetySnapshot(entry)).toBe(false);
  });

  it("does not flag non-step scopes", () => {
    const entry = makeApproval({
      scope: "plan",
      action: "qm snapshot",
      params: { snapname: "rhodes-safety-2026" },
    });
    expect(isSafetySnapshot(entry)).toBe(false);
  });

  it("returns false for null entries", () => {
    expect(isSafetySnapshot(null)).toBe(false);
  });
});

describe("approvals helpers — tierClass / tierLabel", () => {
  it.each(Object.keys(TIER_LABEL))("normalizes known tier %s", (tier) => {
    expect(tierClass(tier)).toBe(tier);
    expect(tierLabel(tier)).toBe(TIER_LABEL[tier]);
  });

  it("falls back to read for unknown tier strings", () => {
    expect(tierClass("nonsense")).toBe("read");
  });

  it("falls back to read when input strips to an unknown tier", () => {
    // "safe write" strips to "safewrite" (no underscore), which is not a
    // known tier in VALID_TIERS — so we fall back to "read" rather than
    // emit an unstyleable class name.
    expect(tierClass("safe write")).toBe("read");
  });
});

describe("remediate prompt builder", () => {
  it("uses the paused_io_error playbook callout for that exact reason", () => {
    const inc = makeIncident({
      metric: "vm_status",
      labels: {
        name: "rhodes-vm-200",
        vmid: "200",
        node: "pranavhost",
        reason: "paused_io_error",
      },
    });
    const prompt = buildRemediatePrompt(inc);
    expect(prompt).toContain("VM rhodes-vm-200 (vmid 200) on pranavhost");
    expect(prompt).toContain("paused (io-error)");
    expect(prompt).toContain("proxmox-storage-pause");
  });

  it("falls back to a generic vm_status prompt for other reasons", () => {
    const inc = makeIncident({
      metric: "vm_status",
      labels: {
        name: "rhodes-vm-200",
        node: "pranavhost",
        reason: "stopped_unexpectedly",
      },
    });
    const prompt = buildRemediatePrompt(inc);
    expect(prompt).toContain("anomaly: stopped_unexpectedly");
    expect(prompt).toContain("Propose a remediation plan");
  });

  it("uses the service prompt for service_http_status incidents", () => {
    const inc = makeIncident({
      metric: "service_http_status",
      labels: { service_name: "jellyfin" },
    });
    const prompt = buildRemediatePrompt(inc);
    expect(prompt).toContain("Investigate service jellyfin");
    expect(prompt).toContain("in-VM diagnostic playbook");
  });

  it("falls back to a generic prompt with labels JSON for unknown metrics", () => {
    const inc = makeIncident({
      metric: "node_cpu_pct",
      anomaly_type: "spike",
      labels: { node: "esxi-01" },
    });
    const prompt = buildRemediatePrompt(inc);
    expect(prompt).toContain("anomaly: spike");
    expect(prompt).toContain("node_cpu_pct");
    expect(prompt).toContain('"node":"esxi-01"');
  });

  it("returns an empty string on null incident", () => {
    expect(buildRemediatePrompt(null)).toBe("");
  });
});
