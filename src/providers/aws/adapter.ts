// ============================================================
// vClaw — AWS EC2 Adapter
// Implements InfraAdapter and registers all AWS EC2 tools
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
  VMInfo,
  StorageInfo,
} from "../types.js";

import { AWSClient } from "./client.js";
import type { EC2InstanceState } from "./types.js";

// ── Config ──────────────────────────────────────────────────

export interface AWSAdapterConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}

// ── Tool Definitions ────────────────────────────────────────

const ADAPTER_NAME = "aws";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object"
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

function param(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: unknown
): ToolDefinition["params"][number] {
  const p: ToolDefinition["params"][number] = { name, type, required, description };
  if (defaultValue !== undefined) p.default = defaultValue;
  return p;
}

const instanceIdParam = param("instance_id", "string", true, "EC2 instance identifier (e.g. i-0abcdef1234567890)");
const volumeIdParam = param("volume_id", "string", true, "EBS volume identifier (e.g. vol-0abcdef1234567890)");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Read Tools ────────────────────────────────────────────

  tool("aws_list_instances", "List all EC2 instances, optionally filtered by name or state", "read", [
    param("name", "string", false, "Filter by instance Name tag"),
    param("state", "string", false, "Filter by instance state (running, stopped, pending, etc.)"),
  ], "EC2InstanceSummary[]"),

  tool("aws_get_instance", "Get detailed info about a specific EC2 instance", "read", [
    instanceIdParam,
  ], "EC2InstanceDetail"),

  tool("aws_list_volumes", "List all EBS volumes", "read", [], "EBSVolumeSummary[]"),

  tool("aws_list_vpcs", "List all VPCs", "read", [], "VPCInfo[]"),

  tool("aws_list_subnets", "List subnets, optionally filtered by VPC", "read", [
    param("vpc_id", "string", false, "Filter subnets by VPC identifier"),
  ], "SubnetInfo[]"),

  tool("aws_list_security_groups", "List security groups, optionally filtered by VPC", "read", [
    param("vpc_id", "string", false, "Filter security groups by VPC identifier"),
  ], "SecurityGroupInfo[]"),

  tool("aws_list_amis", "List owned AMIs (Amazon Machine Images)", "read", [], "AMIInfo[]"),

  tool("aws_list_snapshots", "List EBS snapshots owned by this account", "read", [], "EBSSnapshotInfo[]"),

  // ── Safe Write Tools ──────────────────────────────────────

  tool("aws_start_instance", "Start a stopped EC2 instance", "safe_write", [
    instanceIdParam,
  ], "void"),

  tool("aws_create_ami", "Create an AMI from an EC2 instance", "safe_write", [
    instanceIdParam,
    param("name", "string", true, "Name for the new AMI"),
    param("description", "string", false, "Description for the new AMI"),
  ], "string"),

  tool("aws_create_snapshot", "Create an EBS snapshot from a volume", "safe_write", [
    volumeIdParam,
    param("description", "string", false, "Description for the snapshot"),
  ], "EBSSnapshotInfo"),

  // ── Risky Write Tools ─────────────────────────────────────

  tool("aws_stop_instance", "Stop a running EC2 instance", "risky_write", [
    instanceIdParam,
  ], "void"),

  tool("aws_reboot_instance", "Reboot an EC2 instance", "risky_write", [
    instanceIdParam,
  ], "void"),

  tool("aws_launch_instance", "Launch a new EC2 instance from an AMI", "risky_write", [
    param("ami_id", "string", true, "AMI identifier to launch from"),
    param("instance_type", "string", true, "Instance type (e.g. t3.micro, m5.large)"),
    param("subnet_id", "string", false, "Subnet to launch into"),
    param("security_group_ids", "string", false, "Comma-separated security group IDs"),
    param("key_name", "string", false, "SSH key pair name"),
    param("name", "string", false, "Name tag for the instance"),
  ], "EC2InstanceSummary"),

  // ── Destructive Tools ─────────────────────────────────────

  tool("aws_terminate_instance", "Permanently terminate an EC2 instance", "destructive", [
    instanceIdParam,
  ], "void"),

  tool("aws_deregister_ami", "Deregister an AMI (does not delete underlying snapshots)", "destructive", [
    param("image_id", "string", true, "AMI identifier to deregister"),
  ], "void"),
];

// ── Adapter ─────────────────────────────────────────────────

