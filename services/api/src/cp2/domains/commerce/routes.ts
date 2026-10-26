/**
 * Seventh domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). This is the storefront/social-commerce
 * surface (product-capture jobs, status broadcasts, buy feed, unified checkouts) - the same
 * `CommerceDomain` the store.ts side already extracted first, as its own reference
 * implementation. Needs `binaryUploadPipeline` passed in, and imports
 * `parseDocumentImportBody`/`assertDocumentOcrSignature`/`ProductCatalogueImportBody` (row 6) and
 * `decodeReceiptBase64` (row 5) back from the two domains that own them - a genuine cross-domain
 * reference (product-capture upload handling reuses the exact same file-decoding/signature-check
 * pipeline as document import OCR), not duplicated logic.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  productCaptureImageContentTypes,
  type BuyCheckoutItemInput,
  type BuyResultSourceKind,
  type ProductCaptureImageContentType
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import type { BinaryUploadPipeline } from "../../binary-upload-pipeline.js";
import { decodeReceiptBase64 } from "../suppliers/routes.js";
import {
  assertDocumentOcrSignature,
  parseDocumentImportBody,
  type ProductCatalogueImportBody
} from "../document-imports/routes.js";
import {
  parseBoolean,
  parseNullableNumber,
  parseNullableString,
  parseNumber,
  parseRequestBody,
  parseString,
  parseStringArray,
  readHeader,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";

interface ProductCaptureParams extends BusinessParams {
  captureJobId: string;
}

interface ProductCaptureBody extends ProductCatalogueImportBody {
  extractedText?: string;
}

interface ProductCaptureReviewBody {
  title?: string;
  category?: string | null;
  description?: string | null;
  visiblePrice?: number | null;
  keepImageAsProductMedia?: boolean;
}

interface ProductCaptureConfirmBody {
  existingProductId?: string | null;
  unit?: string | null;
  quantity?: number;
  aliases?: string[];
}

interface ProductCaptureItemParams extends ProductCaptureParams {
  itemId: string;
}

interface ProductCaptureItemConfirmBody {
  title?: string;
  category?: string | null;
  description?: string | null;
  visiblePrice?: number | null;
  existingProductId?: string | null;
  unit?: string | null;
  quantity?: number;
  aliases?: string[];
}

interface StatusBroadcastParams extends BusinessParams {
  statusBroadcastId: string;
}

interface StatusBroadcastCreateBody {
  sourceCaptureJobId?: string;
  recipientNodeIds?: string[];
  sellerConversationId?: string | null;
}

interface StatusBroadcastEngagementParams {
  statusBroadcastId: string;
}

interface BuySearchQuery {
  query?: string;
}

interface BuyCheckoutBody {
  items?: Array<{
    websiteUrl?: string;
    sourceKind?: string;
    sourceId?: string;
    sourceLabel?: string;
    title?: string;
    quantity?: number;
    agentId?: string | null;
    productId?: string | null;
    statusBroadcastId?: string | null;
    productCaptureItemId?: string | null;
  }>;
  sellerConversationId?: string | null;
}

interface UnifiedCheckoutParams {
  unifiedCheckoutId: string;
}

interface SystemOrderParams {
  orderId: string;
}

export function registerCommerceRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  binaryUploadPipeline: BinaryUploadPipeline | undefined
): void {
  app.put(
    "/v1/shop-system/catalogue",
    async (request: FastifyRequest<{ Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.syncShopSystemCatalogue({
          accessToken: bearerToken(request.headers.authorization),
          products: Array.isArray(body.products) ? body.products : []
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/v1/shop-system/orders", async (request, reply) => {
    try {
      return {
        orders: store.listShopSystemOrders({
          accessToken: bearerToken(request.headers.authorization)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.patch(
    "/v1/shop-system/orders/:orderId",
    async (request: FastifyRequest<{ Params: SystemOrderParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.updateShopSystemOrder({
          accessToken: bearerToken(request.headers.authorization),
          orderId: request.params.orderId,
          status: parseSystemOrderStatus(body.status)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/product-captures",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: ProductCaptureBody }>,
      reply
    ) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        store.assertDocumentImportWriteAccess({
          sessionId,
          businessId: request.params.businessId
        });
        const upload = parseDocumentImportBody(request.body);
        if (upload.contentBase64 === undefined) {
          throw new Cp2Error(
            400,
            "product_capture_content_required",
            "A product image is required."
          );
        }
        const contentType = upload.contentType?.trim() || "application/octet-stream";
        if (!(productCaptureImageContentTypes as readonly string[]).includes(contentType)) {
          throw new Cp2Error(415, "product_capture_type_unsupported", "Use JPEG, PNG, or WebP.");
        }
        const binary = decodeReceiptBase64(upload.contentBase64);
        if (binary.byteLength > 10 * 1024 * 1024) {
          throw new Cp2Error(
            413,
            "product_capture_too_large",
            "Product images must be 10 MB or smaller."
          );
        }
        assertDocumentOcrSignature(contentType, binary);
        await binaryUploadPipeline?.process(
          {
            businessId: request.params.businessId,
            fileName: upload.fileName,
            contentType,
            bytes: binary
          },
          { retain: false }
        );
        const extractedText =
          typeof request.body.extractedText === "string" ? request.body.extractedText : "";
        const averageConfidence: number | null = null;
        return store.createProductCaptureJob({
          sessionId,
          businessId: request.params.businessId,
          sourceFileName: upload.fileName,
          contentType: contentType as ProductCaptureImageContentType,
          contentBase64: binary.toString("base64"),
          sourceChecksum: createHash("sha256").update(binary).digest("hex"),
          extractedText,
          averageConfidence
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/product-captures/:captureJobId",
    async (request: FastifyRequest<{ Params: ProductCaptureParams }>, reply) => {
      try {
        return store.getProductCaptureJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/product-captures/:captureJobId/review",
    async (
      request: FastifyRequest<{ Params: ProductCaptureParams; Body: ProductCaptureReviewBody }>,
      reply
    ) => {
      try {
        return store.reviewProductCaptureJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId,
          title: parseString(request.body.title, "title"),
          category: parseNullableString(request.body.category),
          description: parseNullableString(request.body.description),
          visiblePrice:
            request.body.visiblePrice === undefined
              ? null
              : parseNullableNumber(request.body.visiblePrice, "visiblePrice"),
          keepImageAsProductMedia:
            request.body.keepImageAsProductMedia === undefined
              ? false
              : parseBoolean(request.body.keepImageAsProductMedia, "keepImageAsProductMedia")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/product-captures/:captureJobId/retry",
    async (
      request: FastifyRequest<{ Params: ProductCaptureParams; Body: { extractedText?: string } }>,
      reply
    ) => {
      try {
        return store.retryProductCaptureJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId,
          extractedText:
            typeof request.body.extractedText === "string" ? request.body.extractedText : ""
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/product-captures/:captureJobId/cancel",
    async (request: FastifyRequest<{ Params: ProductCaptureParams }>, reply) => {
      try {
        return store.cancelProductCaptureJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/product-captures/:captureJobId/confirm",
    async (
      request: FastifyRequest<{ Params: ProductCaptureParams; Body: ProductCaptureConfirmBody }>,
      reply
    ) => {
      try {
        const quantity =
          request.body.quantity === undefined
            ? undefined
            : parseNumber(request.body.quantity, "quantity");
        const aliases =
          request.body.aliases === undefined
            ? undefined
            : parseStringArray(request.body.aliases, "aliases", 20);
        return store.confirmProductCaptureJob({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId,
          existingProductId: parseNullableString(request.body.existingProductId),
          unit: parseNullableString(request.body.unit),
          ...(quantity === undefined ? {} : { quantity }),
          ...(aliases === undefined ? {} : { aliases })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/product-captures/:captureJobId/items/:itemId/confirm",
    async (
      request: FastifyRequest<{
        Params: ProductCaptureItemParams;
        Body: ProductCaptureItemConfirmBody;
      }>,
      reply
    ) => {
      try {
        const quantity =
          request.body.quantity === undefined
            ? undefined
            : parseNumber(request.body.quantity, "quantity");
        const aliases =
          request.body.aliases === undefined
            ? undefined
            : parseStringArray(request.body.aliases, "aliases", 20);
        return store.confirmProductCaptureItem({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId,
          itemId: request.params.itemId,
          ...(request.body.title === undefined
            ? {}
            : { title: parseString(request.body.title, "title") }),
          ...(request.body.category === undefined
            ? {}
            : { category: parseNullableString(request.body.category) }),
          ...(request.body.description === undefined
            ? {}
            : { description: parseNullableString(request.body.description) }),
          ...(request.body.visiblePrice === undefined
            ? {}
            : { visiblePrice: parseNullableNumber(request.body.visiblePrice, "visiblePrice") }),
          existingProductId: parseNullableString(request.body.existingProductId),
          unit: parseNullableString(request.body.unit),
          ...(quantity === undefined ? {} : { quantity }),
          ...(aliases === undefined ? {} : { aliases })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/product-captures/:captureJobId/items/:itemId/reject",
    async (request: FastifyRequest<{ Params: ProductCaptureItemParams }>, reply) => {
      try {
        return store.rejectProductCaptureItem({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          captureJobId: request.params.captureJobId,
          itemId: request.params.itemId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/status-broadcasts/candidates",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          candidates: store.listStatusBroadcastCandidates({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/status-broadcasts",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: StatusBroadcastCreateBody }>,
      reply
    ) => {
      try {
        return store.createStatusBroadcast({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          sourceCaptureJobId: parseString(request.body.sourceCaptureJobId, "sourceCaptureJobId"),
          recipientNodeIds: parseStringArray(
            request.body.recipientNodeIds,
            "recipientNodeIds",
            200
          ),
          sellerConversationId: parseNullableString(request.body.sellerConversationId ?? null)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/status-broadcasts/:statusBroadcastId",
    async (request: FastifyRequest<{ Params: StatusBroadcastParams }>, reply) => {
      try {
        return store.getStatusBroadcast({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          statusBroadcastId: request.params.statusBroadcastId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/status-broadcasts",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          statusBroadcasts: store.listStatusBroadcastsForBusiness({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/status-broadcasts/received", async (request, reply) => {
    try {
      return {
        statusBroadcasts: store.listStatusBroadcastsReceivedByViewer({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/status-broadcasts/:statusBroadcastId/view",
    async (request: FastifyRequest<{ Params: StatusBroadcastEngagementParams }>, reply) => {
      try {
        return store.recordStatusBroadcastView({
          sessionId: readSessionCookie(request.headers.cookie),
          statusBroadcastId: request.params.statusBroadcastId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/status-broadcasts/:statusBroadcastId/reply",
    async (request: FastifyRequest<{ Params: StatusBroadcastEngagementParams }>, reply) => {
      try {
        return store.recordStatusBroadcastReply({
          sessionId: readSessionCookie(request.headers.cookie),
          statusBroadcastId: request.params.statusBroadcastId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/buy/assistant", async (request, reply) => {
    try {
      const body = parseRequestBody(request.body);
      const shoppingSessionId = parseString(body.shoppingSessionId, "shoppingSessionId");
      const requestId = parseString(body.requestId, "requestId");
      const message = parseString(body.message, "message");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
      if (!uuid.test(shoppingSessionId) || !uuid.test(requestId) || message.length > 16000) {
        throw new Cp2Error(
          400,
          "buyer_shopping_input_invalid",
          "Send a valid shopping request of at most 16,000 characters."
        );
      }
      return await store.createBuyerShoppingTurn({
        sessionId: readSessionCookie(request.headers.cookie),
        shoppingSessionId,
        requestId,
        message,
        signal: AbortSignal.timeout(55000)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get(
    "/buy/search",
    async (request: FastifyRequest<{ Querystring: BuySearchQuery }>, reply) => {
      try {
        return store.searchBuyFeed({
          sessionId: readSessionCookie(request.headers.cookie),
          query: request.query.query ?? ""
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/buy/checkout", async (request: FastifyRequest<{ Body: BuyCheckoutBody }>, reply) => {
    try {
      const idempotencyKey = readHeader(request, "idempotency-key");
      return store.createUnifiedCheckout({
        sessionId: readSessionCookie(request.headers.cookie),
        items: parseBuyCheckoutItems(request.body.items),
        sellerConversationId: parseNullableString(request.body.sellerConversationId ?? null),
        ...(idempotencyKey === null ? {} : { idempotencyKey })
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get(
    "/buy/checkouts/:unifiedCheckoutId",
    async (request: FastifyRequest<{ Params: UnifiedCheckoutParams }>, reply) => {
      try {
        return store.getUnifiedCheckout({
          sessionId: readSessionCookie(request.headers.cookie),
          unifiedCheckoutId: request.params.unifiedCheckoutId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

/**
 * Parses the payload of an offline `productCaptures.ocr.create` sync operation
 * (services/api/src/cp2/store.ts's pushOfflineOperation). Deliberately narrower than
 * parseDocumentImportBody/ProductCaptureBody above: an offline capture never carries image bytes
 * (packages/offline-runtime/providers/local-provider.ts never queues them, same rule as
 * receipts.ocr.create), only the on-device OCR result.
 */
