// ============================================================
// RHODES — Ticket route handlers + SSE/Slack glue
//
// All ticket-mode HTTP endpoints and the supporting wiring
// live here so `server.ts` stays a thin dispatcher. The
// public-facing routes are:
//
//   GET    /api/tickets
//   GET    /api/tickets/:ticket_id
//   POST   /api/tickets/:ticket_id/comments
//   POST   /api/tickets/:ticket_id/close
//   PATCH  /api/tickets/:ticket_id/postmortem
//   POST   /api/tickets/:ticket_id/regenerate-postmortem
//
// Plus three system-facing exports:
//
//   - createTicketRouter(ctx) → { dispatch(req,res,path) }
//   - onTicketOpened — fired by IncidentCoordinator when a new
//     Ticket is allocated; posts the Block Kit alert + binds
//     the resulting `thread_ts` on the ticket
//   - onTicketResolved — fired when an incident resolves; runs
//     the LLM postmortem generator and stores the result
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Incident } from "../../healing/incidents.js";
import type {
  TicketStore,
  TicketRecord,
  TicketStatus,
  TicketComment,
} from "../../healing/ticket-store.js";
import {
  parseTicketId,
} from "../../healing/ticket-ids.js";
import {
  generatePostmortem,
  type PostmortemResult,
} from "../../healing/postmortem.js";
import type { AIConfig } from "../../agent/llm.js";
import type { EventBus } from "../../agent/events.js";
import type { IncidentManager } from "../../healing/incidents.js";
import type { Notifier } from "../../notifications/notifier.js";
import { AgentEventType } from "../../types.js";

export interface TicketRouterContext {
  store: TicketStore;
  incidents: IncidentManager;
  eventBus: EventBus;
  /** Returns true if the caller's session has admin role. The route
   *  body itself relies on the outer `requireAdmin` middleware in
   *  server.ts; this hook is provided for the legacy callsites that
   *  bypassed the gate. */
  isAdmin?: (req: IncomingMessage) => boolean;
  /** AIConfig for the postmortem generator. Optional — when absent,
   *  the regenerate route returns 503. */
  aiConfig?: AIConfig;
  /** Optional notifier — used by the open hook to post Slack alerts.
   *  Without it, tickets still open but no Slack thread is bound. */
  notifier?: Notifier;
  /** Postmortem timeout override in ms. Defaults to `aiConfig.planTimeoutMs`. */
  postmortemTimeoutMs?: number;
}

