import { afterEach, describe, expect, it, vi } from "vitest";
import { MigrationAdapter } from "../../src/migration/adapter.js";
import type { MigrationAdapterConfig } from "../../src/migration/adapter.js";
import type { ToolCallResult } from "../../src/providers/types.js";

const vmwareExporterMocks = vi.hoisted(() => ({
  exportVM: vi.fn(),
  datastorePathToFs: vi.fn(),
  transferDisk: vi.fn(),
}));

const proxmoxExporterMocks = vi.hoisted(() => ({
  exportVM: vi.fn(),
}));

const awsExporterMocks = vi.hoisted(() => ({
  exportInstance: vi.fn(),
}));

const cloudUploaderMocks = vi.hoisted(() => ({
  uploadDiskFromSSHToAzurePageBlob: vi.fn(async () => undefined),
}));

const blobStorageMocks = vi.hoisted(() => ({
  createIfNotExists: vi.fn(),
  getPageBlobClient: vi.fn(),
  deleteIfExists: vi.fn(),
  fromConnectionString: vi.fn(),
  parsePermissions: vi.fn(),
  generateSas: vi.fn(),
}));

vi.mock("../../src/migration/vmware-exporter.js", () => {
  class VMwareExporter {
    exportVM = vmwareExporterMocks.exportVM;
    datastorePathToFs = vmwareExporterMocks.datastorePathToFs;
    transferDisk = vmwareExporterMocks.transferDisk;
  }
  return { VMwareExporter };
});

vi.mock("../../src/migration/proxmox-exporter.js", () => {
  class ProxmoxExporter {
    exportVM = proxmoxExporterMocks.exportVM;
  }
  return { ProxmoxExporter };
});

vi.mock("../../src/migration/aws-exporter.js", () => {
  class AWSExporter {
    exportInstance = awsExporterMocks.exportInstance;
  }
  return { AWSExporter };
});

vi.mock("../../src/migration/cloud-uploader.js", () => ({
  uploadDiskFromSSHToAzurePageBlob: cloudUploaderMocks.uploadDiskFromSSHToAzurePageBlob,
}));

vi.mock("@azure/storage-blob", () => {
  class StorageSharedKeyCredential {
    constructor(_accountName: string, _accountKey: string) {}
  }

  const pageBlobClient = {
    url: "https://vclawmig.blob.core.windows.net/vhds/migration-disk.vhd",
    deleteIfExists: blobStorageMocks.deleteIfExists,
  };

  const containerClient = {
    createIfNotExists: blobStorageMocks.createIfNotExists,
    getPageBlobClient: blobStorageMocks.getPageBlobClient,
  };

  blobStorageMocks.getPageBlobClient.mockReturnValue(pageBlobClient);

  const blobServiceClient = {
    getContainerClient: vi.fn(() => containerClient),
  };

  blobStorageMocks.fromConnectionString.mockReturnValue(blobServiceClient);
  blobStorageMocks.parsePermissions.mockReturnValue("cw");
  blobStorageMocks.generateSas.mockReturnValue({
    toString: () => "sv=2024-01-01&sig=mock",
  });

  return {
    BlobServiceClient: {
      fromConnectionString: blobStorageMocks.fromConnectionString,
    },
    BlobSASPermissions: {
      parse: blobStorageMocks.parsePermissions,
    },
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters: blobStorageMocks.generateSas,
  };
});

function createAdapter(overrides: Partial<MigrationAdapterConfig> = {}): MigrationAdapter {
  const config: MigrationAdapterConfig = {
    vsphereClient: {} as any,
    proxmoxClient: {} as any,
    sshExec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    esxiHost: "192.168.86.46",
    proxmoxHost: "192.168.86.50",
    proxmoxNode: "pranavlab",
    awsClient: {} as any,
    azureClient: { defaultLocation: "eastus" } as any,
    ...overrides,
  };
  return new MigrationAdapter(config);
}

