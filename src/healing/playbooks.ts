import { randomUUID } from "node:crypto";
import { AgentEventType } from "../types.js";
import type { Goal, AgentEvent } from "../types.js";
import type { EventBus } from "../agent/events.js";
import { jellyfinConfigFromEnv } from "../playbooks/service-http-probe.js";

// ── Anomaly ─────────────────────────────────────────────────

export interface Anomaly {
  id: string;
  type: "threshold" | "trend" | "spike" | "flatline" | "state_change";
  severity: "warning" | "critical";
  metric: string;
  labels: Record<string, string>;
  current_value: number;
  message: string;
  detected_at: string;
}

// ── Playbook Types ──────────────────────────────────────────

export interface AnomalyTrigger {
  metric: string;
  type: "threshold" | "trend" | "spike" | "flatline" | "state_change";
  severity?: "warning" | "critical";
  labels?: Record<string, string>;
}

export interface HealingAction {
  type:
    | "restart_vm"
    | "migrate_vm"
    | "expand_disk"
    | "cleanup_snapshots"
    | "rebalance_cluster"
    | "custom_goal";
  params: Record<string, unknown>;
  description: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  trigger: AnomalyTrigger;
  actions: HealingAction[];
  cooldown_minutes: number;
  requires_approval: boolean;
  max_retries: number;
}

// ── Execution Record ────────────────────────────────────────

interface ExecutionRecord {
  playbook_id: string;
  anomaly_id: string;
  success: boolean;
  executed_at: string;
}

// ── Playbook Engine ─────────────────────────────────────────

export class PlaybookEngine {
  private playbooks: Map<string, Playbook> = new Map();
  private executions: ExecutionRecord[] = [];
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  register(playbook: Playbook): void {
    this.playbooks.set(playbook.id, playbook);
  }

  unregister(playbookId: string): void {
    this.playbooks.delete(playbookId);
  }

  getAll(): Playbook[] {
    return [...this.playbooks.values()];
  }

  get(playbookId: string): Playbook | undefined {
    return this.playbooks.get(playbookId);
  }

  /**
   * Returns EVERY registered playbook whose trigger matches the given
   * anomaly, minus any that are currently on cooldown.
   *
   * Multi-match semantics (v0.4.6 fix): when two playbooks share the same
   * trigger — e.g. `jellyfin-service-probe` and `vm_in_guest_diagnostic`
   * both register `metric: service_http_status, type: state_change,
   * severity: critical` — both are returned. The downstream consumer
   * (HealingEngine) fires each independently, each respecting its own
   * `cooldown_minutes`, `requires_approval`, and `max_retries`.
   *
   * Prior behaviour: the engine took `match(anomaly)[0]` and silently
   * dropped the rest, which made the "service restart didn't help →
   * escalate to in-VM diagnostic" chain promised in the v0.4.4 release
   * notes a no-op. See `tests/healing/orchestrator-trigger-collision.test.ts`.
   */
  match(anomaly: Anomaly): Playbook[] {
    const matched: Playbook[] = [];

    for (const playbook of this.playbooks.values()) {
      if (!this.triggerMatches(playbook.trigger, anomaly)) continue;
      if (this.isOnCooldown(playbook.id)) {
        this.emitEvent(AgentEventType.PlaybookCooldown, {
          playbook_id: playbook.id,
          playbook_name: playbook.name,
          anomaly_id: anomaly.id,
        });
        continue;
      }
      matched.push(playbook);
    }

    if (matched.length > 0) {
      this.emitEvent(AgentEventType.PlaybookMatched, {
        playbook_ids: matched.map((p) => p.id),
        playbook_names: matched.map((p) => p.name),
        anomaly_id: anomaly.id,
        anomaly_metric: anomaly.metric,
        anomaly_severity: anomaly.severity,
      });
    }

    return matched;
  }

