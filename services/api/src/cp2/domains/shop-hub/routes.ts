/**
 * HTTP surface for the Shop Hub. Setup checks call the same domain methods the owner app and the
 * agent already use (catalogue, channel readiness, agent readiness, delivery corridors) under the
 * caller's own session, so they can never reveal more than that caller could read directly.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Cp2Error } from "../../cp2-error.js";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import { parseString, sendCp2Error, type BusinessParams } from "../../route-helpers.js";
import type { FulfillmentService } from "../fulfillment/service.js";
import { getShopCapabilities, type ShopSetupCheckResolvers } from "./capabilities.js";

export function registerShopHubRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  fulfillment: Pick<FulfillmentService, "listCorridors">
): void {
  app.get(
    "/businesses/:businessId/capabilities",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        const businessId = parseString(request.params.businessId, "businessId");
        const now = new Date();
        const role = store.getViewerRole({ sessionId, businessId, now });
        const actor = { sessionId, businessId, now };

        const checks: ShopSetupCheckResolvers = {
          catalog_products: async () =>
            store.listProducts(actor).length > 0 ? "ready" : "needs_setup",
          channels_linked: async () => {
            const external = store
              .listChannelProviderReadiness(actor)
              .filter((provider) => provider.provider !== "grogoni");
            if (external.some((provider) => provider.status === "available")) return "ready";
            return external.some((provider) => provider.status === "authorization_required")
              ? "needs_setup"
              : "unavailable";
          },
          agent_runtime: async () => {
            const readiness = store.getAgentRuntimeReadiness(actor);
            if (readiness.ready) return "ready";
            return readiness.issues.some((issue) => issue.actionable)
              ? "needs_setup"
              : "unavailable";
          },
          delivery_corridors: async () => {
            try {
              const corridors = await fulfillment.listCorridors(actor);
              return corridors.length > 0 ? "ready" : "needs_setup";
            } catch (error) {
              // Roles that can see deliveries but not plan them (a cashier) are not nagged about
              // corridors they could not draw anyway.
              if (error instanceof Cp2Error && error.statusCode === 403) return "ready";
              throw error;
            }
          }
        };

        return await getShopCapabilities({ businessId, role, checks, now });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
