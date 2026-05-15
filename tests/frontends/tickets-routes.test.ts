import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TicketStore } from "../../src/healing/ticket-store.js";
import { IncidentManager } from "../../src/healing/incidents.js";
import { EventBus } from "../../src/agent/events.js";
import { createTicketRouter } from "../../src/frontends/dashboard/tickets-routes.js";

// ── Mocks ─────────────────────────────────────────────────

let tmpDb: string;
let tmpDataDir: string;

function fresh(): { dbPath: string; dataDir: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpDb = `/tmp/rhodes-test-tickets-${stamp}.db`;
  tmpDataDir = `/tmp/rhodes-test-tickets-data-${stamp}`;
  return { dbPath: tmpDb, dataDir: tmpDataDir };
}

afterEach(() => {
  for (const path of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.emit("finish");
  }
  json(): unknown {
    return JSON.parse(this.body);
  }
}

function makeReq(method: string, url: string, body?: string): IncomingMessage {
  const stream = new Readable({
    read() {
      if (body) this.push(body);
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = method;
  (stream as unknown as { url: string }).url = url;
  return stream;
}

async function dispatch(
  router: ReturnType<typeof createTicketRouter>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = makeReq(method, url, body ? JSON.stringify(body) : undefined);
  const res = new MockResponse();
  await router.dispatch(req, res as unknown as ServerResponse, new URL(url, "http://localhost").pathname);
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

// ── Fixtures ──────────────────────────────────────────────

function bootstrap(): {
  store: TicketStore;
  incidents: IncidentManager;
  bus: EventBus;
  router: ReturnType<typeof createTicketRouter>;
} {
  const { dbPath, dataDir } = fresh();
  const bus = new EventBus();
  const incidents = new IncidentManager(bus, dataDir);
  const store = new TicketStore(dbPath);
  const router = createTicketRouter({
    store,
    incidents,
    eventBus: bus,
  });
  return { store, incidents, bus, router };
}

function seedTicket(
  incidents: IncidentManager,
  store: TicketStore,
  overrides: { description?: string; severity?: "critical" | "warning" } = {},
): { ticketId: string; incidentId: string } {
  const incident = incidents.open({
    type: "state_change",
    severity: overrides.severity ?? "critical",
    metric: "vm_status",
    labels: { vmid: "200", node: "pranavlab", name: "esxi-01", reason: "paused_io_error" },
    value: 1,
    description: overrides.description ?? "VM esxi-01 entered paused (io-error)",
  });
  const ticket = store.ensureForIncident(incident);
  return { ticketId: ticket.ticket_id, incidentId: incident.id };
}

// ── Tests ─────────────────────────────────────────────────

describe("tickets routes", () => {
  let env: ReturnType<typeof bootstrap>;
  beforeEach(() => {
    env = bootstrap();
  });

  it("GET /api/tickets returns the list", async () => {
    seedTicket(env.incidents, env.store);
    const { status, body } = await dispatch(env.router, "GET", "/api/tickets");
    expect(status).toBe(200);
    const out = body as { tickets: Array<{ ticket: { ticket_id: string } }> };
    expect(out.tickets).toHaveLength(1);
    expect(out.tickets[0].ticket.ticket_id).toMatch(/^RHODES-\d{4}-\d{3,}$/);
  });

  it("GET /api/tickets?status=open filters", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    env.store.setStatus(ticketId, "resolved");
    const openOnly = await dispatch(env.router, "GET", "/api/tickets?status=open");
    expect((openOnly.body as { tickets: unknown[] }).tickets).toHaveLength(0);
    const resolved = await dispatch(env.router, "GET", "/api/tickets?status=resolved");
    expect((resolved.body as { tickets: unknown[] }).tickets).toHaveLength(1);
  });

  it("GET /api/tickets/:id returns the ticket joined with its incident", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    const { status, body } = await dispatch(env.router, "GET", `/api/tickets/${ticketId}`);
    expect(status).toBe(200);
    const out = body as { ticket: { title: string }; incident: { metric: string } };
    expect(out.ticket.title).toContain("esxi-01");
    expect(out.incident.metric).toBe("vm_status");
  });

  it("GET /api/tickets/:id 404s for a missing id", async () => {
    const { status, body } = await dispatch(
      env.router,
      "GET",
      "/api/tickets/RHODES-2099-999",
    );
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("ticket_not_found");
  });

  it("GET /api/tickets/:id rejects malformed ids", async () => {
    const { status } = await dispatch(env.router, "GET", "/api/tickets/not-a-ticket");
    expect(status).toBe(400);
  });

  it("POST /api/tickets/:id/comments appends a comment", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    const { status, body } = await dispatch(
      env.router,
      "POST",
      `/api/tickets/${ticketId}/comments`,
      { body: "Looking into this." },
    );
    expect(status).toBe(200);
    const out = body as { comment: { body: string; author: string; source: string } };
    expect(out.comment.body).toBe("Looking into this.");
    expect(out.comment.source).toBe("dashboard");
    expect(out.comment.author).toBe("operator");
  });

  it("POST /api/tickets/:id/comments rejects empty bodies", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    const { status, body } = await dispatch(
      env.router,
      "POST",
      `/api/tickets/${ticketId}/comments`,
      { body: "   " },
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("comment_body_required");
  });

  it("POST /api/tickets/:id/close blocks without a postmortem", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    env.store.setStatus(ticketId, "resolved");
    const { status, body } = await dispatch(
      env.router,
      "POST",
      `/api/tickets/${ticketId}/close`,
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toContain("postmortem");
  });

  it("POST /api/tickets/:id/close closes when postmortem is set", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    env.store.setStatus(ticketId, "resolved");
    env.store.updatePostmortem(ticketId, "Pruned a snapshot. qm resume returned in 1.3s.");
    const { status, body } = await dispatch(
      env.router,
      "POST",
      `/api/tickets/${ticketId}/close`,
    );
    expect(status).toBe(200);
    const out = body as { ticket: { status: string; closed_at: string } };
    expect(out.ticket.status).toBe("closed");
    expect(out.ticket.closed_at).toBeDefined();
  });

  it("PATCH /api/tickets/:id/postmortem updates the text", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    const { status, body } = await dispatch(
      env.router,
      "PATCH",
      `/api/tickets/${ticketId}/postmortem`,
      { postmortem: "Operator-written postmortem." },
    );
    expect(status).toBe(200);
    const out = body as { ticket: { postmortem: string } };
    expect(out.ticket.postmortem).toBe("Operator-written postmortem.");
  });

  it("POST /api/tickets/:id/regenerate-postmortem 503s without an AIConfig", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    const { status, body } = await dispatch(
      env.router,
      "POST",
      `/api/tickets/${ticketId}/regenerate-postmortem`,
    );
    expect(status).toBe(503);
    expect((body as { error: string }).error).toBe("llm_unavailable");
  });

  it("POST /api/tickets/:id/regenerate-postmortem returns 202 when LLM is configured", async () => {
    const bus = new EventBus();
    const { dbPath, dataDir } = fresh();
    const incidents = new IncidentManager(bus, dataDir);
    const store = new TicketStore(dbPath);
    const router = createTicketRouter({
      store,
      incidents,
      eventBus: bus,
      aiConfig: { provider: "anthropic", apiKey: "test", model: "claude" },
    });
    const incident = incidents.open({
      type: "state_change",
      severity: "critical",
      metric: "vm_status",
      labels: { vmid: "200", node: "pranavlab" },
      value: 1,
      description: "test",
    });
    const ticket = store.ensureForIncident(incident);
    const { status, body } = await dispatch(
      router,
      "POST",
      `/api/tickets/${ticket.ticket_id}/regenerate-postmortem`,
    );
    expect(status).toBe(202);
    expect((body as { status: string }).status).toBe("regenerating");
  });

  it("emits SSE events on comment add", async () => {
    const captured: Array<{ type: string }> = [];
    env.bus.on("*", (event) => captured.push({ type: event.type }));
    const { ticketId } = seedTicket(env.incidents, env.store);
    await dispatch(
      env.router,
      "POST",
      `/api/tickets/${ticketId}/comments`,
      { body: "hi" },
    );
    expect(captured.some((e) => e.type === "ticket_comment_added")).toBe(true);
  });

  it("appendSlackThreadComment binds a slack reply as a comment", async () => {
    const { ticketId } = seedTicket(env.incidents, env.store);
    env.store.bindSlackThread(ticketId, "C123", "1234.5678");
    const comment = env.router.appendSlackThreadComment("1234.5678", "slack reply", "U999");
    expect(comment).toBeDefined();
    expect(comment?.author).toBe("slack:U999");
    expect(comment?.source).toBe("slack");
    const fresh = env.store.findByTicketId(ticketId)!;
    expect(fresh.comments).toHaveLength(1);
  });

  it("appendSlackThreadComment is a no-op when no ticket matches", () => {
    const comment = env.router.appendSlackThreadComment("nope.0000", "msg", "U1");
    expect(comment).toBeUndefined();
  });

  it("onTicketResolved posts a Slack thread reply on the original ticket DM", async () => {
    // Regression: in v0.5.0-pre, onTicketResolved only generated the
    // postmortem text and stored it on the ticket — no DM ever fired
    // when the VM recovered, so the operator was left wondering. Fix
    // sends a `ticket_resolved` Slack alert via the captured thread_ts
    // so the resolve summary lands as a thread reply on the original
    // ticket-opened DM. See CHANGELOG for the live Jellyfin demo.
    const { dbPath, dataDir } = fresh();
    const bus = new EventBus();
    const incidents = new IncidentManager(bus, dataDir);
    const store = new TicketStore(dbPath);
    const sendOnSlack = vi.fn().mockResolvedValue({ delivered: true, provider: "slack" });
    const router = createTicketRouter({
      store,
      incidents,
      eventBus: bus,
      // Minimal Notifier shape — only sendOnSlack is exercised here.
      notifier: { sendOnSlack } as unknown as Parameters<typeof createTicketRouter>[0]["notifier"],
    });

    const incident = incidents.open({
      type: "threshold",
      severity: "critical",
      metric: "vm_status",
      labels: { vmid: "101", node: "pranavlab", name: "JellyFinServer", runtime_status: "stopped" },
      value: 0,
      description: "VM JellyFinServer on pranavlab stopped unexpectedly",
    });
    const ticket = store.ensureForIncident(incident);
    store.bindSlackThread(ticket.ticket_id, "D0B41UW8A6A", "1778869257.827579");

    incidents.resolve(incident.id, "VM JellyFinServer state recovered: stopped → running");
    const resolved = incidents.getById(incident.id)!;
    const refreshedTicket = store.findByTicketId(ticket.ticket_id)!;
    await router.onTicketResolved(refreshedTicket, resolved);

    expect(sendOnSlack).toHaveBeenCalledTimes(1);
    const alert = sendOnSlack.mock.calls[0][0];
    expect(alert.kind).toBe("ticket_resolved");
    expect(alert.title).toContain(ticket.ticket_id);
    expect(alert.context.slack_thread_ts).toBe("1778869257.827579");
    expect(alert.context.slack_channel).toBe("D0B41UW8A6A");
    expect(alert.context.ticket_id).toBe(ticket.ticket_id);
  });
});

// Silence unused-vi import in environments where vi is only available via globals.
void vi;