export interface TicketRouter {
  /** Attempt to dispatch the request as a /api/tickets/* route.
   *  Returns `true` if handled, `false` if the path isn't ours. */
  dispatch(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  /** Hook fired by the IncidentCoordinator when a new Ticket is
   *  allocated. Posts the Slack alert and binds thread_ts. */
  onTicketOpened(ticket: TicketRecord, incident: Incident): Promise<void>;
  /** Hook fired when an incident resolves. Runs LLM postmortem
   *  generation and stores the text. */
  onTicketResolved(ticket: TicketRecord, incident: Incident): Promise<void>;
  /** Append a Slack thread-reply as a ticket comment. Wired from the
   *  slack-routes event handler. */
  appendSlackThreadComment(
    threadTs: string,
    text: string,
    slackUserId: string,
  ): TicketComment | undefined;
  /** Direct read of a ticket joined with its Incident. Used by
   *  slack-routes for `/rhodes ticket <id>`. */
  getTicket(ticketId: string): { ticket: TicketRecord; incident: Incident | undefined } | undefined;
  /** Direct list of open tickets, used by `/rhodes tickets`. */
  listTickets(status?: TicketStatus): Array<{ ticket: TicketRecord; incident: Incident | undefined }>;
}

export function createTicketRouter(ctx: TicketRouterContext): TicketRouter {
  return new TicketRouterImpl(ctx);
}

class TicketRouterImpl implements TicketRouter {
  constructor(private readonly ctx: TicketRouterContext) {}

  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean> {
    if (!path.startsWith("/api/tickets")) return false;

    // /api/tickets  → list
    if (path === "/api/tickets") {
      if (req.method !== "GET") {
        return this.method405(res);
      }
      const url = new URL(req.url || "/", "http://localhost");
      this.handleList(res, url);
      return true;
    }

    // /api/tickets/:id[/sub]
    const rest = path.replace(/^\/api\/tickets\//, "");
    if (rest.length === 0) {
      return this.notFound(res);
    }

    const segments = rest.split("/");
    const ticketId = segments[0];
    const action = segments[1];

    if (!ticketId) return this.notFound(res);
    if (!parseTicketId(ticketId)) {
      return this.badRequest(res, "invalid_ticket_id");
    }

    if (segments.length === 1) {
      if (req.method !== "GET") return this.method405(res);
      this.handleGetOne(res, ticketId);
      return true;
    }

    switch (action) {
      case "comments":
        if (req.method !== "POST") return this.method405(res);
        await this.handlePostComment(req, res, ticketId);
        return true;
      case "close":
        if (req.method !== "POST") return this.method405(res);
        await this.handleClose(req, res, ticketId);
        return true;
      case "postmortem":
        if (req.method !== "PATCH") return this.method405(res);
        await this.handlePatchPostmortem(req, res, ticketId);
        return true;
      case "regenerate-postmortem":
        if (req.method !== "POST") return this.method405(res);
        this.handleRegeneratePostmortem(res, ticketId);
        return true;
      default:
        return this.notFound(res);
    }
  }

  // ── Route handlers ────────────────────────────────────────

  private handleList(res: ServerResponse, url: URL): void {
    const status = url.searchParams.get("status") as TicketStatus | null;
    const since = url.searchParams.get("since") || undefined;
    const labelFilters: Record<string, string> = {};
    for (const [k, v] of url.searchParams) {
      if (k.startsWith("label_")) {
        labelFilters[k.slice("label_".length)] = v;
      }
    }
    const rawRecords = this.ctx.store.list({
      status: status ?? undefined,
      since,
    });
    const joined = rawRecords
      .map((r) => ({ ticket: r, incident: this.ctx.incidents.getById(r.incident_id) }))
      .filter(({ incident }) => {
        if (Object.keys(labelFilters).length === 0) return true;
        if (!incident) return false;
        return Object.entries(labelFilters).every(
          ([k, v]) => String(incident.labels[k] ?? "") === v,
        );
      });
    this.json(res, { tickets: joined });
  }

  private handleGetOne(res: ServerResponse, ticketId: string): void {
    const ticket = this.ctx.store.findByTicketId(ticketId);
    if (!ticket) {
      this.notFound(res, "ticket_not_found");
      return;
    }
    const incident = this.ctx.incidents.getById(ticket.incident_id);
    this.json(res, { ticket, incident });
  }

  private async handlePostComment(
    req: IncomingMessage,
    res: ServerResponse,
    ticketId: string,
  ): Promise<void> {
    const ticket = this.ctx.store.findByTicketId(ticketId);
    if (!ticket) {
      this.notFound(res, "ticket_not_found");
      return;
    }

    let body: { body?: string; author?: string };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      this.badRequest(res, "invalid_body");
      return;
    }
    if (!body.body || body.body.trim().length === 0) {
      this.badRequest(res, "comment_body_required");
      return;
    }

    const comment = this.ctx.store.addComment(ticketId, {
      author: body.author?.trim() || "operator",
      body: body.body.trim(),
      source: "dashboard",
    });
    this.broadcastTicketComment(comment, ticket);
    this.json(res, { comment });
  }

  private async handleClose(
    req: IncomingMessage,
    res: ServerResponse,
    ticketId: string,
  ): Promise<void> {
    const ticket = this.ctx.store.findByTicketId(ticketId);
    if (!ticket) {
      this.notFound(res, "ticket_not_found");
      return;
    }

    if (!ticket.postmortem || ticket.postmortem.trim().length === 0) {
      this.json(
        res,
        { error: "can't close without a postmortem" },
        400,
      );
      return;
    }

    this.ctx.store.close(ticketId);
    const updated = this.ctx.store.findByTicketId(ticketId);
    this.broadcastTicketUpdate("ticket_closed", updated ?? ticket);
    this.json(res, { ticket: updated });
  }

  private async handlePatchPostmortem(
    req: IncomingMessage,
    res: ServerResponse,
    ticketId: string,
  ): Promise<void> {
    const ticket = this.ctx.store.findByTicketId(ticketId);
    if (!ticket) {
      this.notFound(res, "ticket_not_found");
      return;
    }

    let body: { postmortem?: string };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      this.badRequest(res, "invalid_body");
      return;
    }

    const value =
      typeof body.postmortem === "string" ? body.postmortem.trim() : "";
    this.ctx.store.updatePostmortem(ticketId, value.length > 0 ? value : null);
    const updated = this.ctx.store.findByTicketId(ticketId);
    this.broadcastTicketUpdate("ticket_updated", updated ?? ticket);
    this.json(res, { ticket: updated });
  }

  /** Synchronous: return immediately and run the LLM generation in the
   *  background. Required so Slack's `/rhodes ticket regenerate ...`
   *  flow can respond within the 3-second budget. */
  private handleRegeneratePostmortem(
    res: ServerResponse,
    ticketId: string,
  ): void {
    const ticket = this.ctx.store.findByTicketId(ticketId);
    if (!ticket) {
      this.notFound(res, "ticket_not_found");
      return;
    }
    if (!this.ctx.aiConfig || !this.ctx.aiConfig.apiKey) {
      this.json(res, { error: "llm_unavailable" }, 503);
      return;
    }
    this.json(res, { status: "regenerating" }, 202);
    void this.runPostmortemAsync(ticket);
  }

