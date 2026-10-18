import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Pool, PoolClient } from "pg";
import {
  planInventoryReplenishment,
  validateInventorySupplierOffer,
  type InventoryReplenishmentObservation,
  type InventoryReplenishmentPlan,
  type BusinessPermission
} from "@grogoni/business-core";
import type { BusinessTask } from "@grogoni/tool-core";
import type { ProductSummary, InvoiceSummary, SupplierSummary } from "@grogoni/shared-types";
import { canonicalJson } from "../model-templates/manifest.js";
import { Cp2Error } from "../../cp2-error.js";
import { stableUuid } from "./shared.js";
import { createPurchaseOrderStore, type PurchaseOrderDelivery } from "./purchase-order-store.js";
import {
  experienceSourceEvidence,
  type ExperienceSourceEvidence
} from "./experience-source-evidence.js";

interface Actor {
  sessionId: string | null;
  businessId: string;
}
type Authorize = (actor: Actor & { permission: BusinessPermission }) => { userId: string };
export type SupplierQuoteInput = Omit<
  InventoryReplenishmentObservation["offers"][number],
  "businessId" | "supplierActive" | "sourceRef"
> & { priceIncludesCharges: true; unit: string };
type StoredSupplierQuote = SupplierQuoteInput & { businessId: string; unit: string };
type ProcurementObservation = Omit<InventoryReplenishmentObservation, "offers"> & {
  productNames: Record<string, string>;
  sourceEvidence: ExperienceSourceEvidence;
  offers: (InventoryReplenishmentObservation["offers"][number] & { unit: string })[];
};
export interface PurchaseDraft {
  id: string;
  businessId: string;
  taskId: string;
  actionId: string;
  supplierId: string;
  status: "DRAFT";
  submissionStatus: "NOT_SUBMITTED";
  requiresSubmissionApproval: true;
  currency: string;
  totalMinor: number;
  items: InventoryReplenishmentPlan["items"];
  units: Record<string, string>;
  productNames?: Record<string, string>;
  recommendation: InventoryReplenishmentPlan;
  createdAt: string;
}
type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
const invalid = (message: string) => new Cp2Error(409, "procurement_incomplete", message);
const milli = (value: number) => {
  const result = Math.round(value * 1000);
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0 ||
    Math.abs(result / 1000 - value) > 1e-9
  )
    throw invalid("Inventory quantities need safe nonnegative thousandth-unit precision.");
  return result;
};

