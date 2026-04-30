// ============================================================
// vClaw — Azure ARM Adapter
// Implements InfraAdapter and registers Azure Compute + Network tools
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
  NodeInfo,
  VMInfo,
  StorageInfo,
} from "../types.js";

import { AzureClient } from "./client.js";
import type {
  AzureClientConfig,
  AzureVMPowerState,
  AzureVMSizeSpec,
} from "./types.js";

// ── Config ──────────────────────────────────────────────────

export interface AzureAdapterConfig extends AzureClientConfig {}

// ── VM Size Catalog (subset for CPU/RAM mapping) ────────────

const VM_SIZE_CATALOG: AzureVMSizeSpec[] = [
  { name: "Standard_B1s", vCPU: 1, memoryMiB: 1024 },
  { name: "Standard_B1ms", vCPU: 1, memoryMiB: 2048 },
  { name: "Standard_B2s", vCPU: 2, memoryMiB: 4096 },
  { name: "Standard_B2ms", vCPU: 2, memoryMiB: 8192 },
  { name: "Standard_B4ms", vCPU: 4, memoryMiB: 16384 },
  { name: "Standard_D2s_v5", vCPU: 2, memoryMiB: 8192 },
  { name: "Standard_D4s_v5", vCPU: 4, memoryMiB: 16384 },
  { name: "Standard_D8s_v5", vCPU: 8, memoryMiB: 32768 },
  { name: "Standard_D16s_v5", vCPU: 16, memoryMiB: 65536 },
  { name: "Standard_E2s_v5", vCPU: 2, memoryMiB: 16384 },
  { name: "Standard_E4s_v5", vCPU: 4, memoryMiB: 32768 },
  { name: "Standard_F2s_v2", vCPU: 2, memoryMiB: 4096 },
  { name: "Standard_F4s_v2", vCPU: 4, memoryMiB: 8192 },
];

export function lookupVMSize(name: string): AzureVMSizeSpec | null {
  return VM_SIZE_CATALOG.find((s) => s.name === name) ?? null;
}

// ── Tool Definitions ────────────────────────────────────────

const ADAPTER_NAME = "azure";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object",
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

function param(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: unknown,
): ToolDefinition["params"][number] {
  const p: ToolDefinition["params"][number] = { name, type, required, description };
  if (defaultValue !== undefined) p.default = defaultValue;
  return p;
}