export class AWSAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  private client: AWSClient;
  private _connected = false;

  constructor(config: AWSAdapterConfig) {
    this.client = new AWSClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      sessionToken: config.sessionToken,
    });
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

  // ── Execute ─────────────────────────────────────────────

  async execute(
    toolName: string,
    params: Record<string, unknown>
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
    p: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      // ── Read ────────────────────────────────────────────
      case "aws_list_instances": {
        const filters: Record<string, string[]> = {};
        if (p.name) filters["tag:Name"] = [p.name as string];
        if (p.state) filters["instance-state-name"] = [p.state as string];
        return this.client.listInstances(
          Object.keys(filters).length > 0 ? filters : undefined
        );
      }

      case "aws_get_instance":
        return this.client.getInstance(p.instance_id as string);

      case "aws_list_volumes":
        return this.client.listVolumes();

      case "aws_list_vpcs":
        return this.client.listVPCs();

      case "aws_list_subnets":
        return this.client.listSubnets(p.vpc_id as string | undefined);

      case "aws_list_security_groups":
        return this.client.listSecurityGroups(p.vpc_id as string | undefined);

      case "aws_list_amis":
        return this.client.describeImages();

      case "aws_list_snapshots":
        return this.client.describeSnapshots();

      // ── Safe Write ──────────────────────────────────────
      case "aws_start_instance":
        return this.client.startInstance(p.instance_id as string);

      case "aws_create_ami":
        return this.client.createImage(
          p.instance_id as string,
          p.name as string,
          p.description as string | undefined,
        );

      case "aws_create_snapshot":
        return this.client.createSnapshot(
          p.volume_id as string,
          p.description as string | undefined,
        );

      // ── Risky Write ─────────────────────────────────────
      case "aws_stop_instance":
        return this.client.stopInstance(p.instance_id as string);

      case "aws_reboot_instance":
        return this.client.rebootInstance(p.instance_id as string);

      case "aws_launch_instance": {
        const sgIds = p.security_group_ids
          ? (p.security_group_ids as string).split(",").map((s) => s.trim())
          : undefined;
        return this.client.launchInstance({
          amiId: p.ami_id as string,
          instanceType: p.instance_type as string,
          subnetId: p.subnet_id as string | undefined,
          securityGroupIds: sgIds,
          keyName: p.key_name as string | undefined,
          name: p.name as string | undefined,
        });
      }

      // ── Destructive ─────────────────────────────────────
      case "aws_terminate_instance":
        return this.client.terminateInstance(p.instance_id as string);

      case "aws_deregister_ami":
        return this.client.deregisterImage(p.image_id as string);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Cluster State ───────────────────────────────────────

  async getClusterState(): Promise<ClusterState> {
    const [rawInstances, rawVolumes] = await Promise.all([
      this.client.listInstances(),
      this.client.listVolumes(),
    ]);

    // Map EC2 instances -> VMInfo
    const vms: VMInfo[] = rawInstances.map((inst) => ({
      id: inst.instanceId,
      name: inst.name || inst.instanceId,
      node: inst.availabilityZone,
      status: this.mapInstanceState(inst.state),
      cpu_cores: 0,  // Not available from instance summary
      ram_mb: 0,     // Not available from instance summary
      disk_gb: 0,
      ip_address: inst.publicIp ?? inst.privateIp,
      os: inst.platform,
    }));

    // Map EBS volumes -> StorageInfo
    const storage: StorageInfo[] = rawVolumes.map((vol) => ({
      id: vol.volumeId,
      node: vol.availabilityZone,
      type: vol.volumeType,
      total_gb: vol.size,
      used_gb: 0,  // EBS doesn't expose used space at the API level
      available_gb: vol.size,
      content: vol.attachments.map((att) => att.instanceId).filter(Boolean),
    }));

    return {
      adapter: ADAPTER_NAME,
      nodes: [],  // AWS doesn't have user-visible "nodes"
      vms,
      containers: [],  // AWS EC2 doesn't have containers
      storage,
      timestamp: new Date().toISOString(),
    };
  }

  private mapInstanceState(state: EC2InstanceState): VMInfo["status"] {
    switch (state) {
      case "running":
        return "running";
      case "stopped":
        return "stopped";
      case "terminated":
        return "stopped";
      case "pending":
      case "shutting-down":
      case "stopping":
        return "unknown";
      default:
        return "unknown";
    }
  }
}
