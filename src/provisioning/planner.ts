// ============================================================
// vClaw — Provisioning Planner
// Translates a natural-language VmProvisioningRequest into a
// concrete ProvisioningPlan for a target hypervisor.
//
// The LLM is responsible for:
//   - Picking an OS target (when not specified by hints)
//   - Naming the VM
//   - Right-sizing CPU / RAM / disk for the workload
//
// The LLM is NOT responsible for hardware-level decisions
// (firmware, TPM, disk bus, NIC model). Those come from a
// static per-OS-family map so we can't hallucinate them.
//
// SCAFFOLD: ISO and unattend payloads are placeholder shapes
// with empty bodies — the actual rendering happens later, see
// docs/provisioning.md for the prioritized TODO list.
// ============================================================

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { callLLM, type AIConfig } from "../agent/llm.js";
import {
  osFamily,
  type IsoSource,
  type OsFamily,
  type OsTarget,
  type ProvisioningHints,
  type ProvisioningPlan,
  type ProvisioningTarget,
  type ProvisioningVmConfig,
  type UnattendConfig,
  type VmHardwareDefaults,
  type VmProvisioningRequest,
} from "./types.js";

// ── Static VM hardware defaults ─────────────────────────────

/**
 * Sane defaults per OS family. These are deliberately NOT
 * LLM-decided — they are facts about the OS (Win11 needs UEFI
 * + TPM 2.0, Linux is fine on virtio + SeaBIOS, etc.).
 */
const HARDWARE_DEFAULTS: Record<OsFamily, VmHardwareDefaults> = {
  windows: {
    firmware: "uefi",
    tpm: true,
    cpuType: "host",
    diskBus: "scsi",
    nicModel: "virtio",
    defaultDiskGb: 80,
    defaultMemoryMiB: 8192,
    defaultCpuCount: 4,
  },
  linux: {
    firmware: "uefi",
    tpm: false,
    cpuType: "host",
    diskBus: "virtio",
    nicModel: "virtio",
    defaultDiskGb: 40,
    defaultMemoryMiB: 4096,
    defaultCpuCount: 2,
  },
};

export function defaultsForOs(os: OsTarget): VmHardwareDefaults {
  return HARDWARE_DEFAULTS[osFamily(os)];
}

// ── LLM response schema ─────────────────────────────────────

const LLMSizingResponseSchema = z.object({
  os: z.string(),
  vm_name: z.string(),
  cpu_count: z.number().int().positive(),
  memory_mib: z.number().int().positive(),
  disk_gb: z.number().int().positive(),
  reasoning: z.string(),
});

type LLMSizingResponse = z.infer<typeof LLMSizingResponseSchema>;

const KNOWN_OS_TARGETS: readonly OsTarget[] = [
  "windows-11",
  "windows-10",
  "windows-server-2022",
  "windows-server-2019",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "debian-12",
  "fedora-40",
  "rocky-9",
];

const PLANNER_SYSTEM_PROMPT = `You are a VM provisioning planner for vClaw, an autonomous infrastructure agent.

Given a natural-language request to provision a VM, decide:
  - which OS target to install
  - a short VM name (lowercase, hyphenated, <= 32 chars)
  - vCPU count, RAM in MiB, disk size in GiB

You MUST respond with valid JSON ONLY, matching this shape:
{
  "os": "<one of: ${KNOWN_OS_TARGETS.join(" | ")}>",
  "vm_name": "<string>",
  "cpu_count": <int>,
  "memory_mib": <int>,
  "disk_gb": <int>,
  "reasoning": "<one-paragraph explanation>"
}

Rules:
  - If the user specified an OS, honour it.
  - Right-size for the stated workload. Trading bots, build agents,
    and developer workstations need 4+ vCPU and 8 GiB+ RAM. Idle
    utility VMs can be smaller.
  - Do NOT pick firmware, disk bus, NIC, or TPM — those are decided
    elsewhere from the OS family.
`;

// ── Planner ──────────────────────────────────────────────────

