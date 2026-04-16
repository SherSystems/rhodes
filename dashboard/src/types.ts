// Dashboard-specific types (mirrors backend types.ts for the frontend)

export type AgentMode = "build" | "watch" | "investigate" | "heal";
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped" | "rolled_back";
export type ActionTier = "read" | "safe_write" | "risky_write" | "destructive" | "never";

export interface NodeInfo {
  id: string;
  name: string;
  status: string;
  cpu_cores: number;
  cpu_usage_pct: number;
  cpu_pct?: number;
  ram_total_mb: number;
  ram_mb?: number;
  ram_used_mb: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_usage_pct: number;
  uptime_s: number;
}

export interface VMInfo {
  id: string;
  vmid?: string;
  name: string;
  node: string;
  status: string;
  cpu_cores: number;
  ram_mb: number;
  disk_gb: number;
  ip_address?: string;
  os?: string;
  uptime_s?: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  node: string;
  status: string;
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

export interface ClusterState {
  nodes: NodeInfo[];
  vms: VMInfo[];
  containers: ContainerInfo[];
  storage: StorageInfo[];
  timestamp: string;
}

export interface PlanStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  description: string;
  depends_on: string[];
  status: StepStatus;
  tier?: ActionTier;
  estimated_duration_ms?: number;
}

export interface Plan {
  id: string;
  goal_id: string;
  steps: PlanStep[];
  created_at: string;
  status: string;
  reasoning?: string;
  revision?: number;
  previous_plan_id?: string;
}

export interface StepState {
  status: StepStatus;
  duration_ms?: number;
  error?: string;
  output?: unknown;
}

export interface AgentEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface Incident {
  id: string;
  severity: "critical" | "warning";
  description: string;
  status: "open" | "healing" | "resolved" | "failed";
  metric_name?: string;
  trigger_value?: number;
  detected_at: string;
  resolved_at?: string;
  duration_ms?: number;
  resolution?: string;
  playbook_id?: string;
  playbook_name?: string;
  actions_taken?: IncidentAction[];
  pattern_id?: string;
  rca?: RootCauseAnalysis;
  vmid?: string;
}

export interface IncidentAction {
  action: string;
  timestamp: string;
  success: boolean;
  detail?: string;
}

export interface RootCauseAnalysis {
  summary: string;
  contributing_factors: string[];
  recommendation: string;
}

export interface HealingBanner {
  type: "paused" | "escalated";
  message: string;
  id: string;
}

export interface HealthSummary {
  resources: {
    cpu_usage_pct: number;
    ram_usage_pct: number;
    disk_usage_pct: number;
    cpu_cores: number;
    ram_total_mb: number;
    ram_used_mb: number;
    disk_total_gb: number;
    disk_used_gb: number;
  };
  nodes: {
    total: number;
    online: number;
  };
  vms: {
    total: number;
    running: number;
  };
  timestamp: string;
}

export interface Prediction {
  metric: string;
  labels: Record<string, string>;
  current: number;
  slope_per_hour: number;
  projected_1h: number;
  projected_6h: number;
  projected_24h: number;
  hours_to_critical: number | null;
  status: "healthy" | "warning" | "critical";
}

export interface RightsizingRec {
  vmid: string;
  name: string;
  node: string;
  cpu_allocated: number;
  cpu_avg_pct: number;
  cpu_peak_pct: number;
  cpu_recommended: number;
  ram_allocated_mb: number;
  ram_avg_pct: number;
  ram_peak_pct: number;
  ram_recommended_mb: number;
  savings_pct: number;
}

export interface ChaosScenario {
  id: string;
  name: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  target_type: "vm" | "node" | "storage" | "network";
  requires_approval: boolean;
  reversible: boolean;
}

export interface ChaosSimulation {
  scenario_id: string;
  affected_vms: { vmid: string; name: string; impact: string }[];
  predicted_recovery_time_s: number;
  risk_score: number;
  recommendation: string;
}

export interface ChaosRun {
  id: string;
  scenario: ChaosScenario;
  status: "simulated" | "executing" | "recovering" | "verifying" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  blast_radius?: ChaosSimulation;
  actual_recovery_time_s?: number;
  resilience_score?: number;
  verdict?: "pass" | "partial" | "fail";
  events?: AgentEvent[];
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  tier: ActionTier;
  result: "success" | "failed" | "blocked" | "rolled_back";
  duration_ms?: number;
  plan_id?: string;
  step_id?: string;
  reasoning?: string;
  params?: Record<string, unknown>;
  error?: string;
  approval?: string;
}

