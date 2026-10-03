import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ContactSource, DeliveryRouteStatus, SupplierContactRole } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import {
  parseBoolean,
  parseNullableString,
  parseNumber,
  parseRequestBody,
  parseString,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";

interface ContactParams extends BusinessParams {
  contactId: string;
}
interface SupplierParams extends BusinessParams {
  supplierId: string;
}
interface RelationshipParams extends BusinessParams {
  relationshipId: string;
}
interface ProductParams extends BusinessParams {
  productId: string;
}
interface RouteParams extends BusinessParams {
  routeId: string;
}
interface Query {
  q?: string;
  productId?: string;
  supplierId?: string;
  customerId?: string;
  customerContactId?: string;
  includeHistorical?: string;
  destinationLocationId?: string;
}

export function registerCommercialRecordsRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/businesses/:businessId/contacts",
    async (request: FastifyRequest<{ Params: BusinessParams; Querystring: Query }>, reply) =>
      handle(reply, () =>
        store.listContacts({
          sessionId: session(request),
          businessId: request.params.businessId,
          query: request.query.q
        })
      )
  );
  app.get(
    "/businesses/:businessId/contacts/:contactId",
    async (request: FastifyRequest<{ Params: ContactParams }>, reply) =>
      handle(reply, () =>
        store.getContact({
          sessionId: session(request),
          businessId: request.params.businessId,
          contactId: request.params.contactId
        })
      )
  );
  const importContacts = async (
    request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>,
    reply: Parameters<typeof sendCp2Error>[0]
  ) =>
    handle(reply, () => {
      const body = parseRequestBody(request.body);
      return store.importContacts({
        sessionId: session(request),
        businessId: request.params.businessId,
        contacts: parseContacts(body.contacts),
        source: parseContactSource(body.source)
      });
    });
  app.post("/businesses/:businessId/contacts/import", importContacts);
  app.post("/businesses/:businessId/contacts/sync", importContacts);
  app.post(
    "/businesses/:businessId/contacts/:contactId/link",
    async (request: FastifyRequest<{ Params: ContactParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.linkContactAccount({
          sessionId: session(request),
          businessId: request.params.businessId,
          contactId: request.params.contactId,
          accountId: parseString(body.accountId, "accountId")
        });
      })
  );
  app.delete(
    "/businesses/:businessId/contacts/:contactId/link",
    async (request: FastifyRequest<{ Params: ContactParams }>, reply) =>
      handle(reply, () =>
        store.linkContactAccount({
          sessionId: session(request),
          businessId: request.params.businessId,
          contactId: request.params.contactId,
          accountId: null
        })
      )
  );

  app.get(
    "/businesses/:businessId/suppliers/:supplierId/contacts",
    async (request: FastifyRequest<{ Params: SupplierParams; Querystring: Query }>, reply) =>
      handle(reply, () =>
        store.listSupplierContacts({
          sessionId: session(request),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId,
          includeHistorical: request.query.includeHistorical === "true"
        })
      )
  );
  app.post(
    "/businesses/:businessId/suppliers/:supplierId/contacts",
    async (request: FastifyRequest<{ Params: SupplierParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.attachSupplierContact({
          sessionId: session(request),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId,
          contactId: parseString(body.contactId, "contactId"),
          role: parseSupplierRole(body.role),
          isPrimary:
            body.isPrimary === undefined ? false : parseBoolean(body.isPrimary, "isPrimary"),
          validFrom: typeof body.validFrom === "string" ? body.validFrom : undefined
        });
      })
  );
  app.delete(
    "/businesses/:businessId/supplier-contacts/:relationshipId",
    async (request: FastifyRequest<{ Params: RelationshipParams }>, reply) =>
      handle(reply, () =>
        store.detachSupplierContact({
          sessionId: session(request),
          businessId: request.params.businessId,
          relationshipId: request.params.relationshipId
        })
      )
  );

  app.post(
    "/businesses/:businessId/products/:productId/purchase-prices",
    async (request: FastifyRequest<{ Params: ProductParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.changePurchasePrice({
          sessionId: session(request),
          businessId: request.params.businessId,
          productId: request.params.productId,
          price: parseNumber(body.price, "price"),
          currency: optionalString(body.currency),
          supplierId: parseNullableString(body.supplierId),
          supplierContactId: parseNullableString(body.supplierContactId),
          effectiveAt: optionalString(body.effectiveAt),
          deliveredAt: parseNullableString(body.deliveredAt)
        });
      })
  );
  app.get(
    "/businesses/:businessId/products/:productId/purchase-prices",
    async (request: FastifyRequest<{ Params: ProductParams }>, reply) =>
      handle(reply, () =>
        store.listPurchasePriceHistory({
          sessionId: session(request),
          businessId: request.params.businessId,
          productId: request.params.productId
        })
      )
  );

  app.post(
    "/businesses/:businessId/purchases",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.createPurchase({
          sessionId: session(request),
          businessId: request.params.businessId,
          supplierId: parseString(body.supplierId, "supplierId"),
          supplierContactId: parseNullableString(body.supplierContactId),
          productId: parseString(body.productId, "productId"),
          quantity: parseNumber(body.quantity, "quantity"),
          unit: optionalString(body.unit),
          buyingPrice: parseNumber(body.buyingPrice, "buyingPrice"),
          currency: optionalString(body.currency),
          deliveredAt: parseNullableString(body.deliveredAt),
          effectiveAt: optionalString(body.effectiveAt),
          source: optionalString(body.source),
          notes: parseNullableString(body.notes),
          routeId: parseNullableString(body.routeId),
          locationId: parseNullableString(body.locationId),
          externalSourceId: parseNullableString(body.externalSourceId)
        });
      })
  );
  app.get(
    "/businesses/:businessId/purchases/history",
    async (request: FastifyRequest<{ Params: BusinessParams; Querystring: Query }>, reply) =>
      handle(reply, () =>
        store.listPurchaseHistory({
          sessionId: session(request),
          businessId: request.params.businessId,
          productId: request.query.productId,
          supplierId: request.query.supplierId
        })
      )
  );

  app.post(
    "/businesses/:businessId/sales",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.createSale({
          sessionId: session(request),
          businessId: request.params.businessId,
          customerId: parseNullableString(body.customerId),
          customerName: parseNullableString(body.customerName),
          customerContactId: parseNullableString(body.customerContactId),
          items: parseSaleItems(body.items),
          currency: optionalString(body.currency),
          soldAt: optionalString(body.soldAt),
          routeId: parseNullableString(body.routeId),
          externalSourceId: parseNullableString(body.externalSourceId)
        });
      })
  );
  app.get(
    "/businesses/:businessId/sales/history",
    async (request: FastifyRequest<{ Params: BusinessParams; Querystring: Query }>, reply) =>
      handle(reply, () =>
        store.listSalesHistory({
          sessionId: session(request),
          businessId: request.params.businessId,
          customerId: request.query.customerId,
          customerContactId: request.query.customerContactId
        })
      )
  );

  app.post(
    "/businesses/:businessId/routes",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.createDeliveryRoute({
          sessionId: session(request),
          businessId: request.params.businessId,
          origin: parseLocation(body.origin, "origin"),
          destination: parseLocation(body.destination, "destination"),
          stops: parseStops(body.stops),
          status: body.status === undefined ? undefined : parseRouteStatus(body.status),
          provider: optionalString(body.provider),
          externalRouteId: parseNullableString(body.externalRouteId),
          distanceMeters: optionalNumber(body.distanceMeters, "distanceMeters"),
          durationSeconds: optionalNumber(body.durationSeconds, "durationSeconds"),
          geometry: parseNullableString(body.geometry),
          externalSourceId: parseNullableString(body.externalSourceId)
        });
      })
  );
  app.patch(
    "/businesses/:businessId/routes/:routeId",
    async (request: FastifyRequest<{ Params: RouteParams; Body: unknown }>, reply) =>
      handle(reply, () => {
        const body = parseRequestBody(request.body);
        return store.updateDeliveryRoute({
          sessionId: session(request),
          businessId: request.params.businessId,
          routeId: request.params.routeId,
          status: parseRouteStatus(body.status)
        });
      })
  );
  app.get(
    "/businesses/:businessId/routes/history",
    async (request: FastifyRequest<{ Params: BusinessParams; Querystring: Query }>, reply) =>
      handle(reply, () =>
        store.listDeliveryRouteHistory({
          sessionId: session(request),
          businessId: request.params.businessId,
          destinationLocationId: request.query.destinationLocationId
        })
      )
  );
}

