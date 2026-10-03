import type { FastifyInstance } from "fastify";
import {
  type Operation,
  type Entity,
  type OfflineOrderIntent,
  type OfflineOrderItemIntent,
  type OfflineOrderCustomerClaim
} from "@grogoni/offline-runtime";
import { type Cp2Store, readSessionCookie } from "./store.js";
import { Cp2Error } from "./cp2-error.js";
import { parseRequestBody, parseString, sendCp2Error } from "./route-helpers.js";
export function registerOfflineRuntimeRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get<{ Params: { businessId: string } }>(
    "/businesses/:businessId/offline-runtime/snapshot",
    async (request, reply) => {
      try {
        if (process.env.OFFLINE_RUNTIME_ENABLED !== "true")
          throw new Cp2Error(
            403,
            "offline_install_disabled",
            "New offline installations are disabled."
          );
        return store.getOfflineRuntimeSnapshot(
          readSessionCookie(request.headers.cookie),
          request.params.businessId
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  // Sync remains available when enrollment is disabled: existing devices must never be stranded.
  app.post<{ Body: { ops: unknown[] } }>("/sync/push", async (request, reply) => {
    try {
      const body = parseRequestBody(request.body);
      if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > 100)
        throw new Cp2Error(400, "offline_batch_invalid", "Send between 1 and 100 operations.");
      const results = [];
      for (const raw of body.ops) {
        const operation = parseOperation(raw);
        const deviceId = request.headers["x-grogoni-device-id"];
        if (typeof deviceId !== "string" || deviceId !== operation.deviceId)
          throw new Cp2Error(
            403,
            "offline_device_mismatch",
            "Device identity does not match the operation."
          );
        results.push(
          store.pushOfflineOperation(readSessionCookie(request.headers.cookie), operation)
        );
      }
      return { results };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.get<{ Querystring: { storeId: string; since?: string } }>(
    "/sync/pull",
    async (request, reply) => {
      try {
        return store.pullOfflineOperations(
          readSessionCookie(request.headers.cookie),
          parseString(request.query.storeId, "storeId"),
          request.query.since ?? null
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  // Same "sync stays available while enrollment is disabled" rule as /sync/push above: a device
  // that already captured BLE order intents must be able to reconcile them regardless of the
  // OFFLINE_RUNTIME_ENABLED install flag. Every intent carries its own accountId/storeId (like
  // Operation does for /sync/push) rather than trusting a single request-level scope.
  app.post<{ Body: { intents: unknown[] } }>("/sync/order-intents", async (request, reply) => {
    try {
      const body = parseRequestBody(request.body);
      if (!Array.isArray(body.intents) || body.intents.length < 1 || body.intents.length > 50)
        throw new Cp2Error(400, "offline_batch_invalid", "Send between 1 and 50 order intents.");
      const intents = body.intents.map(parseOfflineOrderIntent);
      const outcomes = store.pushOfflineOrderIntents(
        readSessionCookie(request.headers.cookie),
        intents
      );
      return { outcomes };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
}
function parseOperation(raw: unknown): Operation {
  const record = parseRequestBody(raw);
  const strings = [
    "id",
    "accountId",
    "storeId",
    "deviceId",
    "opType",
    "collection",
    "entityLocalId",
    "createdAtLocal"
  ];
  for (const key of strings)
    if (parseString(record[key], key).length > 200)
      throw new Cp2Error(400, "offline_operation_invalid", "Operation field is too long.");
  if (
    !Number.isSafeInteger(record.localSeq) ||
    Number(record.localSeq) < 1 ||
    Number.isNaN(Date.parse(String(record.createdAtLocal)))
  )
    throw new Cp2Error(
      400,
      "offline_operation_invalid",
      "Invalid operation sequence or timestamp."
    );
  if (
    ![
      "catalogue.create",
      "catalogue.update",
      "inventory.adjust",
      "customers.create",
      "receipts.ocr.create",
      "productCaptures.ocr.create",
      "orders.createInvoice",
      "orders.updateInvoice",
      "orders.confirmInvoice"
    ].includes(String(record.opType))
  )
    throw new Cp2Error(
      400,
      "offline_operation_unsupported",
      "This mutation is not supported offline."
    );
  const expected =
    record.opType === "customers.create"
      ? "customers"
      : record.opType === "receipts.ocr.create"
        ? "receiptOcrJobs"
        : record.opType === "productCaptures.ocr.create"
          ? "productCaptureJobs"
          : record.opType === "orders.createInvoice" ||
              record.opType === "orders.updateInvoice" ||
              record.opType === "orders.confirmInvoice"
            ? "invoices"
            : "products";
  if (record.collection !== expected)
    throw new Cp2Error(
      400,
      "offline_collection_invalid",
      "Operation collection does not match its domain."
    );
  const payload = parseRequestBody(record.payload);
  const base = record.base === null ? null : (parseRequestBody(record.base) as Entity);
  const entityCloudId =
    record.entityCloudId === null ? null : parseString(record.entityCloudId, "entityCloudId");
  return { ...record, payload, base, entityCloudId } as unknown as Operation;
}
function parseOfflineOrderIntent(raw: unknown): OfflineOrderIntent {
  const record = parseRequestBody(raw);
  for (const key of ["id", "accountId", "storeId"])
    if (parseString(record[key], key).length > 200)
      throw new Cp2Error(400, "offline_order_intent_invalid", "Order intent field is too long.");
  if (record.transport !== "ble" && record.transport !== "sms")
    throw new Cp2Error(400, "offline_order_intent_invalid", "Unsupported order intent transport.");
  if (Number.isNaN(Date.parse(String(record.receivedAtLocal))))
    throw new Cp2Error(400, "offline_order_intent_invalid", "Invalid order intent timestamp.");
  const claim = parseOfflineOrderCustomerClaim(record.customerClaim);
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 50)
    throw new Cp2Error(400, "offline_order_intent_invalid", "Send between 1 and 50 order items.");
  const items = record.items.map(parseOfflineOrderItemIntent);
  return {
    id: parseString(record.id, "id"),
    accountId: parseString(record.accountId, "accountId"),
    storeId: parseString(record.storeId, "storeId"),
    transport: record.transport,
    customerClaim: claim,
    items,
    paymentMethod:
      record.paymentMethod === null || record.paymentMethod === undefined
        ? null
        : parseString(record.paymentMethod, "paymentMethod"),
    paymentReference:
      record.paymentReference === null || record.paymentReference === undefined
        ? null
        : parseString(record.paymentReference, "paymentReference"),
    note:
      record.note === null || record.note === undefined ? null : parseString(record.note, "note"),
    receivedAtLocal: String(record.receivedAtLocal),
    rawText:
      record.rawText === null || record.rawText === undefined
        ? null
        : parseString(record.rawText, "rawText")
  };
}
function parseOfflineOrderCustomerClaim(raw: unknown): OfflineOrderCustomerClaim {
  const record = parseRequestBody(raw);
  const displayName =
    record.displayName === null || record.displayName === undefined
      ? null
      : parseString(record.displayName, "displayName");
  if (record.type === "account")
    return { type: "account", accountId: parseString(record.accountId, "accountId"), displayName };
  if (record.type === "phone")
    return { type: "phone", phone: parseString(record.phone, "phone"), displayName };
  throw new Cp2Error(400, "offline_order_intent_invalid", "Invalid customer claim.");
}
function parseOfflineOrderItemIntent(raw: unknown): OfflineOrderItemIntent {
  const record = parseRequestBody(raw);
  if (
    typeof record.quantity !== "number" ||
    !Number.isFinite(record.quantity) ||
    record.quantity <= 0
  )
    throw new Cp2Error(400, "offline_order_intent_invalid", "Invalid order item quantity.");
  let quotedUnitPrice: number | null = null;
  if (record.quotedUnitPrice !== null && record.quotedUnitPrice !== undefined) {
    if (typeof record.quotedUnitPrice !== "number" || !Number.isFinite(record.quotedUnitPrice))
      throw new Cp2Error(400, "offline_order_intent_invalid", "Invalid quoted unit price.");
    quotedUnitPrice = record.quotedUnitPrice;
  }
  return {
    productCloudId:
      record.productCloudId === null || record.productCloudId === undefined
        ? null
        : parseString(record.productCloudId, "productCloudId"),
    name: parseString(record.name, "name"),
    quantity: record.quantity,
    quotedUnitPrice
  };
}
