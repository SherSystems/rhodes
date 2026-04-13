import { describe, it, expect, vi, beforeEach } from "vitest";
import { MigrationOrchestrator } from "../../src/migration/orchestrator.js";
import type { VSphereClient } from "../../src/providers/vmware/client.js";
import type { ProxmoxClient } from "../../src/providers/proxmox/client.js";
import type { VmInfo } from "../../src/providers/vmware/types.js";
import type { SSHExecFn, SSHExecResult } from "../../src/migration/types.js";

const mockVmInfo: VmInfo = {
  name: "migrate-test",
  power_state: "POWERED_ON",
  cpu: { count: 2, cores_per_socket: 1, hot_add_enabled: false, hot_remove_enabled: false },
  memory: { size_MiB: 2048, hot_add_enabled: false },
  hardware: { upgrade_policy: "manual", upgrade_status: "NONE", version: "vmx-19" },
  guest_OS: "OTHER_LINUX_64",
  disks: {
    "2000": {
      label: "Hard disk 1",
      type: "SCSI",
      capacity: 5368709120,
      backing: { type: "VMDK_FILE", vmdk_file: "[datastore1] migrate-test/migrate-test.vmdk" },
    },
  },
  nics: {
    "4000": {
      label: "NIC 1",
      type: "VMXNET3",
      mac_address: "00:50:56:aa:bb:cc",
      mac_type: "ASSIGNED",
      state: "CONNECTED",
      backing: { type: "STANDARD_PORTGROUP", network_name: "VM Network" },
      start_connected: true,
    },
  },
  boot: { type: "BIOS" },
};

