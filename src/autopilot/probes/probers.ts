// ============================================================
// vClaw — Service-Health Probe Primitives
// Low-level probe runners for tcp / https / ping. Each runner
// returns a normalized `ProbeResult` and never throws.
//
// All network primitives are abstracted behind the `ProbeRunner`
// interface so unit tests can plug in mocks (no real sockets in
// test runs).
// ============================================================

import * as net from "node:net";
import * as https from "node:https";
import { spawn } from "node:child_process";
import type { ProbeDef } from "./schema.js";

// ── Result Types ────────────────────────────────────────────

export interface ProbeResult {
  /** Whether the probe considers the target reachable. */
  ok: boolean;
  /** Probe round-trip duration in ms. */
  duration_ms: number;
  /** Human-readable detail (status code, error code, etc.). */
  detail: string;
  /** Stable error code when `ok` is false. Useful for tests. */
  error_code?: string;
}

/**
 * Functional probe runner — given a probe definition, return a result.
 * Each kind (tcp / https / ping) has its own runner implementation.
 */
export type ProbeRunner = (probe: ProbeDef) => Promise<ProbeResult>;

// ── TCP Probe ───────────────────────────────────────────────

/**
 * Attempt a TCP connect to host:port, fail if the timeout elapses or
 * the socket emits an error. Used as the fallback for ping on platforms
 * where `ping` isn't available.
 */
export const tcpProbe: ProbeRunner = (probe) => {
  return new Promise<ProbeResult>((resolve) => {
    const start = Date.now();
    const host = probe.host;
    const port = probe.port;
    const timeoutMs = probe.timeout_ms ?? 5_000;

    if (!host || port === undefined) {
      resolve({
        ok: false,
        duration_ms: 0,
        detail: "missing host/port for tcp probe",
        error_code: "config",
      });
      return;
    }

    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore — socket might already be destroyed
      }
      resolve(result);
    };

    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      settle({
        ok: true,
        duration_ms: Date.now() - start,
        detail: `tcp ${host}:${port} connected`,
      });
    });

    socket.once("timeout", () => {
      settle({
        ok: false,
        duration_ms: Date.now() - start,
        detail: `tcp ${host}:${port} timed out after ${timeoutMs}ms`,
        error_code: "timeout",
      });
    });

    socket.once("error", (err: Error & { code?: string }) => {
      settle({
        ok: false,
        duration_ms: Date.now() - start,
        detail: `tcp ${host}:${port} error: ${err.message}`,
        error_code: err.code ?? "error",
      });
    });

    try {
      socket.connect(port, host);
    } catch (err) {
      const e = err as Error;
      settle({
        ok: false,
        duration_ms: Date.now() - start,
        detail: `tcp ${host}:${port} threw on connect: ${e.message}`,
        error_code: "throw",
      });
    }
  });
};

// ── HTTPS Probe ─────────────────────────────────────────────

/**
 * GET an HTTPS URL and report success when the response status is in
 * the 2xx-4xx range — a 4xx is still proof the service is up, just
 * that the URL or auth is wrong (not what we're checking for).
 */
export const httpsProbe: ProbeRunner = (probe) => {
  return new Promise<ProbeResult>((resolve) => {
    const start = Date.now();
    const url = probe.url;
    const timeoutMs = probe.timeout_ms ?? 5_000;
    const insecure = probe.insecure ?? true;

    if (!url) {
      resolve({
        ok: false,
        duration_ms: 0,
        detail: "missing url for https probe",
        error_code: "config",
      });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({
        ok: false,
        duration_ms: 0,
        detail: `invalid url: ${(err as Error).message}`,
        error_code: "config",
      });
      return;
    }

    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        rejectUnauthorized: !insecure,
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode ?? 0;
        // Drain so the socket can close cleanly.
        res.resume();
        const ok = code >= 200 && code < 500;
        settle({
          ok,
          duration_ms: Date.now() - start,
          detail: `https ${url} -> ${code}`,
          error_code: ok ? undefined : `http_${code}`,
        });
      },
    );

    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch {
        // ignore
      }
      settle({
        ok: false,
        duration_ms: Date.now() - start,
        detail: `https ${url} timed out after ${timeoutMs}ms`,
        error_code: "timeout",
      });
    });

    req.on("error", (err: Error & { code?: string }) => {
      settle({
        ok: false,
        duration_ms: Date.now() - start,
        detail: `https ${url} error: ${err.message}`,
        error_code: err.code ?? "error",
      });
    });

    try {
      req.end();
    } catch (err) {
      settle({
        ok: false,
        duration_ms: Date.now() - start,
        detail: `https ${url} threw on send: ${(err as Error).message}`,
        error_code: "throw",
      });
    }
  });
};

// ── Ping Probe ──────────────────────────────────────────────

/**
 * Spawn `ping -c1 -W2 <host>`. On non-Linux systems where ping is
 * absent or has different flags, the spawn will fail and we fall
 * back to a TCP probe (best-effort). The fallback uses port 443 by
 * default unless the probe specifies a port.
 */
export const pingProbe: ProbeRunner = async (probe) => {
  const start = Date.now();
  const host = probe.host;
  if (!host) {
    return {
      ok: false,
      duration_ms: 0,
      detail: "missing host for ping probe",
      error_code: "config",
    };
  }

  const timeoutMs = probe.timeout_ms ?? 5_000;
  const waitSec = Math.max(1, Math.ceil(timeoutMs / 1000));

  const result = await new Promise<ProbeResult | null>((resolve) => {
    let settled = false;
    const settle = (r: ProbeResult | null): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let proc;
    try {
      proc = spawn("ping", ["-c", "1", "-W", String(waitSec), host], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs + 1_000,
      });
    } catch (err) {
      // Could not spawn — likely no ping binary. Caller falls back.
      settle(null);
      return;
    }

    proc.on("error", () => {
      // ENOENT / EPERM — fall back.
      settle(null);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        settle({
          ok: true,
          duration_ms: Date.now() - start,
          detail: `ping ${host} replied`,
        });
      } else {
        settle({
          ok: false,
          duration_ms: Date.now() - start,
          detail: `ping ${host} exit=${code}`,
          error_code: `exit_${code}`,
        });
      }
    });
  });

  if (result) return result;

  // Fallback: best-effort TCP probe against port 443.
  return tcpProbe({
    ...probe,
    kind: "tcp",
    port: probe.port ?? 443,
  });
};

// ── Dispatcher ──────────────────────────────────────────────

export interface ProberOverrides {
  tcp?: ProbeRunner;
  https?: ProbeRunner;
  ping?: ProbeRunner;
}

/**
 * Run a probe using the kind-specific runner. The `overrides` map lets
 * callers (especially tests) inject mock runners without touching the
 * real network. When no override is provided for a given kind, the
 * built-in node:net / node:https / node:child_process runner is used.
 */
export async function runProbe(
  probe: ProbeDef,
  overrides: ProberOverrides = {},
): Promise<ProbeResult> {
  const runner =
    overrides[probe.kind] ??
    (probe.kind === "tcp"
      ? tcpProbe
      : probe.kind === "https"
        ? httpsProbe
        : pingProbe);
  try {
    return await runner(probe);
  } catch (err) {
    return {
      ok: false,
      duration_ms: 0,
      detail: `probe runner threw: ${(err as Error).message}`,
      error_code: "throw",
    };
  }
}
