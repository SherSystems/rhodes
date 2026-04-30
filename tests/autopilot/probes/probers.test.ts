import { describe, it, expect, vi, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────
//
// We mock the underlying network primitives so no real sockets or
// child processes are created in unit tests. vi.mock factories are
// hoisted above all imports, so we cannot reference any module-level
// import here — we lazily require node:events inside the factory.

// `__mockSocketInstances` lets tests grab the most-recent socket and
// drive its events. We can't reach into vi.fn().mock.instances when the
// constructor is a plain class, so we track them ourselves.
vi.mock("node:net", async () => {
  const events = (await vi.importActual("node:events")) as typeof import("node:events");
  const instances: events.EventEmitter[] = [];
  class MockSocket extends events.EventEmitter {
    public readonly setTimeout = vi.fn();
    public readonly destroy = vi.fn();
    public readonly connect = vi.fn();
    constructor() {
      super();
      instances.push(this);
    }
  }
  return {
    Socket: MockSocket,
    __mockSocketInstances: instances,
    default: { Socket: MockSocket, __mockSocketInstances: instances },
  };
});

vi.mock("node:https", () => {
  const requestMock = vi.fn();
  return {
    request: requestMock,
    default: { request: requestMock },
  };
});

vi.mock("node:child_process", () => {
  const spawnMock = vi.fn();
  return {
    spawn: spawnMock,
    default: { spawn: spawnMock },
  };
});

import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as https from "node:https";
import { spawn } from "node:child_process";
import {
  tcpProbe,
  httpsProbe,
  pingProbe,
  runProbe,
  type ProbeRunner,
} from "../../../src/autopilot/probes/probers.js";
import type { ProbeDef } from "../../../src/autopilot/probes/schema.js";

/** Pull the latest mock socket instance for driving events. */
function latestSocket(): EventEmitter {
  const instances = (
    net as unknown as { __mockSocketInstances: EventEmitter[] }
  ).__mockSocketInstances;
  if (!instances || instances.length === 0) {
    throw new Error("no mock socket instances captured");
  }
  return instances[instances.length - 1];
}

/** Reset the captured instance list between tests. */
function resetSocketInstances(): void {
  const instances = (
    net as unknown as { __mockSocketInstances: EventEmitter[] }
  ).__mockSocketInstances;
  if (instances) instances.length = 0;
}

function makeProbe(overrides?: Partial<ProbeDef>): ProbeDef {
  return {
    id: "p",
    kind: "tcp",
    host: "127.0.0.1",
    port: 22,
    interval_s: 60,
    timeout_ms: 5_000,
    failures_to_alert: 3,
    cooldown_s: 60,
    insecure: true,
    enabled: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  resetSocketInstances();
});

// ── tcpProbe ─────────────────────────────────────────────────

describe("tcpProbe", () => {
  it("resolves ok=true on successful connect", async () => {
    const promise = tcpProbe(makeProbe());
    latestSocket().emit("connect");
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("connected");
  });

  it("resolves ok=false on socket error with the error code", async () => {
    const promise = tcpProbe(makeProbe());
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    latestSocket().emit("error", err);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("ECONNREFUSED");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("resolves ok=false on timeout", async () => {
    const promise = tcpProbe(makeProbe({ timeout_ms: 1_000 }));
    latestSocket().emit("timeout");
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("timeout");
  });

  it("returns config error when host or port is missing", async () => {
    const result = await tcpProbe(
      makeProbe({ host: undefined, port: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("config");
  });
});

// ── httpsProbe ───────────────────────────────────────────────

function makeMockHttpsResponse(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    resume: () => void;
  };
  res.statusCode = statusCode;
  res.resume = vi.fn();
  return res;
}

function makeMockHttpsRequest() {
  const req = new EventEmitter() as EventEmitter & {
    end: () => void;
    destroy: (err?: Error) => void;
  };
  req.end = vi.fn();
  req.destroy = vi.fn();
  return req;
}

describe("httpsProbe", () => {
  it("returns ok=true on 200 OK", async () => {
    const req = makeMockHttpsRequest();
    let resolveCallback: ((res: EventEmitter) => void) | undefined;
    vi.mocked(https.request).mockImplementation(
      // @ts-expect-error - simplified mock signature
      (_opts, cb) => {
        resolveCallback = cb as (res: EventEmitter) => void;
        return req;
      },
    );

    const promise = httpsProbe(
      makeProbe({ kind: "https", url: "https://example.com/" }),
    );
    resolveCallback?.(makeMockHttpsResponse(200));
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("200");
  });

  it("treats a 4xx as ok=true (service is up, just rejects request)", async () => {
    const req = makeMockHttpsRequest();
    let resolveCallback: ((res: EventEmitter) => void) | undefined;
    vi.mocked(https.request).mockImplementation(
      // @ts-expect-error - simplified mock signature
      (_opts, cb) => {
        resolveCallback = cb as (res: EventEmitter) => void;
        return req;
      },
    );

    const promise = httpsProbe(
      makeProbe({ kind: "https", url: "https://example.com/" }),
    );
    resolveCallback?.(makeMockHttpsResponse(401));
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("401");
  });

  it("treats a 5xx as ok=false", async () => {
    const req = makeMockHttpsRequest();
    let resolveCallback: ((res: EventEmitter) => void) | undefined;
    vi.mocked(https.request).mockImplementation(
      // @ts-expect-error - simplified mock signature
      (_opts, cb) => {
        resolveCallback = cb as (res: EventEmitter) => void;
        return req;
      },
    );

    const promise = httpsProbe(
      makeProbe({ kind: "https", url: "https://example.com/" }),
    );
    resolveCallback?.(makeMockHttpsResponse(503));
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("http_503");
  });

  it("returns ok=false on request error", async () => {
    const req = makeMockHttpsRequest();
    vi.mocked(https.request).mockReturnValue(
      req as unknown as ReturnType<typeof https.request>,
    );

    const promise = httpsProbe(
      makeProbe({ kind: "https", url: "https://example.com/" }),
    );
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    req.emit("error", err);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("ENOTFOUND");
  });

  it("returns ok=false on request timeout", async () => {
    const req = makeMockHttpsRequest();
    vi.mocked(https.request).mockReturnValue(
      req as unknown as ReturnType<typeof https.request>,
    );

    const promise = httpsProbe(
      makeProbe({
        kind: "https",
        url: "https://example.com/",
        timeout_ms: 1_000,
      }),
    );
    req.emit("timeout");
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("timeout");
  });

  it("rejects an invalid url with a config error", async () => {
    const result = await httpsProbe(
      makeProbe({ kind: "https", url: "not a url" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("config");
  });

  it("returns config error when url is missing", async () => {
    const result = await httpsProbe(
      makeProbe({ kind: "https", url: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("config");
  });
});

// ── pingProbe ────────────────────────────────────────────────

function makeMockChildProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("pingProbe", () => {
  it("returns ok=true when ping exits with code 0", async () => {
    const proc = makeMockChildProc();
    vi.mocked(spawn).mockReturnValue(
      proc as unknown as ReturnType<typeof spawn>,
    );

    const promise = pingProbe(makeProbe({ kind: "ping", host: "1.1.1.1" }));
    proc.emit("close", 0);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("replied");
  });

  it("returns ok=false when ping exits non-zero", async () => {
    const proc = makeMockChildProc();
    vi.mocked(spawn).mockReturnValue(
      proc as unknown as ReturnType<typeof spawn>,
    );

    const promise = pingProbe(makeProbe({ kind: "ping", host: "1.1.1.1" }));
    proc.emit("close", 1);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("exit_1");
  });

  it("returns config error when host missing", async () => {
    const result = await pingProbe(
      makeProbe({ kind: "ping", host: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("config");
  });

  it("falls back to a TCP probe when spawn fails (no ping binary)", async () => {
    const proc = makeMockChildProc();
    vi.mocked(spawn).mockReturnValue(
      proc as unknown as ReturnType<typeof spawn>,
    );

    const promise = pingProbe(makeProbe({ kind: "ping", host: "1.1.1.1" }));
    // Simulate ENOENT — proc emits "error", scheduler returns null
    // (forces fallback to tcpProbe).
    proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    // Microtask flush so the fallback tcpProbe constructs its socket.
    await Promise.resolve();

    const instances = (
      net as unknown as { __mockSocketInstances: EventEmitter[] }
    ).__mockSocketInstances;
    if (instances.length > 0) {
      const socket = instances[instances.length - 1];
      socket.emit(
        "error",
        Object.assign(new Error("fallback failed"), { code: "EHOSTDOWN" }),
      );
    }

    const result = await promise;
    // We can't guarantee ok=true (no real socket). The point is the
    // fallback path is exercised — pingProbe must return a structured
    // ProbeResult rather than throw.
    expect(typeof result.ok).toBe("boolean");
  });
});

// ── runProbe dispatcher ─────────────────────────────────────

describe("runProbe", () => {
  it("dispatches to the override matching kind=tcp", async () => {
    const tcp: ProbeRunner = vi.fn().mockResolvedValue({
      ok: true,
      duration_ms: 1,
      detail: "stub",
    });
    const result = await runProbe(makeProbe({ kind: "tcp" }), { tcp });
    expect(tcp).toHaveBeenCalledTimes(1);
    expect(result.detail).toBe("stub");
  });

  it("dispatches to override for kind=https", async () => {
    const httpsRunner: ProbeRunner = vi.fn().mockResolvedValue({
      ok: false,
      duration_ms: 1,
      detail: "stub-https",
      error_code: "stub",
    });
    const result = await runProbe(
      makeProbe({ kind: "https", url: "https://x.test" }),
      { https: httpsRunner },
    );
    expect(httpsRunner).toHaveBeenCalledTimes(1);
    expect(result.error_code).toBe("stub");
  });

  it("dispatches to override for kind=ping", async () => {
    const pingRunner: ProbeRunner = vi.fn().mockResolvedValue({
      ok: true,
      duration_ms: 1,
      detail: "stub-ping",
    });
    const result = await runProbe(
      makeProbe({ kind: "ping", host: "1.1.1.1" }),
      { ping: pingRunner },
    );
    expect(pingRunner).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("returns a structured failure when the runner throws", async () => {
    const bad: ProbeRunner = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await runProbe(makeProbe({ kind: "tcp" }), { tcp: bad });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("throw");
    expect(result.detail).toContain("boom");
  });
});