export interface ProvisioningPlannerDeps {
  /** LLM config used for sizing/naming. Can be mocked in tests. */
  llmConfig: AIConfig;
  /**
   * Optional override of the LLM call function. Tests inject a
   * stub here so we don't need network access.
   */
  callLLM?: typeof callLLM;
}

export class ProvisioningPlanner {
  private readonly deps: ProvisioningPlannerDeps;

  constructor(deps: ProvisioningPlannerDeps) {
    this.deps = deps;
  }

  /**
   * Build a provisioning plan from a request + target hypervisor.
   *
   * Steps:
   *   1. Ask the LLM for OS / name / sizing (skipped fields if
   *      hints already cover them).
   *   2. Pull static hardware defaults for the OS family.
   *   3. Stub out IsoSource + UnattendConfig (TODO: real impls).
   *   4. Return a fully-shaped ProvisioningPlan.
   */
  async plan(
    request: VmProvisioningRequest,
    target: ProvisioningTarget,
  ): Promise<ProvisioningPlan> {
    const sizing = await this.askLLMForSizing(request);
    const os = this.resolveOs(request.hints, sizing);
    const hardware = defaultsForOs(os);

    const vmConfig: ProvisioningVmConfig = {
      name: request.hints?.vmName ?? sizing.vm_name,
      os,
      cpuCount: request.hints?.cpuCount ?? sizing.cpu_count,
      memoryMiB: request.hints?.memoryMiB ?? sizing.memory_mib,
      diskGb: request.hints?.diskGb ?? sizing.disk_gb,
      hardware,
    };

    return {
      id: `prov-${randomUUID()}`,
      request,
      target,
      vmConfig,
      isoSource: this.placeholderIsoSource(os),
      unattend: this.placeholderUnattend(os, request.hints),
      postInstall: [],
      status: "pending",
      reasoning: sizing.reasoning,
      createdAt: new Date().toISOString(),
    };
  }

  // ── Internals ─────────────────────────────────────────────

  private async askLLMForSizing(
    request: VmProvisioningRequest,
  ): Promise<LLMSizingResponse> {
    const llm = this.deps.callLLM ?? callLLM;

    const userMessage = [
      `Prompt: ${request.prompt}`,
      request.hints ? `Hints: ${JSON.stringify(request.hints)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");

    const raw = await llm({
      system: PLANNER_SYSTEM_PROMPT,
      user: userMessage,
      config: this.deps.llmConfig,
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error(
        `Provisioning planner: LLM did not return JSON: ${raw.slice(0, 300)}`,
      );
    }

    const result = LLMSizingResponseSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new Error(
        `Provisioning planner: invalid LLM response: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    return result.data;
  }

  private resolveOs(
    hints: ProvisioningHints | undefined,
    sizing: LLMSizingResponse,
  ): OsTarget {
    if (hints?.os) return hints.os;
    if (KNOWN_OS_TARGETS.includes(sizing.os as OsTarget)) {
      return sizing.os as OsTarget;
    }
    throw new Error(
      `Provisioning planner: LLM returned unknown OS "${sizing.os}". Allowed: ${KNOWN_OS_TARGETS.join(", ")}`,
    );
  }

  private placeholderIsoSource(os: OsTarget): IsoSource {
    return {
      os,
      url: "",
      filename: `${os}.iso`,
      requiresFormBypass: osFamily(os) === "windows",
      source: "manual",
      resolvedAt: new Date().toISOString(),
    };
  }

  private placeholderUnattend(
    os: OsTarget,
    hints: ProvisioningHints | undefined,
  ): UnattendConfig {
    const locale = hints?.locale ?? "en-US";
    const keyboard = hints?.keyboard ?? "us";
    const timezone = hints?.timezone ?? "UTC";
    const username = hints?.username ?? "vclaw";

    if (osFamily(os) === "windows") {
      return {
        kind: "windows-autounattend",
        xml: "",
        filename: "autounattend.xml",
        fields: { locale, keyboard, timezone, username },
      };
    }

    return {
      kind: "linux-cloud-init",
      content: "",
      filename: "user-data",
      fields: {
        locale,
        keyboard,
        timezone,
        username,
        sshPublicKey: hints?.sshPublicKey,
      },
    };
  }
}
