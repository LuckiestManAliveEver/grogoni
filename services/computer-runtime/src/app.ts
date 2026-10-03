import Fastify from "fastify";
import type { ComputerAction } from "@grogoni/shared-types";
import { PlaywrightComputerRuntime, type WorkerSessionInput } from "./playwright-runtime.js";

function bearer(value: string | undefined): string | null {
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export function buildComputerRuntimeApp(options: {
  serviceToken: string;
  runtime?: PlaywrightComputerRuntime;
}) {
  const app = Fastify({ logger: true, bodyLimit: 2_000_000 });
  const runtime = options.runtime ?? new PlaywrightComputerRuntime();
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (bearer(request.headers.authorization) !== options.serviceToken)
      return reply.code(401).send({ code: "UNAUTHORIZED" });
  });
  app.get("/health", async () => ({ ok: true, service: "computer-runtime" }));
  app.post<{ Body: WorkerSessionInput }>("/v1/sessions", async (request, reply) =>
    reply.code(201).send(await runtime.createSession(request.body))
  );
  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request) =>
    runtime.session(request.params.sessionId)
  );
  app.post<{ Params: { sessionId: string }; Body: ComputerAction }>(
    "/v1/sessions/:sessionId/navigate",
    async (request) => runtime.navigate({ ...request.body, sessionId: request.params.sessionId })
  );
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/observation",
    async (request) => runtime.observe(request.params.sessionId)
  );
  app.post<{
    Params: { sessionId: string };
    Body: { action: ComputerAction; actor: "agent" | "human" };
  }>("/v1/sessions/:sessionId/actions", async (request) =>
    runtime.act({ ...request.body.action, sessionId: request.params.sessionId }, request.body.actor)
  );
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/frame",
    async (request, reply) => {
      reply.header("cache-control", "no-store").type("image/jpeg");
      return runtime.frame(request.params.sessionId);
    }
  );
  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/control/take",
    async (request) => runtime.takeControl(request.params.sessionId)
  );
  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/control/release",
    async (request) => runtime.releaseControl(request.params.sessionId)
  );
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/storage-state",
    async (request) => ({ storageState: await runtime.storageState(request.params.sessionId) })
  );
  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/suspend",
    async (request) => {
      runtime.suspend(request.params.sessionId);
      return { suspended: true };
    }
  );
  app.post<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/resume", async (request) =>
    runtime.resume(request.params.sessionId)
  );
  app.delete<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request) => {
    await runtime.close(request.params.sessionId);
    return { closed: true };
  });
  app.addHook("onClose", async () => runtime.shutdown());
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof Error ? error.message : "COMPUTER_RUNTIME_ERROR";
    const status =
      code === "SESSION_NOT_FOUND"
        ? 404
        : code.endsWith("REJECTED") || code.endsWith("FORBIDDEN")
          ? 409
          : 400;
    void reply.code(status).send({ code, message: "Computer runtime request failed." });
  });
  return app;
}
