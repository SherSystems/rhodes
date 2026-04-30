// ============================================================
// vClaw — Multi-Cluster Aggregator
// Sums totals (VMs, cores, RAM, disk) across all connected
// providers in a single, unit-normalized summary. Designed to
// be tested in isolation against mocked provider state.
// ============================================================

import type { ClusterState, MultiClusterState, ProviderType } from "./types.js";

/**
 * Per-provider rollup, useful for "Provider Overview" panels.
 */
export interface ProviderSummary {
  name: string;
  type: ProviderType;
  healthy: boolean;
  nodeCount: number;
  vmTotal: number;
  vmRunning: number;
  containerTotal: number;
  containerRunning: number;
  cpuCores: number;
  cpuUsagePct: number; // weighted by cores; 0 when no signal
  ramTotalMb: number;
  ramUsedMb: number;
  diskTotalGb: number;
  diskUsedGb: number;
}

/**
 * Aggregate summary across all providers. All numeric fields
 * are pre-normalized to a single unit (cores, MB, GB) so the
 * frontend can display them without further math.
 */
export interface ClusterSummary {
  providers: ProviderSummary[];
  providerCount: number;
  totalNodes: number;
  totalVms: number;
  runningVms: number;
  // Containers (e.g. k8s pods, proxmox LXC) tracked separately
  // so VM totals stay = real VMs only.
  totalContainers: number;
  runningContainers: number;
  totalCpuCores: number;
  /**
   * Weighted average CPU % across nodes that report a signal.
   * Nodes with cpu_cores === 0 OR cpu_usage_pct === 0 are
   * skipped so providers without metrics-server don't drag
   * the average down. NaN/non-finite values become 0.
   */
  cpuUsagePct: number;
  totalRamMb: number;
  usedRamMb: number;
  ramUsagePct: number;
  totalDiskGb: number;
  usedDiskGb: number;
  diskUsagePct: number;
  timestamp: string;
}

const SKIP_PROVIDER_TYPES: ReadonlySet<string> = new Set(["topology", "system"]);

/**
 * Coerce any number-like value to a finite number, defaulting
 * to 0 for null/undefined/NaN/Infinity.
 */
function safeNum(v: unknown): number {
  if (typeof v !== "number") return 0;
  return Number.isFinite(v) ? v : 0;
}

function summarizeProvider(
  name: string,
  type: ProviderType,
  state: ClusterState | undefined | null,
): ProviderSummary {
  if (!state) {
    return {
      name,
      type,
      healthy: false,
      nodeCount: 0,
      vmTotal: 0,
      vmRunning: 0,
      containerTotal: 0,
      containerRunning: 0,
      cpuCores: 0,
      cpuUsagePct: 0,
      ramTotalMb: 0,
      ramUsedMb: 0,
      diskTotalGb: 0,
      diskUsedGb: 0,
    };
  }

  const nodes = state.nodes ?? [];
  const vms = state.vms ?? [];
  const containers = state.containers ?? [];

  let cpuCores = 0;
  let weightedCpuPct = 0;
  let weightedCpuDenom = 0;
  let ramTotalMb = 0;
  let ramUsedMb = 0;
  let diskTotalGb = 0;
  let diskUsedGb = 0;
  let onlineCount = 0;

  for (const n of nodes) {
    const cores = safeNum((n as { cpu_cores?: unknown }).cpu_cores);
    const cpuPct = safeNum((n as { cpu_usage_pct?: unknown }).cpu_usage_pct);
    cpuCores += cores;
    // Only include nodes that actually report a CPU signal in the
    // weighted average. K8s nodes report 0% (no metrics-server) and
    // would otherwise drag the average down.
    if (cores > 0 && cpuPct > 0) {
      weightedCpuPct += cpuPct * cores;
      weightedCpuDenom += cores;
    }
    ramTotalMb += safeNum((n as { ram_total_mb?: unknown }).ram_total_mb);
    ramUsedMb += safeNum((n as { ram_used_mb?: unknown }).ram_used_mb);
    diskTotalGb += safeNum((n as { disk_total_gb?: unknown }).disk_total_gb);
    diskUsedGb += safeNum((n as { disk_used_gb?: unknown }).disk_used_gb);
    if ((n as { status?: unknown }).status === "online") onlineCount++;
  }

  const cpuUsagePct = weightedCpuDenom > 0 ? weightedCpuPct / weightedCpuDenom : 0;

  return {
    name,
    type,
    healthy: nodes.length === 0 ? false : onlineCount === nodes.length,
    nodeCount: nodes.length,
    vmTotal: vms.length,
    vmRunning: vms.filter((v) => v.status === "running").length,
    containerTotal: containers.length,
    containerRunning: containers.filter((c) => c.status === "running").length,
    cpuCores,
    cpuUsagePct,
    ramTotalMb,
    ramUsedMb,
    diskTotalGb,
    diskUsedGb,
  };
}

