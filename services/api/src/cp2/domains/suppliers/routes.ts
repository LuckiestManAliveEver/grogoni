/**
 * Fifth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Needs `binaryUploadPipeline`/
 * binary upload pipeline (derived once in `registerCp2Routes` from `Cp2RouteOptions`) passed
 * in as parameters. `decodeReceiptBase64` is exported since `domains/document-imports/routes.ts`
 * (not yet extracted) calls it too - a genuine cross-domain reference, not duplicated logic.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { OcrBlockSummary, OcrEngine, OcrProfile } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import type { BinaryUploadPipeline } from "../../binary-upload-pipeline.js";
import {
  parseBoolean,
  parseContactRecordBody,
  parseNullableString,
  parsePositiveInteger,
  parseRequestBody,
  parseString,
  sendCp2Error,
  type BusinessParams,
  type ContactRecordBody
} from "../../route-helpers.js";

interface SupplierParams extends BusinessParams {
  supplierId: string;
}

interface SalesAgentParams extends BusinessParams {
  salesAgentId: string;
}

interface SupplierSalesAgentParams extends SupplierParams {
  salesAgentId: string;
}

interface ReceiptOCRParams extends BusinessParams {
  ocrJobId: string;
}

interface PurchaseReceiptParams extends BusinessParams {
  receiptId: string;
}

interface PhonebookSearchQuery {
  q?: string;
}

interface PhonebookLinkBody {
  networkNodeId?: string;
  notes?: string | null;
}

interface ReceiptOCRBody {
  fileName?: string;
  contentType?: string;
  contentBase64?: string;
  extractedText?: string;
  fileSizeBytes?: number;
  fileSignature?: string;
}

interface ReceiptOCRConfirmBody {
  supplierId?: string | null;
  salesAgentId?: string | null;
  createSupplier?: boolean;
  createSalesAgent?: boolean;
}

interface ReceiptOCRCorrectionBody {
  extractedText?: string;
}

export interface ToolExtractionResult {
  engine: OcrEngine;
  engineVersion: string;
  modelVersion: string;
  profile: OcrProfile;
  fallbackUsed: boolean;
  blocks: OcrBlockSummary[];
  fullText: string;
  averageConfidence: number;
  warnings: string[];
}

export function registerSuppliersRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  binaryUploadPipeline: BinaryUploadPipeline | undefined
): void {
  app.get(
    "/businesses/:businessId/suppliers",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listSuppliers({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/suppliers",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: ContactRecordBody }>, reply) => {
      try {
        return store.createSupplier({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplier: parseContactRecordBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/suppliers/:supplierId",
    async (request: FastifyRequest<{ Params: SupplierParams; Body: ContactRecordBody }>, reply) => {
      try {
        return store.updateSupplier({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId,
          supplier: parseContactRecordBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/businesses/:businessId/suppliers/:supplierId",
    async (request: FastifyRequest<{ Params: SupplierParams }>, reply) => {
      try {
        return store.deleteSupplier({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/suppliers/phonebook/search",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Querystring: PhonebookSearchQuery }>,
      reply
    ) => {
      try {
        return store.searchSupplierPhonebookContacts({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          query: request.query.q ?? ""
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/suppliers/from-phonebook",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: PhonebookLinkBody }>, reply) => {
      try {
        const body = parsePhonebookLinkBody(request.body);
        return store.createSupplierFromPhoneContact({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          networkNodeId: body.networkNodeId,
          notes: body.notes
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/suppliers/:supplierId/link-contact",
    async (request: FastifyRequest<{ Params: SupplierParams; Body: PhonebookLinkBody }>, reply) => {
      try {
        return store.linkSupplierContact({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId,
          networkNodeId: parsePhonebookLinkBody(request.body).networkNodeId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/suppliers/:supplierId/sales-agents",
    async (request: FastifyRequest<{ Params: SupplierParams }>, reply) => {
      try {
        return store.listSalesAgents({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/suppliers/:supplierId/sales-agents",
    async (request: FastifyRequest<{ Params: SupplierParams; Body: ContactRecordBody }>, reply) => {
      try {
        return store.createSalesAgent({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId,
          agent: parseContactRecordBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/suppliers/:supplierId/sales-agents/from-phonebook",
    async (request: FastifyRequest<{ Params: SupplierParams; Body: PhonebookLinkBody }>, reply) => {
      try {
        const body = parsePhonebookLinkBody(request.body);
        return store.createSalesAgentFromPhoneContact({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supplierId: request.params.supplierId,
          networkNodeId: body.networkNodeId,
          notes: body.notes
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/suppliers/:supplierId/sales-agents/:salesAgentId",
    async (
      request: FastifyRequest<{ Params: SupplierSalesAgentParams; Body: ContactRecordBody }>,
      reply
    ) => {
      try {
        return store.updateSalesAgent({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          salesAgentId: request.params.salesAgentId,
          agent: parseContactRecordBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/businesses/:businessId/suppliers/:supplierId/sales-agents/:salesAgentId",
    async (request: FastifyRequest<{ Params: SupplierSalesAgentParams }>, reply) => {
      try {
        return store.deleteSalesAgent({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          salesAgentId: request.params.salesAgentId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/sales-agents/:salesAgentId/link-contact",
    async (
      request: FastifyRequest<{ Params: SalesAgentParams; Body: PhonebookLinkBody }>,
      reply
    ) => {
      try {
        return store.linkSalesAgentContact({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          salesAgentId: request.params.salesAgentId,
          networkNodeId: parsePhonebookLinkBody(request.body).networkNodeId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/receipt-ocr/jobs",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: ReceiptOCRBody }>, reply) => {
      try {
        const body = parseReceiptOCRBody(request.body);
        store.assertDocumentImportWriteAccess({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
        let fileSizeBytes = body.fileSizeBytes;
        let fileSignature = body.fileSignature;
        let sourceChecksum: string | undefined;

        if (body.contentBase64 !== null) {
          const binary = decodeReceiptBase64(body.contentBase64);
          fileSizeBytes = binary.byteLength;
          fileSignature = binary.subarray(0, 16).toString("hex");
          sourceChecksum = createHash("sha256").update(binary).digest("hex");
          await binaryUploadPipeline?.process(
            {
              businessId: request.params.businessId,
              fileName: body.fileName,
              contentType: body.contentType,
              bytes: binary
            },
            { retain: false }
          );
        }
        if (body.extractedText.trim().length === 0) {
          throw new Cp2Error(
            400,
            "receipt_text_required",
            "Receipt text must be supplied by an agent tool or client-side extraction."
          );
        }

        return store.createReceiptOCRJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          sourceFileName: body.fileName,
          contentType: body.contentType,
          extractedText: body.extractedText,
          fileSizeBytes,
          fileSignature,
          ...(sourceChecksum === undefined ? {} : { sourceChecksum })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/receipt-ocr/jobs",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listReceiptOCRJobs({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/receipt-ocr/jobs/:ocrJobId/confirm",
    async (
      request: FastifyRequest<{ Params: ReceiptOCRParams; Body: ReceiptOCRConfirmBody }>,
      reply
    ) => {
      try {
        const body = parseReceiptOCRConfirmBody(request.body);
        return store.confirmReceiptOCRJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          ocrJobId: request.params.ocrJobId,
          supplierId: body.supplierId,
          salesAgentId: body.salesAgentId,
          createSupplier: body.createSupplier,
          createSalesAgent: body.createSalesAgent
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/receipt-ocr/jobs/:ocrJobId",
    async (
      request: FastifyRequest<{ Params: ReceiptOCRParams; Body: ReceiptOCRCorrectionBody }>,
      reply
    ) => {
      try {
        return store.correctReceiptOCRJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          ocrJobId: request.params.ocrJobId,
          extractedText: parseString(request.body?.extractedText, "extractedText")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/receipt-ocr/jobs/:ocrJobId/cancel",
    async (request: FastifyRequest<{ Params: ReceiptOCRParams }>, reply) => {
      try {
        return store.cancelReceiptOCRJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          ocrJobId: request.params.ocrJobId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/purchase-receipts",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listPurchaseReceipts({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/purchase-receipts/:receiptId",
    async (request: FastifyRequest<{ Params: PurchaseReceiptParams }>, reply) => {
      try {
        return store.getPurchaseReceipt({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          receiptId: request.params.receiptId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parsePhonebookLinkBody(body: PhonebookLinkBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    networkNodeId: parseString(record.networkNodeId, "networkNodeId"),
    notes: parseNullableString(record.notes)
  };
}

/** Exported - services/api/src/cp2/store.ts's offline-sync dispatcher reuses this to parse the
 * same shape from a queued receipts.ocr.create operation instead of an HTTP request body. */
