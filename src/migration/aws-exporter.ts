// ============================================================
// vClaw — AWS EC2 VM Exporter
// Reads EC2 instance configuration and exports disk via
// AMI -> S3 export for import into VMware
// ============================================================

import type { AWSClient } from "../providers/aws/client.js";
import type { EC2InstanceDetail } from "../providers/aws/types.js";
import type { MigrationVMConfig, MigrationDisk, MigrationNic, SSHExecFn } from "./types.js";

// ── Result Interface ────────────────────────────────────────

export interface AWSExportResult {
  vmConfig: MigrationVMConfig;
  instanceId: string;
  amiId: string; // AMI created from the instance
  s3Bucket: string;
  s3Key: string; // where the exported disk landed in S3
}

// ── Instance Type Lookup ────────────────────────────────────

interface InstanceTypeSpec {
  vCPUs: number;
  memoryMiB: number;
}

const INSTANCE_TYPE_MAP: Record<string, InstanceTypeSpec> = {
  // T3 family — burstable
  "t3.nano": { vCPUs: 2, memoryMiB: 512 },
  "t3.micro": { vCPUs: 2, memoryMiB: 1024 },
  "t3.small": { vCPUs: 2, memoryMiB: 2048 },
  "t3.medium": { vCPUs: 2, memoryMiB: 4096 },
  "t3.large": { vCPUs: 2, memoryMiB: 8192 },
  "t3.xlarge": { vCPUs: 4, memoryMiB: 16384 },
  "t3.2xlarge": { vCPUs: 8, memoryMiB: 32768 },

  // T3a family — AMD burstable
  "t3a.nano": { vCPUs: 2, memoryMiB: 512 },
  "t3a.micro": { vCPUs: 2, memoryMiB: 1024 },
  "t3a.small": { vCPUs: 2, memoryMiB: 2048 },
  "t3a.medium": { vCPUs: 2, memoryMiB: 4096 },
  "t3a.large": { vCPUs: 2, memoryMiB: 8192 },
  "t3a.xlarge": { vCPUs: 4, memoryMiB: 16384 },
  "t3a.2xlarge": { vCPUs: 8, memoryMiB: 32768 },

  // M5 family — general purpose
  "m5.large": { vCPUs: 2, memoryMiB: 8192 },
  "m5.xlarge": { vCPUs: 4, memoryMiB: 16384 },
  "m5.2xlarge": { vCPUs: 8, memoryMiB: 32768 },
  "m5.4xlarge": { vCPUs: 16, memoryMiB: 65536 },
  "m5.8xlarge": { vCPUs: 32, memoryMiB: 131072 },
  "m5.12xlarge": { vCPUs: 48, memoryMiB: 196608 },
  "m5.16xlarge": { vCPUs: 64, memoryMiB: 262144 },

  // M6i family — next-gen general purpose
  "m6i.large": { vCPUs: 2, memoryMiB: 8192 },
  "m6i.xlarge": { vCPUs: 4, memoryMiB: 16384 },
  "m6i.2xlarge": { vCPUs: 8, memoryMiB: 32768 },
  "m6i.4xlarge": { vCPUs: 16, memoryMiB: 65536 },

  // C5 family — compute optimized
  "c5.large": { vCPUs: 2, memoryMiB: 4096 },
  "c5.xlarge": { vCPUs: 4, memoryMiB: 8192 },
  "c5.2xlarge": { vCPUs: 8, memoryMiB: 16384 },
  "c5.4xlarge": { vCPUs: 16, memoryMiB: 32768 },
  "c5.9xlarge": { vCPUs: 36, memoryMiB: 73728 },

  // C6i family — next-gen compute
  "c6i.large": { vCPUs: 2, memoryMiB: 4096 },
  "c6i.xlarge": { vCPUs: 4, memoryMiB: 8192 },
  "c6i.2xlarge": { vCPUs: 8, memoryMiB: 16384 },

  // R5 family — memory optimized
  "r5.large": { vCPUs: 2, memoryMiB: 16384 },
  "r5.xlarge": { vCPUs: 4, memoryMiB: 32768 },
  "r5.2xlarge": { vCPUs: 8, memoryMiB: 65536 },
  "r5.4xlarge": { vCPUs: 16, memoryMiB: 131072 },

  // R6i family — next-gen memory
  "r6i.large": { vCPUs: 2, memoryMiB: 16384 },
  "r6i.xlarge": { vCPUs: 4, memoryMiB: 32768 },
  "r6i.2xlarge": { vCPUs: 8, memoryMiB: 65536 },

  // I3 family — storage optimized
  "i3.large": { vCPUs: 2, memoryMiB: 15616 },
  "i3.xlarge": { vCPUs: 4, memoryMiB: 31232 },
  "i3.2xlarge": { vCPUs: 8, memoryMiB: 62464 },
};

// ── Exporter Class ──────────────────────────────────────────

export class AWSExporter {
  private readonly client: AWSClient;
  private readonly s3Bucket: string;
  private readonly s3Prefix: string;

  constructor(client: AWSClient, s3Bucket: string, s3Prefix = "vclaw-migration/") {
    this.client = client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
  }

