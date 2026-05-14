import { spawn } from "node:child_process";
import type {
  AdapterKind,
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../types.js";
import { classifyCommand } from "../ssh/safety.js";

export interface SystemAdapterConfig {
  sshStrictHostKeyCheck?: boolean;
}

export class SystemAdapter implements InfraAdapter {
  name = "system";
  // System is a generic SSH/utility adapter — not a hypervisor.
  kind: AdapterKind = "service";
  private _connected = false;
  private readonly sshStrictHostKeyCheck: boolean;
  private static readonly MAX_PACKAGE_INPUT_LENGTH = 512;
  private static readonly PACKAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9+_.:-]*$/;

  // ── configureService input-validation gates ──────────────────
  //
  // Security C-1 (HIGH, docs/audits/security-2026-05-14.md): before
  // the fix, `service` and `config_path` were shell-interpolated into
  // a script string. Both are now validated against strict allowlists
  // BEFORE any command is constructed, AND each constructed remote
  // command is re-classified by the SSH safety classifier as a
  // defense-in-depth check. Two layers must agree before anything ships.
  //
  // SERVICE_NAME_PATTERN matches what systemd permits in unit names —
  // alphanumerics plus `_`, `.`, `@`, `:`, `-`. No spaces, no quotes,
  // no shell metacharacters, no path separators.
  private static readonly SERVICE_NAME_PATTERN = /^[a-zA-Z0-9_.@:-]+$/;
  private static readonly MAX_SERVICE_NAME_LENGTH = 128;

  // CONFIG_PATH_PATTERN: absolute path containing only the limited
  // character set we know we can quote safely. No spaces, no quotes,
  // no metachars, no backslash. We further enforce a prefix allowlist
  // and a `..`-segment ban.
  private static readonly CONFIG_PATH_PATTERN = /^\/[a-zA-Z0-9_./@:-]+$/;
  private static readonly CONFIG_PATH_ALLOWED_PREFIXES = [
    "/etc/",
    "/var/lib/",
    "/usr/local/etc/",
    "/opt/",
    "/srv/",
  ];
  private static readonly MAX_CONFIG_PATH_LENGTH = 512;

  // Actions allowed by configure_service. Anything not in this set
  // is refused before any command is built.
  private static readonly CONFIGURE_SERVICE_ACTIONS = new Set([
    "enable_and_start",
    "start",
    "stop",
    "restart",
    "enable",
    "status",
  ]);

  constructor(config: SystemAdapterConfig = {}) {
    this.sshStrictHostKeyCheck = config.sshStrictHostKeyCheck ?? true;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: "ssh_exec",
        description:
          "Execute a command on a remote host via SSH. Use for post-deployment configuration, log retrieval, and service management.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "command", type: "string", required: true, description: "Command to execute" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 30000 },
        ],
        returns: "{ stdout, stderr, exitCode }",
      },
      {
        name: "local_exec",
        description:
          "Execute a command on the local machine. Use for local tool invocations or checks.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "command", type: "string", required: true, description: "Command to execute" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 30000 },
        ],
        returns: "{ stdout, stderr, exitCode }",
      },
      {
        name: "ping",
        description: "Check if a host is reachable via ICMP ping.",
        tier: "read",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "count", type: "number", required: false, description: "Number of pings", default: 3 },
        ],
        returns: "{ reachable, latency_ms, packet_loss_pct }",
      },
      {
        name: "install_packages",
        description:
          "Install packages on a remote host via SSH. Automatically detects the package manager (apt, yum, dnf, apk) and runs the install. Use this after creating a VM to set up software.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "packages", type: "string", required: true, description: "Space-separated list of packages to install (e.g. 'nginx docker.io curl')" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 120000 },
        ],
        returns: "{ stdout, stderr, exitCode, packages_installed }",
      },
      {
        name: "configure_service",
        description:
          "Enable and start a systemd service on a remote host. Optionally write a config file before starting. Inputs are validated against strict allowlists and each constructed remote command is re-classified by the SSH safety classifier.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "service", type: "string", required: true, description: "Service name (e.g. 'nginx', 'docker'). Must match /^[a-zA-Z0-9_.@:-]+$/." },
          { name: "config_path", type: "string", required: false, description: "Path to write a config file before starting. Must be absolute and start with one of /etc/, /var/lib/, /usr/local/etc/, /opt/, /srv/." },
          { name: "config_content", type: "string", required: false, description: "Content to write to config_path (streamed over stdin; never shell-interpolated)." },
          { name: "action", type: "string", required: false, description: "Action: start, stop, restart, enable, status, enable_and_start", default: "enable_and_start" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 30000 },
        ],
        returns: "{ stdout, stderr, exitCode, service_status, steps }",
      },
      {
        name: "run_script",
        description:
          "Upload and execute a multi-line shell script on a remote host via SSH. Use for complex provisioning that requires multiple commands.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "script", type: "string", required: true, description: "Multi-line shell script to execute" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 300000 },
        ],
        returns: "{ stdout, stderr, exitCode }",
      },
      {
        name: "wait_for_ssh",
        description:
          "Wait for SSH to become available on a host. Use after creating a VM to ensure it's ready for configuration. Polls every 5 seconds.",
        tier: "read",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "max_wait_s", type: "number", required: false, description: "Maximum wait time in seconds", default: 120 },
        ],
        returns: "{ available, wait_time_s }",
      },
    ];
  }

  async execute(
    tool: string,
    params: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    switch (tool) {
      case "ssh_exec":
        return this.sshExec(cleanParams);
      case "local_exec":
        return this.localExec(cleanParams);
      case "ping":
        return this.ping(cleanParams);
      case "install_packages":
        return this.installPackages(cleanParams);
      case "configure_service":
        return this.configureService(cleanParams);
      case "run_script":
        return this.runScript(cleanParams);
      case "wait_for_ssh":
        return this.waitForSsh(cleanParams);
      default:
        return { success: false, error: `Unknown system tool: ${tool}` };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    return {
      adapter: "system",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  private async sshExec(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const command = params.command as string;
    const timeout = (params.timeout_ms as number) || 30000;

    if (!host || !command) {
      return { success: false, error: "host and command are required" };
    }

    return this.runProcess(
      "ssh",
      [
        ...this.buildSshOptions(Math.ceil(timeout / 1000)),
        `${user}@${host}`,
        command,
      ],
      timeout
    );
  }

  private async localExec(params: Record<string, unknown>): Promise<ToolCallResult> {
    const command = params.command as string;
    const timeout = (params.timeout_ms as number) || 30000;

    if (!command) {
      return { success: false, error: "command is required" };
    }

    return this.runProcess("bash", ["-c", command], timeout);
  }

  private async ping(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const count = (params.count as number) || 3;

    if (!host) {
      return { success: false, error: "host is required" };
    }

    const result = await this.runProcess(
      "ping",
      ["-c", String(count), "-W", "2", host],
      10000
    );

    if (!result.success) {
      return {
        success: true,
        data: { reachable: false, latency_ms: null, packet_loss_pct: 100 },
      };
    }

    const output = (result.data as { stdout: string }).stdout;
    const lossMatch = output.match(/(\d+(?:\.\d+)?)% packet loss/);
    const latencyMatch = output.match(/rtt min\/avg\/max\/mdev = [\d.]+\/([\d.]+)/);

    return {
      success: true,
      data: {
        reachable: true,
        latency_ms: latencyMatch ? parseFloat(latencyMatch[1]) : null,
        packet_loss_pct: lossMatch ? parseFloat(lossMatch[1]) : 0,
      },
    };
  }

  private async installPackages(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const packages = params.packages as string;
    const timeout = (params.timeout_ms as number) || 120000;

    if (!host || !packages) {
      return { success: false, error: "host and packages are required" };
    }

    const validation = this.validatePackageList(packages);
    if (!validation.success) {
      return { success: false, error: validation.error };
    }

    const safePackageList = validation.packages.map((pkg) => this.quoteShellWord(pkg)).join(" ");

    const script = `
      if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq ${safePackageList}
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y ${safePackageList}
      elif command -v yum >/dev/null 2>&1; then
        yum install -y ${safePackageList}
      elif command -v apk >/dev/null 2>&1; then
        apk add ${safePackageList}
      else
        echo "No supported package manager found" >&2
        exit 1
      fi
    `;

    const result = await this.runProcess(
      "ssh",
      [
        ...this.buildSshOptions(10),
        `${user}@${host}`,
        script,
      ],
      timeout,
    );

    if (result.success) {
      return {
        success: true,
        data: {
          ...(result.data as Record<string, unknown>),
          packages_installed: validation.packages,
        },
      };
    }
    return result;
  }

  private validatePackageList(rawPackages: string): { success: true; packages: string[] } | { success: false; error: string } {
    if (rawPackages.includes("\0")) {
      return { success: false, error: "packages contains invalid null bytes" };
    }

    const trimmed = rawPackages.trim();
    if (!trimmed) {
      return { success: false, error: "packages must contain at least one package name" };
    }

    if (trimmed.length > SystemAdapter.MAX_PACKAGE_INPUT_LENGTH) {
      return {
        success: false,
        error: `packages input exceeds ${SystemAdapter.MAX_PACKAGE_INPUT_LENGTH} characters`,
      };
    }

    const packages = trimmed.split(/\s+/);
    const invalid = packages.find((pkg) => !SystemAdapter.PACKAGE_NAME_PATTERN.test(pkg));
    if (invalid) {
      return {
        success: false,
        error: `packages contains invalid token: "${invalid}"`,
      };
    }

    return { success: true, packages };
  }

  private async configureService(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const service = params.service as string;
    const configPath = params.config_path as string | undefined;
    const configContent = params.config_content as string | undefined;
    const action = (params.action as string) || "enable_and_start";
    const timeout = (params.timeout_ms as number) || 30000;

    if (!host || !service) {
      return { success: false, error: "host and service are required" };
    }

    // ── Layer 1: strict input validation (security C-1 HIGH) ─────
    //
    // Reject anything that doesn't match the systemd-allowed
    // character set before we construct any command. This kills
    // shell-injection at the earliest possible point.
    const serviceCheck = this.validateServiceName(service);
    if (!serviceCheck.success) {
      return { success: false, error: serviceCheck.error };
    }

    const wantsConfigWrite = configPath !== undefined || configContent !== undefined;
    let validatedConfigPath: string | undefined;
    if (wantsConfigWrite) {
      if (!configPath || configContent === undefined) {
        return {
          success: false,
          error: "config_path and config_content must be provided together",
        };
      }
      const pathCheck = this.validateConfigPath(configPath);
      if (!pathCheck.success) {
        return { success: false, error: pathCheck.error };
      }
      validatedConfigPath = pathCheck.path;
    }

    if (!SystemAdapter.CONFIGURE_SERVICE_ACTIONS.has(action)) {
      return { success: false, error: `Unknown action: ${action}` };
    }

    // ── Layer 2: write config (if requested) via argv-style `tee`,
    // streaming content over stdin so the file CONTENT is never
    // shell-interpreted on either side.
    if (validatedConfigPath && configContent !== undefined) {
      const writeResult = await this.writeRemoteFile({
        host,
        user,
        path: validatedConfigPath,
        content: configContent,
        timeoutMs: timeout,
      });
      if (!writeResult.success) {
        return writeResult;
      }
    }

    // ── Layer 3: run each systemctl step as a SEPARATE single-verb
    // ssh call. That keeps every constructed command classifier-
    // friendly (no `&&` chain → no metachar gate). The SSH classifier
    // tags each `systemctl <mutate> <service>` as `risky_write`
    // (rule `systemctl-mutate`) and `systemctl status ...` as `read`.
    // Defense-in-depth: re-classify each command before dispatch and
    // refuse if anything comes back `destructive` or `never`.
    const steps = this.buildConfigureServiceSteps(action, service);
    const stepResults: Array<{
      step: string;
      tier: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    }> = [];

    for (const step of steps) {
      const classification = classifyCommand(step);
      if (classification.tier === "destructive" || classification.tier === "never") {
        // Should be unreachable after validation; bail hard if not.
        return {
          success: false,
          error:
            `configure_service: refused — built command classified as ${classification.tier} ` +
            `(${classification.match}). This indicates an input-validation gap; aborting.`,
          data: { step, classification },
        };
      }

      const stepResult = await this.runProcess(
        "ssh",
        [
          ...this.buildSshOptions(10),
          `${user}@${host}`,
          step,
        ],
        timeout,
      );

      const data = (stepResult.data as { stdout?: string; stderr?: string; exitCode?: number }) ?? {};
      stepResults.push({
        step,
        tier: classification.tier,
        stdout: data.stdout ?? "",
        stderr: data.stderr ?? "",
        exitCode: data.exitCode ?? 1,
      });

      if (!stepResult.success) {
        return {
          success: false,
          error: stepResult.error ?? `Step failed: ${step}`,
          data: { steps: stepResults },
        };
      }
    }

    const lastStdout = stepResults[stepResults.length - 1]?.stdout ?? "";
    const lastStderr = stepResults[stepResults.length - 1]?.stderr ?? "";

    return {
      success: true,
      data: {
        stdout: lastStdout,
        stderr: lastStderr,
        exitCode: 0,
        service_status: "active",
        steps: stepResults,
      },
    };
  }

  /**
   * Construct the ordered list of single-verb shell commands that
   * implement a configure_service action. Each entry is a complete,
   * standalone command that the SSH safety classifier can tier in
   * isolation — there is intentionally no `&&` chaining.
   */
  private buildConfigureServiceSteps(action: string, service: string): string[] {
    // `service` was validated against SERVICE_NAME_PATTERN above,
    // which excludes every shell metacharacter, so it is safe to
    // splice without quoting.
    switch (action) {
      case "enable_and_start":
        return [
          `systemctl enable ${service}`,
          `systemctl start ${service}`,
          `systemctl status ${service} --no-pager`,
        ];
      case "start":
        return [
          `systemctl start ${service}`,
          `systemctl status ${service} --no-pager`,
        ];
      case "stop":
        return [`systemctl stop ${service}`];
      case "restart":
        return [
          `systemctl restart ${service}`,
          `systemctl status ${service} --no-pager`,
        ];
      case "enable":
        return [`systemctl enable ${service}`];
      case "status":
        return [`systemctl status ${service} --no-pager`];
      default:
        return [];
    }
  }

  /**
   * Write a remote file using `tee` with the path passed as a
   * single-quoted argv token. Content is streamed via stdin so it
   * is NEVER shell-interpreted. The directory is created up front
   * with a separate `mkdir -p` call against a quoted path.
   */
  private async writeRemoteFile(opts: {
    host: string;
    user: string;
    path: string;
    content: string;
    timeoutMs: number;
  }): Promise<ToolCallResult> {
    const quotedPath = this.quoteShellWord(opts.path);
    // Build the dir name locally without invoking the shell (no
    // `$(dirname ...)`): opts.path was validated to start with `/`,
    // so the prefix up to the last `/` is the dirname.
    const dirname = opts.path.includes("/")
      ? opts.path.slice(0, opts.path.lastIndexOf("/")) || "/"
      : "/";
    const quotedDir = this.quoteShellWord(dirname);

    // Step 1: mkdir -p <dir>. Classifies as `safe_write`.
    const mkdirCmd = `mkdir -p ${quotedDir}`;
    const mkdirClass = classifyCommand(mkdirCmd);
    if (mkdirClass.tier === "destructive" || mkdirClass.tier === "never") {
      return {
        success: false,
        error: `configure_service: refused — mkdir step classified as ${mkdirClass.tier} (${mkdirClass.match}).`,
      };
    }
    const mkdirResult = await this.runProcess(
      "ssh",
      [...this.buildSshOptions(10), `${opts.user}@${opts.host}`, mkdirCmd],
      opts.timeoutMs,
    );
    if (!mkdirResult.success) {
      return mkdirResult;
    }

    // Step 2: stream content into `tee <path>` via stdin. The
    // command on the remote side never sees the content as a shell
    // token; it only sees `tee <quoted-path>`. The input-validation
    // layer (path prefix allowlist + character allowlist + ".." ban)
    // is the actual gate that makes the path safe.
    const teeCmd = `tee ${quotedPath} >/dev/null`;
    return this.runProcess(
      "ssh",
      [...this.buildSshOptions(10), `${opts.user}@${opts.host}`, teeCmd],
      opts.timeoutMs,
      opts.content,
    );
  }

  private validateServiceName(
    raw: string,
  ): { success: true; service: string } | { success: false; error: string } {
    if (typeof raw !== "string") {
      return { success: false, error: "service must be a string" };
    }
    if (raw.length === 0) {
      return { success: false, error: "service must be non-empty" };
    }
    if (raw.length > SystemAdapter.MAX_SERVICE_NAME_LENGTH) {
      return {
        success: false,
        error: `service exceeds ${SystemAdapter.MAX_SERVICE_NAME_LENGTH} characters`,
      };
    }
    if (raw.includes("\0")) {
      return { success: false, error: "service contains invalid null bytes" };
    }
    if (!SystemAdapter.SERVICE_NAME_PATTERN.test(raw)) {
      return {
        success: false,
        error:
          `service "${raw}" contains characters outside the systemd-allowed ` +
          `set [a-zA-Z0-9_.@:-]. Refused to prevent shell injection.`,
      };
    }
    return { success: true, service: raw };
  }

  private validateConfigPath(
    raw: string,
  ): { success: true; path: string } | { success: false; error: string } {
    if (typeof raw !== "string") {
      return { success: false, error: "config_path must be a string" };
    }
    if (raw.length === 0) {
      return { success: false, error: "config_path must be non-empty" };
    }
    if (raw.length > SystemAdapter.MAX_CONFIG_PATH_LENGTH) {
      return {
        success: false,
        error: `config_path exceeds ${SystemAdapter.MAX_CONFIG_PATH_LENGTH} characters`,
      };
    }
    if (raw.includes("\0")) {
      return { success: false, error: "config_path contains invalid null bytes" };
    }
    if (!SystemAdapter.CONFIG_PATH_PATTERN.test(raw)) {
      return {
        success: false,
        error:
          `config_path "${raw}" contains characters outside the allowed set ` +
          `[a-zA-Z0-9_./@:-] (must be an absolute path with no quotes / metachars).`,
      };
    }
    // No path-traversal segments.
    if (raw.split("/").some((segment) => segment === "..")) {
      return {
        success: false,
        error: `config_path "${raw}" contains a ".." segment; refused.`,
      };
    }
    const prefixOk = SystemAdapter.CONFIG_PATH_ALLOWED_PREFIXES.some((p) =>
      raw.startsWith(p),
    );
    if (!prefixOk) {
      return {
        success: false,
        error:
          `config_path "${raw}" is outside the allowed prefixes ` +
          `(${SystemAdapter.CONFIG_PATH_ALLOWED_PREFIXES.join(", ")}).`,
      };
    }
    return { success: true, path: raw };
  }

  private async runScript(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const script = params.script as string;
    const timeout = (params.timeout_ms as number) || 300000;

    if (!host || !script) {
      return { success: false, error: "host and script are required" };
    }

    return this.runProcess(
      "ssh",
      [
        ...this.buildSshOptions(10),
        `${user}@${host}`,
        script,
      ],
      timeout,
    );
  }

  private async waitForSsh(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const maxWait = (params.max_wait_s as number) || 120;

    if (!host) {
      return { success: false, error: "host is required" };
    }

    const start = Date.now();
    const deadline = start + maxWait * 1000;

    while (Date.now() < deadline) {
      const result = await this.runProcess(
        "ssh",
        [
          ...this.buildSshOptions(5, ["-o", "BatchMode=yes"]),
          `${user}@${host}`,
          "echo ok",
        ],
        10000,
      );

      if (result.success) {
        const waitTime = (Date.now() - start) / 1000;
        return {
          success: true,
          data: { available: true, wait_time_s: Math.round(waitTime * 10) / 10 },
        };
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    return {
      success: false,
      error: `SSH not available after ${maxWait}s`,
      data: { available: false, wait_time_s: maxWait },
    };
  }

  private runProcess(
    cmd: string,
    args: string[],
    timeout: number,
    stdin?: string,
  ): Promise<ToolCallResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const proc = stdin !== undefined
        ? spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] })
        : spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

      if (stdin !== undefined && proc.stdin) {
        proc.stdin.on("error", () => {
          // Ignore EPIPE — child may exit before we finish writing.
        });
        proc.stdin.end(stdin);
      }

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
      }, timeout);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 10240) {
          stdout = stdout.slice(0, 10240) + "\n...[truncated]";
          proc.kill("SIGTERM");
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 5120) {
          stderr = stderr.slice(0, 5120) + "\n...[truncated]";
        }
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({
            success: false,
            error: `Command timed out after ${timeout}ms`,
            data: { stdout, stderr, exitCode: 124 },
          });
        } else {
          resolve({
            success: code === 0,
            data: { stdout, stderr, exitCode: code ?? 1 },
            error: code !== 0 ? `Exit code: ${code}` : undefined,
          });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      });
    });
  }

  private buildSshOptions(connectTimeoutSeconds: number, extra: string[] = []): string[] {
    const strictMode = this.sshStrictHostKeyCheck ? "yes" : "no";
    const options = ["-o", `StrictHostKeyChecking=${strictMode}`];
    if (!this.sshStrictHostKeyCheck) {
      options.push("-o", "UserKnownHostsFile=/dev/null");
    }
    options.push(
      "-o",
      `ConnectTimeout=${connectTimeoutSeconds}`,
      "-o",
      "LogLevel=ERROR",
      ...extra,
    );
    return options;
  }

  private quoteShellWord(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
