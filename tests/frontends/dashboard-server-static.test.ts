import { describe, expect, it, vi } from "vitest";
import { DashboardServer } from "../../src/frontends/dashboard/server";

function makeServer() {
  const eventBus = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getHistory: vi.fn(() => []),
  } as any;

  const toolRegistry = {
    getClusterState: vi.fn(),
    getMultiClusterState: vi.fn(),
  } as any;

  const audit = {
    queryEntries: vi.fn(() => []),
    getStats: vi.fn(() => ({})),
    exportEntries: vi.fn(() => "[]"),
  } as any;

  return new DashboardServer(0, {} as any, toolRegistry, eventBus, audit) as any;
}

function makeReq(path: string) {
  return { url: path, method: "GET" } as any;
}

function makeJsonReq(path: string, body: Record<string, unknown>) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  return {
    url: path,
    method: "POST",
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return this;
    },
    flush() {
      const payload = Buffer.from(JSON.stringify(body));
      for (const cb of listeners.data ?? []) cb(payload);
      for (const cb of listeners.end ?? []) cb();
    },
  } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body: unknown;

  return {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code;
      if (nextHeaders) {
        for (const [name, value] of Object.entries(nextHeaders)) {
          headers[name.toLowerCase()] = value;
        }
      }
    },
    end(chunk?: unknown) {
      body = chunk;
    },
    getStatusCode() {
      return statusCode;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    getBody() {
      return body;
    },
  };
}

function makeMigrationPlan(id: string) {
  return {
    id,
    source: { provider: "vmware", vmId: "vm-1", vmName: "vm-1", host: "source-host" },
    target: { provider: "azure", node: "eastus", host: "azure", storage: "managed-disk" },
    vmConfig: {
      name: "vm-1",
      cpuCount: 2,
      coresPerSocket: 1,
      memoryMiB: 4096,
      guestOS: "otherLinux64Guest",
      disks: [],
      nics: [],
      firmware: "bios",
    },
    status: "pending",
    steps: [],
  };
}

interface MigrationDirectionRouteCase {
  direction: string;
  vmId: string | number;
  idParam: "vm_id" | "instance_id";
  executable: boolean;
}

const MIGRATION_DIRECTION_ROUTE_CASES: MigrationDirectionRouteCase[] = [
  { direction: "vmware_to_proxmox", vmId: "vm-100", idParam: "vm_id", executable: true },
  { direction: "proxmox_to_vmware", vmId: 112, idParam: "vm_id", executable: true },
  { direction: "vmware_to_aws", vmId: "vm-200", idParam: "vm_id", executable: true },
  { direction: "aws_to_vmware", vmId: "i-0123456789abcdef0", idParam: "instance_id", executable: true },
  { direction: "proxmox_to_aws", vmId: 113, idParam: "vm_id", executable: true },
  { direction: "aws_to_proxmox", vmId: "i-abcdef01234567890", idParam: "instance_id", executable: true },
  { direction: "vmware_to_azure", vmId: "vm-az-200", idParam: "vm_id", executable: true },
  {
    direction: "azure_to_vmware",
    vmId: "/subscriptions/sub/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/web-1",
    idParam: "vm_id",
    executable: false,
  },
  { direction: "proxmox_to_azure", vmId: 114, idParam: "vm_id", executable: true },
  {
    direction: "azure_to_proxmox",
    vmId: "/subscriptions/sub/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/api-1",
    idParam: "vm_id",
    executable: true,
  },
  { direction: "aws_to_azure", vmId: "i-1234567890abcdef0", idParam: "instance_id", executable: true },
  {
    direction: "azure_to_aws",
    vmId: "/subscriptions/sub/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/cache-1",
    idParam: "vm_id",
    executable: true,
  },
];

