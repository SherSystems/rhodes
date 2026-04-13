import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiskConverter } from "../../src/migration/disk-converter.js";
import type { SSHExecFn, SSHExecResult } from "../../src/migration/types.js";

describe("DiskConverter", () => {
  let mockSshExec: SSHExecFn;
  let converter: DiskConverter;

  const ok = (stdout = ""): SSHExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const fail = (stderr = "error"): SSHExecResult => ({ stdout: "", stderr, exitCode: 1 });

  beforeEach(() => {
    mockSshExec = vi.fn();
    converter = new DiskConverter(mockSshExec);
  });

  describe("convert", () => {
    it("should run qemu-img convert with correct args", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok("/usr/bin/qemu-img")) // which qemu-img
        .mockResolvedValueOnce(ok()); // convert

      await converter.convert({
        sshExec: mockSshExec,
        host: "192.168.1.50",
        user: "root",
        sourcePath: "/tmp/disk.vmdk",
        targetPath: "/tmp/disk.qcow2",
        sourceFormat: "vmdk",
        targetFormat: "qcow2",
      });

      expect(mockSshExec).toHaveBeenCalledTimes(2);

      // First call: check qemu-img exists
      expect(mockSshExec).toHaveBeenNthCalledWith(
        1,
        "192.168.1.50",
        "root",
        "which qemu-img",
        10_000
      );

      // Second call: actual conversion
      const convertCall = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(convertCall[2]).toContain("qemu-img convert");
      expect(convertCall[2]).toContain("-f vmdk");
      expect(convertCall[2]).toContain("-O qcow2");
      expect(convertCall[2]).toContain("/tmp/disk.vmdk");
      expect(convertCall[2]).toContain("/tmp/disk.qcow2");
    });

    it("should throw if qemu-img is not installed", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fail("not found"));

      await expect(
        converter.convert({
          sshExec: mockSshExec,
          host: "192.168.1.50",
          user: "root",
          sourcePath: "/tmp/disk.vmdk",
          targetPath: "/tmp/disk.qcow2",
          sourceFormat: "vmdk",
          targetFormat: "qcow2",
        })
      ).rejects.toThrow("qemu-img not found");
    });

    it("should throw if conversion fails", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok("/usr/bin/qemu-img"))
        .mockResolvedValueOnce(fail("Could not open '/tmp/disk.vmdk'"));

      await expect(
        converter.convert({
          sshExec: mockSshExec,
          host: "192.168.1.50",
          user: "root",
          sourcePath: "/tmp/disk.vmdk",
          targetPath: "/tmp/disk.qcow2",
          sourceFormat: "vmdk",
          targetFormat: "qcow2",
        })
      ).rejects.toThrow("Disk conversion failed");
    });

    it("should use custom timeout", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok("/usr/bin/qemu-img"))
        .mockResolvedValueOnce(ok());

      await converter.convert({
        sshExec: mockSshExec,
        host: "192.168.1.50",
        user: "root",
        sourcePath: "/tmp/disk.vmdk",
        targetPath: "/tmp/disk.qcow2",
        sourceFormat: "vmdk",
        targetFormat: "qcow2",
        timeoutMs: 900_000,
      });

      const convertCall = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(convertCall[3]).toBe(900_000);
    });
  });

  describe("inspect", () => {
    it("should return disk info", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        ok(
          JSON.stringify({
            format: "qcow2",
            "virtual-size": 10737418240,
            "actual-size": 2147483648,
          })
        )
      );

      const info = await converter.inspect("192.168.1.50", "root", "/tmp/disk.qcow2");

      expect(info.format).toBe("qcow2");
      expect(info.virtualSize).toBe(10737418240);
      expect(info.actualSize).toBe(2147483648);
    });

    it("should throw on failure", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fail("No such file"));

      await expect(
        converter.inspect("192.168.1.50", "root", "/tmp/nope.qcow2")
      ).rejects.toThrow("Failed to inspect disk");
    });
  });

  describe("cleanup", () => {
    it("should rm the file", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok());

      await converter.cleanup("192.168.1.50", "root", "/tmp/disk.vmdk");

      expect(mockSshExec).toHaveBeenCalledWith(
        "192.168.1.50",
        "root",
        'rm -f "/tmp/disk.vmdk"',
        10_000
      );
    });
  });
});
