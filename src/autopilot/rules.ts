// ============================================================
// vClaw — Autopilot Rules Engine
// Self-healing rules that evaluate cluster state changes and
// produce actionable matches for the autopilot daemon.
// ============================================================

import type {
  AutopilotRule,
  ClusterState,
  VMInfo,
  NodeInfo,
} from "../types.js";
import type { ProbeScheduler } from "./probes/scheduler.js";

// ── RuleMatch ───────────────────────────────────────────────

export interface RuleMatch {
  rule: AutopilotRule;
  trigger: string;
  action: string;
  params: Record<string, unknown>;
}

// ── Default Rules ───────────────────────────────────────────

export const DEFAULT_RULES: AutopilotRule[] = [
  {
    id: "vm_auto_restart",
    name: "Auto-restart stopped VMs",
    condition: "vm_was_running_now_stopped",
    action: "start_vm",
    params: {},
    tier: "safe_write",
    enabled: true,
    cooldown_s: 120,
  },
  {
    id: "resource_alert_ram",
    name: "High RAM usage alert",
    condition: "node_ram_above_90",
    action: "alert",
    params: { severity: "warning" },
    tier: "read",
    enabled: true,
    cooldown_s: 300,
  },
  {
    id: "resource_alert_disk",
    name: "Critical disk usage alert",
    condition: "storage_above_95",
    action: "alert",
    params: { severity: "critical" },
    tier: "read",
    enabled: true,
    cooldown_s: 300,
  },
  {
    id: "node_offline_alert",
    name: "Node offline alert",
    condition: "node_went_offline",
    action: "alert",
    params: { severity: "critical" },
    tier: "read",
    enabled: true,
    cooldown_s: 60,
  },
  {
    id: "service_unreachable_restart",
    name: "Restart VMs whose service health probe has failed",
    condition: "service_unreachable",
    action: "restart_vm",
    // tier intentionally raised: the VM is RUNNING-but-unhealthy, so a
    // power-cycle is materially riskier than the start_vm rule which
    // only ever targets stopped VMs. Forces governance every time.
    params: { severity: "critical" },
    tier: "risky_write",
    enabled: true,
    cooldown_s: 600,
    per_entity_cooldown_s: 600,
  },
  {
    id: "provider_unreachable_alert",
    name: "Alert when a provider adapter is unreachable",
    condition: "provider_unreachable",
    action: "alert",
    // No automatic remediation — adapter connection failures usually
    // mean creds or network, neither of which autopilot can fix safely.
    params: { severity: "critical" },
    tier: "read",
    enabled: true,
    cooldown_s: 600,
    per_entity_cooldown_s: 600,
  },
];

// ── Rule Evaluation ─────────────────────────────────────────

/**
 * Evaluate all enabled rules against the current and previous cluster state.
 * Returns an array of RuleMatch objects for rules whose conditions are met
 * and whose cooldown period has elapsed.
 *
 * The optional `probeScheduler` lets the engine evaluate probe-driven
 * conditions (`service_unreachable`, `provider_unreachable`). When
 * absent, those conditions return no matches — keeping the engine
 * usable in tests and pre-probe-config environments.
 */
export function evaluateRules(
  rules: AutopilotRule[],
  currentState: ClusterState,
  previousState: ClusterState | null,
  now: Date,
  probeScheduler?: ProbeScheduler,
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Check cooldown
    if (rule.last_triggered_at) {
      const lastTriggered = new Date(rule.last_triggered_at).getTime();
      const cooldownMs = rule.cooldown_s * 1000;
      if (now.getTime() - lastTriggered < cooldownMs) {
        continue;
      }
    }

    const ruleMatches = evaluateCondition(
      rule,
      currentState,
      previousState,
      probeScheduler,
    );
    matches.push(...ruleMatches);
  }

  return matches;
}

// ── Condition Evaluators ────────────────────────────────────

function evaluateCondition(
  rule: AutopilotRule,
  currentState: ClusterState,
  previousState: ClusterState | null,
  probeScheduler?: ProbeScheduler,
): RuleMatch[] {
  switch (rule.condition) {
    case "vm_was_running_now_stopped":
      return checkVmStopped(rule, currentState, previousState);

    case "node_ram_above_90":
      return checkNodeRam(rule, currentState);

    case "storage_above_95":
      return checkStorageUsage(rule, currentState);

    case "node_went_offline":
      return checkNodeOffline(rule, currentState, previousState);

    case "service_unreachable":
      return checkServiceUnreachable(rule, currentState, probeScheduler);

    case "provider_unreachable":
      return checkProviderUnreachable(rule, probeScheduler);

    default:
      return [];
  }
}

/**
 * Detect VMs that were running in the previous state but are now stopped.
 */
function checkVmStopped(
  rule: AutopilotRule,
  currentState: ClusterState,
  previousState: ClusterState | null,
): RuleMatch[] {
  if (!previousState) return [];

  const matches: RuleMatch[] = [];

  // Build a map of previous VM states
  const prevVmMap = new Map<string | number, VMInfo>();
  for (const vm of previousState.vms) {
    prevVmMap.set(vm.id, vm);
  }

  for (const vm of currentState.vms) {
    const prevVm = prevVmMap.get(vm.id);
    if (
      prevVm &&
      prevVm.status === "running" &&
      vm.status === "stopped"
    ) {
      matches.push({
        rule,
        trigger: `VM "${vm.name}" (${vm.id}) was running but is now stopped on node ${vm.node}`,
        action: rule.action,
        params: {
          vmid: vm.id,
          node: vm.node,
          vm_name: vm.name,
        },
      });
    }
  }

  return matches;
}

