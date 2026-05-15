// ============================================================
// RHODES Slack Shim — public-facing HTTP server
//
// Architecture:
//   Slack ──HTTPS──▶ this shim (public Fly.io URL)
//                       │
//                       ├── verify x-slack-signature
//                       ├── timestamp replay check (±5 min)
//                       │
//                       └── relay raw body over the tailnet
//                              ▼
//                   ${RHODES_URL}/api/integrations/slack/{command|interact|events}
//
// RHODES itself NEVER gets a public listener. The shim is the
// only thing on the public internet. If you find yourself adding
// state, persistence, or business logic here, you're in the
// wrong place — push that work into RHODES.
//
// Routes:
//   POST /slack/command   → relay to /api/integrations/slack/command
//   POST /slack/interact  → relay to /api/integrations/slack/interact
//   POST /slack/events    → handle url_verification synchronously;
//                            otherwise ACK <3s and relay async.
//   GET  /healthz         → liveness for Fly health checks.
//
// All POST routes verify the Slack signature BEFORE relaying.
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { verifySlackSignature, type VerifyFailureReason } from "./verify.js";
import { relayToRhodes } from "./relay.js";

const PORT = Number.parseInt(process.env["PORT"] ?? "8080", 10);
const RHODES_URL = (process.env["RHODES_URL"] ?? "").replace(/\/+$/, "");
const SLACK_SIGNING_SECRET = process.env["SLACK_SIGNING_SECRET"] ?? "";
const RELAY_TIMEOUT_MS = Number.parseInt(process.env["RELAY_TIMEOUT_MS"] ?? "5000", 10);

// Slack expects an ACK within 3s. We give ourselves 2.5s headroom
// on the synchronous relay used for `/slack/command` and
// `/slack/interact` so we can still return Slack's own 2xx if
// RHODES replies in time, but bail to a generic ACK if it doesn't.
const SYNC_RELAY_TIMEOUT_MS = Math.min(RELAY_TIMEOUT_MS, 2_500);

const START_TIME_MS = Date.now();

