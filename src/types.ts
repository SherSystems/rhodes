// ============================================================
// vClaw — Core Types
// The type system that powers the autonomous infrastructure agent
// ============================================================

// Re-export provider types so existing imports from "../types.js" still work
export type {
  ActionTier,
  ToolParam,
  ToolDefinition,
  ToolCallResult,
  InfraAdapter,
  ClusterState,
  NodeInfo,
  VMInfo,
  ContainerInfo,
  StorageInfo,
  ProviderType,
  ProviderConfig,
  MultiClusterState,
} from "./providers/types.js";

// ── Agent Core ───────────────────────────────────────────────

import type { ActionTier } from "./providers/types.js";

export type AgentMode = "build" | "watch" | "investigate";

export interface Goal {
  id: string;
  mode: AgentMode;
  description: string;
  raw_input: string;
  created_at: string;
}

export type StepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "rolled_back";

export interface PlanStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  description: string;
  depends_on: string[];
  status: StepStatus;
  result?: StepResult;
  tier: ActionTier;
  estimated_duration_ms?: number;
}

export interface Plan {
  id: string;
  goal_id: string;
  steps: PlanStep[];
  created_at: string;
  status: "pending" | "approved" | "executing" | "completed" | "failed" | "rolled_back";
  resource_estimate: ResourceEstimate;
  reasoning: string;
  revision: number;
  previous_plan_id?: string;
}

export interface StepResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
  state_before?: Record<string, unknown>;
  state_after?: Record<string, unknown>;
  timestamp: string;
}

export interface ResourceEstimate {
  ram_mb: number;
  disk_gb: number;
  cpu_cores: number;
  vms_created: number;
  containers_created: number;
}

// ── Replanning ───────────────────────────────────────────────

export interface ReplanEvent {
  plan_id: string;
  failed_step_id: string;
  failure_reason: string;
  new_plan_id: string;
  reasoning: string;
  timestamp: string;
}

// ── Investigation ────────────────────────────────────────────

export interface Investigation {
  id: string;
  trigger: string;
  findings: InvestigationFinding[];
  root_cause: string;
  proposed_fix?: ProposedFix;
  timestamp: string;
}

export interface InvestigationFinding {
  source: string;
  detail: string;
  severity: "info" | "warning" | "critical";
}

export interface ProposedFix {
  description: string;
  steps: PlanStep[];
  confidence: "low" | "medium" | "high";
  requires_approval: boolean;
}

// ── Governance ───────────────────────────────────────────────

export type ApprovalMode =
  | "approve_plan"
  | "approve_risky"
  | "approve_all"
  | "auto";

export interface PolicyConfig {
  version: number;
  approval: {
    build_mode: ApprovalMode;
    watch_mode: ApprovalMode;
    investigate_mode: ApprovalMode;
  };
  orchestration: {
    approval: {
      explicit_tiers: ActionTier[];
    };
    rollback: {
      enabled: boolean;
      trigger_tiers: ActionTier[];
      timeout_s: number;
    };
  };
  guardrails: {
    max_vms_per_action: number;
    max_ram_allocation_pct: number;
    max_disk_allocation_pct: number;
    require_snapshot_before_modify: boolean;
    cooldown_between_restarts_s: number;
    max_restart_attempts: number;
  };
  boundaries: {
    allowed_networks: string[];
    allowed_storage: string[];
    forbidden_vmids: number[];
    forbidden_actions: string[];
  };
  audit: {
    log_all_actions: boolean;
    log_reasoning: boolean;
    log_rejected_plans: boolean;
    retention_days: number;
  };
}

export interface ApprovalRequest {
  id: string;
  action: string;
  tier: ActionTier;
  params: Record<string, unknown>;
  reasoning: string;
  plan_id?: string;
  step_id?: string;
  timestamp: string;
}

export interface ApprovalResponse {
  request_id: string;
  approved: boolean;
  approved_by?: string;
  method: "cli" | "dashboard" | "auto";
  timestamp: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  tier: ActionTier;
  approval?: ApprovalResponse;
  reasoning: string;
  params: Record<string, unknown>;
  result: "success" | "failed" | "blocked" | "rolled_back";
  error?: string;
  state_before?: Record<string, unknown>;
  state_after?: Record<string, unknown>;
  plan_id?: string;
  step_id?: string;
  duration_ms: number;
}

