// ============================================================
// Tests for the tailnet relay helper.
//
// Strategy: spin up a real `node:http` server on 127.0.0.1:0
// (ephemeral port) for each test, point the relay at it, and
// assert on the result. No real tailnet, no mocks-for-mocks.
// ============================================================

import test from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { relayToRhodes } from "../src/relay.js";

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error("[test-server] handler error", err);
      try {
        res.statusCode = 500;
        res.end(String(err));
      } catch {
        // ignore
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("relayToRhodes: successful relay forwards body and returns upstream status + body", async () => {
  let received: { body: string; contentType: string | undefined; signature: string | undefined } | undefined;
  const { url, close } = await startServer(async (req, res) => {
    received = {
      body: await collectBody(req),
      contentType: req.headers["content-type"],
      signature: req.headers["x-slack-signature"] as string | undefined,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echoed: true }));
  });
  try {
    const result = await relayToRhodes({
      url: `${url}/api/integrations/slack/command`,
      rawBody: "token=xoxb&text=hello",
      contentType: "application/x-www-form-urlencoded",
      forwardHeaders: {
        "x-slack-signature": "v0=deadbeef",
        "x-slack-request-timestamp": "1700000000",
      },
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).ok, true);
    assert.match(result.contentType, /application\/json/);
    assert.ok(received);
    assert.equal(received!.body, "token=xoxb&text=hello");
    assert.equal(received!.contentType, "application/x-www-form-urlencoded");
    assert.equal(received!.signature, "v0=deadbeef");
  } finally {
    await close();
  }
});

test("relayToRhodes: upstream 4xx is passed through verbatim", async () => {
  const { url, close } = await startServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
  });
  try {
    const result = await relayToRhodes({
      url: `${url}/x`,
      rawBody: "",
      contentType: "application/json",
    });
    assert.equal(result.status, 403);
    assert.equal(result.body, "forbidden");
  } finally {
    await close();
  }
});

test("relayToRhodes: upstream timeout returns 504", async () => {
  // Hang the response — never call res.end.
  const { url, close, server } = await startServer((_req, _res) => {
    // intentional: leave the connection open until the test tears down
  });
  try {
    const start = Date.now();
    const result = await relayToRhodes({
      url: `${url}/slow`,
      rawBody: "hello",
      contentType: "text/plain",
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.status, 504);
    assert.match(result.body, /upstream_timeout/);
    assert.ok(elapsed < 2000, `expected fast timeout, got ${elapsed}ms`);
  } finally {
    // Drop hanging sockets so server.close() actually resolves.
    server.closeAllConnections?.();
    await close();
  }
});

test("relayToRhodes: connection refused returns 502", async () => {
  // Bind a server to an ephemeral port to discover a free port, then
  // close it immediately. The OS won't reassign that port instantly,
  // so an immediate connect attempt produces ECONNREFUSED — reliably
  // exercising the classifier's connection-refused branch.
  const { url, close } = await startServer((_req, res) => {
    res.end("ok");
  });
  await close();
  const result = await relayToRhodes({
    url: `${url}/refused`,
    rawBody: "x",
    contentType: "text/plain",
    timeoutMs: 1000,
  });
  assert.equal(result.status, 502);
  assert.match(result.body, /upstream_unreachable/);
});

test("relayToRhodes: DNS failure returns 502", async () => {
  const result = await relayToRhodes({
    url: "http://this-host-does-not-exist-12345.invalid/x",
    rawBody: "x",
    contentType: "text/plain",
    timeoutMs: 2000,
  });
  assert.equal(result.status, 502);
  assert.match(result.body, /upstream_unreachable/);
});

test("relayToRhodes: returns upstream content-type for non-json responses", async () => {
  const { url, close } = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html>ok</html>");
  });
  try {
    const result = await relayToRhodes({
      url: `${url}/`,
      rawBody: "",
      contentType: "application/json",
    });
    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/html/);
    assert.equal(result.body, "<html>ok</html>");
  } finally {
    await close();
  }
});