const rgParam = param("resource_group", "string", true, "Azure resource group name");
const vmNameParam = param("vm_name", "string", true, "Azure VM name");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Read ──────────────────────────────────────────────────
  tool("azure_list_resource_groups", "List all resource groups in the subscription", "read", [], "AzureResourceGroupInfo[]"),

  tool("azure_list_vms", "List virtual machines, optionally filtered by resource group", "read", [
    param("resource_group", "string", false, "Filter VMs by resource group"),
  ], "AzureVMSummary[]"),

  tool("azure_get_vm", "Get detailed info about a specific VM (includes power state)", "read", [
    rgParam,
    vmNameParam,
  ], "AzureVMDetail"),

  tool("azure_list_disks", "List managed disks, optionally filtered by resource group", "read", [
    param("resource_group", "string", false, "Filter disks by resource group"),
  ], "AzureDiskInfo[]"),

  tool("azure_list_vnets", "List virtual networks, optionally filtered by resource group", "read", [
    param("resource_group", "string", false, "Filter VNets by resource group"),
  ], "AzureVNetInfo[]"),

  tool("azure_list_subnets", "List subnets for a specific virtual network", "read", [
    rgParam,
    param("vnet_name", "string", true, "Virtual network name"),
  ], "AzureSubnetInfo[]"),

  tool("azure_list_nsgs", "List network security groups, optionally filtered by resource group", "read", [
    param("resource_group", "string", false, "Filter NSGs by resource group"),
  ], "AzureNSGInfo[]"),

  tool("azure_list_images", "List managed images, optionally filtered by resource group", "read", [
    param("resource_group", "string", false, "Filter images by resource group"),
  ], "AzureImageInfo[]"),

  // ── Safe Write ────────────────────────────────────────────
  tool("azure_start_vm", "Start a deallocated or stopped VM", "safe_write", [
    rgParam,
    vmNameParam,
  ], "void"),

  tool("azure_create_snapshot", "Create a snapshot from a managed disk", "safe_write", [
    rgParam,
    param("name", "string", true, "Name for the new snapshot"),
    param("source_disk_id", "string", true, "Full ARM id of the source disk"),
    param("location", "string", false, "Azure region (defaults to client default)"),
  ], "AzureSnapshotInfo"),

  tool("azure_create_image", "Capture a managed image from an existing VM", "safe_write", [
    rgParam,
    param("image_name", "string", true, "Name for the new image"),
    param("vm_id", "string", true, "Full ARM id of the source VM"),
    param("location", "string", false, "Azure region (defaults to client default)"),
  ], "string"),

  // ── Risky Write ───────────────────────────────────────────
  tool("azure_stop_vm", "Deallocate a running VM (stops billing for compute)", "risky_write", [
    rgParam,
    vmNameParam,
  ], "void"),

  tool("azure_restart_vm", "Restart a VM", "risky_write", [
    rgParam,
    vmNameParam,
  ], "void"),

  tool("azure_create_vm", "Create a new VM in the given resource group", "risky_write", [
    rgParam,
    param("name", "string", true, "Name for the new VM"),
    param("vm_size", "string", true, "VM size (e.g. Standard_B2s, Standard_D4s_v5)"),
    param("image_publisher", "string", true, "Image publisher (e.g. Canonical)"),
    param("image_offer", "string", true, "Image offer (e.g. 0001-com-ubuntu-server-jammy)"),
    param("image_sku", "string", true, "Image sku (e.g. 22_04-lts-gen2)"),
    param("image_version", "string", false, "Image version (default: latest)"),
    param("subnet_id", "string", true, "Full ARM id of the subnet"),
    param("admin_username", "string", true, "Admin username for the VM"),
    param("admin_password", "string", false, "Admin password (Windows or password auth)"),
    param("ssh_public_key", "string", false, "SSH public key (Linux key auth)"),
    param("os_type", "string", false, "Linux or Windows"),
    param("location", "string", false, "Azure region (defaults to client default)"),
  ], "AzureVMSummary"),

  // ── Destructive ───────────────────────────────────────────
  tool("azure_delete_vm", "Permanently delete a VM (does not delete attached disks)", "destructive", [
    rgParam,
    vmNameParam,
  ], "void"),

  tool("azure_delete_image", "Permanently delete a managed image", "destructive", [
    rgParam,
    param("image_name", "string", true, "Image name to delete"),
  ], "void"),
];

// ── Adapter ─────────────────────────────────────────────────