describe("Dashboard server static routing", () => {
  it("serves root-level static assets from dashboard-v2 dist", () => {
    const server = makeServer();
    const res = makeRes();

    server.handleRequest(makeReq("/vclaw-logo.png"), res);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/png");
    expect(Buffer.isBuffer(res.getBody())).toBe(true);
  });

  it("rejects path traversal attempts instead of falling back to SPA", () => {
    const server = makeServer();
    const res = makeRes();

    server.handleRequest(makeReq("/..%2Fpackage.json"), res);

    expect(res.getStatusCode()).toBe(404);
    expect(res.getHeader("content-type")).toContain("application/json");
    expect(String(res.getBody())).toContain("Not found");
  });

  it("allows azure provider for migration VM listing", async () => {
    const server = makeServer();
    server.migrationAdapter = { execute: vi.fn() } as any;
    server.toolRegistry.getMultiClusterState.mockResolvedValue({
      providers: [
        {
          type: "azure",
          state: {
            vms: [
              {
                id: "vm-az-1",
                name: "api-azure-1",
                status: "running",
                cpu_cores: 4,
                ram_mb: 8192,
                disk_gb: 128,
              },
            ],
          },
        },
      ],
    });
    const res = makeRes();

    await server.handleMigrationVMs(
      res,
      new URL("http://localhost/api/migration/vms?provider=azure"),
    );

    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("application/json");

    const payload = JSON.parse(String(res.getBody()));
    expect(payload.vms).toEqual([
      {
        id: "vm-az-1",
        name: "api-azure-1",
        provider: "azure",
        status: "running",
        cpu: 4,
        memoryMiB: 8192,
        diskGB: 128,
      },
    ]);
  });

  it("rejects unsupported migration VM providers", async () => {
    const server = makeServer();
    server.migrationAdapter = { execute: vi.fn() } as any;
    const res = makeRes();

    await server.handleMigrationVMs(
      res,
      new URL("http://localhost/api/migration/vms?provider=digitalocean"),
    );

    expect(res.getStatusCode()).toBe(400);
    expect(res.getHeader("content-type")).toContain("application/json");
    expect(String(res.getBody())).toContain("Invalid provider");
  });

  it.each(MIGRATION_DIRECTION_ROUTE_CASES)(
    "routes migration plan direction $direction through tool mapping",
    async ({ direction, vmId, idParam, executable }) => {
      const server = makeServer();
      const execute = vi.fn().mockResolvedValue({ success: true, data: makeMigrationPlan(`plan-${direction}`) });
      server.migrationAdapter = { execute } as any;

      const req = makeJsonReq("/api/migration/plan", {
        direction,
        vm_id: vmId,
      });
      const res = makeRes();

      const pending = server.handleMigrationPlan(req, res);
      req.flush();
      await pending;

      expect(execute).toHaveBeenCalledWith(`plan_migration_${direction}`, { [idParam]: vmId });
      expect(res.getStatusCode()).toBe(200);
      const payload = JSON.parse(String(res.getBody()));
      expect(payload.direction).toBe(direction);
      expect(payload.executable).toBe(executable);
      if (executable) {
        expect(payload.executable_reason).toBeUndefined();
      } else {
        expect(payload.executable_reason).toContain(`Execution pipeline for ${direction} has not been implemented yet`);
      }
    },
  );

  it("normalizes migration plan direction before routing", async () => {
    const server = makeServer();
    const execute = vi.fn().mockResolvedValue({ success: true, data: makeMigrationPlan("plan-proxmox-azure") });
    server.migrationAdapter = { execute } as any;

    const req = makeJsonReq("/api/migration/plan", {
      direction: "  Proxmox-To-Azure  ",
      vm_id: 114,
    });
    const res = makeRes();

    const pending = server.handleMigrationPlan(req, res);
    req.flush();
    await pending;

    expect(execute).toHaveBeenCalledWith("plan_migration_proxmox_to_azure", { vm_id: 114 });
    expect(res.getStatusCode()).toBe(200);
    const payload = JSON.parse(String(res.getBody()));
    expect(payload.direction).toBe("proxmox_to_azure");
    expect(payload.executable).toBe(true);
  });

  it.each(MIGRATION_DIRECTION_ROUTE_CASES)(
    "routes migration execute direction $direction through tool mapping",
    async ({ direction, vmId, idParam }) => {
      const server = makeServer();
      const execute = vi.fn().mockResolvedValue({ success: true, data: makeMigrationPlan(`exec-${direction}`) });
      server.migrationAdapter = { execute } as any;

      const req = makeJsonReq("/api/migration/execute", {
        direction,
        vm_id: vmId,
      });
      const res = makeRes();

      const pending = server.handleMigrationExecute(req, res);
      req.flush();
      await pending;

      expect(execute).toHaveBeenCalledWith(`migrate_${direction}`, { [idParam]: vmId });
      expect(res.getStatusCode()).toBe(200);
    },
  );

  it("normalizes migration execute direction before routing", async () => {
    const server = makeServer();
    const execute = vi.fn().mockResolvedValue({ success: true, data: makeMigrationPlan("exec-proxmox-azure") });
    server.migrationAdapter = { execute } as any;

    const req = makeJsonReq("/api/migration/execute", {
      direction: "Proxmox-To-Azure",
      vm_id: 114,
    });
    const res = makeRes();

    const pending = server.handleMigrationExecute(req, res);
    req.flush();
    await pending;

    expect(execute).toHaveBeenCalledWith("migrate_proxmox_to_azure", { vm_id: 114 });
    expect(res.getStatusCode()).toBe(200);
  });

  it("rejects unsupported migration plan directions", async () => {
    const server = makeServer();
    const execute = vi.fn();
    server.migrationAdapter = { execute } as any;

    const req = makeJsonReq("/api/migration/plan", {
      direction: "digitalocean_to_azure",
      vm_id: "droplet-1",
    });
    const res = makeRes();

    const pending = server.handleMigrationPlan(req, res);
    req.flush();
    await pending;

    expect(execute).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(400);
    expect(String(res.getBody())).toContain("Unsupported migration direction");
  });

  it("rejects unsupported migration execute directions", async () => {
    const server = makeServer();
    const execute = vi.fn();
    server.migrationAdapter = { execute } as any;

    const req = makeJsonReq("/api/migration/execute", {
      direction: "azure_to_digitalocean",
      vm_id: "vm-1",
    });
    const res = makeRes();

    const pending = server.handleMigrationExecute(req, res);
    req.flush();
    await pending;

    expect(execute).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(400);
    expect(String(res.getBody())).toContain("Unsupported migration direction");
  });
});
