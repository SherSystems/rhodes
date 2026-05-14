// ============================================================
// RHODES — Proxmox VE REST API Client
// Comprehensive typed client using native Node.js https module
// ============================================================

import https from "node:https";

// ── Types ───────────────────────────────────────────────────

export interface ProxmoxClientConfig {
  host: string;
  port: number;
  tokenId: string;
  tokenSecret: string;
  allowSelfSignedCerts: boolean;
}

export interface ProxmoxResponse<T = unknown> {
  data: T;
}

export interface ProxmoxNode {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  id: string;
  type: string;
  ssl_fingerprint?: string;
}

export interface ProxmoxNodeStats {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  loadavg: number[];
  ksm: Record<string, unknown>;
  cpuinfo: Record<string, unknown>;
  memory: Record<string, unknown>;
  rootfs: Record<string, unknown>;
  swap: Record<string, unknown>;
}

export interface ProxmoxVM {
  vmid: number;
  name: string;
  node?: string;
  status: string;
  mem: number;
  maxmem: number;
  cpu: number;
  cpus: number;
  maxdisk: number;
  disk: number;
  netin: number;
  netout: number;
  uptime: number;
  pid?: number;
  template?: boolean;
  type?: "qemu" | "lxc";
  tags?: string;
  /** Proxmox lock field (backup, clone, create, migrate, rollback,
   *  snapshot, suspended, ...). Present only on locked VMs. The basic
   *  `/nodes/<node>/qemu` list endpoint surfaces this — no extra round-trip. */
  lock?: string;
  /** QEMU QMP-level status. Surfaced when the basic `status` is "running"
   *  but QEMU itself reports something else (e.g. "io-error", "paused").
   *  Populated by the adapter's `runtime_status` derivation, not the
   *  basic list endpoint. */
  qmpstatus?: string;
}

export interface ProxmoxVMStatus {
  vmid: number;
  name: string;
  status: string;
  qmpstatus?: string;
  cpus: number;
  cpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  pid?: number;
  ha: Record<string, unknown>;
  running_machine?: string;
  running_qemu?: string;
}

export interface ProxmoxVMConfig {
  name?: string;
  memory?: number;
  cores?: number;
  sockets?: number;
  cpu?: string;
  ostype?: string;
  boot?: string;
  ide0?: string;
  ide2?: string;
  scsi0?: string;
  scsihw?: string;
  net0?: string;
  agent?: string;
  balloon?: number;
  bios?: string;
  machine?: string;
  numa?: number;
  onboot?: number;
  smbios1?: string;
  tags?: string;
  [key: string]: unknown;
}

export interface ProxmoxSnapshot {
  name: string;
  description: string;
  snaptime?: number;
  vmstate?: boolean;
  parent?: string;
}

export interface ProxmoxStorage {
  storage: string;
  type: string;
  content: string;
  total?: number;
  used?: number;
  avail?: number;
  active?: number;
  enabled?: number;
  shared?: number;
  nodes?: string;
}

export interface ProxmoxISO {
  volid: string;
  format: string;
  size: number;
  content: string;
  filename?: string;
}

export interface ProxmoxTemplate {
  volid: string;
  format: string;
  size: number;
  content: string;
  name?: string;
}

export interface ProxmoxTask {
  upid: string;
  node: string;
  pid: number;
  pstart: number;
  starttime: number;
  type: string;
  id: string;
  user: string;
  status?: string;
  exitstatus?: string;
}

export interface ProxmoxTaskStatus {
  status: string;
  exitstatus?: string;
  type: string;
  id: string;
  user: string;
  node: string;
  pid: number;
  starttime: number;
}

export interface ProxmoxNetworkInterface {
  iface: string;
  type: string;
  method?: string;
  address?: string;
  netmask?: string;
  gateway?: string;
  bridge_ports?: string;
  bridge_stp?: string;
  bridge_fd?: string;
  active?: boolean;
  autostart?: boolean;
  cidr?: string;
  [key: string]: unknown;
}

export interface ProxmoxFirewallRule {
  type: string;
  action: string;
  pos: number;
  enable?: number;
  comment?: string;
  source?: string;
  dest?: string;
  sport?: string;
  dport?: string;
  proto?: string;
  macro?: string;
  iface?: string;
  log?: string;
}

export interface ProxmoxSyslogEntry {
  n: number;
  t: string;
  d: string;
}

export interface CreateVMParams {
  node: string;
  vmid: number;
  name?: string;
  memory?: number;
  cores?: number;
  sockets?: number;
  cpu?: string;
  ostype?: string;
  iso?: string;
  scsihw?: string;
  scsi0?: string;
  ide2?: string;
  net0?: string;
  boot?: string;
  agent?: string;
  bios?: string;
  machine?: string;
  numa?: number;
  onboot?: number;
  start?: boolean;
  tags?: string;
  [key: string]: unknown;
}

