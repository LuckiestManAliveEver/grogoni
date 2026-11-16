import type { FastifyInstance, FastifyRequest } from "fastify";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import {
  parseIntegerString,
  parseOptionalString,
  parseStringArray,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";

interface CatalogueMarketplaceParams extends BusinessParams {
  sourceBusinessId: string;
}

interface CatalogueMarketplaceSearchQuery {
  search?: string;
  limit?: string;
  offset?: string;
}

interface CatalogueDuplicateBody {
  productIds?: unknown[];
}

export function registerCatalogueSharingRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/businesses/:businessId/catalogue-marketplace/shops",
    async (
      request: FastifyRequest<{
        Params: BusinessParams;
        Querystring: CatalogueMarketplaceSearchQuery;
      }>,
      reply
    ) => {
      try {
        const search = parseOptionalString(request.query.search);
        const limit =
          request.query.limit === undefined
            ? undefined
            : parseIntegerString(request.query.limit, "limit");
        return store.listShareableCatalogues({
          sessionId: readSessionCookie(request.headers.cookie),
          viewerBusinessId: request.params.businessId,
          ...(search === undefined ? {} : { search }),
          ...(limit === undefined ? {} : { limit })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/catalogue-marketplace/shops/:sourceBusinessId/products",
    async (
      request: FastifyRequest<{
        Params: CatalogueMarketplaceParams;
        Querystring: CatalogueMarketplaceSearchQuery;
      }>,
      reply
    ) => {
      try {
        return store.listShareableCatalogueProducts({
          sessionId: readSessionCookie(request.headers.cookie),
          viewerBusinessId: request.params.businessId,
          sourceBusinessId: request.params.sourceBusinessId,
          ...(request.query.search === undefined
            ? {}
            : { search: parseOptionalString(request.query.search) ?? "" }),
          ...(request.query.offset === undefined ? {} : { offset: Number(request.query.offset) }),
          ...(request.query.limit === undefined
            ? {}
            : { limit: parseIntegerString(request.query.limit, "limit") })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/catalogue-marketplace/shops/:sourceBusinessId/duplicate",
    async (
      request: FastifyRequest<{ Params: CatalogueMarketplaceParams; Body: CatalogueDuplicateBody }>,
      reply
    ) => {
      try {
        return store.duplicateCatalogueProducts({
          sessionId: readSessionCookie(request.headers.cookie),
          viewerBusinessId: request.params.businessId,
          sourceBusinessId: request.params.sourceBusinessId,
          productIds: parseStringArray(request.body?.productIds, "productIds", 50)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
