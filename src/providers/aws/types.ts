// ============================================================
// vClaw — AWS EC2 & Related Service Types
// Typed interfaces matching the AWS SDK v3 response shapes
// ============================================================

// ── EC2 Instance Types ─────────────────────────────────────

export type EC2InstanceState =
  | "running"
  | "stopped"
  | "terminated"
  | "pending"
  | "shutting-down"
  | "stopping";

export interface EC2InstanceSummary {
  instanceId: string;
  name: string;
  state: EC2InstanceState;
  instanceType: string;
  vpcId?: string;
  subnetId?: string;
  availabilityZone: string;
  publicIp?: string;
  privateIp?: string;
  launchTime: string;
  platform?: string;
}

export interface EC2InstanceDetail extends EC2InstanceSummary {
  blockDeviceMappings: BlockDeviceMapping[];
  securityGroups: SecurityGroupReference[];
  networkInterfaces: NetworkInterfaceInfo[];
  architecture: string;
  imageId: string;
  iamInstanceProfile?: string;
  keyName?: string;
}

export interface BlockDeviceMapping {
  deviceName: string;
  ebs?: {
    volumeId: string;
    status: string;
    attachTime?: string;
    deleteOnTermination: boolean;
  };
}

export interface SecurityGroupReference {
  groupId: string;
  groupName: string;
}

export interface NetworkInterfaceInfo {
  networkInterfaceId: string;
  subnetId: string;
  vpcId: string;
  privateIpAddress: string;
  publicIp?: string;
  status: string;
  macAddress: string;
  securityGroups: SecurityGroupReference[];
}

// ── EBS Volume Types ───────────────────────────────────────

export type EBSVolumeState =
  | "creating"
  | "available"
  | "in-use"
  | "deleting"
  | "deleted"
  | "error";

export type EBSVolumeType =
  | "gp2"
  | "gp3"
  | "io1"
  | "io2"
  | "st1"
  | "sc1"
  | "standard";

export interface EBSVolumeAttachment {
  instanceId: string;
  device: string;
  state: string;
}

export interface EBSVolumeSummary {
  volumeId: string;
  size: number;
  state: EBSVolumeState;
  volumeType: EBSVolumeType;
  availabilityZone: string;
  encrypted: boolean;
  attachments: EBSVolumeAttachment[];
}

// ── EBS Snapshot Types ─────────────────────────────────────

export type EBSSnapshotState = "pending" | "completed" | "error";

export interface EBSSnapshotInfo {
  snapshotId: string;
  volumeId: string;
  state: EBSSnapshotState;
  startTime: string;
  volumeSize: number;
  description?: string;
  encrypted: boolean;
}

// ── AMI Types ──────────────────────────────────────────────

export type AMIState = "available" | "invalid" | "deregistered" | "transient" | "failed" | "error";

export interface AMIInfo {
  imageId: string;
  name: string;
  state: AMIState;
  architecture: string;
  platform?: string;
  blockDeviceMappings: BlockDeviceMapping[];
  creationDate: string;
  description?: string;
  ownerId: string;
}

// ── VPC Types ──────────────────────────────────────────────

export type VPCState = "pending" | "available";

export interface VPCInfo {
  vpcId: string;
  cidrBlock: string;
  state: VPCState;
  isDefault: boolean;
  name?: string;
}

// ── Subnet Types ───────────────────────────────────────────

export interface SubnetInfo {
  subnetId: string;
  vpcId: string;
  cidrBlock: string;
  availabilityZone: string;
  availableIps: number;
  name?: string;
}

// ── Security Group Types ───────────────────────────────────

export interface SecurityGroupRule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidrBlocks?: string[];
  securityGroups?: string[];
  description?: string;
}

export interface SecurityGroupInfo {
  groupId: string;
  groupName: string;
  vpcId: string;
  description: string;
  inboundRules: SecurityGroupRule[];
  outboundRules: SecurityGroupRule[];
}

// ── Import/Export Task Types ───────────────────────────────

export interface ImportTaskInfo {
  importTaskId: string;
  status: string;
  statusMessage?: string;
  progress?: string;
  snapshotId?: string;
  description?: string;
}

export interface ExportTaskInfo {
  exportTaskId: string;
  state: string;
  statusMessage?: string;
  instanceId: string;
  s3Bucket: string;
  s3Key: string;
}

// ── Client Config ──────────────────────────────────────────

export interface AWSClientConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}