export interface CreateCTParams {
  node: string;
  vmid: number;
  hostname?: string;
  ostemplate: string;
  memory?: number;
  cores?: number;
  swap?: number;
  rootfs?: string;
  net0?: string;
  password?: string;
  ssh_public_keys?: string;
  start?: boolean;
  onboot?: number;
  unprivileged?: boolean;
  [key: string]: unknown;
}

export interface CloneVMParams {
  node: string;
  vmid: number;
  newid: number;
  name?: string;
  target?: string;
  full?: boolean;
  storage?: string;
  description?: string;
}

export interface MigrateVMParams {
  node: string;
  vmid: number;
  target: string;
  online?: boolean;
  force?: boolean;
  with_local_disks?: boolean;
  targetstorage?: string;
}

// ── Client ──────────────────────────────────────────────────

export class ProxmoxClient {
  private readonly host: string;
  private readonly port: number;
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly allowSelfSignedCerts: boolean;
  private connected = false;

  constructor(config: ProxmoxClientConfig) {
    this.host = config.host;
    this.port = config.port;
    this.tokenId = config.tokenId;
    this.tokenSecret = config.tokenSecret;
    this.allowSelfSignedCerts = config.allowSelfSignedCerts;
  }

  // ── Connection ──────────────────────────────────────────

