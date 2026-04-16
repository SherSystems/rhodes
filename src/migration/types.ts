// ============================================================
// vClaw — Cross-Provider Migration Types
// Types for VM migration between infrastructure providers
// ============================================================

export type MigrationStatus =
  | "pending"
  | "exporting"
  | "converting"
  | "importing"
  | "configuring"
  | "completed"
  | "failed";

export type DiskFormat = "vmdk" | "qcow2" | "raw" | "vdi" | "vhdx" | "vhd" | "ova";

export interface MigrationPlan {
  id: string;
  source: {
    provider: "vmware" | "proxmox" | "aws";
    vmId: string;
    vmName: string;
    host: string;
    instanceId?: string; // AWS EC2 instance ID
    amiId?: string; // AWS AMI ID
  };
  target: {
    provider: "vmware" | "proxmox" | "aws";
    node: string;
    host: string;
    storage: string;
    vmId?: number; // Proxmox VMID (assigned during import)
    instanceType?: string; // AWS EC2 instance type
    subnetId?: string; // AWS subnet
    securityGroupIds?: string[]; // AWS security groups
    amiId?: string; // AWS AMI (created during import)
  };
  vmConfig: MigrationVMConfig;
  status: MigrationStatus;
  steps: MigrationStep[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface MigrationVMConfig {
  name: string;
  cpuCount: number;
  coresPerSocket: number;
  memoryMiB: number;
  guestOS: string;
  disks: MigrationDisk[];
  nics: MigrationNic[];
  firmware: "bios" | "efi";
}

export interface MigrationDisk {
  label: string;
  capacityBytes: number;
  sourcePath: string; // e.g. [datastore1] vm/vm.vmdk
  sourceFormat: DiskFormat;
  convertedPath?: string;
  targetFormat: DiskFormat;
}

export interface MigrationNic {
  label: string;
  macAddress: string;
  networkName: string;
  adapterType: string; // vmxnet3, virtio, e1000, etc.
}

export interface MigrationStep {
  name: string;
  status: MigrationStatus;
  detail?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SSHExecFn {
  (host: string, user: string, command: string, timeoutMs?: number): Promise<SSHExecResult>;
}

export interface MigrationProgress {
  plan: MigrationPlan;
  currentStep: string;
  percentage: number;
  message: string;
}