export interface RunTelemetrySummary {
  window: {
    from: string;
    to: string;
    days: number;
  };
  totals: {
    runs_started: number;
    runs_completed: number;
    successful_runs: number;
    failed_runs: number;
    success_rate_pct: number;
    complete_envelopes: number;
    envelope_completeness_pct: number;
  };
  latency: {
    p50_ms: number | null;
    p95_ms: number | null;
    avg_ms: number | null;
  };
  approval: {
    total_wait_ms: number;
    avg_wait_ms: number;
  };
  retries: {
    total: number;
    avg_per_run: number;
  };
  escalations: {
    total: number;
    rate_pct: number;
  };
  slo: {
    targets: {
      p95_latency_ms: number;
      success_rate_pct: number;
    };
    breached: boolean;
    latency_p95_breached: boolean;
    success_rate_breached: boolean;
  };
}

export interface Toast {
  id: string;
  type: "error" | "warning" | "success" | "info";
  title: string;
  message: string;
  timestamp: string;
}

// Migration types
export type MigrationDirection = "vmware_to_proxmox" | "proxmox_to_vmware" | "vmware_to_aws" | "aws_to_vmware" | "proxmox_to_aws" | "aws_to_proxmox";
export type MigrationStatus = "pending" | "exporting" | "converting" | "transferring" | "importing" | "completed" | "failed";

export interface MigrationStep {
  name: string;
  status: "pending" | "completed" | "failed";
  detail?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface MigrationPlan {
  id: string;
  direction: MigrationDirection;
  status: MigrationStatus;
  source: {
    provider: "vmware" | "proxmox" | "aws";
    vmId: string;
    vmName: string;
    host: string;
  };
  target: {
    provider: "vmware" | "proxmox" | "aws";
    node: string;
    host: string;
    storage: string;
    vmId?: number;
    instanceType?: string;
    subnetId?: string;
    securityGroupIds?: string[];
    amiId?: string;
  };
  analysis?: any;
  vmConfig: {
    name: string;
    cpuCount: number;
    coresPerSocket: number;
    memoryMiB: number;
    guestOS: string;
    firmware: string;
    disks: { label: string; capacityBytes: number }[];
    nics: { label: string; macAddress?: string }[];
  };
  steps: MigrationStep[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface MigrationVM {
  id: string;
  name: string;
  provider: "vmware" | "proxmox";
  status: string;
  cpu: number;
  memoryMiB: number;
  diskGB: number;
}

export interface ProviderClusterState {
  name: string;
  type: string;
  state: ClusterState;
}

export interface MultiClusterState {
  providers: ProviderClusterState[];
  timestamp: string;
}

// Application Topology types
export type WorkloadType = 'vm' | 'container' | 'pod' | 'service';
export type AppTier = 'production' | 'staging' | 'development' | 'test';

export interface Application {
  id: string;
  name: string;
  tier: AppTier;
  owner?: string;
  description?: string;
  tags: string[];
  members: AppMember[];
  dependencies: AppDependency[];
  createdAt: string;
  updatedAt: string;
}

export interface AppMember {
  id: string;
  appId: string;
  workloadId: string;
  workloadType: WorkloadType;
  provider: string;
  role: string;
  critical: boolean;
  name?: string;
  ipAddress?: string;
}

export interface AppDependency {
  id: string;
  appId: string;
  fromWorkloadId: string;
  toWorkloadId: string;
  port: number;
  protocol: string;
  service: string;
  latencyRequirement: string;
  description?: string;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface TopologyNode {
  id: string;
  name: string;
  workloadType: WorkloadType;
  provider: string;
  role: string;
  critical: boolean;
  status?: string;
  ipAddress?: string;
  appIds: string[];
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  port: number;
  service: string;
  protocol: string;
  appId: string;
}

export interface ImpactReport {
  targetWorkloadId: string;
  targetName: string;
  affectedApps: {
    app: Application;
    brokenDependencies: AppDependency[];
    severity: 'critical' | 'warning' | 'info';
  }[];
  totalAffectedApps: number;
  totalBrokenDependencies: number;
}

export type TabId = "topology" | "plan" | "resources" | "nodes" | "incidents" | "governance" | "chaos" | "migrations" | "apps";
