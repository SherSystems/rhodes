// ============================================================
// RHODES — Notifications: TelegramDirectProvider
// Posts directly to the Telegram Bot API. Used when Supra isn't
// running or when you want the simplest possible delivery path.
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "../types.js";

export interface TelegramDirectProviderOptions {
  botToken: string;
  chatId: string;
  /** Override for `fetch`. Always inject in tests. */
  fetchImpl?: typeof fetch;
  /** Override the API host (used in tests). Defaults to api.telegram.org. */
  apiBase?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export class TelegramDirectProvider implements AlertProvider {
  readonly id = "telegram_direct";
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(options: TelegramDirectProviderOptions) {
    if (!options.botToken) {
      throw new Error("TelegramDirectProvider requires TELEGRAM_BOT_TOKEN");
    }
    if (!options.chatId) {
      throw new Error("TelegramDirectProvider requires TELEGRAM_CHAT_ID");
    }
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiBase = (options.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    // Telegram's body has a 4096-char ceiling; trim aggressively so a
    // huge dump doesn't fail an alert that would otherwise have delivered.
    const text = `*${escapeMarkdown(alert.title)}*\n${alert.body}`.slice(0, 3800);

    // First attempt with Markdown parse_mode. If Telegram returns 400
    // (bad parse), retry once with plain text — alert content still gets
    // through, just without formatting.
    const markdownAttempt = await this.post(text, "Markdown");
    if (markdownAttempt.delivered) return markdownAttempt;
    if (markdownAttempt.error && /parse|markdown|entit/i.test(markdownAttempt.error)) {
      const plain = `${alert.title}\n${alert.body}`.slice(0, 3800);
      const fallback = await this.post(plain, undefined);
      if (fallback.delivered) {
        return { ...fallback, response: { ...((fallback.response as object) ?? {}), parse_mode_fallback: true } };
      }
      return fallback;
    }
    return markdownAttempt;
  }

  private async post(
    text: string,
    parseMode: "Markdown" | undefined,
  ): Promise<NotificationDeliveryResult> {
    const endpoint = `${this.apiBase}/bot${this.botToken}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: this.chatId, text };
    if (parseMode) body.parse_mode = parseMode;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await safeText(res);
        return {
          delivered: false,
          provider: this.id,
          error: `Telegram responded ${res.status}: ${errText.slice(0, 256)}`,
        };
      }
      const data = (await safeJson(res)) as { ok?: boolean; description?: string } | undefined;
      if (data && data.ok === false) {
        return {
          delivered: false,
          provider: this.id,
          error: `Telegram ok=false: ${data.description ?? "unknown"}`,
        };
      }
      return { delivered: true, provider: this.id, response: data };
    } catch (err) {
      return {
        delivered: false,
        provider: this.id,
        error: `Telegram request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Minimal Markdown-V1 escape. Telegram's Markdown is opinionated — we
 * only escape characters that commonly break titles (asterisks, brackets,
 * underscores, backticks) so we don't accidentally interpret an action
 * name as bold/italic syntax.
 */
function escapeMarkdown(s: string): string {
  return s.replace(/([*_`\[\]])/g, "\\$1");
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
