// ============================================================
// RHODES — Notifications: SupraProvider
// Sends alerts to a local Supra agent at SUPRA_URL/api/chat. The
// agent's `notify` skill picks the request up and hits Telegram on
// its own. We don't talk to Telegram directly here.
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "../types.js";

export interface SupraProviderOptions {
  /** Base URL of the Supra HTTP API (no trailing slash). */
  url: string;
  /** Logical sender id Supra uses to attribute the message. */
  userId: string;
  /**
   * Override for `fetch`. Always inject in tests so we never accidentally
   * hit a real Supra instance.
   */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export class SupraProvider implements AlertProvider {
  readonly id = "supra";
  private readonly url: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SupraProviderOptions) {
    // Trim trailing slash so callers can pass either form.
    this.url = options.url.replace(/\/+$/, "");
    this.userId = options.userId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    const endpoint = `${this.url}/api/chat`;
    // Supra's planner reads `message` directly; carrying the structured
    // alert in a separate field lets the notify skill key off `kind`
    // and `context` without re-parsing the body string.
    const payload = {
      message: alert.body,
      userId: this.userId,
      metadata: {
        source: "rhodes",
        kind: alert.kind,
        title: alert.title,
        timestamp: alert.timestamp ?? new Date().toISOString(),
        context: alert.context ?? {},
        link: alert.link,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await safeText(res);
        return {
          delivered: false,
          provider: this.id,
          error: `Supra responded ${res.status}: ${text.slice(0, 256)}`,
        };
      }
      const data = await safeJson(res);
      return { delivered: true, provider: this.id, response: data };
    } catch (err) {
      return {
        delivered: false,
        provider: this.id,
        error: `Supra request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
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
