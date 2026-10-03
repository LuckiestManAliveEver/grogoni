import { isValidTurnId, turnContext } from "./inference/turn-stream.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Metrics } from "@grogoni/observability";
import type { HealthResponse, RuntimeModelDiagnostic } from "@grogoni/shared-types";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerCp2Routes, type Cp2RouteOptions } from "./cp2/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerRenderDeployWebhook } from "./render-deploy-webhook.js";
import type { Cp2Store } from "./cp2/store.js";

const defaultAllowedCorsOrigins = ["http://127.0.0.1:5173", "http://localhost:5173"];

// Coarse, HTTP-level request throttling. This is a backstop against scraping/DoS across the
// entire surface, not the primary brute-force defense for auth actions - the OTP/PIN/signup
// flows already enforce tighter, purpose-specific limits deeper in cp2/routes.ts and cp2/store.ts.
const defaultRateLimitMax = 300;
const authRateLimitMax = 60;
const rateLimitWindowMs = 60_000;
const reservedStorefrontSubdomains = new Set(["api", "www"]);
export const interactiveResponseBudgetMs = 150;

export interface BuildApiOptions {
  allowedCorsOrigins?: string[];
  bodyLimit?: number;
  cp2?: Cp2RouteOptions;
  agentRuntimeDiagnostic?: (runInference: boolean) => Promise<RuntimeModelDiagnostic>;
  databaseHealth?: () => Promise<Record<string, unknown>>;
  inferenceRequired?: boolean;
  mutationPersistenceFlush?: () => Promise<void>;
  /**
   * ioredis-compatible client used to share rate-limit counters across API instances/restarts.
   * When omitted, rate limiting still runs but falls back to an in-memory, per-process store.
   */
  rateLimitRedisClient?: unknown;
  /**
   * Signing secret for Render's workspace deploy webhook (Settings page of the webhook in the
   * Render dashboard, whsec_-prefixed). When set, POST /internal/render/deploy-webhook is
   * registered so a successful Render deploy broadcasts an "update available" push notification.
   * Omitted (e.g. in tests or local dev), the route is not registered at all.
   */
  renderDeployWebhookSecret?: string;
  webRoot?: string | false;
  /**
   * When set, GET /metrics serves this registry's Prometheus text exposition (memory, CPU,
   * event-loop lag, HTTP/DB/model request latency - see docs/observability.md) and every request
   * is timed into its http_request_duration_seconds histogram. Omitted entirely in tests that
   * don't care about metrics, so /metrics is simply not registered.
   */
  metrics?: Metrics;
  /**
   * Shared-secret gate for GET /metrics (checked against the `x-metrics-token` header). Metrics
   * expose internal infrastructure detail (queue depth, pool sizing, per-route latency), so this
   * should be set in any deployment reachable from the public internet. Omitted, the endpoint is
   * unauthenticated - acceptable for local dev, not for production.
   */
  metricsAuthToken?: string;
}

