// ============================================================
// RHODES — Notifications: SlackProvider
//
// Posts alerts to Slack via the Web API (`chat.postMessage`). Unlike
// Supra/Telegram which are *push-only* heartbeat channels for the
// founder, Slack is the team-facing control surface — approval-needed
// alerts include interactive Block Kit buttons that round-trip back
// through the shim service to `/api/agent/approve` and
// `/api/agent/command`.
//
// This provider only handles *outbound*. Inbound signature
// verification + payload parsing lives in `src/frontends/dashboard/
// slack-routes.ts`, and the public-facing edge that receives Slack's
// callbacks runs in the separate `shim/` service so RHODES itself
// stays tailnet-only.
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "../types.js";

export interface SlackProviderOptions {
  /** Bot User OAuth Token starting `xoxb-`. */
  botToken: string;
  /** Default channel id (e.g. `C0123ABCD`) for alerts. Per-alert overrides can be passed via `alert.context.slack_channel`. */
  defaultChannel: string;
  /** Optional channel routing — e.g. {approval_needed: "C0...A", incident: "C0...B"}. Falls back to defaultChannel. */
  channelByKind?: Partial<Record<string, string>>;
  /** Optional dashboard base URL — used to construct approval deep-links in Block Kit messages. */
  dashboardUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const SLACK_API_BASE = "https://slack.com/api";

export class SlackProvider implements AlertProvider {
  readonly id = "slack";
  private readonly botToken: string;
  private readonly defaultChannel: string;
  private readonly channelByKind: Partial<Record<string, string>>;
  private readonly dashboardUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SlackProviderOptions) {
    if (!options.botToken.startsWith("xoxb-")) {
      throw new Error("SlackProvider: botToken must start with 'xoxb-' (got a different shape)");
    }
    this.botToken = options.botToken;
    this.defaultChannel = options.defaultChannel;
    this.channelByKind = options.channelByKind ?? {};
    this.dashboardUrl = options.dashboardUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Alert kinds that get published to the Slack team channel. Anything
   * else (especially `execution_complete` per-step success spam) is
   * silently dropped — Slack is the team's *actionable* surface, not a
   * raw event firehose. The primary provider (Supra → Telegram for the
   * founder's heartbeat) still receives all kinds.
   */
  private static readonly TEAM_CHANNEL_KINDS: ReadonlySet<string> = new Set([
    "approval_needed",
    "plan_generated",
    "execution_failed",
    "health_check_failed",
    "ticket_opened",
    "ticket_resolved",
    "ticket_closed",
  ]);

  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    // Team-channel filter — drop step-by-step success spam (still
    // logged to console + audited via the event bus; just not Slack).
    if (!SlackProvider.TEAM_CHANNEL_KINDS.has(alert.kind)) {
      return {
        delivered: true,
        provider: this.id,
        response: { suppressed: true, reason: `kind '${alert.kind}' not in team-channel allowlist` },
      };
    }

    const channel = this.resolveChannel(alert);
    const blocks = this.buildBlocks(alert);
    const fallbackText = alert.title;

    const payload = {
      channel,
      text: fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${SLACK_API_BASE}/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      return {
        delivered: false,
        provider: this.id,
        error: `Slack request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await safeText(res);
      return {
        delivered: false,
        provider: this.id,
        error: `Slack chat.postMessage HTTP ${res.status}: ${text.slice(0, 256)}`,
      };
    }

    // Slack returns 200 OK even on error — check the `ok` field in the body.
    const body = (await safeJson(res)) as { ok?: boolean; error?: string; ts?: string; channel?: string } | undefined;
    if (!body || body.ok !== true) {
      return {
        delivered: false,
        provider: this.id,
        error: `Slack chat.postMessage rejected: ${body?.error ?? "unknown"}`,
      };
    }

    console.log(`[notify] dispatched via slack (channel=${body.channel ?? channel} ts=${body.ts})`);
    return {
      delivered: true,
      provider: this.id,
      response: { channel: body.channel, ts: body.ts },
    };
  }

  // ── Channel routing ──────────────────────────────────────────────

  private resolveChannel(alert: Alert): string {
    // Per-alert override (highest priority)
    const override = alert.context?.["slack_channel"];
    if (typeof override === "string" && override.length > 0) return override;

    // Per-kind override
    const byKind = this.channelByKind[alert.kind];
    if (byKind) return byKind;

    return this.defaultChannel;
  }

  // ── Block Kit construction ───────────────────────────────────────
  //
  // Goal: every alert gets a Block Kit rendering rather than a plain
  // text dump. For `approval_needed` we attach interactive buttons
  // that the shim service catches and relays back into RHODES.

  private buildBlocks(alert: Alert): unknown[] {
    switch (alert.kind) {
      case "approval_needed":
        return this.approvalNeededBlocks(alert);
      case "plan_generated":
        return this.planGeneratedBlocks(alert);
      case "execution_complete":
        return this.executionBlocks(alert, "ok");
      case "execution_failed":
        return this.executionBlocks(alert, "fail");
      case "health_check_failed":
        return this.healthFailedBlocks(alert);
      case "ticket_opened":
        return this.ticketOpenedBlocks(alert);
      case "event":
      default:
        return this.eventBlocks(alert);
    }
  }

  private ticketOpenedBlocks(alert: Alert): unknown[] {
    const ticketId = (alert.context?.["ticket_id"] as string | undefined) ?? "";
    const severity = (alert.context?.["severity"] as string | undefined) ?? "warning";
    const labels =
      (alert.context?.["labels"] as Record<string, string> | undefined) ?? {};

    const sevEmoji = severity === "critical" ? ":rotating_light:" : ":warning:";
    const labelFields = Object.entries(labels)
      .slice(0, 6)
      .map(([k, v]) => ({
        type: "mrkdwn",
        text: `*${escapeMrkdwn(k)}*\n${escapeMrkdwn(String(v))}`,
      }));

    const blocks: unknown[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${ticketId || "RHODES ticket"} — ${alert.title}`.slice(0, 150),
          emoji: false,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${sevEmoji} *${escapeMrkdwn(severity.toUpperCase())}*\n${escapeMrkdwn(truncate(alert.body, 1500))}`,
        },
      },
    ];

    if (labelFields.length > 0) {
      blocks.push({ type: "section", fields: labelFields });
    }

    if (this.dashboardUrl && ticketId) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View ticket", emoji: false },
            action_id: "rhodes_view_ticket",
            url: this.buildTicketUrl(ticketId),
          },
        ],
      });
    }

    return blocks;
  }

  private buildTicketUrl(ticketId: string): string {
    if (!this.dashboardUrl) return "";
    const base = this.dashboardUrl.replace(/\/+$/, "");
    return `${base}/?ticket=${encodeURIComponent(ticketId)}`;
  }

  private approvalNeededBlocks(alert: Alert): unknown[] {
    const planId = (alert.context?.["plan_id"] as string | undefined) ?? "";
    const stepId = (alert.context?.["step_id"] as string | undefined) ?? "";
    const tier = (alert.context?.["tier"] as string | undefined) ?? "unknown";
    const action = (alert.context?.["action"] as string | undefined) ?? "(no action label)";
    const reasoning = (alert.context?.["reasoning"] as string | undefined) ?? "";

    const valuePayload = JSON.stringify({ plan_id: planId, step_id: stepId || undefined });

    const blocks: unknown[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "RHODES — approval needed", emoji: false },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Action*\n\`${escapeMrkdwn(action)}\`` },
          { type: "mrkdwn", text: `*Tier*\n${escapeMrkdwn(tier)}` },
        ],
      },
    ];

