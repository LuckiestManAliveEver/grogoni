import type { CommerceProductIdentity } from "@grogoni/shared-types";
const normalized = (value?: string) => value?.trim().toLowerCase().replace(/\s+/g, " ");
/** Positive identifiers suggest candidates; contradictory packaging/variants always require review. */
export function compareCommerceIdentity(
  left: CommerceProductIdentity,
  right: CommerceProductIdentity
) {
  const conflicts = (["barcode", "brand", "packaging", "variant", "unit"] as const).filter(
    (key) => left[key] && right[key] && normalized(left[key]) !== normalized(right[key])
  );
  const barcode = !!left.barcode && left.barcode === right.barcode;
  const sku =
    !!left.sku &&
    !!left.skuNamespace &&
    normalized(left.skuNamespace) === normalized(right.skuNamespace) &&
    normalized(left.sku) === normalized(right.sku);
  return { match: (barcode || sku) && !conflicts.length, conflicts, reviewRequired: true as const };
}
export function readCommerceIdentity(value: unknown): CommerceProductIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    ["sku", "skuNamespace", "barcode", "brand", "packaging", "variant", "unit"].flatMap((key) => {
      const item = (value as Record<string, unknown>)[key];
      return typeof item === "string" && item.trim() && item.length <= 160
        ? [[key, item.trim()]]
        : [];
    })
  );
}