  private async runPostmortemAsync(ticket: TicketRecord): Promise<void> {
    const incident = this.ctx.incidents.getById(ticket.incident_id);
    if (!incident) return;
    if (!this.ctx.aiConfig) return;
    try {
      const result = await generatePostmortem(
        { ticket, incident },
        this.ctx.aiConfig,
        { timeoutMs: this.ctx.postmortemTimeoutMs },
      );
      this.applyPostmortemResult(ticket.ticket_id, result);
    } catch (err) {
      console.error("[tickets] postmortem regeneration crashed:", err);
    }
  }

  private applyPostmortemResult(
    ticketId: string,
    result: PostmortemResult,
  ): void {
    if (result.text) {
      this.ctx.store.updatePostmortem(ticketId, result.text);
    }
    if (result.note) {
      this.ctx.store.addComment(ticketId, {
        author: "agent",
        body: result.note,
        source: "agent",
      });
    }
    const updated = this.ctx.store.findByTicketId(ticketId);
    if (updated) this.broadcastTicketUpdate("ticket_updated", updated);
  }

  // ── IncidentCoordinator hooks ─────────────────────────────

  async onTicketOpened(
    ticket: TicketRecord,
    incident: Incident,
  ): Promise<void> {
    this.broadcastTicketUpdate("ticket_opened", ticket);

    if (!this.ctx.notifier) return;
    const result = await this.ctx.notifier.sendOnSlack({
      title: ticket.title,
      body: incident.description ?? ticket.title,
      kind: "ticket_opened",
      context: {
        ticket_id: ticket.ticket_id,
        severity: incident.severity,
        labels: incident.labels,
        incident_id: incident.id,
      },
    });
    if (!result || !result.delivered) return;
    const response = result.response as { channel?: string; ts?: string } | undefined;
    if (response?.ts) {
      this.ctx.store.bindSlackThread(ticket.ticket_id, response.channel ?? "", response.ts);
      const refreshed = this.ctx.store.findByTicketId(ticket.ticket_id);
      if (refreshed) this.broadcastTicketUpdate("ticket_updated", refreshed);
    }
  }

  async onTicketResolved(
    ticket: TicketRecord,
    incident: Incident,
  ): Promise<void> {
    this.broadcastTicketUpdate("ticket_resolved", ticket);

    let postmortemText: string | undefined;
    let postmortemNote: string | undefined;
    if (this.ctx.aiConfig && this.ctx.aiConfig.apiKey) {
      const result = await generatePostmortem(
        { ticket, incident },
        this.ctx.aiConfig,
        { timeoutMs: this.ctx.postmortemTimeoutMs },
      );
      this.applyPostmortemResult(ticket.ticket_id, result);
      postmortemText = result.text;
      postmortemNote = result.note;
    }

    // Post the resolve summary as a thread reply on the original
    // ticket-opened DM (or a fresh DM if the open never bound a thread).
    // This is the v0.5.0 fix for "no summary DM lands when the VM
    // recovers" — onTicketOpened sent the open card, but the resolve
    // path used to update the DB and exit silently. See CHANGELOG.
    if (!this.ctx.notifier) return;
    const refreshed = this.ctx.store.findByTicketId(ticket.ticket_id) ?? ticket;
    const body =
      postmortemText ??
      postmortemNote ??
      (incident.resolution ?? "Incident resolved.");
    const context: Record<string, unknown> = {
      ticket_id: ticket.ticket_id,
      incident_id: incident.id,
      severity: incident.severity,
      labels: incident.labels,
      resolution: incident.resolution,
      postmortem: postmortemText,
    };
    if (refreshed.slack_thread_ts) {
      context["slack_thread_ts"] = refreshed.slack_thread_ts;
    }
    if (refreshed.slack_channel) {
      context["slack_channel"] = refreshed.slack_channel;
    }
    await this.ctx.notifier.sendOnSlack({
      title: `${ticket.ticket_id} resolved — ${ticket.title}`,
      body,
      kind: "ticket_resolved",
      context,
    });
  }

  // ── Slack glue ────────────────────────────────────────────

  appendSlackThreadComment(
    threadTs: string,
    text: string,
    slackUserId: string,
  ): TicketComment | undefined {
    const ticket = this.ctx.store.findByThreadTs(threadTs);
    if (!ticket) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    const comment = this.ctx.store.addComment(ticket.ticket_id, {
      author: `slack:${slackUserId || "unknown"}`,
      body: trimmed,
      source: "slack",
    });
    this.broadcastTicketComment(comment, ticket);
    return comment;
  }

