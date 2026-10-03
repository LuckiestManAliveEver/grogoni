/**
 * The fulfillment order row (`fulfillment_orders`): the stable, lockable, Postgres-authoritative
 * record of one confirmed canonical order in fulfillment (Phase 1b/1c). Intake writes the order's
 * canonical A5 weight onto it once, from the immutable confirmation snapshots; pooling and
 * allocation read that value under the row lock and never recompute it.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ConfirmedOrderReference } from "@grogoni/shared-types";

export type FulfillmentOrderState = "POOLED" | "ALLOCATED" | "DELIVERED" | "CANCELLED" | "ORPHANED";

export interface FulfillmentOrderRow {
  id: string;
  business_id: string;
  invoice_id: string;
  customer_id: string | null;
  confirmed_at: Date;
  weight_status: "RESOLVED" | "UNRESOLVED" | null;
  total_weight_grams: string | null;
  unresolved_line_ids: string[];
  state: FulfillmentOrderState;
  source: string | null;
  taken_in_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
}

/**
 * Idempotent intake upsert. A new row is created POOLED with the order's weight; an existing row
 * (for example one a Phase 1b resolution created before intake) only gets its weight filled in
 * if it had none. Never changes the state of an existing row.
 */
export async function upsertFulfillmentOrder(
  client: PoolClient,
  businessId: string,
  order: ConfirmedOrderReference,
  now: Date
): Promise<{ row: FulfillmentOrderRow; created: boolean }> {
  const weight = order.weight;
  const inserted = await client.query<FulfillmentOrderRow>(
    `
      insert into fulfillment_orders
        (id, business_id, invoice_id, customer_id, confirmed_at, created_at, weight_status,
         total_weight_grams, unresolved_line_ids, state, source, taken_in_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::text[], 'POOLED', $10, $6, $6)
      on conflict (business_id, invoice_id) do nothing
      returning *
    `,
    [
      randomUUID(),
      businessId,
      order.invoiceId,
      order.customerId,
      order.confirmedAt,
      now,
      weight.status,
      weight.status === "RESOLVED" ? weight.totalWeightGrams : null,
      weight.status === "RESOLVED" ? [] : weight.unresolvedLineIds,
      order.source
    ]
  );
  if (inserted.rows[0] !== undefined) return { row: inserted.rows[0], created: true };
  const filled = await client.query<FulfillmentOrderRow>(
    `
      update fulfillment_orders
      set weight_status = $3, total_weight_grams = $4::bigint, unresolved_line_ids = $5::text[],
          source = coalesce(source, $6), taken_in_at = coalesce(taken_in_at, $7), updated_at = $7
      where business_id = $1 and invoice_id = $2 and weight_status is null
      returning *
    `,
    [
      businessId,
      order.invoiceId,
      weight.status,
      weight.status === "RESOLVED" ? weight.totalWeightGrams : null,
      weight.status === "RESOLVED" ? [] : weight.unresolvedLineIds,
      order.source,
      now
    ]
  );
  if (filled.rows[0] !== undefined) return { row: filled.rows[0], created: true };
  const existing = await client.query<FulfillmentOrderRow>(
    "select * from fulfillment_orders where business_id = $1 and invoice_id = $2",
    [businessId, order.invoiceId]
  );
  return { row: existing.rows[0] as FulfillmentOrderRow, created: false };
}
