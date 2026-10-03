/**
 * First domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md), mirroring the same-name split already
 * done on the store.ts side (services/api/src/cp2/domains/logistics/store.ts). Picked as the
 * first slice for the same reason it was picked first on the store.ts side: smallest route
 * footprint (3 routes) with zero cross-domain coupling.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FulfillmentMethod, FulfillmentStatus } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import {
  parseNullableString,
  parseRequestBody,
  parseString,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";

interface LogisticsParams extends BusinessParams {
  logisticsId: string;
}

interface LogisticsBody {
  invoiceId?: string;
  method?: string;
  destination?: string | null;
  note?: string | null;
}

interface LogisticsStatusBody {
  status?: string;
  note?: string | null;
}

export function registerLogisticsRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/businesses/:businessId/logistics",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listLogistics({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/logistics",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: LogisticsBody }>, reply) => {
      try {
        return store.createLogistics({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          logistics: parseLogisticsBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/logistics/:logisticsId",
    async (
      request: FastifyRequest<{ Params: LogisticsParams; Body: LogisticsStatusBody }>,
      reply
    ) => {
      try {
        return store.updateLogisticsStatus({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          logisticsId: request.params.logisticsId,
          status: parseLogisticsStatusBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

/** Exported for routes.ts's `parseSyncMutationPayload` offline-sync-replay dispatcher. */
export function parseLogisticsBody(body: LogisticsBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    invoiceId: parseString(record.invoiceId, "invoiceId"),
    method: parseFulfillmentMethod(record.method),
    destination: parseNullableString(record.destination),
    note: parseNullableString(record.note)
  };
}

/** Exported for routes.ts's `parseSyncMutationPayload` offline-sync-replay dispatcher. */
export function parseLogisticsStatusBody(body: LogisticsStatusBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    status: parseFulfillmentStatus(record.status),
    note: parseNullableString(record.note)
  };
}

function parseFulfillmentMethod(value: unknown): FulfillmentMethod {
  const method = parseString(value, "method");

  if (method === "delivery" || method === "pickup") {
    return method;
  }

  throw new Cp2Error(400, "fulfillment_method_invalid", "Fulfillment method is not supported.");
}

function parseFulfillmentStatus(value: unknown): FulfillmentStatus {
  const status = parseString(value, "status");

  if (
    status === "pending" ||
    status === "ready" ||
    status === "out_for_delivery" ||
    status === "completed" ||
    status === "cancelled"
  ) {
    return status;
  }

  throw new Cp2Error(400, "fulfillment_status_invalid", "Fulfillment status is not supported.");
}