export function parseProductCaptureOfflineBody(body: unknown): {
  fileName: string;
  contentType: ProductCaptureImageContentType;
  extractedText: string;
  averageConfidence: number | null;
} {
  const record = parseRequestBody(body);
  const contentType = parseString(record.contentType, "contentType");
  if (!(productCaptureImageContentTypes as readonly string[]).includes(contentType)) {
    throw new Cp2Error(
      400,
      "product_capture_type_unsupported",
      "This device's product photo type is not supported."
    );
  }
  return {
    fileName: parseString(record.fileName, "fileName"),
    contentType: contentType as ProductCaptureImageContentType,
    extractedText: typeof record.extractedText === "string" ? record.extractedText : "",
    averageConfidence:
      record.averageConfidence === null || record.averageConfidence === undefined
        ? null
        : parseNumber(record.averageConfidence, "averageConfidence")
  };
}

function bearerToken(header: string | undefined): string {
  if (header === undefined || !header.startsWith("Bearer ") || header.slice(7).trim() === "") {
    throw new Cp2Error(401, "shop_system_token_required", "A shop system token is required.");
  }
  return header.slice(7).trim();
}

function parseSystemOrderStatus(
  value: unknown
): "accepted" | "rejected" | "completed" | "cancelled" {
  if (
    value === "accepted" ||
    value === "rejected" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Cp2Error(400, "shop_system_order_status_invalid", "Order status is invalid.");
}

function parseBuySourceKind(value: unknown): BuyResultSourceKind {
  if (
    value === "contact" ||
    value === "catalogue" ||
    value === "marketplace_connector" ||
    value === "offer"
  ) {
    return value;
  }
  throw new Cp2Error(400, "buy_source_kind_invalid", "Checkout item source is invalid.");
}

function parseBuyCheckoutItems(value: unknown): BuyCheckoutItemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Cp2Error(
      400,
      "buy_checkout_items_invalid",
      "Checkout needs between 1 and 100 items."
    );
  }
  return value.map((raw, index) => {
    const item = parseRequestBody(raw);
    return {
      ...(typeof item.websiteUrl === "string" ? { websiteUrl: item.websiteUrl } : {}),
      sourceKind: parseBuySourceKind(item.sourceKind),
      sourceId: parseString(item.sourceId, `items[${index}].sourceId`),
      sourceLabel: parseString(item.sourceLabel, `items[${index}].sourceLabel`),
      title: parseString(item.title, `items[${index}].title`),
      quantity: parseNumber(item.quantity, `items[${index}].quantity`),
      agentId: parseNullableString(item.agentId ?? null),
      productId: parseNullableString(item.productId ?? null),
      statusBroadcastId: parseNullableString(item.statusBroadcastId ?? null),
      productCaptureItemId: parseNullableString(item.productCaptureItemId ?? null)
    };
  });
}
