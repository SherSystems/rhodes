// ============================================================
// vClaw — Provider Types
// Shared interfaces for all infrastructure providers
// ============================================================

// ── Tool System ─────────────────────────────────────────────

export type ActionTier = "read" | "safe_write" | "risky_write" | "destructive" | "never";

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  tier: ActionTier;
  adapter: string;
  params: ToolParam[];
  returns: string;
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── Infrastructure State ────────────────────────────────────

export interface ClusterState {
  adapter: string;
  nodes: NodeInfo[];
  vms: VMInfo[];
  containers: ContainerInfo[];
  storage: StorageInfo[];
  timestamp: string;
}

export interface NodeInfo {
  id: string;
  name: string;
  status: "online" | "offline" | "unknown";
  cpu_cores: number;
  cpu_usage_pct: number;
  ram_total_mb: number;
  ram_used_mb: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_usage_pct: number;
  uptime_s: number;
}

export interface VMInfo {
  id: string | number;
  name: string;
  node: string;
  status: "running" | "stopped" | "paused" | "unknown";
  cpu_cores: number;
  ram_mb: number;
  disk_gb: number;
  ip_address?: string;
  os?: string;
  uptime_s?: number;
  /** Cloud-provider sizing identifier when applicable (e.g. AWS instance_type, Azure vmSize). */
  instance_type?: string;
}

export interface ContainerInfo {
  id: string | number;
  name: string;
  node: string;
  status: "running" | "stopped" | "unknown";
  cpu_cores: number;
  ram_mb: number;
  disk_gb: number;
  ip_address?: string;
  os?: string;
}

export interface StorageInfo {
  id: string;
  node: string;
  type: string;
  total_gb: number;
  used_gb: number;
  available_gb: number;
  content: string[];
}

// ── Provider Interface ──────────────────────────────────────

/**
 * Discriminator for what an adapter actually represents.
 *
 * - "hypervisor": owns infrastructure (nodes, VMs, storage). Shows up
 *   in the dashboard's provider overview and in `getMultiClusterState`.
 *   Examples: proxmox, vmware, aws, azure, kubernetes.
 * - "service": utility adapter that provides tools but does NOT own
 *   cluster state (returns an empty ClusterState). Hidden from the
 *   provider overview. Examples: system, migration, topology.
 * - "planner": planning/orchestration adapter — produces plans, never
 *   touches infra directly. Hidden from the provider overview.
 *   Examples: provisioning.
 *
 * Default is "hypervisor" if omitted (preserves the historical contract
 * for the existing infra providers).
 */
export type AdapterKind = "hypervisor" | "service" | "planner";

export interface InfraAdapter {
  name: string;
  /** What kind of adapter this is. Defaults to "hypervisor" if omitted. */
  kind?: AdapterKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getTools(): ToolDefinition[];
  execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult>;
  getClusterState(): Promise<ClusterState>;
}

// ── Provider Configuration ──────────────────────────────────

export type ProviderType = "proxmox" | "vmware" | "system" | "kubernetes" | "aws" | "azure";

export interface ProviderConfig {
  type: ProviderType;
  name: string;
  enabled: boolean;
  connection: Record<string, unknown>;
}

// ── Multi-Provider State ────────────────────────────────────

export interface MultiClusterState {
  providers: {
    name: string;
    type: ProviderType;
    state: ClusterState;
  }[];
  timestamp: string;
}