    if (reasoning.trim().length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Reasoning*\n${escapeMrkdwn(truncate(reasoning, 1500))}` },
      });
    }

    // Interactive buttons — `action_id` distinguishes approve vs reject
    // server-side; `value` carries the plan/step ids encoded for the
    // shim to forward.
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: false },
          action_id: "rhodes_approve",
          value: valuePayload,
          confirm: {
            title: { type: "plain_text", text: "Confirm approval" },
            text: { type: "mrkdwn", text: `Approve this *${escapeMrkdwn(tier)}* action?\n\`${escapeMrkdwn(action)}\`` },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Reject", emoji: false },
          action_id: "rhodes_reject",
          value: valuePayload,
        },
        ...(this.dashboardUrl && planId
          ? [
              {
                type: "button",
                text: { type: "plain_text", text: "Open in dashboard", emoji: false },
                action_id: "rhodes_dashboard_link",
                url: this.buildDashboardUrl(planId, stepId),
              },
            ]
          : []),
      ],
    });

    return blocks;
  }

  private planGeneratedBlocks(alert: Alert): unknown[] {
    const planId = (alert.context?.["plan_id"] as string | undefined) ?? "";
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Plan generated*\n${escapeMrkdwn(alert.body)}` },
      },
      ...(this.dashboardUrl && planId
        ? [
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `<${this.buildDashboardUrl(planId)}|Open in dashboard>` },
              ],
            },
          ]
        : []),
    ];
  }

  private executionBlocks(alert: Alert, outcome: "ok" | "fail"): unknown[] {
    const emoji = outcome === "ok" ? ":white_check_mark:" : ":x:";
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${emoji} *${escapeMrkdwn(alert.title)}*` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: escapeMrkdwn(truncate(alert.body, 2500)) },
      },
    ];
  }

  private healthFailedBlocks(alert: Alert): unknown[] {
    return [
      {
        type: "header",
        text: { type: "plain_text", text: `:warning: ${alert.title}`.slice(0, 150), emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: escapeMrkdwn(truncate(alert.body, 2500)) },
      },
    ];
  }

  private eventBlocks(alert: Alert): unknown[] {
    const blocks: unknown[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeMrkdwn(alert.title)}*\n${escapeMrkdwn(truncate(alert.body, 2500))}` },
      },
    ];
    if (alert.link) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `<${alert.link}|Open>` }],
      });
    }
    return blocks;
  }

  private buildDashboardUrl(planId: string, stepId?: string): string {
    if (!this.dashboardUrl) return "";
    const base = this.dashboardUrl.replace(/\/+$/, "");
    const stepSuffix = stepId ? `&step=${encodeURIComponent(stepId)}` : "";
    return `${base}/?plan=${encodeURIComponent(planId)}${stepSuffix}`;
  }
}

// ── helpers ───────────────────────────────────────────────────────

function escapeMrkdwn(s: string): string {
  // Slack mrkdwn uses & < > as control characters in user-visible text;
  // escape per the docs. Other characters (*, _, ~) we let through so
  // explicit formatting works.
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
