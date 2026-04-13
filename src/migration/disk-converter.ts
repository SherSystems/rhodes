// ============================================================
// vClaw — Disk Format Converter
// Converts between disk formats (vmdk, qcow2, raw) via qemu-img
// Runs on the target host via SSH
// ============================================================

import type { DiskFormat, SSHExecFn } from "./types.js";

export interface DiskConvertOptions {
  sshExec: SSHExecFn;
  host: string;
  user: string;
  sourcePath: string;
  targetPath: string;
  sourceFormat: DiskFormat;
  targetFormat: DiskFormat;
  timeoutMs?: number;
}

export class DiskConverter {
  private readonly sshExec: SSHExecFn;

  constructor(sshExec: SSHExecFn) {
    this.sshExec = sshExec;
  }

  /**
   * Convert a disk image between formats on a remote host.
   * Requires qemu-img to be installed on the target host.
   */
  async convert(opts: DiskConvertOptions): Promise<void> {
    // Verify qemu-img is available
    const check = await this.sshExec(
      opts.host,
      opts.user,
      "which qemu-img",
      10_000
    );
    if (check.exitCode !== 0) {
      throw new Error(
        `qemu-img not found on ${opts.host}. Install it with: apt install qemu-utils`
      );
    }

    // Run the conversion
    const cmd = [
      "qemu-img", "convert",
      "-f", opts.sourceFormat,
      "-O", opts.targetFormat,
      "-p", // progress
      JSON.stringify(opts.sourcePath),
      JSON.stringify(opts.targetPath),
    ].join(" ");

    const result = await this.sshExec(
      opts.host,
      opts.user,
      cmd,
      opts.timeoutMs ?? 600_000 // 10 min default — large disks take time
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Disk conversion failed on ${opts.host}: ${result.stderr || result.stdout}`
      );
    }
  }

  /**
   * Get info about a disk image on a remote host.
   */
  async inspect(
    host: string,
    user: string,
    diskPath: string
  ): Promise<{ format: string; virtualSize: number; actualSize: number }> {
    const result = await this.sshExec(
      host,
      user,
      `qemu-img info --output=json ${JSON.stringify(diskPath)}`,
      30_000
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to inspect disk ${diskPath}: ${result.stderr}`);
    }

    const info = JSON.parse(result.stdout);
    return {
      format: info.format,
      virtualSize: info["virtual-size"],
      actualSize: info["actual-size"] ?? 0,
    };
  }

  /**
   * Delete a disk file on a remote host (cleanup after migration).
   */
  async cleanup(host: string, user: string, path: string): Promise<void> {
    await this.sshExec(host, user, `rm -f ${JSON.stringify(path)}`, 10_000);
  }
}
