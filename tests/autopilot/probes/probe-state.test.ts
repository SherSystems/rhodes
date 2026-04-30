import { describe, it, expect } from "vitest";
import {
  ProbeStateTracker,
  ProviderHealthTracker,
  buildProbeKey,
} from "../../../src/autopilot/probes/probe-state.js";
import type { ProbeDef } from "../../../src/autopilot/probes/schema.js";

function makeProbe(overrides?: Partial<ProbeDef>): ProbeDef {
  return {
    id: "p1",
    target_vm_id: 201,
    target_node: "pve1",
    kind: "tcp",
    host: "127.0.0.1",
    port: 443,
    interval_s: 60,
    timeout_ms: 5_000,
    failures_to_alert: 3,
    cooldown_s: 300,
    insecure: true,
    enabled: true,
    ...overrides,
  };
}

describe("buildProbeKey", () => {
  it("uses target_vm_id when present", () => {
    expect(buildProbeKey(makeProbe({ target_vm_id: 201 }))).toBe("p1:201");
  });

  it("falls back to target_host when target_vm_id is missing", () => {
    const probe = makeProbe({
      target_vm_id: undefined,
      target_host: "esxi-mgmt",
    });
    expect(buildProbeKey(probe)).toBe("p1:esxi-mgmt");
  });

  it("falls back to a stable anonymous key when neither is set", () => {
    const probe = makeProbe({
      target_vm_id: undefined,
      target_host: undefined,
    });
    expect(buildProbeKey(probe)).toBe("p1:_anon");
  });
});

describe("ProbeStateTracker", () => {
  it("starts with zero consecutive failures", () => {
    const t = new ProbeStateTracker();
    expect(t.consecutiveFailures(makeProbe())).toBe(0);
    expect(t.isAlerting(makeProbe())).toBe(false);
  });

  it("increments consecutive failures on each failed result", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe();
    const t0 = new Date();
    t.recordResult(p, false, t0);
    expect(t.consecutiveFailures(p)).toBe(1);
    t.recordResult(p, false, new Date(t0.getTime() + 1_000));
    expect(t.consecutiveFailures(p)).toBe(2);
  });

  it("does not alert until failures_to_alert is reached", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe({ failures_to_alert: 3 });
    const t0 = new Date();

    let outcome = t.recordResult(p, false, t0);
    expect(outcome).toEqual({
      kind: "failure",
      consecutiveFailures: 1,
      crossedThreshold: false,
    });
    expect(t.isAlerting(p)).toBe(false);

    outcome = t.recordResult(p, false, new Date(t0.getTime() + 1_000));
    expect(outcome).toEqual({
      kind: "failure",
      consecutiveFailures: 2,
      crossedThreshold: false,
    });
    expect(t.isAlerting(p)).toBe(false);

    outcome = t.recordResult(p, false, new Date(t0.getTime() + 2_000));
    expect(outcome).toEqual({
      kind: "failure",
      consecutiveFailures: 3,
      crossedThreshold: true,
    });
    expect(t.isAlerting(p)).toBe(true);
  });

  it("only reports `crossedThreshold` once per alerting episode", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe({ failures_to_alert: 2 });
    const t0 = new Date();

    t.recordResult(p, false, t0);
    const crossing = t.recordResult(p, false, new Date(t0.getTime() + 1_000));
    expect(crossing).toEqual({
      kind: "failure",
      consecutiveFailures: 2,
      crossedThreshold: true,
    });

    const stillFailing = t.recordResult(
      p,
      false,
      new Date(t0.getTime() + 2_000),
    );
    expect(stillFailing).toEqual({
      kind: "failure",
      consecutiveFailures: 3,
      crossedThreshold: false,
    });
  });

  it("resets consecutive failures and alerting on success", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe({ failures_to_alert: 2 });
    const t0 = new Date();
    t.recordResult(p, false, t0);
    t.recordResult(p, false, new Date(t0.getTime() + 1_000));
    expect(t.isAlerting(p)).toBe(true);

    const recovery = t.recordResult(p, true, new Date(t0.getTime() + 2_000));
    expect(recovery).toEqual({ kind: "success", transitionedToHealthy: true });
    expect(t.consecutiveFailures(p)).toBe(0);
    expect(t.isAlerting(p)).toBe(false);
  });

  it("does not report transitionedToHealthy for routine successes", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe();
    const t0 = new Date();
    const out = t.recordResult(p, true, t0);
    expect(out).toEqual({ kind: "success", transitionedToHealthy: false });
  });

  it("tracks per-(probe, target) state independently", () => {
    const t = new ProbeStateTracker();
    const a = makeProbe({ id: "p1", target_vm_id: 201 });
    const b = makeProbe({ id: "p1", target_vm_id: 202 });

    const t0 = new Date();
    t.recordResult(a, false, t0);
    t.recordResult(a, false, new Date(t0.getTime() + 1_000));
    t.recordResult(b, true, new Date(t0.getTime() + 2_000));

    expect(t.consecutiveFailures(a)).toBe(2);
    expect(t.consecutiveFailures(b)).toBe(0);
  });

  it("canRemediate returns admitted when no remediation has happened", () => {
    const t = new ProbeStateTracker();
    const result = t.canRemediate(makeProbe(), new Date());
    expect(result.admitted).toBe(true);
  });

  it("canRemediate blocks until cooldown_s has elapsed", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe({ cooldown_s: 60 });
    const t0 = new Date();
    t.recordRemediation(p, t0);

    const within = t.canRemediate(p, new Date(t0.getTime() + 30_000));
    expect(within.admitted).toBe(false);
    if (!within.admitted) {
      expect(within.retryAfterMs).toBeGreaterThan(0);
      expect(within.retryAfterMs).toBeLessThanOrEqual(60_000);
    }

    const after = t.canRemediate(p, new Date(t0.getTime() + 61_000));
    expect(after.admitted).toBe(true);
  });

  it("reset() with no id clears all entries", () => {
    const t = new ProbeStateTracker();
    t.recordResult(makeProbe(), false, new Date());
    expect(t.snapshot().length).toBeGreaterThan(0);
    t.reset();
    expect(t.snapshot()).toEqual([]);
  });

  it("reset(probeId) only clears the matching probe entries", () => {
    const t = new ProbeStateTracker();
    t.recordResult(makeProbe({ id: "p_a" }), false, new Date());
    t.recordResult(makeProbe({ id: "p_b" }), false, new Date());
    t.reset("p_a");
    const keys = t.snapshot().map((s) => s.key);
    expect(keys.some((k) => k.startsWith("p_a:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("p_b:"))).toBe(true);
  });

  it("snapshot exposes consecutive failures and timestamps", () => {
    const t = new ProbeStateTracker();
    const p = makeProbe({ failures_to_alert: 2 });
    const t0 = new Date();
    t.recordResult(p, false, t0);
    t.recordResult(p, false, new Date(t0.getTime() + 1_000));

    const snap = t.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].consecutiveFailures).toBe(2);
    expect(snap[0].alerting).toBe(true);
    expect(snap[0].lastFailure).toBe(t0.getTime() + 1_000);
  });
});

