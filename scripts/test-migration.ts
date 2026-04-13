#!/usr/bin/env tsx
// ============================================================
// vClaw — Live Migration Smoke Test
// Creates a dummy VM on vSphere, then migrates it to Proxmox
// ============================================================

import { config } from "dotenv";
import { spawn } from "node:child_process";
import { VSphereClient } from "../src/providers/vmware/client.js";
import { ProxmoxClient } from "../src/providers/proxmox/client.js";
import { MigrationOrchestrator } from "../src/migration/orchestrator.js";
import type { SSHExecResult } from "../src/migration/types.js";

config();

// ── SSH Helper ─────────────────────────────────────────────

function sshExec(host: string, user: string, command: string, timeoutMs = 30_000): Promise<SSHExecResult> {
  return new Promise((resolve) => {
    const args = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      `${user}@${host}`,
      command,
    ];

    const proc = spawn("ssh", args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const log = (msg: string) => console.log(`[migration-test] ${msg}`);

  // Connect to both providers
  const vsphere = new VSphereClient({
    host: process.env.VMWARE_HOST!,
    user: process.env.VMWARE_USER!,
    password: process.env.VMWARE_PASSWORD!,
    insecure: true,
  });

  const proxmox = new ProxmoxClient({
    host: process.env.PROXMOX_HOST!,
    port: Number(process.env.PROXMOX_PORT ?? 8006),
    tokenId: process.env.PROXMOX_TOKEN_ID!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    allowSelfSignedCerts: true,
  });

  log("Connecting to vSphere...");
  await vsphere.createSession();
  log("Connected to vSphere ✓");

  log("Connecting to Proxmox...");
  await proxmox.connect();
  log("Connected to Proxmox ✓");

  // Step 1: Create a small test VM on vSphere
  log("Creating test VM on vSphere...");
  const folders = await vsphere.listFolders("VIRTUAL_MACHINE");
  const folder = folders[0]?.folder;
  if (!folder) throw new Error("No VM folder found");

  let testVmId: string;
  try {
    testVmId = await vsphere.createVM({
      name: "Migration-TestVM",
      guest_OS: "OTHER_LINUX_64",
      placement: {
        folder,
        host: "host-11", // esxi-01 (192.168.86.37)
        datastore: "datastore-14", // datastore1 on esxi-01
      },
      cpu: { count: 1, cores_per_socket: 1 },
      memory: { size_MiB: 512 },
      disks: [
        {
          type: "SCSI",
          new_vmdk: {
            capacity: 1073741824, // 1 GB
            name: "Migration-TestVM",
          },
        },
      ],
    });
    log(`Created test VM: ${testVmId}`);
  } catch (err) {
    // VM might already exist from a previous run
    log(`Create failed (may already exist): ${err}`);
    const vms = await vsphere.listVMs({ "names": "Migration-TestVM" });
    if (vms.length === 0) throw err;
    testVmId = vms[0].vm;
    log(`Using existing test VM: ${testVmId}`);
  }

  // Step 2: Get VM info
  const vmInfo = await vsphere.getVM(testVmId);
  log(`VM config: ${vmInfo.cpu.count} CPU, ${vmInfo.memory.size_MiB} MiB RAM, ${Object.keys(vmInfo.disks).length} disk(s)`);

  // Step 3: Run the migration
  log("Starting VMware -> Proxmox migration...");

  const orchestrator = new MigrationOrchestrator({
    vsphereClient: vsphere,
    proxmoxClient: proxmox,
    sshExec,
    esxiHost: "192.168.86.37",
    esxiUser: "root",
    proxmoxHost: "192.168.86.50",
    proxmoxUser: "root",
    proxmoxNode: "pranavlab",
    proxmoxStorage: "local-lvm",
    onProgress: (step, detail) => {
      log(`  [${step}] ${detail}`);
    },
  });

  try {
    // First, do a dry run
    log("Running migration plan (dry run)...");
    const plan = await orchestrator.planMigration(testVmId);
    log(`Plan: migrate "${plan.source.vmName}" -> Proxmox VM ${plan.target.vmId}`);
    log(`  CPU: ${plan.vmConfig.cpuCount}, RAM: ${plan.vmConfig.memoryMiB} MiB`);
    log(`  Disks: ${plan.vmConfig.disks.length}, NICs: ${plan.vmConfig.nics.length}`);
    log(`  Steps: ${plan.steps.map(s => s.name).join(" -> ")}`);

    // Now execute the real migration
    log("\nExecuting migration...");
    const result = await orchestrator.migrateVMwareToProxmox(testVmId);

    log("\n=== Migration Complete ===");
    log(`Status: ${result.status}`);
    log(`Source: ${result.source.vmName} (${result.source.provider}:${result.source.vmId})`);
    log(`Target: Proxmox VM ${result.target.vmId} on ${result.target.node}`);
    log("Steps:");
    for (const step of result.steps) {
      log(`  ${step.status === "completed" ? "✓" : "✗"} ${step.name}${step.detail ? ` — ${step.detail}` : ""}`);
    }
  } catch (err) {
    log(`\nMigration failed: ${err}`);
    process.exit(1);
  }

  // Cleanup
  await vsphere.deleteSession();
  log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
