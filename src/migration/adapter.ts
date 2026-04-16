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
import type { SSHExecFn } from "./types.js";
import { MigrationOrchestrator } from "./orchestrator.js";
import { WorkloadAnalyzer } from "./workload-analyzer.js";
import { AWSExporter } from "./aws-exporter.js";
import { AWSImporter } from "./aws-importer.js";

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
          name: "migrate_vmware_to_aws",
          description:
            "Migrate a VM from VMware vSphere to AWS EC2. " +
            "Exports the VM, converts disk to VMDK, uploads to S3, " +
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
      case "migrate_vmware_to_aws":
        return this.executeVMwareToAWS(params);
      case "migrate_aws_to_vmware":
        return this.executeAWSToVMware(params);
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

  private async executeVMwareToAWS(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };
    if (!this.config.awsClient) return { success: false, error: "AWS not configured" };
    if (!this.config.awsS3Bucket) return { success: false, error: "AWS S3 migration bucket not configured" };

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

      // Power off source VM
      try { await this.config.vsphereClient.vmPowerOff(vmId); } catch { /* may already be off */ }
      await new Promise(r => setTimeout(r, 3000));

      // Transfer disk to staging host (Proxmox)
      const vmdkFsPath = exporter.datastorePathToFs(exportResult.vmConfig.disks[0].sourcePath);
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
        this.config.sshExec,
      );

      const importResult = await importer.importVM(
        {
          vmConfig: exportResult.vmConfig,
          diskPath: stagedVmdk,
          diskFormat: "vmdk",
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
    const instanceId = params.instance_id as string;
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

      if (sourceProvider === "aws" && targetProvider === "vmware") {
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
