#!/usr/bin/env node

// ============================================================
// RHODES — Reasoning, Hybrid Orchestration, Deployment & Execution System
// Infrastructure, executed.
// ============================================================

// Silence Node deprecation warnings (e.g. DEP0040 punycode from transitive
// deps) so they don't interleave with the interactive readline prompt and
// corrupt user input. Real errors still propagate normally.
(process as unknown as { noDeprecation: boolean }).noDeprecation = true;
process.removeAllListeners("warning");
process.on("warning", (warning: Error & { code?: string }) => {
  if (warning.name === "DeprecationWarning") return;
  console.warn(warning.stack || warning.message);
});

// Deprecation notice when invoked under the legacy `vclaw` binary alias.
// argv[1] is the path to the launcher; check its basename.
{
  const launcher = (process.argv[1] || "").split("/").pop() ?? "";
  if (launcher === "vclaw") {
    console.warn(
      "[deprecation] The `vclaw` command is a temporary alias for `rhodes`. Update scripts to use `rhodes` (or `rho`).",
    );
  }
}

import { getConfig, getDataDir, getPoliciesDir } from "./config.js";
import { loadPolicy } from "./governance/policy.js";
import { GovernanceEngine } from "./governance/index.js";
import { ToolRegistry } from "./providers/registry.js";
import { ProxmoxAdapter } from "./providers/proxmox/adapter.js";
import { VMwareAdapter } from "./providers/vmware/adapter.js";
import { SystemAdapter } from "./providers/system/adapter.js";
import { CostAdapter } from "./providers/cost/adapter.js";
import { SshAdapter } from "./providers/ssh/adapter.js";
import { TopologyStore } from "./topology/store.js";
import { TopologyAdapter } from "./topology/adapter.js";
import { AgentCore } from "./agent/core.js";
import { EventBus } from "./agent/events.js";
import { RhodesCLI } from "./frontends/cli.js";
import { DashboardServer } from "./frontends/dashboard/server.js";
import { RhodesMCP } from "./frontends/mcp.js";
import { AutopilotDaemon } from "./autopilot/daemon.js";
import { HealingOrchestrator } from "./healing/orchestrator.js";
import { ChaosEngine } from "./chaos/engine.js";
import { RunTelemetryCollector } from "./monitoring/run-telemetry.js";
import { MigrationAdapter } from "./migration/adapter.js";
import { ProvisioningAdapter } from "./provisioning/adapter.js";
import { AWSAdapter } from "./providers/aws/adapter.js";
import { AzureAdapter } from "./providers/azure/adapter.js";
import { createMigrationAdapter } from "./bootstrap/migration.js";
import { spawn } from "node:child_process";
import type { SSHExecResult } from "./migration/types.js";
import { join } from "path";
import { mkdirSync, readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { Notifier, attachAlertBridge, HealthzServer } from "./notifications/index.js";

// Version is sourced from package.json so we keep a single source of truth.
const RHODES_VERSION: string = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = join(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "cli";

  // Ensure data directory exists
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });

  // Load config and policy
  const config = getConfig();
  const policyPath = join(getPoliciesDir(), "default.yaml");
  const policy = loadPolicy(policyPath);

  // Initialize event bus
  const eventBus = new EventBus();
  const runTelemetry = new RunTelemetryCollector(eventBus);

  // Initialize governance
  const governance = new GovernanceEngine(policy);

  // Initialize tool registry
  const registry = new ToolRegistry();

  // Register Proxmox adapter
  if (config.proxmox.tokenId && config.proxmox.tokenSecret) {
    const proxmox = new ProxmoxAdapter({
      host: config.proxmox.host,
      port: config.proxmox.port,
      tokenId: config.proxmox.tokenId,
      tokenSecret: config.proxmox.tokenSecret,
      allowSelfSignedCerts: config.proxmox.allowSelfSignedCerts,
    });
    registry.registerAdapter(proxmox);
  }

  // Register VMware adapter
  if (config.vmware.host) {
    const vmware = new VMwareAdapter({
      host: config.vmware.host,
      user: config.vmware.user,
      password: config.vmware.password,
      insecure: config.vmware.insecure,
    });
    registry.registerAdapter(vmware);
  }

  // Register AWS adapter
  if (config.aws.accessKeyId && config.aws.secretAccessKey) {
    const aws = new AWSAdapter({
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
      region: config.aws.region,
      sessionToken: config.aws.sessionToken || undefined,
    });
    registry.registerAdapter(aws);
  }

  // Register Azure adapter
  if (
    config.azure.tenantId &&
    config.azure.clientId &&
    config.azure.clientSecret &&
    config.azure.subscriptionId
  ) {
    const azure = new AzureAdapter({
      tenantId: config.azure.tenantId,
      clientId: config.azure.clientId,
      clientSecret: config.azure.clientSecret,
      subscriptionId: config.azure.subscriptionId,
      defaultLocation: config.azure.defaultLocation,
    });
    registry.registerAdapter(azure);
  }

  // Register system adapter
  const system = new SystemAdapter({
    sshStrictHostKeyCheck: config.system.sshStrictHostKeyCheck,
  });
  registry.registerAdapter(system);

  // Register cost adapter — pure pricing service, no infra ownership.
  // Always on; pricing tables are static.
  const cost = new CostAdapter();
  registry.registerAdapter(cost);

  // Register SSH adapter — only if any targets are configured.
  // Adapter has kind="service" so it doesn't pollute the dashboard
  // provider list. Targets come from RHODES_SSH_TARGETS_FILE (a JSON
  // file) or RHODES_SSH_TARGETS (inline JSON) — see src/config.ts.
  if (config.ssh.targets.length > 0) {
    const sshAdapter = new SshAdapter(
      {
        targets: config.ssh.targets,
        max_output_bytes: config.ssh.max_output_bytes,
        default_timeout_s: config.ssh.default_timeout_s,
        allow_destructive: config.ssh.allow_destructive,
        strict_host_key_checking: config.ssh.strict_host_key_checking,
      },
      { eventBus },
    );
    await sshAdapter.connect();
    registry.registerAdapter(sshAdapter);
  }

  // Create migration adapter if both providers are configured
  // SSH exec function — used by migration and topology adapters
  const sshExec = (host: string, user: string, command: string, timeoutMs = 30_000): Promise<SSHExecResult> => {
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
      proc.on("close", (code) => { resolve({ stdout, stderr, exitCode: code ?? 1 }); });
      proc.on("error", (err) => { resolve({ stdout, stderr: err.message, exitCode: 1 }); });
    });
  };

  const migrationAdapter = await createMigrationAdapter(config, sshExec);

  // Register provisioning adapter (always — pure planning, no upstream creds needed)
  const provisioningAdapter = new ProvisioningAdapter({
    llmConfig: {
      provider: config.ai.provider,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
    },
  });
  registry.registerAdapter(provisioningAdapter);

  // Register topology adapter (always — uses SQLite for persistence)
  const topologyStore = new TopologyStore();
  const topologyAdapter = new TopologyAdapter({
    store: topologyStore,
    sshExec,
    registry,
  });
  registry.registerAdapter(topologyAdapter);

  // Connect all adapters
  await registry.connectAll();

  // Initialize agent core
  const agentCore = new AgentCore({
    toolRegistry: registry,
    governance,
    eventBus,
    config: {
      provider: config.ai.provider,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
    },
    executorOptions: {
      reliability: {
        retry: {
          maxRetries: config.executor.maxRetries,
          baseBackoffMs: config.executor.retryBaseBackoffMs,
          maxBackoffMs: config.executor.retryMaxBackoffMs,
          jitterRatio: config.executor.retryJitterRatio,
          retryOnTimeout: config.executor.retryOnTimeout,
        },
        limits: {
          maxToolCallsPerRun: config.executor.maxToolCallsPerRun,
          maxToolCallsPerPlan: config.executor.maxToolCallsPerPlan,
        },
      },
      dryRun: config.dryRun,
    },
  });

  if (config.dryRun) {
    console.log(
      "[rhodes] SHADOW MODE — RHODES_DRY_RUN=true. Tier-1 reads execute; tier-2+ writes are planned/logged but NOT executed.",
    );
  }

  // ── Notifications: build the alert provider once and bridge it
  // to the EventBus so autopilot/incident/health hooks just emit
  // events and the bridge takes care of delivery. The notifier is
  // safe to construct even when provider === "none".
  const notifier = new Notifier({
    provider: config.notifications.provider,
    supra: {
      url: config.notifications.supraUrl,
      userId: config.notifications.supraUserId,
    },
    telegram: {
      botToken: config.notifications.telegramBotToken,
      chatId: config.notifications.telegramChatId,
    },
  });
  attachAlertBridge(eventBus, {
    notifier,
    dashboardUrl: config.notifications.dashboardUrl || undefined,
  });
  console.log(`[rhodes] Alert provider: ${notifier.provider.id}`);

  // ── /healthz endpoint: always on, even in cli mode. Useful for
  // systemd ExecStartPost smoke tests and external uptime probes.
  const healthz = new HealthzServer({
    port: config.health.port,
    version: RHODES_VERSION,
    dryRun: config.dryRun,
    providersConnected: () =>
      registry.getHypervisorAdapters().map((a) => a.name),
    activePlans: () => {
      // We don't track active plans centrally yet; surface 0 as a
      // safe default. Downstream we'll plumb in a real counter from
      // the orchestrator without changing the wire format.
      return 0;
    },
    notifier,
  });
  await healthz.start().catch((err) => {
    console.warn(`[healthz] Failed to bind :${config.health.port} — ${err instanceof Error ? err.message : String(err)}`);
  });

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down RHODES...");
    runTelemetry.close();
    await healthz.stop().catch(() => undefined);
    await registry.disconnectAll();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  switch (mode) {
    case "cli": {
      const cli = new RhodesCLI(agentCore, registry, eventBus, governance);

      // If there's additional text after "cli", treat as one-shot
      const input = args.slice(1).join(" ");
      if (input) {
        await cli.runOnce(input);
      } else {
        await cli.start();
      }
      break;
    }

    case "dashboard": {
      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit,
        runTelemetry,
        config.dashboard.host,
      );
      await dashboard.start();
      dashboard.attachApprovalGate(governance.approvalGate);

      // Self-healing orchestrator — needed for /api/healing/* routes and as a
      // dependency of the chaos engine. Use a tighter poll than autopilot's
      // default so detection lag stays under the chaos scenarios' recovery
      // budgets (e.g. vm_kill: 120s).
      const healer = new HealingOrchestrator({
        agentCore,
        toolRegistry: registry,
        eventBus,
        governance,
        dataDir: join(dataDir, "healing"),
        config: {
          pollIntervalMs: Number(process.env.HEALING_POLL_INTERVAL_MS) || 10000,
          healingEnabled: true,
          maxConcurrentHeals: 2,
          fastPathEnabled: true,
        },
      });
      healer.start();
      (dashboard as unknown as { healer: HealingOrchestrator }).healer = healer;

      // Chaos engineering engine — required for /api/chaos/* routes.
      const chaosEngine = new ChaosEngine({
        agentCore,
        toolRegistry: registry,
        eventBus,
        healingOrchestrator: healer,
        approvalGate: governance.approvalGate,
      });
      (dashboard as unknown as { chaosEngine: ChaosEngine }).chaosEngine = chaosEngine;

      // Migration adapter
      if (migrationAdapter) {
        (dashboard as unknown as { migrationAdapter: MigrationAdapter }).migrationAdapter = migrationAdapter;
      }

      // Topology store
      (dashboard as unknown as { topologyStore: TopologyStore }).topologyStore = topologyStore;

      // If autopilot is enabled, start it alongside dashboard
      if (config.autopilot.enabled) {
        const autopilot = new AutopilotDaemon(
          registry,
          governance,
          eventBus,
          {
            pollIntervalMs: config.autopilot.pollIntervalMs,
            enabled: true,
            probesEnabled: config.service_health.enabled,
            probes: config.service_health.probes,
          }
        );
        autopilot.start();
      }
      break;
    }

    case "mcp": {
      const mcp = new RhodesMCP(agentCore, registry, eventBus, governance);
      await mcp.start();
      break;
    }

    case "autopilot": {
      const autopilot = new AutopilotDaemon(
        registry,
        governance,
        eventBus,
        {
          pollIntervalMs: config.autopilot.pollIntervalMs,
          enabled: true,
          probesEnabled: config.service_health.enabled,
          probes: config.service_health.probes,
        }
      );
      autopilot.start();
      console.log(`Autopilot daemon started (polling every ${config.autopilot.pollIntervalMs}ms)`);

      // Also start dashboard for monitoring
      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit,
        runTelemetry,
        config.dashboard.host,
      );
      await dashboard.start();
      dashboard.attachApprovalGate(governance.approvalGate);
      break;
    }

    case "full": {
      // Start everything
      console.log("Starting RHODES in full mode...\n");

      // Dashboard
      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit,
        runTelemetry,
        config.dashboard.host,
      );
      await dashboard.start();
      dashboard.attachApprovalGate(governance.approvalGate);

      // Autopilot (if enabled)
      if (config.autopilot.enabled) {
        const autopilot = new AutopilotDaemon(
          registry,
          governance,
          eventBus,
          {
            pollIntervalMs: config.autopilot.pollIntervalMs,
            enabled: true,
            probesEnabled: config.service_health.enabled,
            probes: config.service_health.probes,
          }
        );
        autopilot.start();
      }

      // Self-healing orchestrator
      const healer = new HealingOrchestrator({
        agentCore,
        toolRegistry: registry,
        eventBus,
        governance,
        dataDir: join(dataDir, "healing"),
        config: {
          pollIntervalMs: config.autopilot.pollIntervalMs || 60000,
          healingEnabled: true,
          maxConcurrentHeals: 2,
        },
      });
      healer.start();
      console.log("  Self-healing orchestrator started");

      // Expose orchestrator on dashboard for API routes
      (dashboard as unknown as { healer: HealingOrchestrator }).healer = healer;

      // Chaos engineering engine
      const chaosEngine = new ChaosEngine({
        agentCore,
        toolRegistry: registry,
        eventBus,
        healingOrchestrator: healer,
        approvalGate: governance.approvalGate,
      });

      // Expose on dashboard for API routes
      (dashboard as unknown as { chaosEngine: ChaosEngine }).chaosEngine = chaosEngine;

      // Migration adapter
      if (migrationAdapter) {
        (dashboard as unknown as { migrationAdapter: MigrationAdapter }).migrationAdapter = migrationAdapter;
        console.log("  Migration adapter ready");
      }

      // Topology store
      (dashboard as unknown as { topologyStore: TopologyStore }).topologyStore = topologyStore;

      console.log("  Chaos engineering engine ready");

      console.log("\nAll services running. Press Ctrl+C to stop.\n");
      break;
    }

    case "dev": {
      // Dashboard + CLI — all sharing the same event bus
      // Type goals in the CLI and watch them stream live on the dashboard
      console.log("Starting RHODES in dev mode (Dashboard + CLI)...\n");

      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit,
        runTelemetry,
        config.dashboard.host,
      );
      await dashboard.start();
      dashboard.attachApprovalGate(governance.approvalGate);

      // Self-healing orchestrator
      const devHealer = new HealingOrchestrator({
        agentCore,
        toolRegistry: registry,
        eventBus,
        governance,
        dataDir: join(dataDir, "healing"),
        config: {
          pollIntervalMs: 60000,
          healingEnabled: true,
          maxConcurrentHeals: 2,
        },
      });
      devHealer.start();
      (dashboard as unknown as { healer: HealingOrchestrator }).healer = devHealer;

      // Chaos engineering engine
      const devChaosEngine = new ChaosEngine({
        agentCore,
        toolRegistry: registry,
        eventBus,
        healingOrchestrator: devHealer,
        approvalGate: governance.approvalGate,
      });

      // Expose on dashboard for API routes
      (dashboard as unknown as { chaosEngine: ChaosEngine }).chaosEngine = devChaosEngine;

      // Migration adapter
      if (migrationAdapter) {
        (dashboard as unknown as { migrationAdapter: MigrationAdapter }).migrationAdapter = migrationAdapter;
      }

      // Topology store
      (dashboard as unknown as { topologyStore: TopologyStore }).topologyStore = topologyStore;

      const cli = new RhodesCLI(agentCore, registry, eventBus, governance);
      await cli.start();
      break;
    }

    default: {
      // Treat as one-shot command
      const cli = new RhodesCLI(agentCore, registry, eventBus, governance);
      const oneShot = args.join(" ");
      if (oneShot) {
        await cli.runOnce(oneShot);
      } else {
        console.log(`
RHODES — Reasoning, Hybrid Orchestration, Deployment & Execution System
Infrastructure, executed.

OPERATIONS
  rhodes                         Interactive CLI (REPL)
  rhodes cli                     Interactive CLI (REPL)
  rhodes cli "goal"              One-shot: build and execute a plan
  rhodes "goal"                  One-shot: build and execute a plan

PROVIDERS
  rhodes dashboard               Start web dashboard
  rhodes mcp                     Start MCP server (for Claude Code)
  rhodes autopilot               Start autopilot daemon + dashboard

WORKSPACES
  rhodes dev                     CLI + Dashboard (best for testing)
  rhodes full                    Start all services (no CLI)

Environment (Proxmox):
  PROXMOX_HOST                  Proxmox VE host (default: localhost)
  PROXMOX_PORT                  Proxmox VE port (default: 8006)
  PROXMOX_TOKEN_ID              API token ID (user@realm!token)
  PROXMOX_TOKEN_SECRET          API token secret

Environment (VMware):
  VMWARE_HOST                   vCenter host
  VMWARE_USER                   vCenter username
  VMWARE_PASSWORD               vCenter password
  VMWARE_INSECURE               Skip TLS verification (default: true)

Environment (General):
  AI_PROVIDER                   LLM provider: anthropic | openai
  AI_API_KEY                    LLM API key
  AI_MODEL                      LLM model name
  DASHBOARD_PORT                Dashboard port (default: 3000)
  AUTOPILOT_ENABLED             Enable autopilot (default: false)
  AUTOPILOT_POLL_INTERVAL_MS    Poll interval in ms (default: 30000)
  EXECUTOR_MAX_RETRIES          Tool retry count (default: 2)
  EXECUTOR_RETRY_BASE_BACKOFF_MS  Retry base delay ms (default: 250)
  EXECUTOR_RETRY_MAX_BACKOFF_MS   Retry max delay ms (default: 4000)
  EXECUTOR_RETRY_JITTER_RATIO     Retry jitter ratio 0..1 (default: 0.2)
  EXECUTOR_RETRY_ON_TIMEOUT       Retry timed-out tool calls (default: true)
  EXECUTOR_MAX_TOOL_CALLS_PER_RUN   Max tool calls per run (default: 200)
  EXECUTOR_MAX_TOOL_CALLS_PER_PLAN  Max tool calls per plan/thread (default: 100)
`);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
