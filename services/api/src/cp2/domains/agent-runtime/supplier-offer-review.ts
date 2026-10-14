import type { Pool } from "pg";
import type { SupplierOfferReview } from "@grogoni/shared-types";
import type { Cp2Store } from "../../store.js";
import type { SupplierQuoteInput } from "./inventory-procurement-store.js";

export async function readSupplierOffers(
  runtime: Pick<Cp2Store, "authorizeBusinessPermission">,
  native: <T>(work: (pool: Pool) => Promise<T>) => Promise<T>,
  actor: { sessionId: string | null; businessId: string }
): Promise<{ offers: SupplierOfferReview[]; truncated: boolean }> {
  for (const permission of ["supplier:read", "product:read"] as const)
    runtime.authorizeBusinessPermission({ ...actor, permission });
  const records = await native(
    async (pool) =>
      (
        await pool.query<{
          record: SupplierQuoteInput;
          product_name: string | null;
          supplier_name: string | null;
        }>(
          `select q.record,p.record->>'name' as product_name,s.record->>'name' as supplier_name
      from business_supplier_quotes q
      left join cp2_products p on p.business_id=q.business_id and p.entity_id=q.record->>'productId'
      left join cp2_suppliers s on s.business_id=q.business_id and s.entity_id=q.record->>'supplierId'
      where q.business_id=$1 order by q.created_at desc,q.quote_id limit 201`,
          [actor.businessId]
        )
      ).rows
  );
  return {
    truncated: records.length > 200,
    offers: records.slice(0, 200).map(({ record, product_name, supplier_name }) => ({
      id: record.id,
      productId: record.productId,
      productName: product_name ?? "Product unavailable",
      supplierId: record.supplierId,
      supplierName: supplier_name ?? "Supplier unavailable",
      currency: record.currency,
      unit: record.unit,
      unitPriceMinor: record.unitPriceMinor,
      priceIncludesCharges: record.priceIncludesCharges,
      minQuantityMilli: record.minQuantityMilli,
      incrementMilli: record.incrementMilli,
      availableQuantityMilli: record.availableQuantityMilli,
      leadTimeDays: record.leadTimeDays,
      expiresAt: record.expiresAt
    }))
  };
}
