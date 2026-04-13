// ============================================================
// vClaw — Migration Orchestrator
// End-to-end cross-provider VM migration pipeline
// Phase 1: VMware -> Proxmox (cold migration)
// ============================================================

import type { VSphereClient } from "../providers/vmware/client.js";
import type { ProxmoxClient } from "../providers/proxmox/client.js";
import type {
  MigrationPlan,
  MigrationStep,
  MigrationVMConfig,
  SSHExecFn,
} from "./types.js";
import { VMwareExporter } from "./vmware-exporter.js";
import { ProxmoxImporter } from "./proxmox-importer.js";
import { DiskConverter } from "./disk-converter.js";

// ── Config ──────────────────────────────────────────────────

export interface MigrationConfig {
  vsphereClient: VSphereClient;
  proxmoxClient: ProxmoxClient;
  sshExec: SSHExecFn;

  // ESXi host where the source VM's disks live
  esxiHost: string;
  esxiUser?: string;

  // Proxmox target
  proxmoxHost: string;
  proxmoxUser?: string;
  proxmoxNode: string;
  proxmoxStorage?: string; // default: "local-lvm"

  // Working directory on Proxmox for staging disk files
  workDir?: string; // default: "/tmp/vclaw-migration"

  // Optional: specific Proxmox VMID (auto-assigned if not provided)
  targetVmId?: number;

  // Callbacks for progress reporting
  onProgress?: (step: string, detail: string) => void;
}

// ── Orchestrator ────────────────────────────────────────────

export class MigrationOrchestrator {
  private readonly config: MigrationConfig;
  private readonly exporter: VMwareExporter;
  private readonly importer: ProxmoxImporter;
  private readonly converter: DiskConverter;

  constructor(config: MigrationConfig) {
    this.config = config;
    this.exporter = new VMwareExporter(config.vsphereClient, config.sshExec);
    this.importer = new ProxmoxImporter(config.proxmoxClient, config.sshExec);
    this.converter = new DiskConverter(config.sshExec);
  }

  /**
   * Migrate a VM from VMware vSphere to Proxmox.
   *
   * Pipeline:
   *   1. Read VM config from vSphere REST API
   *   2. Power off VM (if running)
   *   3. Create staging directory on Proxmox
   *   4. SCP vmdk from ESXi -> Proxmox
   *   5. Convert vmdk -> qcow2 on Proxmox
   *   6. Create VM shell + import disk on Proxmox
   *   7. Clean up staging files
   */
  async migrateVMwareToProxmox(vmId: string): Promise<MigrationPlan> {
    const esxiUser = this.config.esxiUser ?? "root";
    const proxmoxUser = this.config.proxmoxUser ?? "root";
    const proxmoxStorage = this.config.proxmoxStorage ?? "local-lvm";
    const workDir = this.config.workDir ?? "/tmp/vclaw-migration";
    const report = this.config.onProgress ?? (() => {});

    const plan: MigrationPlan = {
      id: `mig-${Date.now()}`,
      source: {
        provider: "vmware",
        vmId,
        vmName: "",
        host: this.config.esxiHost,
      },
      target: {
        provider: "proxmox",
        node: this.config.proxmoxNode,
        host: this.config.proxmoxHost,
        storage: proxmoxStorage,
      },
      vmConfig: {} as MigrationVMConfig,
      status: "pending",
      steps: [],
      startedAt: new Date().toISOString(),
    };

    const step = (name: string): MigrationStep => {
      const s: MigrationStep = { name, status: "pending", startedAt: new Date().toISOString() };
      plan.steps.push(s);
      return s;
    };

    const complete = (s: MigrationStep, detail?: string) => {
      s.status = "completed";
      s.completedAt = new Date().toISOString();
      if (detail) s.detail = detail;
    };

    const fail = (s: MigrationStep, error: string) => {
      s.status = "failed";
      s.error = error;
      s.completedAt = new Date().toISOString();
    };

    try {
      // ── Step 1: Export VM config ─────────────────────────
      const s1 = step("export_config");
      plan.status = "exporting";
      report("export_config", `Reading VM ${vmId} config from vSphere`);

      const exportResult = await this.exporter.exportVM(vmId, this.config.esxiHost, esxiUser);
      plan.vmConfig = exportResult.vmConfig;
      plan.source.vmName = exportResult.vmConfig.name;
      complete(s1, `Exported config for "${exportResult.vmConfig.name}"`);

      if (exportResult.vmConfig.disks.length === 0) {
        throw new Error("VM has no disks to migrate");
      }

      // ── Step 2: Power off source VM ─────────────────────
      const s2 = step("power_off");
      report("power_off", `Powering off VM ${exportResult.vmConfig.name}`);

      try {
        await this.config.vsphereClient.vmPowerOff(vmId);
        // Wait a moment for clean shutdown
        await new Promise((r) => setTimeout(r, 3000));
        complete(s2, "VM powered off");
      } catch (err) {
        // Might already be off — that's fine
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already") || msg.includes("POWERED_OFF")) {
          complete(s2, "VM already powered off");
        } else {
          complete(s2, `Power off attempted: ${msg}`);
        }
      }

      // ── Step 3: Create staging directory ─────────────────
      const s3 = step("stage_setup");
      report("stage_setup", `Creating staging directory on Proxmox`);

      await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `mkdir -p ${workDir}`,
        10_000
      );
      complete(s3);

