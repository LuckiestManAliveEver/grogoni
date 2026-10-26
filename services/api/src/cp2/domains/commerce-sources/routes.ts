import type { FastifyInstance } from "fastify";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import { sendCp2Error } from "../../route-helpers.js";
import { Cp2Error } from "../../cp2-error.js";
export function registerCommerceSourceRoutes(app: FastifyInstance, store: Cp2Store) {
  app.get<{ Params: { businessId: string } }>(
    "/businesses/:businessId/commerce-sources/fulfillments",
    async (request, reply) => {
      try {
        return store.listSourceFulfillments({
          businessId: request.params.businessId,
          sessionId: readSessionCookie(request.headers.cookie)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Params: { businessId: string } }>(
    "/businesses/:businessId/commerce-sources/distribution",
    async (request, reply) => {
      try {
        return store.commerceDistributionDirectory({
          businessId: request.params.businessId,
          sessionId: readSessionCookie(request.headers.cookie)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{
    Params: { businessId: string; sourceId: string };
    Body: { action?: string; feed?: unknown };
  }>("/businesses/:businessId/commerce-sources/:sourceId/refresh", async (request, reply) => {
    try {
      const actor = {
        businessId: request.params.businessId,
        sessionId: readSessionCookie(request.headers.cookie)
      };
      if (request.body?.action === "import")
        return store.importCommerceFeed(actor, request.params.sourceId, request.body.feed);
      if (request.body?.action !== "verify" && request.body?.action !== "refresh")
        throw new Cp2Error(400, "commerce_action_invalid", "Choose verify, refresh or import.");
      return await store.refreshCommerceSource(actor, request.params.sourceId, request.body.action);
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.post<{ Params: { businessId: string }; Body: { identity?: unknown } }>(
    "/businesses/:businessId/commerce-sources/match",
    async (request, reply) => {
      try {
        return store.matchCommerceProducts(
          {
            businessId: request.params.businessId,
            sessionId: readSessionCookie(request.headers.cookie)
          },
          request.body?.identity
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string }; Body: { description?: string } }>(
    "/businesses/:businessId/commerce-sources/describe",
    async (request, reply) => {
      try {
        return store.describeCommerceCatalogue(
          {
            businessId: request.params.businessId,
            sessionId: readSessionCookie(request.headers.cookie)
          },
          request.body?.description ?? ""
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Params: { businessId: string } }>(
    "/businesses/:businessId/commerce-sources/gallery",
    async (request, reply) => {
      try {
        return store.listGalleryCaptures({
          businessId: request.params.businessId,
          sessionId: readSessionCookie(request.headers.cookie)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Params: { businessId: string } }>(
    "/businesses/:businessId/commerce-sources",
    async (request, reply) => {
      try {
        return store.listCommerceSources({
          businessId: request.params.businessId,
          sessionId: readSessionCookie(request.headers.cookie)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string }; Body: { operation?: unknown; values?: unknown } }>(
    "/businesses/:businessId/commerce-sources/operations",
    async (request, reply) => {
      try {
        if (
          typeof request.body?.operation !== "string" ||
          !request.body.values ||
          typeof request.body.values !== "object" ||
          Array.isArray(request.body.values)
        )
          throw new Cp2Error(
            400,
            "commerce_input_invalid",
            "Provide an operation and values object."
          );
        return await store.executeSourceCommerce(
          {
            businessId: request.params.businessId,
            sessionId: readSessionCookie(request.headers.cookie)
          },
          request.body.operation,
          request.body.values as Record<string, unknown>
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Querystring: { query?: string } }>("/public/commerce-offers", async (request) =>
    store.searchPublishedOffers({ query: request.query.query ?? "" })
  );
}