  /**
   * Export an EC2 instance's configuration and disk to S3 as VMDK.
   * Creates an AMI from the instance, then exports that AMI to S3.
   * Does NOT stop the instance — caller is responsible for that.
   */
  async exportInstance(instanceId: string): Promise<AWSExportResult> {
    // 1. Get full instance details from EC2
    const instance = await this.client.getInstance(instanceId);

    // 2. Map EC2 instance to portable MigrationVMConfig
    const vmConfig = this.mapInstanceToVMConfig(instance);

    // 3. Create AMI from instance
    const timestamp = Date.now();
    const amiName = `vclaw-export-${instanceId}-${timestamp}`;
    const amiId = await this.client.createImage(instanceId, amiName);

    // 4. Wait for AMI to become available
    await this.waitForAMI(amiId);

    // 5. Export AMI to S3 as VMDK
    const planId = `${instanceId}-${timestamp}`;
    const exportPrefix = `${this.s3Prefix}${planId}/`;
    const taskId = await this.client.exportImage(amiId, this.s3Bucket, exportPrefix);

    // 6. Wait for export task to complete and get the S3 key
    const { s3Key } = await this.waitForExport(taskId);

    return {
      vmConfig,
      instanceId,
      amiId,
      s3Bucket: this.s3Bucket,
      s3Key,
    };
  }

  /**
   * Map an EC2 instance detail to a provider-agnostic MigrationVMConfig.
   * Uses a lookup table for instance type -> vCPU/RAM mapping.
   */
  mapInstanceToVMConfig(instance: EC2InstanceDetail): MigrationVMConfig {
    // Resolve CPU and memory from instance type
    const spec = INSTANCE_TYPE_MAP[instance.instanceType];
    const cpuCount = spec?.vCPUs ?? 2;
    const memoryMiB = spec?.memoryMiB ?? 4096;

    // Name: prefer the Name tag, fall back to instanceId
    const name = instance.name || instance.instanceId;

    // Guest OS: map platform string to VMware guest OS identifier
    const guestOS = this.mapGuestOS(instance.platform);

    // Disks: map block device mappings to MigrationDisk[]
    const disks = this.mapDisks(instance);

    // NICs: map network interfaces to MigrationNic[]
    const nics = this.mapNics(instance);

    // Firmware: ARM instances use EFI, x86 uses BIOS
    const firmware = instance.architecture.includes("arm") ? "efi" as const : "bios" as const;

    return {
      name,
      cpuCount,
      coresPerSocket: 1,
      memoryMiB,
      guestOS,
      disks,
      nics,
      firmware,
    };
  }

  /**
   * Wait for an AMI to reach the "available" state.
   * Polls every 15 seconds, times out after 30 minutes by default.
   */
  async waitForAMI(amiId: string, timeoutMs = 30 * 60 * 1000): Promise<void> {
    const pollIntervalMs = 15_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const images = await this.client.describeImages([amiId]);
      const image = images.find((img) => img.imageId === amiId);

      if (image?.state === "available") {
        return;
      }

      if (image?.state === "failed" || image?.state === "error") {
        throw new Error(`AMI ${amiId} entered ${image.state} state`);
      }

      await this.sleep(pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for AMI ${amiId} to become available (${Math.round(timeoutMs / 60_000)} min)`
    );
  }

  /**
   * Wait for an export-image task to complete.
   * Polls every 30 seconds, times out after 2 hours by default.
   * Returns the S3 key where the exported disk was written.
   */
  async waitForExport(
    taskId: string,
    timeoutMs = 2 * 60 * 60 * 1000
  ): Promise<{ s3Key: string }> {
    const pollIntervalMs = 30_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const tasks = await this.client.describeExportTasks([taskId]);
      const task = tasks.find((t) => t.exportTaskId === taskId);

      if (!task) {
        throw new Error(`Export task ${taskId} not found`);
      }

      if (task.state === "completed") {
        return { s3Key: task.s3Key };
      }

      if (task.state === "cancelled" || task.state === "deleted") {
        throw new Error(
          `Export task ${taskId} was ${task.state}: ${task.statusMessage ?? "no details"}`
        );
      }

      await this.sleep(pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for export task ${taskId} to complete (${Math.round(timeoutMs / 60_000)} min)`
    );
  }

  // ── Private Helpers ───────────────────────────────────────

  /**
   * Map AWS platform string to VMware guest OS identifier.
   */
  private mapGuestOS(platform?: string): string {
    if (platform?.toLowerCase().includes("windows")) {
      return "windows9Server64Guest";
    }
    return "otherLinux64Guest";
  }

  /**
   * Map EC2 block device mappings to MigrationDisk[].
   * Target format is "vmdk" since VMware is the destination.
   */
  private mapDisks(instance: EC2InstanceDetail): MigrationDisk[] {
    const disks: MigrationDisk[] = [];

    for (const bdm of instance.blockDeviceMappings) {
      if (!bdm.ebs) continue;

      disks.push({
        label: bdm.deviceName,
        // EBS volume size is not directly on BlockDeviceMapping in our types,
        // so we estimate from volumeId (actual size resolved during export).
        // The volumeId field is populated; capacity comes from the export.
        capacityBytes: 0,
        sourcePath: `ebs://${bdm.ebs.volumeId}`,
        sourceFormat: "raw",
        targetFormat: "vmdk",
      });
    }

    return disks;
  }

  /**
   * Map EC2 network interfaces to MigrationNic[].
   */
  private mapNics(instance: EC2InstanceDetail): MigrationNic[] {
    const nics: MigrationNic[] = [];

    for (const ni of instance.networkInterfaces) {
      nics.push({
        label: ni.networkInterfaceId,
        macAddress: ni.macAddress,
        networkName: ni.subnetId, // AWS uses subnets; map to network name
        adapterType: "vmxnet3", // default VMware adapter type for the target
      });
    }

    return nics;
  }

  /**
   * Sleep for the given duration in milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
