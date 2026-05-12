import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CredentialVault } from "./security/vault.js";
import {
  serviceHealthConfigSchema,
  DEFAULT_PROBES,
} from "./autopilot/probes/schema.js";

// ── .env Discovery ──────────────────────────────────────────
// Look for .env in this order so `rhodes` works no matter where you run it:
//   1. $RHODES_ENV_FILE                        (explicit override)
//   2. ./.env                                  (current working dir)
//   3. ~/.rhodes/.env                          (per-user config)
//   4. <install dir>/.env                      (project root, where this file lives)
//
// First file wins. dotenv won't override variables already set in the real
// environment, so an explicit shell export still beats the file.
function loadEnvFromCandidates(): string | null {
  const __filename = fileURLToPath(import.meta.url);
  // src/config.ts at runtime is dist/config.js — go up one level to the
  // package root in either case.
  const installDir = dirname(dirname(__filename));

  const candidates: string[] = [];
  const envFile = process.env.RHODES_ENV_FILE ?? process.env.VCLAW_ENV_FILE;
  if (envFile) candidates.push(envFile);
  candidates.push(join(process.cwd(), ".env"));
  candidates.push(join(homedir(), ".rhodes", ".env"));
  // Backwards-compat: legacy ~/.vclaw/.env still works.
  candidates.push(join(homedir(), ".vclaw", ".env"));
  candidates.push(join(installDir, ".env"));

  for (const path of candidates) {
    if (existsSync(path)) {
      dotenv.config({ path });
      return path;
    }
  }
  // No file found — still call dotenv.config() in case dotenv has its own
  // search behaviour we want to preserve (it's a no-op if cwd has no .env).
  dotenv.config();
  return null;
}

loadEnvFromCandidates();

// ── .rhodes.yaml Discovery ──────────────────────────────────
// Looks for an optional YAML workspace config file:
//   1. ./.rhodes.yaml                          (current working dir, preferred)
//   2. ./.vclaw.yaml                           (legacy — emits deprecation warning)
//
// The presence of the file is currently informational — env vars remain the
// authoritative config surface. This loader exists so future workspace-level
// settings have a stable name, and so legacy `.vclaw.yaml` users get a clean
// rename signal instead of a silent break.
function discoverWorkspaceConfigPath(): string | null {
  const cwd = process.cwd();
  const rhodesPath = join(cwd, ".rhodes.yaml");
  if (existsSync(rhodesPath)) return rhodesPath;
  const legacyPath = join(cwd, ".vclaw.yaml");
  if (existsSync(legacyPath)) {
    console.warn(
      "[config] Found legacy .vclaw.yaml — rename it to .rhodes.yaml. The old name will stop working in a future release.",
    );
    return legacyPath;
  }
  return null;
}

// Run discovery at import time so warnings surface during startup.
discoverWorkspaceConfigPath();

const ProxmoxConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.coerce.number().default(8006),
  tokenId: z.string().default(""),
  tokenSecret: z.string().default(""),
  allowSelfSignedCerts: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const VMwareConfigSchema = z.object({
  host: z.string().default(""),
  user: z.string().default(""),
  password: z.string().default(""),
  insecure: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const SystemConfigSchema = z.object({
  sshStrictHostKeyCheck: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const AIConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  apiKey: z.string().default(""),
  model: z.string().default("claude-sonnet-4-20250514"),
});

const DashboardConfigSchema = z.object({
  port: z.coerce.number().default(3000),
});

const MigrationConfigSchema = z.object({
  esxiHost: z.string().default(""),
  esxiUser: z.string().default("root"),
  proxmoxHost: z.string().default(""),
  proxmoxUser: z.string().default("root"),
  proxmoxNode: z.string().default(""),
  proxmoxStorage: z.string().default("local-lvm"),
});

const AWSConfigSchema = z.object({
  accessKeyId: z.string().default(""),
  secretAccessKey: z.string().default(""),
  region: z.string().default("us-east-1"),
  sessionToken: z.string().default(""),
  s3MigrationBucket: z.string().default(""),
  s3MigrationPrefix: z.string().default("rhodes-migration/"),
  vmImportRoleArn: z.string().default(""),
});

const AzureConfigSchema = z.object({
  tenantId: z.string().default(""),
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  subscriptionId: z.string().default(""),
  defaultLocation: z.string().default("eastus"),
});

const KubernetesConfigSchema = z.object({
  kubeconfigPath: z.string().default(""),
  context: z.string().default(""),
  namespace: z.string().default("default"),
  insecureSkipTlsVerify: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const AutopilotConfigSchema = z.object({
  pollIntervalMs: z.coerce.number().default(30000),
  enabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const NotificationsConfigSchema = z.object({
  provider: z.enum(["none", "supra", "telegram_direct"]).default("none"),
  supraUrl: z.string().default("http://localhost:3100"),
  supraUserId: z.string().default("rhodes-bot"),
  telegramBotToken: z.string().default(""),
  telegramChatId: z.string().default(""),
  dashboardUrl: z.string().default(""),
});

const HealthConfigSchema = z.object({
  port: z.coerce.number().default(7411),
});

const SshTargetSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  port: z.coerce.number().int().positive().optional(),
  user: z.string().min(1),
  identity_file: z.string().optional(),
  jump_host: z.string().optional(),
  description: z.string().optional(),
});

const SshConfigSchema = z.object({
  targets: z.array(SshTargetSchema).default([]),
  max_output_bytes: z.coerce.number().int().positive().default(65536),
  default_timeout_s: z.coerce.number().int().positive().default(30),
  allow_destructive: z.boolean().default(false),
  strict_host_key_checking: z.boolean().default(true),
});

const ExecutorConfigSchema = z.object({
  maxRetries: z.coerce.number().int().nonnegative().default(2),
  retryBaseBackoffMs: z.coerce.number().int().nonnegative().default(250),
  retryMaxBackoffMs: z.coerce.number().int().nonnegative().default(4000),
  retryJitterRatio: z.coerce.number().min(0).max(1).default(0.2),
  retryOnTimeout: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  maxToolCallsPerRun: z.coerce.number().int().positive().default(200),
  maxToolCallsPerPlan: z.coerce.number().int().positive().default(100),
});

export const ConfigSchema = z.object({
  proxmox: ProxmoxConfigSchema,
  vmware: VMwareConfigSchema,
  system: SystemConfigSchema.default({ sshStrictHostKeyCheck: "true" }),
  ai: AIConfigSchema,
  aws: AWSConfigSchema.default({}),
  azure: AzureConfigSchema.default({}),
  kubernetes: KubernetesConfigSchema.default({}),
  dashboard: DashboardConfigSchema,
  migration: MigrationConfigSchema.default({}),
  autopilot: AutopilotConfigSchema,
  executor: ExecutorConfigSchema.default({}),
  service_health: serviceHealthConfigSchema.default({
    enabled: true,
    probes: DEFAULT_PROBES,
  }),
  ssh: SshConfigSchema.default({
    targets: [],
    max_output_bytes: 65536,
    default_timeout_s: 30,
    allow_destructive: false,
    strict_host_key_checking: true,
  }),
  /**
   * Shadow / dry-run mode. When true, Tier-1 (read) actions still execute,
   * but Tier-2+ (safe_write, risky_write, destructive) actions are PLANNED
   * and LOGGED but NEVER executed. The autopilot still polls, classifies
   * events, builds plans, and alerts — it just doesn't mutate anything.
   *
   * Set with `RHODES_DRY_RUN=true` for the initial production posture.
   */
  dryRun: z.boolean().default(false),
  notifications: NotificationsConfigSchema.default({}),
  health: HealthConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  _config = ConfigSchema.parse({
    proxmox: {
      host: process.env.PROXMOX_HOST,
      port: process.env.PROXMOX_PORT,
      tokenId: process.env.PROXMOX_TOKEN_ID,
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
      allowSelfSignedCerts: process.env.PROXMOX_ALLOW_SELF_SIGNED,
    },
    vmware: {
      host: process.env.VMWARE_HOST,
      user: process.env.VMWARE_USER,
      password: process.env.VMWARE_PASSWORD,
      insecure: process.env.VMWARE_INSECURE,
    },
    system: {
      sshStrictHostKeyCheck: process.env.SYSTEM_SSH_STRICT_HOST_KEY_CHECK,
    },
    ai: {
      provider: process.env.AI_PROVIDER,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL,
    },
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      s3MigrationBucket: process.env.AWS_S3_MIGRATION_BUCKET,
      s3MigrationPrefix: process.env.AWS_S3_MIGRATION_PREFIX,
      vmImportRoleArn: process.env.AWS_VM_IMPORT_ROLE_ARN,
    },
    azure: {
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      defaultLocation: process.env.AZURE_DEFAULT_LOCATION,
    },
    kubernetes: {
      kubeconfigPath: process.env.KUBERNETES_KUBECONFIG_PATH,
      context: process.env.KUBERNETES_CONTEXT,
      namespace: process.env.KUBERNETES_NAMESPACE,
      insecureSkipTlsVerify: process.env.KUBERNETES_INSECURE_SKIP_TLS_VERIFY,
    },
    dashboard: {
      port: process.env.DASHBOARD_PORT,
    },
    migration: {
      esxiHost: process.env.MIGRATION_ESXI_HOST,
      esxiUser: process.env.MIGRATION_ESXI_USER,
      proxmoxHost: process.env.MIGRATION_PROXMOX_HOST,
      proxmoxUser: process.env.MIGRATION_PROXMOX_USER,
      proxmoxNode: process.env.MIGRATION_PROXMOX_NODE,
      proxmoxStorage: process.env.MIGRATION_PROXMOX_STORAGE,
    },
    autopilot: {
      pollIntervalMs: process.env.AUTOPILOT_POLL_INTERVAL_MS,
      enabled: process.env.AUTOPILOT_ENABLED,
    },
    executor: {
      maxRetries: process.env.EXECUTOR_MAX_RETRIES,
      retryBaseBackoffMs: process.env.EXECUTOR_RETRY_BASE_BACKOFF_MS,
      retryMaxBackoffMs: process.env.EXECUTOR_RETRY_MAX_BACKOFF_MS,
      retryJitterRatio: process.env.EXECUTOR_RETRY_JITTER_RATIO,
      retryOnTimeout: process.env.EXECUTOR_RETRY_ON_TIMEOUT,
      maxToolCallsPerRun: process.env.EXECUTOR_MAX_TOOL_CALLS_PER_RUN,
      maxToolCallsPerPlan: process.env.EXECUTOR_MAX_TOOL_CALLS_PER_PLAN,
    },
    service_health: {
      enabled: true,
      // Ship the example probes by default; both are `enabled: false`
      // so they don't auto-start without operator opt-in.
      probes: DEFAULT_PROBES,
    },
    ssh: {
      targets: loadSshTargets(),
      max_output_bytes:
        process.env.RHODES_SSH_MAX_OUTPUT_BYTES ??
        process.env.VCLAW_SSH_MAX_OUTPUT_BYTES,
      default_timeout_s:
        process.env.RHODES_SSH_DEFAULT_TIMEOUT_S ??
        process.env.VCLAW_SSH_DEFAULT_TIMEOUT_S,
      allow_destructive:
        (process.env.RHODES_SSH_ALLOW_DESTRUCTIVE ??
          process.env.VCLAW_SSH_ALLOW_DESTRUCTIVE) === "true",
      strict_host_key_checking:
        (process.env.RHODES_SSH_STRICT_HOST_KEY_CHECKING ??
          process.env.VCLAW_SSH_STRICT_HOST_KEY_CHECKING) !== "false",
    },
    dryRun: (process.env.RHODES_DRY_RUN ?? "").toLowerCase() === "true",
    notifications: {
      provider:
        (process.env.RHODES_ALERT_PROVIDER as
          | "none"
          | "supra"
          | "telegram_direct"
          | undefined) ?? undefined,
      supraUrl: process.env.SUPRA_URL,
      supraUserId: process.env.RHODES_SUPRA_USER_ID,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      dashboardUrl: process.env.DASHBOARD_URL ?? process.env.RHODES_DASHBOARD_URL,
    },
    health: {
      port: process.env.RHODES_HEALTH_PORT,
    },
  });

  return _config;
}

/**
 * Load SSH targets from a JSON file pointed at by RHODES_SSH_TARGETS_FILE
 * (legacy: VCLAW_SSH_TARGETS_FILE).
 *
 * We deliberately keep targets out of process env so:
 *  - identity_file paths aren't exposed via /proc/<pid>/environ
 *  - operators have a single stable inventory file to version-control
 *  - the same shape works for one-off scripts and the daemon
 *
 * Returns an empty array if the env var is unset, the file is missing,
 * or the file is malformed (we log a warning to stderr and fail soft so
 * rhodes still boots without SSH).
 */
function loadSshTargets(): unknown[] {
  const envInline =
    process.env.RHODES_SSH_TARGETS ?? process.env.VCLAW_SSH_TARGETS;
  if (envInline) {
    try {
      const parsed = JSON.parse(envInline);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error(
        `[config] RHODES_SSH_TARGETS is not valid JSON; ignoring. (${(err as Error).message})`,
      );
      return [];
    }
  }

  const file =
    process.env.RHODES_SSH_TARGETS_FILE ?? process.env.VCLAW_SSH_TARGETS_FILE;
  if (!file) return [];
  if (!existsSync(file)) {
    console.error(`[config] RHODES_SSH_TARGETS_FILE points at "${file}" but the file is missing; ignoring.`);
    return [];
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Never log the file path again here in case it lives in a secret dir.
    console.error(`[config] Failed to load SSH targets file: ${(err as Error).message}`);
    return [];
  }
}

export function getProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return dirname(dirname(__filename));
}

export function getPoliciesDir(): string {
  return join(getProjectRoot(), "policies");
}

export function getDataDir(): string {
  const dir = join(getProjectRoot(), "data");
  return dir;
}

// ── Vault Integration (opt-in via RHODES_VAULT_KEY) ─────────

let _vault: CredentialVault | null = null;

/**
 * Get or create the credential vault. Returns null if RHODES_VAULT_KEY
 * (legacy: VCLAW_VAULT_KEY) is not set. The vault is stored at <dataDir>/vault.json.
 */
export function getOrCreateVault(): CredentialVault | null {
  const vaultKey = process.env.RHODES_VAULT_KEY ?? process.env.VCLAW_VAULT_KEY;
  if (!vaultKey) return null;

  if (_vault) return _vault;

  _vault = new CredentialVault({
    path: join(getDataDir(), "vault.json"),
    masterKey: vaultKey,
  });

  return _vault;
}

/**
 * Migrate config secrets into the vault.
 * Stores Proxmox token secret, VMware password, and AI API key.
 */
export function migrateToVault(config: Config, vault: CredentialVault): void {
  vault.importFromConfig({
    "proxmox.tokenSecret": {
      value: config.proxmox.tokenSecret,
      provider: "proxmox",
      field: "tokenSecret",
    },
    "vmware.password": {
      value: config.vmware.password,
      provider: "vmware",
      field: "password",
    },
    "ai.apiKey": {
      value: config.ai.apiKey,
      provider: "ai",
      field: "apiKey",
    },
  });
}