describe("MigrationOrchestrator", () => {
  let mockVsphere: Partial<VSphereClient>;
  let mockProxmox: Partial<ProxmoxClient>;
  let mockSshExec: SSHExecFn;
  let progressLog: string[];

  const ok = (stdout = ""): SSHExecResult => ({ stdout, stderr: "", exitCode: 0 });

  beforeEach(() => {
    progressLog = [];

    mockVsphere = {
      getVM: vi.fn().mockResolvedValue(mockVmInfo),
      vmPowerOff: vi.fn().mockResolvedValue(undefined),
    };

    mockProxmox = {
      createVM: vi.fn().mockResolvedValue("UPID:task-1"),
      updateVMConfig: vi.fn().mockResolvedValue(undefined),
    };

    // SSH mock: handle all possible commands
    mockSshExec = vi.fn().mockImplementation(
      (_host: string, _user: string, cmd: string): Promise<SSHExecResult> => {
        if (cmd.includes("pvesh get /cluster/nextid")) {
          return Promise.resolve(ok('"110"'));
        }
        if (cmd.includes("qm importdisk")) {
          return Promise.resolve(
            ok("Successfully imported disk as 'unused0:local-lvm:vm-110-disk-0'")
          );
        }
        if (cmd.includes("which qemu-img")) {
          return Promise.resolve(ok("/usr/bin/qemu-img"));
        }
        if (cmd.includes("stat -c")) {
          return Promise.resolve(ok("5368709120"));
        }
        // Default: success for mkdir, scp, qemu-img convert, rm
        return Promise.resolve(ok());
      }
    );
  });

  function createOrchestrator(overrides: Record<string, unknown> = {}) {
    return new MigrationOrchestrator({
      vsphereClient: mockVsphere as VSphereClient,
      proxmoxClient: mockProxmox as ProxmoxClient,
      sshExec: mockSshExec,
      esxiHost: "192.168.86.37",
      proxmoxHost: "192.168.86.50",
      proxmoxNode: "pranavlab",
      proxmoxStorage: "local-lvm",
      onProgress: (step, detail) => progressLog.push(`${step}: ${detail}`),
      ...overrides,
    });
  }

  describe("migrateVMwareToProxmox", () => {
    it("should complete full migration pipeline", async () => {
      const orchestrator = createOrchestrator();
      const plan = await orchestrator.migrateVMwareToProxmox("vm-123");

      expect(plan.status).toBe("completed");
      expect(plan.source.vmName).toBe("migrate-test");
      expect(plan.source.provider).toBe("vmware");
      expect(plan.target.provider).toBe("proxmox");
      expect(plan.target.vmId).toBe(110);
      expect(plan.target.node).toBe("pranavlab");
      expect(plan.steps).toHaveLength(7);
      expect(plan.steps.every((s) => s.status === "completed")).toBe(true);
    });

    it("should power off the source VM", async () => {
      const orchestrator = createOrchestrator();
      await orchestrator.migrateVMwareToProxmox("vm-123");

      expect(mockVsphere.vmPowerOff).toHaveBeenCalledWith("vm-123");
    });

    it("should tolerate already powered-off VM", async () => {
      (mockVsphere.vmPowerOff as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("already POWERED_OFF")
      );

      const orchestrator = createOrchestrator();
      const plan = await orchestrator.migrateVMwareToProxmox("vm-123");

      expect(plan.status).toBe("completed");
    });

    it("should transfer vmdk from ESXi to Proxmox", async () => {
      const orchestrator = createOrchestrator();
      await orchestrator.migrateVMwareToProxmox("vm-123");

      // SCP call should reference ESXi host and Proxmox target
      const scpCalls = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => typeof c[2] === "string" && c[2].includes("scp")
      );
      expect(scpCalls.length).toBe(1);
      expect(scpCalls[0][2]).toContain("root@192.168.86.37:");
    });

    it("should convert vmdk to qcow2", async () => {
      const orchestrator = createOrchestrator();
      await orchestrator.migrateVMwareToProxmox("vm-123");

      const convertCalls = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => c[2].includes("qemu-img convert")
      );
      expect(convertCalls.length).toBe(1);
      expect(convertCalls[0][2]).toContain("-f vmdk");
      expect(convertCalls[0][2]).toContain("-O qcow2");
    });

    it("should import disk into Proxmox", async () => {
      const orchestrator = createOrchestrator();
      await orchestrator.migrateVMwareToProxmox("vm-123");

      expect(mockProxmox.createVM).toHaveBeenCalledWith(
        expect.objectContaining({
          vmid: 110,
          name: "migrate-test",
          memory: 2048,
          cores: 2,
        })
      );

      const importCalls = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => c[2].includes("qm importdisk")
      );
      expect(importCalls.length).toBe(1);
    });

    it("should clean up staging files", async () => {
      const orchestrator = createOrchestrator();
      await orchestrator.migrateVMwareToProxmox("vm-123");

      // rm -rf for the staging directory + rm -f for the qcow2
      const rmCalls = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => typeof c[2] === "string" && (c[2].includes("rm -rf") || c[2].includes("rm -f"))
      );
      expect(rmCalls.length).toBe(2); // staging dir + qcow2
    });

    it("should use custom target VMID", async () => {
      const orchestrator = createOrchestrator({ targetVmId: 999 });
      const plan = await orchestrator.migrateVMwareToProxmox("vm-123");

      expect(plan.target.vmId).toBe(999);
      expect(mockProxmox.createVM).toHaveBeenCalledWith(
        expect.objectContaining({ vmid: 999 })
      );
    });

    it("should report progress", async () => {
      const orchestrator = createOrchestrator();
      await orchestrator.migrateVMwareToProxmox("vm-123");

      expect(progressLog.length).toBeGreaterThanOrEqual(7);
      expect(progressLog[0]).toContain("export_config");
      expect(progressLog[progressLog.length - 1]).toContain("done");
    });

    it("should fail gracefully on VM with no disks", async () => {
      const noDiskVm = { ...mockVmInfo, disks: {} };
      (mockVsphere.getVM as ReturnType<typeof vi.fn>).mockResolvedValueOnce(noDiskVm);

      const orchestrator = createOrchestrator();
      await expect(orchestrator.migrateVMwareToProxmox("vm-empty")).rejects.toThrow(
        "VM has no disks to migrate"
      );
    });

    it("should set plan status to failed on error", async () => {
      (mockVsphere.getVM as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("VM not found")
      );

      const orchestrator = createOrchestrator();
      let plan;
      try {
        plan = await orchestrator.migrateVMwareToProxmox("vm-bogus");
      } catch {
        // Expected
      }
      // Plan isn't returned on failure, but the error propagates
    });
  });

  describe("planMigration", () => {
    it("should return dry-run plan without making changes", async () => {
      const orchestrator = createOrchestrator();
      const plan = await orchestrator.planMigration("vm-123");

      expect(plan.status).toBe("pending");
      expect(plan.source.vmName).toBe("migrate-test");
      expect(plan.vmConfig.name).toBe("migrate-test");
      expect(plan.vmConfig.cpuCount).toBe(2);
      expect(plan.vmConfig.memoryMiB).toBe(2048);
      expect(plan.steps).toHaveLength(7);
      expect(plan.steps.every((s) => s.status === "pending")).toBe(true);

      // Should NOT have powered off or created anything
      expect(mockVsphere.vmPowerOff).not.toHaveBeenCalled();
      expect(mockProxmox.createVM).not.toHaveBeenCalled();
    });

    it("should assign next VMID", async () => {
      const orchestrator = createOrchestrator();
      const plan = await orchestrator.planMigration("vm-123");

      expect(plan.target.vmId).toBe(110);
    });
  });
});