/** Observes committed records only; the forecast is an estimate, never evidence of future sales. */
export async function observeProcurementInventory(
  client: PoolClient,
  businessId: string,
  now: Date
): Promise<ProcurementObservation> {
  const { products, invoices, suppliers, quotes } = (
    await client.query<{
      products: Pick<ProductSummary, "id" | "businessId" | "quantity" | "unit" | "name">[];
      invoices: Pick<InvoiceSummary, "id" | "businessId" | "confirmedAt" | "items">[];
      suppliers: Pick<SupplierSummary, "id" | "businessId">[];
      quotes: StoredSupplierQuote[];
    }>(
      `select
    (select coalesce(jsonb_agg(record order by entity_id),'[]'::jsonb) from
      (select entity_id,jsonb_build_object('id',record->'id','businessId',record->'businessId','quantity',record->'quantity','unit',record->'unit','name',record->'name') as record
       from cp2_products where business_id=$1 order by entity_id limit 501) p) as products,
    (select coalesce(jsonb_agg(record order by entity_id),'[]'::jsonb) from
      (select entity_id,jsonb_build_object('id',record->'id','businessId',record->'businessId','confirmedAt',record->'confirmedAt','items',record->'items') as record
       from cp2_invoices where business_id=$1 and record->>'status'='confirmed'
       and (record->>'confirmedAt')::timestamptz >= $2 order by entity_id limit 10001) i) as invoices,
    (select coalesce(jsonb_agg(record order by entity_id),'[]'::jsonb) from
      (select entity_id,jsonb_build_object('id',record->'id','businessId',record->'businessId') as record
       from cp2_suppliers where business_id=$1 order by entity_id limit 1001) s) as suppliers,
    (select coalesce(jsonb_agg(record order by quote_id),'[]'::jsonb) from
      (select quote_id,record from business_supplier_quotes where business_id=$1 order by quote_id limit 5001) q) as quotes`,
      [businessId, new Date(now.getTime() - 7 * 86400_000)]
    )
  ).rows[0]!;
  if (
    products.length > 500 ||
    invoices.length > 10000 ||
    suppliers.length > 1000 ||
    quotes.length > 5000
  )
    throw invalid("Observation exceeds resource limits; narrow the business task.");
  if (
    [...products, ...invoices, ...suppliers, ...quotes].some(
      (record) => record.businessId !== businessId || !record.id
    )
  )
    throw invalid("Business observation identity is inconsistent.");
  if (quotes.some((quote) => quote.priceIncludesCharges !== true))
    throw invalid("Supplier quote charges are not fully specified.");
  const dates = invoices.map((invoice) => Date.parse(invoice.confirmedAt ?? ""));
  if (dates.some((date) => !Number.isFinite(date) || date > now.getTime()))
    throw invalid("Sales evidence has invalid timestamps.");
  const earliest = dates.length ? Math.min(...dates) : now.getTime();
  const days = Math.ceil((now.getTime() - earliest) / 86400_000);
  const productIds = new Set(products.map((product) => product.id));
  const supplierIds = new Set(suppliers.map((supplier) => supplier.id));
  const sales = new Map<
    string,
    { sold: bigint; refs: Set<string>; hash: ReturnType<typeof createHash> }
  >();
  let lines = 0;
  const sourceInvoices = new Set<string>();
  for (const invoice of invoices) {
    if (!Array.isArray(invoice.items)) throw invalid("Sales line evidence is missing.");
    lines += invoice.items.length;
    if (lines > 50000) throw invalid("Sales line observation exceeds resource limits.");
    for (const [index, item] of invoice.items.entries()) {
      if (!productIds.has(item.productId)) continue;
      const quantity = milli(item.quantity);
      if (quantity === 0) throw invalid("Confirmed sales must have positive quantities.");
      sourceInvoices.add(invoice.id);
      const sale = sales.get(item.productId) ?? {
        sold: 0n,
        refs: new Set<string>(),
        hash: createHash("sha256")
      };
      sale.sold += BigInt(quantity);
      if (sale.refs.size < 20) sale.refs.add(`invoice:${invoice.id}`);
      sale.hash.update(
        canonicalJson({ invoiceId: invoice.id, index, quantity, confirmedAt: invoice.confirmedAt })
      );
      sales.set(item.productId, sale);
    }
  }
  const inventoryRef = `inventory:${createHash("sha256")
    .update(
      canonicalJson(
        products.map(({ id, businessId: scope, quantity, unit }) => ({
          id,
          businessId: scope,
          quantity,
          unit
        }))
      )
    )
    .digest("hex")}`;
  return {
    businessId,
    observedAt: now.toISOString(),
    productNames: Object.fromEntries(
      products.map((product) => [
        product.id,
        typeof product.name === "string" && product.name.trim() ? product.name : product.id
      ])
    ),
    sourceEvidence: experienceSourceEvidence(businessId, sourceInvoices),
    sourceRefs: [
      inventoryRef,
      `confirmed-sales-window:${new Date(earliest).toISOString()}:${now.toISOString()}`
    ],
    products: products.map((product) => {
      const sale = sales.get(product.id);
      const demand =
        now.getTime() - earliest >= 86400_000 && sale
          ? (sale.sold + BigInt(days) - 1n) / BigInt(days)
          : null;
      if (demand !== null && demand > BigInt(Number.MAX_SAFE_INTEGER))
        throw invalid("Sales quantities exceed resource limits.");
      return {
        id: product.id,
        businessId,
        onHandMilli: milli(product.quantity),
        dailyDemandMilli: demand === null ? null : Number(demand),
        demandSourceRefs: sale ? [...sale.refs, `confirmed-sales:${sale.hash.digest("hex")}`] : []
      };
    }),
    offers: quotes
      .filter(
        (quote) =>
          productIds.has(quote.productId) &&
          products.find((product) => product.id === quote.productId)?.unit === quote.unit
      )
      .map((quote) => ({
        ...quote,
        supplierActive: supplierIds.has(quote.supplierId),
        sourceRef: `supplier-quote:${quote.id}`
      }))
  };
}

