# ============================================================
# RHODES Slack Shim — Fly.io production image
#
# Multi-stage: builder compiles TS → JS, runtime stage carries only
# the compiled JS + production dependencies (currently none — the
# shim is pure Node builtins). Final image targets <100MB.
#
# Includes the Tailscale daemon so the shim can join the operator's
# tailnet on cold start and resolve MagicDNS hostnames like
# `homelab.tailc0269a.ts.net`.
# ============================================================

# ---------- Build stage ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Install build deps. We use `npm ci` if a lockfile exists, otherwise
# `npm install` — the lockfile gets generated on first `npm install`
# locally and should be committed.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Prune dev deps so we don't ship typescript/tsx in the runtime image.
RUN npm prune --omit=dev

# ---------- Runtime stage ----------
FROM node:22-alpine AS runtime

# Tailscale userspace networking — the daemon runs alongside the shim,
# joins the tailnet using TS_AUTHKEY at boot, and serves MagicDNS so
# `homelab.tailc0269a.ts.net` resolves correctly inside the container.
RUN apk add --no-cache ca-certificates iptables ip6tables tailscale tini \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# tini is PID 1 so signals reach the shim cleanly and zombie tailscaled
# processes get reaped on container restarts.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