      // ── Step 4: Transfer vmdk from ESXi to Proxmox ──────
      // Only handle first disk for Phase 1
      const primaryDisk = exportResult.vmConfig.disks[0];
      const vmdkFsPath = this.exporter.datastorePathToFs(primaryDisk.sourcePath);
      const stageDir = `${workDir}/${plan.id}`;
      const stagedQcow2 = `${workDir}/${plan.id}.qcow2`;

      const s4 = step("transfer_disk");
      plan.status = "exporting";
      report("transfer_disk", `Transferring ${primaryDisk.label} from ESXi to Proxmox`);

      // transferDisk copies both descriptor + flat vmdk, returns descriptor path
      const stagedVmdk = await this.exporter.transferDisk(
        this.config.esxiHost,
        esxiUser,
        vmdkFsPath,
        this.config.proxmoxHost,
        proxmoxUser,
        stageDir,
        600_000 // 10 min timeout
      );
      complete(s4, `Transferred ${vmdkFsPath} -> ${stageDir}/`);

      // ── Step 5: Convert vmdk -> qcow2 ───────────────────
      const s5 = step("convert_disk");
      plan.status = "converting";
      report("convert_disk", `Converting vmdk to qcow2`);

      await this.converter.convert({
        sshExec: this.config.sshExec,
        host: this.config.proxmoxHost,
        user: proxmoxUser,
        sourcePath: stagedVmdk,
        targetPath: stagedQcow2,
        sourceFormat: "vmdk",
        targetFormat: "qcow2",
        timeoutMs: 600_000,
      });
      complete(s5, `Converted to ${stagedQcow2}`);

      // ── Step 6: Import into Proxmox ─────────────────────
      const s6 = step("import_vm");
      plan.status = "importing";
      report("import_vm", `Creating VM on Proxmox and importing disk`);

      // Get VMID
      const targetVmId =
        this.config.targetVmId ??
        (await this.importer.getNextVMID(this.config.proxmoxHost, proxmoxUser));

      plan.target.vmId = targetVmId;

      const importResult = await this.importer.importVM(
        {
          node: this.config.proxmoxNode,
          vmId: targetVmId,
          storage: proxmoxStorage,
          config: exportResult.vmConfig,
          diskPath: stagedQcow2,
        },
        this.config.proxmoxHost,
        proxmoxUser
      );
      complete(s6, `Imported as Proxmox VM ${importResult.vmId} on ${importResult.node}`);

      // ── Step 7: Cleanup staging files ───────────────────
      const s7 = step("cleanup");
      report("cleanup", "Cleaning up staging files");

      // Remove staging directory (vmdk descriptor + flat file) and converted qcow2
      await this.config.sshExec(
        this.config.proxmoxHost,
        proxmoxUser,
        `rm -rf ${JSON.stringify(stageDir)}`,
        10_000
      );
      await this.converter.cleanup(this.config.proxmoxHost, proxmoxUser, stagedQcow2);
      complete(s7);

      // ── Done ────────────────────────────────────────────
      plan.status = "completed";
      plan.completedAt = new Date().toISOString();
      report("done", `Migration complete! VM "${plan.source.vmName}" is now Proxmox VM ${targetVmId}`);

      return plan;
    } catch (err) {
      plan.status = "failed";
      plan.error = err instanceof Error ? err.message : String(err);
      plan.completedAt = new Date().toISOString();

      // Mark last step as failed
      const lastStep = plan.steps[plan.steps.length - 1];
      if (lastStep && lastStep.status !== "completed") {
        fail(lastStep, plan.error);
      }

      throw err;
    }
  }

  /**
   * Dry run: plan the migration without executing it.
   * Validates connectivity and returns the migration plan.
   */
  async planMigration(vmId: string): Promise<MigrationPlan> {
    const esxiUser = this.config.esxiUser ?? "root";
    const proxmoxStorage = this.config.proxmoxStorage ?? "local-lvm";
    const proxmoxUser = this.config.proxmoxUser ?? "root";

    // Read VM config
    const exportResult = await this.exporter.exportVM(vmId, this.config.esxiHost, esxiUser);

    // Get next VMID
    const targetVmId =
      this.config.targetVmId ??
      (await this.importer.getNextVMID(this.config.proxmoxHost, proxmoxUser));

    return {
      id: `plan-${Date.now()}`,
      source: {
        provider: "vmware",
        vmId,
        vmName: exportResult.vmConfig.name,
        host: this.config.esxiHost,
      },
      target: {
        provider: "proxmox",
        node: this.config.proxmoxNode,
        host: this.config.proxmoxHost,
        storage: proxmoxStorage,
        vmId: targetVmId,
      },
      vmConfig: exportResult.vmConfig,
      status: "pending",
      steps: [
        { name: "export_config", status: "pending" },
        { name: "power_off", status: "pending" },
        { name: "stage_setup", status: "pending" },
        { name: "transfer_disk", status: "pending" },
        { name: "convert_disk", status: "pending" },
        { name: "import_vm", status: "pending" },
        { name: "cleanup", status: "pending" },
      ],
    };
  }
}
