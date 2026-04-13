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

  const folders = await c.listFolders("VIRTUAL_MACHINE");
  console.log("VM Folders:", JSON.stringify(folders, null, 2));

  const datastores = await c.listDatastores();
  console.log("\nDatastores:", JSON.stringify(datastores, null, 2));

  const hosts = await c.listHosts();
  console.log("\nHosts:", JSON.stringify(hosts, null, 2));

  const vms = await c.listVMs();
  console.log("\nVMs:", JSON.stringify(vms, null, 2));

  await c.deleteSession();
}
main().catch(console.error);
