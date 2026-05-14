// ============================================================
// RHODES — Proxmox VE Adapter
// Implements InfraAdapter and registers all Proxmox tools
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
  NodeInfo,
  VMInfo,
  ContainerInfo,
  StorageInfo,
} from "../types.js";

import { ProxmoxClient } from "./client.js";
import {
  VmRuntimeStatusCache,
  deriveRuntimeStatus,
  type RuntimeStatus,
} from "./vm-runtime-status.js";

// ── Config ──────────────────────────────────────────────────

export interface ProxmoxConfig {
  host: string;
  port: number;
  tokenId: string;
  tokenSecret: string;
  allowSelfSignedCerts: boolean;
}

// ── Tool Definitions ────────────────────────────────────────

const ADAPTER_NAME = "proxmox";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object"
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

function param(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: unknown
): ToolDefinition["params"][number] {
  const p: ToolDefinition["params"][number] = { name, type, required, description };
  if (defaultValue !== undefined) p.default = defaultValue;
  return p;
}

// Commonly reused param sets
const nodeParam = param("node", "string", true, "Proxmox node name");
const vmidParam = param("vmid", "number", true, "VM or container ID");
const optionalNodeParam = param("node", "string", false, "Proxmox node name (omit to query all nodes)");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Read Tools ────────────────────────────────────────────

  tool("list_vms", "List all VMs and containers, optionally filtered by node", "read", [
    optionalNodeParam,
  ], "VMInfo[]"),

  tool("get_vm_status", "Get current status of a VM or container", "read", [
    nodeParam,
    vmidParam,
  ], "VMStatus"),

  tool("list_nodes", "List all cluster nodes with basic stats", "read", [], "NodeInfo[]"),

  tool("get_node_stats", "Get detailed resource stats for a specific node", "read", [
    nodeParam,
  ], "NodeStats"),

  tool("list_snapshots", "List snapshots for a VM or container", "read", [
    nodeParam,
    vmidParam,
  ], "Snapshot[]"),

  tool("get_vm_config", "Get full configuration of a VM or container", "read", [
    nodeParam,
    vmidParam,
  ], "VMConfig"),

  tool("list_storage", "List available storage pools", "read", [
    optionalNodeParam,
  ], "StorageInfo[]"),

  tool("list_isos", "List available ISO images on a storage pool", "read", [
    nodeParam,
    param("storage", "string", true, "Storage pool name"),
  ], "ISO[]"),

  tool("list_templates", "List available container templates on a storage pool", "read", [
    nodeParam,
    param("storage", "string", true, "Storage pool name"),
  ], "Template[]"),

  tool("get_task_status", "Get status of an async task by UPID", "read", [
    nodeParam,
    param("upid", "string", true, "Task UPID"),
  ], "TaskStatus"),

  tool("list_tasks", "List recent tasks on a node", "read", [
    nodeParam,
    param("limit", "number", false, "Max tasks to return", 50),
  ], "Task[]"),

  tool("search_logs", "Search node syslog entries", "read", [
    nodeParam,
    param("start", "number", false, "Start line offset"),
    param("limit", "number", false, "Max entries to return", 500),
    param("since", "string", false, "Start timestamp (YYYY-MM-DD HH:MM:SS)"),
    param("until", "string", false, "End timestamp (YYYY-MM-DD HH:MM:SS)"),
    param("service", "string", false, "Filter by service name"),
  ], "SyslogEntry[]"),

  tool("list_network_interfaces", "List network interfaces on a node", "read", [
    nodeParam,
  ], "NetworkInterface[]"),

  tool("get_vm_firewall_rules", "Get firewall rules for a VM or container", "read", [
    nodeParam,
    vmidParam,
  ], "FirewallRule[]"),

  // ── Safe Write Tools ──────────────────────────────────────

  tool(
    "start_vm",
    "Start a stopped Proxmox VM or container via the Proxmox API. Prefer this over `ssh_exec qm start` — the API path uses the configured token and does not depend on an SSH key being installed on the agent host.",
    "safe_write",
    [nodeParam, vmidParam],
    "string"
  ),

  tool("create_snapshot", "Create a snapshot of a VM or container", "safe_write", [
    nodeParam,
    vmidParam,
    param("snapname", "string", true, "Snapshot name"),
    param("description", "string", false, "Snapshot description"),
    param("vmstate", "boolean", false, "Include VM RAM state", false),
  ], "string"),

  tool(
    "resume_vm",
    "Resume a paused/suspended Proxmox QEMU VM via the Proxmox API (equivalent to `qm resume`). Prefer this over `ssh_exec qm resume` — the API path uses the configured token and works even when the agent host has no SSH key to the Proxmox node (the common failure mode on fresh NUCs / jump-box setups).",
    "safe_write",
    [nodeParam, vmidParam],
    "string"
  ),

  tool(
    "suspend_vm",
    "Suspend a running Proxmox QEMU VM via the Proxmox API (equivalent to `qm suspend`). Guest RAM stays in memory; pair with `resume_vm` to bring it back. Prefer this over `ssh_exec qm suspend`.",
    "safe_write",
    [nodeParam, vmidParam],
    "string"
  ),

  // ── Risky Write Tools ─────────────────────────────────────

  tool("create_vm", "Create a new QEMU virtual machine", "risky_write", [
    nodeParam,
    vmidParam,
    param("name", "string", false, "VM name"),
    param("memory", "number", false, "Memory in MB", 2048),
    param("cores", "number", false, "CPU cores", 2),
    param("sockets", "number", false, "CPU sockets", 1),
    param("cpu", "string", false, "CPU type", "host"),
    param("ostype", "string", false, "OS type (e.g. l26, win10)"),
    param("iso", "string", false, "ISO volume ID for CD drive"),
    param("scsihw", "string", false, "SCSI hardware type", "virtio-scsi-single"),
    param("scsi0", "string", false, "Primary disk (e.g. local-lvm:32)"),
    param("net0", "string", false, "Network config (e.g. virtio,bridge=vmbr0)"),
    param("boot", "string", false, "Boot order"),
    param("agent", "string", false, "QEMU guest agent"),
    param("bios", "string", false, "BIOS type (seabios or ovmf)"),
    param("machine", "string", false, "Machine type"),
    param("numa", "number", false, "Enable NUMA"),
    param("onboot", "number", false, "Start on boot"),
    param("start", "boolean", false, "Start VM after creation", false),
    param("tags", "string", false, "Tags (semicolon-separated)"),
  ], "string"),

  tool("create_ct", "Create a new LXC container", "risky_write", [
    nodeParam,
    vmidParam,
    param("hostname", "string", false, "Container hostname"),
    param("ostemplate", "string", true, "OS template volume ID"),
    param("memory", "number", false, "Memory in MB", 512),
    param("cores", "number", false, "CPU cores", 1),
    param("swap", "number", false, "Swap in MB", 512),
    param("rootfs", "string", false, "Root filesystem (e.g. local-lvm:8)"),
    param("net0", "string", false, "Network config"),
    param("password", "string", false, "Root password"),
    param("ssh_public_keys", "string", false, "SSH public keys"),
    param("start", "boolean", false, "Start after creation", false),
    param("onboot", "number", false, "Start on boot"),
    param("unprivileged", "boolean", false, "Unprivileged container", true),
  ], "string"),

  tool("clone_vm", "Clone an existing VM", "risky_write", [
    nodeParam,
    vmidParam,
    param("newid", "number", true, "New VM ID for the clone"),
    param("name", "string", false, "Name for the clone"),
    param("target", "string", false, "Target node"),
    param("full", "boolean", false, "Full clone (not linked)", true),
    param("storage", "string", false, "Target storage"),
    param("description", "string", false, "Description for the clone"),
  ], "string"),

  tool(
    "stop_vm",
    "Force-stop a Proxmox VM or container via the Proxmox API (immediate power off — equivalent to `qm stop`). Prefer this over `ssh_exec qm stop`.",
    "risky_write",
    [nodeParam, vmidParam],
    "string"
  ),

  tool(
    "shutdown_vm",
    "Gracefully shut down a Proxmox VM or container via ACPI through the Proxmox API (equivalent to `qm shutdown`). Prefer this over `ssh_exec qm shutdown`.",
    "risky_write",
    [
      nodeParam,
      vmidParam,
      param("timeout", "number", false, "Shutdown timeout in seconds"),
    ],
    "string"
  ),

  tool(
    "reboot_vm",
    "Reboot a Proxmox VM or container via the Proxmox API (equivalent to `qm reboot`). Prefer this over `ssh_exec qm reboot`.",
    "risky_write",
    [nodeParam, vmidParam],
    "string"
  ),

  tool(
    "reset_vm",
    "Hard-reset a Proxmox QEMU VM via the Proxmox API (equivalent to `qm reset`). Guest is not given a chance to flush. Prefer this over `ssh_exec qm reset`. QEMU-only (Proxmox does not expose reset for LXC).",
    "risky_write",
    [nodeParam, vmidParam],
    "string"
  ),

  tool("update_vm_config", "Update configuration of a VM or container", "risky_write", [
    nodeParam,
    vmidParam,
    param("config", "object", true, "Key-value pairs of config options to set"),
  ], "void"),

  tool("resize_disk", "Resize a VM disk", "risky_write", [
    nodeParam,
    vmidParam,
    param("disk", "string", true, "Disk name (e.g. scsi0, virtio0)"),
    param("size", "string", true, "New size (e.g. +10G, 50G)"),
  ], "void"),

  tool("migrate_vm", "Live-migrate a VM to another node", "risky_write", [
    nodeParam,
    vmidParam,
    param("target", "string", true, "Target node name"),
    param("online", "boolean", false, "Online/live migration", true),
    param("force", "boolean", false, "Force migration", false),
    param("with_local_disks", "boolean", false, "Migrate local disks", false),
    param("targetstorage", "string", false, "Target storage for local disks"),
  ], "string"),

  tool("add_firewall_rule", "Add a firewall rule to a VM or container", "risky_write", [
    nodeParam,
    vmidParam,
    param("type", "string", true, "Rule type: in, out, or group"),
    param("action", "string", true, "Rule action: ACCEPT, DROP, or REJECT"),
    param("enable", "boolean", false, "Enable the rule", true),
    param("comment", "string", false, "Rule comment"),
    param("source", "string", false, "Source address/CIDR"),
    param("dest", "string", false, "Destination address/CIDR"),
    param("sport", "string", false, "Source port"),
    param("dport", "string", false, "Destination port"),
    param("proto", "string", false, "Protocol (tcp, udp, icmp)"),
    param("macro", "string", false, "Predefined macro (e.g. SSH, HTTP, HTTPS)"),
    param("iface", "string", false, "Network interface"),
    param("log", "string", false, "Log level"),
  ], "void"),

  tool("rollback_snapshot", "Rollback a VM or container to a previous snapshot", "risky_write", [
    nodeParam,
    vmidParam,
    param("snapname", "string", true, "Snapshot name to rollback to"),
  ], "string"),

  // ── Destructive Tools ─────────────────────────────────────

  tool("delete_vm", "Permanently delete a VM or container and its disks", "destructive", [
    nodeParam,
    vmidParam,
    param("purge", "boolean", false, "Also remove from HA and replication configs", false),
  ], "string"),

  tool("delete_snapshot", "Delete a snapshot from a VM or container", "destructive", [
    nodeParam,
    vmidParam,
    param("snapname", "string", true, "Snapshot name to delete"),
  ], "string"),

  // ── Task Management ───────────────────────────────────────

  tool("wait_for_task", "Wait for an async task to complete", "read", [
    nodeParam,
    param("upid", "string", true, "Task UPID"),
    param("timeout_ms", "number", false, "Timeout in milliseconds", 120000),
    param("poll_interval_ms", "number", false, "Poll interval in milliseconds", 2000),
  ], "TaskStatus"),
];