export function buildApi(options: BuildApiOptions = {}) {
  const app = Fastify({
    logger: true,
    bodyLimit: options.bodyLimit ?? 15_000_000
  });
  const allowedCorsOrigins = new Set(options.allowedCorsOrigins ?? defaultAllowedCorsOrigins);
  const oauthAllowedRedirectOrigins = readOAuthAllowedRedirectOrigins([...allowedCorsOrigins]);
  const persistenceBarrierRequests = new WeakSet<object>();
  // Assigned once registerCp2Routes runs, below - Fastify finishes loading every registered
  // plugin (so this is always assigned) before it accepts its first real request or `.inject()`
  // call resolves. See the onRequest hook right after this for why it needs to be set this early.
  let cp2Store: Cp2Store | undefined;
  const webPublicUrl = (options.cp2?.webPublicUrl ?? "https://grogoni.com").replace(/\/+$/u, "");
  const storefrontApexHostname = new URL(webPublicUrl).hostname;

  void app.register(websocket, {
    options: {
      maxPayload: 1_024
    }
  });

  void app.register(rateLimit, {
    global: true,
    max: (request) => (request.url.startsWith("/auth/") ? authRateLimitMax : defaultRateLimitMax),
    timeWindow: rateLimitWindowMs,
    hook: "onRequest",
    keyGenerator: (request) => request.ip,
    allowList: (request) => request.url.startsWith("/health") || request.url === "/metrics",
    skipOnError: true,
    ...(options.rateLimitRedisClient === undefined ? {} : { redis: options.rateLimitRedisClient }),
    errorResponseBuilder: (_request, context) => ({
      code: "rate_limited",
      message: `Too many requests. Please retry after ${context.after}.`
    })
  });

  // Per-turn context (services/api/src/inference/turn-stream.ts): a client that watches a turn's
  // reply stream, or whose device runs an on-device model, names the turn in x-grogoni-turn-id. The
  // rest of the request runs inside that context so model adapters deep in the pipeline can find
  // it without the turn pipeline carrying it. Callback-style so the context spans the handler.
  app.addHook("onRequest", (request, _reply, done) => {
    const turnId = request.headers["x-grogoni-turn-id"];
    if (isValidTurnId(turnId)) {
      turnContext.run({ turnId }, done);
      return;
    }
    done();
  });

  // Store subdomain redirect (docs/architecture/grogoni-id-slug-system.md): once a wildcard
  // *.grogoni.com custom domain is registered against this service, a request that arrives with
  // Host: {handle}.grogoni.com resolves to that business's canonical storefront and redirects
  // there. Without the wildcard domain/DNS record actually pointed at this service, no such
  // request ever reaches it, so this hook is inert (and does nothing at all) until that one
  // infrastructure step is done. Fixed infrastructure aliases are reserved and never interpreted
  // as store handles; api.grogoni.com temporarily keeps cached pre-migration clients working.
  app.addHook("onRequest", async (request, reply) => {
    if (cp2Store === undefined) return;
    const requestHostname = request.hostname;
    if (!requestHostname.endsWith(`.${storefrontApexHostname}`)) return;
    const handle = requestHostname.slice(0, -(storefrontApexHostname.length + 1));
    if (handle.length === 0 || handle.includes(".") || reservedStorefrontSubdomains.has(handle))
      return;

    const resolution = cp2Store.resolveBusinessByGrogoniId(`grogoni.${handle}`);
    if (resolution === null) {
      return reply.code(404).send({
        code: "storefront_not_found",
        message: "This storefront link is no longer valid."
      });
    }
    return reply.redirect(
      `${webPublicUrl}/agent/${encodeURIComponent(resolution.business.grogoniId)}`,
      302
    );
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);

    if (origin !== undefined && allowedCorsOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header(
        "access-control-allow-headers",
        "content-type,x-request-id,idempotency-key,x-grogoni-device-id,x-grogoni-device-name,x-grogoni-platform,x-grogoni-client,x-grogoni-turn-id"
      );
      reply.header(
        "access-control-expose-headers",
        "server-timing,x-grogoni-response-budget-ms,x-grogoni-response-budget-class"
      );
    }

    const hasRouteSpecificOriginValidation = request.url.startsWith("/auth/passkeys/");
    if (
      origin !== undefined &&
      !allowedCorsOrigins.has(origin) &&
      isMutation &&
      !hasRouteSpecificOriginValidation
    ) {
      return reply.code(403).send({
        code: "origin_not_allowed",
        message: "This request origin is not allowed."
      });
    }

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (
      request.url.startsWith("/auth/") ||
      request.url === "/session" ||
      request.url.startsWith("/session/") ||
      request.url === "/logout" ||
      request.url === "/logout-all" ||
      request.url === "/sessions" ||
      request.url.startsWith("/sessions/")
    ) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    }

    if (
      options.mutationPersistenceFlush === undefined ||
      (request.method === "GET" && !requiresRuntimeDurabilityConfirmation(request.url)) ||
      request.method === "HEAD" ||
      request.method === "OPTIONS" ||
      reply.statusCode >= 400 ||
      persistenceBarrierRequests.has(request)
    ) {
      return payload;
    }

    persistenceBarrierRequests.add(request);
    const persistenceStartedAt = Date.now();
    try {
      await withPersistenceFlushDeadline(options.mutationPersistenceFlush(), request);
      if (request.routeOptions.url === "/api/agents/:agentId/models/:modelId/activate") {
        request.log.info(
          {
            event: "model.activation_persisted",
            requestId: request.id,
            persistenceLatencyMs: Date.now() - persistenceStartedAt
          },
          "Verified agent model binding crossed the persistence barrier."
        );
      }
    } catch (error) {
      if (error instanceof PersistenceFlushDeadlineExceeded) {
        // An offline ACK must prove durability before the device clears its pending mutation -
        // same reasoning for a confirmed/rejected order intent outcome.
        if (
          request.routeOptions.url === "/sync/push" ||
          request.routeOptions.url === "/sync/order-intents"
        )
          throw error;
        if (request.url.startsWith("/v1/runtime/")) {
          reply.code(503);
          return JSON.stringify({
            code: "RUNTIME_PERSISTENCE_PENDING",
            message:
              "Runtime durability is not confirmed yet. Refresh the handoff status before retrying.",
            retryable: true
          });
        }
        // The write is still queued and will complete/retry in the background (see
        // Cp2Store.flush()) - holding this response open until then would leave the caller's
        // "Working..." state spinning for as long as the queue is backed up, with no bound. A
        // request that already succeeded in memory - including a freshly issued session cookie -
        // should not wait forever on a best-effort durability sync, and a deadline timeout is not
        // itself a persistence failure: the flush has not failed, it is merely still running (see
        // withPersistenceFlushDeadline below). Treating "not confirmed yet" the same as "failed"
        // here would turn ordinary Postgres latency (a Neon cold start, a slow query sharing the
        // pool) into a hard login failure even though the in-memory session this response's
        // cookie points to is already valid and immediately usable on this single API instance -
        // exactly the tradeoff docs/single-instance-store-ceiling.md already made deliberately
        // ("a failed save no longer reverts anything... discarding it was strictly worse than
        // keeping it"). A genuinely failed flush (the branch below, not this one) still fails
        // authentication closed.
        request.log.warn(
          {
            event: "auth.persistence_flush_deadline_exceeded",
            requestCorrelationId: request.id
          },
          "Persistence flush exceeded the response deadline; responding without waiting further."
        );
        return payload;
      }

      const syncFailure = readAccountSyncFailure(error);
      const hasAuthenticationCookies = reply.getHeader("set-cookie") !== undefined;
      if (syncFailure === null) {
        if (hasAuthenticationCookies) {
          reply.removeHeader("set-cookie");
          throw new AuthenticationPersistenceUnavailable();
        }
        throw error;
      }
      if (!hasAuthenticationCookies) {
        throw error;
      }

      request.log.error(
        {
          event: "auth.account_sync_degraded",
          operation: "persist_account_sync_change",
          accountId: syncFailure.accountId,
          attemptedCollection: syncFailure.attemptedCollection,
          constraintName: syncFailure.constraintName,
          requestCorrelationId: request.id,
          authenticationBlocked: false
        },
        "Authentication committed without the non-critical account sync journal."
      );
      return payload;
    }
    if (request.routeOptions.url === "/auth/pin/login") {
      request.log.info(
        {
          event: "auth.transaction_committed",
          requestCorrelationId: request.id
        },
        "PIN login transaction committed."
      );
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const elapsedMs = Math.max(0, reply.elapsedTime);
    const budgetClass = responseBudgetClass(request.method, request.url);
    reply.log.debug({ event: "http.response_timing", elapsedMs, budgetClass });
    options.metrics?.httpRequestDuration({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      durationSeconds: elapsedMs / 1000
    });
    if (budgetClass === "interactive" && elapsedMs > interactiveResponseBudgetMs) {
      request.log.warn(
        {
          event: "http.response_budget_exceeded",
          elapsedMs,
          budgetMs: interactiveResponseBudgetMs,
          method: request.method,
          route: request.routeOptions.url
        },
        "Interactive response exceeded its latency budget."
      );
    }
    if (
      request.routeOptions.url === "/auth/pin/login" &&
      reply.statusCode < 400 &&
      reply.getHeader("set-cookie") !== undefined
    ) {
      request.log.info(
        {
          event: "auth.session_cookie_returned",
          requestCorrelationId: request.id,
          statusCode: reply.statusCode
        },
        "PIN login session cookie returned."
      );
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const budgetClass = responseBudgetClass(request.method, request.url);
    const elapsedMs = Math.max(0, reply.elapsedTime);
    reply.header("server-timing", `app;dur=${elapsedMs.toFixed(1)}`);
    reply.header("x-grogoni-response-budget-class", budgetClass);
    if (budgetClass === "interactive") {
      reply.header("x-grogoni-response-budget-ms", String(interactiveResponseBudgetMs));
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationPersistenceUnavailable) {
      reply.removeHeader("set-cookie");
      return reply.code(503).send({
        code: error.code,
        message: error.message
      });
    }
    const syncFailure = readAccountSyncFailure(error);
    if (syncFailure === null) {
      return reply.send(error);
    }

    request.log.error(
      {
        operation:
          request.routeOptions.url === "/auth/pin/login"
            ? "phone_pin_owner_login"
            : "persist_account_sync_change",
        accountId: syncFailure.accountId,
        attemptedCollection: syncFailure.attemptedCollection,
        constraintName: syncFailure.constraintName,
        requestCorrelationId: request.id,
        code: "ACCOUNT_SYNC_INITIALIZATION_FAILED"
      },
      "Account sync persistence failed."
    );
    reply.removeHeader("set-cookie");
    return reply.code(503).send({
      code: "ACCOUNT_SYNC_INITIALIZATION_FAILED",
      message: "We could not finish setting up your account. Please try again."
    });
  });

  void app.register(async (routes) => {
    routes.get("/api", async () => ({
      service: "api" as const,
      status: "ok" as const,
      health: "/health" as const,
      liveness: "/health/live" as const,
      readiness: "/health/ready" as const
    }));

    routes.get(
      "/health",
      async (): Promise<
        HealthResponse & { agentDispatch: { configured: boolean; mode: "synchronous" } }
      > => {
        return {
          service: "api",
          status: "ok",
          timestamp: new Date().toISOString(),
          agentDispatch: {
            configured: options.agentRuntimeDiagnostic !== undefined,
            mode: "synchronous"
          }
        };
      }
    );

    routes.get("/health/live", async () => ({
      service: "api",
      status: "ok",
      timestamp: new Date().toISOString()
    }));

    routes.get("/health/ready", async (_request, reply) => {
      const [database, model] = await Promise.all([
        options.databaseHealth?.(),
        options.agentRuntimeDiagnostic?.(false)
      ]);
      const databaseOk = database === undefined || database.status === "ok";
      const inferenceEnabled = options.agentRuntimeDiagnostic !== undefined;
      const inferenceOk = model?.status === "ready";
      const ready =
        databaseOk && (options.inferenceRequired !== true || (inferenceEnabled && inferenceOk));
      if (!ready) reply.code(503);
      return {
        service: "api",
        status: ready ? "ready" : "unavailable",
        timestamp: new Date().toISOString(),
        dispatch: { mode: "synchronous" },
        database: {
          configured: options.databaseHealth !== undefined,
          ok: databaseOk,
          detail: database ?? null
        },
        inference: {
          enabled: inferenceEnabled,
          required: options.inferenceRequired === true,
          ok: inferenceEnabled ? inferenceOk : null,
          model: model ?? null
        },
        model: model ?? null
      };
    });

    if (options.agentRuntimeDiagnostic !== undefined) {
      const inferenceHealth = async (_request: FastifyRequest, reply: FastifyReply) => {
        const model = await options.agentRuntimeDiagnostic?.(true);
        if (model?.status !== "ready") reply.code(503);
        return {
          service: "api",
          status: model?.status === "ready" ? "ready" : "unavailable",
          timestamp: new Date().toISOString(),
          model
        };
      };
      routes.get("/health/ai", inferenceHealth);
      routes.get("/health/inference", inferenceHealth);
    }

    if (options.metrics !== undefined) {
      const metrics = options.metrics;
      routes.get("/metrics", async (request, reply) => {
        if (
          options.metricsAuthToken !== undefined &&
          request.headers["x-metrics-token"] !== options.metricsAuthToken
        ) {
          reply.code(401);
          return { code: "unauthorized", message: "Missing or invalid metrics token." };
        }
        reply.header("content-type", metrics.contentType);
        return metrics.metricsText();
      });
    }

    if (options.databaseHealth !== undefined) {
      routes.get("/health/db", async () => {
        const database = await options.databaseHealth?.();

        return {
          service: "api",
          timestamp: new Date().toISOString(),
          database
        };
      });
    }

    const store = registerCp2Routes(routes, {
      ...options.cp2,
      oauthAllowedRedirectOrigins:
        options.cp2?.oauthAllowedRedirectOrigins ?? oauthAllowedRedirectOrigins,
      realtimeAllowedOrigins: [...allowedCorsOrigins]
    });
    cp2Store = store;
    registerMcpRoutes(routes, {
      store,
      ...(options.cp2?.fulfillmentService === undefined
        ? {}
        : { fulfillmentService: options.cp2.fulfillmentService }),
      allowedOrigins: [...allowedCorsOrigins],
      publicOrigin: webPublicUrl
    });
    if (options.renderDeployWebhookSecret !== undefined) {
      registerRenderDeployWebhook(routes, {
        store,
        signingSecret: options.renderDeployWebhookSecret
      });
    }
  });

  const defaultWebRoot = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));
  const webRoot = options.webRoot === undefined ? defaultWebRoot : options.webRoot;
  if (process.env.NODE_ENV === "production" && webRoot !== false && !existsSync(webRoot)) {
    throw new Error(`Production web bundle is missing at ${webRoot}.`);
  }
  if (webRoot !== false && existsSync(webRoot)) {
    void app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      decorateReply: true,
      cacheControl: false,
      setHeaders(response, pathName) {
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
            "form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
            "font-src 'self' data:; manifest-src 'self'; worker-src 'self'; child-src 'self'; " +
            "connect-src 'self' https://*.grogoni.com wss://*.grogoni.com; upgrade-insecure-requests"
        );
        response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        response.setHeader(
          "Cache-Control",
          pathName.includes("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache, must-revalidate"
        );
      }
    });
    app.setNotFoundHandler((request, reply) => {
      const acceptsHtml = request.headers.accept?.includes("text/html") === true;
      if ((request.method === "GET" || request.method === "HEAD") && acceptsHtml) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({
        code: "route_not_found",
        message: "This API route does not exist."
      });
    });
  }

  return app;
}

