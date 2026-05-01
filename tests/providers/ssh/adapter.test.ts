import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SshAdapter, type SshEventEmitter } from "../../../src/providers/ssh/adapter.js";
import type { SpawnFn, SpawnedProcess } from "../../../src/providers/ssh/client.js";
import type { SshClassification, SshTarget } from "../../../src/providers/ssh/types.js";
import { AgentEventType, type AgentEvent } from "../../../src/types.js";

const targets: SshTarget[] = [
  { id: "self", host: "127.0.0.1", user: "test" },
  { id: "pve", host: "10.0.0.10", user: "root", description: "Lab Proxmox" },
];

// ── Fake spawn that drives a one-shot stdout/close cycle ────

interface FakeProc extends SpawnedProcess {
  driveStdout: (s: string) => void;
  driveClose: (code: number | null) => void;
  killed: boolean;
}

function makeFakeSpawn(behaviour: (p: FakeProc, args: readonly string[], cmd: string) => void): SpawnFn {
  return (cmd, args) => {
    const stdoutE = new EventEmitter();
    const stderrE = new EventEmitter();
    const procE = new EventEmitter();
    const proc: FakeProc = {
      stdout: stdoutE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      stderr: stderrE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      on: ((e: string, cb: (...a: unknown[]) => void) => procE.on(e, cb)) as SpawnedProcess["on"],
      kill: () => { proc.killed = true; return true; },
      killed: false,
      driveStdout: (s) => stdoutE.emit("data", Buffer.from(s)),
      driveClose: (code) => procE.emit("close", code),
    };
    setImmediate(() => behaviour(proc, args, cmd));
    return proc;
  };
}