  getTicket(ticketId: string): { ticket: TicketRecord; incident: Incident | undefined } | undefined {
    const ticket = this.ctx.store.findByTicketId(ticketId);
    if (!ticket) return undefined;
    return { ticket, incident: this.ctx.incidents.getById(ticket.incident_id) };
  }

  listTickets(status?: TicketStatus): Array<{ ticket: TicketRecord; incident: Incident | undefined }> {
    return this.ctx.store.list({ status }).map((ticket) => ({
      ticket,
      incident: this.ctx.incidents.getById(ticket.incident_id),
    }));
  }

  // ── Helpers ───────────────────────────────────────────────

  private broadcastTicketUpdate(
    eventType: "ticket_opened" | "ticket_updated" | "ticket_resolved" | "ticket_closed",
    ticket: TicketRecord,
  ): void {
    const mapped =
      eventType === "ticket_opened"
        ? AgentEventType.TicketOpened
        : eventType === "ticket_updated"
          ? AgentEventType.TicketUpdated
          : eventType === "ticket_resolved"
            ? AgentEventType.TicketResolved
            : AgentEventType.TicketClosed;
    this.ctx.eventBus.emit({
      type: mapped,
      timestamp: new Date().toISOString(),
      data: {
        ticket_id: ticket.ticket_id,
        incident_id: ticket.incident_id,
        status: ticket.status,
        title: ticket.title,
        postmortem_present: Boolean(ticket.postmortem && ticket.postmortem.length > 0),
      },
    });
  }

  private broadcastTicketComment(
    comment: TicketComment,
    ticket: TicketRecord,
  ): void {
    this.ctx.eventBus.emit({
      type: AgentEventType.TicketCommentAdded,
      timestamp: comment.timestamp,
      data: {
        ticket_id: ticket.ticket_id,
        comment,
      },
    });
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private notFound(res: ServerResponse, error = "not_found"): true {
    this.json(res, { error }, 404);
    return true;
  }

  private method405(res: ServerResponse): true {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  private badRequest(res: ServerResponse, error: string): true {
    this.json(res, { error }, 400);
    return true;
  }
}

// ── Block Kit builders for /rhodes tickets ─────────────────────

export function buildTicketListBlocks(
  rows: Array<{ ticket: TicketRecord; incident: Incident | undefined }>,
): unknown[] {
  if (rows.length === 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":white_check_mark: No tickets match." },
      },
    ];
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `RHODES — ${rows.length} ticket(s)`,
        emoji: false,
      },
    },
  ];

  for (const { ticket, incident } of rows.slice(0, 20)) {
    const severity = incident?.severity ?? "warning";
    const comments = ticket.comments.length;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${escapeMrkdwn(ticket.ticket_id)}* — ${escapeMrkdwn(ticket.title)}`,
          `_${escapeMrkdwn(severity)}_ · _${escapeMrkdwn(ticket.status)}_ · opened ${escapeMrkdwn(ticket.opened_at)} · ${comments} comment${comments === 1 ? "" : "s"}`,
        ].join("\n"),
      },
    });
  }
  return blocks;
}

export function buildTicketDetailBlocks(
  ticket: TicketRecord,
  incident: Incident | undefined,
): unknown[] {
  const severity = incident?.severity ?? "warning";
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${ticket.ticket_id} — ${ticket.title}`.slice(0, 150),
        emoji: false,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status*\n${escapeMrkdwn(ticket.status)}` },
        { type: "mrkdwn", text: `*Severity*\n${escapeMrkdwn(severity)}` },
        { type: "mrkdwn", text: `*Opened*\n${escapeMrkdwn(ticket.opened_at)}` },
        {
          type: "mrkdwn",
          text: `*Resolved*\n${escapeMrkdwn(ticket.resolved_at ?? "—")}`,
        },
      ],
    },
  ];

  if (ticket.postmortem && ticket.postmortem.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Postmortem*\n${escapeMrkdwn(truncate(ticket.postmortem, 2500))}`,
      },
    });
  }

  if (ticket.comments.length > 0) {
    const lastN = ticket.comments.slice(-5);
    const text = lastN
      .map(
        (c) =>
          `*${escapeMrkdwn(c.author)}* (${escapeMrkdwn(c.timestamp)}): ${escapeMrkdwn(truncate(c.body, 300))}`,
      )
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Comments*\n${text}` },
    });
  }

  if (ticket.plan_ids.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Plans:* ${ticket.plan_ids.map((p) => `\`${escapeMrkdwn(p)}\``).join(", ")}`,
        },
      ],
    });
  }

  return blocks;
}

// ── Helpers ───────────────────────────────────────────────────

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}
