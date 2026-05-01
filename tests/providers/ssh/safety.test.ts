import { describe, it, expect } from "vitest";
import { applyTierOverrides, classifyCommand } from "../../../src/providers/ssh/safety.js";
import type { ActionTier } from "../../../src/providers/types.js";
import type { SshTierOverrides } from "../../../src/providers/ssh/types.js";

interface Case {
  command: string;
  tier: ActionTier;
  /** If set, also assert the matched-tag includes this substring. */
  match?: string;
}

const cases: Case[] = [
  // ── Empty / whitespace ─────────────────────────────────────
  { command: "", tier: "never", match: "empty" },
  { command: "   ", tier: "never", match: "empty" },
  { command: "\n\t", tier: "never", match: "empty" },

  // ── Read-only ─────────────────────────────────────────────
  { command: "uptime", tier: "read", match: "uptime" },
  { command: "df", tier: "read", match: "df" },
  { command: "df -h", tier: "read", match: "df" },
  { command: "free -m", tier: "read", match: "free" },
  { command: "uname -a", tier: "read", match: "uname" },
  { command: "whoami", tier: "read", match: "whoami" },
  { command: "id", tier: "read", match: "id" },
  { command: "hostname", tier: "read", match: "hostname" },
  { command: "pwd", tier: "read", match: "pwd" },
  { command: "ps aux", tier: "read", match: "ps" },
  { command: "ls", tier: "read", match: "ls" },
  { command: "ls -la /var/log", tier: "read", match: "ls" },
  { command: "cat /etc/hostname", tier: "read", match: "cat" },
  { command: "cat /proc/cpuinfo", tier: "read", match: "cat" },
  { command: "head -n 50 /var/log/syslog", tier: "read", match: "head" },
  { command: "tail -n 100 /var/log/messages", tier: "read", match: "tail" },
  { command: "grep -i error /var/log/messages", tier: "read", match: "grep" },
  { command: "find /tmp -name foo.txt", tier: "read", match: "find" },
  { command: "journalctl -u nginx", tier: "read", match: "journalctl" },
  { command: "systemctl status nginx", tier: "read", match: "systemctl-read" },
  { command: "systemctl is-active sshd", tier: "read", match: "systemctl-read" },
  { command: "qm list", tier: "read", match: "qm-read" },
  { command: "qm status 200", tier: "read", match: "qm-read" },
  { command: "qm config 200", tier: "read", match: "qm-read" },
  { command: "pct list", tier: "read", match: "pct-read" },
  { command: "esxcli network ip interface list", tier: "read", match: "esxcli-read" },
  { command: "esxcli vm process get", tier: "read", match: "esxcli-read" },
  { command: "vim-cmd vmsvc/getallvms", tier: "read", match: "vim-cmd-read" },
  { command: "top -b -n 1", tier: "read", match: "top-batch" },

  // ── Safe write ────────────────────────────────────────────
  { command: "mkdir -p /tmp/work", tier: "safe_write", match: "mkdir" },
  { command: "touch /tmp/marker", tier: "safe_write", match: "touch" },
  { command: "cp /etc/hosts /tmp/hosts.bak", tier: "safe_write", match: "cp" },
  { command: "chmod 644 /tmp/file", tier: "safe_write", match: "chmod" },
  { command: "chown root /tmp/file", tier: "safe_write", match: "chown" },
  { command: "ln -s /tmp/foo /tmp/bar", tier: "safe_write", match: "ln-s" },

  // ── Risky write ───────────────────────────────────────────
  { command: "qm stop 200", tier: "risky_write", match: "qm-power" },
  { command: "qm shutdown 200", tier: "risky_write", match: "qm-power" },
  { command: "qm reboot 200", tier: "risky_write", match: "qm-power" },
  { command: "qm reset 200", tier: "risky_write", match: "qm-power" },
  { command: "qm start 200", tier: "risky_write", match: "qm-start" },
  { command: "pct stop 100", tier: "risky_write", match: "pct-power" },
  { command: "pct start 100", tier: "risky_write", match: "pct-start" },
  { command: "systemctl restart nginx", tier: "risky_write", match: "systemctl-mutate" },
  { command: "systemctl reload nginx", tier: "risky_write", match: "systemctl-mutate" },
  { command: "systemctl stop nginx", tier: "risky_write", match: "systemctl-mutate" },
  { command: "service nginx restart", tier: "risky_write", match: "service-mutate" },
  { command: "kill -9 12345", tier: "risky_write", match: "kill-pid" },
  { command: "kill 12345", tier: "risky_write", match: "kill-pid" },
  { command: "pkill nginx", tier: "risky_write", match: "pkill" },
  { command: "killall ssh", tier: "risky_write", match: "killall" },

  // ── Destructive ───────────────────────────────────────────
  { command: "qm destroy 200", tier: "destructive", match: "qm-destroy" },
  { command: "qm delete 200", tier: "destructive", match: "qm-destroy" },
  { command: "pct destroy 100", tier: "destructive", match: "pct-destroy" },
  { command: "rm -rf /tmp/foo", tier: "destructive", match: "rm-rf" },
  { command: "rm -fr /tmp/foo", tier: "destructive" },
  { command: "rm --recursive /tmp/foo", tier: "destructive", match: "rm-rf" },
  { command: "dd if=/dev/zero of=/tmp/foo bs=1M count=10", tier: "destructive", match: "dd-of" },
  { command: "mkfs.ext4 /dev/sdb1", tier: "destructive", match: "mkfs" },
  { command: "fdisk /dev/sda", tier: "destructive", match: "fdisk" },
  { command: "parted /dev/sda print", tier: "destructive", match: "parted" },
  { command: "iptables -F", tier: "destructive", match: "iptables-flush" },
  { command: "firewall-cmd --reload", tier: "destructive", match: "firewall-cmd-reload" },
  { command: "reboot", tier: "destructive", match: "host-reboot" },
  { command: "shutdown -h now", tier: "destructive", match: "host-reboot" },
  { command: "poweroff", tier: "destructive", match: "host-reboot" },
  { command: "init 6", tier: "destructive", match: "init-runlevel" },
  { command: "init 0", tier: "destructive", match: "init-runlevel" },
  { command: "wipefs -a /dev/sdb", tier: "destructive", match: "wipefs" },

  // ── Shell escape hatches → destructive ────────────────────
  { command: "uptime; rm -rf /", tier: "destructive", match: "shell-metachar" },
  { command: "uptime && reboot", tier: "destructive", match: "shell-metachar" },
  { command: "ls | grep foo", tier: "destructive", match: "shell-metachar" },
  { command: "echo `whoami`", tier: "destructive", match: "shell-metachar" },
  { command: "echo $(whoami)", tier: "destructive", match: "shell-metachar" },
  { command: "echo $HOME", tier: "destructive", match: "shell-metachar" },
  { command: "echo ${HOME}", tier: "destructive", match: "shell-metachar" },
  { command: "uptime > /tmp/out", tier: "destructive", match: "shell-metachar" },
  { command: "cat /etc/passwd > /dev/null", tier: "destructive" },
  { command: "uptime &", tier: "destructive", match: "shell-metachar" },

  // ── Unknown commands fail closed ──────────────────────────
  { command: "frobnicate --quux", tier: "destructive", match: "default-fail-closed" },
  { command: "curl https://example.com", tier: "destructive", match: "default-fail-closed" },
];