  toGoal(playbook: Playbook, anomaly: Anomaly): Goal {
    const description = this.buildGoalDescription(playbook, anomaly);

    return {
      id: randomUUID(),
      mode: playbook.requires_approval ? "build" : "watch",
      description,
      raw_input: JSON.stringify({
        source: "self-healing",
        playbook_id: playbook.id,
        anomaly_id: anomaly.id,
        actions: playbook.actions,
        anomaly_labels: anomaly.labels,
        anomaly_value: anomaly.current_value,
      }),
      created_at: new Date().toISOString(),
    };
  }

  recordExecution(
    playbookId: string,
    anomalyId: string,
    success: boolean,
  ): void {
    this.executions.push({
      playbook_id: playbookId,
      anomaly_id: anomalyId,
      success,
      executed_at: new Date().toISOString(),
    });

    this.emitEvent(AgentEventType.PlaybookExecuted, {
      playbook_id: playbookId,
      anomaly_id: anomalyId,
      success,
    });
  }

  isOnCooldown(playbookId: string): boolean {
    const playbook = this.playbooks.get(playbookId);
    if (!playbook) return false;

    const lastExecution = this.findLastExecution(playbookId);
    if (!lastExecution) return false;

    const cooldownMs = playbook.cooldown_minutes * 60 * 1000;
    const elapsed = Date.now() - new Date(lastExecution.executed_at).getTime();
    return elapsed < cooldownMs;
  }

  getExecutionHistory(playbookId?: string): ExecutionRecord[] {
    if (!playbookId) return [...this.executions];
    return this.executions.filter((e) => e.playbook_id === playbookId);
  }

  // ── Private ─────────────────────────────────────────────────

  private triggerMatches(trigger: AnomalyTrigger, anomaly: Anomaly): boolean {
    if (trigger.metric !== anomaly.metric) return false;
    if (trigger.type !== anomaly.type) return false;
    if (trigger.severity && trigger.severity !== anomaly.severity) return false;

    if (trigger.labels) {
      for (const [key, value] of Object.entries(trigger.labels)) {
        if (anomaly.labels[key] !== value) return false;
      }
    }

    return true;
  }

  private findLastExecution(playbookId: string): ExecutionRecord | undefined {
    for (let i = this.executions.length - 1; i >= 0; i--) {
      if (this.executions[i].playbook_id === playbookId) {
        return this.executions[i];
      }
    }
    return undefined;
  }

  private buildGoalDescription(playbook: Playbook, anomaly: Anomaly): string {
    const labels = anomaly.labels;

    switch (playbook.id) {
      case "vm_unresponsive":
        return `Restart VM ${labels.vmid || "unknown"} on ${labels.node || "unknown"} — it stopped responding`;

      case "node_memory_critical":
        return `Migrate lightest VM off ${labels.node || "unknown"} — node memory at ${anomaly.current_value}%`;

      case "disk_space_critical":
        return `Free disk space on ${labels.storage || labels.node || "unknown"} — usage at ${anomaly.current_value}%, clean snapshots and expand if needed`;

      case "node_cpu_overload":
        return `Rebalance load on ${labels.node || "unknown"} — CPU sustained at ${anomaly.current_value}%, migrate heaviest VM to least-loaded node`;

      case "vm_crashed":
        return `Recover crashed VM ${labels.vmid || "unknown"} on ${labels.node || "unknown"} — unexpected stop detected`;

      case "predictive_disk_full":
        return `Prevent disk full on ${labels.storage || labels.node || "unknown"} — trend predicts full within 48 hours, cleanup snapshots`;

      case "proxmox_storage_exhaustion_pause":
        return `STORAGE_EXHAUSTION_PAUSE: VM ${labels.vmid || "unknown"} on ${labels.node || "unknown"} is paused (io-error). Run proxmox-storage-pause playbook — prune snapshots, qm resume, verify.`;

      case "jellyfin-service-probe":
        return `SERVICE_DOWN/UNHEALTHY: in-VM service "${labels.service_name || "jellyfin"}" failed its HTTP probe. Run service-http-probe playbook — ping, systemctl is-active, restart, verify.`;

      default:
        return `Execute healing playbook "${playbook.name}" — ${anomaly.message}`;
    }
  }

