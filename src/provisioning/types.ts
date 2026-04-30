// ============================================================
// vClaw — VM Provisioning Types
// End-to-end VM provisioning planning: ISO resolve → download
// → unattend generation → VM create on a target hypervisor.
//
// SCAFFOLD: Most behaviour is stubbed. See docs/provisioning.md
// for the prioritized TODO list.
// ============================================================

// ── OS Targets ──────────────────────────────────────────────

/**
 * Supported OS targets for VM provisioning.
 * Add more variants as resolver/unattend support lands.
 */
export type OsTarget =
  | "windows-11"
  | "windows-10"
  | "windows-server-2022"
  | "windows-server-2019"
  | "ubuntu-24.04"
  | "ubuntu-22.04"
  | "debian-12"
  | "fedora-40"
  | "rocky-9";

export type OsFamily = "windows" | "linux";

/**
 * High-level guess at OS family for an OsTarget.
 * Used to pick firmware, TPM, disk bus, etc.
 */
export function osFamily(target: OsTarget): OsFamily {
  return target.startsWith("windows") ? "windows" : "linux";
}

// ── Provisioning Request ────────────────────────────────────

/**
 * What the user asked for, in natural language plus optional
 * structured hints. The planner is responsible for resolving
 * this into a concrete ProvisioningPlan.
 */
export interface VmProvisioningRequest {
  /**
   * Free-form natural language prompt from the user.
   * Example: "Spin up a Windows 11 VM for running a trading bot."
   */
  prompt: string;

  /**
   * Optional structured hints. When present, the planner should
   * prefer these over LLM inference.
   */
  hints?: ProvisioningHints;
}

export interface ProvisioningHints {
  os?: OsTarget;
  vmName?: string;
  cpuCount?: number;
  memoryMiB?: number;
  diskGb?: number;
  /** Locale tag, e.g. "en-US". */
  locale?: string;
  /** Keyboard layout, e.g. "us". */
  keyboard?: string;
  /** Time zone, e.g. "America/Los_Angeles". */
  timezone?: string;
  /**
   * Initial username. Windows: local admin. Linux: cloud-init user.
   */
  username?: string;
  /**
   * Optional public SSH key to install for `username`. Linux only
   * for the scaffold; Windows OpenSSH support is a future TODO.
   */
  sshPublicKey?: string;
  /**
   * Free-form workload tag — fed to the planner so it can right-size
   * the VM (e.g. "trading-bot", "k8s-node", "build-agent").
   */
  workload?: string;
}

// ── Target Hypervisor ───────────────────────────────────────

export type ProvisioningHypervisor = "proxmox" | "vmware" | "aws" | "azure";

export interface ProvisioningTarget {
  hypervisor: ProvisioningHypervisor;
  /** Cluster node / region / resource group, depending on provider. */
  node?: string;
  /** Storage pool / datastore / disk class. */
  storage?: string;
  /** Network / port group / subnet. */
  network?: string;
}

// ── ISO Source ──────────────────────────────────────────────

export interface IsoSource {
  os: OsTarget;
  /** Direct URL to the ISO. May expire — re-resolve before download. */
  url: string;
  /** Filename to use when staging the ISO locally. */
  filename: string;
  /** SHA-256 checksum (hex), if known. Optional for pre-release ISOs. */
  sha256?: string;
  /** Approximate ISO size in MiB. Used for storage planning. */
  sizeMb?: number;
  /**
   * If true, the upstream URL is gated behind a JS form / cookie wall
   * (e.g. Microsoft download centre). The download step will need a
   * headless browser or known fwlink redirect, not a plain GET.
   */
  requiresFormBypass: boolean;
  /** Where the URL came from, for audit / re-resolution. */
  source: "fwlink" | "releases-page" | "mirror" | "manual";
  /** When this URL was resolved. */
  resolvedAt: string;
}

// ── Unattend Config ─────────────────────────────────────────

/**
 * Discriminated union of per-OS unattend payloads.
 * The generator emits the right shape for the right OS family.
 */
