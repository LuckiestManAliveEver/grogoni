import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { sessionCookie, type SqlClient, type Transaction } from "./session-routes.ts";

type Row = Record<string, unknown>;

/** Outcome of one background job run (services/api/src/edge-job-runner.ts). */
export interface EdgeJobOutcome {
  job: string;
  status: "completed" | "disabled" | "skipped";
  durationMs: number;
  result?: unknown;
  reason?: string;
}

interface Dependencies {
  transaction: Transaction;
  jobToken?: string;
  /**
   * Runs a job to completion in its own transaction. Called outside any route transaction: the
   * job's transaction takes the store lock, so starting it from inside another one would wait on
   * a lock its own caller holds.
   */
  runJob?: (jobName: string) => Promise<EdgeJobOutcome>;
  /**
   * A transaction without the store lock, for writing job records: cp2_background_jobs is not
   * part of the store snapshot, and a record must not wait behind (or fail on) the store lock.
   */
  recordTransaction?: Transaction;
}

interface RouteMatch {
  pattern: RegExp;
  params: string[];
}

const routes = {
  conversations: match("/v1/conversations"),
  conversation: match("/v1/conversations/:conversationId"),
  messages: match("/v1/messages"),
  conversationMessages: match("/v1/conversations/:conversationId/messages"),
  message: match("/v1/conversations/:conversationId/messages/:messageId"),
  productCaptures: match("/businesses/:businessId/product-captures"),
  productCapture: match("/businesses/:businessId/product-captures/:captureJobId"),
  productCaptureReview: match("/businesses/:businessId/product-captures/:captureJobId/review"),
  productCaptureConfirm: match("/businesses/:businessId/product-captures/:captureJobId/confirm"),
  shopCatalogue: match("/v1/shop-system/catalogue"),
  shopOrders: match("/v1/shop-system/orders"),
  shopOrder: match("/v1/shop-system/orders/:orderId"),
  realtimeEvents: match("/v1/realtime/events"),
  realtimeAck: match("/v1/realtime/events/:eventId/ack"),
  jobsRun: match("/internal/jobs/:jobName/run"),
  jobsStatus: match("/internal/jobs/:jobName/status")
};

const mutableMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Must match edgeJobDefinitions in services/api/src/edge-job-runner.ts (asserted by tests). */
export const edgeBackgroundJobNames: ReadonlySet<string> = new Set([
  "account_deletion_purge",
  "agent_owner_correction_retention",
  "connected_mailbox_sync",
  "conversation_recycle_bin_purge",
  "daemon_worker",
  "fulfillment_dispatch_evaluation",
  "fulfillment_idempotency_retention",
  "fulfillment_intake_reconcile",
  "fulfillment_outbox_delivery",
  "grogoniid_cooldown",
  "notification_delivery",
  "runtime_experience_retention",
  "edge_rate_limit_retention"
]);

class EdgeRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function match(pattern: string): RouteMatch {
  const params: string[] = [];
  const expression = pattern
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        params.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${expression}$`), params };
}

function params(route: RouteMatch, path: string): Row | null {
  const result = route.pattern.exec(path);
  if (!result) return null;
  return Object.fromEntries(
    route.params.map((name, index) => [name, decodeURIComponent(result[index + 1])])
  );
}

async function json(request: Request, max = 1_000_000): Promise<Row> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new EdgeRouteError(415, "content_type_invalid", "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > max) {
      await reader.cancel();
      throw new EdgeRouteError(413, "request_too_large", "The request is too large.");
    }
    chunks.push(chunk.value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Row;
  } catch {
    throw new EdgeRouteError(400, "request_invalid", "A JSON object is required.");
  } finally {
    reader.releaseLock();
  }
}

function ok(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function auth(request: Request) {
  const sessionId = sessionCookie(request);
  if (!sessionId) throw new EdgeRouteError(401, "auth_required", "Authentication is required.");
  return sessionId;
}

/** The live session's account and user, or null for a missing, expired or revoked session. */
export async function findSessionUser(
  client: SqlClient,
  request: Request
): Promise<{ sessionId: string; accountId: string; userId: string } | null> {
  const sessionId = sessionCookie(request);
  if (!sessionId) return null;
  const result = await client.query(
    `select s.account_id, s.user_id from sessions s join accounts a on a.id = s.account_id
     where s.id = $1 and s.revoked_at is null and s.expires_at > now()
       and s.inactivity_expires_at > now() and s.absolute_expires_at > now()
       and a.status = 'active' and a.deleted_at is null`,
    [sessionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { sessionId, accountId: String(row.account_id), userId: String(row.user_id) };
}

async function actor(client: SqlClient, request: Request) {
  auth(request);
  const user = await findSessionUser(client, request);
  if (!user) throw new EdgeRouteError(401, "auth_required", "Authentication is required.");
  return user;
}

async function listRecords(client: SqlClient, table: string, where: string, values: unknown[]) {
  const result = await client.query(
    `select record from ${table} where ${where} order by updated_at desc limit 100`,
    values
  );
  return result.rows.map((row) => row.record);
}

async function getRecord(client: SqlClient, table: string, id: string, businessId?: string) {
  const result = await client.query(
    `select record from ${table} where entity_id = $1 and ($2::text is null or business_id = $2) limit 1`,
    [id, businessId ?? null]
  );
  return result.rows[0]?.record ?? null;
}

async function upsertRecord(
  client: SqlClient,
  table: string,
  record: Row,
  ids: {
    id?: string;
    businessId?: string | null;
    accountId?: string | null;
    userId?: string | null;
    parentId?: string | null;
  }
) {
  const id = ids.id ?? String(record.id ?? randomUUID());
  const stored = { id, ...record, updatedAt: new Date().toISOString() };
  await client.query(
    `insert into ${table} (entity_id, business_id, account_id, user_id, parent_id, record)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (entity_id) do update set
       business_id = excluded.business_id,
       account_id = excluded.account_id,
       user_id = excluded.user_id,
       parent_id = excluded.parent_id,
       record = excluded.record,
       updated_at = now()`,
    [
      id,
      ids.businessId ?? null,
      ids.accountId ?? null,
      ids.userId ?? null,
      ids.parentId ?? null,
      JSON.stringify(stored)
    ]
  );
  return stored;
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  if (!value.toLowerCase().startsWith("bearer ") || value.slice(7).trim() === "")
    throw new EdgeRouteError(
      401,
      "shop_system_token_required",
      "A shop-system bearer token is required."
    );
  return value.slice(7).trim();
}

export function createApplicationRoutes({
  transaction,
  jobToken = "",
  runJob,
  recordTransaction = transaction
}: Dependencies) {
  return async (request: Request, path: string): Promise<Response | null> => {
    try {
      // Job routes check the operator token before touching the database: they are exempt
      // from the rate limit, so an unauthenticated caller must not reach a connection or lock.
      const jobRun = params(routes.jobsRun, path);
      const jobStatus = params(routes.jobsStatus, path);
      if (jobRun || jobStatus) {
        const jobName = String((jobRun ?? jobStatus)!.jobName);
        authorizeJob(request, jobName, jobToken);
        if (jobRun && request.method === "POST")
          return await runBackgroundJob(recordTransaction, jobName, runJob);
        if (jobStatus && request.method === "GET")
          return await recordTransaction(async (client) => {
            const stored = (
              await client.query("select record from cp2_background_jobs where entity_id = $1", [
                jobName
              ])
            ).rows[0]?.record;
            return ok(stored ?? { job: jobName, status: "never_run" });
          });
        throw new EdgeRouteError(405, "method_not_allowed", "Method not allowed.");
      }
      if (path === "/v1/realtime/connect" || path === "/realtime") {
        await transaction((client) => actor(client, request));
        return ok({
          transport: "http-poll",
          eventsUrl: "/v1/realtime/events",
          ackUrlTemplate: "/v1/realtime/events/{eventId}/ack",
          websocket: false
        });
      }
      if (!Object.values(routes).some((route) => route.pattern.test(path))) return null;
      return await transaction(async (client) => {
        const captureList = params(routes.productCaptures, path);
        if (captureList && request.method === "GET") {
          await actor(client, request);
          return ok({
            jobs: await listRecords(client, "product_capture_jobs", "business_id = $1", [
              captureList.businessId
            ])
          });
        }
        if (captureList && request.method === "POST") {
          const user = await actor(client, request);
          const data = await json(request, 12_000_000);
          return ok(
            await upsertRecord(
              client,
              "product_capture_jobs",
              { ...data, businessId: captureList.businessId, status: "pending_review" },
              {
                businessId: String(captureList.businessId),
                accountId: user.accountId,
                userId: user.userId
              }
            ),
            201
          );
        }
        const capture = params(routes.productCapture, path);
        if (capture && request.method === "GET") {
          await actor(client, request);
          const record = await getRecord(
            client,
            "product_capture_jobs",
            String(capture.captureJobId),
            String(capture.businessId)
          );
          return record
            ? ok(record)
            : ok(
                { code: "product_capture_not_found", message: "Product capture was not found." },
                404
              );
        }
        const captureMutation =
          params(routes.productCaptureReview, path) ?? params(routes.productCaptureConfirm, path);
        if (captureMutation && request.method === "PATCH") {
          const user = await actor(client, request);
          const data = await json(request);
          const existing = ((await getRecord(
            client,
            "product_capture_jobs",
            String(captureMutation.captureJobId),
            String(captureMutation.businessId)
          )) ?? {}) as Row;
          return ok(
            await upsertRecord(
              client,
              "product_capture_jobs",
              { ...existing, ...data, businessId: captureMutation.businessId },
              {
                id: String(captureMutation.captureJobId),
                businessId: String(captureMutation.businessId),
                accountId: user.accountId,
                userId: user.userId
              }
            )
          );
        }
        if (params(routes.conversations, path) && request.method === "GET") {
          const user = await actor(client, request);
          return ok({
            conversations: await listRecords(client, "cp2_conversations", "account_id = $1", [
              user.accountId
            ])
          });
        }
        if (params(routes.conversations, path) && request.method === "POST") {
          const user = await actor(client, request);
          const data = await json(request);
          return ok(
            await upsertRecord(client, "cp2_conversations", data, {
              businessId: typeof data.activeShopId === "string" ? data.activeShopId : null,
              accountId: user.accountId,
              userId: user.userId
            }),
            201
          );
        }
        const conversation = params(routes.conversation, path);
        if (conversation && request.method === "GET") {
          await actor(client, request);
          const record = await getRecord(
            client,
            "cp2_conversations",
            String(conversation.conversationId)
          );
          return record
            ? ok(record)
            : ok({ code: "conversation_not_found", message: "Conversation was not found." }, 404);
        }
        const messageList = params(routes.conversationMessages, path);
        if (messageList && request.method === "GET") {
          await actor(client, request);
          return ok({
            messages: await listRecords(client, "cp2_conversation_messages", "parent_id = $1", [
              messageList.conversationId
            ])
          });
        }
        if ((messageList || params(routes.messages, path)) && request.method === "POST") {
          const user = await actor(client, request);
          const data = await json(request);
          const conversationId = String(messageList?.conversationId ?? data.conversationId ?? "");
          if (!conversationId)
            throw new EdgeRouteError(400, "conversation_required", "conversationId is required.");
          return ok(
            await upsertRecord(
              client,
              "cp2_conversation_messages",
              { ...data, conversationId },
              { accountId: user.accountId, userId: user.userId, parentId: conversationId }
            ),
            201
          );
        }
        const message = params(routes.message, path);
        if (message && mutableMethods.has(request.method)) {
          const user = await actor(client, request);
          const data = request.method === "DELETE" ? { deleted: true } : await json(request);
          const existing = ((await getRecord(
            client,
            "cp2_conversation_messages",
            String(message.messageId)
          )) ?? {}) as Row;
          return ok(
            await upsertRecord(
              client,
              "cp2_conversation_messages",
              { ...existing, ...data },
              {
                id: String(message.messageId),
                accountId: user.accountId,
                userId: user.userId,
                parentId: String(message.conversationId)
              }
            )
          );
        }
        if (params(routes.shopCatalogue, path) && request.method === "PUT") {
          bearer(request);
          const data = await json(request, 5_000_000);
          return ok({
            accepted: true,
            products: Array.isArray(data.products) ? data.products.length : 0
          });
        }
        if (params(routes.shopOrders, path) && request.method === "GET") {
          bearer(request);
          return ok({ orders: [] });
        }
        const shopOrder = params(routes.shopOrder, path);
        if (shopOrder && request.method === "PATCH") {
          bearer(request);
          return ok({ id: shopOrder.orderId, ...(await json(request)) });
        }
        if (params(routes.realtimeEvents, path) && request.method === "GET") {
          const user = await actor(client, request);
          return ok({
            events: await listRecords(client, "cp2_realtime_events", "account_id = $1", [
              user.accountId
            ])
          });
        }
        const realtimeAck = params(routes.realtimeAck, path);
        if (realtimeAck && request.method === "POST") {
          const user = await actor(client, request);
          const updated = await client.query(
            "update cp2_realtime_events set record = record || jsonb_build_object('acknowledgedAt', $3::text), updated_at = now() where entity_id = $1 and account_id = $2 returning entity_id",
            [String(realtimeAck.eventId), user.accountId, new Date().toISOString()]
          );
          if (!updated.rows.length)
            return ok({ code: "not_found", message: "Event not found" }, 404);
          return ok({ acknowledged: true });
        }
        return null;
      });
    } catch (error) {
      if (error instanceof EdgeRouteError)
        return ok({ code: error.code, message: error.message }, error.status);
      throw error;
    }
  };
}

function authorizeJob(request: Request, jobName: string, expectedToken: string) {
  if (!edgeBackgroundJobNames.has(jobName))
    throw new EdgeRouteError(404, "job_not_found", "Background job was not found.");
  const token = Buffer.from(request.headers.get("x-job-token") ?? "");
  const expected = Buffer.from(expectedToken);
  if (expected.length < 16 || token.length !== expected.length || !timingSafeEqual(token, expected))
    throw new EdgeRouteError(401, "job_token_required", "A job token is required.");
}

async function runBackgroundJob(
  transaction: Transaction,
  jobName: string,
  runJob: Dependencies["runJob"]
) {
  if (runJob === undefined)
    throw new EdgeRouteError(503, "job_runner_unavailable", "The job runner is not available.");
  const requestedAt = new Date().toISOString();
  let record: Row;
  let status = 200;
  try {
    const outcome = await runJob(jobName);
    // An overlapping trigger changed nothing; keep the running job's record as the last result.
    if (outcome.status === "skipped") return ok({ ...outcome, job: jobName }, 200);
    record = { ...outcome, job: jobName, lastRequestedAt: requestedAt, lastRunAt: requestedAt };
  } catch (error) {
    status = 500;
    record = {
      job: jobName,
      status: "failed",
      lastRequestedAt: requestedAt,
      lastRunAt: requestedAt,
      error: {
        type: error instanceof Error ? error.name : "UnknownError",
        code:
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
      }
    };
    console.error(JSON.stringify({ event: "edge_job_failed", ...record }));
  }
  await transaction((client) =>
    upsertRecord(client, "cp2_background_jobs", record, { id: jobName })
  );
  return ok(record, status);
}
