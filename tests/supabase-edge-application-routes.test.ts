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

  it("runs scheduled jobs behind an operator token and records the outcome", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    let inTransaction = false;
    const runJob = vi.fn(async (job: string) => {
      // The job's own transaction takes the store lock; running it inside a route transaction
      // would wait on a lock its caller holds.
      expect(inTransaction).toBe(false);
      return { job, status: "completed" as const, durationMs: 4, result: { checked: 2 } };
    });
    const routes = createApplicationRoutes({
      jobToken: "j".repeat(32),
      runJob,
      transaction: async (action) => {
        inTransaction = true;
        try {
          return await action({ query });
        } finally {
          inTransaction = false;
        }
      }
    });
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
    expect(accepted!.status).toBe(200);
    expect(await accepted!.json()).toMatchObject({
      job: "notification_delivery",
      status: "completed",
      result: { checked: 2 }
    });
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith("notification_delivery");
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into cp2_background_jobs"))).toBe(
      true
    );
  });

  it("records a failed job run and answers 500 instead of pretending it was queued", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const routes = createApplicationRoutes({
      jobToken: "j".repeat(32),
      runJob: async () => {
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      },
      transaction: async (action) => action({ query })
    });
    const response = await routes(
      request("/internal/jobs/notification_delivery/run", {
        method: "POST",
        headers: { "x-job-token": "j".repeat(32) }
      }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(response!.status).toBe(500);
    expect(await response!.json()).toMatchObject({
      status: "failed",
      error: { code: "ECONNRESET" }
    });
    const stored = query.mock.calls.find(([sql]) =>
      sql.includes("insert into cp2_background_jobs")
    );
    expect(JSON.stringify(stored)).toContain('\\"status\\":\\"failed\\"');
  });

  it("rejects tokenless job requests before opening a database transaction", async () => {
    let transactions = 0;
    const routes = createApplicationRoutes({
      jobToken: "j".repeat(32),
      runJob: async (job) => ({ job, status: "completed", durationMs: 1 }),
      transaction: async (action) => {
        transactions++;
        return action({ query: vi.fn(async () => ({ rows: [] })) });
      }
    });
    for (const [method, path] of [
      ["GET", "/internal/jobs/notification_delivery/status"],
      ["POST", "/internal/jobs/notification_delivery/run"],
      ["DELETE", "/internal/jobs/notification_delivery/run"]
    ] as const) {
      const response = await routes(request(path, { method }), path);
      expect(response!.status, `${method} ${path}`).toBe(401);
    }
    const wrongMethod = await routes(
      request("/internal/jobs/notification_delivery/run", {
        method: "PUT",
        headers: { "x-job-token": "j".repeat(32) }
      }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(wrongMethod!.status).toBe(405);
    expect(transactions).toBe(0);
  });

  it("writes job records without the store-locked transaction", async () => {
    const recorded = vi.fn(async () => ({ rows: [] }));
    const routes = createApplicationRoutes({
      jobToken: "j".repeat(32),
      runJob: async (job) => ({ job, status: "completed", durationMs: 1 }),
      transaction: async () => {
        throw new Error("The store-locked transaction must not be used for job records.");
      },
      recordTransaction: async (action) => action({ query: recorded })
    });
    const headers = { "x-job-token": "j".repeat(32) };
    const run = await routes(
      request("/internal/jobs/notification_delivery/run", { method: "POST", headers }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(run!.status).toBe(200);
    const status = await routes(
      request("/internal/jobs/notification_delivery/status", { headers }),
      "/internal/jobs/notification_delivery/status"
    );
    expect(status!.status).toBe(200);
    expect(recorded).toHaveBeenCalledTimes(2);
  });

  it("keeps the last real run's record when an overlapping trigger is skipped", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const routes = createApplicationRoutes({
      jobToken: "j".repeat(32),
      runJob: async (job) => ({ job, status: "skipped", durationMs: 1, reason: "already_running" }),
      transaction: async (action) => action({ query })
    });
    const response = await routes(
      request("/internal/jobs/notification_delivery/run", {
        method: "POST",
        headers: { "x-job-token": "j".repeat(32) }
      }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ status: "skipped", reason: "already_running" });
    expect(query).not.toHaveBeenCalled();
  });

  it("answers 503 when no job runner is wired and 404 for an unknown job", async () => {
    const routes = setup(vi.fn(async () => ({ rows: [] })));
    const headers = { "x-job-token": "j".repeat(32) };
    const unavailable = await routes(
      request("/internal/jobs/notification_delivery/run", { method: "POST", headers }),
      "/internal/jobs/notification_delivery/run"
    );
    expect(unavailable!.status).toBe(503);
    const unknown = await routes(
      request("/internal/jobs/drop_everything/run", { method: "POST", headers }),
      "/internal/jobs/drop_everything/run"
    );
    expect(unknown!.status).toBe(404);
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
