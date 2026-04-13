// ============================================================
// vClaw — VMware VM Exporter
// Reads VM configuration and locates disk files on ESXi hosts
// for cross-provider migration
// ============================================================

import type { VSphereClient } from "../providers/vmware/client.js";
import type { VmInfo } from "../providers/vmware/types.js";
import type { MigrationVMConfig, MigrationDisk, MigrationNic, SSHExecFn } from "./types.js";

export interface VMwareExportResult {
  vmConfig: MigrationVMConfig;
  esxiHost: string; // IP/hostname of the ESXi host where disks live
  datastorePath: string; // e.g. /vmfs/volumes/datastore1
}

export class VMwareExporter {
  private readonly client: VSphereClient;
  private readonly sshExec: SSHExecFn;

  constructor(client: VSphereClient, sshExec: SSHExecFn) {
    this.client = client;
    this.sshExec = sshExec;
  }

  /**
   * Export a VM's configuration and disk locations from VMware.
   * Does NOT power off the VM — caller is responsible for that.
   */
  async exportVM(vmId: string, esxiHost: string, esxiUser = "root"): Promise<VMwareExportResult> {
    // 1. Get full VM info from vSphere REST API
    const vmInfo = await this.client.getVM(vmId);

    // 2. Extract disk info — find vmdk paths on ESXi
    const disks = await this.extractDisks(vmInfo, esxiHost, esxiUser);

    // 3. Extract NIC info
    const nics = this.extractNics(vmInfo);

    // 4. Determine firmware type from boot config
    const firmware = vmInfo.boot?.type === "EFI" ? "efi" as const : "bios" as const;

    // 5. Determine the datastore path from the first disk
    let datastorePath = "/vmfs/volumes/datastore1"; // default
    if (disks.length > 0) {
      const match = disks[0].sourcePath.match(/^\[([^\]]+)\]/);
      if (match) {
        datastorePath = `/vmfs/volumes/${match[1]}`;
      }
    }

    const vmConfig: MigrationVMConfig = {
      name: vmInfo.name,
      cpuCount: vmInfo.cpu.count,
      coresPerSocket: vmInfo.cpu.cores_per_socket,
      memoryMiB: vmInfo.memory.size_MiB,
      guestOS: vmInfo.guest_OS,
      disks,
      nics,
      firmware,
    };

    return { vmConfig, esxiHost, datastorePath };
  }

  /**
   * Extract disk information from VmInfo.
   * Resolves vmdk file paths on the ESXi host filesystem.
   */
  private async extractDisks(
    vmInfo: VmInfo,
    esxiHost: string,
    esxiUser: string
  ): Promise<MigrationDisk[]> {
    const disks: MigrationDisk[] = [];

    for (const [key, disk] of Object.entries(vmInfo.disks)) {
      const vmdkPath = disk.backing?.vmdk_file;
      if (!vmdkPath) continue;

      // Get actual file size from ESXi
      let capacityBytes = disk.capacity ?? 0;
      if (capacityBytes === 0) {
        const fsPath = this.datastorePathToFs(vmdkPath);
        try {
          const result = await this.sshExec(
            esxiHost,
            esxiUser,
            `stat -c %s ${JSON.stringify(fsPath)}`,
            15_000
          );
          if (result.exitCode === 0) {
            capacityBytes = parseInt(result.stdout.trim(), 10) || 0;
          }
        } catch {
          // Non-critical — capacity stays at 0
        }
      }

      disks.push({
        label: disk.label || key,
        capacityBytes,
        sourcePath: vmdkPath, // e.g. [datastore1] vm-name/vm-name.vmdk
        sourceFormat: "vmdk",
        targetFormat: "qcow2",
      });
    }

    return disks;
  }

  /**
   * Extract NIC information from VmInfo.
   */
  private extractNics(vmInfo: VmInfo): MigrationNic[] {
    const nics: MigrationNic[] = [];

    for (const [key, nic] of Object.entries(vmInfo.nics)) {
      nics.push({
        label: nic.label || key,
        macAddress: nic.mac_address,
        networkName: nic.backing?.network_name ?? "VM Network",
        adapterType: nic.type, // vmxnet3, e1000, etc.
      });
    }

    return nics;
  }

  /**
   * Convert a vSphere datastore path like "[datastore1] vm/vm.vmdk"
   * to an ESXi filesystem path like "/vmfs/volumes/datastore1/vm/vm.vmdk"
   */
  datastorePathToFs(datastorePath: string): string {
    const match = datastorePath.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (!match) {
      throw new Error(`Invalid datastore path format: ${datastorePath}`);
    }
    return `/vmfs/volumes/${match[1]}/${match[2]}`;
  }

  /**
   * SCP vmdk files from ESXi host to the target (Proxmox) host.
   * VMware vmdks come in pairs: a descriptor (.vmdk) and a flat file (-flat.vmdk).
   * This method transfers the entire VM directory to get both files.
   * Runs scp FROM the target host, pulling from ESXi.
   */
  async transferDisk(
    esxiHost: string,
    esxiUser: string,
    vmdkFsPath: string,
    targetHost: string,
    targetUser: string,
    targetDir: string,
    timeoutMs = 600_000
  ): Promise<string> {
    // Transfer the entire VM directory (contains descriptor + flat vmdk)
    const vmDir = vmdkFsPath.substring(0, vmdkFsPath.lastIndexOf("/"));
    const vmdkFilename = vmdkFsPath.substring(vmdkFsPath.lastIndexOf("/") + 1);

    // Ensure target directory exists
    await this.sshExec(targetHost, targetUser, `mkdir -p ${JSON.stringify(targetDir)}`, 10_000);

    // SCP the vmdk descriptor and flat file using glob pattern
    // The flat file is named like "vm-flat.vmdk" for a descriptor "vm.vmdk"
    const baseName = vmdkFilename.replace(/\.vmdk$/, "");
    const cmd = [
      "scp",
      "-o StrictHostKeyChecking=no",
      "-o UserKnownHostsFile=/dev/null",
      `${esxiUser}@${esxiHost}:${JSON.stringify(vmDir)}/${baseName}*.vmdk`,
      JSON.stringify(targetDir) + "/",
    ].join(" ");

    const result = await this.sshExec(targetHost, targetUser, cmd, timeoutMs);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to transfer vmdk from ${esxiHost}: ${result.stderr || result.stdout}`
      );
    }

    // Return the path to the descriptor vmdk on the target
    return `${targetDir}/${vmdkFilename}`;
  }
}
