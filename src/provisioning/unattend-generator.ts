// ============================================================
// vClaw — Unattend Generator
// Per-OS strategies for generating unattended-install payloads:
//   Windows -> autounattend.xml
//   Ubuntu/Debian/Fedora cloud images -> cloud-init user-data
//   Fedora/Rocky network installs -> kickstart
//
// SCAFFOLD: Every strategy throws a clearly-labeled TODO.
// The dispatcher picks the right strategy by OsTarget.
// ============================================================

import type {
  OsTarget,
  ProvisioningHints,
  UnattendConfig,
  UnattendGenerator,
} from "./types.js";

// ── Defaults used by every generator ────────────────────────

const DEFAULT_LOCALE = "en-US";
const DEFAULT_KEYBOARD = "us";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_USERNAME = "vclaw";

function resolveCommonFields(hints?: ProvisioningHints) {
  return {
    locale: hints?.locale ?? DEFAULT_LOCALE,
    keyboard: hints?.keyboard ?? DEFAULT_KEYBOARD,
    timezone: hints?.timezone ?? DEFAULT_TIMEZONE,
    username: hints?.username ?? DEFAULT_USERNAME,
  };
}

// ── Windows autounattend.xml generator ──────────────────────

/**
 * Generates an autounattend.xml that drives the Windows OOBE
 * end-to-end without any keyboard input.
 *
 * Real implementation will need:
 *   1. Embed/template a Windows Setup spec with WindowsPE,
 *      offlineServicing, generalize, specialize, oobeSystem
 *      passes.
 *   2. Skip OOBE network screen (Win11) and BypassNRO
 *      registry hack for "no Microsoft account required".
 *   3. Set product key (or KMS placeholder) by edition.
 *   4. Configure local admin + auto-logon for first boot.
 *   5. Stage post-install scripts via SetupComplete.cmd.
 */
export class WindowsAutounattendGenerator implements UnattendGenerator {
  readonly supports = [
    "windows-11",
    "windows-10",
    "windows-server-2022",
    "windows-server-2019",
  ] as const;

  async generate(target: OsTarget, hints?: ProvisioningHints): Promise<UnattendConfig> {
    if (!this.supports.includes(target as (typeof this.supports)[number])) {
      throw new Error(`WindowsAutounattendGenerator does not support ${target}`);
    }
    // Capture the inputs we WOULD render so the planner has a
    // structured record; the actual XML body is left empty.
    const _common = resolveCommonFields(hints);
    throw new Error(`TODO: implement Windows autounattend.xml generation for ${target}`);
  }
}

// ── cloud-init generator (Ubuntu / Debian / Fedora cloud) ───

/**
 * Generates a cloud-init user-data + meta-data pair for cloud
 * images. Most cloud images already ship cloud-init, so this is
 * the path of least resistance for Ubuntu, Debian, and Fedora.
 *
 * Real implementation will need:
 *   1. Render a #cloud-config YAML with:
 *      - users (with sudo + ssh_authorized_keys)
 *      - packages
 *      - locale / keyboard / timezone
 *      - hostname
 *      - runcmd hooks for post-install steps
 *   2. Build a NoCloud seed ISO (or pass via VM CD-ROM) so the
 *      cloud-init datasource picks it up at first boot.
 */
export class CloudInitGenerator implements UnattendGenerator {
  readonly supports = [
    "ubuntu-24.04",
    "ubuntu-22.04",
    "debian-12",
    "fedora-40",
  ] as const;

  async generate(target: OsTarget, hints?: ProvisioningHints): Promise<UnattendConfig> {
    if (!this.supports.includes(target as (typeof this.supports)[number])) {
      throw new Error(`CloudInitGenerator does not support ${target}`);
    }
    const _common = resolveCommonFields(hints);
    throw new Error(`TODO: implement cloud-init user-data generation for ${target}`);
  }
}

// ── Kickstart generator (Rocky / RHEL-style) ────────────────

/**
 * Generates an Anaconda kickstart file for network installs of
 * Rocky / RHEL-style distros. Used when a cloud image is not
 * the right fit (e.g. installing onto bare-ish VM disks from
 * the netinst ISO).
 *
 * Real implementation will need:
 *   1. Emit `lang`, `keyboard`, `timezone`, `rootpw --lock`,
 *      `user --groups=wheel --name=...` directives.
 *   2. Partition layout via `clearpart` + `autopart` or explicit.
 *   3. `%packages` list with @core baseline.
 *   4. `%post --erroronfail` for SSH key install + post-install.
 */
export class KickstartGenerator implements UnattendGenerator {
  readonly supports = ["rocky-9"] as const;

  async generate(target: OsTarget, hints?: ProvisioningHints): Promise<UnattendConfig> {
    if (!this.supports.includes(target as (typeof this.supports)[number])) {
      throw new Error(`KickstartGenerator does not support ${target}`);
    }
    const _common = resolveCommonFields(hints);
    throw new Error(`TODO: implement kickstart generation for ${target}`);
  }
}

// ── Dispatcher ───────────────────────────────────────────────

export class UnattendGeneratorDispatcher {
  private readonly generators: UnattendGenerator[];

  constructor(generators?: UnattendGenerator[]) {
    this.generators = generators ?? [
      new WindowsAutounattendGenerator(),
      new CloudInitGenerator(),
      new KickstartGenerator(),
    ];
  }

  pick(target: OsTarget): UnattendGenerator {
    const g = this.generators.find((gen) =>
      (gen.supports as readonly OsTarget[]).includes(target),
    );
    if (!g) {
      throw new Error(`No unattend generator registered for OS target: ${target}`);
    }
    return g;
  }

  generate(target: OsTarget, hints?: ProvisioningHints): Promise<UnattendConfig> {
    return this.pick(target).generate(target, hints);
  }
}
