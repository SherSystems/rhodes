import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildSshArgs, runRemoteCommand } from "../../../src/providers/ssh/client.js";
import type { SpawnFn, SpawnedProcess } from "../../../src/providers/ssh/client.js";
import type { SshTarget } from "../../../src/providers/ssh/types.js";

// ── Fake child_process.spawn ────────────────────────────────
//
// We model the bare minimum surface runRemoteCommand uses: a process
// with .stdout / .stderr emitters, a kill() method, and 'close' /
// 'error' events. Tests drive the emitters synchronously and then
// emit close to settle the promise.

interface Fake extends SpawnedProcess {
  emit(event: string, ...args: unknown[]): boolean;
  killed: boolean;
  killSignal?: NodeJS.Signals | number;
}

function makeFakeSpawn(): { fn: SpawnFn; lastProc: () => Fake; lastArgs: () => string[] } {
  let proc: Fake | undefined;
  let args: string[] = [];
  const fn: SpawnFn = (_cmd, _args) => {
    args = [..._args];
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const procEmitter = new EventEmitter();
    proc = {
      stdout: stdoutEmitter as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      stderr: stderrEmitter as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      on: ((e: string, cb: (...a: unknown[]) => void) => procEmitter.on(e, cb)) as Fake["on"],
      emit: (e: string, ...a: unknown[]) => {
        if (e === "data:stdout") return stdoutEmitter.emit("data", ...a);
        if (e === "data:stderr") return stderrEmitter.emit("data", ...a);
        return procEmitter.emit(e, ...a);
      },
      kill: (signal?: NodeJS.Signals | number) => {
        proc!.killed = true;
        proc!.killSignal = signal;
        return true;
      },
      killed: false,
    };
    return proc;
  };
  return {
    fn,
    lastProc: () => proc!,
    lastArgs: () => args,
  };
}

const target: SshTarget = {
  id: "test",
  host: "10.0.0.1",
  user: "root",
  port: 2222,
  identity_file: "/tmp/key",
};

describe("buildSshArgs", () => {
  it("includes BatchMode, ConnectTimeout, port, identity_file", () => {
    const args = buildSshArgs(target, "uptime", 30, true);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=30");
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/key");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args[args.length - 2]).toBe("root@10.0.0.1");
    expect(args[args.length - 1]).toBe("uptime");
  });

  it("omits port when default 22", () => {
    const args = buildSshArgs({ id: "x", host: "h", user: "u" }, "uptime", 30, true);
    expect(args).not.toContain("-p");
  });

  it("toggles strict-host-key flags", () => {
    const strict = buildSshArgs({ id: "x", host: "h", user: "u" }, "uptime", 30, true);
    expect(strict).toContain("StrictHostKeyChecking=yes");
    expect(strict).not.toContain("UserKnownHostsFile=/dev/null");

    const lax = buildSshArgs({ id: "x", host: "h", user: "u" }, "uptime", 30, false);
    expect(lax).toContain("StrictHostKeyChecking=no");
    expect(lax).toContain("UserKnownHostsFile=/dev/null");
  });

  it("includes -J jump host when configured", () => {
    const args = buildSshArgs(
      { id: "x", host: "h", user: "u", jump_host: "bastion@10.0.0.99" },
      "uptime",
      30,
      true,
    );
    expect(args).toContain("-J");
    expect(args).toContain("bastion@10.0.0.99");
  });

  describe("jump_host wiring", () => {
    it("emits -J BEFORE the user@host destination so ssh parses it as a flag", () => {
      const args = buildSshArgs(
        { id: "x", host: "10.0.0.1", user: "root", jump_host: "ops@bastion.example.com" },
        "uptime",
        30,
        true,
      );
      const jIdx = args.indexOf("-J");
      const destIdx = args.indexOf("root@10.0.0.1");
      expect(jIdx).toBeGreaterThanOrEqual(0);
      expect(destIdx).toBeGreaterThan(jIdx);
      expect(args[jIdx + 1]).toBe("ops@bastion.example.com");
    });

    it("omits -J entirely when jump_host is not set", () => {
      const args = buildSshArgs(
        { id: "x", host: "h", user: "u" },
        "uptime",
        30,
        true,
      );
      expect(args).not.toContain("-J");
    });

    it("treats empty-string jump_host as omitted (no -J flag)", () => {
      const args = buildSshArgs(
        { id: "x", host: "h", user: "u", jump_host: "" },
        "uptime",
        30,
        true,
      );
      expect(args).not.toContain("-J");
    });

    it("supports multi-hop jump_host (comma-separated proxies)", () => {
      const args = buildSshArgs(
        { id: "x", host: "internal.lab", user: "root", jump_host: "ops@hop1,ops@hop2" },
        "uptime",
        30,
        true,
      );
      const jIdx = args.indexOf("-J");
      expect(args[jIdx + 1]).toBe("ops@hop1,ops@hop2");
    });

    it("combines -J with -p, -i, and strict-host-key flags in the right order", () => {
      const args = buildSshArgs(
        {
          id: "x",
          host: "internal.lab",
          user: "root",
          port: 2200,
          identity_file: "/keys/id_lab",
          jump_host: "ops@bastion",
        },
        "uptime",
        30,
        true,
      );
      // All flags must precede the destination
      const destIdx = args.indexOf("root@internal.lab");
      expect(destIdx).toBeGreaterThan(0);
      expect(args.indexOf("-p")).toBeLessThan(destIdx);
      expect(args.indexOf("-i")).toBeLessThan(destIdx);
      expect(args.indexOf("-J")).toBeLessThan(destIdx);
      // The command is the last arg
      expect(args[args.length - 1]).toBe("uptime");
    });
  });
});