describe("ProviderHealthTracker", () => {
  it("starts with zero consecutive failures", () => {
    const t = new ProviderHealthTracker(3);
    expect(t.isAlerting("proxmox")).toBe(false);
  });

  it("crosses threshold at the configured count", () => {
    const t = new ProviderHealthTracker(3);
    const t0 = new Date();
    let out = t.recordResult("proxmox", false, t0, "ECONNREFUSED");
    expect(out.crossedThreshold).toBe(false);
    out = t.recordResult("proxmox", false, new Date(t0.getTime() + 1_000));
    expect(out.crossedThreshold).toBe(false);
    out = t.recordResult("proxmox", false, new Date(t0.getTime() + 2_000));
    expect(out.crossedThreshold).toBe(true);
    expect(out.consecutiveFailures).toBe(3);
    expect(t.isAlerting("proxmox")).toBe(true);
  });

  it("recovers on a success after failures and reports transition", () => {
    const t = new ProviderHealthTracker(2);
    const t0 = new Date();
    t.recordResult("vmware", false, t0, "ETIMEDOUT");
    t.recordResult("vmware", false, new Date(t0.getTime() + 1_000));
    expect(t.isAlerting("vmware")).toBe(true);

    const recovered = t.recordResult(
      "vmware",
      true,
      new Date(t0.getTime() + 2_000),
    );
    expect(recovered.ok).toBe(true);
    expect(recovered.transitionedToHealthy).toBe(true);
    expect(t.isAlerting("vmware")).toBe(false);
  });

  it("isolates per-provider state", () => {
    const t = new ProviderHealthTracker(2);
    const t0 = new Date();
    t.recordResult("proxmox", false, t0);
    t.recordResult("proxmox", false, new Date(t0.getTime() + 1_000));
    expect(t.isAlerting("proxmox")).toBe(true);
    expect(t.isAlerting("vmware")).toBe(false);
  });

  it("snapshot includes the lastError for diagnostics", () => {
    const t = new ProviderHealthTracker(1);
    t.recordResult("proxmox", false, new Date(), "auth failed");
    const snap = t.snapshot();
    expect(snap.find((s) => s.name === "proxmox")?.lastError).toBe(
      "auth failed",
    );
  });
});
