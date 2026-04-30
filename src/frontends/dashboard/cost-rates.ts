// ============================================================
// vClaw — Cost Rate Maps
// Static, defensible per-instance hourly rates used to derive
// monthly cost estimates from current provider state.
//
// These are heuristic on-demand US-region list prices captured
// from public AWS/Azure pricing pages — accurate enough for
// "ballpark" comparisons but NOT billing-grade. Rates do not
// account for reserved-instance discounts, savings plans,
// region pricing differences, OS license uplift, or storage.
//
// TODO(future): wire to AWS Cost Explorer / Azure Consumption
// APIs for real billing data and historical timeseries.
// ============================================================

export const HOURS_PER_MONTH = 730;

/** Per-vCPU/hour amortized hardware rate for on-prem hypervisors. */
export const ONPREM_VCPU_HOURLY_USD = 0.005;

/** Fallback when an instance/VM size is not present in the rate map. */
export const AWS_FALLBACK_HOURLY_USD = 0.05;
export const AZURE_FALLBACK_HOURLY_USD = 0.05;

/**
 * AWS EC2 on-demand US-East-1 Linux hourly rates.
 * Source: AWS pricing page snapshot, list prices in USD/hour.
 */
export const AWS_HOURLY_RATES: Readonly<Record<string, number>> = Object.freeze({
  // Burstable T3
  "t3.nano": 0.0052,
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "t3.2xlarge": 0.3328,
  // Burstable T4g (Graviton)
  "t4g.nano": 0.0042,
  "t4g.micro": 0.0084,
  "t4g.small": 0.0168,
  "t4g.medium": 0.0336,
  // General purpose M5
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "m5.2xlarge": 0.384,
  "m5.4xlarge": 0.768,
  // Compute optimized C5
  "c5.large": 0.085,
  "c5.xlarge": 0.17,
  "c5.2xlarge": 0.34,
  "c5.4xlarge": 0.68,
  // Memory optimized R5
  "r5.large": 0.126,
  "r5.xlarge": 0.252,
  "r5.2xlarge": 0.504,
});

/**
 * Azure VM on-demand US East Linux hourly rates.
 * Source: Azure pricing page snapshot, list prices in USD/hour.
 */
export const AZURE_HOURLY_RATES: Readonly<Record<string, number>> = Object.freeze({
  // Burstable B-series
  "Standard_B1s": 0.0104,
  "Standard_B1ms": 0.0208,
  "Standard_B2s": 0.0416,
  "Standard_B2ms": 0.0832,
  "Standard_B4ms": 0.166,
  "Standard_B8ms": 0.333,
  // General purpose Dsv3
  "Standard_D2s_v3": 0.096,
  "Standard_D4s_v3": 0.192,
  "Standard_D8s_v3": 0.384,
  // General purpose Dsv5
  "Standard_D2s_v5": 0.096,
  "Standard_D4s_v5": 0.192,
  "Standard_D8s_v5": 0.384,
  "Standard_D16s_v5": 0.768,
  // Memory optimized Esv5
  "Standard_E2s_v5": 0.126,
  "Standard_E4s_v5": 0.252,
});

/**
 * Look up hourly rate for an AWS instance type.
 * Returns the fallback rate if the type is unknown.
 */
export function awsHourlyRate(instanceType: string | undefined | null): number {
  if (!instanceType) return AWS_FALLBACK_HOURLY_USD;
  return AWS_HOURLY_RATES[instanceType] ?? AWS_FALLBACK_HOURLY_USD;
}

/**
 * Look up hourly rate for an Azure VM size.
 * Accepts either canonical case ("Standard_B2s") or the lower-cased
 * suffix-only form sometimes returned from APIs.
 */
export function azureHourlyRate(vmSize: string | undefined | null): number {
  if (!vmSize) return AZURE_FALLBACK_HOURLY_USD;
  if (AZURE_HOURLY_RATES[vmSize] !== undefined) return AZURE_HOURLY_RATES[vmSize];
  // Try a case-insensitive match against canonical keys.
  const lower = vmSize.toLowerCase();
  for (const key of Object.keys(AZURE_HOURLY_RATES)) {
    if (key.toLowerCase() === lower) return AZURE_HOURLY_RATES[key];
  }
  return AZURE_FALLBACK_HOURLY_USD;
}

/**
 * Heuristic hourly rate derived from CPU + RAM when an instance type
 * cannot be identified — used as a last-resort fallback.
 *
 * Calibrated so a 2-vCPU / 4GB box costs roughly the same as t3.medium
 * (~$0.04/hr): $0.005/vCPU/hr + $0.005/GB-RAM/hr.
 */
export function heuristicRateFromShape(cpuCores: number, ramMb: number): number {
  const cpu = Math.max(0, cpuCores);
  const ramGb = Math.max(0, ramMb) / 1024;
  return cpu * 0.005 + ramGb * 0.005;
}

/** On-prem amortized hardware cost ($/vCPU/hr). */
export function onPremHourlyRate(cpuCores: number): number {
  return Math.max(0, cpuCores) * ONPREM_VCPU_HOURLY_USD;
}

/** Convert an hourly rate to a full-month estimate. */
export function hourlyToMonthly(rate: number): number {
  return rate * HOURS_PER_MONTH;
}
