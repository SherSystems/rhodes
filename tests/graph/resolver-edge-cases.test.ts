// ============================================================
// Resolver Edge Cases — name normalization, suffix variants,
// ambiguity behavior.
//
// The base resolver normalizes via:
//   lowercase → strip /\.(local|lan|home|internal)$/ → trim
//
// We pin down:
//   - Suffix variants (.local, .lan, .home, .internal) all match
//     against the bare name.
//   - Case folding (ESXI-01 ↔ esxi-01) works.
//   - Trailing whitespace on either side does not block a match.
//   - Mixed suffix vs. bare (esxi-01 ↔ esxi-01.local) matches.
//   - Cross-suffix (esxi-01.lan ↔ esxi-01.home) matches both
//     normalize to bare `esxi-01`.
//   - A Proxmox-VM-name collision (two distinct VMs named `esxi-01`)
//     creates the cartesian product of matches against any
//     vsphere_host of the same name. This documents the current
//     behavior; production should add a secondary signal.
//
// Companion to:
//   - tests/graph/integration-manifests-as.test.ts
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore, runResolver, z } from "../../src/graph/index.js";

describe("resolver — name normalization edge cases", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-graph-resolver-edges-"));
    store = new GraphStore(join(dir, "graph.db"));

    store.registerResourceType({
      provider: "proxmox",
      type: "proxmox_vm",
      interfaceLabels: ["ComputeWorkload"],
      allowedStates: ["running", "stopped", "unknown"],
      propertiesSchema: z.object({ vmid: z.number(), node: z.string() }),
    });
    store.registerResourceType({
      provider: "vsphere",
      type: "vsphere_host",
      interfaceLabels: ["ComputeNode"],
      allowedStates: ["running", "unknown"],
      propertiesSchema: z.object({ moid: z.string() }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Tiny DSL to keep cases compact.
  function seedPair(vmName: string, hostName: string, idSuffix: string): void {
    store.upsertResource({
      id: `proxmox:proxmox_vm:${idSuffix}`,
      provider: "proxmox",
      type: "proxmox_vm",
      name: vmName,
      observedState: "running",
      properties: { vmid: Number(idSuffix) || 100, node: "pranavlab" },
    });
    store.upsertResource({
      id: `vsphere:vsphere_host:host-${idSuffix}`,
      provider: "vsphere",
      type: "vsphere_host",
      name: hostName,
      observedState: "running",
      properties: { moid: `host-${idSuffix}` },
    });
  }

  it("matches bare ↔ .local suffix", () => {
    seedPair("esxi-01", "esxi-01.local", "200");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches bare ↔ .lan suffix", () => {
    seedPair("esxi-02", "esxi-02.lan", "201");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches bare ↔ .home suffix", () => {
    seedPair("esxi-03", "esxi-03.home", "202");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches bare ↔ .internal suffix", () => {
    seedPair("esxi-04", "esxi-04.internal", "203");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches across two different suffixes (.lan ↔ .home)", () => {
    seedPair("esxi-05.lan", "esxi-05.home", "204");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches case-insensitively (ESXI-01 ↔ esxi-01)", () => {
    seedPair("ESXI-06", "esxi-06", "205");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches with mixed case + suffix (ESXI-07.LOCAL ↔ esxi-07)", () => {
    seedPair("ESXI-07.LOCAL", "esxi-07", "206");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("matches when trailing whitespace appears on either side", () => {
    seedPair("esxi-08  ", "  esxi-08.local", "207");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(1);
  });

  it("does NOT match unrelated suffix .corp (not in the allowlist)", () => {
    seedPair("esxi-09.corp", "esxi-09.local", "208");
    const { matches } = runResolver(store);
    // 'esxi-09.corp' is not in the strip allowlist, so it stays as-is
    // and doesn't normalize to 'esxi-09'. No match.
    expect(matches).toHaveLength(0);
  });

  it("does NOT match different leaf names (esxi-10a ↔ esxi-10b)", () => {
    seedPair("esxi-10a", "esxi-10b.local", "209");
    const { matches } = runResolver(store);
    expect(matches).toHaveLength(0);
  });

  it("documents ambiguity: two Proxmox VMs with the same name BOTH link to a single vSphere host (cartesian product)", () => {
    // This is the current, intentionally simple, behavior. Production
    // should disambiguate via a secondary signal (IP/MAC). We pin the
    // behavior so any future change is a deliberate test edit, not a
    // silent regression.
    store.upsertResource({
      id: "proxmox:proxmox_vm:300",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-dup",
      observedState: "running",
      properties: { vmid: 300, node: "pranavlab" },
    });
    store.upsertResource({
      id: "proxmox:proxmox_vm:301",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-dup",
      observedState: "running",
      properties: { vmid: 301, node: "nuc-1" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-dup",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-dup.local",
      observedState: "running",
      properties: { moid: "host-dup" },
    });

    const { matches, edgesUpserted } = runResolver(store);
    expect(matches.length).toBe(2);
    expect(edgesUpserted).toBe(2);
    const froms = new Set(matches.map((m) => m.fromId));
    expect(froms).toEqual(
      new Set(["proxmox:proxmox_vm:300", "proxmox:proxmox_vm:301"]),
    );
  });

  it("documents ambiguity: one Proxmox VM matches TWO same-named vSphere hosts (rare but possible)", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:400",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "esxi-amb",
      observedState: "running",
      properties: { vmid: 400, node: "pranavlab" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-amb-1",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-amb",
      observedState: "running",
      properties: { moid: "host-amb-1" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-amb-2",
      provider: "vsphere",
      type: "vsphere_host",
      name: "esxi-amb.local",
      observedState: "running",
      properties: { moid: "host-amb-2" },
    });

    const { matches } = runResolver(store);
    expect(matches.length).toBe(2);
    const tos = new Set(matches.map((m) => m.toId));
    expect(tos).toEqual(
      new Set([
        "vsphere:vsphere_host:host-amb-1",
        "vsphere:vsphere_host:host-amb-2",
      ]),
    );
  });

  it("does NOT match between two Proxmox VMs (rule only matches proxmox_vm ↔ vsphere_host)", () => {
    store.upsertResource({
      id: "proxmox:proxmox_vm:500",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "twin",
      observedState: "running",
      properties: { vmid: 500, node: "pranavlab" },
    });
    store.upsertResource({
      id: "proxmox:proxmox_vm:501",
      provider: "proxmox",
      type: "proxmox_vm",
      name: "twin",
      observedState: "running",
      properties: { vmid: 501, node: "nuc-1" },
    });

    const { matches } = runResolver(store);
    expect(matches).toHaveLength(0);
  });

  it("does NOT match between two vSphere hosts (rule is directional)", () => {
    store.upsertResource({
      id: "vsphere:vsphere_host:host-x",
      provider: "vsphere",
      type: "vsphere_host",
      name: "twin",
      observedState: "running",
      properties: { moid: "host-x" },
    });
    store.upsertResource({
      id: "vsphere:vsphere_host:host-y",
      provider: "vsphere",
      type: "vsphere_host",
      name: "twin.local",
      observedState: "running",
      properties: { moid: "host-y" },
    });

    const { matches } = runResolver(store);
    expect(matches).toHaveLength(0);
  });
});
