# RHODES Slack Shim

Tiny public-facing edge service. Receives Slack callbacks, verifies
signatures, and relays the request into the RHODES tailnet. RHODES
itself never gets a public listener — this shim is the only thing on
the open internet.

```
Slack ──HTTPS──▶ sher-rhodes-slack.fly.dev  ──tailnet──▶ homelab.tailc0269a.ts.net:7412/api/integrations/slack/*
                  (this service)                          (RHODES dashboard, private)
```

## What it does

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/slack/command` | Slash commands (`/rhodes …`) — verify, relay, return RHODES response. |
| `POST` | `/slack/interact` | Block Kit button clicks (`rhodes_approve`, `rhodes_reject`) — verify, relay, return RHODES response. |
| `POST` | `/slack/events` | Events API. Handles `url_verification` synchronously; otherwise ACKs within 3s and relays the event async. |
| `GET` | `/healthz` | Liveness probe for Fly health checks. |

Everything else returns 404. Anything missing config returns 503 —
the shim fails closed.

## Architecture decisions worth re-reading before touching this

- **No state.** Pure verify-and-relay. If you find yourself adding a
  database, a cache, or business logic, you're in the wrong layer.
  Push it into RHODES.
- **No new npm deps.** Runtime is pure Node 22 builtins (`node:http`,
  `node:crypto`, the global `fetch`). Dev deps are TypeScript + tsx
  + `@types/node`. Keeping the deps surface at zero keeps the
  attack surface at zero.
- **Signature verification is the only security boundary.** See
  `src/verify.ts` and `test/verify.test.ts`. Verify rejects on
  mismatch, stale timestamp, missing headers, or non-numeric
  timestamp.
- **Tailscale, not Funnel.** RHODES stays tailnet-only. The shim
  joins the tailnet using a reusable ephemeral auth key. See below.

## Deployment runbook

### One-time setup

1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Authenticate: `fly auth login`
3. From `shim/`, create the app without deploying:

   ```bash
   fly launch --no-deploy --copy-config --name sher-rhodes-slack --region ord
   ```

   If Fly asks about Postgres/Redis/Tigris/sentry, decline all — this
   service has no state.

### Generate a Tailscale auth key

The shim joins the SherSystems tailnet on every cold start using a
reusable ephemeral auth key. **Reusable** because Fly machines may
restart; **ephemeral** so the device disappears from the tailnet
admin panel when the container stops.

1. Open <https://login.tailscale.com/admin/settings/keys>.
2. Click **Generate auth key**.
3. Set:
   - Description: `rhodes-slack-shim (Fly.io)`
   - Reusable: **enabled**
   - Ephemeral: **enabled**
   - Pre-approved: enabled (skip the admin-approval step on join)
   - Tags: `tag:slack-shim` (add this tag to the ACL if it doesn't
     exist — see ACL note below)
   - Expiration: 90 days (rotate per calendar reminder)
4. Copy the `tskey-auth-…` value — **you will not see it again**.

ACL note: the `tag:slack-shim` tag must be declared in the Tailscale
ACL with at least permission to reach the RHODES dashboard. Minimal
stanza in `acls/tailscale-policy.hujson`:

```hujson
"tagOwners": {
  "tag:slack-shim": ["autogroup:admin"],
},
"acls": [
  // ... existing acls ...
  {
    "action": "accept",
    "src":    ["tag:slack-shim"],
    "dst":    ["homelab.tailc0269a.ts.net:7412"],
  },
],
```

### Set secrets

```bash
fly secrets set \
  SLACK_SIGNING_SECRET="<from Slack app config → Basic Information → Signing Secret>" \
  RHODES_URL="http://homelab.tailc0269a.ts.net:7412" \
  TS_AUTHKEY="tskey-auth-…the-value-you-just-copied…"
```

The `SLACK_SIGNING_SECRET` is the 32-char hex value from the Slack
app config page, NOT the bot token. The bot token lives on the
RHODES side for outbound posts and never touches this shim.

### Deploy

```bash
fly deploy
```

First deploy will build the Docker image (multi-stage, ~80MB) and
boot a single machine. After it goes live:

```bash
fly status                                    # confirm machine is healthy
curl https://sher-rhodes-slack.fly.dev/healthz
# → {"ok":true,"uptime_s":12,"rhodes_url_configured":true,"signing_secret_configured":true}
```

### Wire Slack

The shim MUST be live BEFORE you save the Slack manifest — Slack
posts a `url_verification` challenge to `/slack/events` while saving
and the manifest save will fail if the shim isn't responding.

In your Slack app config:

- **Slash commands** → `/rhodes` → `https://sher-rhodes-slack.fly.dev/slack/command`
- **Interactivity & Shortcuts** → Request URL → `https://sher-rhodes-slack.fly.dev/slack/interact`
- **Event Subscriptions** → Request URL → `https://sher-rhodes-slack.fly.dev/slack/events`
  (Slack will hit the URL with a `url_verification` body; the shim
  echoes the challenge synchronously.)

## Local development

```bash
cd shim/
npm install
npm test       # runs verify + relay tests against node:test
npm run typecheck
npm run dev    # tsx watch — listens on $PORT or 8080
```

For a smoke test without joining the tailnet:

```bash
SLACK_SIGNING_SECRET="local_dev_secret" \
RHODES_URL="http://localhost:7412" \
npm run dev
```

In a second terminal, sign and POST a fake command:

```bash
TS=$(date +%s)
BODY="token=test&command=/rhodes&text=hello"
SIG="v0=$(printf "v0:${TS}:${BODY}" | openssl dgst -sha256 -hmac local_dev_secret | awk '{print $2}')"
curl -i -X POST http://localhost:8080/slack/command \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: ${TS}" \
  -H "X-Slack-Signature: ${SIG}" \
  --data "${BODY}"
```

Without a RHODES dashboard listening on `:7412`, you'll see a 200
with the friendly "RHODES is unreachable" ephemeral message — that's
the expected fallback.

## Troubleshooting

- **`signature_invalid` on every request:** confirm
  `SLACK_SIGNING_SECRET` matches the value in Slack app config →
  Basic Information → Signing Secret (regenerate if rotated).
- **`upstream_unreachable` in shim logs:** the Tailscale daemon
  didn't join, or the ACL doesn't permit `tag:slack-shim` →
  `homelab.tailc0269a.ts.net:7412`. Check `fly logs` for
  `[entrypoint] tailscale up` lines.
- **Slack manifest save fails:** the shim returned non-2xx to
  `url_verification`. Run `curl https://sher-rhodes-slack.fly.dev/healthz`
  to confirm the shim is reachable, then check `fly logs` for the
  exact verification error.
- **Cold-start latency >3s:** Tailscale auth-key validation can be
  slow on the very first machine boot. Set
  `min_machines_running = 1` in `fly.toml` to keep one warm if it
  bites in practice (costs ~$2/mo on shared-cpu-1x).
