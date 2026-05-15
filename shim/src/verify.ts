// ============================================================
// RHODES Slack Shim — Slack signature verification
//
// This is the only thing protecting RHODES from forged Slack
// requests. The shim lives on the public internet; if a forged
// request gets past this gate, it gets relayed straight into the
// RHODES tailnet endpoint.
//
// Algorithm (per https://api.slack.com/authentication/verifying-requests-from-slack):
//   sigBase = `v0:${timestamp}:${rawBody}`
//   expected = `v0=${hmacSha256(SLACK_SIGNING_SECRET, sigBase).hexDigest()}`
//   compare expected to header `x-slack-signature` in constant time.
//
// Replay defence: reject any request whose `x-slack-request-timestamp`
// is more than `MAX_AGE_S` seconds away from server `now`. Slack's
// recommendation is 5 minutes.
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_AGE_S = 5 * 60; // 5 minutes

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "missing_timestamp_header"
  | "missing_signature_header"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

export interface VerifyInput {
  /** Raw request body, EXACTLY as received on the wire (no JSON parse). */
  rawBody: string;
  /** Value of `x-slack-request-timestamp` header (string, unix seconds). */
  timestamp: string | undefined | null;
  /** Value of `x-slack-signature` header (e.g. `v0=abc123...`). */
  signature: string | undefined | null;
  /** Slack signing secret from app config. */
  signingSecret: string;
  /** Override "now" for tests (unix seconds). Default `Date.now() / 1000`. */
  nowS?: number;
  /** Replay window in seconds. Default 300 (5 min). */
  maxAgeS?: number;
}

/**
 * Verify a Slack request's signature and freshness.
 *
 * Returns `{ok: true}` if the request is authentic, otherwise a
 * structured failure with a `reason` code suitable for logging.
 * Never throws. Never logs. Never returns the secret. The caller
 * decides how to surface the failure (typically 401 + log line
 * with the request id but NOT the body or the secret).
 */
export function verifySlackSignature(input: VerifyInput): VerifyResult {
  const { rawBody, timestamp, signature, signingSecret } = input;
  const maxAgeS = input.maxAgeS ?? MAX_AGE_S;
  const nowS = input.nowS ?? Math.floor(Date.now() / 1000);

  if (typeof timestamp !== "string" || timestamp.length === 0) {
    return { ok: false, reason: "missing_timestamp_header" };
  }
  if (typeof signature !== "string" || signature.length === 0) {
    return { ok: false, reason: "missing_signature_header" };
  }

  // Parse timestamp as integer seconds. Reject non-numeric or NaN.
  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum) || String(tsNum) !== timestamp.trim()) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  // Replay defence — reject anything outside ±maxAgeS of now.
  if (Math.abs(nowS - tsNum) > maxAgeS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expectedHex = createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const expected = `v0=${expectedHex}`;

  // Constant-time compare. timingSafeEqual requires equal-length buffers,
  // so length-check first and short-circuit explicitly to keep the
  // comparison constant-time relative to length.
  if (expected.length !== signature.length) {
    return { ok: false, reason: "signature_mismatch" };
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

/**
 * Build a `v0=...` signature for a request body. Used by tests and
 * for any internal tooling that needs to produce a valid signature.
 * NEVER call this on production traffic — only Slack should be
 * signing real requests.
 */
export function signSlackRequest(
  rawBody: string,
  timestamp: string | number,
  signingSecret: string,
): string {
  const ts = typeof timestamp === "number" ? String(timestamp) : timestamp;
  const sigBase = `v0:${ts}:${rawBody}`;
  const hex = createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  return `v0=${hex}`;
}