describe("SshAdapter", () => {
  let adapter: SshAdapter;

  beforeEach(() => {
    adapter = new SshAdapter({ targets });
  });

  describe("metadata", () => {
    it("name is 'ssh'", () => {
      expect(adapter.name).toBe("ssh");
    });
    it("kind is 'service' (NOT hypervisor)", () => {
      expect(adapter.kind).toBe("service");
    });
    it("connect/disconnect lifecycle", async () => {
      expect(adapter.isConnected()).toBe(false);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
    it("getClusterState returns empty state with adapter='ssh'", async () => {
      const state = await adapter.getClusterState();
      expect(state.adapter).toBe("ssh");
      expect(state.nodes).toHaveLength(0);
      expect(state.vms).toHaveLength(0);
      expect(state.containers).toHaveLength(0);
      expect(state.storage).toHaveLength(0);
    });
  });

  describe("getTools", () => {
    it("registers ssh_exec, ssh_list_targets, ssh_dry_run", () => {
      const names = adapter.getTools().map((t) => t.name);
      expect(names).toContain("ssh_exec");
      expect(names).toContain("ssh_list_targets");
      expect(names).toContain("ssh_dry_run");
    });
    it("all tools are owned by adapter='ssh'", () => {
      expect(adapter.getTools().every((t) => t.adapter === "ssh")).toBe(true);
    });
    it("ssh_list_targets and ssh_dry_run are read tier", () => {
      const tools = adapter.getTools();
      expect(tools.find((t) => t.name === "ssh_list_targets")!.tier).toBe("read");
      expect(tools.find((t) => t.name === "ssh_dry_run")!.tier).toBe("read");
    });
    it("ssh_exec base tier is risky_write (runtime tier comes from classifier)", () => {
      const t = adapter.getTools().find((x) => x.name === "ssh_exec")!;
      expect(t.tier).toBe("risky_write");
    });
  });

  describe("ssh_list_targets", () => {
    it("returns all configured targets", async () => {
      const result = await adapter.execute("ssh_list_targets", {});
      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);
      expect(data.map((t) => t.id)).toEqual(["self", "pve"]);
    });

    it("never returns the identity_file path — only a boolean flag", async () => {
      const a = new SshAdapter({
        targets: [{ id: "x", host: "h", user: "u", identity_file: "/very/secret/key" }],
      });
      const result = await a.execute("ssh_list_targets", {});
      const json = JSON.stringify(result.data);
      expect(json).not.toContain("/very/secret/key");
      expect(json).toContain("has_identity_file");
    });
  });

  describe("ssh_dry_run", () => {
    it("classifies a read command", async () => {
      const r = await adapter.execute("ssh_dry_run", { command: "uptime" });
      expect(r.success).toBe(true);
      expect((r.data as SshClassification).tier).toBe("read");
    });
    it("classifies a destructive command without executing it", async () => {
      const r = await adapter.execute("ssh_dry_run", { command: "rm -rf /" });
      expect((r.data as SshClassification).tier).toBe("destructive");
    });
    it("returns error for missing command", async () => {
      const r = await adapter.execute("ssh_dry_run", {});
      expect(r.success).toBe(false);
    });
  });

  describe("ssh_exec — input validation", () => {
    it("rejects unknown target_id", async () => {
      const r = await adapter.execute("ssh_exec", { target_id: "no-such", command: "uptime" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("Unknown SSH target");
    });
    it("requires target_id", async () => {
      const r = await adapter.execute("ssh_exec", { command: "uptime" });
      expect(r.success).toBe(false);
    });
    it("requires command", async () => {
      const r = await adapter.execute("ssh_exec", { target_id: "self" });
      expect(r.success).toBe(false);
    });
  });

  describe("ssh_exec — kill-switch and tier handling", () => {
    it("refuses destructive commands when allow_destructive=false", async () => {
      const a = new SshAdapter({ targets, allow_destructive: false });
      const r = await a.execute("ssh_exec", { target_id: "self", command: "rm -rf /tmp" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("ssh.allow_destructive is false");
    });

    it("refuses 'never' tier commands (whitespace-only)", async () => {
      // Note: an empty string fails the "command is required" validation
      // earlier; whitespace is non-empty enough to reach the classifier
      // which then tags it as 'never' and refuses.
      const r = await adapter.execute("ssh_exec", { target_id: "self", command: "   \t " });
      expect(r.success).toBe(false);
      expect(r.error).toContain("refused");
    });

    it("dispatches read commands through the SSH client", async () => {
      const spawnFn = makeFakeSpawn((p) => {
        p.driveStdout("up 1 day\n");
        p.driveClose(0);
      });
      const a = new SshAdapter({ targets }, { spawnFn });
      const r = await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(r.success).toBe(true);
      const data = r.data as { exit_code: number; stdout: string; classification: SshClassification };
      expect(data.exit_code).toBe(0);
      expect(data.stdout).toBe("up 1 day\n");
      expect(data.classification.tier).toBe("read");
    });

    it("with allow_destructive=true, destructive commands still run through governance", async () => {
      const evaluator = vi.fn(async () => ({ allowed: false, reason: "denied for test" }));
      const a = new SshAdapter(
        { targets, allow_destructive: true },
        { governanceEvaluator: evaluator },
      );
      const r = await a.execute("ssh_exec", { target_id: "self", command: "rm -rf /tmp/foo" });
      expect(evaluator).toHaveBeenCalledOnce();
      const [classification] = evaluator.mock.calls[0]!;
      expect(classification.tier).toBe("destructive");
      expect(r.success).toBe(false);
      expect(r.error).toContain("Governance denied");
    });

    it("governance evaluator receives the classified tier per command", async () => {
      const calls: SshClassification[] = [];
      const evaluator = vi.fn(async (c: SshClassification) => {
        calls.push(c);
        return { allowed: true, reason: "ok" };
      });
      const spawnFn = makeFakeSpawn((p) => { p.driveClose(0); });
      const a = new SshAdapter(
        { targets, allow_destructive: true },
        { governanceEvaluator: evaluator, spawnFn },
      );
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      await a.execute("ssh_exec", { target_id: "self", command: "systemctl restart nginx" });
      await a.execute("ssh_exec", { target_id: "self", command: "rm -rf /tmp" });
      expect(calls.map((c) => c.tier)).toEqual(["read", "risky_write", "destructive"]);
    });

    it("denied governance never reaches the SSH client", async () => {
      const spawnFn = vi.fn(makeFakeSpawn((p) => p.driveClose(0)));
      const a = new SshAdapter(
        { targets },
        {
          governanceEvaluator: async () => ({ allowed: false, reason: "no" }),
          spawnFn,
        },
      );
      const r = await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(r.success).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    });
  });

  describe("dispatch", () => {
    it("returns error for unknown tool", async () => {
      const r = await adapter.execute("nonexistent_tool", {});
      expect(r.success).toBe(false);
      expect(r.error).toContain("Unknown SSH tool");
    });
  });

  // ── jump_host wiring (adapter-level) ─────────────────────────
  describe("ssh_exec — jump_host wiring", () => {
    it("forwards target.jump_host into the spawn argv as -J <host>", async () => {
      const targetWithJump: SshTarget = {
        id: "behind-bastion",
        host: "esxi.lab.internal",
        user: "root",
        jump_host: "ops@bastion.example.com",
      };
      let capturedArgs: readonly string[] = [];
      const spawnFn = makeFakeSpawn((p, args) => {
        capturedArgs = args;
        p.driveStdout("ok\n");
        p.driveClose(0);
      });
      const a = new SshAdapter({ targets: [targetWithJump] }, { spawnFn });
      const r = await a.execute("ssh_exec", {
        target_id: "behind-bastion",
        command: "uptime",
      });
      expect(r.success).toBe(true);
      // -J flag is present and is followed by the configured jump_host.
      const jIdx = capturedArgs.indexOf("-J");
      expect(jIdx).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[jIdx + 1]).toBe("ops@bastion.example.com");
      // Destination is after -J.
      const destIdx = capturedArgs.indexOf("root@esxi.lab.internal");
      expect(destIdx).toBeGreaterThan(jIdx);
    });

    it("targets without jump_host don't pass -J", async () => {
      let capturedArgs: readonly string[] = [];
      const spawnFn = makeFakeSpawn((p, args) => {
        capturedArgs = args;
        p.driveClose(0);
      });
      const a = new SshAdapter({ targets }, { spawnFn });
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(capturedArgs).not.toContain("-J");
    });

    it("ssh_list_targets surfaces jump_host so operators can see the topology", async () => {
      const a = new SshAdapter({
        targets: [
          { id: "bridged", host: "h", user: "u", jump_host: "j@b" },
          { id: "direct", host: "h2", user: "u" },
        ],
      });
      const r = await a.execute("ssh_list_targets", {});
      const data = r.data as Array<Record<string, unknown>>;
      const bridged = data.find((t) => t.id === "bridged")!;
      const direct = data.find((t) => t.id === "direct")!;
      expect(bridged.jump_host).toBe("j@b");
      expect(direct.jump_host).toBeUndefined();
    });
  });

  // ── Per-target tier_overrides ────────────────────────────────
  describe("ssh_exec — per-target tier_overrides", () => {
    it("hardens a target: 'read' command becomes 'risky_write' under default floor", async () => {
      const evaluator = vi.fn(async () => ({ allowed: true, reason: "ok" }));
      const spawnFn = makeFakeSpawn((p) => p.driveClose(0));
      const a = new SshAdapter(
        {
          targets: [
            {
              id: "fragile-prod",
              host: "h",
              user: "u",
              tier_overrides: { default: "risky_write" },
            },
          ],
        },
        { governanceEvaluator: evaluator, spawnFn },
      );
      await a.execute("ssh_exec", { target_id: "fragile-prod", command: "uptime" });

      expect(evaluator).toHaveBeenCalledOnce();
      const [classification] = evaluator.mock.calls[0]!;
      expect(classification.tier).toBe("risky_write");
      expect(classification.base_tier).toBe("read");
      expect(classification.override).toBe("default");
    });

    it("unlocks a specific command on a target via commands map", async () => {
      // sandbox host: explicitly allowlist `systemctl restart nginx`
      // down to safe_write so it doesn't need risky_write approval.
      const evaluator = vi.fn(async () => ({ allowed: true, reason: "ok" }));
      const spawnFn = makeFakeSpawn((p) => p.driveClose(0));
      const a = new SshAdapter(
        {
          targets: [
            {
              id: "sandbox",
              host: "h",
              user: "u",
              tier_overrides: {
                commands: { "systemctl-mutate": "safe_write" },
              },
            },
          ],
        },
        { governanceEvaluator: evaluator, spawnFn },
      );
      await a.execute("ssh_exec", {
        target_id: "sandbox",
        command: "systemctl restart nginx",
      });

      const [classification] = evaluator.mock.calls[0]!;
      expect(classification.tier).toBe("safe_write");
      expect(classification.base_tier).toBe("risky_write");
      expect(classification.override).toBe("systemctl-mutate");
    });

    it("does not affect targets that don't declare overrides", async () => {
      const evaluator = vi.fn(async () => ({ allowed: true, reason: "ok" }));
      const spawnFn = makeFakeSpawn((p) => p.driveClose(0));
      const a = new SshAdapter(
        { targets },
        { governanceEvaluator: evaluator, spawnFn },
      );
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      const [classification] = evaluator.mock.calls[0]!;
      expect(classification.tier).toBe("read");
      expect(classification.base_tier).toBeUndefined();
      expect(classification.override).toBeUndefined();
    });

    it("never tier cannot be lowered even with an override", async () => {
      const a = new SshAdapter({
        targets: [
          {
            id: "perm",
            host: "h",
            user: "u",
            tier_overrides: { default: "read", commands: { "empty-command": "read" } },
          },
        ],
      });
      const r = await a.execute("ssh_exec", { target_id: "perm", command: "   " });
      expect(r.success).toBe(false);
      expect(r.error).toContain("refused");
    });

    it("ssh_dry_run with target_id surfaces the post-override tier", async () => {
      const a = new SshAdapter({
        targets: [
          {
            id: "fragile",
            host: "h",
            user: "u",
            tier_overrides: { default: "risky_write" },
          },
        ],
      });
      const r = await a.execute("ssh_dry_run", {
        target_id: "fragile",
        command: "uptime",
      });
      expect(r.success).toBe(true);
      const c = r.data as SshClassification;
      expect(c.tier).toBe("risky_write");
      expect(c.base_tier).toBe("read");
      expect(c.override).toBe("default");
    });

    it("ssh_dry_run without target_id keeps the base classification", async () => {
      const a = new SshAdapter({
        targets: [
          {
            id: "fragile",
            host: "h",
            user: "u",
            tier_overrides: { default: "risky_write" },
          },
        ],
      });
      const r = await a.execute("ssh_dry_run", { command: "uptime" });
      const c = r.data as SshClassification;
      expect(c.tier).toBe("read");
      expect(c.base_tier).toBeUndefined();
    });

    it("ssh_dry_run rejects an unknown target_id (does not silently fall back)", async () => {
      const a = new SshAdapter({ targets });
      const r = await a.execute("ssh_dry_run", {
        target_id: "no-such-host",
        command: "uptime",
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("Unknown SSH target");
    });
  });

  // ── Audit-trail integration ──────────────────────────────────
  describe("ssh_exec — audit-trail integration", () => {
    function makeRecorderBus(): SshEventEmitter & { events: AgentEvent[] } {
      const events: AgentEvent[] = [];
      return {
        events,
        emit: (e) => { events.push(e); },
      };
    }

    it("emits exactly one ssh_exec event on a successful run", async () => {
      const bus = makeRecorderBus();
      const spawnFn = makeFakeSpawn((p) => {
        p.driveStdout("up 1 day\n");
        p.driveClose(0);
      });
      const a = new SshAdapter({ targets }, { spawnFn, eventBus: bus });
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });

      expect(bus.events).toHaveLength(1);
      const ev = bus.events[0]!;
      expect(ev.type).toBe(AgentEventType.SshExec);
      expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ev.data.target_id).toBe("self");
      expect(ev.data.command).toBe("uptime");
      expect(ev.data.tier).toBe("read");
      expect(ev.data.dry_run).toBe(false);
      expect(ev.data.outcome).toBe("executed");
      expect(ev.data.exit_code).toBe(0);
      expect(ev.data.duration_ms).toEqual(expect.any(Number));
    });

    it("emits an event with outcome='failed' and the non-zero exit_code", async () => {
      const bus = makeRecorderBus();
      const spawnFn = makeFakeSpawn((p) => {
        p.driveStdout("bad\n");
        p.driveClose(2);
      });
      const a = new SshAdapter({ targets }, { spawnFn, eventBus: bus });
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });

      const ev = bus.events[0]!;
      expect(ev.data.outcome).toBe("failed");
      expect(ev.data.exit_code).toBe(2);
    });

    it("emits an event with outcome='refused' when destructive kill-switch fires (no execute)", async () => {
      const bus = makeRecorderBus();
      const spawnFn = vi.fn(makeFakeSpawn((p) => p.driveClose(0)));
      const a = new SshAdapter(
        { targets, allow_destructive: false },
        { spawnFn, eventBus: bus },
      );
      const r = await a.execute("ssh_exec", {
        target_id: "self",
        command: "rm -rf /tmp/foo",
      });
      expect(r.success).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();

      expect(bus.events).toHaveLength(1);
      const ev = bus.events[0]!;
      expect(ev.data.outcome).toBe("refused");
      expect(ev.data.tier).toBe("destructive");
      expect(ev.data.exit_code).toBeUndefined();
      expect(ev.data.error).toContain("allow_destructive");
    });

    it("emits an event with outcome='denied' when governance refuses", async () => {
      const bus = makeRecorderBus();
      const spawnFn = vi.fn(makeFakeSpawn((p) => p.driveClose(0)));
      const a = new SshAdapter(
        { targets },
        {
          spawnFn,
          eventBus: bus,
          governanceEvaluator: async () => ({ allowed: false, reason: "test" }),
        },
      );
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(spawnFn).not.toHaveBeenCalled();

      const ev = bus.events[0]!;
      expect(ev.data.outcome).toBe("denied");
      expect(ev.data.error).toContain("Governance denied");
    });

    it("audit event includes base_tier + override when a per-target override fired", async () => {
      const bus = makeRecorderBus();
      const spawnFn = makeFakeSpawn((p) => p.driveClose(0));
      const a = new SshAdapter(
        {
          targets: [
            {
              id: "fragile",
              host: "h",
              user: "u",
              tier_overrides: { default: "risky_write" },
            },
          ],
        },
        { spawnFn, eventBus: bus, governanceEvaluator: async () => ({ allowed: true, reason: "ok" }) },
      );
      await a.execute("ssh_exec", { target_id: "fragile", command: "uptime" });

      const ev = bus.events[0]!;
      expect(ev.data.tier).toBe("risky_write");
      expect(ev.data.base_tier).toBe("read");
      expect(ev.data.override).toBe("default");
    });

    it("ssh_dry_run emits an event with dry_run=true and no outcome", async () => {
      const bus = makeRecorderBus();
      const a = new SshAdapter({ targets }, { eventBus: bus });
      await a.execute("ssh_dry_run", { command: "uptime" });

      expect(bus.events).toHaveLength(1);
      const ev = bus.events[0]!;
      expect(ev.data.dry_run).toBe(true);
      expect(ev.data.tier).toBe("read");
      expect(ev.data.target_id).toBeNull();
      expect(ev.data.outcome).toBeUndefined();
      expect(ev.data.exit_code).toBeUndefined();
    });

    it("audit event reports truncated=true when output cap fires", async () => {
      const bus = makeRecorderBus();
      // Drive enough stdout to overflow the cap (set to 8 bytes), then close.
      const spawnFn = makeFakeSpawn((p) => {
        p.driveStdout("A".repeat(64));
        p.driveClose(0);
      });
      const a = new SshAdapter(
        { targets, max_output_bytes: 8 },
        { spawnFn, eventBus: bus },
      );
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      const ev = bus.events[0]!;
      expect(ev.data.truncated).toBe(true);
      expect(ev.data.timed_out).toBe(false);
    });

    it("listener exceptions are swallowed and don't break ssh_exec", async () => {
      const throwingBus: SshEventEmitter = {
        emit: () => {
          throw new Error("audit listener exploded");
        },
      };
      const spawnFn = makeFakeSpawn((p) => {
        p.driveStdout("ok\n");
        p.driveClose(0);
      });
      // Silence the console.error from the swallow path
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const a = new SshAdapter({ targets }, { spawnFn, eventBus: throwingBus });
      const r = await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(r.success).toBe(true);
      errSpy.mockRestore();
    });

    it("does not emit when no eventBus is injected (back-compat)", async () => {
      const spawnFn = makeFakeSpawn((p) => p.driveClose(0));
      const a = new SshAdapter({ targets }, { spawnFn });
      // No throw, no observable events — just sanity-check the call returns.
      const r = await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(r.success).toBe(true);
    });
  });
});