  async connect(): Promise<void> {
    try {
      await this.request<{ version: string }>("GET", "/api2/json/version");
      this.connected = true;
    } catch (err) {
      this.connected = false;
      throw new Error(
        `Failed to connect to Proxmox at ${this.host}:${this.port}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Generic Request ─────────────────────────────────────

  private request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
        Accept: "application/json",
      };

      let postData: string | undefined;
      if (body && (method === "POST" || method === "PUT")) {
        const formParams = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          if (value !== undefined && value !== null) {
            formParams.set(key, String(value));
          }
        }

        postData = formParams.toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers["Content-Length"] = Buffer.byteLength(postData).toString();
      }

      let requestPath = path;
      if (body && (method === "GET" || method === "DELETE")) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          if (value !== undefined && value !== null) {
            params.set(key, String(value));
          }
        }
        const qs = params.toString();
        if (qs) {
          requestPath += `?${qs}`;
        }
      }

      const options: https.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path: requestPath,
        method,
        headers,
        rejectUnauthorized: !this.allowSelfSignedCerts,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data) as ProxmoxResponse<T>;
              resolve(parsed.data);
            } catch {
              resolve(data as unknown as T);
            }
          } else {
            let errorMsg = `Proxmox API error: ${res.statusCode} ${res.statusMessage}`;
            try {
              const parsed = JSON.parse(data);
              if (parsed.errors) {
                errorMsg += ` — ${JSON.stringify(parsed.errors)}`;
              } else if (parsed.data) {
                errorMsg += ` — ${JSON.stringify(parsed.data)}`;
              }
            } catch {
              if (data) {
                errorMsg += ` — ${data.slice(0, 500)}`;
              }
            }
            reject(new Error(errorMsg));
          }
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Proxmox request failed: ${err.message}`));
      });

      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error(`Proxmox request timed out: ${method} ${path}`));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  // ── Nodes ───────────────────────────────────────────────

  async getNodes(): Promise<ProxmoxNode[]> {
    return this.request<ProxmoxNode[]>("GET", "/api2/json/nodes");
  }

  async getNodeStats(node: string): Promise<ProxmoxNodeStats> {
    return this.request<ProxmoxNodeStats>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/status`
    );
  }

  // ── VMs ─────────────────────────────────────────────────

  async getVMs(node?: string): Promise<ProxmoxVM[]> {
    if (node) {
      const qemu = await this.request<ProxmoxVM[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu`
      );
      const lxc = await this.request<ProxmoxVM[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc`
      );
      return [
        ...qemu.map((vm) => ({ ...vm, node, type: "qemu" as const })),
        ...lxc.map((ct) => ({ ...ct, node, type: "lxc" as const })),
      ];
    }

    const nodes = await this.getNodes();
    const all: ProxmoxVM[] = [];
    for (const n of nodes) {
      try {
        const vms = await this.getVMs(n.node);
        all.push(...vms);
      } catch {
        // Node may be offline; skip it
      }
    }
    return all;
  }

  async getVMStatus(node: string, vmid: number): Promise<ProxmoxVMStatus> {
    try {
      return await this.request<ProxmoxVMStatus>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/current`
      );
    } catch {
      return this.request<ProxmoxVMStatus>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/current`
      );
    }
  }

  /**
   * QMP-level status for a single QEMU VM. The Proxmox API surfaces
   * `qmpstatus` on the `/status/current` endpoint, which is the same
   * truth that `qm monitor <vmid> 'info status'` returns over the
   * monitor socket — without the per-VM shell. Returns `undefined`
   * for LXC containers and for VMs whose status endpoint doesn't
   * carry the field.
   *
   * Cost note: one REST call per VM. The caller is expected to gate
   * this via {@link VmRuntimeStatusCache} so the cluster isn't
   * hammered every poll.
   */
  async getVMQmpStatus(node: string, vmid: number): Promise<string | undefined> {
    try {
      const status = await this.request<ProxmoxVMStatus>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/current`
      );
      return status.qmpstatus;
    } catch {
      return undefined;
    }
  }

  async getVMConfig(node: string, vmid: number): Promise<ProxmoxVMConfig> {
    try {
      return await this.request<ProxmoxVMConfig>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`
      );
    } catch {
      return this.request<ProxmoxVMConfig>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/config`
      );
    }
  }

  // ── Power Management ────────────────────────────────────

  async startVM(node: string, vmid: number): Promise<string> {
    try {
      return await this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/start`
      );
    } catch {
      return this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/start`
      );
    }
  }

  async stopVM(node: string, vmid: number): Promise<string> {
    try {
      return await this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/stop`
      );
    } catch {
      return this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/stop`
      );
    }
  }

  async shutdownVM(node: string, vmid: number, timeout?: number): Promise<string> {
    const body: Record<string, unknown> = {};
    if (timeout !== undefined) body.timeout = timeout;
    try {
      return await this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/shutdown`,
        body
      );
    } catch {
      return this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/shutdown`,
        body
      );
    }
  }

  async rebootVM(node: string, vmid: number): Promise<string> {
    try {
      return await this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/reboot`
      );
    } catch {
      return this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/reboot`
      );
    }
  }

  async resumeVM(node: string, vmid: number): Promise<string> {
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/resume`
    );
  }

  /**
   * Suspend a running QEMU VM (qm suspend). The guest is paused — RAM
   * stays in memory; use {@link resumeVM} to bring it back. This is the
   * API equivalent of `qm suspend <vmid>` and is QEMU-only.
   */
  async suspendVM(node: string, vmid: number): Promise<string> {
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/suspend`
    );
  }

  /**
   * Hard-reset a QEMU VM (qm reset). Equivalent to pressing the reset
   * button — the guest is not given a chance to flush. QEMU-only;
   * Proxmox does not expose a reset endpoint for LXC.
   */
  async resetVM(node: string, vmid: number): Promise<string> {
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/reset`
    );
  }

  // ── CRUD ────────────────────────────────────────────────

  async createVM(params: CreateVMParams): Promise<string> {
    const { node, ...body } = params;
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu`,
      body
    );
  }

  async createCT(params: CreateCTParams): Promise<string> {
    const { node, ...body } = params;
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/lxc`,
      body
    );
  }

  async deleteVM(node: string, vmid: number, purge?: boolean): Promise<string> {
    const body: Record<string, unknown> = {};
    if (purge) body.purge = 1;
    try {
      return await this.request<string>(
        "DELETE",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}`,
        body
      );
    } catch {
      return this.request<string>(
        "DELETE",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}`,
        body
      );
    }
  }

  async cloneVM(params: CloneVMParams): Promise<string> {
    const { node, vmid, ...body } = params;
    if (body.full !== undefined) {
      (body as Record<string, unknown>).full = body.full ? 1 : 0;
    }
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/clone`,
      body as Record<string, unknown>
    );
  }

  // ── Snapshots ───────────────────────────────────────────

  async listSnapshots(node: string, vmid: number): Promise<ProxmoxSnapshot[]> {
    try {
      return await this.request<ProxmoxSnapshot[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot`
      );
    } catch {
      return this.request<ProxmoxSnapshot[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/snapshot`
      );
    }
  }

  async createSnapshot(
    node: string,
    vmid: number,
    snapname: string,
    description?: string,
    vmstate?: boolean
  ): Promise<string> {
    const body: Record<string, unknown> = { snapname };
    if (description) body.description = description;
    if (vmstate !== undefined) body.vmstate = vmstate ? 1 : 0;
    try {
      return await this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot`,
        body
      );
    } catch {
      return this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/snapshot`,
        body
      );
    }
  }

  async rollbackSnapshot(node: string, vmid: number, snapname: string): Promise<string> {
    try {
      return await this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`
      );
    } catch {
      return this.request<string>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`
      );
    }
  }

  async deleteSnapshot(node: string, vmid: number, snapname: string): Promise<string> {
    try {
      return await this.request<string>(
        "DELETE",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}`
      );
    } catch {
      return this.request<string>(
        "DELETE",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/snapshot/${encodeURIComponent(snapname)}`
      );
    }
  }

  // ── Storage ─────────────────────────────────────────────

  async getStorage(node?: string): Promise<ProxmoxStorage[]> {
    if (node) {
      return this.request<ProxmoxStorage[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/storage`
      );
    }
    return this.request<ProxmoxStorage[]>("GET", "/api2/json/storage");
  }

  async getISOs(node: string, storage: string): Promise<ProxmoxISO[]> {
    return this.request<ProxmoxISO[]>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`,
      { content: "iso" }
    );
  }

  async getTemplates(node: string, storage: string): Promise<ProxmoxTemplate[]> {
    return this.request<ProxmoxTemplate[]>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`,
      { content: "vztmpl" }
    );
  }

  // ── Tasks ───────────────────────────────────────────────

  async getTasks(node: string, limit?: number): Promise<ProxmoxTask[]> {
    const body: Record<string, unknown> = {};
    if (limit !== undefined) body.limit = limit;
    return this.request<ProxmoxTask[]>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/tasks`,
      body
    );
  }

  async getTaskStatus(node: string, upid: string): Promise<ProxmoxTaskStatus> {
    return this.request<ProxmoxTaskStatus>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`
    );
  }

  async waitForTask(
    node: string,
    upid: string,
    timeoutMs = 120_000,
    pollIntervalMs = 2_000
  ): Promise<ProxmoxTaskStatus> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.getTaskStatus(node, upid);
      if (status.status === "stopped") {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(
      `Task ${upid} did not complete within ${timeoutMs}ms`
    );
  }

  // ── Network ─────────────────────────────────────────────

  async getNetworkInterfaces(node: string): Promise<ProxmoxNetworkInterface[]> {
    return this.request<ProxmoxNetworkInterface[]>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/network`
    );
  }

  // ── Firewall ────────────────────────────────────────────

  async getVMFirewallRules(node: string, vmid: number): Promise<ProxmoxFirewallRule[]> {
    try {
      return await this.request<ProxmoxFirewallRule[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/firewall/rules`
      );
    } catch {
      return this.request<ProxmoxFirewallRule[]>(
        "GET",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/firewall/rules`
      );
    }
  }

  async addVMFirewallRule(
    node: string,
    vmid: number,
    rule: {
      type: string;
      action: string;
      enable?: boolean;
      comment?: string;
      source?: string;
      dest?: string;
      sport?: string;
      dport?: string;
      proto?: string;
      macro?: string;
      iface?: string;
      log?: string;
      pos?: number;
    }
  ): Promise<void> {
    const body: Record<string, unknown> = { ...rule };
    if (rule.enable !== undefined) body.enable = rule.enable ? 1 : 0;
    try {
      await this.request<void>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/firewall/rules`,
        body
      );
    } catch {
      await this.request<void>(
        "POST",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/firewall/rules`,
        body
      );
    }
  }

  // ── Config ──────────────────────────────────────────────

  async updateVMConfig(node: string, vmid: number, config: Record<string, unknown>): Promise<void> {
    try {
      await this.request<void>(
        "PUT",
        `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
        config
      );
    } catch {
      await this.request<void>(
        "PUT",
        `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/config`,
        config
      );
    }
  }

  async resizeDisk(node: string, vmid: number, disk: string, size: string): Promise<void> {
    await this.request<void>(
      "PUT",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`,
      { disk, size }
    );
  }

  // ── Migration ───────────────────────────────────────────

  async migrateVM(params: MigrateVMParams): Promise<string> {
    const { node, vmid, ...body } = params;
    if (body.online !== undefined) {
      (body as Record<string, unknown>).online = body.online ? 1 : 0;
    }
    if (body.force !== undefined) {
      (body as Record<string, unknown>).force = body.force ? 1 : 0;
    }
    if (body.with_local_disks !== undefined) {
      (body as Record<string, unknown>)["with-local-disks"] = body.with_local_disks ? 1 : 0;
      delete (body as Record<string, unknown>).with_local_disks;
    }
    return this.request<string>(
      "POST",
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/migrate`,
      body as Record<string, unknown>
    );
  }

  // ── Logs ────────────────────────────────────────────────

  async getNodeSyslog(
    node: string,
    options?: { start?: number; limit?: number; since?: string; until?: string; service?: string }
  ): Promise<ProxmoxSyslogEntry[]> {
    const body: Record<string, unknown> = {};
    if (options?.start !== undefined) body.start = options.start;
    if (options?.limit !== undefined) body.limit = options.limit;
    if (options?.since) body.since = options.since;
    if (options?.until) body.until = options.until;
    if (options?.service) body.service = options.service;
    return this.request<ProxmoxSyslogEntry[]>(
      "GET",
      `/api2/json/nodes/${encodeURIComponent(node)}/syslog`,
      body
    );
  }
}
