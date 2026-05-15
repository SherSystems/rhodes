#!/bin/sh
# ============================================================
# RHODES Slack Shim — container entrypoint
#
# Starts tailscaled in userspace mode so the shim can reach the
# operator's tailnet (and resolve MagicDNS), then execs the shim
# itself. If TS_AUTHKEY is not set, skip Tailscale entirely and
# run the shim alone — useful for the manual smoke-test step on
# Fly before flipping the live Slack manifest URL.
# ============================================================

set -eu

if [ -n "${TS_AUTHKEY:-}" ]; then
  echo "[entrypoint] starting tailscaled (userspace mode, socks5 disabled)"
  tailscaled \
    --tun=userspace-networking \
    --state=mem: \
    --socket=/var/run/tailscale/tailscaled.sock \
    >/var/log/tailscaled.log 2>&1 &

  # Wait for the socket to appear before calling `tailscale up`.
  i=0
  while [ ! -S /var/run/tailscale/tailscaled.sock ]; do
    i=$((i+1))
    if [ "$i" -gt 50 ]; then
      echo "[entrypoint] tailscaled never came up; tail of log:"
      tail -n 50 /var/log/tailscaled.log || true
      exit 1
    fi
    sleep 0.1
  done

  HOSTNAME_TAG="${TS_HOSTNAME:-rhodes-slack-shim}"
  echo "[entrypoint] tailscale up (hostname=${HOSTNAME_TAG})"
  tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY}" \
    --hostname="${HOSTNAME_TAG}" \
    --accept-dns=true \
    --accept-routes=false

  # Expose MagicDNS to the shim — when Tailscale runs in userspace mode
  # it doesn't rewrite /etc/resolv.conf by default. We point Node at the
  # tailscaled DNS shim via NODE_OPTIONS-compatible env (undici uses the
  # system resolver, so we patch /etc/resolv.conf instead).
  echo "nameserver 100.100.100.100" > /etc/resolv.conf
  echo "search ts.net" >> /etc/resolv.conf
else
  echo "[entrypoint] TS_AUTHKEY not set — skipping Tailscale (smoke-test mode)"
fi

echo "[entrypoint] starting rhodes-slack-shim"
exec "$@"
