import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CredentialVault } from "./security/vault.js";
import {
  serviceHealthConfigSchema,
  DEFAULT_PROBES,
} from "./autopilot/probes/schema.js";

dotenv.config();

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
  s3MigrationPrefix: z.string().default("vclaw-migration/"),
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
  });

  return _config;
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

// ── Vault Integration (opt-in via VCLAW_VAULT_KEY) ──────────

let _vault: CredentialVault | null = null;

/**
 * Get or create the credential vault. Returns null if VCLAW_VAULT_KEY is not set.
 * The vault is stored at <dataDir>/vault.json.
 */
export function getOrCreateVault(): CredentialVault | null {
  const vaultKey = process.env.VCLAW_VAULT_KEY;
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
