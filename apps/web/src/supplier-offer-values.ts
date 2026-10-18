import type { SupplierOfferReview } from "@grogoni/shared-types";

export function parseSupplierOfferResponse(value: unknown): {
  offers: SupplierOfferReview[];
  truncated: boolean;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !("offers" in value) ||
    !Array.isArray(value.offers) ||
    value.offers.length > 200 ||
    !("truncated" in value) ||
    typeof value.truncated !== "boolean"
  )
    throw new Error("Supplier offers could not be loaded.");
  for (const offer of value.offers) {
    if (
      !offer ||
      typeof offer !== "object" ||
      !["id", "productId", "productName", "supplierId", "supplierName", "unit"].every(
        (key) => typeof offer[key] === "string" && offer[key].length > 0
      ) ||
      typeof offer.currency !== "string" ||
      !/^[A-Z]{3}$/u.test(offer.currency) ||
      offer.priceIncludesCharges !== true ||
      ![
        "unitPriceMinor",
        "minQuantityMilli",
        "incrementMilli",
        "availableQuantityMilli",
        "leadTimeDays"
      ].every((key) => Number.isSafeInteger(offer[key]) && offer[key] >= 0) ||
      !offer.unitPriceMinor ||
      !offer.minQuantityMilli ||
      !offer.incrementMilli ||
      offer.leadTimeDays > 365 ||
      typeof offer.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(offer.expiresAt))
    )
      throw new Error("Supplier offer data is incomplete.");
  }
  return { offers: value.offers, truncated: value.truncated };
}

export function parseOfferFixed(value: string, digits: number, label: string): number {
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`, "u").test(value.trim()))
    throw new Error(`${label} needs at most ${digits} decimal places.`);
  const [whole, fraction = ""] = value.trim().split(".");
  const scaled = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(scaled) || scaled < 0)
    throw new Error(`${label} is outside the supported range.`);
  return scaled;
}
