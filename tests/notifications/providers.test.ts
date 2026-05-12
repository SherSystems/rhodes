// ============================================================
// RHODES — Notification provider tests
// Each provider is exercised with a mocked fetch so no real
// network call ever leaves the test sandbox.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoneProvider } from "../../src/notifications/providers/none.js";
import { SupraProvider } from "../../src/notifications/providers/supra.js";
import { TelegramDirectProvider } from "../../src/notifications/providers/telegram-direct.js";
import type { Alert } from "../../src/notifications/types.js";

function alert(overrides?: Partial<Alert>): Alert {
  return {
    title: "RHODES test alert",
    body: "RHODES — test alert\nLine two",
    kind: "event",
    timestamp: "2026-05-12T00:00:00Z",
    context: { test: true },
    ...overrides,
  };
}

describe("NoneProvider", () => {
  it("returns delivered=true and logs to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await new NoneProvider().send(alert());
    expect(result).toEqual({ delivered: true, provider: "none" });
    // It logged at least the title line.
    expect(spy.mock.calls.some((c) => String(c[0]).includes("RHODES test alert"))).toBe(true);
  });
});

describe("SupraProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("POSTs to ${url}/api/chat with message + userId", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" });
    const supra = new SupraProvider({
      url: "http://localhost:3100",
      userId: "rhodes-bot",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await supra.send(alert({ body: "hello" }));
    expect(result.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3100/api/chat");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.message).toBe("hello");
    expect(body.userId).toBe("rhodes-bot");
    expect(body.metadata.source).toBe("rhodes");
    expect(body.metadata.kind).toBe("event");
  });

  it("trims trailing slash on SUPRA_URL", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
    const supra = new SupraProvider({
      url: "http://localhost:3100/",
      userId: "rhodes-bot",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await supra.send(alert());
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3100/api/chat");
  });

  it("reports delivery failure on non-2xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "boom" });
    const supra = new SupraProvider({
      url: "http://localhost:3100",
      userId: "rhodes-bot",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await supra.send(alert());
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("503");
  });

  it("survives a thrown fetch and reports the error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const supra = new SupraProvider({
      url: "http://localhost:3100",
      userId: "rhodes-bot",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await supra.send(alert());
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("TelegramDirectProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID", () => {
    expect(
      () => new TelegramDirectProvider({ botToken: "", chatId: "abc", fetchImpl: fetchMock as unknown as typeof fetch }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(
      () => new TelegramDirectProvider({ botToken: "abc", chatId: "", fetchImpl: fetchMock as unknown as typeof fetch }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("POSTs to bot${token}/sendMessage with Markdown parse_mode", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "",
    });
    const tg = new TelegramDirectProvider({
      botToken: "TOKEN",
      chatId: "12345",
      apiBase: "https://api.telegram.test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await tg.send(alert());
    expect(result.delivered).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.test/botTOKEN/sendMessage");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe("12345");
    expect(body.parse_mode).toBe("Markdown");
    expect(typeof body.text).toBe("string");
    expect(body.text).toContain("RHODES");
  });

  it("falls back to plain text if Markdown parse fails", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "can't parse entities — bad markdown",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      });
    const tg = new TelegramDirectProvider({
      botToken: "TOKEN",
      chatId: "12345",
      apiBase: "https://api.telegram.test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await tg.send(alert());
    expect(result.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1];
    const secondBody = JSON.parse((secondCall[1] as { body: string }).body);
    expect(secondBody.parse_mode).toBeUndefined();
  });

  it("reports failure on non-parse error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" });
    const tg = new TelegramDirectProvider({
      botToken: "TOKEN",
      chatId: "12345",
      apiBase: "https://api.telegram.test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await tg.send(alert());
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("401");
    // Only one attempt — not a parse error, no fallback.
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
