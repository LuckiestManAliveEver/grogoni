import type { FastifyInstance, FastifyRequest } from "fastify";
import { ModelRuntimeError, type ModelRuntimeAdapter } from "../inference/model-runtime.js";
import { Cp2Error } from "./cp2-error.js";
import { readSessionCookie, type Cp2Store } from "./store.js";
import { sendCp2Error } from "./route-helpers.js";
import { readChatImage } from "./chat-image-reader.js";

export function registerChatImageRoutes(
  app: FastifyInstance,
  store: Pick<Cp2Store, "getSession"> | null,
  resolveModel?: () => ModelRuntimeAdapter | undefined,
  authenticate?: (request: FastifyRequest) => Promise<{ accountId?: string } | null>
): void {
  app.post(
    "/v1/chat/images/read",
    {
      bodyLimit: 14_000_000,
      config: { rateLimit: { max: 12, timeWindow: 60_000 } }
    },
    async (request, reply) => {
      try {
        const session = authenticate
          ? await authenticate(request)
          : store?.getSession(readSessionCookie(request.headers.cookie));
        if (!session) throw new Cp2Error(401, "auth_required", "Authentication is required.");
        const accountId = "account" in session ? session.account.id : session.accountId;
        const result = await readChatImage(request.body, accountId, resolveModel);
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        if (error instanceof ModelRuntimeError)
          return sendCp2Error(
            reply,
            new Cp2Error(
              503,
              error.code,
              "Luna could not read this image right now. Please try again.",
              error.retryable
            )
          );
        return sendCp2Error(reply, error);
      }
    }
  );
}
