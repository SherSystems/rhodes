import { describe, it, expect, vi } from "vitest";

import {
  ProvisioningPlanner,
  defaultsForOs,
} from "../../src/provisioning/planner.js";
import type { AIConfig } from "../../src/agent/llm.js";
import type {
  ProvisioningTarget,
  VmProvisioningRequest,
} from "../../src/provisioning/types.js";

const llmConfig: AIConfig = {
  provider: "anthropic",
  apiKey: "test-key",
  model: "claude-test",
};

const proxmoxTarget: ProvisioningTarget = {
  hypervisor: "proxmox",
  node: "pve1",
  storage: "local-lvm",
};

function mockLlm(payload: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(JSON.stringify(payload));
}

describe("ProvisioningPlanner", () => {
  it("returns a plan with the LLM-chosen sizing for a Windows trading-bot VM", async () => {
    const callLLM = mockLlm({
      os: "windows-11",
      vm_name: "trader-bot-1",
      cpu_count: 4,
      memory_mib: 8192,
      disk_gb: 80,
      reasoning: "Windows 11 with 4 vCPU/8 GiB for low-latency trading workload",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const request: VmProvisioningRequest = {
      prompt: "Spin up a Windows 11 VM for running a trading bot",
    };

    const plan = await planner.plan(request, proxmoxTarget);

    expect(plan.id).toMatch(/^prov-/);
    expect(plan.status).toBe("pending");
    expect(plan.target).toEqual(proxmoxTarget);
    expect(plan.vmConfig.name).toBe("trader-bot-1");
    expect(plan.vmConfig.os).toBe("windows-11");
    expect(plan.vmConfig.cpuCount).toBe(4);
    expect(plan.vmConfig.memoryMiB).toBe(8192);
    expect(plan.vmConfig.diskGb).toBe(80);
    expect(plan.reasoning).toContain("Windows 11");
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it("applies sane Windows hardware defaults (UEFI + TPM + virtio NIC)", async () => {
    const callLLM = mockLlm({
      os: "windows-11",
      vm_name: "win11-test",
      cpu_count: 4,
      memory_mib: 8192,
      disk_gb: 80,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan({ prompt: "win 11 vm" }, proxmoxTarget);

    expect(plan.vmConfig.hardware).toEqual(defaultsForOs("windows-11"));
    expect(plan.vmConfig.hardware.firmware).toBe("uefi");
    expect(plan.vmConfig.hardware.tpm).toBe(true);
    expect(plan.vmConfig.hardware.nicModel).toBe("virtio");
  });

  it("applies sane Linux hardware defaults (no TPM, virtio disk bus)", async () => {
    const callLLM = mockLlm({
      os: "ubuntu-24.04",
      vm_name: "ubuntu-dev",
      cpu_count: 2,
      memory_mib: 4096,
      disk_gb: 40,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan({ prompt: "ubuntu vm" }, proxmoxTarget);

    expect(plan.vmConfig.hardware.tpm).toBe(false);
    expect(plan.vmConfig.hardware.diskBus).toBe("virtio");
  });

  it("propagates user hints over LLM choices", async () => {
    // LLM picks Ubuntu, but user hint says Win Server 2022.
    const callLLM = mockLlm({
      os: "ubuntu-24.04",
      vm_name: "wrong-name",
      cpu_count: 2,
      memory_mib: 4096,
      disk_gb: 40,
      reasoning: "ignored",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan(
      {
        prompt: "build agent",
        hints: {
          os: "windows-server-2022",
          vmName: "build-agent-01",
          cpuCount: 8,
          memoryMiB: 16384,
          diskGb: 120,
        },
      },
      proxmoxTarget,
    );

    expect(plan.vmConfig.os).toBe("windows-server-2022");
    expect(plan.vmConfig.name).toBe("build-agent-01");
    expect(plan.vmConfig.cpuCount).toBe(8);
    expect(plan.vmConfig.memoryMiB).toBe(16384);
    expect(plan.vmConfig.diskGb).toBe(120);
    // Hardware defaults still come from the OS family (windows -> tpm true).
    expect(plan.vmConfig.hardware.tpm).toBe(true);
  });

  it("emits a placeholder Windows unattend payload with captured locale hints", async () => {
    const callLLM = mockLlm({
      os: "windows-11",
      vm_name: "win11-test",
      cpu_count: 4,
      memory_mib: 8192,
      disk_gb: 80,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan(
      {
        prompt: "win 11 vm",
        hints: { locale: "en-GB", keyboard: "uk", timezone: "Europe/London", username: "trader" },
      },
      proxmoxTarget,
    );

    expect(plan.unattend.kind).toBe("windows-autounattend");
    if (plan.unattend.kind === "windows-autounattend") {
      // Scaffold: XML body is intentionally empty.
      expect(plan.unattend.xml).toBe("");
      expect(plan.unattend.filename).toBe("autounattend.xml");
      expect(plan.unattend.fields).toEqual({
        locale: "en-GB",
        keyboard: "uk",
        timezone: "Europe/London",
        username: "trader",
      });
    }
  });

  it("emits a placeholder cloud-init payload for Linux with sshPublicKey hint", async () => {
    const callLLM = mockLlm({
      os: "ubuntu-24.04",
      vm_name: "ubuntu-test",
      cpu_count: 2,
      memory_mib: 4096,
      disk_gb: 40,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan(
      { prompt: "ubuntu", hints: { sshPublicKey: "ssh-ed25519 AAAA test" } },
      proxmoxTarget,
    );

    expect(plan.unattend.kind).toBe("linux-cloud-init");
    if (plan.unattend.kind === "linux-cloud-init") {
      expect(plan.unattend.content).toBe("");
      expect(plan.unattend.fields.sshPublicKey).toBe("ssh-ed25519 AAAA test");
    }
  });

  it("marks Windows ISO source as requiring form bypass", async () => {
    const callLLM = mockLlm({
      os: "windows-11",
      vm_name: "win11-test",
      cpu_count: 4,
      memory_mib: 8192,
      disk_gb: 80,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan({ prompt: "win 11" }, proxmoxTarget);

    expect(plan.isoSource.requiresFormBypass).toBe(true);
    expect(plan.isoSource.os).toBe("windows-11");
    expect(plan.isoSource.url).toBe(""); // SCAFFOLD: empty until the resolver lands.
  });

  it("marks Linux ISO source as not requiring form bypass", async () => {
    const callLLM = mockLlm({
      os: "ubuntu-24.04",
      vm_name: "ubuntu-test",
      cpu_count: 2,
      memory_mib: 4096,
      disk_gb: 40,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });
    const plan = await planner.plan({ prompt: "ubuntu" }, proxmoxTarget);

    expect(plan.isoSource.requiresFormBypass).toBe(false);
  });

  it("rejects an unknown OS from the LLM", async () => {
    const callLLM = mockLlm({
      os: "haiku-os",
      vm_name: "weird",
      cpu_count: 2,
      memory_mib: 2048,
      disk_gb: 20,
      reasoning: "test",
    });

    const planner = new ProvisioningPlanner({ llmConfig, callLLM });

    await expect(
      planner.plan({ prompt: "obscure" }, proxmoxTarget),
    ).rejects.toThrow(/unknown OS/);
  });

  it("rejects malformed JSON from the LLM", async () => {
    const callLLM = vi.fn().mockResolvedValue("not json {broken");
    const planner = new ProvisioningPlanner({ llmConfig, callLLM });

    await expect(
      planner.plan({ prompt: "anything" }, proxmoxTarget),
    ).rejects.toThrow(/did not return JSON/);
  });
});
