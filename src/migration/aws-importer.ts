// ============================================================
// vClaw — AWS EC2 VM Importer
// Uploads disk to S3, imports as AMI, and launches EC2 instance
// ============================================================

import type { AWSClient } from "../providers/aws/client.js";
import type { MigrationVMConfig, SSHExecFn } from "./types.js";

// ── Interfaces ──────────────────────────────────────────────

export interface AWSImportConfig {
  vmConfig: MigrationVMConfig;
  diskPath: string; // local path to vmdk/raw disk on staging host
  diskFormat: "vmdk" | "raw" | "vhd";
  instanceType?: string; // auto-determined from vmConfig if not specified
  subnetId?: string;
  securityGroupIds?: string[];
  keyName?: string;
}

export interface AWSImportResult {
  amiId: string;
  instanceId: string;
  instanceType: string;
  privateIp?: string;
}

// ── Instance Type Lookup Table ──────────────────────────────

interface InstanceSpec {
  type: string;
  vCPU: number;
  memoryMiB: number;
}

const INSTANCE_TABLE: InstanceSpec[] = [
  { type: "c5.large", vCPU: 2, memoryMiB: 4096 },
  { type: "t3.large", vCPU: 2, memoryMiB: 8192 },
  { type: "m5.large", vCPU: 2, memoryMiB: 8192 },
  { type: "c5.xlarge", vCPU: 4, memoryMiB: 8192 },
  { type: "m5.xlarge", vCPU: 4, memoryMiB: 16384 },
  { type: "r5.large", vCPU: 2, memoryMiB: 16384 },
  { type: "c5.2xlarge", vCPU: 8, memoryMiB: 16384 },
  { type: "m5.2xlarge", vCPU: 8, memoryMiB: 32768 },
  { type: "r5.xlarge", vCPU: 4, memoryMiB: 32768 },
  { type: "m5.4xlarge", vCPU: 16, memoryMiB: 65536 },
];

// ── Importer ────────────────────────────────────────────────

export class AWSImporter {
  private readonly client: AWSClient;
  private readonly s3Bucket: string;
  private readonly s3Prefix: string;
  private readonly sshExec: SSHExecFn;

  constructor(
    client: AWSClient,
    s3Bucket: string,
    s3Prefix: string,
    sshExec: SSHExecFn
  ) {
    this.client = client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
    this.sshExec = sshExec;
  }

  /**
   * Import a VM into AWS EC2 from a disk image on a staging host.
   * 1. Upload disk to S3 via `aws s3 cp` on staging host
   * 2. Import image from S3 using AWS VM Import/Export
   * 3. Wait for import task to complete (AMI creation)
   * 4. Launch EC2 instance from the imported AMI
   */
  async importVM(
    config: AWSImportConfig,
    stagingHost: string,
    stagingUser: string
  ): Promise<AWSImportResult> {
    const { vmConfig, diskPath, diskFormat } = config;
    const planId = vmConfig.name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const filename = diskPath.split("/").pop() ?? "disk.vmdk";
    const s3Key = `${this.s3Prefix}${planId}/${filename}`;

    // 1. Upload disk to S3 via staging host
    console.log(`[aws-importer] Uploading disk to s3://${this.s3Bucket}/${s3Key}`);
    await this.uploadDiskToS3(stagingHost, stagingUser, diskPath, s3Key, this.sshExec);

    // 2. Import image from S3
    console.log(`[aws-importer] Starting VM Import/Export for ${vmConfig.name}`);
    const taskId = await this.client.importImage({
      s3Bucket: this.s3Bucket,
      s3Key,
      format: diskFormat,
      description: `vClaw import: ${vmConfig.name}`,
    });

    // 3. Wait for import task to complete (up to 3 hours)
    console.log(`[aws-importer] Waiting for import task ${taskId} to complete...`);
    const amiId = await this.waitForImport(taskId, 3 * 60 * 60 * 1000);

    // 4. Launch instance from imported AMI
    const instanceType = config.instanceType ?? this.recommendInstanceType(vmConfig);
    console.log(
      `[aws-importer] Launching instance from ${amiId} as ${instanceType}`
    );

    const instance = await this.client.launchInstance({
      amiId,
      instanceType,
      subnetId: config.subnetId,
      securityGroupIds: config.securityGroupIds,
      keyName: config.keyName,
      name: vmConfig.name,
    });

    console.log(
      `[aws-importer] Instance ${instance.instanceId} launched successfully`
    );

    return {
      amiId,
      instanceId: instance.instanceId,
      instanceType,
      privateIp: instance.privateIp,
    };
  }

