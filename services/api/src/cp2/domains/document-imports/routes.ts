/**
 * Sixth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Needs `binaryUploadPipeline`/
 * `parseDocumentImportBody` is
 * exported since the not-yet-extracted commerce product-captures route calls it too - a genuine
 * cross-domain reference. `decodeReceiptBase64` is imported back from `domains/suppliers/routes.js`
 * (extracted first, in row 5) rather than duplicated.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProductImportDraft, SupplierImportDraft } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import {
  extractDocumentImportSource,
  extractUploadedDocument,
  type DocumentUploadInput
} from "../../document-extraction.js";
import type { BinaryUploadPipeline } from "../../binary-upload-pipeline.js";
import {
  parseBoolean,
  parseIntegerString,
  parseNullableNumber,
  parseNullableString,
  parseNumber,
  parsePositiveInteger,
  parseRequestBody,
  parseString,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";

interface DocumentImportParams extends BusinessParams {
  importJobId: string;
}

interface DocumentImportRowParams extends DocumentImportParams {
  rowNumber: string;
}

interface SupplierCsvImportBody {
  fileName?: string;
  contentType?: string | null;
  content?: string;
  contentBase64?: string;
  sourceType?: string;
  sourceLocator?: string | null;
}

/** Exported - domains/commerce/routes.ts's (not yet extracted) ProductCaptureBody extends this. */
export interface ProductCatalogueImportBody {
  fileName?: string;
  contentType?: string | null;
  content?: string;
  contentBase64?: string;
  sourceType?: string;
  sourceLocator?: string | null;
}

interface SupplierImportRowBody {
  mapped?: Partial<SupplierImportDraft>;
  selected?: boolean;
}

interface ProductImportRowBody {
  mapped?: Partial<ProductImportDraft>;
  selected?: boolean;
}

interface SupplierImportConfirmBody {
  selectedRowNumbers?: number[];
}

