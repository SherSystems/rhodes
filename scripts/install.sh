#!/usr/bin/env bash
# RHODES — first-time install on a Debian/Linux NUC running systemd.
#
# Idempotent: safe to re-run; will git-pull, rebuild, and refresh the unit file.
# Usage:
#   sudo bash scripts/install.sh             # actually install
#   bash scripts/install.sh --dry-run        # show what would happen, no changes
#
# Assumes you have:
#   - Node 20+ on PATH
#   - git on PATH
#   - systemd (Debian/Ubuntu/etc.)
#   - sudo privileges (or are root) for the systemd-unit copy + daemon-reload

set -euo pipefail

# ---- Config ----------------------------------------------------------------
REPO_URL="${RHODES_REPO_URL:-https://github.com/SherSystems/rhodes.git}"
INSTALL_DIR="${RHODES_INSTALL_DIR:-/opt/rhodes}"
SERVICE_NAME="rhodes"
SERVICE_UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_USER="${RHODES_SERVICE_USER:-pranav}"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run|--check)
      DRY_RUN=true
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# ---- Helpers ---------------------------------------------------------------
log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; }

run() {
  # Echo + execute (or just echo in --dry-run mode).
  if $DRY_RUN; then
    printf '  + %s\n' "$*"
  else
    eval "$@"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    exit 1
  fi
}

# ---- Preflight -------------------------------------------------------------
log "RHODES installer — target ${INSTALL_DIR}"
$DRY_RUN && warn "DRY-RUN: no changes will be made."

require_cmd git
require_cmd node
require_cmd npm
require_cmd systemctl

NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  warn "Node ${NODE_MAJOR} detected; Node 20+ is recommended."
fi

# Source unit lives alongside the script, in the cloned repo or the cwd.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_UNIT_SRC="${SCRIPT_DIR}/../rhodes.service"

# ---- Clone or update -------------------------------------------------------
if [ -d "${INSTALL_DIR}/.git" ]; then
  log "Existing checkout at ${INSTALL_DIR}; fetching latest."
  run "git -C '${INSTALL_DIR}' fetch --prune"
  run "git -C '${INSTALL_DIR}' pull --ff-only"
else
  log "Cloning ${REPO_URL} into ${INSTALL_DIR}"
  run "sudo mkdir -p '${INSTALL_DIR}'"
  run "sudo chown ${SERVICE_USER}:${SERVICE_USER} '${INSTALL_DIR}'"
  run "git clone '${REPO_URL}' '${INSTALL_DIR}'"
fi

# After clone/pull, prefer the in-tree unit file.
if [ -f "${INSTALL_DIR}/rhodes.service" ]; then
  SERVICE_UNIT_SRC="${INSTALL_DIR}/rhodes.service"
fi

# ---- Build -----------------------------------------------------------------
log "Installing production dependencies"
run "cd '${INSTALL_DIR}' && npm ci --omit=dev"

log "Compiling TypeScript"
# tsc lives in devDependencies; install it just-in-time for the build, then prune.
run "cd '${INSTALL_DIR}' && npm install --no-save typescript@^5.7.0"
run "cd '${INSTALL_DIR}' && npx tsc"
run "cd '${INSTALL_DIR}' && npm prune --omit=dev"

# ---- systemd unit ----------------------------------------------------------
if [ ! -f "${SERVICE_UNIT_SRC}" ]; then
  err "rhodes.service not found at ${SERVICE_UNIT_SRC}"
  exit 1
fi

log "Installing systemd unit -> ${SERVICE_UNIT_DST}"
run "sudo cp '${SERVICE_UNIT_SRC}' '${SERVICE_UNIT_DST}'"
run "sudo chmod 0644 '${SERVICE_UNIT_DST}'"
run "sudo systemctl daemon-reload"
run "sudo systemctl enable ${SERVICE_NAME}"

# ---- .env reminder ---------------------------------------------------------
ENV_FILE="${INSTALL_DIR}/.env"
if [ ! -f "${ENV_FILE}" ] && ! $DRY_RUN; then
  warn ".env not found at ${ENV_FILE} — copy from .env.example and fill in secrets:"
  warn "  sudo -u ${SERVICE_USER} cp ${INSTALL_DIR}/.env.example ${ENV_FILE}"
  warn "  sudo -u ${SERVICE_USER} \$EDITOR ${ENV_FILE}"
fi

# ---- Done ------------------------------------------------------------------
cat <<EOF

------------------------------------------------------------
RHODES install complete$($DRY_RUN && echo " (dry-run; nothing changed)")

Next steps:
  1. Create / verify ${ENV_FILE} (copy from .env.example).
  2. Start the service:
        sudo systemctl start ${SERVICE_NAME}
  3. Tail logs:
        journalctl -u ${SERVICE_NAME} -f
  4. Check status:
        systemctl status ${SERVICE_NAME}
------------------------------------------------------------
EOF
