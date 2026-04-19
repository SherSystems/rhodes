// ============================================================
// vClaw — Migration Adapter
// Exposes cross-provider migration as tools in the adapter system
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../providers/types.js";
import type { VSphereClient } from "../providers/vmware/client.js";
import type { ProxmoxClient } from "../providers/proxmox/client.js";
import type { AWSClient } from "../providers/aws/client.js";
import type { AzureClient } from "../providers/azure/client.js";
import type { SSHExecFn } from "./types.js";
import { MigrationOrchestrator } from "./orchestrator.js";
import { WorkloadAnalyzer } from "./workload-analyzer.js";
import { AzureWorkloadAnalyzer } from "./azure-workload-analyzer.js";
import { AWSExporter } from "./aws-exporter.js";
import { AWSImporter } from "./aws-importer.js";
import { uploadDiskFromSSHToAzurePageBlob } from "./cloud-uploader.js";
import { DiskConverter } from "./disk-converter.js";
import { createHash } from "node:crypto";
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

export interface MigrationAdapterConfig {
  vsphereClient: VSphereClient;
  proxmoxClient: ProxmoxClient;
  sshExec: SSHExecFn;
  esxiHost: string;
  esxiUser?: string;
  proxmoxHost: string;
  proxmoxUser?: string;
  proxmoxNode: string;
  proxmoxStorage?: string;
  // AWS (optional — enables AWS migration tools)
  awsClient?: AWSClient;
  awsS3Bucket?: string;
  awsS3Prefix?: string;
  // Azure (optional — enables Azure migration planning/execution tools)
  azureClient?: AzureClient;
}

export class MigrationAdapter implements InfraAdapter {
  name = "migration";
  private config: MigrationAdapterConfig;
  private _connected = false;

