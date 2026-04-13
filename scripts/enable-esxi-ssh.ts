#!/usr/bin/env tsx
// Enable SSH on ESXi hosts via raw vCenter REST API call
import { config } from "dotenv";
import https from "node:https";
config();

const HOST = process.env.VMWARE_HOST!;
const USER = process.env.VMWARE_USER!;
const PASS = process.env.VMWARE_PASSWORD!;

function request(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers["vmware-api-session-id"] = token;
    else headers["Authorization"] = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

    let postData: string | undefined;
    if (body) {
      postData = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(postData).toString();
    }

    const req = https.request({ hostname: HOST, port: 443, path, method, headers, rejectUnauthorized: false }, (res) => {
      let data = "";
      res.on("data", (c) => data += c.toString());
      res.on("end", () => resolve({ status: res.statusCode!, data }));
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function main() {
  // Create session
  const sessRes = await request("POST", "/api/session");
  const token = JSON.parse(sessRes.data);
  console.log("Session created");

  // The vSphere REST API doesn't have a direct host service control endpoint.
  // But we can use the /api/appliance endpoint if this were vCenter SSH.
  // For ESXi host SSH, we need to use vim.host.ServiceSystem via SOAP.

  // Alternative: use the ESXi DCUI-like approach via Proxmox's qm command
  // since ESXi is running as a nested VM on Proxmox, we can send keyboard input

  // Actually, simplest approach: use vim-cmd on ESXi via Proxmox serial console
  // or just use curl against ESXi directly with its own API

  // ESXi has its own /api endpoint. Let's try enabling SSH via esxi-01 directly
  const esxiHosts = [...configured from env...];

  for (const esxi of esxiHosts) {
    console.log(`\nEnabling SSH on ${esxi}...`);
    // Create session on ESXi directly
    const esxiSess = await new Promise<{ status: number; data: string }>((resolve, reject) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`root:${process.env.ESXI_PASSWORD}`).toString("base64")}`,
      };
      const req = https.request({ hostname: esxi, port: 443, path: "/api/session", method: "POST", headers, rejectUnauthorized: false }, (res) => {
        let data = "";
        res.on("data", (c) => data += c.toString());
        res.on("end", () => resolve({ status: res.statusCode!, data }));
      });
      req.on("error", reject);
      req.end();
    });

    console.log(`  Session: ${esxiSess.status} ${esxiSess.data.substring(0, 50)}`);

    if (esxiSess.status === 201 || esxiSess.status === 200) {
      const esxiToken = JSON.parse(esxiSess.data);

      // Start SSH service
      const startRes = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const headers: Record<string, string> = {
          Accept: "application/json",
          "vmware-api-session-id": esxiToken,
        };
        const req = https.request({ hostname: esxi, port: 443, path: "/api/esx/services/ssh?action=start", method: "POST", headers, rejectUnauthorized: false }, (res) => {
          let data = "";
          res.on("data", (c) => data += c.toString());
          res.on("end", () => resolve({ status: res.statusCode!, data }));
        });
        req.on("error", reject);
        req.end();
      });

      console.log(`  SSH start: ${startRes.status} ${startRes.data.substring(0, 100)}`);
    }
  }

  // Clean up vCenter session
  await request("DELETE", "/api/session", token);
  console.log("\nDone");
}

main().catch(console.error);
