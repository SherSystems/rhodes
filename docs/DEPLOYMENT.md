# RHODES — Deployment Runbook

This runbook covers deploying RHODES to a long-lived Linux host
managed by `systemd`. The reference target is a 16 GB Intel NUC
running Debian 12 in a homelab, but anything Debian/Ubuntu/Fedora
with `systemd` will work.

> Tagline: *Infrastructure, executed.*

---

## 1. Prerequisites

On the target host:

- **Node.js 20+** (`node -v`)
- **git** (`git --version`)
- **systemd** (default on Debian/Ubuntu/Fedora)
- A user account that owns `/opt/rhodes` (the install scripts
  assume `pranav`; override with `RHODES_SERVICE_USER`)
- Optional: **Tailscale**, if you want to reach the RHODES
  dashboard from outside the LAN.

Outbound network access is required for:

- The Anthropic / OpenAI API (LLM backend)
- Your hypervisors and cloud providers (vCenter, Proxmox, AWS,
  Azure as configured)
- Supra / Telegram (if alerts are enabled)

---

## 2. First-time install

```bash
# 1. Clone & run the installer (it will re-clone into /opt/rhodes)
git clone https://github.com/SherSystems/rhodes.git ~/rhodes-src
cd ~/rhodes-src
bash scripts/install.sh
```

The installer:

1. Clones the repo into `/opt/rhodes` (or `git pull` if it
   already exists).
2. Runs `npm ci --omit=dev` to install runtime deps.
3. Compiles TypeScript to `dist/`.
4. Copies `rhodes.service` to `/etc/systemd/system/`.
5. `systemctl daemon-reload && systemctl enable rhodes`.
6. **Does not** start the service — you must create `.env` first.

### Configure `.env`

```bash
sudo -u pranav cp /opt/rhodes/.env.example /opt/rhodes/.env
sudo -u pranav $EDITOR /opt/rhodes/.env
```

Fill in at least:

- `AI_API_KEY`
- `PROXMOX_*` and/or `VMWARE_*` and/or `AWS_*` / `AZURE_*`
- `RHODES_DEPLOYMENT_NAME` (free-form label, e.g. `homelab`)
- `RHODES_ALERT_PROVIDER` and the matching credentials

### Start the service

```bash
sudo systemctl start rhodes
sudo systemctl status rhodes
```

### Dry-run mode

To preview the install without touching anything:

```bash
bash scripts/install.sh --dry-run
```

Every command that would mutate the host is printed with a `+`
prefix; nothing is executed.

---

## 3. Updates

After the first install, use `scripts/update.sh` for routine
updates:

```bash
sudo bash /opt/rhodes/scripts/update.sh
```

The update script:

1. `git fetch && git pull --ff-only`
2. `npm ci --omit=dev`
3. Rebuilds TypeScript.
4. Refreshes `/etc/systemd/system/rhodes.service` only if the
   in-repo unit file changed.
5. `systemctl restart rhodes`
6. Prints the first 10 lines of `systemctl status`.

Dry-run is supported here too: `bash scripts/update.sh --dry-run`.

---

## 4. Operating

### Tail logs

```bash
journalctl -u rhodes -f
```

### One-shot status

```bash
systemctl status rhodes
```

### Health probe

```bash
curl -fsS http://localhost:${RHODES_HEALTH_PORT:-7411}/healthz
```

### Stop / start / restart

```bash
sudo systemctl stop    rhodes
sudo systemctl start   rhodes
sudo systemctl restart rhodes
```

---

## 5. Rollback

RHODES ships as a git checkout, so rollback is a checkout +
rebuild:

```bash
cd /opt/rhodes
git log --oneline -n 10            # pick a known-good SHA
git checkout <previous-sha>
bash scripts/update.sh             # rebuilds & restarts
```

To return to `main`:

```bash
cd /opt/rhodes
git checkout main
bash scripts/update.sh
```

If the unit file itself broke something, you can roll back the
unit with the same flow — `update.sh` will detect the change and
copy the older unit back into `/etc/systemd/system/`.

---

## 6. Uninstall

```bash
sudo systemctl disable --now rhodes
sudo rm /etc/systemd/system/rhodes.service
sudo systemctl daemon-reload
sudo rm -rf /opt/rhodes
```

---

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| Unit fails to start | `journalctl -u rhodes -n 200` — usually missing env vars or bad `AI_API_KEY` |
| `node: command not found` in journal | Node not on PATH for the service user; adjust `Environment=PATH=` in `rhodes.service` |
| `EADDRINUSE` on health port | Another process is bound to `RHODES_HEALTH_PORT`; change it in `.env` and restart |
| `permission denied` writing to `/opt/rhodes/data` | Ensure `User=` in the unit matches the owner of `/opt/rhodes` |
