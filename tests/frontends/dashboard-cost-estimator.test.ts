import { describe, expect, it } from "vitest";
import {
  awsHourlyRate,
  azureHourlyRate,
  heuristicRateFromShape,
  HOURS_PER_MONTH,
  hourlyToMonthly,
  onPremHourlyRate,
} from "../../src/frontends/dashboard/cost-rates";
import {
  buildSummary,
  buildTimeseries,
  buildTopResources,
  filterProviders,
  isOnPremProviderType,
  vmHourlyRate,
} from "../../src/frontends/dashboard/cost-estimator";
import type { MultiClusterState } from "../../src/providers/types";

function makeState(): MultiClusterState {
  return {
    providers: [
      {
        name: "aws",
        type: "aws",
        state: {
          adapter: "aws",
          nodes: [],
          containers: [],
          storage: [],
          timestamp: "2026-04-30T00:00:00Z",
          vms: [
            {
              id: "i-aaa",
              name: "web-1",
              node: "us-east-1a",
              status: "running",
              cpu_cores: 2,
              ram_mb: 4096,
              disk_gb: 30,
              os: "t3.medium",
            },
            {
              id: "i-bbb",
              name: "db-1",
              node: "us-east-1b",
              status: "running",
              cpu_cores: 4,
              ram_mb: 16384,
              disk_gb: 100,
              os: "m5.xlarge",
            },
            // Unknown instance type → falls back to shape heuristic
            {
              id: "i-ccc",
              name: "weird-1",
              node: "us-east-1c",
              status: "running",
              cpu_cores: 2,
              ram_mb: 2048,
              disk_gb: 20,
              os: "windows",
            },
          ],
        },
      },
      {
        name: "azure",
        type: "azure",
        state: {
          adapter: "azure",
          nodes: [],
          containers: [],
          storage: [],
          timestamp: "2026-04-30T00:00:00Z",
          vms: [
            {
              id: "az-1",
              name: "api-azure-1",
              node: "eastus",
              status: "running",
              cpu_cores: 2,
              ram_mb: 4096,
              disk_gb: 50,
              os: "Standard_B2s",
            },
          ],
        },
      },
      {
        name: "homelab",
        type: "proxmox",
        state: {
          adapter: "proxmox",
          nodes: [],
          containers: [],
          storage: [],
          timestamp: "2026-04-30T00:00:00Z",
          vms: [
            {
              id: "100",
              name: "lab-vm-1",
              node: "pve1",
              status: "running",
              cpu_cores: 4,
              ram_mb: 8192,
              disk_gb: 80,
            },
          ],
        },
      },
      {
        name: "system",
        type: "system",
        state: {
          adapter: "system",
          nodes: [],
          containers: [],
          storage: [],
          timestamp: "2026-04-30T00:00:00Z",
          vms: [],
        },
      },
    ],
    timestamp: "2026-04-30T00:00:00Z",
  };
}

describe("cost-rates", () => {
  it("returns known AWS rates", () => {
    expect(awsHourlyRate("t3.micro")).toBeCloseTo(0.0104);
    expect(awsHourlyRate("m5.large")).toBeCloseTo(0.096);
  });

  it("falls back to default for unknown AWS instance types", () => {
    const rate = awsHourlyRate("zz9.gigantic");
    expect(rate).toBeGreaterThan(0);
  });

  it("returns known Azure rates and falls back", () => {
    expect(azureHourlyRate("Standard_B2s")).toBeCloseTo(0.0416);
    expect(azureHourlyRate("Unknown_Size")).toBeGreaterThan(0);
    // Case-insensitive
    expect(azureHourlyRate("standard_b2s")).toBeCloseTo(0.0416);
  });

  it("computes on-prem hourly rate proportional to vCPU", () => {
    expect(onPremHourlyRate(0)).toBe(0);
    expect(onPremHourlyRate(8)).toBeCloseTo(0.04);
  });

  it("computes shape heuristic from cpu+ram", () => {
    // 2 vCPU + 4 GB RAM = 2*0.005 + 4*0.005 = 0.03/hr
    expect(heuristicRateFromShape(2, 4096)).toBeCloseTo(0.03);
  });

  it("converts hourly to monthly using 730 hours", () => {
    expect(hourlyToMonthly(0.1)).toBeCloseTo(73);
    expect(HOURS_PER_MONTH).toBe(730);
  });
});

describe("vmHourlyRate", () => {
  it("uses os field as instance type for AWS", () => {
    const rate = vmHourlyRate("aws", { cpu_cores: 2, ram_mb: 4096, os: "t3.medium" });
    expect(rate).toBeCloseTo(0.0416);
  });

  it("falls back to shape heuristic for AWS Windows VMs", () => {
    const rate = vmHourlyRate("aws", { cpu_cores: 2, ram_mb: 4096, os: "windows" });
    expect(rate).toBeGreaterThan(0);
  });

  it("uses os field as VM size for Azure when present", () => {
    const rate = vmHourlyRate("azure", { cpu_cores: 2, ram_mb: 4096, os: "Standard_B2s" });
    expect(rate).toBeCloseTo(0.0416);
  });

  it("uses on-prem rate for proxmox", () => {
    const rate = vmHourlyRate("proxmox", { cpu_cores: 4, ram_mb: 8192, os: "linux" });
    expect(rate).toBeCloseTo(0.02);
  });
});

