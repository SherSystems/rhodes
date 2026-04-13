import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProxmoxImporter } from "../../src/migration/proxmox-importer.js";
import type { ProxmoxClient } from "../../src/providers/proxmox/client.js";
import type { MigrationVMConfig, SSHExecFn, SSHExecResult } from "../../src/migration/types.js";

const testConfig: MigrationVMConfig = {
  name: "migrated-vm",
  cpuCount: 4,
  coresPerSocket: 2,
  memoryMiB: 8192,
  guestOS: "UBUNTU_64",
  disks: [
    {
      label: "Hard disk 1",
      capacityBytes: 10737418240,
      sourcePath: "[datastore1] vm/vm.vmdk",
      sourceFormat: "vmdk",
      targetFormat: "qcow2",
    },
  ],
  nics: [
    {
      label: "NIC 1",
      macAddress: "00:50:56:ab:cd:ef",
      networkName: "VM Network",
      adapterType: "VMXNET3",
    },
  ],
  firmware: "bios",
};

describe("ProxmoxImporter", () => {
  let mockClient: Partial<ProxmoxClient>;
  let mockSshExec: SSHExecFn;
  let importer: ProxmoxImporter;

  const ok = (stdout = ""): SSHExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const fail = (stderr = "error"): SSHExecResult => ({ stdout: "", stderr, exitCode: 1 });

  beforeEach(() => {
    mockClient = {
      createVM: vi.fn().mockResolvedValue("UPID:task-1"),
      updateVMConfig: vi.fn().mockResolvedValue(undefined),
    };
    mockSshExec = vi.fn().mockResolvedValue(
      ok("Successfully imported disk as 'unused0:local-lvm:vm-105-disk-0'")
    );
    importer = new ProxmoxImporter(mockClient as ProxmoxClient, mockSshExec);
  });

  describe("importVM", () => {
    it("should create VM shell with correct config", async () => {
      await importer.importVM(
        {
          node: "pranavlab",
          vmId: 105,
          storage: "local-lvm",
          config: testConfig,
          diskPath: "/tmp/disk.qcow2",
        },
        "192.168.86.50"
      );

      expect(mockClient.createVM).toHaveBeenCalledWith(
        expect.objectContaining({
          node: "pranavlab",
          vmid: 105,
          name: "migrated-vm",
          memory: 8192,
          cores: 4,
          sockets: 1,
          cpu: "host",
          ostype: "l26",
          bios: "seabios",
          scsihw: "virtio-scsi-single",
          net0: "virtio,bridge=vmbr0",
        })
      );
    });

    it("should import disk via qm importdisk", async () => {
      await importer.importVM(
        {
          node: "pranavlab",
          vmId: 105,
          storage: "local-lvm",
          config: testConfig,
          diskPath: "/tmp/disk.qcow2",
        },
        "192.168.86.50"
      );

      expect(mockSshExec).toHaveBeenCalledWith(
        "192.168.86.50",
        "root",
        expect.stringContaining("qm importdisk 105"),
        300_000
      );
    });

    it("should attach disk and set boot order", async () => {
      await importer.importVM(
        {
          node: "pranavlab",
          vmId: 105,
          storage: "local-lvm",
          config: testConfig,
          diskPath: "/tmp/disk.qcow2",
        },
        "192.168.86.50"
      );

      // Attach disk as scsi0
      expect(mockClient.updateVMConfig).toHaveBeenCalledWith("pranavlab", 105, {
        scsi0: "local-lvm:vm-105-disk-0",
      });

      // Set boot order
      expect(mockClient.updateVMConfig).toHaveBeenCalledWith("pranavlab", 105, {
        boot: "order=scsi0;net0",
      });
    });

    it("should add EFI disk for EFI firmware", async () => {
      const efiConfig = { ...testConfig, firmware: "efi" as const };

      await importer.importVM(
        {
          node: "pranavlab",
          vmId: 105,
          storage: "local-lvm",
          config: efiConfig,
          diskPath: "/tmp/disk.qcow2",
        },
        "192.168.86.50"
      );

      expect(mockClient.createVM).toHaveBeenCalledWith(
        expect.objectContaining({ bios: "ovmf" })
      );

      expect(mockClient.updateVMConfig).toHaveBeenCalledWith("pranavlab", 105, {
        efidisk0: "local-lvm:1,efitype=4m,pre-enrolled-keys=1",
      });
    });

    it("should throw on import disk failure", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fail("storage error"));

      await expect(
        importer.importVM(
          {
            node: "pranavlab",
            vmId: 105,
            storage: "local-lvm",
            config: testConfig,
            diskPath: "/tmp/disk.qcow2",
          },
          "192.168.86.50"
        )
      ).rejects.toThrow("Failed to import disk");
    });

    it("should use fallback disk ID when output parsing fails", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok("import done"));

      await importer.importVM(
        {
          node: "pranavlab",
          vmId: 200,
          storage: "local-lvm",
          config: testConfig,
          diskPath: "/tmp/disk.qcow2",
        },
        "192.168.86.50"
      );

      expect(mockClient.updateVMConfig).toHaveBeenCalledWith("pranavlab", 200, {
        scsi0: "local-lvm:vm-200-disk-0",
      });
    });

    it("should map Windows guest OS correctly", async () => {
      const winConfig = { ...testConfig, guestOS: "WINDOWS_11_64" };

      await importer.importVM(
        {
          node: "pranavlab",
          vmId: 105,
          storage: "local-lvm",
          config: winConfig,
          diskPath: "/tmp/disk.qcow2",
        },
        "192.168.86.50"
      );

      expect(mockClient.createVM).toHaveBeenCalledWith(
        expect.objectContaining({ ostype: "win11" })
      );
    });
  });

  describe("getNextVMID", () => {
    it("should return next available VMID", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok('"105"'));

      const vmid = await importer.getNextVMID("192.168.86.50");
      expect(vmid).toBe(105);
    });

    it("should throw on failure", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fail("permission denied"));

      await expect(importer.getNextVMID("192.168.86.50")).rejects.toThrow(
        "Failed to get next VMID"
      );
    });
  });
});