  private emitEvent(type: AgentEventType, data: Record<string, unknown>): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

// ── Default Playbooks ───────────────────────────────────────

export const DEFAULT_PLAYBOOKS: Playbook[] = [
  {
    id: "vm_unresponsive",
    name: "VM Unresponsive",
    description:
      "Restarts a VM that has stopped responding and verifies recovery",
    trigger: {
      metric: "vm_status",
      type: "flatline",
      severity: "critical",
    },
    actions: [
      {
        type: "restart_vm",
        params: { force: false, wait_for_agent: true, timeout_s: 120 },
        description: "Gracefully restart the unresponsive VM",
      },
      {
        type: "custom_goal",
        params: { goal: "Verify VM is running and network-reachable" },
        description: "Confirm the VM recovered successfully",
      },
    ],
    cooldown_minutes: 15,
    requires_approval: false,
    max_retries: 2,
  },
  {
    id: "node_memory_critical",
    name: "Node Memory Critical",
    description:
      "Migrates the lightest VM to the least-loaded node when memory exceeds 90%",
    trigger: {
      metric: "node_memory_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "migrate_vm",
        params: {
          select: "lightest_by_ram",
          target: "least_loaded_node",
          live: true,
        },
        description:
          "Live-migrate the lightest VM to the least-loaded node",
      },
    ],
    cooldown_minutes: 30,
    requires_approval: false,
    max_retries: 1,
  },
  {
    id: "disk_space_critical",
    name: "Disk Space Critical",
    description:
      "Cleans old snapshots first, then expands storage if still critical",
    trigger: {
      metric: "disk_usage_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "cleanup_snapshots",
        params: { older_than_days: 7, keep_minimum: 1 },
        description: "Remove snapshots older than 7 days, keeping at least one",
      },
      {
        type: "expand_disk",
        params: { increment_gb: 20, max_total_gb: 500 },
        description: "Expand storage by 20 GB if cleanup was insufficient",
      },
    ],
    cooldown_minutes: 60,
    requires_approval: true,
    max_retries: 1,
  },
  {
    id: "node_cpu_overload",
    name: "Node CPU Overload",
    description:
      "Migrates the heaviest VM to the least-loaded node when CPU exceeds 90% sustained",
    trigger: {
      metric: "node_cpu_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "migrate_vm",
        params: {
          select: "heaviest_by_cpu",
          target: "least_loaded_node",
          live: true,
        },
        description:
          "Live-migrate the heaviest VM to the least-loaded node",
      },
    ],
    cooldown_minutes: 30,
    requires_approval: false,
    max_retries: 1,
  },
  {
    id: "vm_crashed",
    name: "VM Crashed",
    description:
      "Restarts a VM that stopped unexpectedly and fires an alert",
    trigger: {
      metric: "vm_status",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "restart_vm",
        params: { force: true, wait_for_agent: true, timeout_s: 180 },
        description: "Force-start the crashed VM",
      },
      {
        type: "custom_goal",
        params: {
          goal: "Alert operator that VM crashed and was auto-restarted",
        },
        description: "Send crash notification to the operator",
      },
    ],
    cooldown_minutes: 10,
    requires_approval: false,
    max_retries: 3,
  },
  {
    id: "proxmox_storage_exhaustion_pause",
    name: "Proxmox Storage-Exhaustion Pause",
    description:
      "Recognizes paused (io-error) on a Proxmox VM as a thin-pool exhaustion event, " +
      "prunes snapshots, resumes the VM, and verifies recovery. " +
      "See docs/playbooks/proxmox-storage-pause.md.",
    trigger: {
      metric: "vm_status",
      type: "state_change",
      severity: "critical",
      labels: { reason: "paused_io_error" },
    },
    actions: [
      {
        type: "custom_goal",
        params: {
          goal:
            "Execute proxmox-storage-pause playbook: inspect qm monitor info status, " +
            "confirm paused (io-error), inspect pvesm/lvs, rank snapshots, " +
            "request operator approval for qm delsnapshot commands, then qm resume.",
          playbook_module: "src/playbooks/proxmox-storage-pause.ts",
          event_class: "STORAGE_EXHAUSTION_PAUSE",
        },
        description:
          "Run the storage-exhaustion-pause diagnostic + remediation chain",
      },
    ],
    cooldown_minutes: 10,
    requires_approval: true,
    max_retries: 1,
  },
  {
    id: "jellyfin-service-probe",
    name: "Jellyfin Service Probe",
    description:
      "HTTP probe + auto-restart for the Jellyfin media service inside the JellyFinServer VM (vmid 101). " +
      "Reusable template for any in-VM HTTP service — see src/playbooks/service-http-probe.ts. " +
      "Detects 'VM up, service down' by probing the in-guest HTTP endpoint; classifies via systemctl; " +
      "auto-restarts at Tier 2 with a 3-restart / 30-min loop guard.",
    trigger: {
      metric: "service_http_status",
      type: "state_change",
      severity: "critical",
      labels: { service_name: "jellyfin" },
    },
    actions: [
      {
        type: "custom_goal",
        params: {
          goal:
            "Execute service-http-probe playbook for jellyfin: ping VM, " +
            "systemctl is-active jellyfin, restart on SERVICE_DOWN / SERVICE_UNHEALTHY, " +
            "verify recovery over 30s. Hand off if VM is unreachable.",
          playbook_module: "src/playbooks/service-http-probe.ts",
          event_class: "SERVICE_DOWN",
          service_config: jellyfinConfigFromEnv(),
        },
        description:
          "Run the service-http-probe diagnostic + restart chain for Jellyfin",
      },
    ],
    cooldown_minutes: 5,
    requires_approval: false,
    max_retries: 2,
  },
  {
    id: "vm_in_guest_diagnostic",
    name: "In-VM Diagnostic & Remediation",
    description:
      "Agentic in-VM diagnosis when an app-level probe trips. SSHes into the VM, runs " +
      "df/free/journalctl/dmesg/systemctl, classifies the failure mode, proposes a " +
      "remediation plan (vacuum logs, restart service, clean apt cache, etc.) and " +
      "executes after operator approval. See src/playbooks/vm-diagnostic.ts.",
    trigger: {
      metric: "service_http_status",
      type: "state_change",
      severity: "critical",
      // No labels filter — applies to any service that has an http probe configured.
    },
    actions: [
      {
        type: "custom_goal",
        params: {
          goal:
            "Execute vm-diagnostic playbook: SSH into the service VM, run the 9-command diagnostic " +
            "sweep (df -h, free -h, uptime, systemctl --failed, journalctl --since=10min, dmesg, " +
            "ss -tlnp, systemctl status <service>), classify failure modes, and propose a tiered " +
            "remediation plan. Wait for operator approval before any risky_write or destructive action.",
          playbook_module: "src/playbooks/vm-diagnostic.ts",
          event_class: "VM_APP_UNREACHABLE",
        },
        description: "Run the in-VM diagnostic + remediation chain",
      },
    ],
    cooldown_minutes: 15,
    requires_approval: true,
    max_retries: 1,
  },
  {
    id: "predictive_disk_full",
    name: "Predictive Disk Full",
    description:
      "Proactively cleans snapshots when trend analysis predicts disk full within 48 hours",
    trigger: {
      metric: "disk_usage_pct",
      type: "trend",
      severity: "warning",
    },
    actions: [
      {
        type: "custom_goal",
        params: {
          goal: "Alert operator: disk projected to be full within 48 hours",
        },
        description: "Warn operator about impending disk capacity issue",
      },
      {
        type: "cleanup_snapshots",
        params: { older_than_days: 3, keep_minimum: 2 },
        description:
          "Preemptively remove snapshots older than 3 days, keeping at least two",
      },
    ],
    cooldown_minutes: 360,
    requires_approval: false,
    max_retries: 1,
  },
];
