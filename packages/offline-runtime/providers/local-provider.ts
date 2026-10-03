import {
  normalizeProductInput,
  validateProductInput,
  normalizeContactRecordInput,
  validateContactRecordInput,
  validateStockAdjustmentInput,
  validateInvoiceInput,
  createInvoicePreview,
  type ProductInput,
  type ContactRecordInput,
  type StockAdjustmentInput,
  type InvoiceInput
} from "@grogoni/business-core";
import {
  productCaptureImageContentTypes,
  type ProductCaptureImageContentType,
  type ProductSummary,
  type CustomerSummary
} from "@grogoni/shared-types";
import type { LocalDatabase } from "../db/client.js";
import { recordOperation } from "../sync/writer.js";
import {
  OfflineError,
  type Scope,
  type Collection,
  type Entity,
  type RuntimePin,
  type ReceiptOcrExtraction,
  type LocalState,
  type MirrorRow
} from "../types.js";
import { receiptOcrJobEntity } from "./receipt-ocr-entity.js";
import { productCaptureJobEntity } from "./product-capture-entity.js";
import type { GrogoniProvider } from "./types.js";

export const localReads: Record<string, Collection> = {
  "catalogue.list": "products",
  "customers.list": "customers",
  "invoices.list": "invoices",
  "orders.list": "orders",
  "catalogue.fields": "productFields",
  "receipts.ocr.list": "receiptOcrJobs",
  "productCaptures.ocr.list": "productCaptureJobs"
};
const writes = [
  "catalogue.create",
  "catalogue.update",
  "inventory.adjust",
  "customers.create",
  "orders.createInvoice",
  "orders.updateInvoice",
  "orders.confirmInvoice"
];
export type ReceiptOcrEngine = (input: {
  fileName: string;
  contentType: string;
  contentBase64: string;
}) => Promise<ReceiptOcrExtraction>;
export class LocalProvider implements GrogoniProvider {
  readonly name = "local";
  constructor(
    private db: LocalDatabase,
    private scope: Scope,
    private infer?: (pin: RuntimePin, args: unknown) => Promise<unknown>,
    private ocr?: ReceiptOcrEngine
  ) {}
  supports(op: string): boolean {
    return (
      Object.hasOwn(localReads, op) ||
      writes.includes(op) ||
      (op === "agent.infer" && !!this.infer) ||
      (op === "receipts.ocr.create" && !!this.ocr) ||
      (op === "productCaptures.ocr.create" && !!this.ocr)
    );
  }
  async isAvailable(): Promise<boolean> {
    const state = await this.db.read(this.scope);
    return state.installed && state.offlineModeActive;
  }
  async call<T>(op: string, args: unknown): Promise<T> {
    const state = await this.db.read(this.scope);
    if (!state.installed || !state.offlineModeActive)
      throw new OfflineError("PROVIDER_UNAVAILABLE", "The offline runtime is not active.");
    if (op === "agent.infer") {
      if (!state.pin?.active || !this.infer)
        throw new OfflineError(
          "MODEL_NOT_INSTALLED",
          "No compatible pinned model is installed on this device."
        );
      return (await this.infer(state.pin, args)) as T;
    }
    const collection = localReads[op];
    if (collection) {
      const rows = state.rows
        .filter((row) => row.collection === collection)
        .map((row) => row.payload);
      return (
        op === "catalogue.fields"
          ? (rows[0] ?? { businessId: this.scope.storeId, fields: [] })
          : rows
      ) as T;
    }
    const input = (args ?? {}) as { id?: string; body?: Record<string, unknown> };
    const body = input.body ?? {};
    const id = input.id ?? crypto.randomUUID();
    if (op === "catalogue.create" || op === "catalogue.update") {
      const product = body as unknown as ProductInput;
      validate(validateProductInput(product));
      return (await recordOperation(
        this.db,
        this.scope,
        { opType: op, collection: "products", entityLocalId: id, payload: body },
        (current, operation) => {
          const existing = current.rows.find((row) => row.local_id === operation.entityLocalId);
          if (op === "catalogue.update" && !existing)
            throw new Error("This product is not in the downloaded snapshot.");
          return {
            ...existing?.payload,
            ...normalizeProductInput(product),
            id: existing?.payload.id ?? id,
            businessId: this.scope.storeId,
            primaryMediaId: existing?.payload.primaryMediaId ?? null,
            createdAt: existing?.payload.createdAt ?? operation.createdAtLocal,
            updatedAt: operation.createdAtLocal
          };
        }
      )) as T;
    }
    if (op === "customers.create") {
      const customer = body as unknown as ContactRecordInput;
      validate(validateContactRecordInput(customer, "Customer"));
      return (await recordOperation(
        this.db,
        this.scope,
        { opType: op, collection: "customers", entityLocalId: id, payload: body },
        (_current, operation) => ({
          ...normalizeContactRecordInput(customer),
          id,
          businessId: this.scope.storeId,
          linkedAccountId: null,
          createdAt: operation.createdAtLocal,
          updatedAt: operation.createdAtLocal
        })
      )) as T;
    }
    if (op === "orders.createInvoice" || op === "orders.updateInvoice") {
      const invoiceInput = body as unknown as InvoiceInput;
      validate(validateInvoiceInput(invoiceInput));
      return (await recordOperation(
        this.db,
        this.scope,
        { opType: op, collection: "invoices", entityLocalId: id, payload: body },
        (current, operation) => {
          const existing = current.rows.find((row) => row.local_id === operation.entityLocalId);
          if (op === "orders.updateInvoice") {
            if (!existing) throw new Error("This invoice is not in the downloaded snapshot.");
            if (existing.payload.status !== "draft")
              throw new Error("Confirmed invoices cannot be edited.");
          }
          for (const item of invoiceInput.items)
            if (!findRow(current, "products", item.productId))
              throw new Error("This product is not in the downloaded snapshot.");
          const customer =
            invoiceInput.customerId === undefined || invoiceInput.customerId === null
              ? null
              : (findRow(current, "customers", invoiceInput.customerId)?.payload ?? null);
          if (invoiceInput.customerId && !customer)
            throw new Error("This customer is not in the downloaded snapshot.");
          const products = current.rows
            .filter((row) => row.collection === "products")
            .map((row) => row.payload as unknown as ProductSummary);
          const preview = createInvoicePreview({
            businessId: this.scope.storeId,
            invoice: invoiceInput,
            products,
            customer: customer as unknown as CustomerSummary | null
          });
          const invoiceId = (existing?.payload.id as string | undefined) ?? id;
          return {
            id: invoiceId,
            businessId: this.scope.storeId,
            invoiceNumber: existing?.payload.invoiceNumber ?? "Pending sync",
            status: "draft",
            customerId: preview.customerId,
            customerName: preview.customerName,
            items: preview.items.map((item, index) => ({
              ...item,
              id: `${invoiceId}-item-${index}`,
              invoiceId
            })),
            subtotal: preview.subtotal,
            taxRate: preview.taxRate,
            taxTotal: preview.taxTotal,
            total: preview.total,
            confirmedAt: null,
            createdAt: existing?.payload.createdAt ?? operation.createdAtLocal,
            updatedAt: operation.createdAtLocal
          };
        }
      )) as T;
    }
    if (op === "orders.confirmInvoice") {
      return (await recordOperation(
        this.db,
        this.scope,
        { opType: op, collection: "invoices", entityLocalId: id, payload: {} },
        (current, operation) => {
          const existing = current.rows.find((row) => row.local_id === operation.entityLocalId);
          if (!existing) throw new Error("This invoice is not in the downloaded snapshot.");
          if (existing.payload.status !== "draft") throw new Error("Invoice is already confirmed.");
          const items =
            (existing.payload.items as Array<{ productId: string; quantity: number }>) ?? [];
          const required = new Map<string, number>();
          for (const item of items)
            required.set(item.productId, (required.get(item.productId) ?? 0) + item.quantity);
          for (const [productId, quantity] of required) {
            const product = findRow(current, "products", productId);
            if (product && Number(product.payload.quantity) < quantity)
              throw new Error(
                `${product.payload.name} has ${product.payload.quantity} ${product.payload.unit} available as of your last sync. Reconnect and sync to confirm against current stock.`
              );
          }
          // The stock decrement itself is not applied here - it happens once, authoritatively,
          // when this operation reaches confirmInvoice on the server (same reasoning as
          // receipts.ocr.create: a locally optimistic decrement across N product rows would mark
          // them dirty with no operation of their own to clear that flag on ack, permanently
          // blocking future pulls for those products - see sync/client.ts's `if (row?.dirty)
          // continue`). The invoice's own local status flips immediately for feedback; stock
          // updates arrive on the next sync via the ordinary product pull, same as any other
          // device's sale.
          return {
            ...existing.payload,
            status: "confirmed",
            confirmedAt: operation.createdAtLocal,
            updatedAt: operation.createdAtLocal
          };
        }
      )) as T;
    }
    if (op === "receipts.ocr.create") {
      if (!this.ocr)
        throw new OfflineError(
          "OCR_NOT_INSTALLED",
          "The on-device receipt scanner is not installed on this device."
        );
      const capture = validateOfflineImageCapture(body, {
        subject: "receipt photo",
        rejectPdfMessage:
          "PDF receipts need an online connection. Photograph the receipt instead, or reconnect."
      });
      const { fileName, contentType } = capture;
      const extraction = await this.ocr(capture);
      return (await recordOperation(
        this.db,
        this.scope,
        {
          opType: op,
          collection: "receiptOcrJobs",
          entityLocalId: id,
          payload: { fileName, contentType, extractedText: extraction.fullText, extraction }
        },
        (_current, operation) =>
          receiptOcrJobEntity(
            id,
            this.scope.storeId,
            this.scope.accountId,
            fileName,
            contentType,
            extraction,
            operation.createdAtLocal
          )
      )) as T;
    }
    if (op === "productCaptures.ocr.create") {
      if (!this.ocr)
        throw new OfflineError(
          "OCR_NOT_INSTALLED",
          "The on-device scanner is not installed on this device."
        );
      const capture = validateOfflineImageCapture(body, { subject: "product photo" });
      const { fileName, contentType } = capture;
      const extraction = await this.ocr(capture);
      return (await recordOperation(
        this.db,
        this.scope,
        {
          opType: op,
          collection: "productCaptureJobs",
          entityLocalId: id,
          payload: {
            fileName,
            contentType,
            extractedText: extraction.fullText,
            averageConfidence: extraction.averageConfidence
          }
        },
        (current, operation) =>
          productCaptureJobEntity(
            id,
            this.scope.storeId,
            this.scope.accountId,
            fileName,
            contentType,
            extraction.fullText,
            extraction.averageConfidence,
            current.rows
              .filter((row) => row.collection === "products")
              .map((row) => row.payload as unknown as ProductSummary),
            operation.createdAtLocal
          )
      )) as T;
    }
    if (op === "inventory.adjust") {
      validate(validateStockAdjustmentInput(body as unknown as StockAdjustmentInput));
      let quantityBefore = 0;
      let movementId = "";
      const product = await recordOperation(
        this.db,
        this.scope,
        { opType: op, collection: "products", entityLocalId: id, payload: body },
        (current, operation): Entity => {
          const existing = current.rows.find((row) => row.local_id === operation.entityLocalId);
          if (!existing) throw new Error("This product is not in the downloaded snapshot.");
          quantityBefore = Number(existing.payload.quantity);
          movementId = operation.id;
          return {
            ...existing.payload,
            quantity: body.quantityAfter,
            updatedAt: operation.createdAtLocal
          };
        }
      );
      return {
        product,
        movement: {
          id: movementId,
          businessId: this.scope.storeId,
          productId: product.id,
          type: "manual_adjustment",
          quantityBefore,
          quantityAfter: product.quantity,
          delta: Number(product.quantity) - quantityBefore,
          reason: body.reason ?? "Manual stock count",
          actorId: this.scope.deviceId,
          createdAt: product.updatedAt
        }
      } as T;
    }
    throw new OfflineError("OPERATION_UNAVAILABLE", "This action needs an online connection.");
  }
}
function validate(result: { ok: boolean; errors: string[] }): void {
  if (!result.ok) throw new OfflineError("VALIDATION_FAILED", result.errors.join(" "));
}
/**
 * Shared presence/type/size/encoding validation for both receipts.ocr.create and
 * productCaptures.ocr.create - the two offline image-capture ops differ only in their subject
 * noun for error copy and whether PDF gets a dedicated redirect-to-online message (receipts) or
 * falls into the generic unsupported-type message (product capture, which never accepted PDF even
 * online). Kept as one function so a validation fix (the size bound, the base64 charset) never has
 * to be applied to two near-identical copies by hand.
 */