  constructor(config: MigrationAdapterConfig) {
    this.config = config;
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
    return [
      {
        name: "migrate_vmware_to_proxmox",
        description:
          "Migrate a VM from VMware vSphere to Proxmox VE. " +
          "Exports the VM config, transfers and converts the disk (vmdk -> qcow2), " +
          "then creates a new VM on Proxmox with the imported disk. " +
          "The source VM will be powered off during migration.",
        tier: "risky_write",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "string",
            required: true,
            description: "VMware VM identifier (e.g. vm-1234)",
          },
          {
            name: "target_vmid",
            type: "number",
            required: false,
            description: "Specific Proxmox VMID to use (auto-assigned if omitted)",
          },
          {
            name: "target_storage",
            type: "string",
            required: false,
            description: "Proxmox storage for the imported disk (default: local-lvm)",
          },
          {
            name: "target_node",
            type: "string",
            required: false,
            description: "Proxmox node name (default: from adapter config)",
          },
        ],
        returns: "MigrationPlan with status, steps, and target VM details",
      },
      {
        name: "plan_migration_vmware_to_proxmox",
        description:
          "Dry-run planning for VMware -> Proxmox migration. " +
          "Reads VM config and validates connectivity without making changes. " +
          "Use this to preview what will happen before running the actual migration.",
        tier: "read",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "string",
            required: true,
            description: "VMware VM identifier (e.g. vm-1234)",
          },
        ],
        returns: "MigrationPlan (dry-run) with VM config and planned steps",
      },
      {
        name: "migrate_proxmox_to_vmware",
        description:
          "Migrate a VM from Proxmox VE to VMware vSphere. " +
          "Exports the VM config, converts the disk (raw/qcow2 -> vmdk), " +
          "uploads to ESXi datastore, and creates a new VM on vSphere. " +
          "The source VM will be stopped during migration.",
        tier: "risky_write",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "number",
            required: true,
            description: "Proxmox VMID (e.g. 112)",
          },
        ],
        returns: "MigrationPlan with status, steps, and target vSphere VM details",
      },
      {
        name: "plan_migration_proxmox_to_vmware",
        description:
          "Dry-run planning for Proxmox -> VMware migration. " +
          "Reads VM config and validates connectivity without making changes.",
        tier: "read",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "number",
            required: true,
            description: "Proxmox VMID (e.g. 112)",
          },
        ],
        returns: "MigrationPlan (dry-run) with VM config and planned steps",
      },
      // ── AWS Migration Tools ────────────────────────────────
      ...(this.config.awsClient ? [
        {
          name: "plan_migration_vmware_to_aws",
          description:
            "Dry-run planning for VMware → AWS migration. " +
            "Reads VM config, analyzes workload, and shows recommended EC2 instance type, " +
            "cost estimate, risks, and migration steps without making changes.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "VMware VM identifier (e.g. vm-1234)" },
          ],
          returns: "WorkloadAnalysis with plan, cost estimate, and risks",
        },
        {
          name: "plan_migration_aws_to_vmware",
          description:
            "Dry-run planning for AWS → VMware migration. " +
            "Reads EC2 instance config, analyzes workload, and shows recommended VM config, " +
            "risks, and migration steps without making changes.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "instance_id", type: "string", required: true, description: "EC2 instance ID (e.g. i-0abc123)" },
          ],
          returns: "WorkloadAnalysis with plan and risks",
        },
        {
          name: "migrate_vmware_to_aws",
          description:
            "Migrate a VM from VMware vSphere to AWS EC2. " +
            "Exports the VM, uploads disk to S3, " +
            "imports as AMI, and launches an EC2 instance. " +
            "The source VM will be powered off during migration.",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "VMware VM identifier (e.g. vm-1234)" },
            { name: "instance_type", type: "string", required: false, description: "EC2 instance type (auto-selected if omitted)" },
            { name: "subnet_id", type: "string", required: false, description: "AWS subnet ID" },
            { name: "security_group_ids", type: "string", required: false, description: "Comma-separated AWS security group IDs" },
            { name: "key_name", type: "string", required: false, description: "EC2 key pair name for SSH access" },
            { name: "import_mode", type: "string", required: false, description: "Import strategy: auto, snapshot, or image (default: auto)" },
            { name: "fallback_to_import_image", type: "string", required: false, description: "When using snapshot path, fallback to ImportImage on failure (true/false; default: true)" },
          ],
          returns: "MigrationPlan with AMI ID and EC2 instance details",
        },
        {
          name: "migrate_aws_to_vmware",
          description:
            "Migrate an EC2 instance from AWS to VMware vSphere. " +
            "Creates AMI, exports to S3 as VMDK, downloads to staging host, " +
            "uploads to ESXi, and creates a VM on vSphere. " +
            "Source instance will be stopped during migration.",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "instance_id", type: "string", required: true, description: "EC2 instance ID (e.g. i-0abc123)" },
          ],
          returns: "MigrationPlan with vSphere VM details",
        },
        {
          name: "plan_migration_proxmox_to_aws",
          description:
            "Dry-run planning for Proxmox → AWS migration. " +
            "Reads VM config, analyzes workload, and shows recommended EC2 instance type, " +
            "cost estimate, risks, and migration steps without making changes.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "number", required: true, description: "Proxmox VMID (e.g. 112)" },
          ],
          returns: "WorkloadAnalysis with plan, cost estimate, and risks",
        },
        {
          name: "plan_migration_aws_to_proxmox",
          description:
            "Dry-run planning for AWS → Proxmox migration. " +
            "Reads EC2 instance config, analyzes workload, and shows recommended VM config.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "instance_id", type: "string", required: true, description: "EC2 instance ID (e.g. i-0abc123)" },
          ],
          returns: "WorkloadAnalysis with plan and risks",
        },
        {
          name: "migrate_proxmox_to_aws",
          description:
            "Migrate a VM from Proxmox VE to AWS EC2. " +
            "Exports VM config, uploads disk to S3 (RAW when possible), " +
            "imports as AMI, and launches an EC2 instance.",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "number", required: true, description: "Proxmox VMID (e.g. 112)" },
            { name: "instance_type", type: "string", required: false, description: "EC2 instance type (auto-selected if omitted)" },
            { name: "subnet_id", type: "string", required: false, description: "AWS subnet ID" },
            { name: "security_group_ids", type: "string", required: false, description: "Comma-separated AWS security group IDs" },
            { name: "import_mode", type: "string", required: false, description: "Import strategy: auto, snapshot, or image (default: auto)" },
            { name: "fallback_to_import_image", type: "string", required: false, description: "When using snapshot path, fallback to ImportImage on failure (true/false; default: true)" },
          ],
          returns: "MigrationPlan with AMI ID and EC2 instance details",
        },
        {
          name: "migrate_aws_to_proxmox",
          description:
            "Migrate an EC2 instance from AWS to Proxmox VE. " +
            "Creates AMI, exports to S3, downloads disk, converts to qcow2, imports into Proxmox.",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "instance_id", type: "string", required: true, description: "EC2 instance ID (e.g. i-0abc123)" },
          ],
          returns: "MigrationPlan with Proxmox VM details",
        },
        {
          name: "analyze_workload",
          description:
            "Analyze a VM/instance and recommend configuration for migration to another platform. " +
            "Shows instance type mapping, cost estimates, storage requirements, risks, and migration time estimate.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "source_provider", type: "string", required: true, description: "Source platform: 'vmware' or 'aws'" },
            { name: "vm_id", type: "string", required: true, description: "VM identifier (VMware vm-id or EC2 instance-id)" },
            { name: "target_provider", type: "string", required: true, description: "Target platform: 'vmware' or 'aws'" },
          ],
          returns: "WorkloadAnalysis with recommendations, cost estimates, and risks",
        },
      ] as ToolDefinition[] : []),
      // ── Azure Migration Tools ─────────────────────────────
      ...(this.config.azureClient ? [
        {
          name: "plan_migration_vmware_to_azure",
          description:
            "Dry-run planning for VMware → Azure migration. " +
            "Reads VM config and returns an Azure target recommendation with migration steps.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "VMware VM identifier (e.g. vm-1234)" },
          ],
          returns: "WorkloadAnalysis with Azure target recommendations and migration steps",
        },
        {
          name: "plan_migration_azure_to_vmware",
          description:
            "Dry-run planning for Azure → VMware migration. " +
            "Reads Azure VM config and returns a VMware target recommendation with migration steps.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "Azure VM ARM id (or resourceGroup/vmName)" },
          ],
          returns: "WorkloadAnalysis with VMware target recommendations and migration steps",
        },
        {
          name: "plan_migration_proxmox_to_azure",
          description:
            "Dry-run planning for Proxmox → Azure migration. " +
            "Reads VM config and returns an Azure target recommendation with migration steps.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "number", required: true, description: "Proxmox VMID (e.g. 112)" },
          ],
          returns: "WorkloadAnalysis with Azure target recommendations and migration steps",
        },
        {
          name: "plan_migration_azure_to_proxmox",
          description:
            "Dry-run planning for Azure → Proxmox migration. " +
            "Reads Azure VM config and returns a Proxmox target recommendation with migration steps.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "Azure VM ARM id (or resourceGroup/vmName)" },
          ],
          returns: "WorkloadAnalysis with Proxmox target recommendations and migration steps",
        },
        {
          name: "plan_migration_aws_to_azure",
          description:
            "Dry-run planning for AWS → Azure migration. " +
            "Reads EC2 instance config and returns an Azure target recommendation with migration steps.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "instance_id", type: "string", required: true, description: "EC2 instance ID (e.g. i-0abc123)" },
          ],
          returns: "WorkloadAnalysis with Azure target recommendations and migration steps",
        },
        {
          name: "plan_migration_azure_to_aws",
          description:
            "Dry-run planning for Azure → AWS migration. " +
            "Reads Azure VM config and returns an AWS target recommendation with migration steps.",
          tier: "read" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "Azure VM ARM id (or resourceGroup/vmName)" },
          ],
          returns: "WorkloadAnalysis with AWS target recommendations and migration steps",
        },
        {
          name: "migrate_vmware_to_azure",
          description: "Execute VMware → Azure migration run (backend execution path).",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "VMware VM identifier (e.g. vm-1234)" },
          ],
          returns: "MigrationPlan with run status and step details",
        },
        {
          name: "migrate_azure_to_vmware",
          description: "Execute Azure → VMware migration run (backend execution path).",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "Azure VM ARM id (or resourceGroup/vmName)" },
          ],
          returns: "MigrationPlan with run status and step details",
        },
        {
          name: "migrate_proxmox_to_azure",
          description: "Execute Proxmox → Azure migration run (backend execution path).",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "number", required: true, description: "Proxmox VMID (e.g. 112)" },
          ],
          returns: "MigrationPlan with run status and step details",
        },
        {
          name: "migrate_azure_to_proxmox",
          description: "Execute Azure → Proxmox migration run (backend execution path).",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "Azure VM ARM id (or resourceGroup/vmName)" },
          ],
          returns: "MigrationPlan with run status and step details",
        },
        {
          name: "migrate_aws_to_azure",
          description: "Execute AWS → Azure migration run (backend execution path).",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "instance_id", type: "string", required: true, description: "EC2 instance ID (e.g. i-0abc123)" },
          ],
          returns: "MigrationPlan with run status and step details",
        },
        {
          name: "migrate_azure_to_aws",
          description: "Execute Azure → AWS migration run (backend execution path).",
          tier: "risky_write" as const,
          adapter: "migration",
          params: [
            { name: "vm_id", type: "string", required: true, description: "Azure VM ARM id (or resourceGroup/vmName)" },
          ],
          returns: "MigrationPlan with run status and step details",
        },
      ] as ToolDefinition[] : []),
    ];
  }

  async execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    switch (tool) {
      case "migrate_vmware_to_proxmox":
        return this.executeVMwareToProxmox(params);
      case "plan_migration_vmware_to_proxmox":
        return this.executePlanVMwareToProxmox(params);
      case "migrate_proxmox_to_vmware":
        return this.executeProxmoxToVMware(params);
      case "plan_migration_proxmox_to_vmware":
        return this.executePlanProxmoxToVMware(params);
      case "plan_migration_vmware_to_aws":
        return this.executePlanVMwareToAWS(params);
      case "plan_migration_aws_to_vmware":
        return this.executePlanAWSToVMware(params);
      case "migrate_vmware_to_aws":
        return this.executeVMwareToAWS(params);
      case "migrate_aws_to_vmware":
        return this.executeAWSToVMware(params);
      case "plan_migration_proxmox_to_aws":
        return this.executePlanProxmoxToAWS(params);
      case "plan_migration_aws_to_proxmox":
        return this.executePlanAWSToProxmox(params);
      case "migrate_proxmox_to_aws":
        return this.executeProxmoxToAWS(params);
      case "migrate_aws_to_proxmox":
        return this.executeAWSToProxmox(params);
      case "plan_migration_vmware_to_azure":
        return this.executePlanVMwareToAzure(params);
      case "plan_migration_azure_to_vmware":
        return this.executePlanAzureToVMware(params);
      case "plan_migration_proxmox_to_azure":
        return this.executePlanProxmoxToAzure(params);
      case "plan_migration_azure_to_proxmox":
        return this.executePlanAzureToProxmox(params);
      case "plan_migration_aws_to_azure":
        return this.executePlanAWSToAzure(params);
      case "plan_migration_azure_to_aws":
        return this.executePlanAzureToAWS(params);
      case "migrate_vmware_to_azure":
        return this.executeVMwareToAzure(params);
      case "migrate_azure_to_vmware":
        return this.executeAzureToVMware(params);
      case "migrate_proxmox_to_azure":
        return this.executeProxmoxToAzure(params);
      case "migrate_azure_to_proxmox":
        return this.executeAzureToProxmox(params);
      case "migrate_aws_to_azure":
        return this.executeAWSToAzure(params);
      case "migrate_azure_to_aws":
        return this.executeAzureToAWS(params);
      case "analyze_workload":
        return this.executeAnalyzeWorkload(params);
      default:
        return { success: false, error: `Unknown migration tool: ${tool}` };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    // Migration adapter doesn't have its own cluster state
    return {
      adapter: "migration",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private ────────────────────────────────────────────────

  private async executeVMwareToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator({
      proxmoxNode: (params.target_node as string) ?? this.config.proxmoxNode,
      proxmoxStorage: (params.target_storage as string) ?? this.config.proxmoxStorage,
    });

    try {
      const plan = await orchestrator.migrateVMwareToProxmox(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executePlanVMwareToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator();

    try {
      const plan = await orchestrator.planMigration(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeProxmoxToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator();

    try {
      const plan = await orchestrator.migrateProxmoxToVMware(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executePlanProxmoxToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator();

    try {
      const plan = await orchestrator.planProxmoxToVMware(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executePlanVMwareToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };

    try {
      // Get VM config and run workload analysis
      const vmInfo = await this.config.vsphereClient.getVM(vmId);
      const vmConfig = {
        name: vmInfo.name,
        cpuCount: vmInfo.cpu.count,
        coresPerSocket: vmInfo.cpu.cores_per_socket,
        memoryMiB: vmInfo.memory.size_MiB,
        guestOS: vmInfo.guest_OS,
        disks: Object.values(vmInfo.disks ?? {}).map((d: any) => ({
          label: d.label || "disk",
          capacityBytes: d.capacity || 0,
          sourcePath: "",
          sourceFormat: "vmdk" as const,
          targetFormat: "vmdk" as const,
        })),
        nics: Object.values(vmInfo.nics ?? {}).map((n: any) => ({
          label: n.label || "nic",
          macAddress: n.mac_address || "",
          networkName: n.backing?.network_name || "",
          adapterType: n.type || "vmxnet3",
        })),
        firmware: (vmInfo.boot?.type === "EFI" ? "efi" : "bios") as "efi" | "bios",
      };

      const analysis = WorkloadAnalyzer.analyzeVMwareForAWS(vmConfig);

      return {
        success: true,
        data: {
          plan: {
            id: `plan-${Date.now()}`,
            source: { provider: "vmware", vmId, vmName: vmInfo.name, host: this.config.esxiHost },
            target: { provider: "aws", node: "aws", host: "aws", storage: "s3", instanceType: analysis.target.recommended.instanceType },
            vmConfig,
            status: "pending",
            steps: [
              { name: "export_config", status: "pending" },
              { name: "power_off", status: "pending" },
              { name: "transfer_disk", status: "pending" },
              { name: "upload_to_s3", status: "pending" },
              { name: "import_ami", status: "pending" },
              { name: "launch_instance", status: "pending" },
              { name: "cleanup", status: "pending" },
            ],
          },
          analysis,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanAWSToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const instanceId = (params.instance_id as string) ?? (params.vm_id as string);
    if (!instanceId) return { success: false, error: "instance_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };

    try {
      const instance = await this.config.awsClient.getInstance(instanceId);
      const volumeIds = instance.blockDeviceMappings?.map(b => b.ebs?.volumeId).filter((v): v is string => !!v) ?? [];
      const volumes = volumeIds.length > 0 ? await this.config.awsClient.listVolumes() : [];
      const volumeMap = new Map(volumes.map(v => [v.volumeId, v.size]));
      const ebsVolumes = instance.blockDeviceMappings?.map(b => ({
        sizeGB: (b.ebs?.volumeId ? volumeMap.get(b.ebs.volumeId) : undefined) ?? 8,
      })) ?? [{ sizeGB: 8 }];

      const analysis = WorkloadAnalyzer.analyzeAWSForVMware(instance.instanceType, ebsVolumes, instance.platform);

      return {
        success: true,
        data: {
          plan: {
            id: `plan-${Date.now()}`,
            source: { provider: "aws", vmId: instanceId, vmName: instance.name, host: "aws", instanceId },
            target: { provider: "vmware", node: this.config.esxiHost, host: this.config.esxiHost, storage: "" },
            vmConfig: {
              name: instance.name,
              cpuCount: analysis.target.recommended.cpuCount ?? 2,
              coresPerSocket: 1,
              memoryMiB: analysis.target.recommended.memoryMiB ?? 4096,
              guestOS: analysis.target.recommended.guestOS ?? "otherLinux64Guest",
              disks: [],
              nics: [],
              firmware: "bios" as const,
            },
            status: "pending",
            steps: [
              { name: "create_ami", status: "pending" },
              { name: "export_to_s3", status: "pending" },
              { name: "download_disk", status: "pending" },
              { name: "resolve_target", status: "pending" },
              { name: "import_vm", status: "pending" },
              { name: "cleanup", status: "pending" },
            ],
          },
          analysis,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeVMwareToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };
    const importMode = this.parseAWSImportMode(params.import_mode);
    if (!importMode) {
      return { success: false, error: "import_mode must be one of: auto, snapshot, image" };
    }
    const fallbackToImportImage = this.parseOptionalBooleanParam(params.fallback_to_import_image);
    if (fallbackToImportImage === "invalid") {
      return { success: false, error: "fallback_to_import_image must be a boolean (true/false)" };
    }

    try {
      // Step 1: Export from VMware (get VM config + disk path)
      const orchestrator = this.createOrchestrator();
      const esxiUser = this.config.esxiUser ?? "root";
      const proxmoxUser = this.config.proxmoxUser ?? "root";
      const workDir = "/tmp/vclaw-migration";

      // Read VM config from vSphere
      const { VMwareExporter } = await import("./vmware-exporter.js");
      const exporter = new VMwareExporter(this.config.vsphereClient, this.config.sshExec);
      const exportResult = await exporter.exportVM(vmId, this.config.esxiHost, esxiUser);
      const primaryDisk = exportResult.vmConfig.disks[0];

      if (!primaryDisk) {
        return { success: false, error: "Source VM has no attached disks. Nothing to migrate." };
      }

      if (typeof primaryDisk.sourcePath !== "string" || primaryDisk.sourcePath.trim().length === 0) {
        return { success: false, error: "Source VM primary disk is missing source path. Nothing to migrate." };
      }

      // Power off source VM
      try { await this.config.vsphereClient.vmPowerOff(vmId); } catch { /* may already be off */ }
      await new Promise(r => setTimeout(r, 3000));

      // Transfer disk to staging host (Proxmox)
      const vmdkFsPath = exporter.datastorePathToFs(primaryDisk.sourcePath);
      const stageDir = `${workDir}/aws-mig-${Date.now()}`;
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const stagedVmdk = await exporter.transferDisk(
        this.config.esxiHost, esxiUser, vmdkFsPath,
        this.config.proxmoxHost, proxmoxUser, stageDir, 600_000
      );

      // Step 2: Upload to S3 and import as AMI
      const importer = new AWSImporter(
        this.config.awsClient,
        this.config.awsS3Bucket,
        this.config.awsS3Prefix ?? "vclaw-migration/",
      );

      const importResult = await importer.importVM(
        {
          vmConfig: exportResult.vmConfig,
          diskPath: stagedVmdk,
          diskFormat: "vmdk",
          importMode,
          fallbackToImportImage: fallbackToImportImage ?? undefined,
          instanceType: params.instance_type as string | undefined,
          subnetId: params.subnet_id as string | undefined,
          securityGroupIds: params.security_group_ids
            ? (params.security_group_ids as string).split(",").map(s => s.trim())
            : undefined,
          keyName: params.key_name as string | undefined,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );

      // Cleanup staging
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);

      return {
        success: true,
        data: {
          source: { provider: "vmware", vmId, vmName: exportResult.vmConfig.name },
          target: { provider: "aws", ...importResult },
          vmConfig: exportResult.vmConfig,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeAWSToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const instanceId = (params.instance_id as string) ?? (params.vm_id as string);
    if (!instanceId) return { success: false, error: "instance_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };

    try {
      const proxmoxUser = this.config.proxmoxUser ?? "root";
      const esxiUser = this.config.esxiUser ?? "root";
      const workDir = "/tmp/vclaw-migration";
      const stageDir = `${workDir}/aws-to-vmware-${Date.now()}`;

      // Step 1: Export from AWS (create AMI, export to S3)
      const awsExporter = new AWSExporter(
        this.config.awsClient,
        this.config.awsS3Bucket,
        this.config.awsS3Prefix ?? "vclaw-migration/",
      );
      const exportResult = await awsExporter.exportInstance(instanceId);

      // Step 2: Download from S3 to staging host
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const localVmdk = `${stageDir}/disk.vmdk`;
      await this.config.sshExec(
        this.config.proxmoxHost, proxmoxUser,
        `aws s3 cp s3://${exportResult.s3Bucket}/${exportResult.s3Key} ${localVmdk} --no-progress`,
        7200_000, // 2 hour timeout for large disks
      );

      // Step 3: Import into VMware
      const { VMwareImporter } = await import("./vmware-importer.js");
      const vmwareImporter = new VMwareImporter(this.config.vsphereClient, this.config.sshExec);
      const defaults = await vmwareImporter.resolveDefaults();

      const importResult = await vmwareImporter.importVM(
        {
          config: exportResult.vmConfig,
          vmdkPath: localVmdk,
          esxiHost: this.config.esxiHost,
          esxiUser,
          datastoreId: defaults.datastoreId,
          datastoreName: defaults.datastoreName,
          hostId: defaults.hostId,
          folderId: defaults.folderId,
          networkId: defaults.networkId,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );

      // Cleanup
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);

      return {
        success: true,
        data: {
          source: { provider: "aws", instanceId, vmName: exportResult.vmConfig.name },
          target: { provider: "vmware", vmId: importResult.vmId, datastoreName: importResult.datastoreName },
          vmConfig: exportResult.vmConfig,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanProxmoxToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };

    try {
      const proxmoxUser = this.config.proxmoxUser ?? "root";
      const { ProxmoxExporter } = await import("./proxmox-exporter.js");
      const exporter = new ProxmoxExporter(this.config.proxmoxClient, this.config.sshExec);
      const exportResult = await exporter.exportVM(
        this.config.proxmoxNode, vmId, this.config.proxmoxHost, proxmoxUser
      );

      const analysis = WorkloadAnalyzer.analyzeVMwareForAWS(exportResult.vmConfig);

      return {
        success: true,
        data: {
          plan: {
            id: `plan-${Date.now()}`,
            source: { provider: "proxmox", vmId: String(vmId), vmName: exportResult.vmConfig.name, host: this.config.proxmoxHost },
            target: { provider: "aws", node: "aws", host: "aws", storage: "s3", instanceType: analysis.target.recommended.instanceType },
            vmConfig: exportResult.vmConfig,
            status: "pending",
            steps: [
              { name: "export_config", status: "pending" },
              { name: "power_off", status: "pending" },
              { name: "convert_disk", status: "pending" },
              { name: "upload_to_s3", status: "pending" },
              { name: "import_ami", status: "pending" },
              { name: "launch_instance", status: "pending" },
              { name: "cleanup", status: "pending" },
            ],
          },
          analysis,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanAWSToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const instanceId = (params.instance_id as string) ?? (params.vm_id as string);
    if (!instanceId) return { success: false, error: "instance_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };

    try {
      const instance = await this.config.awsClient.getInstance(instanceId);
      const volumeIds = instance.blockDeviceMappings?.map(b => b.ebs?.volumeId).filter((v): v is string => !!v) ?? [];
      const volumes = volumeIds.length > 0 ? await this.config.awsClient.listVolumes() : [];
      const volumeMap = new Map(volumes.map(v => [v.volumeId, v.size]));
      const ebsVolumes = instance.blockDeviceMappings?.map(b => ({
        sizeGB: (b.ebs?.volumeId ? volumeMap.get(b.ebs.volumeId) : undefined) ?? 8,
      })) ?? [{ sizeGB: 8 }];

      const analysis = WorkloadAnalyzer.analyzeAWSForVMware(instance.instanceType, ebsVolumes, instance.platform);

      return {
        success: true,
        data: {
          plan: {
            id: `plan-${Date.now()}`,
            source: { provider: "aws", vmId: instanceId, vmName: instance.name, host: "aws", instanceId },
            target: { provider: "proxmox", node: this.config.proxmoxNode, host: this.config.proxmoxHost, storage: this.config.proxmoxStorage || "local-lvm" },
            vmConfig: {
              name: instance.name,
              cpuCount: analysis.target.recommended.cpuCount ?? 2,
              coresPerSocket: 1,
              memoryMiB: analysis.target.recommended.memoryMiB ?? 4096,
              guestOS: analysis.target.recommended.guestOS ?? "otherLinux64Guest",
              disks: [],
              nics: [],
              firmware: "bios" as const,
            },
            status: "pending",
            steps: [
              { name: "create_ami", status: "pending" },
              { name: "export_to_s3", status: "pending" },
              { name: "download_disk", status: "pending" },
              { name: "convert_disk", status: "pending" },
              { name: "import_vm", status: "pending" },
              { name: "cleanup", status: "pending" },
            ],
          },
          analysis,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeProxmoxToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };
    const importMode = this.parseAWSImportMode(params.import_mode);
    if (!importMode) {
      return { success: false, error: "import_mode must be one of: auto, snapshot, image" };
    }
    const fallbackToImportImage = this.parseOptionalBooleanParam(params.fallback_to_import_image);
    if (fallbackToImportImage === "invalid") {
      return { success: false, error: "fallback_to_import_image must be a boolean (true/false)" };
    }

    try {
      const proxmoxUser = this.config.proxmoxUser ?? "root";
      const workDir = "/tmp/vclaw-migration";
      const stageDir = `${workDir}/pve-aws-${Date.now()}`;

      // Export from Proxmox
      const { ProxmoxExporter } = await import("./proxmox-exporter.js");
      const exporter = new ProxmoxExporter(this.config.proxmoxClient, this.config.sshExec);
      const exportResult = await exporter.exportVM(this.config.proxmoxNode, vmId, this.config.proxmoxHost, proxmoxUser);

      // Stop VM
      try { await this.config.proxmoxClient.stopVM(this.config.proxmoxNode, vmId); } catch { /* may be stopped */ }
      await new Promise(r => setTimeout(r, 3000));

      const primaryDisk = exportResult.vmConfig.disks[0];
      if (!primaryDisk) {
        return { success: false, error: "Source VM has no attached disks. Nothing to migrate." };
      }
      let stagedDiskPath = primaryDisk.sourcePath;
      let stagedDiskFormat: "raw" | "vmdk" = "raw";
      let shouldCleanupStageDir = false;

      if (primaryDisk.sourceFormat !== "raw") {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
        const stagedVmdk = `${stageDir}/disk.vmdk`;
        await exporter.convertDiskToVmdk(
          this.config.proxmoxHost, proxmoxUser,
          primaryDisk.sourcePath, stagedVmdk,
          primaryDisk.sourceFormat, 600_000
        );
        stagedDiskPath = stagedVmdk;
        stagedDiskFormat = "vmdk";
        shouldCleanupStageDir = true;
      }

      // Upload to S3 and import
      const importer = new AWSImporter(
        this.config.awsClient,
        this.config.awsS3Bucket,
        this.config.awsS3Prefix ?? "vclaw-migration/",
      );

      const importResult = await importer.importVM(
        {
          vmConfig: exportResult.vmConfig,
          diskPath: stagedDiskPath,
          diskFormat: stagedDiskFormat,
          importMode,
          fallbackToImportImage: fallbackToImportImage ?? undefined,
          instanceType: params.instance_type as string | undefined,
          subnetId: params.subnet_id as string | undefined,
          securityGroupIds: params.security_group_ids
            ? (params.security_group_ids as string).split(",").map(s => s.trim())
            : undefined,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );

      // Cleanup
      if (shouldCleanupStageDir) {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      }

      return {
        success: true,
        data: {
          source: { provider: "proxmox", vmId: String(vmId), vmName: exportResult.vmConfig.name },
          target: { provider: "aws", ...importResult },
          vmConfig: exportResult.vmConfig,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeAWSToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const instanceId = (params.instance_id as string) ?? (params.vm_id as string);
    if (!instanceId) return { success: false, error: "instance_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };

    try {
      const proxmoxUser = this.config.proxmoxUser ?? "root";
      const workDir = "/tmp/vclaw-migration";
      const stageDir = `${workDir}/aws-pve-${Date.now()}`;

      // Export from AWS
      const awsExporter = new AWSExporter(
        this.config.awsClient,
        this.config.awsS3Bucket,
        this.config.awsS3Prefix ?? "vclaw-migration/",
      );
      const exportResult = await awsExporter.exportInstance(instanceId);

      // Download from S3 to staging
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const localVmdk = `${stageDir}/disk.vmdk`;
      await this.config.sshExec(
        this.config.proxmoxHost, proxmoxUser,
        `aws s3 cp s3://${exportResult.s3Bucket}/${exportResult.s3Key} ${localVmdk} --no-progress`,
        7200_000,
      );

      // Convert vmdk to qcow2
      const stagedQcow2 = `${stageDir}/disk.qcow2`;
      const { DiskConverter } = await import("./disk-converter.js");
      const converter = new DiskConverter(this.config.sshExec);
      await converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: localVmdk,
        targetPath: stagedQcow2,
        sourceFormat: "vmdk",
        targetFormat: "qcow2",
        timeoutMs: 600_000,
      });

      // Import into Proxmox
      const { ProxmoxImporter } = await import("./proxmox-importer.js");
      const proxmoxImporter = new ProxmoxImporter(this.config.proxmoxClient, this.config.sshExec);
      const targetVmId = await proxmoxImporter.getNextVMID(this.config.proxmoxHost, proxmoxUser);

      const importResult = await proxmoxImporter.importVM(
        {
          node: this.config.proxmoxNode,
          vmId: targetVmId,
          storage: this.config.proxmoxStorage || "local-lvm",
          config: exportResult.vmConfig,
          diskPath: stagedQcow2,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );

      // Cleanup
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);

      return {
        success: true,
        data: {
          source: { provider: "aws", instanceId, vmName: exportResult.vmConfig.name },
          target: { provider: "proxmox", vmId: importResult.vmId, node: importResult.node },
          vmConfig: exportResult.vmConfig,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanVMwareToAzure(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    try {
      const vmInfo = await this.config.vsphereClient.getVM(vmId);
      const vmConfig = this.mapVMwareInfoToVMConfig(vmInfo);
      const analysis = this.buildAzureTargetAnalysis(vmConfig);
      const plan = this.buildAzureTargetPlan("vmware", vmId, vmInfo.name, this.config.esxiHost, vmConfig, analysis);
      return { success: true, data: { plan, analysis } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanProxmoxToAzure(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    try {
      const proxmoxUser = this.config.proxmoxUser ?? "root";
      const { ProxmoxExporter } = await import("./proxmox-exporter.js");
      const exporter = new ProxmoxExporter(this.config.proxmoxClient, this.config.sshExec);
      const exportResult = await exporter.exportVM(
        this.config.proxmoxNode, vmId, this.config.proxmoxHost, proxmoxUser,
      );
      const analysis = this.buildAzureTargetAnalysis(exportResult.vmConfig);
      const plan = this.buildAzureTargetPlan(
        "proxmox",
        String(vmId),
        exportResult.vmConfig.name,
        this.config.proxmoxHost,
        exportResult.vmConfig,
        analysis,
      );
      return { success: true, data: { plan, analysis } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanAWSToAzure(params: Record<string, unknown>): Promise<ToolCallResult> {
    const instanceId = (params.instance_id as string) ?? (params.vm_id as string);
    if (!instanceId) return { success: false, error: "instance_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    try {
      const instance = await this.config.awsClient.getInstance(instanceId);
      const volumeIds = instance.blockDeviceMappings?.map((b) => b.ebs?.volumeId).filter((v): v is string => !!v) ?? [];
      const volumes = volumeIds.length > 0 ? await this.config.awsClient.listVolumes() : [];
      const volumeMap = new Map(volumes.map((v) => [v.volumeId, v.size]));
      const totalDiskGB = volumeIds.reduce((sum, volumeId) => sum + (volumeMap.get(volumeId) ?? 8), 0) || 8;
      const vmConfig = this.mapAWSInstanceToVMConfig(instance.name, instance.instanceType, totalDiskGB, instance.platform);
      const analysis = this.buildAzureTargetAnalysis(vmConfig);
      const plan = this.buildAzureTargetPlan("aws", instanceId, instance.name, "aws", vmConfig, analysis);
      return { success: true, data: { plan, analysis } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanAzureToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    try {
      const azureSource = await this.getAzureSourceVM(vmId);
      const ebsVolumes = azureSource.totalDiskGB > 0 ? [{ sizeGB: azureSource.totalDiskGB }] : [{ sizeGB: 8 }];
      const analysis = WorkloadAnalyzer.analyzeAWSForVMware(
        "azure-custom",
        ebsVolumes,
        azureSource.vm.osType === "Windows" ? "windows" : "linux",
      );
      const plan = this.buildAzureSourcePlan(
        "vmware",
        azureSource,
        analysis.target.recommended.cpuCount ?? azureSource.vmConfig.cpuCount,
        analysis.target.recommended.memoryMiB ?? azureSource.vmConfig.memoryMiB,
      );
      return { success: true, data: { plan, analysis } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanAzureToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    try {
      const azureSource = await this.getAzureSourceVM(vmId);
      const ebsVolumes = azureSource.totalDiskGB > 0 ? [{ sizeGB: azureSource.totalDiskGB }] : [{ sizeGB: 8 }];
      const analysis = WorkloadAnalyzer.analyzeAWSForVMware(
        "azure-custom",
        ebsVolumes,
        azureSource.vm.osType === "Windows" ? "windows" : "linux",
      );
      const plan = this.buildAzureSourcePlan(
        "proxmox",
        azureSource,
        analysis.target.recommended.cpuCount ?? azureSource.vmConfig.cpuCount,
        analysis.target.recommended.memoryMiB ?? azureSource.vmConfig.memoryMiB,
      );
      return { success: true, data: { plan, analysis } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executePlanAzureToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    try {
      const azureSource = await this.getAzureSourceVM(vmId);
      const analysis = WorkloadAnalyzer.analyzeVMwareForAWS(azureSource.vmConfig);
      const plan = {
        id: `plan-${Date.now()}`,
        source: {
          provider: "azure",
          vmId,
          vmName: azureSource.vm.name,
          host: "azure",
          resourceGroup: azureSource.resourceGroup,
        },
        target: {
          provider: "aws",
          node: "aws",
          host: "aws",
          storage: "s3",
          instanceType: analysis.target.recommended.instanceType,
        },
        vmConfig: azureSource.vmConfig,
        status: "pending",
        steps: [
          { name: "capture_image", status: "pending" },
          { name: "export_disk", status: "pending" },
          { name: "upload_to_s3", status: "pending" },
          { name: "import_ami", status: "pending" },
          { name: "launch_instance", status: "pending" },
          { name: "cleanup", status: "pending" },
        ],
      };
      return { success: true, data: { plan, analysis } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeVMwareToAzure(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    const azureClient = this.config.azureClient;
    const esxiUser = this.config.esxiUser ?? "root";
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const resourceGroup = this.normalizeOptionalString(params.resource_group) ?? "vclaw-migrations";
    const location = this.normalizeOptionalString(params.location) ?? azureClient.defaultLocation;
    const storageAccountName = this.normalizeOptionalString(params.storage_account)
      ?? this.buildAzureStorageAccountName(resourceGroup, azureClient.subscriptionId);
    const containerName = this.normalizeOptionalString(params.container_name) ?? "vhds";
    const requestedVmSize = this.normalizeOptionalString(params.vm_size);
    const requestedSubnetId = this.normalizeOptionalString(params.subnet_id);

    const startedAt = new Date().toISOString();
    const executionSteps: Array<{ name: string; status: "pending" | "completed" | "failed"; detail?: string; error?: string }> = [
      { name: "export_config", status: "pending" },
      { name: "power_off", status: "pending" },
      { name: "export_disk", status: "pending" },
      { name: "upload_to_azure", status: "pending" },
      { name: "create_managed_disk", status: "pending" },
      { name: "create_vm", status: "pending" },
      { name: "cleanup", status: "pending" },
    ];

    const markStepComplete = (name: string, detail?: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "completed";
      if (detail) step.detail = detail;
    };

    const markStepFailed = (name: string, error: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "failed";
      step.error = error;
    };

    const markPendingCleanupSteps = (name: string, detail: string) => {
      let reached = false;
      for (const step of executionSteps) {
        if (step.name === name) reached = true;
        if (reached && step.status === "pending") {
          step.status = "completed";
          step.detail = detail;
        }
      }
    };

    const workDir = "/tmp/vclaw-migration";
    const stageDir = `${workDir}/vmware-azure-${Date.now()}`;
    const stageRawPath = `${stageDir}/disk.raw`;
    let managedDiskName = "";
    let vmName = "";
    let exportedVmName = "";
    let vmSize = requestedVmSize ?? "Standard_B2s";
    let subnetId = requestedSubnetId ?? "";
    let managedDiskId = "";
    let uploadedBlobUrl = "";
    let createdVm = false;
    let createdDisk = false;
    let blobClientForCleanup: { deleteIfExists: () => Promise<unknown> } | null = null;

    try {
      const { VMwareExporter } = await import("./vmware-exporter.js");
      const exporter = new VMwareExporter(this.config.vsphereClient, this.config.sshExec);
      const exportResult = await exporter.exportVM(vmId, this.config.esxiHost, esxiUser);
      if (exportResult.vmConfig.disks.length === 0) {
        throw new Error("Source VM has no attached disks. Nothing to migrate.");
      }

      const primaryDisk = exportResult.vmConfig.disks[0];
      if (typeof primaryDisk.sourcePath !== "string" || primaryDisk.sourcePath.trim().length === 0) {
        throw new Error("Source VM primary disk is missing source path. Nothing to migrate.");
      }

      exportedVmName = exportResult.vmConfig.name;
      markStepComplete("export_config", `Exported VMware VM config for ${exportedVmName}`);

      try {
        await this.config.vsphereClient.vmPowerOff(vmId);
      } catch {
        // VM might already be powered off.
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      markStepComplete("power_off", "Source VM power-off requested");

      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const vmdkFsPath = exporter.datastorePathToFs(primaryDisk.sourcePath);
      const stagedVmdkPath = await exporter.transferDisk(
        this.config.esxiHost,
        esxiUser,
        vmdkFsPath,
        this.config.proxmoxHost,
        proxmoxUser,
        stageDir,
        7_200_000,
      );

      const converter = new DiskConverter(this.config.sshExec);
      await converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: stagedVmdkPath,
        targetPath: stageRawPath,
        sourceFormat: "vmdk",
        targetFormat: "raw",
        timeoutMs: 7_200_000,
      });

      const statResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `stat -c%s ${JSON.stringify(stageRawPath)}`,
        30_000,
      );
      if (statResult.exitCode !== 0) {
        throw new Error(`Unable to read staged disk size: ${statResult.stderr || statResult.stdout}`);
      }
      const stagedDiskSizeBytes = Number(statResult.stdout.trim());
      if (!Number.isFinite(stagedDiskSizeBytes) || stagedDiskSizeBytes <= 0) {
        throw new Error("Staged disk size is invalid for Azure page blob upload");
      }
      if (stagedDiskSizeBytes % 512 !== 0) {
        throw new Error("Staged disk size must be a multiple of 512 bytes for Azure page blobs");
      }
      markStepComplete("export_disk", `Transferred and converted primary disk to ${stageRawPath}`);

      await azureClient.ensureResourceGroup(resourceGroup, location);
      const storageAccount = await azureClient.ensureStorageAccount({
        resourceGroup,
        accountName: storageAccountName,
        location,
      });
      await azureClient.ensureBlobContainer(resourceGroup, storageAccount.name, containerName);
      const storageKey = await azureClient.getStorageAccountKey(resourceGroup, storageAccount.name);

      const connectionString =
        `DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};` +
        `AccountKey=${storageKey};EndpointSuffix=core.windows.net`;
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blobName = `${this.sanitizeAzureName(exportResult.vmConfig.name, "vmware-vm", 48)}-${Date.now()}.vhd`;
      const pageBlobClient = containerClient.getPageBlobClient(blobName);
      blobClientForCleanup = pageBlobClient;
      uploadedBlobUrl = pageBlobClient.url;

      const sharedKeyCredential = new StorageSharedKeyCredential(storageAccount.name, storageKey);
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          startsOn: new Date(Date.now() - 5 * 60 * 1000),
          expiresOn: new Date(Date.now() + 2 * 60 * 60 * 1000),
          permissions: BlobSASPermissions.parse("cw"),
        },
        sharedKeyCredential,
      ).toString();
      const uploadUrlWithSas = `${pageBlobClient.url}?${sasToken}`;

      await this.uploadDiskToAzurePageBlob(
        this.config.proxmoxHost,
        proxmoxUser,
        stageRawPath,
        uploadUrlWithSas,
        stagedDiskSizeBytes,
      );
      markStepComplete("upload_to_azure", `Uploaded staged disk to ${uploadedBlobUrl}`);

      managedDiskName = this.sanitizeAzureName(`${exportResult.vmConfig.name}-osdisk`, `vmware-${vmId}-osdisk`, 80);
      const osType = this.detectAzureOsType(exportResult.vmConfig.guestOS);
      const managedDisk = await azureClient.createManagedDiskFromImport({
        resourceGroup,
        name: managedDiskName,
        sourceUri: pageBlobClient.url,
        storageAccountId: storageAccount.id,
        location,
        osType,
      });
      createdDisk = true;
      managedDiskId = managedDisk.id;
      markStepComplete("create_managed_disk", `Created managed disk ${managedDiskName}`);

      const analysis = this.buildAzureTargetAnalysis(exportResult.vmConfig);
      vmSize = requestedVmSize ?? analysis.target.recommended.vmSize;
      subnetId = requestedSubnetId ?? await this.resolveAzureSubnetId(resourceGroup);
      vmName = this.sanitizeAzureName(exportResult.vmConfig.name, `vmware-vm-${vmId}`, 64);

      await azureClient.createVMFromManagedDisk({
        resourceGroup,
        name: vmName,
        location,
        vmSize,
        osDiskId: managedDisk.id,
        subnetId,
        osType,
      });
      createdVm = true;
      markStepComplete("create_vm", `Created Azure VM ${vmName}`);

      // Blob is no longer required once the managed disk import succeeds.
      await pageBlobClient.deleteIfExists();
      blobClientForCleanup = null;
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      markStepComplete("cleanup", "Removed temporary blob and staging files");

      return {
        success: true,
        data: {
          id: `mig-${Date.now()}`,
          source: {
            provider: "vmware",
            vmId,
            vmName: exportedVmName,
            host: this.config.esxiHost,
          },
          target: {
            provider: "azure",
            node: location,
            host: "azure",
            storage: "managed-disk",
            vmSize,
            resourceGroup,
            subnetId,
          },
          vmConfig: exportResult.vmConfig,
          status: "completed",
          steps: executionSteps,
          startedAt,
          completedAt: new Date().toISOString(),
          metadata: {
            managedDiskId,
            managedDiskName,
            uploadedBlobUrl,
          },
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstPendingStep = executionSteps.find((entry) => entry.status === "pending");
      if (firstPendingStep) {
        markStepFailed(firstPendingStep.name, errorMessage);
        markPendingCleanupSteps(firstPendingStep.name, "Not executed due to earlier failure");
      }

      const cleanupFailures: string[] = [];

      if (createdVm && vmName) {
        try {
          await azureClient.deleteVM(resourceGroup, vmName);
        } catch (cleanupErr) {
          cleanupFailures.push(`delete VM ${vmName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }

      if (createdDisk && managedDiskName) {
        try {
          await azureClient.deleteDisk(resourceGroup, managedDiskName);
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete managed disk ${managedDiskName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }

      if (blobClientForCleanup) {
        try {
          await blobClientForCleanup.deleteIfExists();
        } catch (cleanupErr) {
          cleanupFailures.push(`delete page blob: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }

      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupFailures.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      const cleanupSuffix = cleanupFailures.length > 0
        ? ` Cleanup warnings: ${cleanupFailures.join("; ")}`
        : "";

      return {
        success: false,
        error: `${errorMessage}${cleanupSuffix}`,
      };
    }
  }

  private async executeProxmoxToAzure(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    const azureClient = this.config.azureClient;
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const resourceGroup = this.normalizeOptionalString(params.resource_group) ?? "vclaw-migrations";
    const location = this.normalizeOptionalString(params.location) ?? azureClient.defaultLocation;
    const storageAccountName = this.normalizeOptionalString(params.storage_account)
      ?? this.buildAzureStorageAccountName(resourceGroup, azureClient.subscriptionId);
    const containerName = this.normalizeOptionalString(params.container_name) ?? "vhds";
    const requestedVmSize = this.normalizeOptionalString(params.vm_size);
    const requestedSubnetId = this.normalizeOptionalString(params.subnet_id);

    const startedAt = new Date().toISOString();
    const executionSteps: Array<{ name: string; status: "pending" | "completed" | "failed"; detail?: string; error?: string }> = [
      { name: "export_config", status: "pending" },
      { name: "power_off", status: "pending" },
      { name: "export_disk", status: "pending" },
      { name: "upload_to_azure", status: "pending" },
      { name: "create_managed_disk", status: "pending" },
      { name: "create_vm", status: "pending" },
      { name: "cleanup", status: "pending" },
    ];

    const markStepComplete = (name: string, detail?: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "completed";
      if (detail) step.detail = detail;
    };

    const markStepFailed = (name: string, error: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "failed";
      step.error = error;
    };

    const markPendingCleanupSteps = (name: string, detail: string) => {
      let reached = false;
      for (const step of executionSteps) {
        if (step.name === name) reached = true;
        if (reached && step.status === "pending") {
          step.status = "completed";
          step.detail = detail;
        }
      }
    };

    const workDir = "/tmp/vclaw-migration";
    const stageDir = `${workDir}/pve-azure-${Date.now()}`;
    const stageDiskPath = `${stageDir}/disk.raw`;
    let managedDiskName = "";
    let vmName = "";
    let exportedVmName = "";
    let vmSize = requestedVmSize ?? "Standard_B2s";
    let subnetId = requestedSubnetId ?? "";
    let managedDiskId = "";
    let uploadedBlobUrl = "";
    let createdVm = false;
    let createdDisk = false;
    let blobClientForCleanup: { deleteIfExists: () => Promise<unknown> } | null = null;

    try {
      const { ProxmoxExporter } = await import("./proxmox-exporter.js");
      const exporter = new ProxmoxExporter(this.config.proxmoxClient, this.config.sshExec);
      const exportResult = await exporter.exportVM(
        this.config.proxmoxNode,
        vmId,
        this.config.proxmoxHost,
        proxmoxUser,
      );
      if (exportResult.vmConfig.disks.length === 0) {
        throw new Error("Source VM has no attached disks. Nothing to migrate.");
      }

      exportedVmName = exportResult.vmConfig.name;
      markStepComplete("export_config", `Exported Proxmox VM config for ${exportedVmName}`);

      try {
        await this.config.proxmoxClient.stopVM(this.config.proxmoxNode, vmId);
      } catch {
        // VM might already be stopped.
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      markStepComplete("power_off", "Source VM power-off requested");

      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const converter = new DiskConverter(this.config.sshExec);
      const primaryDisk = exportResult.vmConfig.disks[0];
      await converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: primaryDisk.sourcePath,
        targetPath: stageDiskPath,
        sourceFormat: primaryDisk.sourceFormat,
        targetFormat: "raw",
        timeoutMs: 7_200_000,
      });

      const statResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `stat -c%s ${JSON.stringify(stageDiskPath)}`,
        30_000,
      );
      if (statResult.exitCode !== 0) {
        throw new Error(`Unable to read staged disk size: ${statResult.stderr || statResult.stdout}`);
      }
      const stagedDiskSizeBytes = Number(statResult.stdout.trim());
      if (!Number.isFinite(stagedDiskSizeBytes) || stagedDiskSizeBytes <= 0) {
        throw new Error("Staged disk size is invalid for Azure page blob upload");
      }
      if (stagedDiskSizeBytes % 512 !== 0) {
        throw new Error("Staged disk size must be a multiple of 512 bytes for Azure page blobs");
      }
      markStepComplete("export_disk", `Exported and converted primary disk to ${stageDiskPath}`);

      await azureClient.ensureResourceGroup(resourceGroup, location);
      const storageAccount = await azureClient.ensureStorageAccount({
        resourceGroup,
        accountName: storageAccountName,
        location,
      });
      await azureClient.ensureBlobContainer(resourceGroup, storageAccount.name, containerName);
      const storageKey = await azureClient.getStorageAccountKey(resourceGroup, storageAccount.name);

      const connectionString =
        `DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};` +
        `AccountKey=${storageKey};EndpointSuffix=core.windows.net`;
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blobName = `${this.sanitizeAzureName(exportResult.vmConfig.name, "proxmox-vm", 48)}-${Date.now()}.vhd`;
      const pageBlobClient = containerClient.getPageBlobClient(blobName);
      blobClientForCleanup = pageBlobClient;
      uploadedBlobUrl = pageBlobClient.url;

      const sharedKeyCredential = new StorageSharedKeyCredential(storageAccount.name, storageKey);
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          startsOn: new Date(Date.now() - 5 * 60 * 1000),
          expiresOn: new Date(Date.now() + 2 * 60 * 60 * 1000),
          permissions: BlobSASPermissions.parse("cw"),
        },
        sharedKeyCredential,
      ).toString();
      const uploadUrlWithSas = `${pageBlobClient.url}?${sasToken}`;

      await this.uploadDiskToAzurePageBlob(
        this.config.proxmoxHost,
        proxmoxUser,
        stageDiskPath,
        uploadUrlWithSas,
        stagedDiskSizeBytes,
      );
      markStepComplete("upload_to_azure", `Uploaded staged disk to ${uploadedBlobUrl}`);

      managedDiskName = this.sanitizeAzureName(`${exportResult.vmConfig.name}-osdisk`, `pve-${vmId}-osdisk`, 80);
      const osType = this.detectAzureOsType(exportResult.vmConfig.guestOS);
      const managedDisk = await azureClient.createManagedDiskFromImport({
        resourceGroup,
        name: managedDiskName,
        sourceUri: pageBlobClient.url,
        storageAccountId: storageAccount.id,
        location,
        osType,
      });
      createdDisk = true;
      managedDiskId = managedDisk.id;
      markStepComplete("create_managed_disk", `Created managed disk ${managedDiskName}`);

      const analysis = this.buildAzureTargetAnalysis(exportResult.vmConfig);
      vmSize = requestedVmSize ?? analysis.target.recommended.vmSize;
      subnetId = requestedSubnetId ?? await this.resolveAzureSubnetId(resourceGroup);
      vmName = this.sanitizeAzureName(exportResult.vmConfig.name, `proxmox-vm-${vmId}`, 64);

      await azureClient.createVMFromManagedDisk({
        resourceGroup,
        name: vmName,
        location,
        vmSize,
        osDiskId: managedDisk.id,
        subnetId,
        osType,
      });
      createdVm = true;
      markStepComplete("create_vm", `Created Azure VM ${vmName}`);

      // Blob is no longer required once the managed disk import succeeds.
      await pageBlobClient.deleteIfExists();
      blobClientForCleanup = null;
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      markStepComplete("cleanup", "Removed temporary blob and staging files");

      return {
        success: true,
        data: {
          id: `mig-${Date.now()}`,
          source: {
            provider: "proxmox",
            vmId: String(vmId),
            vmName: exportedVmName,
            host: this.config.proxmoxHost,
          },
          target: {
            provider: "azure",
            node: location,
            host: "azure",
            storage: "managed-disk",
            vmSize,
            resourceGroup,
            subnetId,
          },
          vmConfig: exportResult.vmConfig,
          status: "completed",
          steps: executionSteps,
          startedAt,
          completedAt: new Date().toISOString(),
          metadata: {
            managedDiskId,
            managedDiskName,
            uploadedBlobUrl,
          },
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstPendingStep = executionSteps.find((entry) => entry.status === "pending");
      if (firstPendingStep) {
        markStepFailed(firstPendingStep.name, errorMessage);
        markPendingCleanupSteps(firstPendingStep.name, "Not executed due to earlier failure");
      }

      const cleanupFailures: string[] = [];

      if (createdVm && vmName) {
        try {
          await azureClient.deleteVM(resourceGroup, vmName);
        } catch (cleanupErr) {
          cleanupFailures.push(`delete VM ${vmName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }

      if (createdDisk && managedDiskName) {
        try {
          await azureClient.deleteDisk(resourceGroup, managedDiskName);
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete managed disk ${managedDiskName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }

      if (blobClientForCleanup) {
        try {
          await blobClientForCleanup.deleteIfExists();
        } catch (cleanupErr) {
          cleanupFailures.push(`delete page blob: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }

      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupFailures.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      const cleanupSuffix = cleanupFailures.length > 0
        ? ` Cleanup warnings: ${cleanupFailures.join("; ")}`
        : "";

      return {
        success: false,
        error: `${errorMessage}${cleanupSuffix}`,
      };
    }
  }

  private async executeAWSToAzure(params: Record<string, unknown>): Promise<ToolCallResult> {
    const instanceId = (params.instance_id as string) ?? (params.vm_id as string);
    if (!instanceId) return { success: false, error: "instance_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    const azureClient = this.config.azureClient;
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const resourceGroup = this.normalizeOptionalString(params.resource_group) ?? "vclaw-migrations";
    const location = this.normalizeOptionalString(params.location) ?? azureClient.defaultLocation;
    const storageAccountName = this.normalizeOptionalString(params.storage_account)
      ?? this.buildAzureStorageAccountName(resourceGroup, azureClient.subscriptionId);
    const containerName = this.normalizeOptionalString(params.container_name) ?? "vhds";
    const requestedVmSize = this.normalizeOptionalString(params.vm_size);
    const requestedSubnetId = this.normalizeOptionalString(params.subnet_id);

    const startedAt = new Date().toISOString();
    const executionSteps: Array<{ name: string; status: "pending" | "completed" | "failed"; detail?: string; error?: string }> = [
      { name: "export_config", status: "pending" },
      { name: "power_off", status: "pending" },
      { name: "export_disk", status: "pending" },
      { name: "upload_to_azure", status: "pending" },
      { name: "create_managed_disk", status: "pending" },
      { name: "create_vm", status: "pending" },
      { name: "cleanup", status: "pending" },
    ];

    const markStepComplete = (name: string, detail?: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "completed";
      if (detail) step.detail = detail;
    };

    const markStepFailed = (name: string, error: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "failed";
      step.error = error;
    };

    const markPendingCleanupSteps = (name: string, detail: string) => {
      let reached = false;
      for (const step of executionSteps) {
        if (step.name === name) reached = true;
        if (reached && step.status === "pending") {
          step.status = "completed";
          step.detail = detail;
        }
      }
    };

    const workDir = "/tmp/vclaw-migration";
    const stageDir = `${workDir}/aws-azure-${Date.now()}`;
    const stageVmdkPath = `${stageDir}/disk.vmdk`;
    const stageRawPath = `${stageDir}/disk.raw`;
    let managedDiskName = "";
    let vmName = "";
    let vmSize = requestedVmSize ?? "Standard_B2s";
    let subnetId = requestedSubnetId ?? "";
    let managedDiskId = "";
    let uploadedBlobUrl = "";
    let createdVm = false;
    let createdDisk = false;
    let blobClientForCleanup: { deleteIfExists: () => Promise<unknown> } | null = null;

    try {
      const awsExporter = new AWSExporter(
        this.config.awsClient,
        this.config.awsS3Bucket,
        this.config.awsS3Prefix ?? "vclaw-migration/",
      );
      const exportResult = await awsExporter.exportInstance(instanceId);
      markStepComplete("export_config", `Created AMI ${exportResult.amiId} and prepared AWS export metadata`);

      markStepComplete("power_off", "No explicit source power-off required for AWS AMI export");

      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const downloadResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `aws s3 cp s3://${exportResult.s3Bucket}/${exportResult.s3Key} ${JSON.stringify(stageVmdkPath)} --no-progress`,
        7_200_000,
      );
      if (downloadResult.exitCode !== 0) {
        throw new Error(`Failed to download exported AWS disk from S3: ${downloadResult.stderr || downloadResult.stdout}`);
      }

      const converter = new DiskConverter(this.config.sshExec);
      await converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: stageVmdkPath,
        targetPath: stageRawPath,
        sourceFormat: "vmdk",
        targetFormat: "raw",
        timeoutMs: 7_200_000,
      });

      const statResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `stat -c%s ${JSON.stringify(stageRawPath)}`,
        30_000,
      );
      if (statResult.exitCode !== 0) {
        throw new Error(`Unable to read staged disk size: ${statResult.stderr || statResult.stdout}`);
      }
      const stagedDiskSizeBytes = Number(statResult.stdout.trim());
      if (!Number.isFinite(stagedDiskSizeBytes) || stagedDiskSizeBytes <= 0) {
        throw new Error("Staged disk size is invalid for Azure page blob upload");
      }
      if (stagedDiskSizeBytes % 512 !== 0) {
        throw new Error("Staged disk size must be a multiple of 512 bytes for Azure page blobs");
      }
      markStepComplete("export_disk", `Downloaded and converted AWS export disk to ${stageRawPath}`);

      await azureClient.ensureResourceGroup(resourceGroup, location);
      const storageAccount = await azureClient.ensureStorageAccount({
        resourceGroup,
        accountName: storageAccountName,
        location,
      });
      await azureClient.ensureBlobContainer(resourceGroup, storageAccount.name, containerName);
      const storageKey = await azureClient.getStorageAccountKey(resourceGroup, storageAccount.name);

      const connectionString =
        `DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};` +
        `AccountKey=${storageKey};EndpointSuffix=core.windows.net`;
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blobName = `${this.sanitizeAzureName(exportResult.vmConfig.name, "aws-vm", 48)}-${Date.now()}.vhd`;
      const pageBlobClient = containerClient.getPageBlobClient(blobName);
      blobClientForCleanup = pageBlobClient;
      uploadedBlobUrl = pageBlobClient.url;

      const sharedKeyCredential = new StorageSharedKeyCredential(storageAccount.name, storageKey);
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          startsOn: new Date(Date.now() - 5 * 60 * 1000),
          expiresOn: new Date(Date.now() + 2 * 60 * 60 * 1000),
          permissions: BlobSASPermissions.parse("cw"),
        },
        sharedKeyCredential,
      ).toString();
      const uploadUrlWithSas = `${pageBlobClient.url}?${sasToken}`;

      await this.uploadDiskToAzurePageBlob(
        this.config.proxmoxHost,
        proxmoxUser,
        stageRawPath,
        uploadUrlWithSas,
        stagedDiskSizeBytes,
      );
      markStepComplete("upload_to_azure", `Uploaded staged disk to ${uploadedBlobUrl}`);

      managedDiskName = this.sanitizeAzureName(`${exportResult.vmConfig.name}-osdisk`, `aws-${instanceId}-osdisk`, 80);
      const osType = this.detectAzureOsType(exportResult.vmConfig.guestOS);
      const managedDisk = await azureClient.createManagedDiskFromImport({
        resourceGroup,
        name: managedDiskName,
        sourceUri: pageBlobClient.url,
        storageAccountId: storageAccount.id,
        location,
        osType,
      });
      createdDisk = true;
      managedDiskId = managedDisk.id;
      markStepComplete("create_managed_disk", `Created managed disk ${managedDiskName}`);

      const analysis = this.buildAzureTargetAnalysis(exportResult.vmConfig);
      vmSize = requestedVmSize ?? analysis.target.recommended.vmSize;
      subnetId = requestedSubnetId ?? await this.resolveAzureSubnetId(resourceGroup);
      vmName = this.sanitizeAzureName(exportResult.vmConfig.name, `aws-vm-${instanceId}`, 64);

      await azureClient.createVMFromManagedDisk({
        resourceGroup,
        name: vmName,
        location,
        vmSize,
        osDiskId: managedDisk.id,
        subnetId,
        osType,
      });
      createdVm = true;
      markStepComplete("create_vm", `Created Azure VM ${vmName}`);

      // Blob is no longer required once the managed disk import succeeds.
      await pageBlobClient.deleteIfExists();
      blobClientForCleanup = null;
      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      markStepComplete("cleanup", "Removed temporary blob and staging files");

      return {
        success: true,
        data: {
          id: `mig-${Date.now()}`,
          source: {
            provider: "aws",
            vmId: instanceId,
            instanceId,
            vmName: exportResult.vmConfig.name,
            host: "aws",
          },
          target: {
            provider: "azure",
            node: location,
            host: "azure",
            storage: "managed-disk",
            vmSize,
            resourceGroup,
            subnetId,
          },
          vmConfig: exportResult.vmConfig,
          status: "completed",
          steps: executionSteps,
          startedAt,
          completedAt: new Date().toISOString(),
          metadata: {
            managedDiskId,
            managedDiskName,
            uploadedBlobUrl,
            sourceS3Object: `s3://${exportResult.s3Bucket}/${exportResult.s3Key}`,
          },
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstPendingStep = executionSteps.find((entry) => entry.status === "pending");
      if (firstPendingStep) {
        markStepFailed(firstPendingStep.name, errorMessage);
        markPendingCleanupSteps(firstPendingStep.name, "Not executed due to earlier failure");
      }

      const cleanupFailures: string[] = [];

      if (createdVm && vmName) {
        try {
          await azureClient.deleteVM(resourceGroup, vmName);
        } catch (cleanupErr) {
          cleanupFailures.push(`delete VM ${vmName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }

      if (createdDisk && managedDiskName) {
        try {
          await azureClient.deleteDisk(resourceGroup, managedDiskName);
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete managed disk ${managedDiskName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }

      if (blobClientForCleanup) {
        try {
          await blobClientForCleanup.deleteIfExists();
        } catch (cleanupErr) {
          cleanupFailures.push(`delete page blob: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }

      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupFailures.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      const cleanupSuffix = cleanupFailures.length > 0
        ? ` Cleanup warnings: ${cleanupFailures.join("; ")}`
        : "";

      return {
        success: false,
        error: `${errorMessage}${cleanupSuffix}`,
      };
    }
  }

  private async executeAzureToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    const azureClient = this.config.azureClient;
    const esxiUser = this.config.esxiUser ?? "root";
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const workDir = "/tmp/vclaw-migration";
    const stageDir = `${workDir}/azure-vmware-${Date.now()}`;
    const stagedVhdPath = `${stageDir}/disk.vhd`;
    const stagedVmdkPath = `${stageDir}/disk.vmdk`;

    const startedAt = new Date().toISOString();
    const executionSteps: Array<{ name: string; status: "pending" | "completed" | "failed"; detail?: string; error?: string }> = [
      { name: "capture_image", status: "pending" },
      { name: "export_disk", status: "pending" },
      { name: "download_disk", status: "pending" },
      { name: "convert_disk", status: "pending" },
      { name: "import_vm", status: "pending" },
      { name: "cleanup", status: "pending" },
    ];

    const markStepComplete = (name: string, detail?: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "completed";
      if (detail) step.detail = detail;
    };

    const markStepFailed = (name: string, error: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "failed";
      step.error = error;
    };

    const markPendingCleanupSteps = (name: string, detail: string) => {
      let reached = false;
      for (const step of executionSteps) {
        if (step.name === name) reached = true;
        if (reached && step.status === "pending") {
          step.status = "completed";
          step.detail = detail;
        }
      }
    };

    let snapshotName = "";
    let snapshotResourceGroup = "";
    let snapshotSasUrl = "";
    let createdSnapshot = false;
    let snapshotAccessGranted = false;

    try {
      const azureSource = await this.getAzureSourceVM(vmId);
      const osDiskId = azureSource.vm.osDiskId ?? azureSource.vmConfig.disks[0]?.sourcePath;
      if (!osDiskId) {
        throw new Error(`Azure VM ${azureSource.vm.name} has no attached OS disk`);
      }

      const osDiskRef = this.parseAzureDiskReference(osDiskId);
      if (!osDiskRef) {
        throw new Error("Unable to parse OS disk resource group/name from Azure disk id");
      }
      snapshotResourceGroup = osDiskRef.resourceGroup;
      snapshotName = this.sanitizeAzureName(
        `${azureSource.vm.name}-osdisk-snap-${Date.now()}`,
        `azure-${Date.now()}-osdisk-snap`,
        80,
      );

      const snapshot = await azureClient.createSnapshot({
        resourceGroup: snapshotResourceGroup,
        name: snapshotName,
        sourceDiskId: osDiskId,
        location: azureSource.vm.location,
      });
      createdSnapshot = true;
      snapshotName = snapshot.name || snapshotName;
      markStepComplete("capture_image", `Created snapshot ${snapshotName} from OS disk`);

      snapshotSasUrl = await azureClient.grantSnapshotReadAccess(snapshotResourceGroup, snapshotName, 2 * 60 * 60);
      snapshotAccessGranted = true;
      markStepComplete("export_disk", "Granted read-only SAS access for snapshot export");

      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const downloadResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `curl --fail --location --retry 3 --retry-delay 2 --output ${JSON.stringify(stagedVhdPath)} ${JSON.stringify(snapshotSasUrl)}`,
        7_200_000,
      );
      if (downloadResult.exitCode !== 0) {
        throw new Error(`Failed to download Azure snapshot VHD: ${downloadResult.stderr || downloadResult.stdout}`);
      }
      markStepComplete("download_disk", `Downloaded Azure VHD to ${stagedVhdPath}`);

      const converter = new DiskConverter(this.config.sshExec);
      await converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: stagedVhdPath,
        targetPath: stagedVmdkPath,
        sourceFormat: "vhd",
        targetFormat: "vmdk",
        timeoutMs: 7_200_000,
      });
      markStepComplete("convert_disk", `Converted VHD to ${stagedVmdkPath}`);

      const { VMwareImporter } = await import("./vmware-importer.js");
      const vmwareImporter = new VMwareImporter(this.config.vsphereClient, this.config.sshExec);
      const defaults = await vmwareImporter.resolveDefaults();
      const importResult = await vmwareImporter.importVM(
        {
          config: azureSource.vmConfig,
          vmdkPath: stagedVmdkPath,
          esxiHost: this.config.esxiHost,
          esxiUser,
          datastoreId: defaults.datastoreId,
          datastoreName: defaults.datastoreName,
          hostId: defaults.hostId,
          folderId: defaults.folderId,
          networkId: defaults.networkId,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );
      markStepComplete("import_vm", `Imported VM into VMware as ${importResult.vmId}`);

      const cleanupWarnings: string[] = [];
      if (snapshotAccessGranted) {
        try {
          await azureClient.revokeSnapshotAccess(snapshotResourceGroup, snapshotName);
          snapshotAccessGranted = false;
        } catch (cleanupErr) {
          cleanupWarnings.push(
            `revoke snapshot access ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      if (createdSnapshot) {
        try {
          await azureClient.deleteSnapshot(snapshotResourceGroup, snapshotName);
          createdSnapshot = false;
        } catch (cleanupErr) {
          cleanupWarnings.push(
            `delete snapshot ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupWarnings.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
      markStepComplete(
        "cleanup",
        cleanupWarnings.length > 0
          ? `Cleanup completed with warnings: ${cleanupWarnings.join("; ")}`
          : "Revoked snapshot access, deleted snapshot, and removed staging files",
      );

      return {
        success: true,
        data: {
          id: `mig-${Date.now()}`,
          source: {
            provider: "azure",
            vmId,
            vmName: azureSource.vm.name,
            host: "azure",
            resourceGroup: azureSource.resourceGroup,
          },
          target: {
            provider: "vmware",
            vmId: importResult.vmId,
            host: this.config.esxiHost,
            datastoreName: importResult.datastoreName,
          },
          vmConfig: azureSource.vmConfig,
          status: "completed",
          steps: executionSteps,
          startedAt,
          completedAt: new Date().toISOString(),
          metadata: {
            snapshotName,
            snapshotResourceGroup,
            snapshotSasHost: snapshotSasUrl.split("?")[0],
          },
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstPendingStep = executionSteps.find((entry) => entry.status === "pending");
      if (firstPendingStep) {
        markStepFailed(firstPendingStep.name, errorMessage);
        markPendingCleanupSteps(firstPendingStep.name, "Not executed due to earlier failure");
      }

      const cleanupFailures: string[] = [];
      if (snapshotAccessGranted && snapshotResourceGroup && snapshotName) {
        try {
          await azureClient.revokeSnapshotAccess(snapshotResourceGroup, snapshotName);
          snapshotAccessGranted = false;
        } catch (cleanupErr) {
          cleanupFailures.push(
            `revoke snapshot access ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      if (createdSnapshot && snapshotResourceGroup && snapshotName) {
        try {
          await azureClient.deleteSnapshot(snapshotResourceGroup, snapshotName);
          createdSnapshot = false;
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete snapshot ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupFailures.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      const cleanupSuffix = cleanupFailures.length > 0
        ? ` Cleanup warnings: ${cleanupFailures.join("; ")}`
        : "";
      return {
        success: false,
        error: `${errorMessage}${cleanupSuffix}`,
      };
    }
  }

  private async executeAzureToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };

    const azureClient = this.config.azureClient;
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const proxmoxStorage = this.config.proxmoxStorage ?? "local-lvm";
    const workDir = "/tmp/vclaw-migration";
    const stageDir = `${workDir}/azure-pve-${Date.now()}`;
    const stagedVhdPath = `${stageDir}/disk.vhd`;
    const stagedQcow2Path = `${stageDir}/disk.qcow2`;

    const startedAt = new Date().toISOString();
    const executionSteps: Array<{ name: string; status: "pending" | "completed" | "failed"; detail?: string; error?: string }> = [
      { name: "capture_image", status: "pending" },
      { name: "export_disk", status: "pending" },
      { name: "download_disk", status: "pending" },
      { name: "convert_disk", status: "pending" },
      { name: "import_vm", status: "pending" },
      { name: "cleanup", status: "pending" },
    ];

    const markStepComplete = (name: string, detail?: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "completed";
      if (detail) step.detail = detail;
    };

    const markStepFailed = (name: string, error: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "failed";
      step.error = error;
    };

    const markPendingCleanupSteps = (name: string, detail: string) => {
      let reached = false;
      for (const step of executionSteps) {
        if (step.name === name) reached = true;
        if (reached && step.status === "pending") {
          step.status = "completed";
          step.detail = detail;
        }
      }
    };

    let snapshotName = "";
    let snapshotResourceGroup = "";
    let snapshotSasUrl = "";
    let createdSnapshot = false;
    let snapshotAccessGranted = false;
    let targetVmId: number | null = null;

    try {
      const azureSource = await this.getAzureSourceVM(vmId);
      const osDiskId = azureSource.vm.osDiskId ?? azureSource.vmConfig.disks[0]?.sourcePath;
      if (!osDiskId) {
        throw new Error(`Azure VM ${azureSource.vm.name} has no attached OS disk`);
      }

      const osDiskRef = this.parseAzureDiskReference(osDiskId);
      if (!osDiskRef) {
        throw new Error("Unable to parse OS disk resource group/name from Azure disk id");
      }
      snapshotResourceGroup = osDiskRef.resourceGroup;
      snapshotName = this.sanitizeAzureName(
        `${azureSource.vm.name}-osdisk-snap-${Date.now()}`,
        `azure-${Date.now()}-osdisk-snap`,
        80,
      );

      const snapshot = await azureClient.createSnapshot({
        resourceGroup: snapshotResourceGroup,
        name: snapshotName,
        sourceDiskId: osDiskId,
        location: azureSource.vm.location,
      });
      createdSnapshot = true;
      snapshotName = snapshot.name || snapshotName;
      markStepComplete("capture_image", `Created snapshot ${snapshotName} from OS disk`);

      snapshotSasUrl = await azureClient.grantSnapshotReadAccess(snapshotResourceGroup, snapshotName, 2 * 60 * 60);
      snapshotAccessGranted = true;
      markStepComplete("export_disk", "Granted read-only SAS access for snapshot export");

      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const downloadResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `curl --fail --location --retry 3 --retry-delay 2 --output ${JSON.stringify(stagedVhdPath)} ${JSON.stringify(snapshotSasUrl)}`,
        7_200_000,
      );
      if (downloadResult.exitCode !== 0) {
        throw new Error(`Failed to download Azure snapshot VHD: ${downloadResult.stderr || downloadResult.stdout}`);
      }
      markStepComplete("download_disk", `Downloaded Azure VHD to ${stagedVhdPath}`);

      const converter = new DiskConverter(this.config.sshExec);
      await converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: stagedVhdPath,
        targetPath: stagedQcow2Path,
        sourceFormat: "vhd",
        targetFormat: "qcow2",
        timeoutMs: 7_200_000,
      });
      markStepComplete("convert_disk", `Converted VHD to ${stagedQcow2Path}`);

      const { ProxmoxImporter } = await import("./proxmox-importer.js");
      const proxmoxImporter = new ProxmoxImporter(this.config.proxmoxClient, this.config.sshExec);
      targetVmId = await proxmoxImporter.getNextVMID(this.config.proxmoxHost, proxmoxUser);
      const importResult = await proxmoxImporter.importVM(
        {
          node: this.config.proxmoxNode,
          vmId: targetVmId,
          storage: proxmoxStorage,
          config: azureSource.vmConfig,
          diskPath: stagedQcow2Path,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );
      markStepComplete("import_vm", `Imported VM into Proxmox as VM ${importResult.vmId}`);

      const cleanupWarnings: string[] = [];
      if (snapshotAccessGranted) {
        try {
          await azureClient.revokeSnapshotAccess(snapshotResourceGroup, snapshotName);
          snapshotAccessGranted = false;
        } catch (cleanupErr) {
          cleanupWarnings.push(
            `revoke snapshot access ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      if (createdSnapshot) {
        try {
          await azureClient.deleteSnapshot(snapshotResourceGroup, snapshotName);
          createdSnapshot = false;
        } catch (cleanupErr) {
          cleanupWarnings.push(
            `delete snapshot ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupWarnings.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
      markStepComplete(
        "cleanup",
        cleanupWarnings.length > 0
          ? `Cleanup completed with warnings: ${cleanupWarnings.join("; ")}`
          : "Revoked snapshot access, deleted snapshot, and removed staging files",
      );

      return {
        success: true,
        data: {
          id: `mig-${Date.now()}`,
          source: {
            provider: "azure",
            vmId,
            vmName: azureSource.vm.name,
            host: "azure",
            resourceGroup: azureSource.resourceGroup,
          },
          target: {
            provider: "proxmox",
            node: this.config.proxmoxNode,
            host: this.config.proxmoxHost,
            storage: proxmoxStorage,
            vmId: targetVmId,
          },
          vmConfig: azureSource.vmConfig,
          status: "completed",
          steps: executionSteps,
          startedAt,
          completedAt: new Date().toISOString(),
          metadata: {
            snapshotName,
            snapshotResourceGroup,
            snapshotSasHost: snapshotSasUrl.split("?")[0],
          },
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstPendingStep = executionSteps.find((entry) => entry.status === "pending");
      if (firstPendingStep) {
        markStepFailed(firstPendingStep.name, errorMessage);
        markPendingCleanupSteps(firstPendingStep.name, "Not executed due to earlier failure");
      }

      const cleanupFailures: string[] = [];
      if (snapshotAccessGranted && snapshotResourceGroup && snapshotName) {
        try {
          await azureClient.revokeSnapshotAccess(snapshotResourceGroup, snapshotName);
          snapshotAccessGranted = false;
        } catch (cleanupErr) {
          cleanupFailures.push(
            `revoke snapshot access ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      if (createdSnapshot && snapshotResourceGroup && snapshotName) {
        try {
          await azureClient.deleteSnapshot(snapshotResourceGroup, snapshotName);
          createdSnapshot = false;
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete snapshot ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupFailures.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      if (targetVmId !== null && executionSteps.find((step) => step.name === "import_vm")?.status !== "completed") {
        try {
          await this.config.proxmoxClient.deleteVM(this.config.proxmoxNode, targetVmId, true);
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete partially-created Proxmox VM ${targetVmId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }

      const cleanupSuffix = cleanupFailures.length > 0
        ? ` Cleanup warnings: ${cleanupFailures.join("; ")}`
        : "";
      return {
        success: false,
        error: `${errorMessage}${cleanupSuffix}`,
      };
    }
  }

  private async executeAzureToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.azureClient) return { success: false, error: "Azure not configured" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };

    const azureClient = this.config.azureClient;
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const instanceType = this.normalizeOptionalString(params.instance_type) ?? undefined;
    const subnetId = this.normalizeOptionalString(params.subnet_id) ?? undefined;
    const securityGroupIdsRaw = this.normalizeOptionalString(params.security_group_ids);
    const securityGroupIds = securityGroupIdsRaw
      ? securityGroupIdsRaw.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
      : undefined;
    const keyName = this.normalizeOptionalString(params.key_name) ?? undefined;

    const startedAt = new Date().toISOString();
    const executionSteps: Array<{ name: string; status: "pending" | "completed" | "failed"; detail?: string; error?: string }> = [
      { name: "capture_image", status: "pending" },
      { name: "export_disk", status: "pending" },
      { name: "upload_to_s3", status: "pending" },
      { name: "import_ami", status: "pending" },
      { name: "launch_instance", status: "pending" },
      { name: "cleanup", status: "pending" },
    ];

    const markStepComplete = (name: string, detail?: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "completed";
      if (detail) step.detail = detail;
    };

    const markStepFailed = (name: string, error: string) => {
      const step = executionSteps.find((entry) => entry.name === name);
      if (!step) return;
      step.status = "failed";
      step.error = error;
    };

    const markPendingCleanupSteps = (name: string, detail: string) => {
      let reached = false;
      for (const step of executionSteps) {
        if (step.name === name) reached = true;
        if (reached && step.status === "pending") {
          step.status = "completed";
          step.detail = detail;
        }
      }
    };

    const workDir = "/tmp/vclaw-migration";
    const stageDir = `${workDir}/azure-aws-${Date.now()}`;
    const stagedVhdPath = `${stageDir}/disk.vhd`;

    let snapshotName = "";
    let snapshotResourceGroup = "";
    let snapshotSasUrl = "";
    let createdSnapshot = false;
    let snapshotAccessGranted = false;

    try {
      const azureSource = await this.getAzureSourceVM(vmId);
      const osDiskId = azureSource.vm.osDiskId ?? azureSource.vmConfig.disks[0]?.sourcePath;
      if (!osDiskId) {
        throw new Error(`Azure VM ${azureSource.vm.name} has no attached OS disk`);
      }

      const osDiskRef = this.parseAzureDiskReference(osDiskId);
      if (!osDiskRef) {
        throw new Error("Unable to parse OS disk resource group/name from Azure disk id");
      }
      snapshotResourceGroup = osDiskRef.resourceGroup;
      snapshotName = this.sanitizeAzureName(
        `${azureSource.vm.name}-osdisk-snap-${Date.now()}`,
        `azure-${Date.now()}-osdisk-snap`,
        80,
      );

      const snapshot = await azureClient.createSnapshot({
        resourceGroup: snapshotResourceGroup,
        name: snapshotName,
        sourceDiskId: osDiskId,
        location: azureSource.vm.location,
      });
      createdSnapshot = true;
      snapshotName = snapshot.name || snapshotName;
      markStepComplete("capture_image", `Created snapshot ${snapshotName} from OS disk`);

      snapshotSasUrl = await azureClient.grantSnapshotReadAccess(snapshotResourceGroup, snapshotName, 2 * 60 * 60);
      snapshotAccessGranted = true;
      markStepComplete("export_disk", "Granted read-only SAS access for snapshot export");

      await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `mkdir -p ${stageDir}`, 10_000);
      const downloadResult = await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `curl --fail --location --retry 3 --retry-delay 2 --output ${JSON.stringify(stagedVhdPath)} ${JSON.stringify(snapshotSasUrl)}`,
        7_200_000,
      );
      if (downloadResult.exitCode !== 0) {
        throw new Error(`Failed to download Azure snapshot VHD: ${downloadResult.stderr || downloadResult.stdout}`);
      }

      const awsImporter = new AWSImporter(
        this.config.awsClient,
        this.config.awsS3Bucket,
        this.config.awsS3Prefix ?? "vclaw-migration/",
      );
      const importResult = await awsImporter.importVM(
        {
          vmConfig: azureSource.vmConfig,
          diskPath: stagedVhdPath,
          diskFormat: "vhd",
          instanceType,
          subnetId,
          securityGroupIds,
          keyName,
        },
        this.config.proxmoxHost,
        proxmoxUser,
      );
      markStepComplete("upload_to_s3", "Uploaded staged VHD to S3 for AWS import");
      markStepComplete("import_ami", `Imported AMI ${importResult.amiId}`);
      markStepComplete("launch_instance", `Launched EC2 instance ${importResult.instanceId}`);

      const cleanupWarnings: string[] = [];
      if (snapshotAccessGranted) {
        try {
          await azureClient.revokeSnapshotAccess(snapshotResourceGroup, snapshotName);
          snapshotAccessGranted = false;
        } catch (cleanupErr) {
          cleanupWarnings.push(
            `revoke snapshot access ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      if (createdSnapshot) {
        try {
          await azureClient.deleteSnapshot(snapshotResourceGroup, snapshotName);
          createdSnapshot = false;
        } catch (cleanupErr) {
          cleanupWarnings.push(
            `delete snapshot ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupWarnings.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
      markStepComplete(
        "cleanup",
        cleanupWarnings.length > 0
          ? `Cleanup completed with warnings: ${cleanupWarnings.join("; ")}`
          : "Revoked snapshot access, deleted snapshot, and removed staging files",
      );

      return {
        success: true,
        data: {
          id: `mig-${Date.now()}`,
          source: {
            provider: "azure",
            vmId,
            vmName: azureSource.vm.name,
            host: "azure",
            resourceGroup: azureSource.resourceGroup,
          },
          target: {
            provider: "aws",
            node: "aws",
            host: "aws",
            instanceId: importResult.instanceId,
            amiId: importResult.amiId,
            instanceType: importResult.instanceType,
            privateIp: importResult.privateIp,
          },
          vmConfig: azureSource.vmConfig,
          status: "completed",
          steps: executionSteps,
          startedAt,
          completedAt: new Date().toISOString(),
          metadata: {
            snapshotName,
            snapshotResourceGroup,
            snapshotSasHost: snapshotSasUrl.split("?")[0],
          },
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstPendingStep = executionSteps.find((entry) => entry.status === "pending");
      if (firstPendingStep) {
        markStepFailed(firstPendingStep.name, errorMessage);
        markPendingCleanupSteps(firstPendingStep.name, "Not executed due to earlier failure");
      }

      const cleanupFailures: string[] = [];
      if (snapshotAccessGranted && snapshotResourceGroup && snapshotName) {
        try {
          await azureClient.revokeSnapshotAccess(snapshotResourceGroup, snapshotName);
          snapshotAccessGranted = false;
        } catch (cleanupErr) {
          cleanupFailures.push(
            `revoke snapshot access ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      if (createdSnapshot && snapshotResourceGroup && snapshotName) {
        try {
          await azureClient.deleteSnapshot(snapshotResourceGroup, snapshotName);
          createdSnapshot = false;
        } catch (cleanupErr) {
          cleanupFailures.push(
            `delete snapshot ${snapshotName}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      try {
        await this.config.sshExec(this.config.proxmoxHost, proxmoxUser, `rm -rf ${JSON.stringify(stageDir)}`, 10_000);
      } catch (cleanupErr) {
        cleanupFailures.push(
          `remove Proxmox staging directory ${stageDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      const cleanupSuffix = cleanupFailures.length > 0
        ? ` Cleanup warnings: ${cleanupFailures.join("; ")}`
        : "";
      return {
        success: false,
        error: `${errorMessage}${cleanupSuffix}`,
      };
    }
  }

  private async executeAzureExecutionScaffold(
    direction: string,
    planBuilder: () => Promise<ToolCallResult>,
  ): Promise<ToolCallResult> {
    const planResult = await planBuilder();
    if (!planResult.success) return planResult;
    return {
      success: false,
      error:
        `Execution pipeline for ${direction} has not been implemented yet. ` +
        "Use the plan endpoint for validation and sizing until disk transfer/import is completed.",
    };
  }

  private buildAzureTargetAnalysis(vmConfig: {
    name?: string;
    cpuCount: number;
    memoryMiB: number;
    disks: Array<{ capacityBytes: number }>;
    nics?: Array<{ label: string; macAddress: string; networkName: string; adapterType: string }>;
    firmware?: "bios" | "efi";
  }): ReturnType<typeof AzureWorkloadAnalyzer.analyzeVMForAzure> {
    return AzureWorkloadAnalyzer.analyzeVMForAzure({
      name: vmConfig.name ?? "source-vm",
      cpuCount: vmConfig.cpuCount,
      memoryMiB: vmConfig.memoryMiB,
      disks: vmConfig.disks,
      nics: vmConfig.nics ?? [],
      firmware: vmConfig.firmware ?? "bios",
    }, this.config.azureClient?.defaultLocation ?? "eastus");
  }

  private buildAzureTargetPlan(
    sourceProvider: "vmware" | "proxmox" | "aws",
    sourceId: string,
    sourceName: string,
    sourceHost: string,
    vmConfig: {
      name: string;
      cpuCount: number;
      coresPerSocket: number;
      memoryMiB: number;
      guestOS: string;
      disks: Array<{ label: string; capacityBytes: number; sourcePath: string; sourceFormat: "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova"; targetFormat: "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova" }>;
      nics: Array<{ label: string; macAddress: string; networkName: string; adapterType: string }>;
      firmware: "bios" | "efi";
    },
    analysis: { target: { recommended: { vmSize: string; location: string } } },
  ): Record<string, unknown> {
    return {
      id: `plan-${Date.now()}`,
      source: {
        provider: sourceProvider,
        vmId: sourceId,
        vmName: sourceName,
        host: sourceHost,
      },
      target: {
        provider: "azure",
        node: analysis.target.recommended.location,
        host: "azure",
        storage: "managed-disk",
        vmSize: analysis.target.recommended.vmSize,
      },
      vmConfig,
      status: "pending",
      steps: [
        { name: "export_config", status: "pending" },
        { name: "power_off", status: "pending" },
        { name: "export_disk", status: "pending" },
        { name: "upload_to_azure", status: "pending" },
        { name: "create_managed_disk", status: "pending" },
        { name: "create_vm", status: "pending" },
        { name: "cleanup", status: "pending" },
      ],
    };
  }

  private buildAzureSourcePlan(
    targetProvider: "vmware" | "proxmox",
    source: {
      vm: { name: string };
      vmId: string;
      vmConfig: {
        name: string;
        cpuCount: number;
        coresPerSocket: number;
        memoryMiB: number;
        guestOS: string;
        disks: Array<{ label: string; capacityBytes: number; sourcePath: string; sourceFormat: "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova"; targetFormat: "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova" }>;
        nics: Array<{ label: string; macAddress: string; networkName: string; adapterType: string }>;
        firmware: "bios" | "efi";
      };
      resourceGroup: string;
    },
    targetCpu: number,
    targetMemoryMiB: number,
  ): Record<string, unknown> {
    const target = targetProvider === "vmware"
      ? { node: this.config.esxiHost, host: this.config.esxiHost, storage: "" }
      : { node: this.config.proxmoxNode, host: this.config.proxmoxHost, storage: this.config.proxmoxStorage || "local-lvm" };

    return {
      id: `plan-${Date.now()}`,
      source: {
        provider: "azure",
        vmId: source.vmId,
        vmName: source.vm.name,
        host: "azure",
        resourceGroup: source.resourceGroup,
      },
      target: {
        provider: targetProvider,
        ...target,
      },
      vmConfig: {
        ...source.vmConfig,
        cpuCount: targetCpu,
        memoryMiB: targetMemoryMiB,
      },
      status: "pending",
      steps: [
        { name: "capture_image", status: "pending" },
        { name: "export_disk", status: "pending" },
        { name: "download_disk", status: "pending" },
        { name: "convert_disk", status: "pending" },
        { name: "import_vm", status: "pending" },
        { name: "cleanup", status: "pending" },
      ],
    };
  }

  private parseAWSImportMode(value: unknown): "auto" | "snapshot" | "image" | null {
    if (value === undefined || value === null || value === "") {
      return "auto";
    }
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.toLowerCase();
    if (normalized === "auto" || normalized === "snapshot" || normalized === "image") {
      return normalized;
    }
    return null;
  }

  private parseOptionalBooleanParam(value: unknown): boolean | null | "invalid" {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    return "invalid";
  }

  private parseAzureVMReference(vmId: string): { resourceGroup: string; vmName: string } | null {
    const armMatch = vmId.match(
      /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)/i,
    );
    if (armMatch) {
      return {
        resourceGroup: decodeURIComponent(armMatch[1]),
        vmName: decodeURIComponent(armMatch[2]),
      };
    }

    const slashSplit = vmId.split("/");
    if (slashSplit.length === 2 && slashSplit[0] && slashSplit[1]) {
      return { resourceGroup: slashSplit[0], vmName: slashSplit[1] };
    }

    return null;
  }

  private parseAzureDiskReference(diskId: string): { resourceGroup: string; diskName: string } | null {
    const armMatch = diskId.match(
      /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/disks\/([^/]+)/i,
    );
    if (!armMatch) return null;
    return {
      resourceGroup: decodeURIComponent(armMatch[1]),
      diskName: decodeURIComponent(armMatch[2]),
    };
  }

  private async getAzureSourceVM(vmId: string): Promise<{
    vm: { id: string; name: string; vmSize: string; location: string; osType?: "Linux" | "Windows"; osDiskId?: string };
    vmId: string;
    resourceGroup: string;
    vmConfig: {
      name: string;
      cpuCount: number;
      coresPerSocket: number;
      memoryMiB: number;
      guestOS: string;
      disks: Array<{ label: string; capacityBytes: number; sourcePath: string; sourceFormat: "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova"; targetFormat: "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova" }>;
      nics: Array<{ label: string; macAddress: string; networkName: string; adapterType: string }>;
      firmware: "bios" | "efi";
    };
    totalDiskGB: number;
  }> {
    if (!this.config.azureClient) {
      throw new Error("Azure not configured");
    }

    const ref = this.parseAzureVMReference(vmId);
    if (!ref) {
      throw new Error("vm_id must be an Azure ARM id or resourceGroup/vmName");
    }

    const vm = await this.config.azureClient.getVM(ref.resourceGroup, ref.vmName);
    const size = AzureWorkloadAnalyzer.getVMSizeSpecs(vm.vmSize) ?? {
      vCPU: 2,
      memoryMiB: 4096,
      hourlyRate: 0.0416,
    };
    const disks = await this.config.azureClient.listDisks(ref.resourceGroup);
    const attachedDisks = disks.filter((disk) => disk.attachedVmId === vm.id);
    const totalDiskGB = attachedDisks.reduce((sum, disk) => sum + Math.max(1, disk.sizeGB), 0) || 64;

    const vmConfig = {
      name: vm.name,
      cpuCount: size.vCPU,
      coresPerSocket: 1,
      memoryMiB: size.memoryMiB,
      guestOS: vm.osType === "Windows" ? "windows9Server64Guest" : "otherLinux64Guest",
      disks: attachedDisks.length > 0
        ? attachedDisks.map((disk) => ({
          label: disk.name || "disk",
          capacityBytes: Math.max(1, disk.sizeGB) * 1024 * 1024 * 1024,
          sourcePath: disk.id,
          sourceFormat: "vhd" as const,
          targetFormat: "vmdk" as const,
        }))
        : [{
          label: "osdisk",
          capacityBytes: totalDiskGB * 1024 * 1024 * 1024,
          sourcePath: "",
          sourceFormat: "vhd" as const,
          targetFormat: "vmdk" as const,
        }],
      nics: (vm.networkInterfaceIds ?? []).map((nicId, index) => ({
        label: `nic-${index + 1}`,
        macAddress: "",
        networkName: nicId,
        adapterType: "virtio",
      })),
      firmware: "efi" as const,
    };

    return {
      vm: {
        id: vm.id,
        name: vm.name,
        vmSize: vm.vmSize,
        location: vm.location,
        osType: vm.osType,
        osDiskId: vm.osDiskId,
      },
      vmId,
      resourceGroup: ref.resourceGroup,
      vmConfig,
      totalDiskGB,
    };
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private sanitizeAzureName(value: string, fallback: string, maxLength: number): string {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    const candidate = cleaned.length > 0 ? cleaned : fallback.toLowerCase();
    return candidate.slice(0, maxLength);
  }

  private buildAzureStorageAccountName(resourceGroup: string, subscriptionId: string): string {
    const seed = `${resourceGroup}:${subscriptionId}`;
    const suffix = createHash("sha1").update(seed).digest("hex").slice(0, 18);
    return `vclawmig${suffix}`.slice(0, 24);
  }

  private detectAzureOsType(guestOS: string): "Linux" | "Windows" {
    return guestOS.toLowerCase().includes("win") ? "Windows" : "Linux";
  }

  private async resolveAzureSubnetId(resourceGroup: string): Promise<string> {
    if (!this.config.azureClient) {
      throw new Error("Azure not configured");
    }

    const vnets = await this.config.azureClient.listVNets(resourceGroup);
    for (const vnet of vnets) {
      if (!vnet.name) continue;
      const subnets = await this.config.azureClient.listSubnets(resourceGroup, vnet.name);
      const subnetWithId = subnets.find((subnet) => Boolean(subnet.id));
      if (subnetWithId?.id) {
        return subnetWithId.id;
      }
    }

    throw new Error(
      `No subnet found in resource group '${resourceGroup}'. ` +
      "Provide subnet_id explicitly or create a VNet/subnet in the target resource group.",
    );
  }

  private async uploadDiskToAzurePageBlob(
    host: string,
    user: string,
    sourcePath: string,
    destinationUrlWithSas: string,
    diskSizeBytes: number,
  ): Promise<void> {
    await uploadDiskFromSSHToAzurePageBlob({
      sourceHost: host,
      sourceUser: user,
      sourcePath,
      destinationUrlWithSas,
      diskSizeBytes,
    });
  }

  private mapVMwareInfoToVMConfig(vmInfo: any): {
    name: string;
    cpuCount: number;
    coresPerSocket: number;
    memoryMiB: number;
    guestOS: string;
    disks: Array<{ label: string; capacityBytes: number; sourcePath: string; sourceFormat: "vmdk"; targetFormat: "vmdk" }>;
    nics: Array<{ label: string; macAddress: string; networkName: string; adapterType: string }>;
    firmware: "bios" | "efi";
  } {
    return {
      name: vmInfo.name,
      cpuCount: vmInfo.cpu.count,
      coresPerSocket: vmInfo.cpu.cores_per_socket,
      memoryMiB: vmInfo.memory.size_MiB,
      guestOS: vmInfo.guest_OS,
      disks: Object.values(vmInfo.disks ?? {}).map((d: any) => ({
        label: d.label || "disk",
        capacityBytes: d.capacity || 0,
        sourcePath: "",
        sourceFormat: "vmdk" as const,
        targetFormat: "vmdk" as const,
      })),
      nics: Object.values(vmInfo.nics ?? {}).map((n: any) => ({
        label: n.label || "nic",
        macAddress: n.mac_address || "",
        networkName: n.backing?.network_name || "",
        adapterType: n.type || "vmxnet3",
      })),
      firmware: (vmInfo.boot?.type === "EFI" ? "efi" : "bios") as "efi" | "bios",
    };
  }

  private mapAWSInstanceToVMConfig(
    name: string,
    instanceType: string,
    totalDiskGB: number,
    platform?: string,
  ): {
    name: string;
    cpuCount: number;
    coresPerSocket: number;
    memoryMiB: number;
    guestOS: string;
    disks: Array<{ label: string; capacityBytes: number; sourcePath: string; sourceFormat: "vmdk"; targetFormat: "vmdk" }>;
    nics: Array<{ label: string; macAddress: string; networkName: string; adapterType: string }>;
    firmware: "bios" | "efi";
  } {
    const analysis = WorkloadAnalyzer.analyzeAWSForVMware(
      instanceType,
      [{ sizeGB: totalDiskGB }],
      platform,
    );
    return {
      name,
      cpuCount: analysis.target.recommended.cpuCount ?? 2,
      coresPerSocket: 1,
      memoryMiB: analysis.target.recommended.memoryMiB ?? 4096,
      guestOS: analysis.target.recommended.guestOS ?? "otherLinux64Guest",
      disks: [{
        label: "root",
        capacityBytes: Math.max(1, totalDiskGB) * 1024 * 1024 * 1024,
        sourcePath: "",
        sourceFormat: "vmdk" as const,
        targetFormat: "vmdk" as const,
      }],
      nics: [{
        label: "eth0",
        macAddress: "",
        networkName: "default",
        adapterType: "virtio",
      }],
      firmware: "bios" as const,
    };
  }

  private async executeAnalyzeWorkload(params: Record<string, unknown>): Promise<ToolCallResult> {
    const sourceProvider = params.source_provider as string;
    const vmId = params.vm_id as string;
    const targetProvider = params.target_provider as string;

    if (!sourceProvider || !vmId || !targetProvider) {
      return { success: false, error: "source_provider, vm_id, and target_provider are all required" };
    }

    try {
      if (sourceProvider === "vmware" && targetProvider === "aws") {
        // Get VM config from VMware
        const vmInfo = await this.config.vsphereClient.getVM(vmId);
        const vmConfig = {
          name: vmInfo.name,
          cpuCount: vmInfo.cpu.count,
          coresPerSocket: vmInfo.cpu.cores_per_socket,
          memoryMiB: vmInfo.memory.size_MiB,
          guestOS: vmInfo.guest_OS,
          disks: Object.values(vmInfo.disks ?? {}).map((d: any) => ({
            label: d.label || "disk",
            capacityBytes: (d.capacity || 0),
            sourcePath: "",
            sourceFormat: "vmdk" as const,
            targetFormat: "vmdk" as const,
          })),
          nics: Object.values(vmInfo.nics ?? {}).map((n: any) => ({
            label: n.label || "nic",
            macAddress: n.mac_address || "",
            networkName: n.backing?.network_name || "",
            adapterType: n.type || "vmxnet3",
          })),
          firmware: (vmInfo.boot?.type === "EFI" ? "efi" : "bios") as "efi" | "bios",
        };
        const analysis = WorkloadAnalyzer.analyzeVMwareForAWS(vmConfig);
        return { success: true, data: analysis };
      }

      if (sourceProvider === "proxmox" && targetProvider === "aws") {
        const proxmoxUser = this.config.proxmoxUser ?? "root";
        const { ProxmoxExporter } = await import("./proxmox-exporter.js");
        const exporter = new ProxmoxExporter(this.config.proxmoxClient, this.config.sshExec);
        const exportResult = await exporter.exportVM(
          this.config.proxmoxNode, Number(vmId), this.config.proxmoxHost, proxmoxUser
        );
        const analysis = WorkloadAnalyzer.analyzeVMwareForAWS(exportResult.vmConfig);
        return { success: true, data: analysis };
      }

      if (sourceProvider === "aws" && (targetProvider === "vmware" || targetProvider === "proxmox")) {
        if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
        const instance = await this.config.awsClient.getInstance(vmId);
        // Look up actual volume sizes from EBS
        const volumeIds = instance.blockDeviceMappings
          ?.map(b => b.ebs?.volumeId)
          .filter((v): v is string => !!v) ?? [];
        const volumes = volumeIds.length > 0 ? await this.config.awsClient.listVolumes() : [];
        const volumeMap = new Map(volumes.map(v => [v.volumeId, v.size]));
        const ebsVolumes = instance.blockDeviceMappings?.map(b => ({
          sizeGB: (b.ebs?.volumeId ? volumeMap.get(b.ebs.volumeId) : undefined) ?? 8,
        })) ?? [{ sizeGB: 8 }];
        const analysis = WorkloadAnalyzer.analyzeAWSForVMware(
          instance.instanceType, ebsVolumes, instance.platform,
        );
        return { success: true, data: analysis };
      }

      return { success: false, error: `Unsupported migration path: ${sourceProvider} -> ${targetProvider}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private createOrchestrator(overrides: Partial<MigrationAdapterConfig> = {}): MigrationOrchestrator {
    return new MigrationOrchestrator({
      vsphereClient: this.config.vsphereClient,
      proxmoxClient: this.config.proxmoxClient,
      sshExec: this.config.sshExec,
      esxiHost: overrides.esxiHost ?? this.config.esxiHost,
      esxiUser: overrides.esxiUser ?? this.config.esxiUser,
      proxmoxHost: overrides.proxmoxHost ?? this.config.proxmoxHost,
      proxmoxUser: overrides.proxmoxUser ?? this.config.proxmoxUser,
      proxmoxNode: overrides.proxmoxNode ?? this.config.proxmoxNode,
      proxmoxStorage: overrides.proxmoxStorage ?? this.config.proxmoxStorage,
    });
  }
}