export class AzureAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  private client: AzureClient;
  private _connected = false;

  constructor(config: AzureAdapterConfig) {
    this.client = new AzureClient(config);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this.client.disconnect();
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    try {
      const data = await this.dispatch(toolName, cleanParams);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatch(
    toolName: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      // ── Read ────────────────────────────────────────────
      case "azure_list_resource_groups":
        return this.client.listResourceGroups();

      case "azure_list_vms":
        return this.client.listVMs(p.resource_group as string | undefined);

      case "azure_get_vm":
        return this.client.getVM(p.resource_group as string, p.vm_name as string);

      case "azure_list_disks":
        return this.client.listDisks(p.resource_group as string | undefined);

      case "azure_list_vnets":
        return this.client.listVNets(p.resource_group as string | undefined);

      case "azure_list_subnets":
        return this.client.listSubnets(p.resource_group as string, p.vnet_name as string);

      case "azure_list_nsgs":
        return this.client.listNSGs(p.resource_group as string | undefined);

      case "azure_list_images":
        return this.client.listImages(p.resource_group as string | undefined);

      // ── Safe Write ──────────────────────────────────────
      case "azure_start_vm":
        return this.client.startVM(p.resource_group as string, p.vm_name as string);

      case "azure_create_snapshot":
        return this.client.createSnapshot({
          resourceGroup: p.resource_group as string,
          name: p.name as string,
          sourceDiskId: p.source_disk_id as string,
          location: p.location as string | undefined,
        });

      case "azure_create_image":
        return this.client.createImageFromVM({
          resourceGroup: p.resource_group as string,
          imageName: p.image_name as string,
          vmId: p.vm_id as string,
          location: p.location as string | undefined,
        });

      // ── Risky Write ─────────────────────────────────────
      case "azure_stop_vm":
        return this.client.deallocateVM(p.resource_group as string, p.vm_name as string);

      case "azure_restart_vm":
        return this.client.restartVM(p.resource_group as string, p.vm_name as string);

      case "azure_create_vm":
        return this.client.createVM({
          resourceGroup: p.resource_group as string,
          name: p.name as string,
          vmSize: p.vm_size as string,
          imageReference: {
            publisher: p.image_publisher as string,
            offer: p.image_offer as string,
            sku: p.image_sku as string,
            version: (p.image_version as string) ?? "latest",
          },
          adminUsername: p.admin_username as string,
          adminPassword: p.admin_password as string | undefined,
          sshPublicKey: p.ssh_public_key as string | undefined,
          subnetId: p.subnet_id as string,
          osType: p.os_type as "Linux" | "Windows" | undefined,
          location: p.location as string | undefined,
        });

      // ── Destructive ─────────────────────────────────────
      case "azure_delete_vm":
        return this.client.deleteVM(p.resource_group as string, p.vm_name as string);

      case "azure_delete_image":
        return this.client.deleteImage(p.resource_group as string, p.image_name as string);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Cluster State ───────────────────────────────────────

  async getClusterState(): Promise<ClusterState> {
    const [vms, disks] = await Promise.all([
      this.client.listVMs(),
      this.client.listDisks(),
    ]);

    // Build a disk lookup keyed by attached VM id
    const disksByVmId = new Map<string, number>();
    for (const disk of disks) {
      if (disk.attachedVmId) {
        disksByVmId.set(disk.attachedVmId, (disksByVmId.get(disk.attachedVmId) ?? 0) + disk.sizeGB);
      }
    }

    // Map VMs to VMInfo
    const mappedVms: VMInfo[] = vms.map((vm) => {
      const spec = lookupVMSize(vm.vmSize);
      return {
        id: vm.id,
        name: vm.name,
        node: vm.location,
        status: this.mapPowerState(vm.powerState),
        cpu_cores: spec?.vCPU ?? 0,
        ram_mb: spec?.memoryMiB ?? 0,
        disk_gb: disksByVmId.get(vm.id) ?? 0,
        ip_address: vm.publicIp ?? vm.privateIp,
        os: vm.osType ?? vm.vmSize,
        instance_type: vm.vmSize,
      };
    });

    // Build a "node" entry per Azure region (like AWS AZs)
    const regionMap = new Map<string, { totalCpu: number; totalRam: number; totalDisk: number; vmCount: number }>();
    for (const vm of mappedVms) {
      const region = vm.node;
      if (!region) continue;
      if (!regionMap.has(region)) {
        regionMap.set(region, { totalCpu: 0, totalRam: 0, totalDisk: 0, vmCount: 0 });
      }
      const entry = regionMap.get(region)!;
      entry.vmCount += 1;
      if (vm.status === "running") {
        entry.totalCpu += vm.cpu_cores;
        entry.totalRam += vm.ram_mb;
      }
      entry.totalDisk += vm.disk_gb;
    }

    // Account for disks that live in regions without a VM
    for (const disk of disks) {
      if (!disk.location) continue;
      if (!regionMap.has(disk.location)) {
        regionMap.set(disk.location, { totalCpu: 0, totalRam: 0, totalDisk: 0, vmCount: 0 });
      }
      if (!disk.attachedVmId) {
        regionMap.get(disk.location)!.totalDisk += disk.sizeGB;
      }
    }

    const nodes: NodeInfo[] = Array.from(regionMap.entries()).map(([region, data]) => ({
      id: region,
      name: region,
      status: "online" as const,
      cpu_cores: data.totalCpu,
      cpu_usage_pct: data.totalCpu > 0 ? 50 : 0,
      ram_total_mb: data.totalRam,
      ram_used_mb: Math.round(data.totalRam * 0.6),
      disk_total_gb: data.totalDisk,
      disk_used_gb: Math.round(data.totalDisk * 0.5),
      disk_usage_pct: data.totalDisk > 0 ? 50 : 0,
      uptime_s: 0,
    }));

    // Map disks to StorageInfo
    const storage: StorageInfo[] = disks.map((disk) => ({
      id: disk.id,
      node: disk.location,
      type: disk.skuName ?? "managed-disk",
      total_gb: disk.sizeGB,
      used_gb: 0,
      available_gb: disk.sizeGB,
      content: disk.attachedVmId ? [disk.attachedVmId] : [],
    }));

    return {
      adapter: ADAPTER_NAME,
      nodes,
      vms: mappedVms,
      containers: [],
      storage,
      timestamp: new Date().toISOString(),
    };
  }

  private mapPowerState(state: AzureVMPowerState): VMInfo["status"] {
    switch (state) {
      case "running":
        return "running";
      case "stopped":
      case "deallocated":
        return "stopped";
      case "starting":
      case "stopping":
      case "deallocating":
        return "unknown";
      default:
        return "unknown";
    }
  }
}