describe("filterProviders", () => {
  it("excludes system always", () => {
    const filtered = filterProviders(makeState(), "hybrid");
    expect(filtered.find((p) => p.type === "system")).toBeUndefined();
  });

  it("excludes on-prem in cloud mode", () => {
    const filtered = filterProviders(makeState(), "cloud");
    expect(filtered.find((p) => p.type === "proxmox")).toBeUndefined();
    expect(filtered.find((p) => p.type === "aws")).toBeDefined();
    expect(filtered.find((p) => p.type === "azure")).toBeDefined();
  });

  it("includes on-prem in hybrid mode", () => {
    const filtered = filterProviders(makeState(), "hybrid");
    expect(filtered.find((p) => p.type === "proxmox")).toBeDefined();
  });

  it("isOnPremProviderType identifies hypervisors", () => {
    expect(isOnPremProviderType("proxmox")).toBe(true);
    expect(isOnPremProviderType("vmware")).toBe(true);
    expect(isOnPremProviderType("aws")).toBe(false);
  });
});

describe("buildSummary", () => {
  it("aggregates monthly cost per provider in cloud mode", () => {
    const summary = buildSummary(makeState(), "cloud");
    const names = summary.map((s) => s.provider).sort();
    expect(names).toEqual(["aws", "azure"]);

    const aws = summary.find((s) => s.provider === "aws")!;
    // t3.medium ($0.0416) + m5.xlarge ($0.192) + heuristic windows
    // (2*0.005 + 2*0.005 = 0.02) = 0.2536/hr * 730 = 185.13
    expect(aws.monthlyCostUsd).toBeGreaterThan(180);
    expect(aws.monthlyCostUsd).toBeLessThan(200);
    expect(aws.currency).toBe("USD");
  });

  it("includes on-prem provider in hybrid mode at amortized rate", () => {
    const summary = buildSummary(makeState(), "hybrid");
    const homelab = summary.find((s) => s.provider === "homelab");
    expect(homelab).toBeDefined();
    // 4 vCPU * $0.005/hr * 730 = $14.60
    expect(homelab!.monthlyCostUsd).toBeCloseTo(14.6, 1);
  });

  it("returns empty array when no eligible providers", () => {
    const empty: MultiClusterState = { providers: [], timestamp: "2026-04-30T00:00:00Z" };
    expect(buildSummary(empty, "cloud")).toEqual([]);
  });
});

describe("buildTopResources", () => {
  it("sorts by monthly cost descending and respects limit", () => {
    const top = buildTopResources(makeState(), "cloud", 2);
    expect(top.length).toBe(2);
    expect(top[0].monthlyCostUsd).toBeGreaterThanOrEqual(top[1].monthlyCostUsd);
    // m5.xlarge at $0.192/hr is the most expensive in fixture
    expect(top[0].name).toBe("db-1");
  });

  it("annotates resourceType per provider", () => {
    const top = buildTopResources(makeState(), "hybrid", 100);
    const ec2 = top.find((r) => r.name === "db-1");
    const azureVm = top.find((r) => r.name === "api-azure-1");
    const labVm = top.find((r) => r.name === "lab-vm-1");
    expect(ec2?.resourceType).toBe("ec2-instance");
    expect(azureVm?.resourceType).toBe("azure-vm");
    expect(labVm?.resourceType).toBe("proxmox-vm");
  });

  it("excludes on-prem from cloud mode", () => {
    const top = buildTopResources(makeState(), "cloud", 100);
    expect(top.find((r) => r.provider === "homelab")).toBeUndefined();
  });

  it("clamps limit to safe range", () => {
    const top = buildTopResources(makeState(), "hybrid", 0);
    expect(top.length).toBeGreaterThan(0);
  });
});

describe("buildTimeseries", () => {
  it("emits one point per provider per day", () => {
    const points = buildTimeseries(makeState(), "cloud", 30, new Date("2026-04-30T00:00:00Z"));
    // 2 providers (aws, azure) × 30 days = 60
    expect(points.length).toBe(60);
    const dates = new Set(points.map((p) => p.date));
    expect(dates.size).toBe(30);
    const providers = new Set(points.map((p) => p.provider));
    expect(providers).toEqual(new Set(["aws", "azure"]));
  });

  it("daily cost is monthly/30", () => {
    const points = buildTimeseries(makeState(), "cloud", 30, new Date("2026-04-30T00:00:00Z"));
    const summary = buildSummary(makeState(), "cloud");
    const aws = summary.find((s) => s.provider === "aws")!;
    const awsPoint = points.find((p) => p.provider === "aws")!;
    expect(awsPoint.costUsd).toBeCloseTo(aws.monthlyCostUsd / 30, 1);
  });

  it("returns empty array when no providers eligible", () => {
    const empty: MultiClusterState = { providers: [], timestamp: "2026-04-30T00:00:00Z" };
    expect(buildTimeseries(empty, "cloud", 30)).toEqual([]);
  });
});