/** Native operations used only by the canonical capability dispatcher; no alternate agent loop. */
export function createInventoryProcurementStore(
  transaction: Transaction,
  authorize: Authorize,
  delivery?: PurchaseOrderDelivery
) {
  return {
    ...createPurchaseOrderStore(transaction, authorize, delivery),
    async recordQuote(actor: Actor, quote: SupplierQuoteInput, now = new Date()) {
      const { userId } = authorize({ ...actor, permission: "supplier:write" });
      authorize({ ...actor, permission: "product:read" });
      if (quote.priceIncludesCharges !== true)
        throw invalid("Quote prices must explicitly include all charges.");
      if (
        !quote.id ||
        quote.id.length > 200 ||
        !Number.isFinite(now.getTime()) ||
        Date.parse(quote.expiresAt) <= now.getTime()
      )
        throw invalid("Supplier quote must have a stable identifier and future expiry.");
      validateInventorySupplierOffer(
        {
          ...quote,
          businessId: actor.businessId,
          supplierActive: true,
          sourceRef: `supplier-quote:${quote.id}`
        },
        actor.businessId
      );
      return transaction(async (client) => {
        const product = (
          await client.query<{ record: ProductSummary }>(
            "select record from cp2_products where business_id=$1 and entity_id=$2",
            [actor.businessId, quote.productId]
          )
        ).rows[0]?.record;
        const supplier = (
          await client.query<{ record: SupplierSummary }>(
            "select record from cp2_suppliers where business_id=$1 and entity_id=$2",
            [actor.businessId, quote.supplierId]
          )
        ).rows[0]?.record;
        if (
          !product ||
          product.id !== quote.productId ||
          product.businessId !== actor.businessId ||
          !supplier ||
          supplier.id !== quote.supplierId ||
          supplier.businessId !== actor.businessId
        )
          throw invalid("Supplier or product is unavailable in this business.");
        if (typeof product.unit !== "string" || !product.unit.trim() || product.unit.length > 100)
          throw invalid("The product's canonical quantity unit is missing.");
        if (quote.unit !== product.unit)
          throw invalid(
            "The product quantity unit changed; a new exact quote approval is required."
          );
        const record: StoredSupplierQuote = {
          ...quote,
          businessId: actor.businessId,
          unit: product.unit
        };
        const saved = (
          await client.query<{ record: typeof record }>(
            `insert into business_supplier_quotes (business_id,quote_id,created_by,record)
          values ($1,$2,$3,$4::jsonb) on conflict (business_id,quote_id) do update set record=business_supplier_quotes.record
          where business_supplier_quotes.record=excluded.record returning record`,
            [actor.businessId, quote.id, userId, JSON.stringify(record)]
          )
        ).rows[0];
        if (!saved) throw invalid("Quote identifier already represents a different offer.");
        return saved.record;
      });
    },
    async prepare(
      actor: Actor,
      taskId: string,
      actionId: string,
      now = new Date()
    ): Promise<{ recommendation: InventoryReplenishmentPlan; drafts: PurchaseDraft[] }> {
      const { userId } = authorize({ ...actor, permission: "import:write" });
      authorize({ ...actor, permission: "product:read" });
      authorize({ ...actor, permission: "invoice:read" });
      authorize({ ...actor, permission: "supplier:read" });
      if (!Number.isFinite(now.getTime())) throw invalid("Invalid procurement time.");
      return transaction(async (client) => {
        const environment = (
          await client.query(
            `select 1 from business_environment_instances
          where business_id=$1 and task_id=$2 and actor_id=$3 and instance->>'status'='RUNNING' and expires_at>$4
          for update`,
            [actor.businessId, taskId, userId, now]
          )
        ).rows[0];
        if (!environment) throw invalid("Procurement requires a running, unexpired environment.");
        const task = (
          await client.query<{ task: BusinessTask }>(
            `select task from business_environment_tasks
          where business_id=$1 and task_id=$2 and actor_id=$3 for update`,
            [actor.businessId, taskId, userId]
          )
        ).rows[0]?.task;
        if (!task) throw new Cp2Error(404, "business_task_not_found", "Task not found.");
        const steps = task.plan.filter((step) => step.capability === "procurement.prepare");
        if (
          task.executionMode !== "LIVE" ||
          steps.length !== 1 ||
          stableUuid(steps[0]!.idempotencyKey) !== actionId ||
          steps[0]!.input.taskId !== taskId ||
          task.constraints.budgetMinor === null ||
          task.constraints.currency === null ||
          task.constraints.horizonDays === null
        )
          throw invalid(
            "Procurement requires one exact compiled preparation action with a budget and horizon."
          );
        if (
          !(
            await client.query(
              `select 1 from business_environment_task_steps
          where business_id=$1 and task_id=$2 and actor_id=$3 and step_id=$4 and status='RUNNING'`,
              [actor.businessId, taskId, userId, steps[0]!.id]
            )
          ).rows[0]
        )
          throw invalid("The preparation step must be durably claimed before execution.");
        const existing = (
          await client.query<{ record: PurchaseDraft }>(
            `select record from business_purchase_drafts where business_id=$1 and task_id=$2 and action_id=$3 order by supplier_id`,
            [actor.businessId, taskId, actionId]
          )
        ).rows.map((row) => row.record);
        if (existing.length)
          return { recommendation: existing[0]!.recommendation, drafts: existing };
        const spent = BigInt(
          (
            await client.query<{ total: string }>(
              "select coalesce(sum(total_minor),0)::text as total from business_purchase_drafts where business_id=$1 and task_id=$2",
              [actor.businessId, taskId]
            )
          ).rows[0]!.total
        );
        const remaining = BigInt(task.constraints.budgetMinor) - spent;
        if (remaining < 0n) throw invalid("Task budget is already exceeded.");
        const observation = await observeProcurementInventory(client, actor.businessId, now);
        const recommendation = planInventoryReplenishment({
          businessId: actor.businessId,
          budgetMinor: Number(remaining),
          currency: task.constraints.currency,
          horizonDays: task.constraints.horizonDays,
          observation,
          now
        });
        if (
          recommendation.items.length > 50 ||
          new Set(recommendation.items.map((item) => item.supplierId)).size > 20 ||
          Buffer.byteLength(JSON.stringify(recommendation)) > 64000
        ) {
          throw invalid("Preparation exceeds draft batch or evidence limits; narrow the task.");
        }
        const drafts: PurchaseDraft[] = [];
        for (const supplierId of [
          ...new Set(recommendation.items.map((item) => item.supplierId))
        ].sort()) {
          const items = recommendation.items.filter((item) => item.supplierId === supplierId);
          const draft: PurchaseDraft = {
            id: stableUuid(`${actionId}:${supplierId}`),
            businessId: actor.businessId,
            taskId,
            actionId,
            supplierId,
            status: "DRAFT",
            submissionStatus: "NOT_SUBMITTED",
            requiresSubmissionApproval: true,
            currency: task.constraints.currency,
            totalMinor: items.reduce((total, item) => total + item.totalMinor, 0),
            items,
            units: Object.fromEntries(
              items.map((item) => [
                item.productId,
                observation.offers.find((offer) => offer.id === item.quoteId)!.unit
              ])
            ),
            productNames: Object.fromEntries(
              items.map((item) => [item.productId, observation.productNames[item.productId]!])
            ),
            recommendation,
            createdAt: now.toISOString()
          };
          await client.query(
            `insert into business_purchase_drafts (business_id,task_id,action_id,supplier_id,draft_id,actor_id,total_minor,record)
            values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [
              actor.businessId,
              taskId,
              actionId,
              supplierId,
              draft.id,
              userId,
              draft.totalMinor,
              JSON.stringify(draft)
            ]
          );
          drafts.push(draft);
        }
        return { recommendation, drafts };
      });
    }
  };
}

export function createPostgresInventoryProcurementStore(
  pool: Pool,
  authorize: Authorize,
  delivery?: PurchaseOrderDelivery
) {
  return createInventoryProcurementStore(
    async (work) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    authorize,
    delivery
  );
}

export type InventoryProcurementStore = ReturnType<typeof createInventoryProcurementStore>;
