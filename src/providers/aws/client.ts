// ============================================================
// vClaw — AWS EC2 & Related Services API Client
// Wraps AWS SDK v3 clients for EC2, S3, and STS operations
// ============================================================

import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";

import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  TerminateInstancesCommand,
  RunInstancesCommand,
  CreateImageCommand,
  DescribeImagesCommand,
  DeregisterImageCommand,
  DescribeVolumesCommand,
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  ImportImageCommand,
  DescribeImportImageTasksCommand,
  ExportImageCommand,
  DescribeExportImageTasksCommand,
  CreateTagsCommand,
  type Filter,
  type Instance,
  type Tag,
  type IpPermission,
} from "@aws-sdk/client-ec2";

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { Upload } from "@aws-sdk/lib-storage";

import {
  STSClient,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";

import type {
  AWSClientConfig,
  EC2InstanceSummary,
  EC2InstanceDetail,
  EBSVolumeSummary,
  EBSSnapshotInfo,
  AMIInfo,
  VPCInfo,
  SubnetInfo,
  SecurityGroupInfo,
  SecurityGroupRule,
  ImportTaskInfo,
  ExportTaskInfo,
  BlockDeviceMapping,
  SecurityGroupReference,
  NetworkInterfaceInfo,
} from "./types.js";

import type { Readable } from "node:stream";

// ── Client ──────────────────────────────────────────────────

export class AWSClient {
  private readonly ec2: EC2Client;
  private readonly s3: S3Client;
  private readonly sts: STSClient;
  private connected = false;

  constructor(config: AWSClientConfig) {
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    };

    const clientConfig = { region: config.region, credentials };

    this.ec2 = new EC2Client(clientConfig);
    this.s3 = new S3Client(clientConfig);
    this.sts = new STSClient(clientConfig);
  }

  // ── Connection Management ──────────────────────────────────

  async connect(): Promise<void> {
    await this.getCallerIdentity();
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── STS ─────────────────────────────────────────────────────

  async getCallerIdentity(): Promise<{
    accountId: string;
    arn: string;
    userId: string;
  }> {
    const resp = await this.sts.send(new GetCallerIdentityCommand({}));
    return {
      accountId: resp.Account ?? "",
      arn: resp.Arn ?? "",
      userId: resp.UserId ?? "",
    };
  }

  // ── EC2 Instances ──────────────────────────────────────────

  async listInstances(
    filters?: Record<string, string[]>
  ): Promise<EC2InstanceSummary[]> {
    const awsFilters = filters ? this.toEC2Filters(filters) : undefined;
    const resp = await this.ec2.send(
      new DescribeInstancesCommand({ Filters: awsFilters })
    );

    const instances: EC2InstanceSummary[] = [];
    for (const reservation of resp.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        instances.push(this.toInstanceSummary(inst));
      }
    }
    return instances;
  }

  async getInstance(instanceId: string): Promise<EC2InstanceDetail> {
    const resp = await this.ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] })
    );

    const inst = resp.Reservations?.[0]?.Instances?.[0];
    if (!inst) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    return this.toInstanceDetail(inst);
  }

  async startInstance(instanceId: string): Promise<void> {
    await this.ec2.send(
      new StartInstancesCommand({ InstanceIds: [instanceId] })
    );
  }

  async stopInstance(instanceId: string): Promise<void> {
    await this.ec2.send(
      new StopInstancesCommand({ InstanceIds: [instanceId] })
    );
  }

  async rebootInstance(instanceId: string): Promise<void> {
    await this.ec2.send(
      new RebootInstancesCommand({ InstanceIds: [instanceId] })
    );
  }

  async terminateInstance(instanceId: string): Promise<void> {
    await this.ec2.send(
      new TerminateInstancesCommand({ InstanceIds: [instanceId] })
    );
  }

  async launchInstance(params: {
    amiId: string;
    instanceType: string;
    subnetId?: string;
    securityGroupIds?: string[];
    keyName?: string;
    name?: string;
  }): Promise<EC2InstanceSummary> {
    const resp = await this.ec2.send(
      new RunInstancesCommand({
        ImageId: params.amiId,
        InstanceType: params.instanceType as any,
        MinCount: 1,
        MaxCount: 1,
        SubnetId: params.subnetId,
        SecurityGroupIds: params.securityGroupIds,
        KeyName: params.keyName,
      })
    );

    const inst = resp.Instances?.[0];
    if (!inst) {
      throw new Error("Failed to launch instance — no instance returned");
    }

    // Tag with Name if provided
    if (params.name && inst.InstanceId) {
      await this.ec2.send(
        new CreateTagsCommand({
          Resources: [inst.InstanceId],
          Tags: [{ Key: "Name", Value: params.name }],
        })
      );
    }

    return this.toInstanceSummary(inst);
  }

  // ── AMI ────────────────────────────────────────────────────

  async createImage(
    instanceId: string,
    name: string,
    description?: string
  ): Promise<string> {
    const resp = await this.ec2.send(
      new CreateImageCommand({
        InstanceId: instanceId,
        Name: name,
        Description: description,
        NoReboot: true,
      })
    );
    if (!resp.ImageId) {
      throw new Error("Failed to create image — no imageId returned");
    }
    return resp.ImageId;
  }

  async describeImages(imageIds?: string[]): Promise<AMIInfo[]> {
    const resp = await this.ec2.send(
      new DescribeImagesCommand({
        ...(imageIds ? { ImageIds: imageIds } : { Owners: ["self"] }),
      })
    );

    return (resp.Images ?? []).map((img) => ({
      imageId: img.ImageId ?? "",
      name: img.Name ?? "",
      state: (img.State ?? "available") as AMIInfo["state"],
      architecture: img.Architecture ?? "",
      platform: img.PlatformDetails,
      blockDeviceMappings: (img.BlockDeviceMappings ?? []).map((bdm) => ({
        deviceName: bdm.DeviceName ?? "",
        ebs: bdm.Ebs
          ? {
              volumeId: bdm.Ebs.VolumeSize?.toString() ?? "",
              status: bdm.Ebs.VolumeType ?? "",
              deleteOnTermination: bdm.Ebs.DeleteOnTermination ?? false,
            }
          : undefined,
      })),
      creationDate: img.CreationDate ?? "",
      description: img.Description,
      ownerId: img.OwnerId ?? "",
    }));
  }

  async deregisterImage(imageId: string): Promise<void> {
    await this.ec2.send(
      new DeregisterImageCommand({ ImageId: imageId })
    );
  }

  // ── EBS ────────────────────────────────────────────────────

  async listVolumes(): Promise<EBSVolumeSummary[]> {
    const resp = await this.ec2.send(new DescribeVolumesCommand({}));

    return (resp.Volumes ?? []).map((vol) => ({
      volumeId: vol.VolumeId ?? "",
      size: vol.Size ?? 0,
      state: (vol.State ?? "available") as EBSVolumeSummary["state"],
      volumeType: (vol.VolumeType ?? "gp3") as EBSVolumeSummary["volumeType"],
      availabilityZone: vol.AvailabilityZone ?? "",
      encrypted: vol.Encrypted ?? false,
      attachments: (vol.Attachments ?? []).map((att) => ({
        instanceId: att.InstanceId ?? "",
        device: att.Device ?? "",
        state: att.State ?? "",
      })),
    }));
  }

  async createSnapshot(
    volumeId: string,
    description?: string
  ): Promise<EBSSnapshotInfo> {
    const resp = await this.ec2.send(
      new CreateSnapshotCommand({
        VolumeId: volumeId,
        Description: description,
      })
    );

    return {
      snapshotId: resp.SnapshotId ?? "",
      volumeId: resp.VolumeId ?? "",
      state: (resp.State ?? "pending") as EBSSnapshotInfo["state"],
      startTime: resp.StartTime?.toISOString() ?? "",
      volumeSize: resp.VolumeSize ?? 0,
      description: resp.Description,
      encrypted: resp.Encrypted ?? false,
    };
  }

  async describeSnapshots(snapshotIds?: string[]): Promise<EBSSnapshotInfo[]> {
    const resp = await this.ec2.send(
      new DescribeSnapshotsCommand({
        ...(snapshotIds
          ? { SnapshotIds: snapshotIds }
          : { OwnerIds: ["self"] }),
      })
    );

    return (resp.Snapshots ?? []).map((snap) => ({
      snapshotId: snap.SnapshotId ?? "",
      volumeId: snap.VolumeId ?? "",
      state: (snap.State ?? "pending") as EBSSnapshotInfo["state"],
      startTime: snap.StartTime?.toISOString() ?? "",
      volumeSize: snap.VolumeSize ?? 0,
      description: snap.Description,
      encrypted: snap.Encrypted ?? false,
    }));
  }

  // ── VPC / Networking ───────────────────────────────────────

  async listVPCs(): Promise<VPCInfo[]> {
    const resp = await this.ec2.send(new DescribeVpcsCommand({}));

    return (resp.Vpcs ?? []).map((vpc) => ({
      vpcId: vpc.VpcId ?? "",
      cidrBlock: vpc.CidrBlock ?? "",
      state: (vpc.State ?? "available") as VPCInfo["state"],
      isDefault: vpc.IsDefault ?? false,
      name: this.extractName(vpc.Tags),
    }));
  }

  async listSubnets(vpcId?: string): Promise<SubnetInfo[]> {
    const filters = vpcId
      ? [{ Name: "vpc-id", Values: [vpcId] }]
      : undefined;
    const resp = await this.ec2.send(
      new DescribeSubnetsCommand({ Filters: filters })
    );

    return (resp.Subnets ?? []).map((sub) => ({
      subnetId: sub.SubnetId ?? "",
      vpcId: sub.VpcId ?? "",
      cidrBlock: sub.CidrBlock ?? "",
      availabilityZone: sub.AvailabilityZone ?? "",
      availableIps: sub.AvailableIpAddressCount ?? 0,
      name: this.extractName(sub.Tags),
    }));
  }

  async listSecurityGroups(vpcId?: string): Promise<SecurityGroupInfo[]> {
    const filters = vpcId
      ? [{ Name: "vpc-id", Values: [vpcId] }]
      : undefined;
    const resp = await this.ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: filters })
    );

    return (resp.SecurityGroups ?? []).map((sg) => ({
      groupId: sg.GroupId ?? "",
      groupName: sg.GroupName ?? "",
      vpcId: sg.VpcId ?? "",
      description: sg.Description ?? "",
      inboundRules: this.toSecurityGroupRules(sg.IpPermissions),
      outboundRules: this.toSecurityGroupRules(sg.IpPermissionsEgress),
    }));
  }

  // ── VM Import / Export ─────────────────────────────────────

  async importImage(params: {
    s3Bucket: string;
    s3Key: string;
    format: string;
    description?: string;
  }): Promise<string> {
    const resp = await this.ec2.send(
      new ImportImageCommand({
        Description: params.description,
        DiskContainers: [
          {
            Format: params.format,
            UserBucket: {
              S3Bucket: params.s3Bucket,
              S3Key: params.s3Key,
            },
          },
        ],
      })
    );

    if (!resp.ImportTaskId) {
      throw new Error("Failed to import image — no importTaskId returned");
    }
    return resp.ImportTaskId;
  }

  async describeImportTasks(taskIds?: string[]): Promise<ImportTaskInfo[]> {
    const resp = await this.ec2.send(
      new DescribeImportImageTasksCommand({
        ImportTaskIds: taskIds,
      })
    );

    return (resp.ImportImageTasks ?? []).map((task) => ({
      importTaskId: task.ImportTaskId ?? "",
      status: task.Status ?? "",
      statusMessage: task.StatusMessage,
      progress: task.Progress,
      snapshotId: task.SnapshotDetails?.[0]?.SnapshotId,
      description: task.Description,
    }));
  }

  async exportImage(
    imageId: string,
    s3Bucket: string,
    s3Prefix: string
  ): Promise<string> {
    const resp = await this.ec2.send(
      new ExportImageCommand({
        ImageId: imageId,
        DiskImageFormat: "VMDK",
        S3ExportLocation: {
          S3Bucket: s3Bucket,
          S3Prefix: s3Prefix,
        },
      })
    );

    if (!resp.ExportImageTaskId) {
      throw new Error("Failed to export image — no exportTaskId returned");
    }
    return resp.ExportImageTaskId;
  }

  async describeExportTasks(taskIds?: string[]): Promise<ExportTaskInfo[]> {
    const resp = await this.ec2.send(
      new DescribeExportImageTasksCommand({
        ExportImageTaskIds: taskIds,
      })
    );

    return (resp.ExportImageTasks ?? []).map((task) => ({
      exportTaskId: task.ExportImageTaskId ?? "",
      state: task.Status ?? "",
      statusMessage: task.StatusMessage,
      instanceId: task.ImageId ?? "",
      s3Bucket: task.S3ExportLocation?.S3Bucket ?? "",
      s3Key: task.S3ExportLocation?.S3Prefix ?? "",
    }));
  }

  // ── S3 ─────────────────────────────────────────────────────

  async uploadToS3(
    localPath: string,
    bucket: string,
    key: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const fileSize = (await stat(localPath)).size;
    const body = createReadStream(localPath);

    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
      },
      queueSize: 4,
      partSize: 10 * 1024 * 1024, // 10 MiB parts
    });

    if (onProgress) {
      upload.on("httpUploadProgress", (progress) => {
        onProgress(progress.loaded ?? 0, fileSize);
      });
    }

    await upload.done();
  }

  async downloadFromS3(
    bucket: string,
    key: string,
    localPath: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    if (!resp.Body) {
      throw new Error(`S3 object body is empty: s3://${bucket}/${key}`);
    }

    const totalSize = resp.ContentLength ?? 0;
    const readable = resp.Body as Readable;
    const writable = createWriteStream(localPath);

    return new Promise<void>((resolve, reject) => {
      let loaded = 0;

      readable.on("data", (chunk: Buffer) => {
        loaded += chunk.length;
        if (onProgress) {
          onProgress(loaded, totalSize);
        }
      });

      readable.pipe(writable);
      writable.on("finish", resolve);
      writable.on("error", reject);
      readable.on("error", reject);
    });
  }

  async headObject(
    bucket: string,
    key: string
  ): Promise<{ exists: boolean; size: number; lastModified?: string }> {
    try {
      const resp = await this.s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      );
      return {
        exists: true,
        size: resp.ContentLength ?? 0,
        lastModified: resp.LastModified?.toISOString(),
      };
    } catch (err: unknown) {
      const code = (err as { name?: string }).name;
      if (code === "NotFound" || code === "NoSuchKey") {
        return { exists: false, size: 0 };
      }
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key })
    );
  }

  // ── Private Helpers ────────────────────────────────────────

  private extractName(tags?: Tag[]): string {
    if (!tags) return "";
    const nameTag = tags.find((t) => t.Key === "Name");
    return nameTag?.Value ?? "";
  }

  private toEC2Filters(filters: Record<string, string[]>): Filter[] {
    return Object.entries(filters).map(([name, values]) => ({
      Name: name,
      Values: values,
    }));
  }

  private toSecurityGroupRules(
    permissions?: IpPermission[]
  ): SecurityGroupRule[] {
    if (!permissions) return [];

    return permissions.map((perm) => ({
      protocol: perm.IpProtocol ?? "",
      fromPort: perm.FromPort,
      toPort: perm.ToPort,
      cidrBlocks: perm.IpRanges?.map((r) => r.CidrIp ?? "").filter(Boolean),
      securityGroups: perm.UserIdGroupPairs?.map((p) => p.GroupId ?? "").filter(
        Boolean
      ),
      description:
        perm.IpRanges?.[0]?.Description ??
        perm.UserIdGroupPairs?.[0]?.Description,
    }));
  }

  private toInstanceSummary(inst: Instance): EC2InstanceSummary {
    return {
      instanceId: inst.InstanceId ?? "",
      name: this.extractName(inst.Tags),
      state: (inst.State?.Name ?? "pending") as EC2InstanceSummary["state"],
      instanceType: inst.InstanceType ?? "",
      vpcId: inst.VpcId,
      subnetId: inst.SubnetId,
      availabilityZone: inst.Placement?.AvailabilityZone ?? "",
      publicIp: inst.PublicIpAddress,
      privateIp: inst.PrivateIpAddress,
      launchTime: inst.LaunchTime?.toISOString() ?? "",
      platform: inst.PlatformDetails,
    };
  }

  private toInstanceDetail(inst: Instance): EC2InstanceDetail {
    return {
      ...this.toInstanceSummary(inst),
      blockDeviceMappings: (inst.BlockDeviceMappings ?? []).map((bdm) => ({
        deviceName: bdm.DeviceName ?? "",
        ebs: bdm.Ebs
          ? {
              volumeId: bdm.Ebs.VolumeId ?? "",
              status: bdm.Ebs.Status ?? "",
              attachTime: bdm.Ebs.AttachTime?.toISOString(),
              deleteOnTermination: bdm.Ebs.DeleteOnTermination ?? false,
            }
          : undefined,
      })),
      securityGroups: (inst.SecurityGroups ?? []).map((sg) => ({
        groupId: sg.GroupId ?? "",
        groupName: sg.GroupName ?? "",
      })),
      networkInterfaces: (inst.NetworkInterfaces ?? []).map((ni) => ({
        networkInterfaceId: ni.NetworkInterfaceId ?? "",
        subnetId: ni.SubnetId ?? "",
        vpcId: ni.VpcId ?? "",
        privateIpAddress: ni.PrivateIpAddress ?? "",
        publicIp: ni.Association?.PublicIp,
        status: ni.Status ?? "",
        macAddress: ni.MacAddress ?? "",
        securityGroups: (ni.Groups ?? []).map((g) => ({
          groupId: g.GroupId ?? "",
          groupName: g.GroupName ?? "",
        })),
      })),
      architecture: inst.Architecture ?? "",
      imageId: inst.ImageId ?? "",
      iamInstanceProfile: inst.IamInstanceProfile?.Arn,
      keyName: inst.KeyName,
    };
  }
}
