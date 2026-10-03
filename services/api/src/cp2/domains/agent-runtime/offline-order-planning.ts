import type { OfflineOrderIntentOutcome, ProductSummary } from "@grogoni/shared-types";

/** Deterministic parsing only - no model call. Every quantity/product match here is a plain
 *  regex + string comparison, exactly the kind of same-input-same-output work that belongs in
 *  code rather than a prompt. */
export interface ParsedOfflineOrderLine {
  quantity: number;
  name: string;
  productId: string;
}

export interface OfflineOrderTextParseResult {
  /** False means the text doesn't look like an order attempt at all (no quantity-led segment) -
   *  callers should leave the message alone, not clarify it. */
  looksLikeOrder: boolean;
  /** Non-empty only when every segment resolved to exactly one product. A single unresolved
   *  segment empties this array entirely - we never silently drop the ambiguous part and keep
   *  the rest, since that would ship a smaller order than the customer asked for. */
  items: ParsedOfflineOrderLine[];
  /** One human-readable reason per segment that didn't resolve. Empty exactly when items is
   *  non-empty. */
  problems: string[];
}

const SEGMENT_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(?:x\s*)?(.+?)\s*$/iu;

/** "2 sugar 1kg, 1 soap" -> two order lines. Reused, unmodified, by both the SMS ingestion path
 *  (services/api/src/cp2/domains/messaging/store.ts's ingestNativeSmsMessage) and its own tests -
 *  there is exactly one place inbound order text becomes structured items. */
export function parseOfflineOrderText(
  text: string,
  products: ProductSummary[]
): OfflineOrderTextParseResult {
  const segments = text
    .split(/[,\n;]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const numberLed = segments.filter((segment) => /^\d/u.test(segment));
  if (segments.length === 0 || numberLed.length === 0) {
    return { looksLikeOrder: false, items: [], problems: [] };
  }

  const items: ParsedOfflineOrderLine[] = [];
  const problems: string[] = [];
  for (const segment of segments) {
    const match = SEGMENT_PATTERN.exec(segment);
    if (!match) {
      problems.push(`"${segment}" is missing a quantity, e.g. "2 ${segment}".`);
      continue;
    }
    const quantity = Number(match[1]);
    const name = (match[2] ?? "").trim();
    if (!Number.isFinite(quantity) || quantity <= 0 || name === "") {
      problems.push(`"${segment}" has an invalid quantity.`);
      continue;
    }
    const candidates = matchOfflineOrderProducts(products, name);
    if (candidates.length === 0) {
      problems.push(`we don't have a product matching "${name}"`);
      continue;
    }
    if (candidates.length > 1) {
      problems.push(`"${name}" matches more than one product - use its exact name`);
      continue;
    }
    items.push({ quantity, name: candidates[0]!.name, productId: candidates[0]!.id });
  }
  return { looksLikeOrder: true, items: problems.length === 0 ? items : [], problems };
}

/** Case-insensitive exact name/alias match first; falls back to substring match only when that
 *  still resolves to exactly one product. Shared with the offline-order reconciliation endpoint
 *  (services/api/src/cp2/store.ts's matchOfflineOrderProduct) so there is one matching rule for
 *  both "what did the SMS ask for" and "what does the BLE/SMS item resolve to at confirm time". */
export function matchOfflineOrderProducts(
  products: ProductSummary[],
  name: string
): ProductSummary[] {
  const needle = name.trim().toLowerCase();
  if (needle === "") return [];
  const exact = products.filter(
    (product) =>
      product.name.trim().toLowerCase() === needle ||
      (product.aliases ?? []).some((alias) => alias.trim().toLowerCase() === needle)
  );
  if (exact.length > 0) return exact;
  return products.filter((product) => product.name.trim().toLowerCase().includes(needle));
}

/** Deterministic, templated - not model-generated, so the same ambiguity always produces the
 *  same reply text. */
export function offlineOrderClarificationMessage(problems: string[]): string {
  const summary = problems.slice(0, 4).join("; ");
  return `We couldn't read your order: ${summary}. Reply like "2 sugar 1kg, 1 soap" using our exact product names.`;
}

/** Deterministic, templated reply for a reconciled SMS order - never a model call. */
export function offlineOrderOutcomeMessage(outcome: OfflineOrderIntentOutcome): string {
  const confirmedSummary = outcome.confirmedItems
    .map((item) => `${item.quantity} ${item.name}`)
    .join(", ");
  const rejectedSummary = outcome.rejectedItems
    .map((item) => `${item.name} (${item.reason ?? "unavailable"})`)
    .join(", ");
  if (outcome.status === "confirmed") return `Order confirmed: ${confirmedSummary}. Thank you!`;
  if (outcome.status === "partial")
    return `We could only fulfil part of your order: ${confirmedSummary}. Not available: ${rejectedSummary}.`;
  return `Sorry, we couldn't fulfil your order: ${rejectedSummary || "items unavailable"}.`;
}
