// ============================================================
// vClaw — Proxmox VM Importer
// Creates a VM shell on Proxmox and imports converted disks
// ============================================================

import type { ProxmoxClient } from "../providers/proxmox/client.js";
import type { MigrationVMConfig, SSHExecFn } from "./types.js";

export interface ProxmoxImportOptions {
  node: string;
  vmId: number;
  storage: string; // e.g. "local-lvm"
  config: MigrationVMConfig;
  diskPath: string; // path to qcow2 on Proxmox host filesystem
}

export interface ProxmoxImportResult {
  vmId: number;
  node: string;
  taskId?: string;
}

export class ProxmoxImporter {
  private readonly client: ProxmoxClient;
  private readonly sshExec: SSHExecFn;

  constructor(client: ProxmoxClient, sshExec: SSHExecFn) {
    this.client = client;
    this.sshExec = sshExec;
  }

  /**
   * Import a VM into Proxmox from a converted disk image.
   * 1. Creates a VM shell with matching CPU/RAM config
   * 2. Imports the disk via `qm importdisk`
   * 3. Attaches the disk and sets boot order
   * 4. Configures NIC as virtio (optimal for Proxmox)
   */
  async importVM(
    opts: ProxmoxImportOptions,
    proxmoxHost: string,
    proxmoxUser = "root"
  ): Promise<ProxmoxImportResult> {
    const { node, vmId, storage, config, diskPath } = opts;

    // 1. Create VM shell via Proxmox API
    const ostype = this.mapGuestOS(config.guestOS);
    const bios = config.firmware === "efi" ? "ovmf" : "seabios";

    await this.client.createVM({
      node,
      vmid: vmId,
      name: config.name,
      memory: config.memoryMiB,
      cores: config.cpuCount,
      sockets: 1,
      cpu: "host",
      ostype,
      bios,
      scsihw: "virtio-scsi-single",
      net0: `virtio,bridge=vmbr0`,
      agent: "1",
      onboot: 0,
    });

    // 2. Import disk via `qm importdisk` (must run on Proxmox host)
    const importCmd = `qm importdisk ${vmId} ${JSON.stringify(diskPath)} ${storage}`;
    const importResult = await this.sshExec(
      proxmoxHost,
      proxmoxUser,
      importCmd,
      300_000 // 5 min for disk import
    );

    if (importResult.exitCode !== 0) {
      throw new Error(
        `Failed to import disk into Proxmox VM ${vmId}: ${importResult.stderr || importResult.stdout}`
      );
    }

    // Parse the imported disk identifier from output
    // Output typically: "Successfully imported disk as 'unused0:local-lvm:vm-{vmid}-disk-0'"
    const diskId = this.parseImportedDiskId(importResult.stdout, vmId, storage);

    // 3. Attach the imported disk as scsi0
    await this.client.updateVMConfig(node, vmId, {
      scsi0: diskId,
    });

    // 4. Set boot order to disk
    await this.client.updateVMConfig(node, vmId, {
      boot: "order=scsi0;net0",
    });

    // 5. Add EFI disk if firmware is EFI
    if (config.firmware === "efi") {
      await this.client.updateVMConfig(node, vmId, {
        efidisk0: `${storage}:1,efitype=4m,pre-enrolled-keys=1`,
      });
    }

    return { vmId, node };
  }

  /**
   * Find the next available VMID on the Proxmox cluster.
   */
  async getNextVMID(proxmoxHost: string, proxmoxUser = "root"): Promise<number> {
    const result = await this.sshExec(
      proxmoxHost,
      proxmoxUser,
      "pvesh get /cluster/nextid",
      10_000
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get next VMID: ${result.stderr}`);
    }

    // pvesh returns quoted number like "105"
    return parseInt(result.stdout.trim().replace(/"/g, ""), 10);
  }

  /**
   * Parse the imported disk ID from qm importdisk output.
   * Example output: "Successfully imported disk as 'unused0:local-lvm:vm-105-disk-0'"
   */
  private parseImportedDiskId(output: string, vmId: number, storage: string): string {
    // Try to parse from the success message
    const match = output.match(/Successfully imported disk as '(?:unused\d+:)?(.+?)'/);
    if (match) {
      return match[1];
    }

    // Fallback: construct the expected path
    return `${storage}:vm-${vmId}-disk-0`;
  }

  /**
   * Map VMware guest OS identifier to Proxmox ostype.
   */
  private mapGuestOS(vmwareOS: string): string {
    const os = vmwareOS.toUpperCase();

    if (os.includes("WINDOWS_11") || os.includes("WINDOWS_9_SERVER")) return "win11";
    if (os.includes("WINDOWS_9") || os.includes("WINDOWS_10")) return "win10";
    if (os.includes("WINDOWS")) return "win10";
    if (os.includes("UBUNTU") || os.includes("DEBIAN")) return "l26";
    if (os.includes("RHEL") || os.includes("CENTOS") || os.includes("ROCKY")) return "l26";
    if (os.includes("LINUX")) return "l26";

    return "other";
  }
}