export type UnattendConfig =
  | WindowsUnattendConfig
  | LinuxUnattendConfig;

export interface WindowsUnattendConfig {
  kind: "windows-autounattend";
  /** Rendered XML content. Empty in the scaffold. */
  xml: string;
  /** Suggested filename, conventionally autounattend.xml. */
  filename: "autounattend.xml";
  /** Captured fields, useful for assertions and audit. */
  fields: {
    locale: string;
    keyboard: string;
    timezone: string;
    username: string;
    productKey?: string;
    /** Edition slug, e.g. "Pro", "Home", "Enterprise". */
    edition?: string;
  };
}

export interface LinuxUnattendConfig {
  /**
   * cloud-init: Ubuntu/Debian/Fedora cloud images.
   * kickstart:  Fedora/RHEL/Rocky network installs.
   */
  kind: "linux-cloud-init" | "linux-kickstart";
  /** Rendered YAML (cloud-init) or kickstart text. Empty in the scaffold. */
  content: string;
  filename: string;
  fields: {
    locale: string;
    keyboard: string;
    timezone: string;
    username: string;
    sshPublicKey?: string;
    /** Hostname to set inside the guest. */
    hostname?: string;
  };
}

// ── VM Defaults ─────────────────────────────────────────────

/**
 * Sane VM defaults for a given OS target. These are static —
 * NOT LLM-decided — so we don't hallucinate things like firmware
 * or TPM. The LLM is only responsible for sizing and naming.
 */
export interface VmHardwareDefaults {
  firmware: "bios" | "uefi";
  tpm: boolean;
  cpuType: string;
  diskBus: "sata" | "scsi" | "virtio" | "nvme";
  nicModel: "e1000" | "virtio" | "vmxnet3";
  /** Default disk size in GiB for this OS family. */
  defaultDiskGb: number;
  /** Default memory in MiB. */
  defaultMemoryMiB: number;
  /** Default vCPU count. */
  defaultCpuCount: number;
}

// ── VM Config (output of planner) ───────────────────────────

export interface ProvisioningVmConfig {
  name: string;
  os: OsTarget;
  cpuCount: number;
  memoryMiB: number;
  diskGb: number;
  hardware: VmHardwareDefaults;
}

// ── Post-install Steps ──────────────────────────────────────

/**
 * Things to do after the OS is installed but before handing the VM
 * to the user. Examples: install QEMU guest agent, run a setup
 * script, register with a config manager.
 *
 * Kept intentionally loose for now — execution is a future TODO.
 */
export interface PostInstallStep {
  name: string;
  description: string;
  /** Optional shell snippet. Generator + executor are TODO. */
  script?: string;
}

// ── Provisioning Plan ───────────────────────────────────────

export type ProvisioningStatus =
  | "pending"
  | "resolving-iso"
  | "downloading-iso"
  | "generating-unattend"
  | "creating-vm"
  | "installing-os"
  | "post-install"
  | "completed"
  | "failed";

export interface ProvisioningPlan {
  id: string;
  request: VmProvisioningRequest;
  target: ProvisioningTarget;
  vmConfig: ProvisioningVmConfig;
  isoSource: IsoSource;
  unattend: UnattendConfig;
  postInstall: PostInstallStep[];
  status: ProvisioningStatus;
  reasoning: string;
  createdAt: string;
  /** Set when the plan was last advanced to a new status. */
  updatedAt?: string;
  error?: string;
}

// ── Resolver / Generator interfaces ─────────────────────────

export interface IsoResolver {
  /** OS targets this resolver handles. */
  readonly supports: readonly OsTarget[];
  /**
   * Resolve a download URL + metadata for the given target.
   * Implementations should throw if the OS is not supported.
   */
  resolve(target: OsTarget, hints?: ProvisioningHints): Promise<IsoSource>;
}

export interface UnattendGenerator {
  readonly supports: readonly OsTarget[];
  /**
   * Render an unattend payload for the given target + hints.
   * Implementations should throw if the OS is not supported.
   */
  generate(target: OsTarget, hints?: ProvisioningHints): Promise<UnattendConfig>;
}
