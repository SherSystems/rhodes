import { describe, expect, it } from "vitest";

const RUN_LIVE = process.env.VCLAW_RUN_LIVE === "1";
const BASE_URL = process.env.VCLAW_MIGRATION_API_BASE_URL ?? "http://localhost:3000";
const describeLive = RUN_LIVE ? describe : describe.skip;

type DirectionCase = {
  direction: string;
  source: "vmware" | "proxmox" | "aws" | "azure";
};

type ApiResponse = {
  status: number;
  json: Record<string, unknown>;
};

const DIRECTION_CASES: DirectionCase[] = [
  { direction: "vmware_to_proxmox", source: "vmware" },
  { direction: "proxmox_to_vmware", source: "proxmox" },
  { direction: "vmware_to_aws", source: "vmware" },
  { direction: "aws_to_vmware", source: "aws" },
  { direction: "proxmox_to_aws", source: "proxmox" },
  { direction: "aws_to_proxmox", source: "aws" },
  { direction: "vmware_to_azure", source: "vmware" },
  { direction: "azure_to_vmware", source: "azure" },
  { direction: "proxmox_to_azure", source: "proxmox" },
  { direction: "azure_to_proxmox", source: "azure" },
  { direction: "aws_to_azure", source: "aws" },
  { direction: "azure_to_aws", source: "azure" },
];

const PLAN_ONLY_DIRECTIONS = new Set<string>();

function getSourceId(source: DirectionCase["source"]): string | number {
  if (source === "vmware") return process.env.VMWARE_TEST_VM_ID ?? "vm-54";
  if (source === "proxmox") return Number(process.env.PROXMOX_TEST_VM_ID ?? "112");
  if (source === "aws") return process.env.AWS_TEST_INSTANCE_ID ?? "i-missing-canary";
  return process.env.AZURE_TEST_VM_ID ?? "vclaw-qa/Migration-TestVM";
}

async function postJson(path: string, body: Record<string, unknown>): Promise<ApiResponse> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({ error: "non-json response" })) as Record<string, unknown>;
  return { status: response.status, json };
}

describeLive("Live migration matrix (env-gated)", () => {
  it.each(DIRECTION_CASES)(
    "accepts plan routing for $direction without direction-map regressions",
    async ({ direction, source }) => {
      const vm_id = getSourceId(source);
      const result = await postJson("/api/migration/plan", { direction, vm_id });
      const error = typeof result.json.error === "string" ? result.json.error : "";

      // Proves matrix route support stays wired for all 12 directions.
      expect(error).not.toContain("Unsupported migration direction");
      // Proves server-side id remapping still works for AWS-source directions.
      expect(error).not.toContain("instance_id is required");

      expect([200, 400]).toContain(result.status);

      // When a plan is produced, only currently scaffolded directions should be marked plan-only.
      if (result.status === 200) {
        const planOnly = PLAN_ONLY_DIRECTIONS.has(direction);
        expect(result.json.executable).toBe(!planOnly);
        if (planOnly) {
          expect(typeof result.json.executable_reason).toBe("string");
        }
      }
    },
    180_000,
  );

  it("does not leak raw TypeError text for vmware_to_aws execute failures", async () => {
    const result = await postJson("/api/migration/execute", {
      direction: "vmware_to_aws",
      vm_id: getSourceId("vmware"),
    });
    const error = typeof result.json.error === "string" ? result.json.error : "";

    // Proves execute errors stay user-facing and do not expose internal stack-level TypeError details.
    expect(error).not.toContain("Cannot read properties of undefined");
  }, 180_000);
});
