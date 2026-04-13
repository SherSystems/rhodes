import { describe, it, expect, vi, beforeEach } from "vitest";
import { VMwareExporter } from "../../src/migration/vmware-exporter.js";
import type { VSphereClient } from "../../src/migration/../providers/vmware/client.js";
import type { VmInfo } from "../../src/providers/vmware/types.js";
import type { SSHExecFn, SSHExecResult } from "../../src/migration/types.js";

const mockVmInfo: VmInfo = {
  name: "test-vm",
  power_state: "POWERED_OFF",
  cpu: { count: 2, cores_per_socket: 1, hot_add_enabled: false, hot_remove_enabled: false },
  memory: { size_MiB: 4096, hot_add_enabled: false },
  hardware: { upgrade_policy: "manual", upgrade_status: "NONE", version: "vmx-19" },
  guest_OS: "UBUNTU_64",
  disks: {
    "2000": {
      label: "Hard disk 1",
      type: "SCSI",
      capacity: 10737418240,
      backing: { type: "VMDK_FILE", vmdk_file: "[datastore1] test-vm/test-vm.vmdk" },
    },
  },
  nics: {
    "4000": {
      label: "Network adapter 1",
      type: "VMXNET3",
      mac_address: "00:50:56:ab:cd:ef",
      mac_type: "ASSIGNED",
      state: "CONNECTED",
      backing: {
        type: "STANDARD_PORTGROUP",
        network: "network-1",
        network_name: "VM Network",
      },
      start_connected: true,
    },
  },
  boot: { type: "BIOS" },
};

describe("VMwareExporter", () => {
  let mockClient: Partial<VSphereClient>;
  let mockSshExec: SSHExecFn;
  let exporter: VMwareExporter;

  const ok = (stdout = ""): SSHExecResult => ({ stdout, stderr: "", exitCode: 0 });

  beforeEach(() => {
    mockClient = {
      getVM: vi.fn().mockResolvedValue(mockVmInfo),
    };
    mockSshExec = vi.fn().mockResolvedValue(ok());
    exporter = new VMwareExporter(mockClient as VSphereClient, mockSshExec);
  });

  describe("exportVM", () => {
    it("should export VM config with disks and NICs", async () => {
      const result = await exporter.exportVM("vm-123", "192.168.86.37");

      expect(mockClient.getVM).toHaveBeenCalledWith("vm-123");
      expect(result.vmConfig.name).toBe("test-vm");
      expect(result.vmConfig.cpuCount).toBe(2);
      expect(result.vmConfig.memoryMiB).toBe(4096);
      expect(result.vmConfig.guestOS).toBe("UBUNTU_64");
      expect(result.vmConfig.firmware).toBe("bios");
      expect(result.vmConfig.disks).toHaveLength(1);
      expect(result.vmConfig.disks[0].label).toBe("Hard disk 1");
      expect(result.vmConfig.disks[0].sourcePath).toBe("[datastore1] test-vm/test-vm.vmdk");
      expect(result.vmConfig.disks[0].sourceFormat).toBe("vmdk");
      expect(result.vmConfig.disks[0].targetFormat).toBe("qcow2");
      expect(result.vmConfig.nics).toHaveLength(1);
      expect(result.vmConfig.nics[0].macAddress).toBe("00:50:56:ab:cd:ef");
      expect(result.vmConfig.nics[0].adapterType).toBe("VMXNET3");
    });

    it("should detect EFI firmware", async () => {
      const efiVm = { ...mockVmInfo, boot: { type: "EFI" } };
      (mockClient.getVM as ReturnType<typeof vi.fn>).mockResolvedValue(efiVm);

      const result = await exporter.exportVM("vm-456", "192.168.86.37");
      expect(result.vmConfig.firmware).toBe("efi");
    });

    it("should resolve datastore path", async () => {
      const result = await exporter.exportVM("vm-123", "192.168.86.37");
      expect(result.datastorePath).toBe("/vmfs/volumes/datastore1");
    });

    it("should handle VMs with no disks", async () => {
      const noDiskVm = { ...mockVmInfo, disks: {} };
      (mockClient.getVM as ReturnType<typeof vi.fn>).mockResolvedValue(noDiskVm);

      const result = await exporter.exportVM("vm-789", "192.168.86.37");
      expect(result.vmConfig.disks).toHaveLength(0);
    });

    it("should try to get capacity via SSH if not in API", async () => {
      const noCapVm = {
        ...mockVmInfo,
        disks: {
          "2000": {
            label: "Hard disk 1",
            type: "SCSI",
            capacity: 0,
            backing: { type: "VMDK_FILE", vmdk_file: "[datastore1] test-vm/test-vm.vmdk" },
          },
        },
      };
      (mockClient.getVM as ReturnType<typeof vi.fn>).mockResolvedValue(noCapVm);
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok("5368709120"));

      const result = await exporter.exportVM("vm-123", "192.168.86.37");
      expect(result.vmConfig.disks[0].capacityBytes).toBe(5368709120);
    });
  });

  describe("datastorePathToFs", () => {
    it("should convert datastore path to filesystem path", () => {
      expect(exporter.datastorePathToFs("[datastore1] vm/vm.vmdk")).toBe(
        "/vmfs/volumes/datastore1/vm/vm.vmdk"
      );
    });

    it("should handle spaces in datastore names", () => {
      expect(exporter.datastorePathToFs("[Local SSD] my-vm/disk.vmdk")).toBe(
        "/vmfs/volumes/Local SSD/my-vm/disk.vmdk"
      );
    });

    it("should throw on invalid format", () => {
      expect(() => exporter.datastorePathToFs("invalid-path.vmdk")).toThrow(
        "Invalid datastore path format"
      );
    });
  });

  describe("transferDisk", () => {
    it("should SCP vmdk files from ESXi to target directory", async () => {
      // mkdir + scp
      (mockSshExec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok()) // mkdir
        .mockResolvedValueOnce(ok()); // scp

      const resultPath = await exporter.transferDisk(
        "192.168.86.37",
        "root",
        "/vmfs/volumes/datastore1/vm/vm.vmdk",
        "192.168.86.50",
        "root",
        "/tmp/staging"
      );

      expect(resultPath).toBe("/tmp/staging/vm.vmdk");

      // mkdir call
      expect(mockSshExec).toHaveBeenNthCalledWith(
        1,
        "192.168.86.50",
        "root",
        expect.stringContaining("mkdir"),
        10_000
      );

      // scp call should use glob pattern for descriptor + flat vmdk
      const scpCall = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(scpCall[0]).toBe("192.168.86.50");
      expect(scpCall[2]).toContain("scp");
      expect(scpCall[2]).toContain("root@192.168.86.37:");
      expect(scpCall[2]).toContain("vm*.vmdk");
      expect(scpCall[2]).toContain("StrictHostKeyChecking=no");
    });

    it("should throw on transfer failure", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok()) // mkdir
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "Connection refused",
          exitCode: 1,
        });

      await expect(
        exporter.transferDisk(
          "192.168.86.37",
          "root",
          "/vmfs/volumes/datastore1/vm/vm.vmdk",
          "192.168.86.50",
          "root",
          "/tmp/staging"
        )
      ).rejects.toThrow("Failed to transfer vmdk");
    });
  });
});
