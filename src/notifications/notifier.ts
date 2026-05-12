// ============================================================
// RHODES — Notifications: top-level Notifier facade
// Provides a single `notify()` surface for the rest of the codebase
// so we can wire it into autopilot/incident hooks without leaking
// provider details. The actual delivery target is chosen via
// `RHODES_ALERT_PROVIDER` env var (none | supra | telegram_direct).
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "./types.js";
import { NoneProvider } from "./providers/none.js";
import { SupraProvider } from "./providers/supra.js";
import { TelegramDirectProvider } from "./providers/telegram-direct.js";

export interface NotifierOptions {
  provider: "none" | "supra" | "telegram_direct";
  supra?: { url: string; userId: string };
  telegram?: { botToken: string; chatId: string };
  /** Inject a fake fetch in tests. */
  fetchImpl?: typeof fetch;
}

export interface NotifierStatus {
  provider: string;
  lastAlert: {
    title: string;
    kind: string;
    timestamp: string;
    delivered: boolean;
  } | null;
}

export class Notifier {
  readonly provider: AlertProvider;
  private lastAlert: NotifierStatus["lastAlert"] = null;

  constructor(options: NotifierOptions) {
    this.provider = this.buildProvider(options);
  }

  private buildProvider(options: NotifierOptions): AlertProvider {
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
      case "none":
      default:
        return new NoneProvider();
    }
  }

  /**
   * Send an alert. Never throws — delivery failures are returned in the
   * result and logged. Alert delivery must never crash the autopilot.
   */
  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    const ts = alert.timestamp ?? new Date().toISOString();
    let result: NotificationDeliveryResult;
    try {
      result = await this.provider.send({ ...alert, timestamp: ts });
    } catch (err) {
      // Defensive: providers shouldn't throw, but if they do we still
      // want the caller to keep going.
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
    return { provider: this.provider.id, lastAlert: this.lastAlert };
  }
}
