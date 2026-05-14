// ============================================================
// RHODES — SSH Command Safety Classifier
//
// Given a raw shell command string, determine which governance tier
// applies. Conservative by design: anything we don't recognise is
// classified as "destructive" so it requires explicit human approval.
//
// Operators can extend the allowlists by editing the regex tables
// below or by adding entries to the SshConfig (future iteration —
// see docs/ssh-adapter.md TODOs).
// ============================================================

import type { ActionTier } from "../types.js";
import type { SshClassification, SshTierOverrides } from "./types.js";

// ── Shell metacharacter detection ───────────────────────────
//
// Any of these convert an otherwise-safe command into something we
// can't reason about — the caller could be running a benign first
// command but pipe it into rm, redirect it to /dev/sda, or chain a
// destroy. We treat ANY of them as an automatic bump to "destructive".
//
// Operators who need pipelines must request the higher tier or use
// a future per-target allowlist.
//
// Note: we DO allow bare `&` if it's part of `&&` ... actually no:
// & alone could background a destructive command. Keep it strict.
const SHELL_ESCAPE_HATCHES = /[;`$()<>&|]|\$\{/;

// Backslash-redirect (>>) — also a write/escape vector.
const REDIRECT_HATCH = /\s>>?\s|\s>>?$|^>>?/;

// ── Tier rule tables ────────────────────────────────────────
//
// Each rule is a regex matched against the trimmed command string.
// First-match-wins, evaluated in the order: never -> destructive ->
// risky_write -> safe_write -> read. (We start at "most dangerous"
// to make sure a safe-prefix can't disguise something nasty.)

interface Rule {
  re: RegExp;
  tag: string;
}

// Forbidden — we never even ask for approval.
const NEVER_RULES: Rule[] = [
  { re: /^\s*$/, tag: "empty-command" },
];

// Destructive — need explicit, per-call approval (kill-switch must be on).
const DESTRUCTIVE_RULES: Rule[] = [
  { re: /\bqm\s+(destroy|delete)\b/, tag: "qm-destroy" },
  { re: /\bpct\s+destroy\b/, tag: "pct-destroy" },
  { re: /\brm\s+(-[rRfF]+\s|--recursive\b|--force\b)/, tag: "rm-rf" },
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, tag: "rm-rf-combined" },
  { re: /\bdd\b[^\n]*\bof=/, tag: "dd-of" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, tag: "mkfs" },
  { re: /\bfdisk\b/, tag: "fdisk" },
  { re: /\bparted\b/, tag: "parted" },
  { re: /\bwipefs\b/, tag: "wipefs" },
  { re: /\biptables\s+-F\b/, tag: "iptables-flush" },
  { re: /\bfirewall-cmd\s+--reload\b/, tag: "firewall-cmd-reload" },
  // Host-level reboot/shutdown/poweroff/halt as the LEADING command. We
  // anchor at start-of-string so `qm shutdown 200` (a per-VM op handled
  // by the risky-write rules) doesn't get caught here.
  { re: /^\s*(reboot|shutdown|poweroff|halt)\b/, tag: "host-reboot" },
  { re: /\binit\s+[06]\b/, tag: "init-runlevel" },
  { re: /\/dev\/(sd[a-z]|nvme\d|vd[a-z]|xvd[a-z]|disk\d)/, tag: "block-device" },
];

// Risky write — service restarts, VM stops, kills. Reversible-ish but
// can cause real outages.
const RISKY_RULES: Rule[] = [
  { re: /\bqm\s+(stop|shutdown|reboot|reset|suspend)\b/, tag: "qm-power" },
  { re: /\bqm\s+start\b/, tag: "qm-start" }, // boots a VM — wrong VM = harm
  { re: /\bpct\s+(stop|shutdown|reboot)\b/, tag: "pct-power" },
  { re: /\bpct\s+start\b/, tag: "pct-start" },
  { re: /\bsystemctl\s+(restart|reload|stop|start|enable|disable|mask|unmask|daemon-reload)\b/, tag: "systemctl-mutate" },
  { re: /\bservice\s+\S+\s+(restart|reload|stop|start)\b/, tag: "service-mutate" },
  { re: /\bkill\s+-?\d+\b|\bkill\s+\d+\b/, tag: "kill-pid" },
  { re: /\bpkill\b/, tag: "pkill" },
  { re: /\bkillall\b/, tag: "killall" },
  { re: /\besxcli\s+(?:.*\s)?(set|add|remove)\b/, tag: "esxcli-mutate" },
  { re: /\bvim-cmd\s+vmsvc\/(power\.\w+|destroy)\b/, tag: "vim-cmd-power" },
  // ufw rule mutation — adding/removing firewall rules, reloading, or
  // toggling the firewall state. Reversible-ish but can cut off network
  // reachability of the host itself, so we treat it as risky_write.
  // The sudo-prefix variant (`sudo ufw allow ...`) is handled
  // transparently by the leading-sudo strip in `classifyCommand`.
  { re: /^\s*ufw\s+(allow|deny|delete|reload|enable|disable)\b/, tag: "ufw-mutate" },
];

// Safe write — small filesystem mutations, conventionally safe.
const SAFE_WRITE_RULES: Rule[] = [
  { re: /^\s*mkdir(\s+-p)?\s+\S/, tag: "mkdir" },
  { re: /^\s*touch\s+\S/, tag: "touch" },
  { re: /^\s*cp(\s+-[a-zA-Z]+)?\s+\S+\s+\S+/, tag: "cp" },
  { re: /^\s*chmod\s+[0-7]{3,4}\s+\S/, tag: "chmod-octal" },
  { re: /^\s*chown\s+\S+\s+\S/, tag: "chown" },
  { re: /^\s*ln\s+-s\s+\S+\s+\S+/, tag: "ln-s" },
];

// Read-only — purely informational. The bulk of agent traffic should
// be here. We pin these to anchored prefixes so a reader can't sneak
// a destructive suffix in (and the metachar gate already catches that).
const READ_RULES: Rule[] = [
  { re: /^\s*cat\s+\S/, tag: "cat" },
  { re: /^\s*ls(\s+-[a-zA-Z]+)?(\s+\S+)?\s*$/, tag: "ls" },
  { re: /^\s*head(\s+-n?\s*\d+)?\s+\S/, tag: "head" },
  { re: /^\s*tail(\s+-[nF]?\s*\d*)?\s+\S/, tag: "tail" },
  { re: /^\s*grep(\s+-[a-zA-Z]+)?\s+\S/, tag: "grep" },
  { re: /^\s*awk\s+/, tag: "awk" },
  { re: /^\s*sed\s+-n\s+/, tag: "sed-readonly" },
  { re: /^\s*find\s+\S/, tag: "find" }, // metachar gate stops -delete/-exec rm
  { re: /^\s*journalctl(\s|$)/, tag: "journalctl" },
  { re: /^\s*systemctl\s+(status|is-active|is-enabled|show|list-units|list-unit-files|cat)\b/, tag: "systemctl-read" },
  { re: /^\s*service\s+\S+\s+status\b/, tag: "service-status" },
  { re: /^\s*qm\s+(list|status|config|showcmd|listsnapshot|pending|importovf|cloudinit)\b/, tag: "qm-read" },
  { re: /^\s*pct\s+(list|status|config|listsnapshot|pending|df|fsck)\b/, tag: "pct-read" },
  { re: /^\s*pveversion\b/, tag: "pveversion" },
  { re: /^\s*pvesh\s+get\s+/, tag: "pvesh-get" },
  { re: /^\s*df(\s+-[a-zA-Z]+)?\s*$/, tag: "df" },
  { re: /^\s*free(\s+-[a-zA-Z]+)?\s*$/, tag: "free" },
  { re: /^\s*uptime\s*$/, tag: "uptime" },
  { re: /^\s*who\s*$/, tag: "who" },
  { re: /^\s*w\s*$/, tag: "w" },
  { re: /^\s*ps(\s+-[a-zA-Z]+)?\s*$/, tag: "ps" },
  { re: /^\s*ps\s+aux\s*$/, tag: "ps-aux" },
  { re: /^\s*top\s+-b\s+-n\s*1\b/, tag: "top-batch" },
  { re: /^\s*uname(\s+-[a-zA-Z]+)?\s*$/, tag: "uname" },
  { re: /^\s*hostname\s*$/, tag: "hostname" },
  { re: /^\s*id(\s+\S+)?\s*$/, tag: "id" },
  { re: /^\s*whoami\s*$/, tag: "whoami" },
  { re: /^\s*pwd\s*$/, tag: "pwd" },
  { re: /^\s*cat\s+\/proc\/\S+/, tag: "proc-read" },
  { re: /^\s*vmkfstools(\s+--?[a-zA-Z]+)?\s+\S/, tag: "vmkfstools" }, // metachar gate prevents writes
  { re: /^\s*esxcli\s+\S+\s+(?:\S+\s+)*?(list|get)\b/, tag: "esxcli-read" },
  { re: /^\s*vim-cmd\s+vmsvc\/(getallvms|get\.\w+)\b/, tag: "vim-cmd-read" },
  { re: /^\s*echo\s+/, tag: "echo" },
  { re: /^\s*true\s*$/, tag: "true" },
  { re: /^\s*date\s*$/, tag: "date" },
];

// ── Public API ──────────────────────────────────────────────

/**
 * Classify a shell command into one of the governance tiers.
 *
 * Algorithm:
 *  1. Reject empty/whitespace as "never" (fail closed on garbage).
 *  2. If the command contains a shell metacharacter or redirect,
 *     bump straight to "destructive" — we can't reason about
 *     pipelines/substitutions safely.
 *  3. Otherwise scan the rule tables, most-dangerous first, and
 *     return the first match.
 *  4. If nothing matches, default to "destructive". Operators can
 *     widen the allowlists in safety.ts to add more read-only
 *     idioms over time.
 */
export function classifyCommand(rawCommand: string): SshClassification {
  const cmd = rawCommand ?? "";
  const trimmed = cmd.trim();

  // 1. Empty / whitespace
  if (matchAny(trimmed, NEVER_RULES)) {
    return {
      tier: "never",
      reason: "Command is empty or whitespace-only.",
      match: "empty-command",
    };
  }

  // 2. Metacharacter / redirect escape hatches force destructive
  if (SHELL_ESCAPE_HATCHES.test(cmd)) {
    return {
      tier: "destructive",
      reason: "Command contains shell metacharacters (;, |, &, `, $(), <, >). Cannot statically reason about safety.",
      match: "shell-metachar",
    };
  }
  if (REDIRECT_HATCH.test(cmd)) {
    return {
      tier: "destructive",
      reason: "Command contains output redirection.",
      match: "redirect",
    };
  }

  // 2a. Strip a leading `sudo` / `sudo -n` prefix for rule-scanning
  //     purposes ONLY. This lets the same rule tables classify both
  //     `df` and `sudo -n df` as `read`, which is the contract the
  //     sudo-fallback ladder depends on (the ladder retries with
  //     `sudo -n <command>` and then re-classifies — without this
  //     strip, the read verbs in the rule tables would no longer
  //     match and the command would fall through to the
  //     fail-closed `destructive` default, blocking every legitimate
  //     escalation). Risky/destructive rules with `\b` anchors
  //     match through `sudo` already; this strip just keeps the
  //     read/safe_write anchored rules working too.
  //
  //     We do NOT recurse — only ONE `sudo` is stripped, so a
  //     pathological `sudo sudo rm -rf /` still surfaces as
  //     destructive via the un-stripped scan path below.
  const scanTarget = trimmed.replace(/^sudo(?:\s+-n)?\s+/, "");

  // 3. Most-dangerous-first scan
  const destructive = matchAny(trimmed, DESTRUCTIVE_RULES) ?? matchAny(scanTarget, DESTRUCTIVE_RULES);
  if (destructive) {
    return tieredResult("destructive", destructive, "Matches a destructive command pattern.");
  }

  const risky = matchAny(trimmed, RISKY_RULES) ?? matchAny(scanTarget, RISKY_RULES);
  if (risky) {
    return tieredResult("risky_write", risky, "Matches a risky-write command pattern (service mutation, VM power op, kill).");
  }

  const safeWrite = matchAny(trimmed, SAFE_WRITE_RULES) ?? matchAny(scanTarget, SAFE_WRITE_RULES);
  if (safeWrite) {
    return tieredResult("safe_write", safeWrite, "Matches a safe-write command pattern (small fs mutation).");
  }

  const read = matchAny(trimmed, READ_RULES) ?? matchAny(scanTarget, READ_RULES);
  if (read) {
    return tieredResult("read", read, "Matches a read-only command pattern.");
  }

  // 4. Fail closed
  return {
    tier: "destructive",
    reason: "No allowlist match — defaulting to destructive (fail-closed). Extend the read/safe_write rule tables in src/providers/ssh/safety.ts to widen.",
    match: "default-fail-closed",
  };
}