export function registerDocumentImportsRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  binaryUploadPipeline: BinaryUploadPipeline | undefined
): void {
  async function prepareDocumentUpload(
    input: DocumentUploadInput,
    businessId: string,
    retain: boolean
  ): Promise<DocumentUploadInput> {
    if (input.contentBase64 === undefined || binaryUploadPipeline === undefined) return input;
    const bytes = decodePipelineBase64(input.contentBase64);
    const result = await binaryUploadPipeline.process(
      {
        businessId,
        fileName: input.fileName,
        contentType: input.contentType?.trim() || "application/octet-stream",
        bytes
      },
      { retain }
    );
    return {
      ...input,
      originalStorageKey: result.storageKey
    };
  }

  app.post(
    "/businesses/:businessId/imports/supplier-csv",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: SupplierCsvImportBody }>,
      reply
    ) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        store.assertDocumentImportWriteAccess({
          sessionId,
          businessId: request.params.businessId
        });
        const upload = await prepareDocumentUpload(
          parseDocumentImportBody(request.body),
          request.params.businessId,
          true
        );
        const source = await extractDocumentImportSource(upload);
        return store.createSupplierCsvImport({
          sessionId,
          businessId: request.params.businessId,
          source
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/imports/product-catalogue",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: ProductCatalogueImportBody }>,
      reply
    ) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        store.assertDocumentImportWriteAccess({
          sessionId,
          businessId: request.params.businessId
        });
        const upload = await prepareDocumentUpload(
          parseDocumentImportBody(request.body),
          request.params.businessId,
          true
        );
        const source = await extractDocumentImportSource(upload);
        return store.createProductCatalogueImport({
          sessionId,
          businessId: request.params.businessId,
          source
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/documents/extract",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: ProductCatalogueImportBody }>,
      reply
    ) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        store.assertDocumentImportWriteAccess({
          sessionId,
          businessId: request.params.businessId
        });
        const upload = await prepareDocumentUpload(
          parseDocumentImportBody(request.body),
          request.params.businessId,
          false
        );
        return await extractUploadedDocument(upload);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/imports",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listDocumentImports({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/imports/:importJobId",
    async (request: FastifyRequest<{ Params: DocumentImportParams }>, reply) => {
      try {
        return store.getDocumentImport({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          importJobId: request.params.importJobId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/imports/:importJobId/rows/:rowNumber",
    async (
      request: FastifyRequest<{ Params: DocumentImportRowParams; Body: SupplierImportRowBody }>,
      reply
    ) => {
      try {
        return store.updateSupplierImportRow({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          importJobId: request.params.importJobId,
          rowNumber: parseIntegerString(request.params.rowNumber, "rowNumber"),
          ...parseSupplierImportRowBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/imports/:importJobId/product-rows/:rowNumber",
    async (
      request: FastifyRequest<{ Params: DocumentImportRowParams; Body: ProductImportRowBody }>,
      reply
    ) => {
      try {
        return store.updateProductImportRow({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          importJobId: request.params.importJobId,
          rowNumber: parseIntegerString(request.params.rowNumber, "rowNumber"),
          ...parseProductImportRowBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/imports/:importJobId/confirm",
    async (
      request: FastifyRequest<{ Params: DocumentImportParams; Body: SupplierImportConfirmBody }>,
      reply
    ) => {
      try {
        const selectedRowNumbers = parseOptionalRowNumbers(request.body?.selectedRowNumbers);
        const input = {
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          importJobId: request.params.importJobId
        };
        return store.confirmSupplierImport({
          ...input,
          ...(selectedRowNumbers === undefined ? {} : { selectedRowNumbers })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/imports/:importJobId/confirm-products",
    async (
      request: FastifyRequest<{ Params: DocumentImportParams; Body: SupplierImportConfirmBody }>,
      reply
    ) => {
      try {
        const selectedRowNumbers = parseOptionalRowNumbers(request.body?.selectedRowNumbers);
        const input = {
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          importJobId: request.params.importJobId
        };
        return store.confirmProductImport({
          ...input,
          ...(selectedRowNumbers === undefined ? {} : { selectedRowNumbers })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

/** Exported - domains/commerce/routes.ts (not yet extracted) calls this too. */
export function parseDocumentImportBody(
  body: SupplierCsvImportBody | ProductCatalogueImportBody | null | undefined
): DocumentUploadInput {
  const record = parseRequestBody(body);
  const parsed: DocumentUploadInput = {
    fileName: parseString(record.fileName, "fileName"),
    contentType: parseNullableString(record.contentType),
    ...(record.sourceType === undefined
      ? {}
      : { sourceType: parseDocumentImportSourceType(record.sourceType) }),
    sourceLocator: parseNullableString(record.sourceLocator)
  };

  if (record.content !== undefined) {
    parsed.content = parseString(record.content, "content");
  }

  if (record.contentBase64 !== undefined) {
    parsed.contentBase64 = parseString(record.contentBase64, "contentBase64");
  }

  return parsed;
}

function parseDocumentImportSourceType(value: unknown): "upload" | "paste" | "database" {
  const sourceType = parseString(value, "sourceType");
  if (sourceType === "upload" || sourceType === "paste" || sourceType === "database") {
    return sourceType;
  }
  throw new Cp2Error(400, "import_source_type_invalid", "Import source type is not supported.");
}

function parseSupplierImportRowBody(body: SupplierImportRowBody | null | undefined): {
  mapped: SupplierImportDraft;
  selected?: boolean;
} {
  const record = parseRequestBody(body);
  const mapped = parseRequestBody(record.mapped);
  const parsed = {
    mapped: {
      name: parseString(mapped.name, "mapped.name"),
      phone: parseNullableString(mapped.phone),
      email: parseNullableString(mapped.email),
      notes: parseNullableString(mapped.notes)
    }
  };

  return record.selected === undefined
    ? parsed
    : {
        ...parsed,
        selected: parseBoolean(record.selected, "selected")
      };
}

function parseProductImportRowBody(body: ProductImportRowBody | null | undefined): {
  mapped: ProductImportDraft;
  selected?: boolean;
} {
  const record = parseRequestBody(body);
  const mapped = parseRequestBody(record.mapped);
  const parsed = {
    mapped: {
      name: parseString(mapped.name, "mapped.name"),
      sku: parseNullableString(mapped.sku),
      unit: parseString(mapped.unit, "mapped.unit"),
      quantity: parseNumber(mapped.quantity, "mapped.quantity"),
      buyingPrice: parseNullableNumber(mapped.buyingPrice, "mapped.buyingPrice"),
      sellingPrice: parseNullableNumber(mapped.sellingPrice, "mapped.sellingPrice")
    }
  };

  return record.selected === undefined
    ? parsed
    : {
        ...parsed,
        selected: parseBoolean(record.selected, "selected")
      };
}

function parseOptionalRowNumbers(value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "selected_rows_invalid", "selectedRowNumbers must be an array.");
  }

  return value.map((item, index) => parsePositiveInteger(item, `selectedRowNumbers.${index}`));
}

/** Exported - domains/commerce/routes.ts (not yet extracted) calls this too. */
export function assertDocumentOcrSignature(contentType: string, buffer: Buffer): void {
  const hex = buffer.subarray(0, 16).toString("hex").toLowerCase();
  const matches =
    (contentType === "image/jpeg" && hex.startsWith("ffd8ff")) ||
    (contentType === "image/png" && hex.startsWith("89504e47")) ||
    (contentType === "image/webp" &&
      hex.startsWith("52494646") &&
      hex.slice(16, 24) === "57454250") ||
    (contentType === "application/pdf" && hex.startsWith("25504446")) ||
    ((contentType === "image/heic" || contentType === "image/heif") &&
      ["6674797068656963", "6674797068656966", "667479706d696631"].some((brand) =>
        hex.includes(brand)
      ));

  if (!matches) {
    throw new Cp2Error(
      400,
      "document_ocr_signature_mismatch",
      "Document contents do not match the declared image or PDF type."
    );
  }
}

function decodePipelineBase64(value: string): Buffer {
  const normalized = value.includes(",") ? (value.split(",", 2)[1] ?? "") : value;
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/iu.test(normalized)
  ) {
    throw new Cp2Error(400, "document_base64_invalid", "Document file content is invalid.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength === 0) {
    throw new Cp2Error(400, "document_content_required", "Document file content is required.");
  }
  return buffer;
}