export function responseBudgetClass(method: string, url: string): "interactive" | "long-running" {
  const pathname = url.split("?")[0] ?? url;
  if (
    pathname.startsWith("/v1/inference") ||
    pathname.startsWith("/v1/runtime/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/v1/webhooks/") ||
    pathname.includes("/imports") ||
    pathname.includes("/product-captures") ||
    pathname.includes("/improvement-runs") ||
    pathname.includes("/evaluations") ||
    method === "OPTIONS"
  ) {
    return "long-running";
  }
  return "interactive";
}

function readOAuthAllowedRedirectOrigins(fallback: string[]): string[] {
  const configured = process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;

  if (configured === undefined || configured.trim().length === 0) {
    return fallback;
  }

  const origins = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => new URL(origin).origin);

  return origins.length > 0 ? [...new Set(origins)] : fallback;
}

class PersistenceFlushDeadlineExceeded extends Error {}

class AuthenticationPersistenceUnavailable extends Error {
  readonly code = "AUTH_PERSISTENCE_UNAVAILABLE";

  constructor() {
    super("Authentication could not be saved safely. Please try again.");
    this.name = "AuthenticationPersistenceUnavailable";
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Only GET /v1/runtime/:taskId and GET /v1/runtime/:taskId/handoff (without a `version` query)
// can mutate: both resolve through RuntimeHandoffDomain.resolveHandoff(), which bootstraps a
// legacy task's first checkpoint the first time either is called for a task that predates the
// Runtime Handoff Protocol (see bootstrapLegacyHandoff in cp2/domains/runtime-handoff/store.ts).
// The same /handoff path with a `version` query instead calls getRuntimeHandoffByVersion
// (runtime-handoff/routes.ts), a pure read of an already-recorded checkpoint that never
// bootstraps. Every other GET under /v1/runtime/ - capabilities, transfer status, handoff-by-id -
// is likewise a pure read; postgres-store.ts's mutatingMethodNames deliberately excludes
// getRuntimeCapabilities/getRuntimeTransfer for exactly this reason (their own possible expiry
// side effect is idempotent and self-heals on the next real mutation's snapshot). Routing all of
// /v1/runtime/ through the flush wait below undid that: cp2Store.flush() drains one saveQueue
// shared by every tenant, so an unrelated business's slow write made this read wait on it and
// could time out into a false "Runtime unavailable" for a request that changed nothing.
const runtimeHandoffTaskGetPattern = /^\/v1\/runtime\/[^/]+$/;
const runtimeHandoffLatestGetPattern = /^\/v1\/runtime\/[^/]+\/handoff$/;
function requiresRuntimeDurabilityConfirmation(url: string): boolean {
  const [pathname = url, query = ""] = url.split("?");
  if (runtimeHandoffTaskGetPattern.test(pathname)) return true;
  if (!runtimeHandoffLatestGetPattern.test(pathname)) return false;
  return !new URLSearchParams(query).has("version");
}

// Bounds how long a response can be held open waiting on the shared persistence queue
// (Cp2Store.flush()). The queue's own retries are already timeout-bounded per attempt, but under
// a sustained outage it keeps re-queueing (see postgres-store.ts scheduleSaveRetry), so a request
// that lands behind a large backlog could otherwise wait indefinitely. This does not cancel the
// underlying flush - it keeps running - it only stops this response from waiting on it forever.
function withPersistenceFlushDeadline<T>(flush: Promise<T>, request: FastifyRequest): Promise<T> {
  const deadlineMs = positiveIntegerFromEnv("PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS", 8_000);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PersistenceFlushDeadlineExceeded());
    }, deadlineMs);
    timer.unref();
    flush.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  }).catch((error) => {
    if (error instanceof PersistenceFlushDeadlineExceeded) {
      // Keep observing the original flush in the background so a later real failure is still
      // logged (readAccountSyncFailure has already lost its chance to inform this response).
      flush.catch((flushError) => {
        request.log.error(
          { event: "auth.persistence_flush_failed_after_deadline", error: flushError },
          "Persistence flush failed after its response deadline had already elapsed."
        );
      });
    }
    throw error;
  });
}

function readAccountSyncFailure(error: unknown): {
  accountId: string;
  attemptedCollection: string;
  constraintName: string | null;
} | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "ACCOUNT_SYNC_INITIALIZATION_FAILED" ||
    !("persistenceStage" in error) ||
    error.persistenceStage !== "account_sync_journal" ||
    !("criticalAuthPersistenceCommitted" in error) ||
    error.criticalAuthPersistenceCommitted !== true
  ) {
    return null;
  }

  const record = error as Record<string, unknown>;
  if (typeof record.accountId !== "string" || typeof record.attemptedCollection !== "string") {
    return null;
  }

  return {
    accountId: record.accountId,
    attemptedCollection: record.attemptedCollection,
    constraintName: typeof record.constraintName === "string" ? record.constraintName : null
  };
}
