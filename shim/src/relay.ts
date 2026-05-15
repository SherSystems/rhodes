// ============================================================
// RHODES Slack Shim — tailnet relay
//
// POSTs a raw body to a tailnet URL with the headers Slack
// included on the original request. Translates upstream
// failures into HTTP status codes the shim returns to Slack
// (504 for timeout, 502 for connection refused, etc.).
//
// Uses the global `fetch` (Node 22 builtin — undici under the
// hood) so we don't pull in any deps.
// ============================================================

export interface RelayInput {
  /** Fully-qualified tailnet URL — e.g. `http://homelab.tailc0269a.ts.net:7412/api/integrations/slack/command` */
  url: string;
  /** Raw request body (string). Already verified before this call. */
  rawBody: string;
  /** Content type from the original Slack request. */
  contentType: string;
  /**
   * Extra headers to forward. Caller decides what to pass — typically
   * `x-slack-request-timestamp`, `x-slack-signature`, and any trace ids.
   */
  forwardHeaders?: Record<string, string>;
  /** Timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface RelayResult {
  status: number;
  body: string;
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Relay a signed Slack request body to a tailnet URL.
 *
 * Returns the upstream status + body verbatim for happy paths. For
 * network-level failures, synthesises a status the shim can return
 * to Slack: 504 on timeout, 502 on connection failure, 500 for
 * unexpected errors. Never throws.
 */
export async function relayToRhodes(input: RelayInput): Promise<RelayResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = {
    "content-type": input.contentType,
    ...(input.forwardHeaders ?? {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(input.url, {
      method: "POST",
      headers,
      body: input.rawBody,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return classifyRelayError(err);
  }
  clearTimeout(timer);

  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }

  return {
    status: res.status,
    body,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

function classifyRelayError(err: unknown): RelayResult {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const causeCode =
    err instanceof Error && err.cause && typeof err.cause === "object" && "code" in err.cause
      ? String((err.cause as { code?: unknown }).code ?? "")
      : "";

  // AbortError fires on our own AbortController timeout.
  if (name === "AbortError") {
    return {
      status: 504,
      body: JSON.stringify({ ok: false, error: "upstream_timeout" }),
      contentType: "application/json",
    };
  }

  // undici surfaces connection failures as TypeError("fetch failed")
  // with `cause.code` carrying the real reason — ECONNREFUSED,
  // ENOTFOUND, EHOSTUNREACH, ETIMEDOUT, etc.
  if (
    causeCode === "ECONNREFUSED" ||
    causeCode === "ENOTFOUND" ||
    causeCode === "EHOSTUNREACH" ||
    causeCode === "ENETUNREACH"
  ) {
    return {
      status: 502,
      body: JSON.stringify({ ok: false, error: "upstream_unreachable", code: causeCode }),
      contentType: "application/json",
    };
  }

  if (causeCode === "ETIMEDOUT" || causeCode === "UND_ERR_HEADERS_TIMEOUT" || causeCode === "UND_ERR_BODY_TIMEOUT") {
    return {
      status: 504,
      body: JSON.stringify({ ok: false, error: "upstream_timeout", code: causeCode }),
      contentType: "application/json",
    };
  }

  return {
    status: 500,
    body: JSON.stringify({ ok: false, error: "relay_failed", detail: message.slice(0, 256) }),
    contentType: "application/json",
  };
}