/**
 * Aggregate a MultiClusterState into a single normalized summary.
 *
 * - Skips topology + system pseudo-providers.
 * - Tolerates providers with empty/missing state (returns 0, never NaN).
 * - Counts containers (k8s pods, proxmox LXC) as a separate field;
 *   VM totals remain = real VMs only.
 * - Computes a cores-weighted CPU average, ignoring nodes that
 *   report 0% (no metrics signal) so they don't drag it down.
 * - Normalizes units: cores, MB for RAM, GB for disk.
 */
export function aggregateClusterSummary(
  state: MultiClusterState | null | undefined,
): ClusterSummary {
  const summary: ClusterSummary = {
    providers: [],
    providerCount: 0,
    totalNodes: 0,
    totalVms: 0,
    runningVms: 0,
    totalContainers: 0,
    runningContainers: 0,
    totalCpuCores: 0,
    cpuUsagePct: 0,
    totalRamMb: 0,
    usedRamMb: 0,
    ramUsagePct: 0,
    totalDiskGb: 0,
    usedDiskGb: 0,
    diskUsagePct: 0,
    timestamp: state?.timestamp ?? new Date().toISOString(),
  };

  const providers = (state?.providers ?? []).filter(
    (p) => !SKIP_PROVIDER_TYPES.has(p.type as string),
  );

  let weightedCpuPct = 0;
  let weightedCpuDenom = 0;

  for (const p of providers) {
    const ps = summarizeProvider(p.name, p.type, p.state);
    summary.providers.push(ps);

    summary.totalNodes += ps.nodeCount;
    summary.totalVms += ps.vmTotal;
    summary.runningVms += ps.vmRunning;
    summary.totalContainers += ps.containerTotal;
    summary.runningContainers += ps.containerRunning;
    summary.totalCpuCores += ps.cpuCores;
    summary.totalRamMb += ps.ramTotalMb;
    summary.usedRamMb += ps.ramUsedMb;
    summary.totalDiskGb += ps.diskTotalGb;
    summary.usedDiskGb += ps.diskUsedGb;

    // Aggregate the weighted CPU avg using the provider-level
    // weighted contribution. Skip providers that didn't report.
    if (ps.cpuUsagePct > 0 && ps.cpuCores > 0) {
      weightedCpuPct += ps.cpuUsagePct * ps.cpuCores;
      weightedCpuDenom += ps.cpuCores;
    }
  }

  summary.providerCount = summary.providers.length;
  summary.cpuUsagePct = weightedCpuDenom > 0 ? weightedCpuPct / weightedCpuDenom : 0;
  summary.ramUsagePct = summary.totalRamMb > 0
    ? (summary.usedRamMb / summary.totalRamMb) * 100
    : 0;
  summary.diskUsagePct = summary.totalDiskGb > 0
    ? (summary.usedDiskGb / summary.totalDiskGb) * 100
    : 0;

  return summary;
}
