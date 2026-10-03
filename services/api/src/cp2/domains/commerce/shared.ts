import type { ProductCaptureField } from "@grogoni/shared-types";
import {
  captureField,
  firstProductCaptureTitle,
  productCaptureItemsFromFields,
  visibleProductCapturePrice
} from "@grogoni/business-core";
import {
  normalizeOptionalBoundedText,
  normalizeRequiredBoundedText
} from "../../text-normalization.js";

export { normalizeOptionalBoundedText, normalizeRequiredBoundedText };

// Re-exported rather than redefined: these are pure text-extraction heuristics that must produce
// the exact same result whether they run here (the online capture path) or on-device in
// packages/offline-runtime/providers/product-capture-entity.ts (the offline capture path) - see
// that function's own doc comment for why it lives in @grogoni/business-core instead of either side.
export {
  captureField,
  firstProductCaptureTitle,
  productCaptureItemsFromFields,
  visibleProductCapturePrice
};

export function sellerCaptureField<T>(value: T | null): ProductCaptureField<T> {
  return {
    value,
    source: value === null ? "not_detected" : "seller",
    confidence: value === null ? null : 1
  };
}

/**
 * Text relevance for the unified buy feed - mirrors catalogueMatchScore's exact/prefix/substring
 * scale (packages/business-core/src/index.ts) but works on a plain title string, since contact
 * results only have StatusBroadcastItemSummary.title, not a full ProductSummary to score against.
 */
export function buyTextRelevanceScore(title: string, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return 1;
  const normalizedTitle = title.trim().toLowerCase();
  if (normalizedTitle === normalizedQuery) return 1000;
  if (normalizedTitle.startsWith(normalizedQuery)) return 800;
  if (normalizedTitle.includes(normalizedQuery)) return 600;
  return 0;
}
