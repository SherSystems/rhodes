// ============================================================
// Tests for the /brand/* static route serving RHODES brand assets.
// Verifies:
//   1. Bundled SVGs (favicon, mark, mark-white) are served with the
//      correct content-type.
//   2. Path-traversal attempts are rejected, not resolved against the
//      brand dir.
//   3. Requests for non-image extensions / unknown files return 404.
// PNG lockup tests are gated by host availability (~/rhodes-brand may
// not exist in CI) — they assert content-type when the file is present.
// ============================================================
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DashboardServer } from "../../src/frontends/dashboard/server";

function makeServer() {
  const eventBus = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getHistory: vi.fn(() => []),
  } as any;
  const toolRegistry = {
    getClusterState: vi.fn(),
    getMultiClusterState: vi.fn(),
  } as any;
  const audit = {
    queryEntries: vi.fn(() => []),
    getStats: vi.fn(() => ({})),
    exportEntries: vi.fn(() => "[]"),
  } as any;
  return new DashboardServer(0, {} as any, toolRegistry, eventBus, audit) as any;
}

function makeReq(path: string) {
  return { url: path, method: "GET" } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body: unknown;
  return {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, next?: Record<string, string>) {
      statusCode = code;
      if (next) for (const [k, v] of Object.entries(next)) headers[k.toLowerCase()] = v;
    },
    end(chunk?: unknown) {
      body = chunk;
    },
    getStatusCode() {
      return statusCode;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    getBody() {
      return body;
    },
  };
}

describe("Dashboard /brand/* static assets", () => {
  it("serves the bundled favicon SVG with image/svg+xml", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/rhodes-favicon.svg"), res);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/svg+xml");
    expect(Buffer.isBuffer(res.getBody())).toBe(true);
    const body = res.getBody() as Buffer;
    expect(body.length).toBeGreaterThan(0);
    // Sanity: starts with an SVG tag (allow optional leading whitespace).
    expect(body.toString("utf8").trimStart().startsWith("<svg")).toBe(true);
  });

  it("serves the bundled RHODES mark SVG", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/rhodes-mark.svg"), res);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/svg+xml");
  });

  it("serves the white-variant mark SVG", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/rhodes-mark-white.svg"), res);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/svg+xml");
  });

  it("serves the bundled logotype SVG", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/rhodes-logo.svg"), res);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/svg+xml");
  });

  it("serves the lockup PNG from RHODES_BRAND_DIR when available", () => {
    // Default brand dir is /home/pranav/rhodes-brand; this test passes on
    // the dev host where the PNG exists and is skipped otherwise.
    const brandDir = process.env.RHODES_BRAND_DIR || "/home/pranav/rhodes-brand";
    if (!existsSync(join(brandDir, "rhodes-lockup.png"))) {
      return;
    }
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/rhodes-lockup.png"), res);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/png");
    expect(Buffer.isBuffer(res.getBody())).toBe(true);
  });

  it("rejects encoded path-traversal attempts under /brand/", () => {
    // Note: literal `/brand/../../etc/passwd` is normalised by the URL
    // parser to `/etc/passwd` before reaching the dispatcher (so the
    // /brand/ handler never sees it). Encoded `..%2f` sequences DO
    // survive normalisation — that's the real attack surface, and what
    // the brand handler must reject.
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/..%2f..%2fetc%2fpasswd"), res);
    expect(res.getStatusCode()).toBe(404);
    expect(res.getHeader("content-type")).toContain("application/json");
    expect(String(res.getBody())).toContain("Not found");
  });

  it("rejects null-byte injection under /brand/", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/rhodes-mark.svg%00.png"), res);
    expect(res.getStatusCode()).toBe(404);
  });

  it("returns 404 for non-image extensions under /brand/", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/secret.txt"), res);
    expect(res.getStatusCode()).toBe(404);
  });

  it("returns 404 for unknown brand files", () => {
    const server = makeServer();
    const res = makeRes();
    server.handleRequest(makeReq("/brand/does-not-exist.svg"), res);
    expect(res.getStatusCode()).toBe(404);
  });
});