function validateOfflineImageCapture(
  body: unknown,
  options: { subject: string; rejectPdfMessage?: string }
): { fileName: string; contentType: ProductCaptureImageContentType; contentBase64: string } {
  const capture = body as unknown as {
    fileName?: string;
    contentType?: string;
    contentBase64?: string;
  };
  if (
    typeof capture.fileName !== "string" ||
    !capture.fileName.trim() ||
    typeof capture.contentType !== "string" ||
    !capture.contentType.trim() ||
    typeof capture.contentBase64 !== "string" ||
    !capture.contentBase64.trim()
  )
    throw new OfflineError("VALIDATION_FAILED", `A ${options.subject} is required.`);
  if (options.rejectPdfMessage && capture.contentType === "application/pdf")
    throw new OfflineError("OPERATION_UNAVAILABLE", options.rejectPdfMessage);
  if (!(productCaptureImageContentTypes as readonly string[]).includes(capture.contentType))
    throw new OfflineError(
      "OPERATION_UNAVAILABLE",
      `Use a JPEG, PNG or WebP ${options.subject} offline. This file type needs an online connection.`
    );
  if (capture.contentBase64.length > 4 * Math.ceil((10 * 1024 * 1024) / 3))
    throw new OfflineError(
      "VALIDATION_FAILED",
      `${options.subject[0]!.toUpperCase()}${options.subject.slice(1)}s must be 10 MB or smaller.`
    );
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(capture.contentBase64) ||
    capture.contentBase64.length % 4 !== 0
  )
    throw new OfflineError("VALIDATION_FAILED", `The ${options.subject} content is invalid.`);
  return {
    fileName: capture.fileName,
    contentType: capture.contentType as ProductCaptureImageContentType,
    contentBase64: capture.contentBase64
  };
}
/** A referenced id may be a local placeholder (not yet synced) or the real cloud id, exactly like
 *  recordOperation's own existing-row lookup - so every cross-entity reference must check both. */
function findRow(state: LocalState, collection: Collection, id: string): MirrorRow | undefined {
  return state.rows.find(
    (row) => row.collection === collection && (row.local_id === id || row.cloud_id === id)
  );
}
