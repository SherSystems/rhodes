import { describe, it, expect, beforeEach } from "vitest";
import type { GraphProvider } from "../../src/graph/types.js";
import {
  capabilities,
  getPrimitives,
  PrimitiveNotImplemented,
  ProviderNotRegistered,
  registerPrimitives,
  registeredProviders,
  resetRegistry,
  type Primitives,
  type ProviderCapabilities,
} from "../../src/primitives/index.js";

// ── Helpers ────────────────────────────────────────────────

function makeStubPrimitives(provider: GraphProvider): Primitives {
  const caps: ProviderCapabilities = {
    provider,
    evacuateModes: ["live_migrate"],
    maintenanceModeSupported: true,
    hostRemediationSupported: false,
    rollbackStrategies: ["snapshot_restore"],
    notes: "test stub",
  };
  return {
    capabilities: () => caps,
    evacuateWorkload: async () => {
      throw new PrimitiveNotImplemented(provider, "evacuateWorkload");
    },
    enterMaintenance: async () => {
      throw new PrimitiveNotImplemented(provider, "enterMaintenance");
    },
    exitMaintenance: async () => {
      throw new PrimitiveNotImplemented(provider, "exitMaintenance");
    },
    remediateHost: async () => {
      throw new PrimitiveNotImplemented(provider, "remediateHost");
    },
    rollback: async () => {
      throw new PrimitiveNotImplemented(provider, "rollback");
    },
  };
}

describe("primitives registry", () => {
  beforeEach(() => {
    resetRegistry();
    // Re-import the index module to re-run the side-effects? No — the
    // side-effects ran once at process start. Tests that need the
    // built-in vmware/proxmox bindings re-register them via the
    // exported objects (see capabilities.test.ts).
  });

  it("registers and retrieves a provider's primitives", () => {
    const stub = makeStubPrimitives("vsphere");
    registerPrimitives("vsphere", stub);

    const got = getPrimitives("vsphere");
    expect(got).toBe(stub);
    expect(got.capabilities().provider).toBe("vsphere");
  });

  it("throws ProviderNotRegistered when nothing is bound", () => {
    expect(() => getPrimitives("aws")).toThrow(ProviderNotRegistered);
    expect(() => capabilities("aws")).toThrow(ProviderNotRegistered);
  });

  it("includes the provider name in ProviderNotRegistered.message", () => {
    try {
      getPrimitives("azure");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotRegistered);
      expect((err as Error).message).toContain("azure");
    }
  });

  it("re-registration overwrites the previous binding", () => {
    const first = makeStubPrimitives("proxmox");
    const second = makeStubPrimitives("proxmox");
    registerPrimitives("proxmox", first);
    registerPrimitives("proxmox", second);
    expect(getPrimitives("proxmox")).toBe(second);
    expect(getPrimitives("proxmox")).not.toBe(first);
  });

  it("lists registered providers", () => {
    registerPrimitives("vsphere", makeStubPrimitives("vsphere"));
    registerPrimitives("proxmox", makeStubPrimitives("proxmox"));
    const providers = registeredProviders().sort();
    expect(providers).toEqual(["proxmox", "vsphere"]);
  });

  it("capabilities() is a thin pass-through to getPrimitives().capabilities()", () => {
    const stub = makeStubPrimitives("kubernetes");
    registerPrimitives("kubernetes", stub);
    expect(capabilities("kubernetes")).toBe(stub.capabilities());
  });

  it("resetRegistry clears every binding", () => {
    registerPrimitives("vsphere", makeStubPrimitives("vsphere"));
    registerPrimitives("proxmox", makeStubPrimitives("proxmox"));
    resetRegistry();
    expect(registeredProviders()).toEqual([]);
    expect(() => getPrimitives("vsphere")).toThrow(ProviderNotRegistered);
  });

  it("PrimitiveNotImplemented carries provider, method, and version", async () => {
    const stub = makeStubPrimitives("vsphere");
    registerPrimitives("vsphere", stub);

    await expect(
      getPrimitives("vsphere").evacuateWorkload({
        targetId: "vsphere:vsphere_vm:vm-101",
        provider: "vsphere",
        mode: "live_migrate",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);

    try {
      await getPrimitives("vsphere").remediateHost({
        hostId: "vsphere:vsphere_host:host-1",
        provider: "vsphere",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PrimitiveNotImplemented);
      const e = err as PrimitiveNotImplemented;
      expect(e.provider).toBe("vsphere");
      expect(e.method).toBe("remediateHost");
      expect(e.message).toMatch(/not yet implemented/i);
      expect(e.message).toMatch(/v0\.6\.0 contract-only/i);
    }
  });
});
