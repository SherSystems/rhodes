# vClaw Quickstart

This quickstart walks through:

- Proxmox setup (minimal homelab path)
- VMware vSphere setup
- Azure setup (service principal path)
- Vault configuration for credential storage
- First natural-language command
- How the 5-tier safety governance works

## 1. Prerequisites

- Node.js 22+ recommended (18+ minimum)
- Access to at least one provider:
  - Proxmox VE API token, or
  - VMware vSphere credentials, or
  - Azure service principal credentials
- AI provider key (`anthropic` or `openai`)

## 2. Install and bootstrap

```bash
git clone https://github.com/SherSystems/vclaw.git
cd vclaw
npm install
cp .env.example .env
```

## 3A. Proxmox minimal config

Edit `.env`:

```env
PROXMOX_HOST=192.168.1.100
PROXMOX_PORT=8006
PROXMOX_TOKEN_ID=root@pam!vclaw
PROXMOX_TOKEN_SECRET=your-token-secret
PROXMOX_ALLOW_SELF_SIGNED=true
```

`src/index.ts` auto-registers the Proxmox adapter when `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET` are present.

## 3B. VMware vSphere config

Edit `.env`:

```env
VMWARE_HOST=vcenter.lab.local
VMWARE_USER=administrator@vsphere.local
VMWARE_PASSWORD=your-password
VMWARE_INSECURE=true

# System adapter SSH policy (recommended: true)
SYSTEM_SSH_STRICT_HOST_KEY_CHECK=true
```

`src/index.ts` auto-registers VMware when `VMWARE_HOST` is set.

## 3C. Azure config (service principal)

Install Azure CLI and sign in:

```bash
az login
az account set --subscription "<subscription-id>"
```

Create a service principal with subscription scope:

```bash
az ad sp create-for-rbac \
  --name vclaw-sp \
  --role Contributor \
  --scopes /subscriptions/<subscription-id>
```

Set the returned credentials in `.env`:

```env
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<app-id>
AZURE_CLIENT_SECRET=<client-secret>
AZURE_SUBSCRIPTION_ID=<subscription-id>
AZURE_DEFAULT_LOCATION=eastus
```

`src/index.ts` auto-registers Azure when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_SUBSCRIPTION_ID` are set.

## 4. AI provider config

```env
AI_PROVIDER=anthropic
AI_API_KEY=your-ai-key
AI_MODEL=claude-haiku-4-5-20251001
```

## 5. Optional: configure the credential vault

vClaw includes a vault implementation in `src/security/vault.ts`, with helpers in `src/config.ts`.

Set a vault key:

```bash
export VCLAW_VAULT_KEY="$(openssl rand -hex 32)"
```

Migrate current `.env` secrets into `data/vault.json`:

```bash
npx tsx -e "import { getConfig, getOrCreateVault, migrateToVault } from './src/config.ts'; const cfg = getConfig(); const vault = getOrCreateVault(); if (!vault) throw new Error('VCLAW_VAULT_KEY is missing'); migrateToVault(cfg, vault); console.log('Vault migration complete: data/vault.json');"
```

Current release note: startup still reads runtime credentials from environment variables, so keep `.env` values available for execution.

## 6. Run your first command

Start CLI mode:

```bash
npm run dev:cli
```

Try a read-only command first:

```text
List all VMs across every provider
```

Then try a planning/execution request:

```text
Create a VM with 2 cores and 4GB RAM on the host with the most free memory
```

## 7. Understand 5-tier safety governance

vClaw classifies actions into five tiers:

| Tier | Meaning | Typical behavior |
| --- | --- | --- |
| `read` | Non-mutating queries | Runs automatically |
| `safe_write` | Low-risk mutations | Usually allowed without manual approval |
| `risky_write` | Higher-risk mutations | Subject to approval mode/policy |
| `destructive` | Potentially irreversible operations | Requires strict approval controls |
| `never` | Forbidden operations | Blocked by policy |

Policy defaults live in `policies/default.yaml` (approval modes, boundaries, and guardrails).

## 8. Validate your setup

```bash
npm test -- --run
npm run build
```

If both pass and CLI commands return provider data, your quickstart is complete.
