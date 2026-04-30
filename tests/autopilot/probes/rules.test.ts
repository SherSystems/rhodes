import { describe, it, expect } from "vitest";
import { evaluateRules, DEFAULT_RULES } from "../../../src/autopilot/rules.js";
import { ProbeScheduler } from "../../../src/autopilot/probes/scheduler.js";
import { EventBus } from "../../../src/agent/events.js";
import type { ProbeDef } from "../../../src/autopilot/probes/schema.js";
import type { ProbeRunner } from "../../../src/autopilot/probes/probers.js";
import type {
  AutopilotRule,
  ClusterState,
  VMInfo,
} from "../../../src/types.js";

function makeRule(overrides?: Partial<AutopilotRule>): AutopilotRule {
  return {
    id: "service_unreachable_restart",
    name: "Restart on service unreachable",
    condition: "service_unreachable",
    action: "restart_vm",
    params: { severity: "critical" },
    tier: "risky_write",
    enabled: true,
    cooldown_s: 600,
    per_entity_cooldown_s: 600,
    ...overrides,
  };
}

function makeVm(overrides?: Partial<VMInfo>): VMInfo {
  return {
    id: 201,
    name: "esxi-nested",
    node: "pve1",
    status: "running",
    cpu_cores: 4,
    ram_mb: 8192,
    disk_gb: 64,
    ...overrides,
  };
}

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

function makeProbe(overrides?: Partial<ProbeDef>): ProbeDef {
  return {
    id: "esxi_mgmt",
    target_vm_id: 201,
    target_node: "pve1",
    kind: "tcp",
    host: "192.168.86.46",
    port: 443,
    interval_s: 60,
    timeout_ms: 5_000,
    failures_to_alert: 2,
    cooldown_s: 60,
    insecure: true,
    enabled: true,
    ...overrides,
  };
}

describe("DEFAULT_RULES (probe-driven additions)", () => {
  it("now ships 6 rules including the two probe-driven ones", () => {
    expect(DEFAULT_RULES).toHaveLength(6);
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(ids).toContain("service_unreachable_restart");
    expect(ids).toContain("provider_unreachable_alert");
  });

  it("service_unreachable_restart uses risky_write tier", () => {
    const r = DEFAULT_RULES.find(
      (r) => r.id === "service_unreachable_restart",
    );
    expect(r?.tier).toBe("risky_write");
    expect(r?.action).toBe("restart_vm");
  });

  it("provider_unreachable_alert uses alert action and read tier", () => {
    const r = DEFAULT_RULES.find(
      (r) => r.id === "provider_unreachable_alert",
    );
    expect(r?.action).toBe("alert");
    expect(r?.tier).toBe("read");
  });
});

describe("service_unreachable rule evaluation", () => {
  it("returns no matches when no probe scheduler is provided", () => {
    const rule = makeRule();
    const matches = evaluateRules([rule], makeClusterState(), null, new Date());
    expect(matches).toHaveLength(0);
  });

  it("returns no matches when no probes are alerting", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = async () => ({
      ok: true,
      duration_ms: 1,
      detail: "ok",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe()],
      runnerOverrides: { tcp },
    });
    await scheduler.runOnce("esxi_mgmt");

    const rule = makeRule();
    const state = makeClusterState({ vms: [makeVm()] });
    const matches = evaluateRules([rule], state, null, new Date(), scheduler);
    expect(matches).toHaveLength(0);
  });

  it("fires once a probe transitions to alerting", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = async () => ({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ failures_to_alert: 2 })],
      runnerOverrides: { tcp },
    });
    await scheduler.runOnce("esxi_mgmt"); // fail #1
    await scheduler.runOnce("esxi_mgmt"); // fail #2 — alerting

    const rule = makeRule();
    const state = makeClusterState({ vms: [makeVm()] });
    const matches = evaluateRules([rule], state, null, new Date(), scheduler);
    expect(matches).toHaveLength(1);
    expect(matches[0].action).toBe("restart_vm");
    expect(matches[0].params.probe_id).toBe("esxi_mgmt");
    expect(matches[0].params.vmid).toBe(201);
    expect(matches[0].params.vm_name).toBe("esxi-nested");
    expect(matches[0].params.node).toBe("pve1");
  });

  it("does not double-fire while the probe is still alerting (rule cooldown)", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = async () => ({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ failures_to_alert: 1 })],
      runnerOverrides: { tcp },
    });
    await scheduler.runOnce("esxi_mgmt");

    const rule = makeRule({
      last_triggered_at: new Date().toISOString(),
      cooldown_s: 600,
    });
    const matches = evaluateRules(
      [rule],
      makeClusterState(),
      null,
      new Date(),
      scheduler,
    );
    expect(matches).toHaveLength(0);
  });

  it("populates trigger string with probe identity", async () => {
    const eventBus = new EventBus();
    const tcp: ProbeRunner = async () => ({
      ok: false,
      duration_ms: 1,
      detail: "down",
      error_code: "ECONNREFUSED",
    });
    const scheduler = new ProbeScheduler(eventBus, null, {
      probes: [makeProbe({ failures_to_alert: 1 })],
      runnerOverrides: { tcp },
    });
    await scheduler.runOnce("esxi_mgmt");

    const rule = makeRule();
    const matches = evaluateRules(
      [rule],
      makeClusterState({ vms: [makeVm()] }),
      null,
      new Date(),
      scheduler,
    );
    expect(matches[0].trigger).toContain("esxi_mgmt");
  });
});