describe("runRemoteCommand", () => {
  it("resolves with exit_code 0 and captured stdout on success", async () => {
    const { fn, lastProc } = makeFakeSpawn();
    const promise = runRemoteCommand({
      target,
      command: "uptime",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      strictHostKeyChecking: true,
      spawnFn: fn,
    });
    // Drive the fake
    setImmediate(() => {
      lastProc().emit("data:stdout", Buffer.from("hello\n"));
      lastProc().emit("close", 0);
    });
    const result = await promise;
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.timed_out).toBe(false);
  });

  it("captures stderr and propagates non-zero exit code", async () => {
    const { fn, lastProc } = makeFakeSpawn();
    const promise = runRemoteCommand({
      target,
      command: "ls /missing",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      strictHostKeyChecking: true,
      spawnFn: fn,
    });
    setImmediate(() => {
      lastProc().emit("data:stderr", Buffer.from("ls: cannot access\n"));
      lastProc().emit("close", 2);
    });
    const result = await promise;
    expect(result.exit_code).toBe(2);
    expect(result.stderr).toContain("cannot access");
    expect(result.stdout).toBe("");
  });

  it("truncates stdout at max_output_bytes and marks truncated=true", async () => {
    const { fn, lastProc } = makeFakeSpawn();
    const promise = runRemoteCommand({
      target,
      command: "yes",
      timeoutMs: 5000,
      maxOutputBytes: 16,
      strictHostKeyChecking: true,
      spawnFn: fn,
    });
    setImmediate(() => {
      // 32 bytes of A — twice the cap
      lastProc().emit("data:stdout", Buffer.from("A".repeat(32)));
      lastProc().emit("close", 0);
    });
    const result = await promise;
    expect(result.truncated).toBe(true);
    // First 16 bytes plus the truncation marker
    expect(result.stdout.startsWith("A".repeat(16))).toBe(true);
    expect(result.stdout).toContain("[truncated by vclaw");
    expect(lastProc().killed).toBe(true);
  });

  it("enforces timeout: kills the process and reports timed_out=true with exit_code 124", async () => {
    vi.useFakeTimers();
    const { fn, lastProc } = makeFakeSpawn();
    const promise = runRemoteCommand({
      target,
      command: "sleep 99",
      timeoutMs: 100,
      maxOutputBytes: 1024,
      strictHostKeyChecking: true,
      spawnFn: fn,
    });

    // Trip the soft-kill timer
    await vi.advanceTimersByTimeAsync(101);
    expect(lastProc().killed).toBe(true);
    expect(lastProc().killSignal).toBe("SIGTERM");

    // Process eventually closes (simulating the kill landing)
    lastProc().emit("close", null);
    vi.useRealTimers();
    const result = await promise;
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(124);
  });

  it("reports exit_code 127 on spawn 'error' event", async () => {
    const { fn, lastProc } = makeFakeSpawn();
    const promise = runRemoteCommand({
      target,
      command: "uptime",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      strictHostKeyChecking: true,
      spawnFn: fn,
    });
    setImmediate(() => {
      lastProc().emit("error", new Error("ENOENT: ssh"));
    });
    const result = await promise;
    expect(result.exit_code).toBe(127);
    expect(result.stderr).toContain("ENOENT");
  });

  it("never rejects — synchronous spawn throw is wrapped", async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("no fork for you");
    };
    const result = await runRemoteCommand({
      target,
      command: "uptime",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      strictHostKeyChecking: true,
      spawnFn: throwingSpawn,
    });
    expect(result.exit_code).toBe(127);
    expect(result.stderr).toContain("no fork");
  });
});
