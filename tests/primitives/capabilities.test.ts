import { describe, it, expect, beforeAll } from "vitest";
import {
  PrimitiveNotImplemented,
  proxmoxPrimitives,
  registerPrimitives,
  vmwarePrimitives,
} from "../../src/primitives/index.js";

// The index module's import side-effect already registered the
// stubs, but other tests (registry.test.ts) call `resetRegistry()`
// in their beforeEach — which would leave this file's lookups
// empty if vitest interleaves. Re-binding here keeps us independent.
beforeAll(() => {
  registerPrimitives("vsphere", vmwarePrimitives);
  registerPrimitives("proxmox", proxmoxPrimitives);
});

describe("vmware capabilities", () => {
  it("never throws from capabilities()", () => {
    expect(() => vmwarePrimitives.capabilities()).not.toThrow();
  });

  it("publishes vMotion (live_migrate) and evict; NOT replace", () => {
    const caps = vmwarePrimitives.capabilities();
    expect(caps.provider).toBe("vsphere");
    expect(caps.evacuateModes).toContain("live_migrate");
    expect(caps.evacuateModes).toContain("evict");
    expect(caps.evacuateModes).not.toContain("replace");
  });

  it("publishes native maintenance + LCM host remediation", () => {
    const caps = vmwarePrimitives.capabilities();
    expect(caps.maintenanceModeSupported).toBe(true);
    expect(caps.hostRemediationSupported).toBe(true);
  });

  it("publishes blue_green + snapshot_restore + inverse_mutation rollbacks", () => {
    const caps = vmwarePrimitives.capabilities();
    expect(caps.rollbackStrategies).toContain("blue_green");
    expect(caps.rollbackStrategies).toContain("snapshot_restore");
    expect(caps.rollbackStrategies).toContain("inverse_mutation");
    // surge_teardown is a K8s/cloud pattern, not raw vSphere.
    expect(caps.rollbackStrategies).not.toContain("surge_teardown");
  });

  it("includes notes about DRS / vMotion preconditions", () => {
    const caps = vmwarePrimitives.capabilities();
    expect(caps.notes).toBeDefined();
    expect((caps.notes ?? "").toLowerCase()).toMatch(/vmotion|drs|vlcm/);
  });

  it("verb methods throw PrimitiveNotImplemented (v0.6.0 stub)", async () => {
    await expect(
      vmwarePrimitives.evacuateWorkload({
        targetId: "vsphere:vsphere_vm:vm-200",
        provider: "vsphere",
        mode: "live_migrate",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    await expect(
      vmwarePrimitives.enterMaintenance({
        hostId: "vsphere:vsphere_host:host-1",
        provider: "vsphere",
        evacuate: true,
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    await expect(
      vmwarePrimitives.exitMaintenance({
        hostId: "vsphere:vsphere_host:host-1",
        provider: "vsphere",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    await expect(
      vmwarePrimitives.remediateHost({
        hostId: "vsphere:vsphere_host:host-1",
        provider: "vsphere",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    await expect(
      vmwarePrimitives.rollback({
        planId: "plan-1",
        stepId: "step-3",
        provider: "vsphere",
        strategy: "blue_green",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);
  });
});

describe("proxmox capabilities", () => {
  it("never throws from capabilities()", () => {
    expect(() => proxmoxPrimitives.capabilities()).not.toThrow();
  });

  it("publishes live_migrate (QEMU) + evict (LXC cold-mig fallback)", () => {
    const caps = proxmoxPrimitives.capabilities();
    expect(caps.provider).toBe("proxmox");
    expect(caps.evacuateModes).toContain("live_migrate");
    expect(caps.evacuateModes).toContain("evict");
    expect(caps.evacuateModes).not.toContain("replace");
  });

  it("publishes emulated maintenance + apt-based host remediation", () => {
    const caps = proxmoxPrimitives.capabilities();
    expect(caps.maintenanceModeSupported).toBe(true);
    expect(caps.hostRemediationSupported).toBe(true);
  });

  it("publishes snapshot_restore + inverse_mutation; NOT blue_green / surge_teardown", () => {
    const caps = proxmoxPrimitives.capabilities();
    expect(caps.rollbackStrategies).toContain("snapshot_restore");
    expect(caps.rollbackStrategies).toContain("inverse_mutation");
    expect(caps.rollbackStrategies).not.toContain("blue_green");
    expect(caps.rollbackStrategies).not.toContain("surge_teardown");
  });

  it("notes call out the LXC cold-migration caveat and HA-cordon emulation", () => {
    const caps = proxmoxPrimitives.capabilities();
    expect(caps.notes).toBeDefined();
    const lower = (caps.notes ?? "").toLowerCase();
    expect(lower).toMatch(/lxc|cold/);
    expect(lower).toMatch(/emulated|ha cordon|cordon/);
  });

  it("verb methods throw PrimitiveNotImplemented (v0.6.0 stub)", async () => {
    await expect(
      proxmoxPrimitives.evacuateWorkload({
        targetId: "proxmox:proxmox_vm:200",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    await expect(
      proxmoxPrimitives.enterMaintenance({
        hostId: "proxmox:proxmox_node:pve1",
        provider: "proxmox",
        evacuate: false,
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    await expect(
      proxmoxPrimitives.rollback({
        planId: "plan-1",
        stepId: "step-1",
        provider: "proxmox",
        strategy: "snapshot_restore",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);
  });
});

describe("cross-substrate capability matrix (anti-LCD-trap)", () => {
  it("vmware advertises blue_green but proxmox does not", () => {
    expect(vmwarePrimitives.capabilities().rollbackStrategies).toContain(
      "blue_green",
    );
    expect(proxmoxPrimitives.capabilities().rollbackStrategies).not.toContain(
      "blue_green",
    );
  });

  it("both substrates publish their own provider id in capabilities", () => {
    expect(vmwarePrimitives.capabilities().provider).toBe("vsphere");
    expect(proxmoxPrimitives.capabilities().provider).toBe("proxmox");
  });
});
