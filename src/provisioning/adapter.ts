// ============================================================
// vClaw — Provisioning Adapter
// Exposes VM provisioning planning tools to the vClaw agent.
//
// SCAFFOLD: Only the planner tool is partially wired (it can
// call the LLM and return a plan once an LLM config is provided).
// Resolve / generate / execute paths return TODO errors.
// ============================================================

import type {
  ClusterState,
  InfraAdapter,
  ToolCallResult,
  ToolDefinition,
} from "../providers/types.js";
import type { AIConfig } from "../agent/llm.js";
import { provisioningTools } from "./index.js";
import { ProvisioningPlanner } from "./planner.js";
import {
  IsoResolverDispatcher,
} from "./iso-resolver.js";
import {
  UnattendGeneratorDispatcher,
} from "./unattend-generator.js";
import type {
  OsTarget,
  ProvisioningHints,
  ProvisioningHypervisor,
  ProvisioningTarget,
  VmProvisioningRequest,
} from "./types.js";

export interface ProvisioningAdapterConfig {
  /** LLM config used by the planner. Required for `provision_plan_vm`. */
  llmConfig?: AIConfig;
}

export class ProvisioningAdapter implements InfraAdapter {
  name = "provisioning";
  private _connected = false;
  private readonly config: ProvisioningAdapterConfig;
  private readonly isoResolver: IsoResolverDispatcher;
  private readonly unattendGenerator: UnattendGeneratorDispatcher;

  constructor(config: ProvisioningAdapterConfig = {}) {
    this.config = config;
    this.isoResolver = new IsoResolverDispatcher();
    this.unattendGenerator = new UnattendGeneratorDispatcher();
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return provisioningTools;
  }

  async execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      switch (tool) {
        case "provision_plan_vm":
          return await this.executePlanVm(params);
        case "provision_resolve_iso":
          return await this.executeResolveIso(params);
        case "provision_generate_unattend":
          return await this.executeGenerateUnattend(params);
        case "provision_execute_plan":
          return {
            success: false,
            error: "TODO: provision_execute_plan is not implemented in the scaffold",
          };
        default:
          return { success: false, error: `Unknown provisioning tool: ${tool}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    return {
      adapter: this.name,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Tool handlers ─────────────────────────────────────────

  private async executePlanVm(params: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.config.llmConfig) {
      return {
        success: false,
        error: "Provisioning adapter has no LLM config — cannot plan a VM",
      };
    }

    const prompt = params.prompt;
    const hypervisor = params.hypervisor;
    if (typeof prompt !== "string" || prompt.length === 0) {
      return { success: false, error: "prompt is required" };
    }
    if (!isHypervisor(hypervisor)) {
      return {
        success: false,
        error: "hypervisor must be one of: proxmox, vmware, aws, azure",
      };
    }

    const hints = extractHints(params);
    const request: VmProvisioningRequest = { prompt, hints };
    const target: ProvisioningTarget = { hypervisor };

    const planner = new ProvisioningPlanner({ llmConfig: this.config.llmConfig });
    const plan = await planner.plan(request, target);
    return { success: true, data: plan };
  }

  private async executeResolveIso(params: Record<string, unknown>): Promise<ToolCallResult> {
    const os = params.os;
    if (typeof os !== "string") {
      return { success: false, error: "os is required" };
    }
    const iso = await this.isoResolver.resolve(os as OsTarget);
    return { success: true, data: iso };
  }

  private async executeGenerateUnattend(params: Record<string, unknown>): Promise<ToolCallResult> {
    const os = params.os;
    if (typeof os !== "string") {
      return { success: false, error: "os is required" };
    }
    const hints = extractHints(params);
    const unattend = await this.unattendGenerator.generate(os as OsTarget, hints);
    return { success: true, data: unattend };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function isHypervisor(v: unknown): v is ProvisioningHypervisor {
  return v === "proxmox" || v === "vmware" || v === "aws" || v === "azure";
}

function extractHints(params: Record<string, unknown>): ProvisioningHints | undefined {
  const hints: ProvisioningHints = {};
  if (typeof params.os === "string") hints.os = params.os as OsTarget;
  if (typeof params.vm_name === "string") hints.vmName = params.vm_name;
  if (typeof params.cpu_count === "number") hints.cpuCount = params.cpu_count;
  if (typeof params.memory_mib === "number") hints.memoryMiB = params.memory_mib;
  if (typeof params.disk_gb === "number") hints.diskGb = params.disk_gb;
  if (typeof params.username === "string") hints.username = params.username;
  if (typeof params.ssh_public_key === "string") hints.sshPublicKey = params.ssh_public_key;
  return Object.keys(hints).length > 0 ? hints : undefined;
}
