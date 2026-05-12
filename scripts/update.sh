#!/usr/bin/env bash
# RHODES — in-place update on a Debian/Linux NUC.
#
# Use this for routine updates AFTER scripts/install.sh has already run once.
# Idempotent: safe to re-run.
#
# Usage:
#   bash scripts/update.sh            # pull, rebuild, restart
#   bash scripts/update.sh --dry-run  # show what would happen, no changes

set -euo pipefail

INSTALL_DIR="${RHODES_INSTALL_DIR:-/opt/rhodes}"
SERVICE_NAME="rhodes"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run|--check) DRY_RUN=true ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[update]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[update]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[update]\033[0m %s\n' "$*" >&2; }

run() {
  if $DRY_RUN; then
    printf '  + %s\n' "$*"
  else
    eval "$@"
  fi
}

if [ ! -d "${INSTALL_DIR}/.git" ]; then
  err "${INSTALL_DIR} is not a git checkout. Run scripts/install.sh first."
  exit 1
fi

log "Updating RHODES at ${INSTALL_DIR}"
$DRY_RUN && warn "DRY-RUN: no changes will be made."

BEFORE_SHA="$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"

run "git -C '${INSTALL_DIR}' fetch --prune"
run "git -C '${INSTALL_DIR}' pull --ff-only"

log "Reinstalling production dependencies"
run "cd '${INSTALL_DIR}' && npm ci --omit=dev"

log "Rebuilding (TypeScript -> dist/)"
run "cd '${INSTALL_DIR}' && npm install --no-save typescript@^5.7.0"
run "cd '${INSTALL_DIR}' && npx tsc"
run "cd '${INSTALL_DIR}' && npm prune --omit=dev"

# If rhodes.service in the repo changed, refresh the installed unit.
if [ -f "${INSTALL_DIR}/rhodes.service" ]; then
  if ! $DRY_RUN && ! cmp -s "${INSTALL_DIR}/rhodes.service" "/etc/systemd/system/${SERVICE_NAME}.service" 2>/dev/null; then
    log "Unit file changed; updating /etc/systemd/system/${SERVICE_NAME}.service"
    run "sudo cp '${INSTALL_DIR}/rhodes.service' '/etc/systemd/system/${SERVICE_NAME}.service'"
    run "sudo systemctl daemon-reload"
  fi
fi

log "Restarting ${SERVICE_NAME}"
run "sudo systemctl restart ${SERVICE_NAME}"

if ! $DRY_RUN; then
  sleep 1
  sudo systemctl status "${SERVICE_NAME}" --no-pager | head -10 || true
fi

AFTER_SHA="$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "Done. ${BEFORE_SHA} -> ${AFTER_SHA}"
