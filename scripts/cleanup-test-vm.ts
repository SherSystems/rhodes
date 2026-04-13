#!/usr/bin/env tsx
import { config } from "dotenv";
import { VSphereClient } from "../src/providers/vmware/client.js";
config();

async function main() {
  const c = new VSphereClient({
    host: process.env.VMWARE_HOST!,
    user: process.env.VMWARE_USER!,
    password: process.env.VMWARE_PASSWORD!,
    insecure: true,
  });
  await c.createSession();

  const vms = await c.listVMs();
  console.log("Current VMs:", vms.map(v => `${v.vm}: ${v.name} (${v.power_state})`));

  const testVm = vms.find(v => v.name === "Migration-TestVM");
  if (testVm) {
    console.log(`Deleting ${testVm.vm}...`);
    if (testVm.power_state === "POWERED_ON") {
      await c.vmPowerOff(testVm.vm);
      await new Promise(r => setTimeout(r, 2000));
    }
    await c.deleteVM(testVm.vm);
    console.log("Deleted");
  } else {
    console.log("No Migration-TestVM found");
  }

  await c.deleteSession();
}
main().catch(console.error);