export function parseReceiptOCRBody(body: ReceiptOCRBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    fileName: parseString(record.fileName, "fileName"),
    contentType: parseString(record.contentType, "contentType"),
    contentBase64:
      typeof record.contentBase64 === "string" && record.contentBase64.trim().length > 0
        ? record.contentBase64.trim()
        : null,
    extractedText: typeof record.extractedText === "string" ? record.extractedText : "",
    fileSizeBytes:
      record.fileSizeBytes === undefined
        ? null
        : parsePositiveInteger(record.fileSizeBytes, "fileSizeBytes"),
    fileSignature:
      typeof record.fileSignature === "string" && record.fileSignature.trim().length > 0
        ? record.fileSignature.trim()
        : null
  };
}

export function parseToolExtractionResult(value: unknown): ToolExtractionResult {
  if (typeof value !== "object" || value === null) {
    throw invalidExtractionPayload();
  }

  const record = value as Record<string, unknown>;
  const engine = record.engine;
  const profile = record.profile;
  const blocks = record.blocks;

  if (
    (engine !== "paddleocr" && engine !== "tesseract") ||
    (profile !== "mobile" && profile !== "balanced" && profile !== "accurate") ||
    typeof record.engineVersion !== "string" ||
    typeof record.modelVersion !== "string" ||
    typeof record.fallbackUsed !== "boolean" ||
    typeof record.fullText !== "string" ||
    !Number.isFinite(record.averageConfidence) ||
    !Array.isArray(record.warnings) ||
    !record.warnings.every((warning) => typeof warning === "string") ||
    !Array.isArray(blocks)
  ) {
    throw invalidExtractionPayload();
  }

  const parsedBlocks = blocks.map((block): OcrBlockSummary => {
    if (typeof block !== "object" || block === null) {
      throw invalidExtractionPayload();
    }
    const item = block as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !Number.isInteger(item.page) ||
      typeof item.text !== "string" ||
      !Number.isFinite(item.confidence)
    ) {
      throw invalidExtractionPayload();
    }

    const boundingBox =
      item.boundingBox === null
        ? null
        : Array.isArray(item.boundingBox)
          ? item.boundingBox.map((point) => {
              if (
                typeof point !== "object" ||
                point === null ||
                !Number.isFinite((point as Record<string, unknown>).x) ||
                !Number.isFinite((point as Record<string, unknown>).y)
              ) {
                throw invalidExtractionPayload();
              }
              return {
                x: Number((point as Record<string, unknown>).x),
                y: Number((point as Record<string, unknown>).y)
              };
            })
          : undefined;

    if (boundingBox === undefined) {
      throw invalidExtractionPayload();
    }

    return {
      id: item.id,
      page: Number(item.page),
      text: item.text,
      confidence: Number(item.confidence),
      boundingBox
    };
  });

  return {
    engine,
    engineVersion: record.engineVersion,
    modelVersion: record.modelVersion,
    profile,
    fallbackUsed: record.fallbackUsed,
    blocks: parsedBlocks,
    fullText: record.fullText,
    averageConfidence: Number(record.averageConfidence),
    warnings: record.warnings
  };
}

function invalidExtractionPayload(): Cp2Error {
  return new Cp2Error(
    400,
    "tool_extraction_payload_invalid",
    "The supplied extraction payload is invalid."
  );
}

/** Exported - domains/document-imports/routes.ts (not yet extracted) calls this too. */
export function decodeReceiptBase64(value: string): Buffer {
  const normalized = value.includes(",") ? (value.split(",", 2)[1] ?? "") : value;

  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/iu.test(normalized)
  ) {
    throw new Cp2Error(400, "receipt_ocr_base64_invalid", "Receipt file content is invalid.");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength === 0) {
    throw new Cp2Error(400, "receipt_ocr_content_required", "Receipt file content is required.");
  }
  return buffer;
}

function parseReceiptOCRConfirmBody(body: ReceiptOCRConfirmBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    supplierId: parseNullableString(record.supplierId),
    salesAgentId: parseNullableString(record.salesAgentId),
    createSupplier:
      record.createSupplier === undefined
        ? false
        : parseBoolean(record.createSupplier, "createSupplier"),
    createSalesAgent:
      record.createSalesAgent === undefined
        ? false
        : parseBoolean(record.createSalesAgent, "createSalesAgent")
  };
}