describe("ssh safety classifier", () => {
  for (const c of cases) {
    it(`classifies "${c.command}" as ${c.tier}`, () => {
      const result = classifyCommand(c.command);
      expect(result.tier, `tier mismatch for "${c.command}" (got ${result.tier} via ${result.match})`).toBe(c.tier);
      if (c.match) {
        expect(result.match, `match-tag mismatch for "${c.command}"`).toContain(c.match);
      }
      // Every classification must come with a non-empty reason.
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }

  describe("regression-prone shapes", () => {
    it("most-dangerous-first: reboot in middle of word stays destructive", () => {
      const r = classifyCommand("reboot --force");
      expect(r.tier).toBe("destructive");
    });

    it("rm without -r/-f is still suspicious — defaults to destructive (no rule matched)", () => {
      const r = classifyCommand("rm /tmp/foo");
      expect(r.tier).toBe("destructive");
      expect(r.match).toBe("default-fail-closed");
    });

    it("trailing whitespace doesn't break read classification", () => {
      const r = classifyCommand("  uptime   ");
      expect(r.tier).toBe("read");
    });

    it("block-device path triggers destructive even in read prefix", () => {
      const r = classifyCommand("cat /dev/sda");
      // This contains '/dev/sda' which matches the block-device rule
      // before cat is considered. (Most-dangerous-first scan.)
      expect(r.tier).toBe("destructive");
      expect(r.match).toBe("block-device");
    });
  });

  // ── Per-target tier overrides ────────────────────────────────
  describe("applyTierOverrides", () => {
    it("returns the input unchanged when overrides is undefined", () => {
      const base = classifyCommand("uptime");
      const out = applyTierOverrides(base, "uptime", undefined);
      expect(out).toBe(base);
    });

    it("returns the input unchanged when overrides is empty", () => {
      const base = classifyCommand("uptime");
      const out = applyTierOverrides(base, "uptime", {});
      expect(out.tier).toBe("read");
      expect(out.base_tier).toBeUndefined();
      expect(out.override).toBeUndefined();
    });

    it("default floor: bumps read up to risky_write on a fragile target", () => {
      const overrides: SshTierOverrides = { default: "risky_write" };
      const out = applyTierOverrides(classifyCommand("uptime"), "uptime", overrides);
      expect(out.tier).toBe("risky_write");
      expect(out.base_tier).toBe("read");
      expect(out.override).toBe("default");
      expect(out.reason).toContain("per-target floor");
    });

    it("default floor never lowers — risky_write stays risky_write when floor is read", () => {
      const overrides: SshTierOverrides = { default: "read" };
      const base = classifyCommand("systemctl restart nginx");
      expect(base.tier).toBe("risky_write");
      const out = applyTierOverrides(base, "systemctl restart nginx", overrides);
      expect(out.tier).toBe("risky_write");
      expect(out.base_tier).toBeUndefined();
    });

    it("commands map: per-tag override (allowlists systemctl-mutate to safe_write)", () => {
      const overrides: SshTierOverrides = {
        commands: { "systemctl-mutate": "safe_write" },
      };
      const base = classifyCommand("systemctl restart nginx");
      const out = applyTierOverrides(base, "systemctl restart nginx", overrides);
      expect(out.tier).toBe("safe_write");
      expect(out.base_tier).toBe("risky_write");
      expect(out.override).toBe("systemctl-mutate");
    });

    it("commands map: exact-command override wins when tag isn't in the map", () => {
      const overrides: SshTierOverrides = {
        commands: { "systemctl restart specific-service": "safe_write" },
      };
      const out = applyTierOverrides(
        classifyCommand("systemctl restart specific-service"),
        "systemctl restart specific-service",
        overrides,
      );
      expect(out.tier).toBe("safe_write");
      expect(out.override).toBe("systemctl restart specific-service");
    });

    it("commands map can RAISE a read command to risky_write", () => {
      const overrides: SshTierOverrides = {
        commands: { uptime: "risky_write" },
      };
      const out = applyTierOverrides(
        classifyCommand("uptime"),
        "uptime",
        overrides,
      );
      expect(out.tier).toBe("risky_write");
      expect(out.base_tier).toBe("read");
      expect(out.override).toBe("uptime");
    });

    it("never tier is never overridden (forbidden inputs stay forbidden)", () => {
      const overrides: SshTierOverrides = {
        default: "read",
        commands: { "empty-command": "read" },
      };
      const base = classifyCommand("");
      expect(base.tier).toBe("never");
      const out = applyTierOverrides(base, "", overrides);
      expect(out.tier).toBe("never");
    });

    it("commands map: tag check beats text check", () => {
      // Both keys "match" but the tag should take precedence.
      const overrides: SshTierOverrides = {
        commands: { uptime: "destructive", uptime_text_only: "read" },
      };
      const out = applyTierOverrides(
        classifyCommand("uptime"),
        "uptime",
        overrides,
      );
      expect(out.tier).toBe("destructive");
      expect(out.override).toBe("uptime");
    });

    it("commands and default combine — explicit override wins over the floor", () => {
      const overrides: SshTierOverrides = {
        default: "risky_write",
        commands: { uptime: "read" },
      };
      // Without the commands override, default would bump uptime to
      // risky_write. The exact override unlocks it back down to read.
      const out = applyTierOverrides(
        classifyCommand("uptime"),
        "uptime",
        overrides,
      );
      expect(out.tier).toBe("read");
      expect(out.override).toBe("uptime");
    });

    it("no-op override matched by tag still records the override key", () => {
      // The override sets the same tier — useful for "I explicitly
      // allowlisted this command on this target" audit trails.
      const overrides: SshTierOverrides = {
        commands: { uptime: "read" },
      };
      const out = applyTierOverrides(
        classifyCommand("uptime"),
        "uptime",
        overrides,
      );
      expect(out.tier).toBe("read");
      expect(out.override).toBe("uptime");
      // No tier change, so no base_tier is recorded.
      expect(out.base_tier).toBeUndefined();
    });
  });
});
