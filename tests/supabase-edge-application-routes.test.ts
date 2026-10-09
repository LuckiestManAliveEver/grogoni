import { describe, expect, it, vi } from "vitest";
import { createApplicationRoutes } from "../supabase/functions/api/application-routes";
import type { SqlClient } from "../supabase/functions/api/session-routes";
import { createHandler } from "../supabase/functions/api/handler";

const accountId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const cookie = `grogoni_session=${sessionId}`;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`https://example.com${path}`, { ...init, headers });
}

function setup(query: SqlClient["query"]) {
  return createApplicationRoutes({
    jobToken: "j".repeat(32),
    transaction: async (action) => action({ query })
  });
}

function authQuery(extra: SqlClient["query"] = vi.fn(async () => ({ rows: [] }))) {
  return vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("from sessions"))
      return { rows: [{ account_id: accountId, user_id: userId }] };
    return extra(sql, values);
  });
}

describe("Supabase Edge application routes", () => {
  it("exposes chat conversations and messages from durable mirror tables", async () => {
    const query = authQuery(async (sql) => {
      if (sql.includes("select record from cp2_conversations"))
        return { rows: [{ record: { id: "conversation-1", title: "Buyer" } }] };
      if (sql.includes("select record from cp2_conversation_messages"))
        return { rows: [{ record: { id: "message-1", body: "Hello" } }] };
      return { rows: [] };
    });
    const routes = setup(query);
    const conversations = await routes(request("/v1/conversations"), "/v1/conversations");
    expect(await conversations!.json()).toEqual({
      conversations: [{ id: "conversation-1", title: "Buyer" }]
    });
    const messages = await routes(
      request("/v1/conversations/conversation-1/messages"),
      "/v1/conversations/conversation-1/messages"
    );
    expect(await messages!.json()).toEqual({ messages: [{ id: "message-1", body: "Hello" }] });
  });

  it("creates marketplace product-capture jobs without process-local state", async () => {
    const query = authQuery();
    const routes = setup(query);
    const response = await routes(
      request("/businesses/shop-1/product-captures", {
        method: "POST",
        body: JSON.stringify({ sourceFileName: "photo.jpg" })
      }),
      "/businesses/shop-1/product-captures"
    );
    expect(response!.status).toBe(201);
    expect(await response!.json()).toMatchObject({
      businessId: "shop-1",
      sourceFileName: "photo.jpg",
      status: "pending_review"
    });
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into product_capture_jobs"))).toBe(
      true
    );
  });

  it("maps raw WebSocket expectations to the Edge HTTP polling transport", async () => {
    const query = authQuery();
    const routes = setup(query);
    const response = await routes(request("/v1/realtime/connect"), "/v1/realtime/connect");
    expect(await response!.json()).toEqual({
      transport: "http-poll",
      eventsUrl: "/v1/realtime/events",
      ackUrlTemplate: "/v1/realtime/events/{eventId}/ack",
      websocket: false
    });
  });

  it("persists scheduled job runs behind an operator token", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const routes = setup(query);
    const denied = await routes(
      request("/internal/jobs/notification_delivery/run", { method: "POST" }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(denied!.status).toBe(401);
    const forged = await routes(
      request("/internal/jobs/notification_delivery/run", {
        method: "POST",
        headers: { "x-job-token": "x".repeat(32) }
      }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(forged!.status).toBe(401);
    const accepted = await routes(
      request("/internal/jobs/notification_delivery/run", {
        method: "POST",
        headers: { "x-job-token": "j".repeat(32) }
      }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(accepted!.status).toBe(202);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into cp2_background_jobs"))).toBe(
      true
    );
  });

  it("acknowledges only an owned event without replacing its payload", async () => {
    const query = authQuery(async () => ({ rows: [{ entity_id: "event-1" }] }));
    const response = await setup(query)(
      request("/v1/realtime/events/event-1/ack", { method: "POST" }),
      "/v1/realtime/events/event-1/ack"
    );
    expect(response!.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => sql.startsWith("update cp2_realtime_events"))!;
    expect(update[0]).toContain("record = record ||");
    expect(update[0]).toContain("account_id = $2");
    expect(update[1]!.slice(0, 2)).toEqual(["event-1", accountId]);
  });

  it("does not create an event when acknowledging an unknown or foreign ID", async () => {
    const query = authQuery();
    const response = await setup(query)(
      request("/v1/realtime/events/foreign/ack", { method: "POST" }),
      "/v1/realtime/events/foreign/ack"
    );
    expect(response!.status).toBe(404);
    expect(
      query.mock.calls.some(([sql]) => sql.startsWith("insert into cp2_realtime_events"))
    ).toBe(false);
  });

  it("allows readiness to go green only for the complete Edge host", async () => {
    const incomplete = createHandler({ checkDatabase: async () => {}, allowedOrigins: [] });
    expect((await incomplete(new Request("https://example.com/health/ready"))).status).toBe(503);
    const complete = createHandler({
      checkDatabase: async () => {},
      allowedOrigins: [],
      complete: true
    });
    expect((await complete(new Request("https://example.com/health/ready"))).status).toBe(200);
  });
});
