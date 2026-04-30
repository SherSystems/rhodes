// ============================================================
// vClaw — Provisioning Module
// End-to-end VM provisioning planning (scaffold).
// ============================================================

import type { ToolDefinition } from "../providers/types.js";

export { ProvisioningPlanner, defaultsForOs } from "./planner.js";
export type { ProvisioningPlannerDeps } from "./planner.js";

export {
  IsoResolverDispatcher,
  WindowsFwlinkResolver,
  UbuntuReleasesResolver,
  FedoraMirrorResolver,
} from "./iso-resolver.js";

export {
  UnattendGeneratorDispatcher,
  WindowsAutounattendGenerator,
  CloudInitGenerator,
  KickstartGenerator,
} from "./unattend-generator.js";

export { osFamily } from "./types.js";
export type {
  IsoResolver,
  IsoSource,
  LinuxUnattendConfig,
  OsFamily,
  OsTarget,
  PostInstallStep,
  ProvisioningHints,
  ProvisioningHypervisor,
  ProvisioningPlan,
  ProvisioningStatus,
  ProvisioningTarget,
  ProvisioningVmConfig,
  UnattendConfig,
  UnattendGenerator,
  VmHardwareDefaults,
  VmProvisioningRequest,
  WindowsUnattendConfig,
} from "./types.js";

// ── Tool definitions ────────────────────────────────────────

const ADAPTER_NAME = "provisioning";

/**
 * Tool definitions exposed to the agent planner / LLM.
 *
 * SCAFFOLD: These describe the surface area but the matching
 * adapter `execute()` paths are not wired yet. See
 * docs/provisioning.md.
 */
export const provisioningTools: ToolDefinition[] = [
  {
    name: "provision_plan_vm",
    description:
      "Plan an end-to-end VM provisioning run from a natural-language request. " +
      "Resolves an OS target, picks sane VM hardware defaults, and produces a " +
      "ProvisioningPlan that downstream tools can execute. Does not download " +
      "ISOs, generate unattend files, or create VMs — call `provision_execute_plan` " +
      "for that (TODO: not yet implemented).",
    tier: "read",
    adapter: ADAPTER_NAME,
    params: [
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "Natural-language description of the VM you want, e.g. 'Windows 11 VM for a trading bot'",
      },
      {
        name: "hypervisor",
        type: "string",
        required: true,
        description: "Target hypervisor: proxmox | vmware | aws | azure",
      },
      {
        name: "os",
        type: "string",
        required: false,
        description: "Optional OS hint, e.g. 'windows-11', 'ubuntu-24.04'",
      },
      {
        name: "vm_name",
        type: "string",
        required: false,
        description: "Optional VM name override",
      },
      {
        name: "cpu_count",
        type: "number",
        required: false,
        description: "Optional vCPU count override",
      },
      {
        name: "memory_mib",
        type: "number",
        required: false,
        description: "Optional RAM (MiB) override",
      },
      {
        name: "disk_gb",
        type: "number",
        required: false,
        description: "Optional disk size (GiB) override",
      },
    ],
    returns: "ProvisioningPlan with vmConfig, isoSource (placeholder), unattend (placeholder), and status='pending'",
  },
  {
    name: "provision_resolve_iso",
    description:
      "Resolve a download URL + metadata for an OS target. " +
      "TODO: per-OS resolvers (Windows fwlink, Ubuntu releases, Fedora mirrors) " +
      "are stubbed.",
    tier: "read",
    adapter: ADAPTER_NAME,
    params: [
      {
        name: "os",
        type: "string",
        required: true,
        description: "OS target slug, e.g. 'windows-11', 'ubuntu-24.04'",
      },
    ],
    returns: "IsoSource { url, sha256, sizeMb, requiresFormBypass, source, resolvedAt }",
  },
  {
    name: "provision_generate_unattend",
    description:
      "Render an unattended-install payload (autounattend.xml, cloud-init " +
      "user-data, or kickstart) for the given OS target. " +
      "TODO: generators are stubbed.",
    tier: "read",
    adapter: ADAPTER_NAME,
    params: [
      {
        name: "os",
        type: "string",
        required: true,
        description: "OS target slug, e.g. 'windows-11', 'ubuntu-24.04'",
      },
      {
        name: "username",
        type: "string",
        required: false,
        description: "Initial admin / cloud-init user (default: vclaw)",
      },
      {
        name: "ssh_public_key",
        type: "string",
        required: false,
        description: "Optional SSH public key for the user (Linux only for now)",
      },
    ],
    returns: "UnattendConfig (Windows XML or Linux YAML/kickstart)",
  },
  {
    name: "provision_execute_plan",
    description:
      "Execute a ProvisioningPlan: download the ISO, write the unattend " +
      "payload, create the VM on the target hypervisor, and run post-install " +
      "steps. TODO: not yet implemented in the scaffold.",
    tier: "risky_write",
    adapter: ADAPTER_NAME,
    params: [
      {
        name: "plan_id",
        type: "string",
        required: true,
        description: "ID of a previously-created ProvisioningPlan",
      },
    ],
    returns: "ProvisioningPlan with status='completed' (or 'failed') and updated step results",
  },
];