describe("MigrationAdapter Azure direction routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vmwareExporterMocks.exportVM.mockReset();
    vmwareExporterMocks.datastorePathToFs.mockReset();
    vmwareExporterMocks.transferDisk.mockReset();
    proxmoxExporterMocks.exportVM.mockReset();
    awsExporterMocks.exportInstance.mockReset();
    cloudUploaderMocks.uploadDiskFromSSHToAzurePageBlob.mockReset();
    blobStorageMocks.createIfNotExists.mockReset();
    blobStorageMocks.getPageBlobClient.mockReset();
    blobStorageMocks.deleteIfExists.mockReset();
    blobStorageMocks.fromConnectionString.mockReset();
    blobStorageMocks.parsePermissions.mockReset();
    blobStorageMocks.generateSas.mockReset();
  });

  const routeCases: Array<{
    tool: string;
    method:
      | "executePlanVMwareToAzure"
      | "executePlanAzureToVMware"
      | "executePlanProxmoxToAzure"
      | "executePlanAzureToProxmox"
      | "executePlanAWSToAzure"
      | "executePlanAzureToAWS"
      | "executeVMwareToAzure"
      | "executeAzureToVMware"
      | "executeProxmoxToAzure"
      | "executeAzureToProxmox"
      | "executeAWSToAzure"
      | "executeAzureToAWS";
    params: Record<string, unknown>;
  }> = [
    { tool: "plan_migration_vmware_to_azure", method: "executePlanVMwareToAzure", params: { vm_id: "vm-100" } },
    { tool: "plan_migration_azure_to_vmware", method: "executePlanAzureToVMware", params: { vm_id: "rg/vm-1" } },
    { tool: "plan_migration_proxmox_to_azure", method: "executePlanProxmoxToAzure", params: { vm_id: 112 } },
    { tool: "plan_migration_azure_to_proxmox", method: "executePlanAzureToProxmox", params: { vm_id: "rg/vm-1" } },
    { tool: "plan_migration_aws_to_azure", method: "executePlanAWSToAzure", params: { instance_id: "i-0123" } },
    { tool: "plan_migration_azure_to_aws", method: "executePlanAzureToAWS", params: { vm_id: "rg/vm-1" } },
    { tool: "migrate_vmware_to_azure", method: "executeVMwareToAzure", params: { vm_id: "vm-100" } },
    { tool: "migrate_azure_to_vmware", method: "executeAzureToVMware", params: { vm_id: "rg/vm-1" } },
    { tool: "migrate_proxmox_to_azure", method: "executeProxmoxToAzure", params: { vm_id: 112 } },
    { tool: "migrate_azure_to_proxmox", method: "executeAzureToProxmox", params: { vm_id: "rg/vm-1" } },
    { tool: "migrate_aws_to_azure", method: "executeAWSToAzure", params: { instance_id: "i-0123" } },
    { tool: "migrate_azure_to_aws", method: "executeAzureToAWS", params: { vm_id: "rg/vm-1" } },
  ];

  it.each(routeCases)("dispatches $tool to $method", async ({ tool, method, params }) => {
    const adapter = createAdapter();
    const expected: ToolCallResult = { success: true, data: { tool, dispatched: true } };
    const spy = vi.spyOn(adapter as any, method).mockResolvedValue(expected);

    const result = await adapter.execute(tool, params);

    expect(spy).toHaveBeenCalledWith(params);
    expect(result).toEqual(expected);
  });

  it("returns Azure plan analysis with recommended pricing, alternatives, and storage breakdown", async () => {
    proxmoxExporterMocks.exportVM.mockResolvedValue({
      vmConfig: {
        name: "proxmox-112",
        cpuCount: 2,
        coresPerSocket: 1,
        memoryMiB: 4096,
        guestOS: "otherLinux64Guest",
        disks: [
          {
            label: "scsi0",
            capacityBytes: 40 * 1024 * 1024 * 1024,
            sourcePath: "/var/lib/vz/images/112/vm-112-disk-0.qcow2",
            sourceFormat: "qcow2",
            targetFormat: "raw",
          },
        ],
        nics: [],
        firmware: "bios",
      },
      node: "pranavlab",
      diskDevicePaths: ["/var/lib/vz/images/112/vm-112-disk-0.qcow2"],
    });

    const adapter = createAdapter();
    const result = await adapter.execute("plan_migration_proxmox_to_azure", { vm_id: 112 });

    expect(result.success, String(result.error)).toBe(true);
    const data = result.data as {
      analysis: {
        target: {
          recommended: {
            vmSize: string;
            diskSku: string;
            estimatedMonthlyCost: number;
          };
          alternatives: Array<unknown>;
        };
        storage: {
          currentGB: number;
          estimatedMonthlyCost: number;
        };
      };
    };
    const analysis = data.analysis;
    expect(analysis.target.recommended.vmSize).toBeTruthy();
    expect(analysis.target.recommended.diskSku).toMatch(/_LRS$/);
    expect(analysis.target.recommended.estimatedMonthlyCost).toBeGreaterThan(0);
    expect(analysis.target.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(analysis.storage.currentGB).toBe(40);
    expect(analysis.storage.estimatedMonthlyCost).toBeGreaterThan(0);
  });

  it("returns deterministic validation error for vmware_to_aws execute when source VM has no disks", async () => {
    const vmPowerOff = vi.fn(async () => undefined);
    const sshExec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const adapter = createAdapter({
      awsS3Bucket: "vclaw-test-migration",
      vsphereClient: { vmPowerOff } as any,
      sshExec: sshExec as any,
    });

    vmwareExporterMocks.exportVM.mockResolvedValueOnce({
      vmConfig: {
        name: "vm-no-disk",
        cpuCount: 2,
        coresPerSocket: 1,
        memoryMiB: 2048,
        guestOS: "otherLinux64Guest",
        disks: [],
        nics: [],
        firmware: "bios",
      },
      esxiHost: "192.168.86.46",
      datastorePath: "/vmfs/volumes/datastore1",
    });

    const result = await adapter.execute("migrate_vmware_to_aws", { vm_id: "vm-54" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Source VM has no attached disks. Nothing to migrate.");
    expect(vmPowerOff).not.toHaveBeenCalled();
    expect(vmwareExporterMocks.datastorePathToFs).not.toHaveBeenCalled();
    expect(vmwareExporterMocks.transferDisk).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("returns all Azure migration directions in getTools()", () => {
    const adapter = createAdapter();
    const toolNames = new Set(adapter.getTools().map((tool) => tool.name));

    expect(toolNames.has("plan_migration_vmware_to_azure")).toBe(true);
    expect(toolNames.has("plan_migration_azure_to_vmware")).toBe(true);
    expect(toolNames.has("plan_migration_proxmox_to_azure")).toBe(true);
    expect(toolNames.has("plan_migration_azure_to_proxmox")).toBe(true);
    expect(toolNames.has("plan_migration_aws_to_azure")).toBe(true);
    expect(toolNames.has("plan_migration_azure_to_aws")).toBe(true);
    expect(toolNames.has("migrate_vmware_to_azure")).toBe(true);
    expect(toolNames.has("migrate_azure_to_vmware")).toBe(true);
    expect(toolNames.has("migrate_proxmox_to_azure")).toBe(true);
    expect(toolNames.has("migrate_azure_to_proxmox")).toBe(true);
    expect(toolNames.has("migrate_aws_to_azure")).toBe(true);
    expect(toolNames.has("migrate_azure_to_aws")).toBe(true);
  });

  it("surfaces explicit plan-only execution messaging for Azure execute calls", async () => {
    const adapter = createAdapter();
    vi.spyOn(adapter as any, "executePlanAzureToVMware").mockResolvedValue({
      success: true,
      data: { plan: { id: "plan-1", steps: [] } },
    });

    const result = await adapter.execute("migrate_azure_to_vmware", { vm_id: "vclaw-qa/Migration-TestVM" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("has not been implemented yet");
    expect(result.error).toContain("Use the plan endpoint");
  });

  it("executes vmware_to_azure migration with Azure disk import path", async () => {
    const pageBlobClient = {
      url: "https://vclawmig.blob.core.windows.net/vhds/migration-disk.vhd",
      deleteIfExists: vi.fn(async () => undefined),
    };
    const containerClient = {
      createIfNotExists: vi.fn(async () => undefined),
      getPageBlobClient: vi.fn(() => pageBlobClient),
    };
    blobStorageMocks.getPageBlobClient.mockReturnValue(pageBlobClient);
    blobStorageMocks.fromConnectionString.mockReturnValue({
      getContainerClient: vi.fn(() => containerClient),
    });
    blobStorageMocks.parsePermissions.mockReturnValue("cw");
    blobStorageMocks.generateSas.mockReturnValue({ toString: () => "sv=2024-01-01&sig=mock" });

    const sshExec = vi.fn(async (_host: string, _user: string, cmd: string) => {
      if (cmd.includes("stat -c%s")) {
        return { stdout: "1073741824\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    vmwareExporterMocks.exportVM.mockResolvedValue({
      vmConfig: {
        name: "vmware-200",
        cpuCount: 2,
        coresPerSocket: 1,
        memoryMiB: 4096,
        guestOS: "otherLinux64Guest",
        disks: [
          {
            label: "scsi0",
            capacityBytes: 20 * 1024 * 1024 * 1024,
            sourcePath: "[datastore1] vmware-200/vmware-200.vmdk",
            sourceFormat: "vmdk",
            targetFormat: "qcow2",
          },
        ],
        nics: [],
        firmware: "bios",
      },
      esxiHost: "192.168.86.46",
      datastorePath: "/vmfs/volumes/datastore1",
    });
    vmwareExporterMocks.datastorePathToFs.mockReturnValue("/vmfs/volumes/datastore1/vmware-200/vmware-200.vmdk");
    vmwareExporterMocks.transferDisk.mockResolvedValue("/tmp/vclaw-migration/vmware-azure-123456/disk.vmdk");

    const azureClient = {
      defaultLocation: "eastus",
      subscriptionId: "sub-1234",
      ensureResourceGroup: vi.fn(async () => undefined),
      ensureStorageAccount: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Storage/storageAccounts/vclawmigabc123",
        name: "vclawmigabc123",
        location: "eastus",
      })),
      ensureBlobContainer: vi.fn(async () => undefined),
      getStorageAccountKey: vi.fn(async () => "storage-account-key"),
      createManagedDiskFromImport: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Compute/disks/vmware-200-osdisk",
        name: "vmware-200-osdisk",
        resourceGroup: "vclaw-migrations",
        location: "eastus",
        sizeGB: 20,
        diskState: "Unattached",
        encrypted: false,
      })),
      listVNets: vi.fn(async () => [
        { id: "vnet-1", name: "default-vnet", resourceGroup: "vclaw-migrations", location: "eastus", addressSpaces: ["10.0.0.0/16"], subnetCount: 1 },
      ]),
      listSubnets: vi.fn(async () => [
        { id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Network/virtualNetworks/default-vnet/subnets/default", name: "default", resourceGroup: "vclaw-migrations", vnetName: "default-vnet", addressPrefix: "10.0.0.0/24" },
      ]),
      createVMFromManagedDisk: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Compute/virtualMachines/vmware-200",
        name: "vmware-200",
        resourceGroup: "vclaw-migrations",
        location: "eastus",
        vmSize: "Standard_B2s",
        powerState: "unknown",
        provisioningState: "Succeeded",
        osType: "Linux",
      })),
      deleteVM: vi.fn(async () => undefined),
      deleteDisk: vi.fn(async () => undefined),
    } as any;

    const vmPowerOff = vi.fn(async () => undefined);
    const adapter = createAdapter({
      vsphereClient: { vmPowerOff } as any,
      sshExec: sshExec as any,
      azureClient,
    });

    const result = await adapter.execute("migrate_vmware_to_azure", { vm_id: "vm-200" });

    expect(result.success, String(result.error)).toBe(true);
    expect(vmPowerOff).toHaveBeenCalledWith("vm-200");
    expect(vmwareExporterMocks.datastorePathToFs).toHaveBeenCalledWith("[datastore1] vmware-200/vmware-200.vmdk");
    expect(vmwareExporterMocks.transferDisk).toHaveBeenCalledWith(
      "192.168.86.46",
      "root",
      "/vmfs/volumes/datastore1/vmware-200/vmware-200.vmdk",
      "192.168.86.50",
      "root",
      expect.stringContaining("/tmp/vclaw-migration/vmware-azure-"),
      7_200_000,
    );
    expect(cloudUploaderMocks.uploadDiskFromSSHToAzurePageBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHost: "192.168.86.50",
        sourceUser: "root",
        sourcePath: expect.stringContaining("/tmp/vclaw-migration/vmware-azure-"),
        destinationUrlWithSas: expect.stringContaining("https://vclawmig.blob.core.windows.net"),
        diskSizeBytes: 1073741824,
      }),
    );
    expect(azureClient.createManagedDiskFromImport).toHaveBeenCalled();
    expect(azureClient.createVMFromManagedDisk).toHaveBeenCalled();
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "completed",
        source: expect.objectContaining({ provider: "vmware", vmId: "vm-200" }),
        target: expect.objectContaining({ provider: "azure", resourceGroup: "vclaw-migrations" }),
      }),
    );
  });

  it("executes aws_to_azure migration with Azure disk import path", async () => {
    const pageBlobClient = {
      url: "https://vclawmig.blob.core.windows.net/vhds/migration-disk.vhd",
      deleteIfExists: vi.fn(async () => undefined),
    };
    const containerClient = {
      createIfNotExists: vi.fn(async () => undefined),
      getPageBlobClient: vi.fn(() => pageBlobClient),
    };
    blobStorageMocks.getPageBlobClient.mockReturnValue(pageBlobClient);
    blobStorageMocks.fromConnectionString.mockReturnValue({
      getContainerClient: vi.fn(() => containerClient),
    });
    blobStorageMocks.parsePermissions.mockReturnValue("cw");
    blobStorageMocks.generateSas.mockReturnValue({ toString: () => "sv=2024-01-01&sig=mock" });

    const sshExec = vi.fn(async (_host: string, _user: string, cmd: string) => {
      if (cmd.includes("stat -c%s")) {
        return { stdout: "1073741824\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    awsExporterMocks.exportInstance.mockResolvedValue({
      instanceId: "i-0123",
      amiId: "ami-0123",
      s3Bucket: "vclaw-migration",
      s3Key: "vclaw-migration/i-0123/disk.vmdk",
      vmConfig: {
        name: "aws-i-0123",
        cpuCount: 2,
        coresPerSocket: 1,
        memoryMiB: 4096,
        guestOS: "otherLinux64Guest",
        disks: [
          {
            label: "/dev/sda1",
            capacityBytes: 20 * 1024 * 1024 * 1024,
            sourcePath: "ebs://vol-0123",
            sourceFormat: "raw",
            targetFormat: "vmdk",
          },
        ],
        nics: [],
        firmware: "bios",
      },
    });

    const azureClient = {
      defaultLocation: "eastus",
      subscriptionId: "sub-1234",
      ensureResourceGroup: vi.fn(async () => undefined),
      ensureStorageAccount: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Storage/storageAccounts/vclawmigabc123",
        name: "vclawmigabc123",
        location: "eastus",
      })),
      ensureBlobContainer: vi.fn(async () => undefined),
      getStorageAccountKey: vi.fn(async () => "storage-account-key"),
      createManagedDiskFromImport: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Compute/disks/aws-i-0123-osdisk",
        name: "aws-i-0123-osdisk",
        resourceGroup: "vclaw-migrations",
        location: "eastus",
        sizeGB: 20,
        diskState: "Unattached",
        encrypted: false,
      })),
      listVNets: vi.fn(async () => [
        { id: "vnet-1", name: "default-vnet", resourceGroup: "vclaw-migrations", location: "eastus", addressSpaces: ["10.0.0.0/16"], subnetCount: 1 },
      ]),
      listSubnets: vi.fn(async () => [
        { id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Network/virtualNetworks/default-vnet/subnets/default", name: "default", resourceGroup: "vclaw-migrations", vnetName: "default-vnet", addressPrefix: "10.0.0.0/24" },
      ]),
      createVMFromManagedDisk: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Compute/virtualMachines/aws-i-0123",
        name: "aws-i-0123",
        resourceGroup: "vclaw-migrations",
        location: "eastus",
        vmSize: "Standard_B2s",
        powerState: "unknown",
        provisioningState: "Succeeded",
        osType: "Linux",
      })),
      deleteVM: vi.fn(async () => undefined),
      deleteDisk: vi.fn(async () => undefined),
    } as any;

    const adapter = createAdapter({
      awsClient: {} as any,
      awsS3Bucket: "vclaw-migration",
      awsS3Prefix: "vclaw-migration/",
      sshExec: sshExec as any,
      azureClient,
    });

    const result = await adapter.execute("migrate_aws_to_azure", { instance_id: "i-0123" });

    expect(result.success, String(result.error)).toBe(true);
    expect(awsExporterMocks.exportInstance).toHaveBeenCalledWith("i-0123");
    expect(sshExec).toHaveBeenCalledWith(
      "192.168.86.50",
      "root",
      expect.stringContaining("aws s3 cp s3://vclaw-migration/vclaw-migration/i-0123/disk.vmdk"),
      7_200_000,
    );
    expect(cloudUploaderMocks.uploadDiskFromSSHToAzurePageBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHost: "192.168.86.50",
        sourceUser: "root",
        sourcePath: expect.stringContaining("/tmp/vclaw-migration/aws-azure-"),
        destinationUrlWithSas: expect.stringContaining("https://vclawmig.blob.core.windows.net"),
        diskSizeBytes: 1073741824,
      }),
    );
    expect(azureClient.createManagedDiskFromImport).toHaveBeenCalled();
    expect(azureClient.createVMFromManagedDisk).toHaveBeenCalled();
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "completed",
        source: expect.objectContaining({ provider: "aws", instanceId: "i-0123" }),
        target: expect.objectContaining({ provider: "azure", resourceGroup: "vclaw-migrations" }),
      }),
    );
  });

  it("executes proxmox_to_azure migration with Azure disk import path", async () => {
    const pageBlobClient = {
      url: "https://vclawmig.blob.core.windows.net/vhds/migration-disk.vhd",
      deleteIfExists: vi.fn(async () => undefined),
    };
    const containerClient = {
      createIfNotExists: vi.fn(async () => undefined),
      getPageBlobClient: vi.fn(() => pageBlobClient),
    };
    blobStorageMocks.getPageBlobClient.mockReturnValue(pageBlobClient);
    blobStorageMocks.fromConnectionString.mockReturnValue({
      getContainerClient: vi.fn(() => containerClient),
    });
    blobStorageMocks.parsePermissions.mockReturnValue("cw");
    blobStorageMocks.generateSas.mockReturnValue({ toString: () => "sv=2024-01-01&sig=mock" });

    const sshExec = vi.fn(async (_host: string, _user: string, cmd: string) => {
      if (cmd.includes("stat -c%s")) {
        return { stdout: "1073741824\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("command -v azcopy")) {
        return { stdout: "/usr/bin/azcopy\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    proxmoxExporterMocks.exportVM.mockResolvedValue({
      vmConfig: {
        name: "proxmox-112",
        cpuCount: 2,
        coresPerSocket: 1,
        memoryMiB: 4096,
        guestOS: "otherLinux64Guest",
        disks: [
          {
            label: "scsi0",
            capacityBytes: 20 * 1024 * 1024 * 1024,
            sourcePath: "/var/lib/vz/images/112/vm-112-disk-0.qcow2",
            sourceFormat: "qcow2",
            targetFormat: "raw",
          },
        ],
        nics: [],
        firmware: "bios",
      },
      node: "pranavlab",
      diskDevicePaths: ["/var/lib/vz/images/112/vm-112-disk-0.qcow2"],
    });

    const azureClient = {
      defaultLocation: "eastus",
      subscriptionId: "sub-1234",
      ensureResourceGroup: vi.fn(async () => undefined),
      ensureStorageAccount: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Storage/storageAccounts/vclawmigabc123",
        name: "vclawmigabc123",
        location: "eastus",
      })),
      ensureBlobContainer: vi.fn(async () => undefined),
      getStorageAccountKey: vi.fn(async () => "storage-account-key"),
      createManagedDiskFromImport: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Compute/disks/proxmox-112-osdisk",
        name: "proxmox-112-osdisk",
        resourceGroup: "vclaw-migrations",
        location: "eastus",
        sizeGB: 20,
        diskState: "Unattached",
        encrypted: false,
      })),
      listVNets: vi.fn(async () => [
        { id: "vnet-1", name: "default-vnet", resourceGroup: "vclaw-migrations", location: "eastus", addressSpaces: ["10.0.0.0/16"], subnetCount: 1 },
      ]),
      listSubnets: vi.fn(async () => [
        { id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Network/virtualNetworks/default-vnet/subnets/default", name: "default", resourceGroup: "vclaw-migrations", vnetName: "default-vnet", addressPrefix: "10.0.0.0/24" },
      ]),
      createVMFromManagedDisk: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-migrations/providers/Microsoft.Compute/virtualMachines/proxmox-112",
        name: "proxmox-112",
        resourceGroup: "vclaw-migrations",
        location: "eastus",
        vmSize: "Standard_B2s",
        powerState: "unknown",
        provisioningState: "Succeeded",
        osType: "Linux",
      })),
      deleteVM: vi.fn(async () => undefined),
      deleteDisk: vi.fn(async () => undefined),
    } as any;

    const stopVM = vi.fn(async () => undefined);
    const adapter = createAdapter({
      proxmoxClient: { stopVM } as any,
      sshExec: sshExec as any,
      azureClient,
    });

    const result = await adapter.execute("migrate_proxmox_to_azure", { vm_id: 112 });

    expect(result.success, String(result.error)).toBe(true);
    expect(stopVM).toHaveBeenCalledWith("pranavlab", 112);
    expect(cloudUploaderMocks.uploadDiskFromSSHToAzurePageBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHost: "192.168.86.50",
        sourceUser: "root",
        sourcePath: expect.stringContaining("/tmp/vclaw-migration/pve-azure-"),
        destinationUrlWithSas: expect.stringContaining("https://vclawmig.blob.core.windows.net"),
        diskSizeBytes: 1073741824,
      }),
    );
    expect(azureClient.createManagedDiskFromImport).toHaveBeenCalled();
    expect(azureClient.createVMFromManagedDisk).toHaveBeenCalled();
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "completed",
        source: expect.objectContaining({ provider: "proxmox", vmId: "112" }),
        target: expect.objectContaining({ provider: "azure", resourceGroup: "vclaw-migrations" }),
      }),
    );
  });

  it("executes azure_to_proxmox migration with snapshot SAS export path", async () => {
    const vmArmId = "/subscriptions/sub-1234/resourceGroups/vclaw-qa/providers/Microsoft.Compute/virtualMachines/Migration-TestVM";
    const diskArmId = "/subscriptions/sub-1234/resourceGroups/vclaw-disks/providers/Microsoft.Compute/disks/migration-testvm-osdisk";

    const sshExec = vi.fn(async (_host: string, _user: string, cmd: string) => {
      if (cmd.includes("pvesh get /cluster/nextid")) {
        return { stdout: "\"205\"\n", stderr: "", exitCode: 0 };
      }
      if (cmd.startsWith("qm importdisk")) {
        return { stdout: "Successfully imported disk as 'unused0:local-lvm:vm-205-disk-0'\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const azureClient = {
      defaultLocation: "eastus",
      getVM: vi.fn(async () => ({
        id: vmArmId,
        name: "Migration-TestVM",
        resourceGroup: "vclaw-qa",
        location: "eastus",
        vmSize: "Standard_B2s",
        powerState: "running",
        provisioningState: "Succeeded",
        networkInterfaceIds: [],
        osDiskId: diskArmId,
        dataDiskIds: [],
        tags: {},
        osType: "Linux",
      })),
      listDisks: vi.fn(async () => [
        {
          id: diskArmId,
          name: "migration-testvm-osdisk",
          resourceGroup: "vclaw-disks",
          location: "eastus",
          sizeGB: 64,
          diskState: "Attached",
          encrypted: false,
          attachedVmId: vmArmId,
        },
      ]),
      createSnapshot: vi.fn(async () => ({
        id: "/subscriptions/sub-1234/resourceGroups/vclaw-disks/providers/Microsoft.Compute/snapshots/migration-testvm-snap",
        name: "migration-testvm-snap",
        resourceGroup: "vclaw-disks",
        location: "eastus",
        sizeGB: 64,
        sourceDiskId: diskArmId,
        provisioningState: "Succeeded",
        encrypted: false,
      })),
      grantSnapshotReadAccess: vi.fn(async () => "https://storage.example/snap.vhd?sv=mock"),
      revokeSnapshotAccess: vi.fn(async () => undefined),
      deleteSnapshot: vi.fn(async () => undefined),
    } as any;

    const proxmoxClient = {
      createVM: vi.fn(async () => "UPID:create"),
      updateVMConfig: vi.fn(async () => undefined),
      deleteVM: vi.fn(async () => "UPID:delete"),
    } as any;

    const adapter = createAdapter({
      azureClient,
      proxmoxClient,
      sshExec: sshExec as any,
      proxmoxStorage: "local-lvm",
    });

    const result = await adapter.execute("migrate_azure_to_proxmox", { vm_id: "vclaw-qa/Migration-TestVM" });

    expect(result.success, String(result.error)).toBe(true);
    expect(azureClient.createSnapshot).toHaveBeenCalled();
    expect(azureClient.grantSnapshotReadAccess).toHaveBeenCalled();
    expect(azureClient.revokeSnapshotAccess).toHaveBeenCalled();
    expect(azureClient.deleteSnapshot).toHaveBeenCalled();
    expect(sshExec).toHaveBeenCalledWith(
      "192.168.86.50",
      "root",
      expect.stringContaining("curl --fail --location"),
      7_200_000,
    );
    expect(proxmoxClient.createVM).toHaveBeenCalled();
    expect(proxmoxClient.updateVMConfig).toHaveBeenCalled();
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "completed",
        source: expect.objectContaining({ provider: "azure", vmId: "vclaw-qa/Migration-TestVM" }),
        target: expect.objectContaining({ provider: "proxmox", vmId: 205 }),
      }),
    );
  });
});