// ── Adapter ─────────────────────────────────────────────────

export class ProxmoxAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  private client: ProxmoxClient;
  private _connected = false;
  /**
   * Per-VM cache around the QMP probe — see vm-runtime-status.ts for
   * the rationale. Tests can swap this via {@link setRuntimeStatusCache}.
   */
  private runtimeStatusCache = new VmRuntimeStatusCache();
  /**
   * Set of `node:storage` keys for thin pools currently above the
   * pause-risk threshold. Populated externally (e.g. by the thin-pool
   * monitor) so the adapter can bypass the QMP cache for VMs whose
   * disks live on a pressured pool. Empty by default — the adapter
   * still probes uncached VMs, just at the slower cache-TTL cadence.
   */
  private pressuredPools: Set<string> = new Set();

  constructor(config: ProxmoxConfig) {
    this.client = new ProxmoxClient({
      host: config.host,
      port: config.port,
      tokenId: config.tokenId,
      tokenSecret: config.tokenSecret,
      allowSelfSignedCerts: config.allowSelfSignedCerts,
    });
  }

  /** Test seam — inject a cache with a custom TTL or pre-seeded entries. */
  setRuntimeStatusCache(cache: VmRuntimeStatusCache): void {
    this.runtimeStatusCache = cache;
  }

  /** Mark a node:storage pool as under pause-risk pressure. VMs whose
   *  disks reference this pool will bypass the QMP cache and always
   *  probe. Idempotent. */
  markThinPoolPressured(node: string, storage: string, pressured: boolean): void {
    const key = `${node}:${storage}`;
    if (pressured) this.pressuredPools.add(key);
    else this.pressuredPools.delete(key);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this.client.disconnect();
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  // ── Execute ─────────────────────────────────────────────

  async execute(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    try {
      const data = await this.dispatch(toolName, cleanParams);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatch(
    toolName: string,
    p: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      // ── Read ────────────────────────────────────────────
      case "list_vms":
        return this.listVmsWithRuntimeStatus(p.node as string | undefined);

      case "get_vm_status":
        return this.client.getVMStatus(p.node as string, p.vmid as number);

      case "list_nodes":
        return this.client.getNodes();

      case "get_node_stats":
        return this.client.getNodeStats(p.node as string);

      case "list_snapshots":
        return this.client.listSnapshots(p.node as string, p.vmid as number);

      case "get_vm_config":
        return this.client.getVMConfig(p.node as string, p.vmid as number);

      case "list_storage":
        return this.client.getStorage(p.node as string | undefined);

      case "list_isos":
        return this.client.getISOs(p.node as string, p.storage as string);

      case "list_templates":
        return this.client.getTemplates(p.node as string, p.storage as string);

      case "get_task_status":
        return this.client.getTaskStatus(p.node as string, p.upid as string);

      case "list_tasks":
        return this.client.getTasks(
          p.node as string,
          p.limit as number | undefined
        );

      case "search_logs":
        return this.client.getNodeSyslog(p.node as string, {
          start: p.start as number | undefined,
          limit: p.limit as number | undefined,
          since: p.since as string | undefined,
          until: p.until as string | undefined,
          service: p.service as string | undefined,
        });

      case "list_network_interfaces":
        return this.client.getNetworkInterfaces(p.node as string);

      case "get_vm_firewall_rules":
        return this.client.getVMFirewallRules(
          p.node as string,
          p.vmid as number
        );

      case "wait_for_task":
        return this.client.waitForTask(
          p.node as string,
          p.upid as string,
          (p.timeout_ms as number) ?? 120_000,
          (p.poll_interval_ms as number) ?? 2_000
        );

      // ── Safe Write ──────────────────────────────────────
      case "start_vm":
        return this.client.startVM(p.node as string, p.vmid as number);

      case "create_snapshot":
        return this.client.createSnapshot(
          p.node as string,
          p.vmid as number,
          p.snapname as string,
          p.description as string | undefined,
          p.vmstate as boolean | undefined
        );

      case "resume_vm":
        return this.client.resumeVM(p.node as string, p.vmid as number);

      case "suspend_vm":
        return this.client.suspendVM(p.node as string, p.vmid as number);

      // ── Risky Write ─────────────────────────────────────
      case "create_vm":
        return this.client.createVM({
          node: p.node as string,
          vmid: p.vmid as number,
          name: p.name as string | undefined,
          memory: p.memory as number | undefined,
          cores: p.cores as number | undefined,
          sockets: p.sockets as number | undefined,
          cpu: p.cpu as string | undefined,
          ostype: p.ostype as string | undefined,
          iso: p.iso as string | undefined,
          scsihw: p.scsihw as string | undefined,
          scsi0: p.scsi0 as string | undefined,
          net0: p.net0 as string | undefined,
          boot: p.boot as string | undefined,
          agent: p.agent as string | undefined,
          bios: p.bios as string | undefined,
          machine: p.machine as string | undefined,
          numa: p.numa as number | undefined,
          onboot: p.onboot as number | undefined,
          start: p.start as boolean | undefined,
          tags: p.tags as string | undefined,
        });

      case "create_ct":
        return this.client.createCT({
          node: p.node as string,
          vmid: p.vmid as number,
          hostname: p.hostname as string | undefined,
          ostemplate: p.ostemplate as string,
          memory: p.memory as number | undefined,
          cores: p.cores as number | undefined,
          swap: p.swap as number | undefined,
          rootfs: p.rootfs as string | undefined,
          net0: p.net0 as string | undefined,
          password: p.password as string | undefined,
          ssh_public_keys: p.ssh_public_keys as string | undefined,
          start: p.start as boolean | undefined,
          onboot: p.onboot as number | undefined,
          unprivileged: p.unprivileged as boolean | undefined,
        });

      case "clone_vm":
        return this.client.cloneVM({
          node: p.node as string,
          vmid: p.vmid as number,
          newid: p.newid as number,
          name: p.name as string | undefined,
          target: p.target as string | undefined,
          full: p.full as boolean | undefined,
          storage: p.storage as string | undefined,
          description: p.description as string | undefined,
        });

      case "stop_vm":
        return this.client.stopVM(p.node as string, p.vmid as number);

      case "shutdown_vm":
        return this.client.shutdownVM(
          p.node as string,
          p.vmid as number,
          p.timeout as number | undefined
        );

      case "reboot_vm":
        return this.client.rebootVM(p.node as string, p.vmid as number);

      case "reset_vm":
        return this.client.resetVM(p.node as string, p.vmid as number);

      case "update_vm_config":
        return this.client.updateVMConfig(
          p.node as string,
          p.vmid as number,
          p.config as Record<string, unknown>
        );

      case "resize_disk":
        return this.client.resizeDisk(
          p.node as string,
          p.vmid as number,
          p.disk as string,
          p.size as string
        );

      case "migrate_vm":
        return this.client.migrateVM({
          node: p.node as string,
          vmid: p.vmid as number,
          target: p.target as string,
          online: p.online as boolean | undefined,
          force: p.force as boolean | undefined,
          with_local_disks: p.with_local_disks as boolean | undefined,
          targetstorage: p.targetstorage as string | undefined,
        });

      case "add_firewall_rule":
        return this.client.addVMFirewallRule(
          p.node as string,
          p.vmid as number,
          {
            type: p.type as string,
            action: p.action as string,
            enable: p.enable as boolean | undefined,
            comment: p.comment as string | undefined,
            source: p.source as string | undefined,
            dest: p.dest as string | undefined,
            sport: p.sport as string | undefined,
            dport: p.dport as string | undefined,
            proto: p.proto as string | undefined,
            macro: p.macro as string | undefined,
            iface: p.iface as string | undefined,
            log: p.log as string | undefined,
          }
        );

      case "rollback_snapshot":
        return this.client.rollbackSnapshot(
          p.node as string,
          p.vmid as number,
          p.snapname as string
        );

      // ── Destructive ─────────────────────────────────────
      case "delete_vm":
        return this.client.deleteVM(
          p.node as string,
          p.vmid as number,
          p.purge as boolean | undefined
        );

      case "delete_snapshot":
        return this.client.deleteSnapshot(
          p.node as string,
          p.vmid as number,
          p.snapname as string
        );

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Cluster State ───────────────────────────────────────

  async getClusterState(): Promise<ClusterState> {
    const rawNodes = await this.client.getNodes();
    const nodes: NodeInfo[] = rawNodes.map((n) => ({
      id: n.id || n.node,
      name: n.node,
      status: n.status === "online" ? "online" : n.status === "offline" ? "offline" : "unknown",
      cpu_cores: n.maxcpu ?? 0,
      cpu_usage_pct: n.cpu != null ? Math.round(n.cpu * 10000) / 100 : 0,
      ram_total_mb: n.maxmem ? Math.round(n.maxmem / 1024 / 1024) : 0,
      ram_used_mb: n.mem ? Math.round(n.mem / 1024 / 1024) : 0,
      disk_total_gb: n.maxdisk ? Math.round((n.maxdisk / 1024 / 1024 / 1024) * 100) / 100 : 0,
      disk_used_gb: n.disk ? Math.round((n.disk / 1024 / 1024 / 1024) * 100) / 100 : 0,
      disk_usage_pct: n.maxdisk ? Math.round((n.disk / n.maxdisk) * 10000) / 100 : 0,
      uptime_s: n.uptime ?? 0,
    }));

    const vms: VMInfo[] = [];
    const containers: ContainerInfo[] = [];
    const storageMap = new Map<string, StorageInfo>();

    for (const node of rawNodes) {
      if (node.status !== "online") continue;

      try {
        const rawVMs = await this.client.getVMs(node.node);
        for (const vm of rawVMs) {
          const baseInfo = {
            id: vm.vmid,
            name: vm.name || `vm-${vm.vmid}`,
            node: vm.node || node.node,
            status: this.mapVMStatus(vm.status),
            cpu_cores: vm.cpus ?? 0,
            ram_mb: vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : 0,
            disk_gb: vm.maxdisk ? Math.round(vm.maxdisk / 1024 / 1024 / 1024 * 10) / 10 : 0,
            uptime_s: vm.uptime ?? 0,
          };

          if (vm.type === "lxc") {
            const ctStatus = baseInfo.status === "paused" ? "stopped" as const : baseInfo.status;
            containers.push({ ...baseInfo, status: ctStatus });
          } else {
            const { runtime_status, runtime_reason } =
              await this.resolveRuntimeStatus(vm.node || node.node, vm);
            vms.push({ ...baseInfo, runtime_status, runtime_reason });
          }
        }
      } catch {
        // Node may have errored; continue with others
      }

      try {
        const rawStorage = await this.client.getStorage(node.node);
        for (const s of rawStorage) {
          const key = `${node.node}:${s.storage}`;
          if (!storageMap.has(key)) {
            storageMap.set(key, {
              id: s.storage,
              node: node.node,
              type: s.type,
              total_gb: s.total ? Math.round(s.total / 1024 / 1024 / 1024 * 10) / 10 : 0,
              used_gb: s.used ? Math.round(s.used / 1024 / 1024 / 1024 * 10) / 10 : 0,
              available_gb: s.avail ? Math.round(s.avail / 1024 / 1024 / 1024 * 10) / 10 : 0,
              content: s.content ? s.content.split(",") : [],
            });
          }
        }
      } catch {
        // Continue
      }
    }

    return {
      adapter: ADAPTER_NAME,
      nodes,
      vms,
      containers,
      storage: Array.from(storageMap.values()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * `list_vms` tool entrypoint. Wraps `client.getVMs` with
   * runtime-status derivation so callers see `runtime_status` and
   * `runtime_reason` on every QEMU entry. LXC containers pass through
   * unchanged. Kept on the tool path (not just `getClusterState`) so
   * the health monitor — which goes through the tool registry —
   * sees the same fields.
   */
  private async listVmsWithRuntimeStatus(node: string | undefined) {
    const raw = await this.client.getVMs(node);
    const enriched: Array<Record<string, unknown>> = [];
    for (const vm of raw) {
      if (vm.type === "lxc") {
        enriched.push(vm as unknown as Record<string, unknown>);
        continue;
      }
      const vmNode = vm.node || node || "";
      if (!vmNode) {
        enriched.push(vm as unknown as Record<string, unknown>);
        continue;
      }
      const { runtime_status, runtime_reason } =
        await this.resolveRuntimeStatus(vmNode, vm);
      enriched.push({ ...(vm as unknown as Record<string, unknown>), runtime_status, runtime_reason });
    }
    return enriched;
  }

  private mapVMStatus(status: string): VMInfo["status"] {
    switch (status) {
      case "running":
        return "running";
      case "stopped":
        return "stopped";
      case "paused":
        return "paused";
      default:
        return "unknown";
    }
  }

  /**
   * Decide whether this VM needs a QMP probe right now, fire it if so,
   * and derive the truthful runtime state. The cache + thin-pool
   * gating live here so the cost of the probe is bounded.
   *
   * The reason qualifier mirrors the QMP status when present (io-error,
   * internal-error, paused) or falls back to the lock reason for
   * `runtime_status === "locked"`.
   */
  private async resolveRuntimeStatus(
    node: string,
    vm: { vmid: number; status: string; lock?: string; qmpstatus?: string },
  ): Promise<{ runtime_status: RuntimeStatus; runtime_reason?: string }> {
    let qmpstatus = vm.qmpstatus;

    if (
      this.runtimeStatusCache.shouldProbe(node, vm.vmid, {
        status: vm.status,
        lock: vm.lock,
        thinPoolPressure: this.hasThinPoolPressure(node, vm.vmid),
      })
    ) {
      try {
        const probed = await this.client.getVMQmpStatus(node, vm.vmid);
        if (probed) {
          qmpstatus = probed;
          this.runtimeStatusCache.record(node, vm.vmid, probed);
        }
      } catch {
        // Probe failure must not break cluster-state collection — fall
        // back to whatever the basic list endpoint told us.
      }
    } else {
      const cached = this.runtimeStatusCache.getCached(node, vm.vmid);
      if (cached) qmpstatus = cached;
    }

    if (vm.status === "stopped") {
      // Stopped VMs never need a stale QMP cache hanging around.
      this.runtimeStatusCache.invalidate(node, vm.vmid);
    }

    const runtime_status = deriveRuntimeStatus({
      status: vm.status,
      lock: vm.lock,
      qmpstatus,
    });

    const runtime_reason = this.runtimeReason(runtime_status, {
      lock: vm.lock,
      qmpstatus,
    });
    return runtime_reason ? { runtime_status, runtime_reason } : { runtime_status };
  }

  private hasThinPoolPressure(_node: string, _vmid: number): boolean {
    // Without a VM→pool map handy we treat ANY pressured pool on this
    // node as a reason to probe — the cost is bounded (only fires when
    // a thin pool is already in the danger zone). Future work: thread
    // the per-VM disk-storage list through here so we only probe VMs
    // that actually live on the pressured pool.
    for (const key of this.pressuredPools) {
      if (key.startsWith(`${_node}:`)) return true;
    }
    return false;
  }

  private runtimeReason(
    status: RuntimeStatus,
    inputs: { lock?: string; qmpstatus?: string },
  ): string | undefined {
    switch (status) {
      case "paused_io_error":
        return "io-error";
      case "paused_other":
        return inputs.qmpstatus?.toLowerCase() ?? inputs.lock?.toLowerCase() ?? "paused";
      case "locked":
        return inputs.lock?.toLowerCase();
      case "error":
        return inputs.qmpstatus?.toLowerCase() ?? "unknown";
      default:
        return undefined;
    }
  }
}
