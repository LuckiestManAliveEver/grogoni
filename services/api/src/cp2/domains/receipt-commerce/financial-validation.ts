import type { ReceiptStructuredExtractionSummary } from "@grogoni/shared-types";

export interface ReceiptFinancialFinding {
  field: string;
  message: string;
}

/** Decimal amounts are compared in minor units. Unknown values stay unknown. */
export function validateReceiptFinances(
  fields: ReceiptStructuredExtractionSummary
): ReceiptFinancialFinding[] {
  const findings: ReceiptFinancialFinding[] = [];
  const add = (field: string, message: string) => findings.push({ field, message });
  const minor = (value: number, field: string): number | null => {
    const scaled = value * 100;
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(scaled))) {
      add(field, "Enter a finite, non-negative amount within the supported range.");
      return null;
    }
    if (Math.abs(scaled - Math.round(scaled)) > 0.000001) {
      add(field, "Amounts may have at most two decimal places.");
      return null;
    }
    return Math.round(scaled);
  };
  const receipt = fields.receipt;
  const amounts = new Map<string, number | null>();
  for (const key of ["subtotal", "discount", "tax", "total", "amountPaid", "balance"] as const) {
    amounts.set(key, receipt[key] === null ? null : minor(receipt[key], `receipt.${key}`));
  }
  let sum = 0;
  for (const [index, line] of fields.products.entries()) {
    const prefix = `products.${index}`;
    if (line.lineTotalSource === "derived")
      add(
        `${prefix}.lineTotalSource`,
        "This line total was calculated, not read from the receipt. Review it and mark its source as reviewed before posting."
      );

    const price = minor(line.unitPrice, `${prefix}.unitPrice`);
    const total = minor(line.lineTotal, `${prefix}.lineTotal`);
    const discount =
      line.lineDiscount == null ? 0 : minor(line.lineDiscount, `${prefix}.lineDiscount`);
    const quantityMilli = Math.round(line.quantity * 1000);
    if (
      !Number.isFinite(line.quantity) ||
      line.quantity <= 0 ||
      !Number.isSafeInteger(quantityMilli) ||
      Math.abs(line.quantity * 1000 - quantityMilli) > 0.000001
    ) {
      add(`${prefix}.quantity`, "Enter a positive quantity within the supported range.");
      continue;
    }
    if (price !== null && total !== null && discount !== null) {
      const expectedInteger =
        (BigInt(quantityMilli) * BigInt(price) + 500n) / 1000n - BigInt(discount);
      const expected = Number(expectedInteger);
      if (expectedInteger < 0n || !Number.isSafeInteger(expected) || Math.abs(expected - total) > 1)
        add(
          `${prefix}.lineTotal`,
          "Quantity multiplied by unit price minus line discount does not match the line total."
        );
      sum += total;
      if (!Number.isSafeInteger(sum))
        add("products", "The line total exceeds the supported range.");
    }
  }
  const subtotal = amounts.get("subtotal") ?? null;
  const total = amounts.get("total") ?? null;
  const paid = amounts.get("amountPaid") ?? null;
  const balance = amounts.get("balance") ?? null;
  if (!fields.products.length)
    add("products", "Review at least one product before recording a purchase.");
  if (total === null)
    add(
      "receipt.total",
      "Enter the receipt total before posting; it is not inferred from products."
    );
  if (subtotal !== null && Math.abs(subtotal - sum) > 1)
    add("receipt.subtotal", "The subtotal does not match the product line totals.");
  const tax = amounts.get("tax") ?? 0;
  if (tax > 0 && (!receipt.taxBasis || receipt.taxBasis === "unknown"))
    add("receipt.taxBasis", "Confirm whether the subtotal includes tax before posting.");
  if (receipt.taxBasis === "inclusive" && total !== null && tax > total)
    add("receipt.tax", "Included tax cannot exceed the receipt total.");
  const expected =
    (subtotal ?? sum) -
    (amounts.get("discount") ?? 0) +
    (receipt.taxBasis === "inclusive" ? 0 : tax);
  if (
    total !== null &&
    (expected < 0 || !Number.isSafeInteger(expected) || Math.abs(expected - total) > 1)
  )
    add("receipt.total", "Subtotal minus discount plus tax does not match the grand total.");
  if (total !== null && balance !== null && balance > total)
    add("receipt.balance", "The outstanding balance exceeds the receipt total.");
  if (total !== null && paid !== null && paid > total)
    add("receipt.amountPaid", "The paid amount exceeds the receipt total.");
  if (total !== null && paid !== null && balance !== null && Math.abs(total - paid - balance) > 1)
    add("receipt.balance", "Total minus paid amount does not match the balance.");
  return findings;
}
