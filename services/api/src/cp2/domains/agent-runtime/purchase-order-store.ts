import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { validateRuntimeToolInput } from "@grogoni/tool-core";
import type { BusinessPermission } from "@grogoni/business-core";
import type { SupplierSummary } from "@grogoni/shared-types";
import { canonicalJson } from "../model-templates/manifest.js";
import { Cp2Error } from "../../cp2-error.js";
import { stableUuid } from "./shared.js";
import type { PurchaseDraft } from "./inventory-procurement-store.js";

export type PurchaseOrderActor = { sessionId: string | null; businessId: string };
export type PurchaseOrderSubmission = {
  draftId: string;
  draftDigest: string;
  channel: "grogoni" | "email" | "whatsapp";
  recipient: string;
  mailboxId?: string;
  optInConfirmed?: boolean;
};
export interface PurchaseOrderReceipt {
  order_id: string;
  business_id: string;
  draft_id: string;
  actor_id: string;
  draft_digest: string;
  channel: PurchaseOrderSubmission["channel"];
  recipient: string;
  recipient_business_id: string | null;
  mailbox_id: string | null;
  snapshot: {
    id: string;
    businessId: string;
    supplierId: string;
    currency: string;
    totalMinor: number;
    items: { productId: string; quantityMilli: number; totalMinor: number; unit: string }[];
  };
  status:
    | "SUBMITTED_IN_APP"
    | "DISPATCHING"
    | "PROVIDER_ACCEPTED"
    | "DELIVERY_UNKNOWN"
    | "ACCEPTED"
    | "REJECTED";
  revision: number;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
export interface PurchaseOrderDelivery {
  check(actor: PurchaseOrderActor, input: PurchaseOrderSubmission): Promise<void>;
  send(
    actor: PurchaseOrderActor,
    input: PurchaseOrderSubmission,
    order: PurchaseOrderReceipt
  ): Promise<{ providerMessageId: string }>;
}
type Transaction = <T>(work: (client: Pick<PoolClient, "query">) => Promise<T>) => Promise<T>;
type Authorize = (actor: PurchaseOrderActor & { permission: BusinessPermission }) => {
  userId: string;
};
const conflict = (message: string) => new Cp2Error(409, "purchase_order_conflict", message);
export const purchaseDraftDigest = (draft: PurchaseDraft) =>
  createHash("sha256").update(canonicalJson(draft)).digest("hex");
const supplierSnapshot = (draft: PurchaseDraft): PurchaseOrderReceipt["snapshot"] => ({
  id: draft.id,
  businessId: draft.businessId,
  supplierId: draft.supplierId,
  currency: draft.currency,
  totalMinor: draft.totalMinor,
  items: draft.items.map((item) => ({
    productId: item.productId,
    quantityMilli: item.quantityMilli,
    totalMinor: item.totalMinor,
    unit: draft.units[item.productId]!
  }))
});

/** Only the existing confirmation-gated capability dispatcher calls submit/respond. */
export function createPurchaseOrderStore(
  transaction: Transaction,
  authorize: Authorize,
  delivery?: PurchaseOrderDelivery
) {
  return {
    async orders(actor: PurchaseOrderActor) {
      const { userId } = authorize({ ...actor, permission: "supplier:read" });
      return transaction(async (client) => {
        const outgoing = (
          await client.query<PurchaseOrderReceipt>(
            "select * from business_purchase_orders where business_id=$1 order by created_at desc limit 100",
            [actor.businessId]
          )
        ).rows;
        const incoming = (
          await client.query<PurchaseOrderReceipt>(
            "select * from business_purchase_orders where recipient_business_id=$1 order by created_at desc limit 100",
            [actor.businessId]
          )
        ).rows;
        const drafts = (
          await client.query<{ record: PurchaseDraft }>(
            "select record from business_purchase_drafts where business_id=$1 and actor_id=$2 order by created_at desc limit 100",
            [actor.businessId, userId]
          )
        ).rows.map(({ record }) => ({
          ...supplierSnapshot(record),
          digest: purchaseDraftDigest(record)
        }));
        const recipients = (
          await client.query<{ supplierId: string; businessId: string; name: string }>(
            `select distinct l.record->>'supplierId' as "supplierId",b.entity_id as "businessId",coalesce(b.record->>'name',b.entity_id) as name
          from cp2_supplier_contact_links l join cp2_network_nodes n on n.entity_id=l.record->>'networkNodeId'
          join cp2_businesses b on b.entity_id=n.record->>'grogoniBusinessId'
          where l.record->>'businessId'=$1 and l.record->>'linkType'='supplier' and n.record->>'ownerUserId'=$2
            and n.record->>'consentStatus'='granted' and n.record->>'visibilityStatus'='direct' and b.entity_id<>$1
          order by "supplierId","businessId" limit 100`,
            [actor.businessId, userId]
          )
        ).rows;
        return {
          drafts,
          recipients,
          outgoing,
          incoming: incoming.map((order) => ({
            order_id: order.order_id,
            business_id: order.business_id,
            channel: order.channel,
            status: order.status,
            revision: order.revision,
            snapshot: order.snapshot,
            created_at: order.created_at
          }))
        };
      });
    },
    async submit(
      actor: PurchaseOrderActor,
      input: PurchaseOrderSubmission,
      actionId: string,
      now = new Date()
    ) {
      const { userId } = authorize({ ...actor, permission: "supplier:write" });
      if (
        !validateRuntimeToolInput("procurement.submit", input).ok ||
        !actionId ||
        !Number.isFinite(now.getTime())
      )
        throw conflict("Invalid exact purchase order approval.");
      if (input.channel !== "grogoni") {
        if (!delivery)
          throw new Cp2Error(
            503,
            "purchase_order_channel_unavailable",
            "This external channel is not configured."
          );
        await delivery.check(actor, input);
      }
      const saved = await transaction(async (client) => {
        const row = (
          await client.query<{ record: PurchaseDraft; actor_id: string }>(
            "select record,actor_id from business_purchase_drafts where business_id=$1 and draft_id=$2 for update",
            [actor.businessId, input.draftId]
          )
        ).rows[0];
        if (!row || row.actor_id !== userId)
          throw new Cp2Error(
            404,
            "purchase_draft_not_found",
            "Purchase draft not found for this actor."
          );
        const draft = row.record;
        if (purchaseDraftDigest(draft) !== input.draftDigest)
          throw conflict("The reviewed draft changed; review and approve it again.");
        const existing = (
          await client.query<PurchaseOrderReceipt>(
            "select * from business_purchase_orders where business_id=$1 and draft_id=$2",
            [actor.businessId, input.draftId]
          )
        ).rows[0];
        if (existing) {
          if (
            existing.channel !== input.channel ||
            existing.recipient !== input.recipient ||
            existing.mailbox_id !== (input.mailboxId ?? null) ||
            existing.draft_digest !== input.draftDigest
          )
            throw conflict(
              "This draft already has a different submission. No duplicate order was sent."
            );
          return { order: existing, created: false };
        }
        const verified = (
          await client.query(
            "select status,claim_eligible from business_environment_task_verifications where business_id=$1 and task_id=$2 and actor_id=$3 order by evidence_sequence desc limit 1",
            [actor.businessId, draft.taskId, userId]
          )
        ).rows[0];
        if (verified?.status !== "PASSED" || verified.claim_eligible !== true)
          throw conflict("Independent draft verification must pass before submission.");
        const supplier = (
          await client.query<{ record: SupplierSummary }>(
            "select record from cp2_suppliers where business_id=$1 and entity_id=$2",
            [actor.businessId, draft.supplierId]
          )
        ).rows[0]?.record;
        if (!supplier || supplier.businessId !== actor.businessId)
          throw conflict("Supplier is no longer available.");
        for (const item of draft.items) {
          const quote = (
            await client.query<{ record: { expiresAt: string } }>(
              "select record from business_supplier_quotes where business_id=$1 and quote_id=$2",
              [actor.businessId, item.quoteId]
            )
          ).rows[0]?.record;
          if (!quote || !(Date.parse(quote.expiresAt) > now.getTime()))
            throw conflict("A supplier quote expired; prepare and review a new draft.");
        }
        if (input.channel === "grogoni") {
          const linked = (
            await client.query(
              `select 1 from cp2_supplier_contact_links l join cp2_network_nodes n on n.entity_id=l.record->>'networkNodeId' join cp2_businesses b on b.entity_id=n.record->>'grogoniBusinessId'
            where l.record->>'businessId'=$1 and l.record->>'supplierId'=$2 and l.record->>'linkType'='supplier'
              and n.record->>'ownerUserId'=$3 and n.record->>'grogoniBusinessId'=$4
              and n.record->>'consentStatus'='granted' and n.record->>'visibilityStatus'='direct'`,
              [actor.businessId, draft.supplierId, userId, input.recipient]
            )
          ).rows[0];
          if (!linked || input.recipient === actor.businessId)
            throw conflict("Select the supplier's consented linked GroGoni business.");
        } else if (input.channel === "email") {
          if (supplier.email?.trim().toLowerCase() !== input.recipient.trim().toLowerCase())
            throw conflict("The approved email must match the supplier's saved address.");
        } else if (supplier.phone?.replace(/[\s()-]/g, "") !== input.recipient)
          throw conflict(
            "The approved WhatsApp number must match the supplier's saved E.164 number."
          );
        const order = (
          await client.query<PurchaseOrderReceipt>(
            `insert into business_purchase_orders
          (order_id,business_id,draft_id,actor_id,draft_digest,channel,recipient,recipient_business_id,snapshot,status,created_at,updated_at,mailbox_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$11,$12) returning *`,
            [
              stableUuid(`purchase-order:${actor.businessId}:${draft.id}`),
              actor.businessId,
              draft.id,
              userId,
              input.draftDigest,
              input.channel,
              input.recipient,
              input.channel === "grogoni" ? input.recipient : null,
              JSON.stringify(supplierSnapshot(draft)),
              input.channel === "grogoni" ? "SUBMITTED_IN_APP" : "DISPATCHING",
              now,
              input.mailboxId ?? null
            ]
          )
        ).rows[0]!;
        return { order, created: true };
      });
      if (!saved.created || input.channel === "grogoni") return saved.order;
      // Commit the reservation before the provider call. An ambiguous send is never retried.
      let providerMessageId: string | null = null;
      try {
        const result = await delivery!.send(actor, input, saved.order);
        if (
          typeof result.providerMessageId !== "string" ||
          !result.providerMessageId.trim() ||
          result.providerMessageId.length > 500
        )
          throw new Error("Missing provider acknowledgment.");
        providerMessageId = result.providerMessageId;
      } catch {
        // Provider bodies may contain credentials or recipient data; retain only a safe code.
      }
      return transaction(
        async (client) =>
          (
            await client.query<PurchaseOrderReceipt>(
              `update business_purchase_orders set status=$3,provider_message_id=$4,error_code=$5,revision=revision+1,updated_at=$6 where business_id=$1 and order_id=$2 and status='DISPATCHING' returning *`,
              [
                actor.businessId,
                saved.order.order_id,
                providerMessageId ? "PROVIDER_ACCEPTED" : "DELIVERY_UNKNOWN",
                providerMessageId,
                providerMessageId ? null : "PROVIDER_ACKNOWLEDGMENT_UNKNOWN",
                now
              ]
            )
          ).rows[0] ?? saved.order
      );
    },
    async respond(
      actor: PurchaseOrderActor,
      input: { orderId: string; revision: number; decision: "ACCEPTED" | "REJECTED" },
      now = new Date()
    ) {
      authorize({ ...actor, permission: "supplier:write" });
      if (!validateRuntimeToolInput("procurement.respond", input).ok)
        throw conflict("Invalid order response.");
      return transaction(async (client) => {
        const result = (
          await client.query<PurchaseOrderReceipt>(
            `update business_purchase_orders set status=$4,revision=revision+1,updated_at=$5 where recipient_business_id=$1 and order_id=$2 and revision=$3 and status='SUBMITTED_IN_APP' returning *`,
            [actor.businessId, input.orderId, input.revision, input.decision, now]
          )
        ).rows[0];
        if (!result)
          throw conflict(
            "This incoming order is unavailable or already answered. Refresh before approving."
          );
        return result;
      });
    }
  };
}