// ── Tier overrides ──────────────────────────────────────────

/**
 * Total ordering on action tiers, low → high risk. `never` is its own
 * top: a `never` classification can never be overridden (we always
 * fail closed on garbage / forbidden input).
 */
const TIER_RANK: Record<ActionTier, number> = {
  read: 0,
  safe_write: 1,
  risky_write: 2,
  destructive: 3,
  never: 99,
};

function rank(t: ActionTier): number {
  return TIER_RANK[t];
}

/**
 * Apply per-target tier overrides to a base classification.
 *
 * Rules:
 *   - `never` is never lowered (forbidden inputs stay forbidden).
 *   - `commands` map is checked first; key match is by the
 *     classifier `match` tag OR the trimmed command text. The
 *     override is applied verbatim — it can raise OR lower the tier
 *     (a sandbox host can downgrade `systemctl restart nginx` to
 *     safe_write, a fragile prod host can upgrade `ls` to risky_write).
 *   - Otherwise, `default` acts as a floor: if the base tier is
 *     strictly less risky than `default`, bump up to `default`.
 *     `default` never lowers a tier.
 *   - When the tier changes, the result carries `base_tier` and
 *     `override` so audit logs can show what fired.
 */
export function applyTierOverrides(
  classification: SshClassification,
  command: string,
  overrides: SshTierOverrides | undefined,
): SshClassification {
  if (!overrides) return classification;
  if (classification.tier === "never") return classification;

  const trimmed = command.trim();
  const cmdMap = overrides.commands ?? {};
  const matchKey = classification.match;

  // Per-command override — exact tag, then exact command text.
  const direct =
    (matchKey && Object.prototype.hasOwnProperty.call(cmdMap, matchKey)
      ? { tier: cmdMap[matchKey]!, key: matchKey }
      : undefined) ??
    (Object.prototype.hasOwnProperty.call(cmdMap, trimmed)
      ? { tier: cmdMap[trimmed]!, key: trimmed }
      : undefined);

  if (direct && direct.tier !== classification.tier) {
    return {
      ...classification,
      tier: direct.tier,
      base_tier: classification.tier,
      override: direct.key,
      reason: `${classification.reason} (per-target override "${direct.key}" → ${direct.tier})`,
    };
  }
  if (direct) {
    // Override matched but is a no-op for this tier; still record it
    // so audit can see that an explicit allowlist fired.
    return { ...classification, override: direct.key };
  }

  // Floor — only bumps tier UP, never down.
  if (overrides.default && rank(overrides.default) > rank(classification.tier)) {
    return {
      ...classification,
      tier: overrides.default,
      base_tier: classification.tier,
      override: "default",
      reason: `${classification.reason} (per-target floor → ${overrides.default})`,
    };
  }

  return classification;
}

// ── Helpers ─────────────────────────────────────────────────

function matchAny(command: string, rules: Rule[]): string | null {
  for (const rule of rules) {
    if (rule.re.test(command)) return rule.tag;
  }
  return null;
}

function tieredResult(tier: ActionTier, tag: string, reason: string): SshClassification {
  return { tier, reason, match: tag };
}