  /**
   * Recommend an EC2 instance type based on VM CPU and memory requirements.
   * Finds the smallest instance where vCPU >= cpuCount and RAM >= memoryMiB.
   * Defaults to m5.large if nothing fits well.
   */
  recommendInstanceType(vmConfig: MigrationVMConfig): string {
    // Sort by total resource (vCPU + memory) ascending to find smallest fit
    const sorted = [...INSTANCE_TABLE].sort(
      (a, b) => a.memoryMiB + a.vCPU * 1024 - (b.memoryMiB + b.vCPU * 1024)
    );

    for (const spec of sorted) {
      if (spec.vCPU >= vmConfig.cpuCount && spec.memoryMiB >= vmConfig.memoryMiB) {
        return spec.type;
      }
    }

    // Nothing fits — return the largest available or default
    return "m5.large";
  }

  /**
   * Poll an import image task until completion.
   * AWS VM Import/Export tasks can take 30-60+ minutes for large disks.
   * @returns The AMI ID of the imported image.
   */
  async waitForImport(taskId: string, timeoutMs = 3 * 60 * 60 * 1000): Promise<string> {
    const pollIntervalMs = 30_000; // 30 seconds
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const tasks = await this.client.describeImportTasks([taskId]);
      const task = tasks.find((t) => t.importTaskId === taskId);

      if (!task) {
        throw new Error(`Import task ${taskId} not found`);
      }

      const status = task.status.toLowerCase();
      const progress = task.progress ?? "unknown";
      console.log(
        `[aws-importer] Import task ${taskId}: status=${task.status}, progress=${progress}%`
      );

      if (status === "completed") {
        // The import task doesn't directly return an AMI ID — we need to look
        // up images created from this import. The AMI is associated with the
        // snapshot referenced in the task.
        // For importImage, the task status "completed" means the AMI is ready.
        // We retrieve it by describing images filtered by the task description.
        const images = await this.client.describeImages();
        const description = `vClaw import:`;

        // Find the most recently created image matching our import
        const imported = images.find(
          (img) => img.description?.includes(description) &&
            task.snapshotId &&
            img.blockDeviceMappings?.some((b: any) => b.ebs?.snapshotId === task.snapshotId)
        );

        if (imported) {
          return imported.imageId;
        }

        // Fallback: if the snapshot ID is available, search by it
        if (task.snapshotId) {
          // The AMI was created from this import — find it via snapshot
          const allImages = await this.client.describeImages();
          for (const img of allImages) {
            for (const bdm of img.blockDeviceMappings ?? []) {
              if (bdm.ebs?.volumeId === task.snapshotId) {
                return img.imageId;
              }
            }
          }
        }

        throw new Error(
          `Import task ${taskId} completed but could not locate the resulting AMI`
        );
      }

      if (status === "deleted" || status === "deleting") {
        throw new Error(
          `Import task ${taskId} was cancelled: ${task.statusMessage ?? "unknown reason"}`
        );
      }

      if (task.statusMessage?.toLowerCase().includes("error")) {
        throw new Error(
          `Import task ${taskId} failed: ${task.statusMessage}`
        );
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Import task ${taskId} timed out after ${Math.round(timeoutMs / 60_000)} minutes`
    );
  }

  /**
   * Upload a disk image from a staging host to S3 using `aws s3 cp` over SSH.
   * This avoids downloading huge disk files to the vClaw host first.
   */
  async uploadDiskToS3(
    stagingHost: string,
    stagingUser: string,
    diskPath: string,
    s3Key: string,
    sshExec: SSHExecFn
  ): Promise<void> {
    const s3Uri = `s3://${this.s3Bucket}/${s3Key}`;
    const cmd = `aws s3 cp ${JSON.stringify(diskPath)} ${s3Uri} --no-progress`;

    const result = await sshExec(
      stagingHost,
      stagingUser,
      cmd,
      7_200_000 // 2 hour timeout for large disk uploads
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to upload disk to S3: ${result.stderr || result.stdout}`
      );
    }

    // Verify the object landed in S3
    const head = await this.client.headObject(this.s3Bucket, s3Key);
    if (!head.exists) {
      throw new Error(
        `Disk upload to s3://${this.s3Bucket}/${s3Key} succeeded but object not found`
      );
    }

    console.log(
      `[aws-importer] Disk uploaded to S3: ${s3Uri} (${Math.round(head.size / 1024 / 1024)} MiB)`
    );
  }
}
