// ============================================================
// Primitives Integration — sanity-check the published capability
// surface of every registered provider.
//
// For each provider (currently vsphere + proxmox):
//   (a) at least one rollback strategy is declared
//   (b) `notes` is present whenever an emulated/caveated capability
//       is published (Proxmox emulates maintenance + LXC cold-mig)
//   (c) every verb method throws PrimitiveNotImplemented — the
//       v0.6.0 contract-only stub guarantee holds across the board
//   (d) capabilities() never throws on a registered provider
//
// Companion to:
//   - tests/primitives/capabilities.test.ts (per-provider deep)
//   - tests/primitives/registry.test.ts (registry mechanics)
// ============================================================

import { beforeAll, describe, expect, it } from "vitest";
import {
  capabilities,
  getPrimitives,
  PrimitiveNotImplemented,
  proxmoxPrimitives,
  registerPrimitives,
  registeredProviders,
  vmwarePrimitives,
} from "../../src/primitives/index.js";
import type { GraphProvider } from "../../src/graph/types.js";
import type { PrimitiveMethod } from "../../src/primitives/types.js";

// Re-bind the built-in adapters in case another file's beforeEach
// blew away the registry. The capabilities.test.ts file does the
// same trick for the same reason.
beforeAll(() => {
  registerPrimitives("vsphere", vmwarePrimitives);
  registerPrimitives("proxmox", proxmoxPrimitives);
});

const BUILT_IN_PROVIDERS: GraphProvider[] = ["vsphere", "proxmox"];

const VERB_METHODS: PrimitiveMethod[] = [
  "evacuateWorkload",
  "enterMaintenance",
  "exitMaintenance",
  "remediateHost",
  "rollback",
];

describe("provider capability surface — uniform invariants", () => {
  it.each(BUILT_IN_PROVIDERS)(
    "%s capabilities() never throws",
    (provider) => {
      expect(() => capabilities(provider)).not.toThrow();
    },
  );

  it.each(BUILT_IN_PROVIDERS)(
    "%s declares its own provider id in capabilities",
    (provider) => {
      expect(capabilities(provider).provider).toBe(provider);
    },
  );

  it.each(BUILT_IN_PROVIDERS)(
    "%s publishes at least one rollback strategy",
    (provider) => {
      const caps = capabilities(provider);
      expect(Array.isArray(caps.rollbackStrategies)).toBe(true);
      expect(caps.rollbackStrategies.length).toBeGreaterThan(0);
    },
  );

  it.each(BUILT_IN_PROVIDERS)(
    "%s publishes at least one evacuate mode",
    (provider) => {
      const caps = capabilities(provider);
      expect(caps.evacuateModes.length).toBeGreaterThan(0);
    },
  );

  it.each(BUILT_IN_PROVIDERS)(
    "%s registers in the registry (registeredProviders includes it)",
    (provider) => {
      expect(registeredProviders()).toContain(provider);
    },
  );

  it.each(VERB_METHODS)(
    "every provider's '%s' method throws PrimitiveNotImplemented (stub contract)",
    async (method) => {
      for (const provider of BUILT_IN_PROVIDERS) {
        const impl = getPrimitives(provider);
        // Build a minimal valid-looking input. The bodies don't read it.
        let invocation: Promise<unknown>;
        switch (method) {
          case "evacuateWorkload":
            invocation = impl.evacuateWorkload({
              targetId: `${provider}:vm:test`,
              provider,
              mode: "live_migrate",
            });
            break;
          case "enterMaintenance":
            invocation = impl.enterMaintenance({
              hostId: `${provider}:host:test`,
              provider,
              evacuate: false,
            });
            break;
          case "exitMaintenance":
            invocation = impl.exitMaintenance({
              hostId: `${provider}:host:test`,
              provider,
            });
            break;
          case "remediateHost":
            invocation = impl.remediateHost({
              hostId: `${provider}:host:test`,
              provider,
            });
            break;
          case "rollback":
            invocation = impl.rollback({
              planId: "plan-test",
              stepId: "step-test",
              provider,
              strategy: "snapshot_restore",
            });
            break;
        }
        await expect(invocation!).rejects.toBeInstanceOf(
          PrimitiveNotImplemented,
        );
      }
    },
  );
});

describe("notes presence for emulated / caveated providers", () => {
  it("proxmox documents its LXC cold-migration caveat (notes is required)", () => {
    const caps = capabilities("proxmox");
    expect(caps.notes).toBeDefined();
    expect((caps.notes ?? "").toLowerCase()).toMatch(/lxc|cold/);
  });

  it("proxmox documents that maintenance mode is emulated (HA cordon)", () => {
    const caps = capabilities("proxmox");
    expect(caps.notes).toBeDefined();
    const lower = (caps.notes ?? "").toLowerCase();
    expect(lower).toMatch(/cordon|emulat/);
    // The provider STILL advertises maintenance support — emulated
    // is fine as long as the notes document the truth.
    expect(caps.maintenanceModeSupported).toBe(true);
  });

  it("vsphere documents vMotion preconditions (vMotion / DRS / vLCM)", () => {
    const caps = capabilities("vsphere");
    expect(caps.notes).toBeDefined();
    expect((caps.notes ?? "").toLowerCase()).toMatch(/vmotion|drs|vlcm/);
  });
});

describe("cross-provider differentiation (anti-LCD-trap)", () => {
  it("at least one rollback strategy differs between providers", () => {
    const vsphereStrategies = new Set(
      capabilities("vsphere").rollbackStrategies,
    );
    const proxmoxStrategies = new Set(
      capabilities("proxmox").rollbackStrategies,
    );
    // Symmetric diff is non-empty.
    const sd = new Set<string>();
    for (const s of vsphereStrategies)
      if (!proxmoxStrategies.has(s)) sd.add(s);
    for (const s of proxmoxStrategies)
      if (!vsphereStrategies.has(s)) sd.add(s);
    expect(sd.size).toBeGreaterThan(0);
  });
});
