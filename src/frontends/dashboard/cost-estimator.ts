// ============================================================
// vClaw — Cost Estimator
// Pure functions that turn provider cluster state into
// monthly-cost summaries, daily timeseries, and top-resource
// rankings used by the Costs tab in the dashboard.
//
// All amounts are USD. Estimates are derived from static rate
// maps (see cost-rates.ts) — defensible ballparks, NOT billing.
// ============================================================

import type { MultiClusterState, VMInfo } from "../../providers/types.js";
import {
  AZURE_HOURLY_RATES,
  awsHourlyRate,
  azureHourlyRate,
  heuristicRateFromShape,
  hourlyToMonthly,
  onPremHourlyRate,
} from "./cost-rates.js";

export type CostComparisonMode = "cloud" | "hybrid";

export interface ProviderCostSummary {
  provider: string;
  monthlyCostUsd: number;
  currency: string;
}

export interface CostTimeseriesPoint {
  date: string;
  provider: string;
  costUsd: number;
}

export interface CostTopResource {
  id: string;
  name: string;
  provider: string;
  resourceType: string;
  monthlyCostUsd: number;
}

const ON_PREM_PROVIDER_TYPES = new Set(["proxmox", "vmware"]);

/** Whether a provider is an on-prem hypervisor we treat as $0/amortized. */
export function isOnPremProviderType(type: string): boolean {
  return ON_PREM_PROVIDER_TYPES.has(type.toLowerCase());
}

/**
 * Compute the hourly rate for a single VM given the provider type
 * and the VMInfo shape. Each provider has a different "best" lookup
 * key so we centralize it here.
 */
export function vmHourlyRate(
  providerType: string,
  vm: Pick<VMInfo, "cpu_cores" | "ram_mb" | "os">,
): number {
  const ptype = providerType.toLowerCase();

  if (ptype === "aws") {
    // AWS adapter encodes the instance type in `os` when no platform string
    // is set. If `os` looks like a known instance type, prefer that.
    const candidate = (vm.os ?? "").trim();
    if (candidate && /^[a-z0-9]+\.[a-z0-9]+$/i.test(candidate)) {
      return awsHourlyRate(candidate);
    }
    // Fallback: shape-based heuristic from cpu+ram.
    return heuristicRateFromShape(vm.cpu_cores, vm.ram_mb);
  }

  if (ptype === "azure") {
    // Azure adapter sets `os` to osType (Linux/Windows) when known,
    // falling back to vmSize. Try both forms.
    const candidate = (vm.os ?? "").trim();
    if (candidate && AZURE_HOURLY_RATES[candidate] !== undefined) {
      return azureHourlyRate(candidate);
    }
    return heuristicRateFromShape(vm.cpu_cores, vm.ram_mb);
  }

  if (isOnPremProviderType(ptype)) {
    return onPremHourlyRate(vm.cpu_cores);
  }

  // Unknown provider type — be conservative.
  return heuristicRateFromShape(vm.cpu_cores, vm.ram_mb);
}

/** Map provider type to the resourceType label used by top-resources. */
function resourceTypeFor(providerType: string): string {
  const ptype = providerType.toLowerCase();
  if (ptype === "aws") return "ec2-instance";
  if (ptype === "azure") return "azure-vm";
  if (ptype === "proxmox") return "proxmox-vm";
  if (ptype === "vmware") return "vmware-vm";
  return "vm";
}

/**
 * Filter MultiClusterState providers based on the comparison mode.
 *  - "cloud": cloud only (skip proxmox/vmware/system)
 *  - "hybrid": cloud + on-prem (still skip "system")
 */
export function filterProviders(
  state: MultiClusterState,
  comparison: CostComparisonMode,
): MultiClusterState["providers"] {
  return state.providers.filter((p) => {
    const ptype = (p.type ?? "").toLowerCase();
    if (ptype === "system") return false;
    if (comparison === "cloud" && isOnPremProviderType(ptype)) return false;
    return true;
  });
}

/**
 * Aggregate monthly cost per provider.
 * Stopped VMs are still counted at full month — closer to how
 * cloud bills accrue for storage and reservation, but on-prem
 * is amortized hardware so this is also reasonable.
 */
export function buildSummary(
  state: MultiClusterState,
  comparison: CostComparisonMode,
): ProviderCostSummary[] {
  const providers = filterProviders(state, comparison);
  const summaries: ProviderCostSummary[] = [];
  for (const p of providers) {
    const vms = p.state?.vms ?? [];
    let monthly = 0;
    for (const vm of vms) {
      monthly += hourlyToMonthly(vmHourlyRate(p.type, vm));
    }
    summaries.push({
      provider: p.name || p.type,
      monthlyCostUsd: roundCents(monthly),
      currency: "USD",
    });
  }
  return summaries;
}

/**
 * Build a flat 30-day timeseries by replicating the current
 * monthly-rate (divided by 30) for each day.
 *
 * TODO(future): replace with real billing history from AWS Cost
 * Explorer / Azure Cost Management. For now this gives the chart
 * something defensible to render.
 */
export function buildTimeseries(
  state: MultiClusterState,
  comparison: CostComparisonMode,
  days = 30,
  now: Date = new Date(),
): CostTimeseriesPoint[] {
  const summary = buildSummary(state, comparison);
  const points: CostTimeseriesPoint[] = [];
  const dailyByProvider = new Map<string, number>();
  for (const s of summary) {
    dailyByProvider.set(s.provider, s.monthlyCostUsd / 30);
  }

  // Build dates in ascending order ending today.
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const isoDate = d.toISOString().slice(0, 10);
    for (const [provider, daily] of dailyByProvider) {
      points.push({
        date: isoDate,
        provider,
        costUsd: roundCents(daily),
      });
    }
  }
  return points;
}

/**
 * Top-N resources by monthly cost across all (filtered) providers.
 */
export function buildTopResources(
  state: MultiClusterState,
  comparison: CostComparisonMode,
  limit = 10,
): CostTopResource[] {
  const providers = filterProviders(state, comparison);
  const all: CostTopResource[] = [];
  for (const p of providers) {
    const vms = p.state?.vms ?? [];
    for (const vm of vms) {
      const monthly = hourlyToMonthly(vmHourlyRate(p.type, vm));
      all.push({
        id: String(vm.id),
        name: vm.name || String(vm.id),
        provider: p.name || p.type,
        resourceType: resourceTypeFor(p.type),
        monthlyCostUsd: roundCents(monthly),
      });
    }
  }
  all.sort((a, b) => {
    if (b.monthlyCostUsd !== a.monthlyCostUsd) {
      return b.monthlyCostUsd - a.monthlyCostUsd;
    }
    return a.name.localeCompare(b.name);
  });
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return all.slice(0, safeLimit);
}

function roundCents(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}
