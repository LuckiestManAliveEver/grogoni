/**
 * Route module for the external-connections domain (services/api/src/cp2/domains/external-connections/).
 * Mirrors domains/oauth/routes.ts's shape: a plain `register*Routes(app, store, ...)` function
 * wired into services/api/src/cp2/routes.ts next to `registerOAuthRoutes`. Every handler here
 * only ever returns the public `ExternalRegistryConnection` summary (via store.ts's
 * externalConnectionView) - never the encrypted or plaintext token - and `resolveToken` is not
 * imported here at all, so there is no route path that can reach it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import { Cp2Error } from "../../cp2-error.js";
import { enforceAuthIpRate, parseString, sendCp2Error } from "../../route-helpers.js";
import { parseExternalRegistryProvider } from "./shared.js";

interface ConnectBody {
  token?: string;
}

interface ConnectParams {
  provider: string;
}

interface DisconnectParams {
  id: string;
}

export function registerExternalConnectionsRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  authAttemptsByIp: Map<string, number[]>
): void {
  app.get("/v1/external-connections", async (request, reply) => {
    try {
      return {
        connections: store.listExternalConnections({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/v1/external-connections/:provider",
    async (request: FastifyRequest<{ Params: ConnectParams; Body: ConnectBody }>, reply) => {
      try {
        const provider = parseExternalRegistryProvider(request.params.provider);
        if (provider === null) {
          throw new Cp2Error(
            400,
            "external_connection_provider_invalid",
            "External registry provider is not supported."
          );
        }
        enforceAuthIpRate(authAttemptsByIp, request, `external_connection_${provider}`, 10);
        const token = parseString(request.body?.token, "token");
        return await store.connectExternalConnection({
          sessionId: readSessionCookie(request.headers.cookie),
          provider,
          token
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/v1/external-connections/:id",
    async (request: FastifyRequest<{ Params: DisconnectParams }>, reply) => {
      try {
        return store.disconnectExternalConnection({
          sessionId: readSessionCookie(request.headers.cookie),
          id: request.params.id
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
