import {
  captureField,
  firstProductCaptureTitle,
  productCaptureItemsFromFields,
  queryCatalogueProducts,
  visibleProductCapturePrice
} from "@grogoni/business-core";
import type { ProductCaptureJobSummary, ProductSummary } from "@grogoni/shared-types";
import type { Entity } from "../types.js";

/**
 * The local mirror of a captured product photo before it syncs. Unlike receiptOcrJobEntity (whose
 * structured extraction needs the server's contact graph), title/price extraction and duplicate
 * detection are pure, deterministic functions the server itself uses
 * (services/api/src/cp2/domains/commerce/store.ts's createProductCaptureJob) - both sides import
 * them from @grogoni/business-core, so the offline review card shows the same fields a merchant would
 * see online, not a degraded "not yet extracted" placeholder. The job still syncs for real once
 * online: the server recomputes the same fields from `extractedText` rather than trusting this
 * device's copy, and assigns the durable id and any product-media handling.
 */
export function productCaptureJobEntity(
  id: string,
  businessId: string,
  uploadedBy: string,
  sourceFileName: string,
  contentType: string,
  extractedText: string,
  averageConfidence: number,
  localProducts: ProductSummary[],
  now: string
): Entity {
  const text = extractedText.trim();
  const confidence = Math.min(1, Math.max(0, averageConfidence));
  const title = firstProductCaptureTitle(text);
  const visiblePrice = visibleProductCapturePrice(text);
  const fields = {
    title: captureField(title, confidence),
    category: captureField<string>(null, null),
    description: captureField(text.length > 0 ? text.slice(0, 1000) : null, confidence),
    visiblePrice: captureField(visiblePrice, visiblePrice === null ? null : confidence)
  };
  const duplicates =
    title === null
      ? []
      : queryCatalogueProducts({
          businessId,
          products: localProducts,
          query: title,
          limit: 5
        }).products.map((product) => product.productId);
  const job: ProductCaptureJobSummary = {
    id,
    businessId,
    uploadedBy,
    status: text.length > 0 ? "REVIEW_REQUIRED" : "EXTRACTION_FAILED",
    // Mirrors createProductCaptureJob's historyStatuses in
    // services/api/src/cp2/domains/commerce/store.ts exactly, so a job's status history looks the
    // same whether it was captured online or offline - there is no separate QUEUED/VALIDATING step
    // to skip on-device, the local OCR call already did that work synchronously.
    statusHistory:
      text.length > 0
        ? [
            { status: "CAPTURED", at: now },
            { status: "QUEUED", at: now },
            { status: "VALIDATING", at: now },
            { status: "PREPROCESSING", at: now },
            { status: "EXTRACTION_RUNNING", at: now },
            { status: "FIELDS_EXTRACTED", at: now },
            { status: "DUPLICATE_CHECK", at: now },
            { status: "REVIEW_REQUIRED", at: now }
          ]
        : [
            { status: "CAPTURED", at: now },
            { status: "QUEUED", at: now },
            { status: "VALIDATING", at: now },
            { status: "PREPROCESSING", at: now },
            { status: "EXTRACTION_RUNNING", at: now },
            { status: "EXTRACTION_FAILED", at: now }
          ],
    sourceFileName,
    contentType,
    sourceChecksum: "",
    // No image bytes are queued or synced offline (bandwidth-saving, same rule as receipt OCR) -
    // there is nothing to keep as product media until the seller re-captures online.
    temporaryMediaId: null,
    fields,
    detectionAvailable: false,
    items: productCaptureItemsFromFields(fields),
    possibleDuplicateProductIds: duplicates,
    failureCode: text.length > 0 ? null : "product_capture_text_missing",
    failureMessage:
      text.length > 0
        ? null
        : "No reliable product text was extracted. Retry, enter details manually, or cancel.",
    retryCount: 0,
    publishedProductId: null,
    keepImageAsProductMedia: false,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    publishedAt: null,
    cancelledAt: null
  };
  return job as unknown as Entity;
}
