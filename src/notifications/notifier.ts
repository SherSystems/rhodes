// ============================================================
// RHODES — Notifications: top-level Notifier facade
// Provides a single `notify()` surface for the rest of the codebase
// so we can wire it into autopilot/incident hooks without leaking
// provider details.
//
// The *primary* provider is chosen via `RHODES_ALERT_PROVIDER` env
// var (none | supra | telegram_direct | slack). For RHODES v0.5.0+
// the Notifier ALSO publishes to Slack when configured, regardless
// of what the primary is — so an operator running with
//   RHODES_ALERT_PROVIDER=supra       (personal heartbeat via Supra)
//   RHODES_SLACK_BOT_TOKEN=xoxb-...   (team approvals via Slack)
// gets both: Pranav's Telegram-bridged feed AND the team's Slack
// channel with interactive approval buttons. Slack is the operational
// control surface; the primary provider is the founder's heartbeat.
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "./types.js";
import { NoneProvider } from "./providers/none.js";
import { SupraProvider } from "./providers/supra.js";
import { TelegramDirectProvider } from "./providers/telegram-direct.js";
import { SlackProvider } from "./providers/slack.js";

export interface NotifierOptions {
  /** Primary heartbeat provider — the operator's personal channel. */
  provider: "none" | "supra" | "telegram_direct" | "slack";
  supra?: { url: string; userId: string };
  telegram?: { botToken: string; chatId: string };
  /**
   * Slack configuration. When provided, Slack is published to in
   * ADDITION to the primary provider (unless the primary is already
   * `slack`, in which case Slack is only attached once).
   */
  slack?: {
    botToken: string;
    defaultChannel: string;
    channelByKind?: Partial<Record<string, string>>;
    dashboardUrl?: string;
  };
  /** Inject a fake fetch in tests. */
  fetchImpl?: typeof fetch;
}

export interface NotifierStatus {
  provider: string;
  /** All providers currently attached (primary + slack-as-secondary if any). */
  providers: string[];
  lastAlert: {
    title: string;
    kind: string;
    timestamp: string;
    delivered: boolean;
  } | null;
}

export class Notifier {
  readonly provider: AlertProvider;
  /** All providers — `provider` is the primary, `secondary` may include slack. */
  private readonly secondary: AlertProvider[];
  private lastAlert: NotifierStatus["lastAlert"] = null;

  constructor(options: NotifierOptions) {
    this.provider = this.buildPrimary(options);
    this.secondary = this.buildSecondary(options);
  }

  private buildPrimary(options: NotifierOptions): AlertProvider {
    switch (options.provider) {
      case "supra": {
        if (!options.supra?.url) {
          console.warn(
            "[notify] RHODES_ALERT_PROVIDER=supra but SUPRA_URL is empty — falling back to 'none'.",
          );
          return new NoneProvider();
        }
        return new SupraProvider({
          url: options.supra.url,
          userId: options.supra.userId,
          fetchImpl: options.fetchImpl,
        });
      }
      case "telegram_direct": {
        if (!options.telegram?.botToken || !options.telegram?.chatId) {
          console.warn(
            "[notify] RHODES_ALERT_PROVIDER=telegram_direct but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — falling back to 'none'.",
          );
          return new NoneProvider();
        }
        return new TelegramDirectProvider({
          botToken: options.telegram.botToken,
          chatId: options.telegram.chatId,
          fetchImpl: options.fetchImpl,
        });
      }
      case "slack": {
        if (!options.slack?.botToken || !options.slack?.defaultChannel) {
          console.warn(
            "[notify] RHODES_ALERT_PROVIDER=slack but RHODES_SLACK_BOT_TOKEN / RHODES_SLACK_DEFAULT_CHANNEL missing — falling back to 'none'.",
          );
          return new NoneProvider();
        }
        return new SlackProvider({
          botToken: options.slack.botToken,
          defaultChannel: options.slack.defaultChannel,
          channelByKind: options.slack.channelByKind,
          dashboardUrl: options.slack.dashboardUrl,
          fetchImpl: options.fetchImpl,
        });
      }
      case "none":
      default:
        return new NoneProvider();
    }
  }

  private buildSecondary(options: NotifierOptions): AlertProvider[] {
    const secondary: AlertProvider[] = [];

    // Slack as a secondary channel — attach when configured AND not
    // already the primary.
    if (
      options.provider !== "slack" &&
      options.slack?.botToken &&
      options.slack?.defaultChannel
    ) {
      secondary.push(
        new SlackProvider({
          botToken: options.slack.botToken,
          defaultChannel: options.slack.defaultChannel,
          channelByKind: options.slack.channelByKind,
          dashboardUrl: options.slack.dashboardUrl,
          fetchImpl: options.fetchImpl,
        }),
      );
    }

    return secondary;
  }

  /**
   * Send an alert. Never throws — delivery failures are returned in the
   * result and logged. Alert delivery must never crash the autopilot.
   *
   * Multi-provider behaviour: returns the PRIMARY provider's result.
   * Secondary providers fire in parallel (fire-and-forget from the
   * caller's perspective — their outcomes are logged but don't bubble
   * up since the primary is the operator's signal).
   */
  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    const ts = alert.timestamp ?? new Date().toISOString();
    const stamped: Alert = { ...alert, timestamp: ts };

    // Kick off secondary delivery in parallel — never await the result
    // path for the primary's outcome, but DO catch + log so it doesn't
    // leak as an unhandled rejection.
    for (const sec of this.secondary) {
      void sec
        .send(stamped)
        .then((r) => {
          if (!r.delivered) {
            console.warn(`[notify] secondary ${r.provider} failed: ${r.error ?? "unknown"}`);
          }
        })
        .catch((err) => {
          console.warn(
            `[notify] secondary threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    let result: NotificationDeliveryResult;
    try {
      result = await this.provider.send(stamped);
    } catch (err) {
      result = {
        delivered: false,
        provider: this.provider.id,
        error: `Notifier caught exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.lastAlert = {
      title: alert.title,
      kind: alert.kind,
      timestamp: ts,
      delivered: result.delivered,
    };
    if (!result.delivered) {
      console.warn(
        `[notify] delivery failed via ${result.provider}: ${result.error ?? "unknown error"}`,
      );
    }
    return result;
  }

  getStatus(): NotifierStatus {
    return {
      provider: this.provider.id,
      providers: [this.provider.id, ...this.secondary.map((p) => p.id)],
      lastAlert: this.lastAlert,
    };
  }
}