describe("provider_unreachable rule evaluation", () => {
  function makeProviderRule(): AutopilotRule {
    return {
      id: "provider_unreachable_alert",
      name: "Alert on provider unreachable",
      condition: "provider_unreachable",
      action: "alert",
      params: { severity: "critical" },
      tier: "read",
      enabled: true,
      cooldown_s: 600,
      per_entity_cooldown_s: 600,
    };
  }

  it("returns no matches when no provider is unreachable", () => {
    const eventBus = new EventBus();
    const scheduler = new ProbeScheduler(eventBus, null, { probes: [] });
    const matches = evaluateRules(
      [makeProviderRule()],
      makeClusterState(),
      null,
      new Date(),
      scheduler,
    );
    expect(matches).toHaveLength(0);
  });

  it("fires after threshold provider failures", () => {
    const eventBus = new EventBus();
    const adapter = {
      name: "proxmox",
      kind: "hypervisor" as const,
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isConnected: () => false,
      getTools: () => [],
      execute: () => Promise.resolve({ success: false }),
      getClusterState: () => Promise.reject(new Error("offline")),
    };
    const registry = {
      getHypervisorAdapters: () => [adapter],
    } as unknown as Parameters<typeof ProbeScheduler.prototype.constructor>[1];

    const scheduler = new ProbeScheduler(eventBus, registry, {
      probes: [],
      providerFailuresToAlert: 3,
    });

    scheduler.pollProviders();
    scheduler.pollProviders();
    scheduler.pollProviders();

    const matches = evaluateRules(
      [makeProviderRule()],
      makeClusterState(),
      null,
      new Date(),
      scheduler,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].action).toBe("alert");
    expect(matches[0].params.provider).toBe("proxmox");
    expect(matches[0].params.consecutive_failures).toBe(3);
  });

  it("does not fire while only N-1 failures are recorded", () => {
    const eventBus = new EventBus();
    const adapter = {
      name: "vmware",
      kind: "hypervisor" as const,
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isConnected: () => false,
      getTools: () => [],
      execute: () => Promise.resolve({ success: false }),
      getClusterState: () => Promise.reject(new Error("offline")),
    };
    const registry = {
      getHypervisorAdapters: () => [adapter],
    } as unknown as Parameters<typeof ProbeScheduler.prototype.constructor>[1];

    const scheduler = new ProbeScheduler(eventBus, registry, {
      probes: [],
      providerFailuresToAlert: 3,
    });
    scheduler.pollProviders();
    scheduler.pollProviders();

    const matches = evaluateRules(
      [makeProviderRule()],
      makeClusterState(),
      null,
      new Date(),
      scheduler,
    );
    expect(matches).toHaveLength(0);
  });
});

// ── schema awareness ──────────────────────────────────────────

describe("schema awareness of new conditions/actions", () => {
  it("KNOWN_CONDITIONS includes service_unreachable + provider_unreachable", async () => {
    const { KNOWN_CONDITIONS } = await import(
      "../../../src/autopilot/schema.js"
    );
    expect(KNOWN_CONDITIONS).toContain("service_unreachable");
    expect(KNOWN_CONDITIONS).toContain("provider_unreachable");
  });

  it("KNOWN_ACTIONS includes restart_vm", async () => {
    const { KNOWN_ACTIONS } = await import(
      "../../../src/autopilot/schema.js"
    );
    expect(KNOWN_ACTIONS).toContain("restart_vm");
  });
});
