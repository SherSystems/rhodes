// ============================================================
// vClaw — ISO Resolver
// Per-OS strategies for resolving an OsTarget to a concrete
// download URL + metadata (sha256, size, fwlink/form gates).
//
// SCAFFOLD: Every strategy throws a clearly-labeled TODO.
// The dispatcher picks the right strategy by OsTarget so the
// rest of the provisioning pipeline can be wired up around it.
// ============================================================

import type {
  IsoResolver,
  IsoSource,
  OsTarget,
  ProvisioningHints,
} from "./types.js";

// ── Windows: fwlink redirect resolver ────────────────────────

/**
 * Resolves Windows ISOs via Microsoft fwlink IDs (e.g. the
 * official Win11 download page exposes per-edition fwlinks
 * that 302 to time-limited Azure blob URLs).
 *
 * Real implementation will need:
 *   1. Map OsTarget -> fwlink ID + edition.
 *   2. HEAD/GET the fwlink, follow the redirect chain.
 *   3. Capture final URL, sha256 (from the Microsoft hash page).
 *   4. Detect form-bypass requirements (consumer ISOs gate on JS).
 */
export class WindowsFwlinkResolver implements IsoResolver {
  readonly supports = [
    "windows-11",
    "windows-10",
    "windows-server-2022",
    "windows-server-2019",
  ] as const;

  async resolve(target: OsTarget, _hints?: ProvisioningHints): Promise<IsoSource> {
    if (!this.supports.includes(target as (typeof this.supports)[number])) {
      throw new Error(`WindowsFwlinkResolver does not support ${target}`);
    }
    throw new Error(`TODO: implement Windows ISO resolution for ${target}`);
  }
}

// ── Ubuntu: releases.ubuntu.com resolver ─────────────────────

/**
 * Resolves Ubuntu ISOs from releases.ubuntu.com.
 *
 * Real implementation will need:
 *   1. Map OsTarget -> release codename (e.g. ubuntu-24.04 -> "noble").
 *   2. GET the release directory listing, pick desktop vs server.
 *   3. Read SHA256SUMS for checksum verification.
 *   4. Prefer the closest mirror via geo-aware resolution.
 */
export class UbuntuReleasesResolver implements IsoResolver {
  readonly supports = ["ubuntu-24.04", "ubuntu-22.04", "debian-12"] as const;

  async resolve(target: OsTarget, _hints?: ProvisioningHints): Promise<IsoSource> {
    if (!this.supports.includes(target as (typeof this.supports)[number])) {
      throw new Error(`UbuntuReleasesResolver does not support ${target}`);
    }
    throw new Error(`TODO: implement Ubuntu ISO resolution for ${target}`);
  }
}

// ── Fedora / Rocky: mirror resolver ──────────────────────────

/**
 * Resolves Fedora and Rocky Linux ISOs from MirrorManager / a
 * curated mirror list.
 *
 * Real implementation will need:
 *   1. Map OsTarget -> release version + variant (Workstation/Server/etc).
 *   2. Query MirrorManager for a healthy mirror.
 *   3. Verify with the upstream CHECKSUM file (GPG-signed).
 */
export class FedoraMirrorResolver implements IsoResolver {
  readonly supports = ["fedora-40", "rocky-9"] as const;

  async resolve(target: OsTarget, _hints?: ProvisioningHints): Promise<IsoSource> {
    if (!this.supports.includes(target as (typeof this.supports)[number])) {
      throw new Error(`FedoraMirrorResolver does not support ${target}`);
    }
    throw new Error(`TODO: implement Fedora/Rocky ISO resolution for ${target}`);
  }
}

// ── Dispatcher ───────────────────────────────────────────────

/**
 * Picks the right resolver for an OsTarget.
 *
 * Resolvers are checked in registration order. The first one
 * whose `supports` includes the target wins.
 */
export class IsoResolverDispatcher {
  private readonly resolvers: IsoResolver[];

  constructor(resolvers?: IsoResolver[]) {
    this.resolvers = resolvers ?? [
      new WindowsFwlinkResolver(),
      new UbuntuReleasesResolver(),
      new FedoraMirrorResolver(),
    ];
  }

  /** Returns the resolver for `target`, or throws if none match. */
  pick(target: OsTarget): IsoResolver {
    const r = this.resolvers.find((res) =>
      (res.supports as readonly OsTarget[]).includes(target),
    );
    if (!r) {
      throw new Error(`No ISO resolver registered for OS target: ${target}`);
    }
    return r;
  }

  resolve(target: OsTarget, hints?: ProvisioningHints): Promise<IsoSource> {
    return this.pick(target).resolve(target, hints);
  }
}