interface ParsedRequest {
  rawBody: string;
  contentType: string;
  timestamp: string | undefined;
  signature: string | undefined;
  requestId: string;
}

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function textResponse(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

function genReqId(): string {
  // Short random id for log correlation. Not cryptographic, just for tracing.
  return `req_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function logSigFailure(reqId: string, route: string, reason: VerifyFailureReason): void {
  // NEVER log the body or the secret. Just the route + reason + req id.
  console.warn(`[shim] signature ${reason} route=${route} req_id=${reqId}`);
}

async function parseRequest(req: IncomingMessage): Promise<ParsedRequest> {
  const rawBody = await readBody(req);
  return {
    rawBody,
    contentType: singleHeader(req, "content-type") ?? "application/x-www-form-urlencoded",
    timestamp: singleHeader(req, "x-slack-request-timestamp"),
    signature: singleHeader(req, "x-slack-signature"),
    requestId: genReqId(),
  };
}

function verifyOr401(
  res: ServerResponse,
  route: string,
  parsed: ParsedRequest,
): boolean {
  const result = verifySlackSignature({
    rawBody: parsed.rawBody,
    timestamp: parsed.timestamp,
    signature: parsed.signature,
    signingSecret: SLACK_SIGNING_SECRET,
  });
  if (!result.ok) {
    logSigFailure(parsed.requestId, route, result.reason);
    jsonResponse(res, 401, { ok: false, error: "signature_invalid" });
    return false;
  }
  return true;
}

function forwardHeaders(parsed: ParsedRequest): Record<string, string> {
  const out: Record<string, string> = {};
  if (parsed.timestamp) out["x-slack-request-timestamp"] = parsed.timestamp;
  if (parsed.signature) out["x-slack-signature"] = parsed.signature;
  out["x-shim-request-id"] = parsed.requestId;
  return out;
}

async function handleCommand(parsed: ParsedRequest, res: ServerResponse): Promise<void> {
  if (!verifyOr401(res, "command", parsed)) return;

  const upstream = await relayToRhodes({
    url: `${RHODES_URL}/api/integrations/slack/command`,
    rawBody: parsed.rawBody,
    contentType: parsed.contentType,
    forwardHeaders: forwardHeaders(parsed),
    timeoutMs: SYNC_RELAY_TIMEOUT_MS,
  });

  // If RHODES couldn't be reached in time, give Slack a friendly
  // ephemeral message rather than a raw 5xx — Slack renders it inline.
  if (upstream.status >= 500) {
    console.warn(`[shim] command upstream ${upstream.status} req_id=${parsed.requestId}`);
    jsonResponse(res, 200, {
      response_type: "ephemeral",
      text: ":warning: RHODES is unreachable right now — try again in a moment.",
    });
    return;
  }

  res.writeHead(upstream.status, { "content-type": upstream.contentType });
  res.end(upstream.body);
}

async function handleInteract(parsed: ParsedRequest, res: ServerResponse): Promise<void> {
  if (!verifyOr401(res, "interact", parsed)) return;

  const upstream = await relayToRhodes({
    url: `${RHODES_URL}/api/integrations/slack/interact`,
    rawBody: parsed.rawBody,
    contentType: parsed.contentType,
    forwardHeaders: forwardHeaders(parsed),
    timeoutMs: SYNC_RELAY_TIMEOUT_MS,
  });

  if (upstream.status >= 500) {
    console.warn(`[shim] interact upstream ${upstream.status} req_id=${parsed.requestId}`);
    // Slack accepts an empty 200 for interactivity — the message just
    // doesn't get auto-updated. Operator will see the failure in the
    // shim logs and can retry the button.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }

  res.writeHead(upstream.status, { "content-type": upstream.contentType });
  res.end(upstream.body);
}

async function handleEvents(parsed: ParsedRequest, res: ServerResponse): Promise<void> {
  if (!verifyOr401(res, "events", parsed)) return;

  // Events API has a special bootstrap step: Slack POSTs a
  // `url_verification` body the first time the events URL is
  // registered, and expects the `challenge` value echoed back
  // synchronously within 3s. Detect it before doing anything else.
  let parsedBody: { type?: string; challenge?: string } | undefined;
  try {
    parsedBody = JSON.parse(parsed.rawBody) as { type?: string; challenge?: string };
  } catch {
    // Events should always be JSON; if it's not, fall through and let
    // RHODES surface the parse error.
  }

  if (parsedBody?.type === "url_verification" && typeof parsedBody.challenge === "string") {
    console.log(`[shim] url_verification challenge served req_id=${parsed.requestId}`);
    jsonResponse(res, 200, { challenge: parsedBody.challenge });
    return;
  }

  // Slack needs <3s ACK for events. Relay async — fire-and-forget but
  // log the outcome so failures aren't silent.
  jsonResponse(res, 200, { ok: true });

  void relayToRhodes({
    url: `${RHODES_URL}/api/integrations/slack/events`,
    rawBody: parsed.rawBody,
    contentType: parsed.contentType,
    forwardHeaders: forwardHeaders(parsed),
    timeoutMs: RELAY_TIMEOUT_MS,
  }).then(
    (result) => {
      if (result.status >= 400) {
        console.warn(`[shim] events upstream ${result.status} req_id=${parsed.requestId}`);
      }
    },
    (err) => {
      // relayToRhodes never throws, but defence in depth.
      console.warn(`[shim] events relay errored req_id=${parsed.requestId}: ${String(err)}`);
    },
  );
}

function handleHealth(res: ServerResponse): void {
  const uptimeS = Math.floor((Date.now() - START_TIME_MS) / 1000);
  jsonResponse(res, 200, {
    ok: true,
    uptime_s: uptimeS,
    rhodes_url_configured: RHODES_URL.length > 0,
    signing_secret_configured: SLACK_SIGNING_SECRET.length > 0,
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  // Healthz is a plain GET — no body, no verification.
  if (method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
    handleHealth(res);
    return;
  }

  if (method !== "POST") {
    textResponse(res, 405, "Method Not Allowed");
    return;
  }

  // Refuse to operate if config is missing — better to 503 every
  // request than to silently fail-open on signature verification.
  if (SLACK_SIGNING_SECRET.length === 0 || RHODES_URL.length === 0) {
    console.error("[shim] refusing request — SLACK_SIGNING_SECRET or RHODES_URL not configured");
    jsonResponse(res, 503, { ok: false, error: "shim_not_configured" });
    return;
  }

  let parsed: ParsedRequest;
  try {
    parsed = await parseRequest(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    textResponse(res, 413, `body read failed: ${msg}`);
    return;
  }

  switch (url) {
    case "/slack/command":
      await handleCommand(parsed, res);
      return;
    case "/slack/interact":
      await handleInteract(parsed, res);
      return;
    case "/slack/events":
      await handleEvents(parsed, res);
      return;
    default:
      textResponse(res, 404, "Not Found");
      return;
  }
}

function main(): void {
  const server = createServer((req, res) => {
    dispatch(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[shim] unhandled error: ${msg}`);
      if (!res.headersSent) {
        try {
          jsonResponse(res, 500, { ok: false, error: "internal_error" });
        } catch {
          res.end();
        }
      } else {
        res.end();
      }
    });
  });

  server.on("clientError", (_err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      // socket already closed
    }
  });

  server.listen(PORT, () => {
    const configState = SLACK_SIGNING_SECRET.length > 0 && RHODES_URL.length > 0 ? "ready" : "DEGRADED (config missing)";
    console.log(`[shim] listening on :${PORT} state=${configState} rhodes_url=${RHODES_URL || "(unset)"}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[shim] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Force exit after 10s if connections hang.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only start the server when run directly (not when imported by tests).
// Using process.argv[1] check rather than `import.meta.url` comparison
// keeps this portable across node versions and tsx invocation modes.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/index.js") || process.argv[1].endsWith("/index.ts") || process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"));

if (invokedDirectly) {
  main();
}

export { main, dispatch };