export interface CircuitBreakerState {
  consecutive_failures: number;
  last_failure_at?: string;
  tripped: boolean;
  tripped_at?: string;
  cooldown_until?: string;
}

// ── Memory ───────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  type: "preference" | "pattern" | "failure" | "environment";
  key: string;
  value: string;
  confidence: number;
  created_at: string;
  last_used_at: string;
  use_count: number;
}

// ── Autopilot ────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export interface HealthCheck {
  target: string;
  type: "vm_status" | "service_status" | "resource_threshold" | "connectivity";
  status: "healthy" | "degraded" | "unhealthy";
  message: string;
  timestamp: string;
}

export interface AutopilotRule {
  id: string;
  name: string;
  condition: string;
  action: string;
  params: Record<string, unknown>;
  tier: ActionTier;
  enabled: boolean;
  cooldown_s: number;
  last_triggered_at?: string;
}

export interface Alert {
  id: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  timestamp: string;
  acknowledged: boolean;
  resolved: boolean;
  auto_healed: boolean;
  investigation_id?: string;
}

// ── Events (for dashboard streaming) ─────────────────────────

export enum AgentEventType {
  RunStarted = "run_started",
  RunCompleted = "run_completed",
  RunEscalated = "run_escalated",
  PlanCreated = "plan_created",
  PlanApproved = "plan_approved",
  StepStarted = "step_started",
  StepCompleted = "step_completed",
  StepFailed = "step_failed",
  Replan = "replan",
  InvestigationStarted = "investigation_started",
  InvestigationComplete = "investigation_complete",
  ApprovalRequested = "approval_requested",
  ApprovalReceived = "approval_received",
  CircuitBreakerTripped = "circuit_breaker_tripped",
  AlertFired = "alert_fired",
  AlertResolved = "alert_resolved",
  HealthCheck = "health_check",
  IncidentOpened = "incident_opened",
  IncidentAction = "incident_action",
  IncidentResolved = "incident_resolved",
  IncidentFailed = "incident_failed",
  MetricRecorded = "metric_recorded",
  HealingTick = "healing_tick",
  HealingStarted = "healing_started",
  HealingCompleted = "healing_completed",
  HealingFailed = "healing_failed",
  HealingEscalated = "healing_escalated",
  HealingPaused = "healing_paused",
  PlaybookMatched = "playbook_matched",
  PlaybookExecuted = "playbook_executed",
  PlaybookCooldown = "playbook_cooldown",
  ChaosSimulated = "chaos_simulated",
  ChaosStarted = "chaos_started",
  ChaosRecoveryDetected = "chaos_recovery_detected",
  ChaosCompleted = "chaos_completed",
  ChaosFailed = "chaos_failed",
  IncidentRca = "incident_rca",
  MultiProviderGoalStarted = "multi_provider_goal_started",
  MultiProviderGoalCompleted = "multi_provider_goal_completed",
  MultiProviderQuery = "multi_provider_query",
  CapacityAnalysis = "capacity_analysis",
}

export interface AgentEvent {
  type: AgentEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type EventListener = (event: AgentEvent) => void;

// ── Lab Blueprints ───────────────────────────────────────────

export interface LabBlueprint {
  name: string;
  description: string;
  version: string;
  author?: string;
  resources: ResourceEstimate;
  nodes: LabNode[];
  networking: LabNetwork[];
  post_deploy?: string[];
}

export interface LabNode {
  role: string;
  count: number;
  os?: string;
  iso?: string;
  template?: string;
  ram_mb: number;
  cpu_cores: number;
  disk_gb: number;
  nested_virt?: boolean;
  cpu_flags?: string[];
  cloud_init?: Record<string, unknown>;
}

export interface LabNetwork {
  name: string;
  vlan?: number;
  bridge?: string;
  subnet: string;
  gateway?: string;
  dhcp?: boolean;
}
