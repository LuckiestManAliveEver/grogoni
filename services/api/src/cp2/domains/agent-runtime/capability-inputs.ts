import type { ProductFieldInputType } from "@grogoni/shared-types";

export function runtimeInvoiceItems(value: unknown): Array<{
  productId: string;
  quantity: number;
  unitPrice: number;
}> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [
      {
        productId: String(record.productId ?? ""),
        quantity: Number(record.quantity),
        unitPrice: Number(record.unitPrice)
      }
    ];
  });
}

export function optionalRuntimeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isProductFieldInputType(value: unknown): value is ProductFieldInputType {
  return ["text", "number", "select", "textarea", "yes_no"].includes(String(value));
}

export function runtimeProductFieldId(label: string): string {
  const normalized = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);

  return normalized || "custom-field";
}