function session(request: FastifyRequest) {
  return readSessionCookie(request.headers.cookie);
}
async function handle<T>(reply: Parameters<typeof sendCp2Error>[0], action: () => T | Promise<T>) {
  try {
    return await action();
  } catch (error) {
    return sendCp2Error(reply, error);
  }
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function optionalNumber(value: unknown, name: string): number | null | undefined {
  return value === undefined ? undefined : value === null ? null : parseNumber(value, name);
}
function parseContactSource(value: unknown): ContactSource {
  const source = value === undefined ? "MANUAL" : parseString(value, "source").toUpperCase();
  if (!["PHONEBOOK", "EMAIL", "SOCIAL", "MANUAL", "GROGONI_ACCOUNT"].includes(source))
    throw new Cp2Error(400, "contact_source_invalid", "Contact source is not supported.");
  return source as ContactSource;
}
function parseSupplierRole(value: unknown): SupplierContactRole {
  const role = parseString(value, "role").toUpperCase();
  if (
    !["OWNER", "SALES_AGENT", "DELIVERY_AGENT", "DRIVER", "ACCOUNT_MANAGER", "OTHER"].includes(role)
  )
    throw new Cp2Error(
      400,
      "supplier_contact_role_invalid",
      "Supplier contact role is not supported."
    );
  return role as SupplierContactRole;
}
function parseRouteStatus(value: unknown): DeliveryRouteStatus {
  const status = parseString(value, "status").toUpperCase();
  if (!["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(status))
    throw new Cp2Error(400, "route_status_invalid", "Route status is not supported.");
  return status as DeliveryRouteStatus;
}
function parseStringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Cp2Error(
      400,
      "contact_fields_invalid",
      "Contact phone and email fields must be arrays of strings."
    );
  return value as string[];
}
function parseContacts(value: unknown) {
  if (!Array.isArray(value)) throw new Cp2Error(400, "contacts_required", "contacts is required.");
  return value.map((entry) => {
    const item = parseRequestBody(entry);
    return {
      displayName: parseString(item.displayName ?? item.name, "displayName"),
      givenName: parseNullableString(item.givenName),
      familyName: parseNullableString(item.familyName),
      phones: parseStringList(item.phones ?? (item.phone ? [item.phone] : [])),
      emails: parseStringList(item.emails ?? (item.email ? [item.email] : [])),
      source: item.source === undefined ? undefined : parseContactSource(item.source),
      sourceExternalId: parseNullableString(item.sourceExternalId),
      avatarRef: parseNullableString(item.avatarRef),
      externalIdentities: Array.isArray(item.externalIdentities)
        ? item.externalIdentities.map((identity) => {
            const record = parseRequestBody(identity);
            return {
              provider: parseString(record.provider, "provider"),
              externalId: parseString(record.externalId, "externalId")
            };
          })
        : []
    };
  });
}
function parseSaleItems(value: unknown) {
  if (!Array.isArray(value))
    throw new Cp2Error(400, "sale_items_required", "Sale items are required.");
  return value.map((entry) => {
    const item = parseRequestBody(entry);
    return {
      productId: parseString(item.productId, "productId"),
      quantity: parseNumber(item.quantity, "quantity"),
      unitPrice: parseNumber(item.unitPrice, "unitPrice")
    };
  });
}
function parseLocation(value: unknown, name: string) {
  const item = parseRequestBody(value);
  return {
    label: parseString(item.label, `${name}.label`),
    address: parseNullableString(item.address),
    latitude: optionalNumber(item.latitude, `${name}.latitude`),
    longitude: optionalNumber(item.longitude, `${name}.longitude`),
    region: parseNullableString(item.region),
    country: parseNullableString(item.country),
    providerPlaceId: parseNullableString(item.providerPlaceId),
    contactId: parseNullableString(item.contactId),
    arrivalAt: parseNullableString(item.arrivalAt),
    departureAt: parseNullableString(item.departureAt),
    deliveredAt: parseNullableString(item.deliveredAt)
  };
}
function parseStops(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Cp2Error(400, "route_stops_invalid", "Route stops must be an array.");
  return value.map((item, index) => parseLocation(item, `stops.${index}`));
}
