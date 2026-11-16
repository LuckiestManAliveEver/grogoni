import type { VerifiedProductPackaging, UnitConversionResult } from "@grogoni/shared-types";
const normalize = (unit: string | null) => (unit ?? "").normalize("NFKC").trim().toLowerCase();
/** Only definitions explicitly verified through product:write may multiply stock quantities. */
export function convertReceiptQuantity(input: {
  businessId: string;
  productId: string;
  receiptUnit: string | null;
  stockUnit: string | null;
  quantity: number;
  packaging: VerifiedProductPackaging[];
}): UnitConversionResult {
  const unresolved = (detail: string): UnitConversionResult => ({
    basis: "unresolved",
    baseQuantityMilli: null,
    packagingId: null,
    detail
  });
  const quantityMilli = Math.round(input.quantity * 1000);
  if (
    !Number.isFinite(input.quantity) ||
    input.quantity <= 0 ||
    !Number.isSafeInteger(quantityMilli) ||
    Math.abs(input.quantity * 1000 - quantityMilli) > 0.000001
  )
    return unresolved("Review the positive quantity; at most three decimal places are supported.");
  const from = normalize(input.receiptUnit);
  const to = normalize(input.stockUnit);
  if (!from || !to) return unresolved("Confirm the receipt and stock units before posting.");
  if (from === to)
    return {
      basis: "same_unit",
      baseQuantityMilli: quantityMilli,
      packagingId: null,
      detail: "Receipt and stock units match."
    };
  const matches = input.packaging.filter(
    (p) =>
      p.status === "active" &&
      p.businessId === input.businessId &&
      p.productId === input.productId &&
      normalize(p.packUnit) === from &&
      normalize(p.baseUnit) === to &&
      p.verifiedBy &&
      Number.isFinite(Date.parse(p.verifiedAt)) &&
      Number.isSafeInteger(p.unitsPerPack) &&
      p.unitsPerPack > 0
  );
  if (matches.length !== 1)
    return unresolved("Verify one unambiguous pack conversion for this product before posting.");
  const definition = matches[0]!;
  const converted = quantityMilli * definition.unitsPerPack;
  if (!Number.isSafeInteger(converted))
    return unresolved("Converted quantity exceeds the supported range.");
  return {
    basis: "verified_packaging",
    baseQuantityMilli: converted,
    packagingId: definition.id,
    detail: `${input.quantity} ${from} × ${definition.unitsPerPack} = ${converted / 1000} ${to}`
  };
}