/**
 * Detect nodes with RAM usage above 90%.
 */
function checkNodeRam(
  rule: AutopilotRule,
  currentState: ClusterState,
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const node of currentState.nodes) {
    if (node.status !== "online" || node.ram_total_mb === 0) continue;

    const ramPct = (node.ram_used_mb / node.ram_total_mb) * 100;
    if (ramPct > 90) {
      matches.push({
        rule,
        trigger: `Node "${node.name}" RAM usage at ${ramPct.toFixed(1)}% (${node.ram_used_mb}/${node.ram_total_mb} MB)`,
        action: rule.action,
        params: {
          node: node.name,
          ram_pct: Math.round(ramPct * 10) / 10,
          ram_used_mb: node.ram_used_mb,
          ram_total_mb: node.ram_total_mb,
          severity: rule.params.severity ?? "warning",
        },
      });
    }
  }

  return matches;
}

/**
 * Detect storage pools with usage above 95%.
 */
function checkStorageUsage(
  rule: AutopilotRule,
  currentState: ClusterState,
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const storage of currentState.storage) {
    if (storage.total_gb === 0) continue;

    const usedPct = (storage.used_gb / storage.total_gb) * 100;
    if (usedPct > 95) {
      matches.push({
        rule,
        trigger: `Storage "${storage.id}" on ${storage.node} at ${usedPct.toFixed(1)}% (${storage.used_gb}/${storage.total_gb} GB)`,
        action: rule.action,
        params: {
          storage_id: storage.id,
          node: storage.node,
          used_pct: Math.round(usedPct * 10) / 10,
          used_gb: storage.used_gb,
          total_gb: storage.total_gb,
          severity: rule.params.severity ?? "critical",
        },
      });
    }
  }

  return matches;
}

/**
 * Detect nodes that went from online to offline.
 */
function checkNodeOffline(
  rule: AutopilotRule,
  currentState: ClusterState,
  previousState: ClusterState | null,
): RuleMatch[] {
  if (!previousState) return [];

  const matches: RuleMatch[] = [];

  const prevNodeMap = new Map<string, NodeInfo>();
  for (const node of previousState.nodes) {
    prevNodeMap.set(node.id, node);
  }

  for (const node of currentState.nodes) {
    const prevNode = prevNodeMap.get(node.id);
    if (
      prevNode &&
      prevNode.status === "online" &&
      node.status === "offline"
    ) {
      matches.push({
        rule,
        trigger: `Node "${node.name}" went offline (was online in previous check)`,
        action: rule.action,
        params: {
          node: node.name,
          node_id: node.id,
          severity: rule.params.severity ?? "critical",
        },
      });
    }
  }

  return matches;
}

/**
 * Detect VMs whose service-health probe is in the "alerting" phase
 * (consecutive_failures >= failures_to_alert). One match per probe;
 * the daemon then routes the match through governance and, if approved,
 * dispatches a `restart_vm` against the configured target VM.
 *
 * The probe state (and per-(probe, target) cooldowns) live in the
 * `ProbeScheduler` rather than on the rule, so a flapping VM doesn't
 * get power-cycled in a loop.
 */
function checkServiceUnreachable(
  rule: AutopilotRule,
  currentState: ClusterState,
  probeScheduler?: ProbeScheduler,
): RuleMatch[] {
  if (!probeScheduler) return [];
  const matches: RuleMatch[] = [];

  for (const probe of probeScheduler.getProbes()) {
    if (!probeScheduler.isProbeAlerting(probe.id)) continue;

    // Resolve VM identity. Prefer probe-config target, fall back to
    // looking up by id in the current cluster state. If neither is
    // available we still surface the alert via params so the operator
    // sees something — restart_vm itself will fail safely if vmid is
    // unknown.
    let vmName: string | undefined;
    let vmNode = probe.target_node;
    if (probe.target_vm_id !== undefined) {
      const vm = currentState.vms.find(
        (v) => String(v.id) === String(probe.target_vm_id),
      );
      if (vm) {
        vmName = vm.name;
        vmNode = vmNode ?? vm.node;
      }
    }

    matches.push({
      rule,
      trigger: `Service-health probe "${probe.id}" failed for target ${
        probe.target_vm_id ?? probe.target_host ?? probe.host ?? "?"
      }`,
      action: rule.action,
      params: {
        probe_id: probe.id,
        vmid: probe.target_vm_id,
        vm_name: vmName,
        node: vmNode,
        target_host: probe.target_host,
        kind: probe.kind,
        severity: rule.params.severity ?? "critical",
      },
    });
  }

  return matches;
}

/**
 * Detect provider adapters that have failed their connection check
 * for >= threshold consecutive ticks. Emits one match per provider.
 *
 * Per the design: there is NO automatic remediation — the rule fires
 * an `alert` action, never a connect/restart. A provider that can't
 * reach its target almost always means the operator must fix
 * credentials or networking outside of vclaw.
 */
function checkProviderUnreachable(
  rule: AutopilotRule,
  probeScheduler?: ProbeScheduler,
): RuleMatch[] {
  if (!probeScheduler) return [];
  const matches: RuleMatch[] = [];

  for (const record of probeScheduler.getProviderHealthSnapshot()) {
    if (!record.alerting) continue;
    matches.push({
      rule,
      trigger: `Provider adapter "${record.name}" unreachable for ${record.consecutiveFailures} consecutive checks${
        record.lastError ? ` (${record.lastError})` : ""
      }`,
      action: rule.action,
      params: {
        provider: record.name,
        consecutive_failures: record.consecutiveFailures,
        error: record.lastError,
        severity: rule.params.severity ?? "critical",
      },
    });
  }

  return matches;
}
