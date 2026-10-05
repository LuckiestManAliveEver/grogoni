/**
 * AI provider routes (docs/architecture/multi-provider-inference-implementation.md §13):
 *
 *   GET    /v1/ai/providers                          configured providers (no credential data)
 *   GET    /v1/ai/models                             provider-routed catalog models
 *
 *   GET    /v1/ai/device-inference/jobs/next         a device claims its account's on-device job
 *   POST   /v1/ai/device-inference/jobs/:id/result   ... and returns the generated text
 *   POST   /v1/ai/device-inference/jobs/:id/failure  ... or reports that it could not
 *   GET    /v1/ai/turn-stream/:turnId                live reply preview (server-sent events)
 *
 *   GET|PUT /v1/ai/policies/shop/:businessId         a shop's budget, limits, fallback policy
 *   GET|PUT /v1/ai/policies/me                       a person's own budget and limits
 *   GET|PUT /v1/platform/ai/policy                   platform caps (platform operators only)
 *   GET     /v1/platform/ai/providers                provider configuration (operators only)
 *   PUT|DELETE /v1/platform/ai/providers/:id         add/override/remove a provider (operators)
 *
 * The BYOK /v1/ai/provider-connections routes were removed with the hosted providers
 * (docs/local-first-cloud-audit.md); inference is local-only and takes no API keys.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AgentTurnStreamEvent,
  DeviceInferenceResultInput,
  DeviceInferenceRuntime
} from "@grogoni/shared-types";
import { isValidTurnId } from "../../../inference/turn-stream.js";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import { Cp2Error } from "../../cp2-error.js";
import { parseString, sendCp2Error } from "../../route-helpers.js";

interface IdParams {
  id: string;
}

export function registerInferenceProviderRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get("/v1/ai/providers", async (request, reply) => {
    try {
      return { providers: store.listInferenceProviders(readSessionCookie(request.headers.cookie)) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/v1/ai/models", async (request, reply) => {
    try {
      return { models: store.listInferenceModels(readSessionCookie(request.headers.cookie)) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
}

interface DeviceJobQuery {
  runtime?: string;
  models?: string;
  turnId?: string;
  waitMs?: string;
}

/** Device-local inference, turn streaming, policies and operator provider management. */
export function registerInferenceRuntimeRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/v1/ai/device-inference/jobs/next",
    async (request: FastifyRequest<{ Querystring: DeviceJobQuery }>, reply) => {
      try {
        const runtime: DeviceInferenceRuntime =
          request.query.runtime === "installed-app" ? "installed-app" : "browser-local";
        const availableModelIds = (request.query.models ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => /^[A-Za-z0-9._-]{1,120}$/u.test(entry))
          .slice(0, 20);
        const turnId = request.query.turnId;
        if (turnId !== undefined && !isValidTurnId(turnId)) {
          throw new Cp2Error(400, "turn_id_invalid", "turnId is invalid.");
        }
        const waitMs = Math.min(Math.max(Number(request.query.waitMs ?? 20_000) || 0, 0), 25_000);
        const aborted = new AbortController();
        request.raw.once("close", () => aborted.abort());
        const job = await store.claimDeviceInferenceJob({
          sessionId: readSessionCookie(request.headers.cookie),
          runtime,
          availableModelIds,
          ...(turnId === undefined ? {} : { turnId }),
          waitMs,
          signal: aborted.signal
        });
        if (job === null) return reply.code(204).send();
        // The job carries the member's own business context: never cache it anywhere.
        reply.header("cache-control", "no-store");
        return { job };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/ai/device-inference/jobs/:id/result",
    { bodyLimit: 256 * 1024 },
    async (
      request: FastifyRequest<{
        Params: IdParams;
        Body: Partial<DeviceInferenceResultInput>;
      }>,
      reply
    ) => {
      try {
        const body = request.body ?? {};
        return store.completeDeviceInferenceJob({
          sessionId: readSessionCookie(request.headers.cookie),
          jobId: request.params.id,
          result: {
            token: parseString(body.token, "token"),
            text: typeof body.text === "string" ? body.text : "",
            ...(body.usage === undefined ? {} : { usage: body.usage }),
            ...(typeof body.latencyMs === "number" ? { latencyMs: body.latencyMs } : {}),
            ...(typeof body.firstTokenMs === "number" ? { firstTokenMs: body.firstTokenMs } : {})
          }
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/ai/device-inference/jobs/:id/failure",
    async (request: FastifyRequest<{ Params: IdParams; Body: { token?: unknown } }>, reply) => {
      try {
        return store.failDeviceInferenceJob({
          sessionId: readSessionCookie(request.headers.cookie),
          jobId: request.params.id,
          token: parseString(request.body?.token, "token")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/ai/turn-stream/:turnId",
    async (request: FastifyRequest<{ Params: { turnId: string } }>, reply) => {
      let unsubscribe: (() => void) | null = null;
      try {
        if (!isValidTurnId(request.params.turnId)) {
          throw new Cp2Error(400, "turn_id_invalid", "turnId is invalid.");
        }
        const sessionId = readSessionCookie(request.headers.cookie);
        const events: AgentTurnStreamEvent[] = [];
        let write: ((event: AgentTurnStreamEvent) => void) | null = null;
        unsubscribe = store.subscribeAgentTurnStream({
          sessionId,
          turnId: request.params.turnId,
          listener: (event) => (write === null ? events.push(event) : write(event))
        });
        const stop = unsubscribe;
        reply.hijack();
        const headers: Record<string, string> = {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        };
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (name.startsWith("access-control-") && value !== undefined)
            headers[name] = String(value);
        }
        reply.raw.writeHead(200, headers);
        // Node sends nothing until the first write; open the stream now so the client sees it
        // established before the first token arrives.
        reply.raw.write(": connected\n\n");
        write = (event) => {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === "done") close();
        };
        const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
        const maxLifetime = setTimeout(() => close(), 5 * 60_000);
        const close = () => {
          clearInterval(heartbeat);
          clearTimeout(maxLifetime);
          stop();
          if (!reply.raw.writableEnded) reply.raw.end();
        };
        request.raw.once("close", close);
        for (const event of events.splice(0)) write(event);
        return reply;
      } catch (error) {
        unsubscribe?.();
        return sendCp2Error(reply, error);
      }
    }
  );

  const policyRoute = (
    method: "GET" | "PUT",
    url: string,
    scopeOf: (request: FastifyRequest<{ Params: { businessId?: string } }>) => {
      scope: "tenant" | "user" | "global";
      businessId?: string;
    }
  ) =>
    app.route<{ Params: { businessId?: string }; Body: unknown }>({
      method,
      url,
      handler: async (request, reply) => {
        try {
          const target = scopeOf(request);
          const sessionId = readSessionCookie(request.headers.cookie);
          return method === "GET"
            ? await store.getInferencePolicy({ sessionId, ...target })
            : await store.updateInferencePolicy({ sessionId, ...target, body: request.body });
        } catch (error) {
          return sendCp2Error(reply, error);
        }
      }
    });
  for (const method of ["GET", "PUT"] as const) {
    policyRoute(method, "/v1/ai/policies/shop/:businessId", (request) => ({
      scope: "tenant",
      businessId: request.params.businessId ?? ""
    }));
    policyRoute(method, "/v1/ai/policies/me", () => ({ scope: "user" }));
    policyRoute(method, "/v1/platform/ai/policy", () => ({ scope: "global" }));
  }

  app.get("/v1/platform/ai/providers", async (request, reply) => {
    try {
      return {
        providers: await store.listPlatformInferenceProviders(
          readSessionCookie(request.headers.cookie)
        )
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.put(
    "/v1/platform/ai/providers/:id",
    async (request: FastifyRequest<{ Params: IdParams; Body: unknown }>, reply) => {
      try {
        return await store.upsertPlatformInferenceProvider({
          sessionId: readSessionCookie(request.headers.cookie),
          id: request.params.id,
          body: request.body
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/v1/platform/ai/providers/:id",
    async (request: FastifyRequest<{ Params: IdParams }>, reply) => {
      try {
        return await store.removePlatformInferenceProvider({
          sessionId: readSessionCookie(request.headers.cookie),
          id: request.params.id
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
