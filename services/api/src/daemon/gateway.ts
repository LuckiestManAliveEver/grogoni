import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  toPublicDaemonTask,
  type DaemonPayload,
  type DaemonTask,
  type DaemonTaskStore
} from "./task-store.js";
import { edgeJobDefinitions } from "../edge-job-runner.js";

export function buildDaemonGateway(input: {
  store: DaemonTaskStore;
  token: string;
  ready: () => boolean;
  /** Applied when an agent task omits them; the executor still rejects unmapped models. */
  defaults: { modelId: string; agentAdapterId: "grogoni" | "pi" };
  /** Returns an error code when this daemon cannot run the payload (answered with 422). */
  refusal?: (payload: DaemonPayload) => string | null;
  report?: (event: { type: string; errorCode?: string }) => void;
  /** After a task is queued (submitted, or retried): the Edge lane lowers its wake hint here. */
  onQueued?: (task: DaemonTask) => Promise<void>;
}) {
  if (input.token.length < 32 || /\s/u.test(input.token))
    throw new Error("DAEMON_SERVICE_TOKEN must be at least 32 characters with no whitespace.");
  // Comparing fixed-length digests keeps the check constant-time and leaks no token length.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(input.token);
  const app = Fastify({
    // 60,000 characters each written as a 6-byte \uXXXX JSON escape, plus envelope, must fit.
    bodyLimit: 400_000,
    logger: false,
    requestTimeout: 15_000,
    // No type coercion: "60000" is not an interval, and operators should learn that at submit time.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }
  });
  // Same hardened parser as Fastify's default (prototype-poisoning protection), except that an
  // empty body is no body: DELETE and retry clients often send Content-Type without one.
  const json = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) =>
    body === "" ? done(null, undefined) : json(request, body.toString(), done)
  );
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health/live") return;
    // The auth scheme is case-insensitive (RFC 7235); the token itself is compared exactly.
    const supplied = /^bearer (.*)$/isu.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(supplied), expected))
      return reply.code(401).send({ error: "UNAUTHORIZED" });
  });
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => {
    if (!input.ready()) return reply.code(503).send({ status: "stopping" });
    try {
      await input.store.health();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "database_unavailable" });
    }
  });
  app.post<{
    Body: {
      key: string;
      payload: DaemonPayload;
      runAt?: string;
      intervalMs?: number;
      maxAttempts?: number;
    };
  }>(
    "/v1/tasks",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["key", "payload"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
            runAt: { type: "string", format: "date-time" },
            intervalMs: { type: "integer", minimum: 60_000, maximum: 2_592_000_000 },
            maxAttempts: { type: "integer", minimum: 1, maximum: 5 },
            payload: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "message"],
                  properties: {
                    kind: { const: "agent" },
                    message: { type: "string", minLength: 1, maxLength: 60_000, pattern: "\\S" },
                    modelId: { type: "string", minLength: 1, maxLength: 120 },
                    agentAdapterId: { enum: ["grogoni", "pi"] }
                  }
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "job"],
                  properties: {
                    kind: { const: "maintenance" },
                    job: { enum: Object.keys(edgeJobDefinitions) }
                  }
                }
              ]
            }
          }
        }
      }
    },
    async (request, reply) => {
      if (!input.ready()) return reply.code(503).send({ error: "DAEMON_STOPPING" });
      const body = request.body;
      const runAt = body.runAt ? new Date(body.runAt) : new Date();
      // PostgreSQL cannot store U+0000 or lone surrogates (the latter would also make distinct
      // idempotency keys collide), and JSON Schema date-time admits values Date cannot represent.
      const texts = [body.key, ...(body.payload.kind === "agent" ? [body.payload.message] : [])];
      if (
        Number.isNaN(runAt.getTime()) ||
        texts.some((text) => text.includes("\0") || /\p{Cs}/u.test(text))
      )
        return reply.code(400).send({ error: "INVALID_TASK" });
      const payload =
        body.payload.kind === "agent"
          ? {
              ...body.payload,
              modelId: body.payload.modelId ?? input.defaults.modelId,
              agentAdapterId: body.payload.agentAdapterId ?? input.defaults.agentAdapterId
            }
          : body.payload;
      const refused = input.refusal?.(payload) ?? null;
      if (refused) return reply.code(422).send({ error: refused });
      const task = await input.store.enqueue({
        key: body.key,
        payload,
        runAt,
        ...(body.intervalMs === undefined ? {} : { intervalMs: body.intervalMs }),
        maxAttempts: body.maxAttempts ?? 3
      });
      await input.onQueued?.(task);
      return reply.code(202).send(toPublicDaemonTask(task));
    }
  );
  const idSchema = {
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } }
    }
  };
  app.get<{ Params: { id: string } }>(
    "/v1/tasks/:id",
    { schema: idSchema },
    async (request, reply) => {
      const task = await input.store.get(request.params.id);
      return task ? toPublicDaemonTask(task) : reply.code(404).send({ error: "TASK_NOT_FOUND" });
    }
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/tasks/:id",
    { schema: idSchema },
    async (request) => ({ cancelled: await input.store.cancel(request.params.id) })
  );
  app.get("/v1/tasks", async () => ({
    tasks: (await input.store.list()).map(toPublicDaemonTask)
  }));
  app.get("/v1/stats", async () => input.store.stats());
  app.post<{ Params: { id: string } }>(
    "/v1/tasks/:id/retry",
    { schema: idSchema },
    async (request, reply) => {
      if (!input.ready()) return reply.code(503).send({ error: "DAEMON_STOPPING" });
      // Requeueing work this daemon cannot run would only dead-letter it again.
      const task = input.refusal ? await input.store.get(request.params.id) : null;
      const refused = task ? input.refusal!(task.payload) : null;
      if (refused) return reply.code(422).send({ error: refused });
      const queued = await input.store.retry(request.params.id);
      if (queued && input.onQueued) {
        const requeued = await input.store.get(request.params.id);
        if (requeued) await input.onQueued(requeued);
      }
      return { queued };
    }
  );
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    const code = (error as { code?: unknown }).code;
    const oversized = status === 413;
    // Every client-side rejection (schema, media type, malformed JSON) and any PostgreSQL data
    // exception (SQLSTATE class 22) is the caller's input, never a retryable outage.
    const validation =
      !oversized &&
      ((typeof status === "number" && status >= 400 && status < 500) ||
        (typeof code === "string" && /^22[0-9A-Z]{3}$/u.test(code)));
    if (!validation && !oversized) {
      input.report?.({
        type: "gateway_error",
        errorCode: typeof code === "string" ? code : "UNKNOWN"
      });
    }
    void reply.code(oversized ? 413 : validation ? 400 : 503).send({
      error: oversized ? "TASK_TOO_LARGE" : validation ? "INVALID_TASK" : "DAEMON_UNAVAILABLE"
    });
  });
  return app;
}
