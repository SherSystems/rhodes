// ============================================================
// Tests for Slack signature verification.
//
// Run with: npm test (which invokes `node --test --import tsx test/*.test.ts`).
// ============================================================

import test from "node:test";
import { strict as assert } from "node:assert";
import { verifySlackSignature, signSlackRequest, MAX_AGE_S } from "../src/verify.js";

const SECRET = "test_signing_secret_do_not_use_in_prod";
const NOW = 1_700_000_000; // fixed "now" for determinism (2023-11-14)

function validReq(body: string, tsOffset = 0): {
  rawBody: string;
  timestamp: string;
  signature: string;
} {
  const ts = String(NOW + tsOffset);
  return {
    rawBody: body,
    timestamp: ts,
    signature: signSlackRequest(body, ts, SECRET),
  };
}

test("verifySlackSignature: valid signature passes", () => {
  const req = validReq("token=xoxb&team_id=T1&command=/rhodes");
  const result = verifySlackSignature({
    ...req,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("verifySlackSignature: wrong secret fails with signature_mismatch", () => {
  const req = validReq("hello=world");
  const result = verifySlackSignature({
    ...req,
    signingSecret: "different_secret",
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "signature_mismatch");
});

test("verifySlackSignature: timestamp > 5 min in past fails with stale_timestamp", () => {
  const req = validReq("hello=world", -(MAX_AGE_S + 1));
  const result = verifySlackSignature({
    ...req,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_timestamp");
});

test("verifySlackSignature: timestamp > 5 min in future fails with stale_timestamp", () => {
  const req = validReq("hello=world", MAX_AGE_S + 1);
  const result = verifySlackSignature({
    ...req,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_timestamp");
});

test("verifySlackSignature: timestamp exactly at boundary passes", () => {
  // ±MAX_AGE_S is allowed (the check is `> maxAgeS`, not `>=`)
  const req = validReq("hello=world", MAX_AGE_S);
  const result = verifySlackSignature({
    ...req,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("verifySlackSignature: tampered body fails with signature_mismatch", () => {
  const req = validReq("command=/rhodes&text=investigate");
  // Mutate body after signing — simulates an attacker rewriting the payload.
  const tampered = { ...req, rawBody: "command=/rhodes&text=DROP_TABLE" };
  const result = verifySlackSignature({
    ...tampered,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "signature_mismatch");
});

test("verifySlackSignature: tampered timestamp fails with signature_mismatch", () => {
  // If the attacker advances the timestamp without re-signing, the
  // signature no longer matches the sigBase.
  const req = validReq("hello=world");
  const result = verifySlackSignature({
    rawBody: req.rawBody,
    timestamp: String(NOW + 1), // shifted by 1 second
    signature: req.signature,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "signature_mismatch");
});

test("verifySlackSignature: missing timestamp header fails cleanly", () => {
  const result = verifySlackSignature({
    rawBody: "hello",
    timestamp: undefined,
    signature: "v0=anything",
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_timestamp_header");
});

test("verifySlackSignature: missing signature header fails cleanly", () => {
  const result = verifySlackSignature({
    rawBody: "hello",
    timestamp: String(NOW),
    signature: null,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_signature_header");
});

test("verifySlackSignature: empty timestamp header fails cleanly", () => {
  const result = verifySlackSignature({
    rawBody: "hello",
    timestamp: "",
    signature: "v0=x",
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_timestamp_header");
});

test("verifySlackSignature: non-numeric timestamp fails with invalid_timestamp", () => {
  const result = verifySlackSignature({
    rawBody: "hello",
    timestamp: "not-a-number",
    signature: "v0=x",
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_timestamp");
});

test("verifySlackSignature: signature with different length fails (no crash)", () => {
  const req = validReq("hello");
  const result = verifySlackSignature({
    ...req,
    signature: "v0=short",
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "signature_mismatch");
});

test("verifySlackSignature: handles binary-ish UTF-8 payloads", () => {
  // Slack payloads are usually ASCII form-encoded, but Block Kit
  // interaction payloads can contain emoji. Verify UTF-8 byte fidelity.
  const body = "payload=%7B%22text%22%3A%22%F0%9F%9A%80%22%7D";
  const req = validReq(body);
  const result = verifySlackSignature({
    ...req,
    signingSecret: SECRET,
    nowS: NOW,
  });
  assert.deepEqual(result, { ok: true });
});
