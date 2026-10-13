import type { PoolClient } from "pg";
import type { BusinessTask, BusinessTaskPlanStep } from "@grogoni/tool-core";
import type { RuntimeTurnSummary } from "@grogoni/shared-types";
import { planInventoryReplenishment } from "@grogoni/business-core";
import { canonicalJson } from "../model-templates/manifest.js";
import { Cp2Error } from "../../cp2-error.js";
import { observeProcurementInventory, type PurchaseDraft } from "./inventory-procurement-store.js";
import { stableUuid } from "./shared.js";

export async function verifyProcurementDrafts(
  client: PoolClient,
  task: BusinessTask,
  step: BusinessTaskPlanStep,
  turn: RuntimeTurnSummary | null
) {
  const actionId = stableUuid(step.idempotencyKey);
  const records = (
    await client.query<{
      actor_id: string;
      action_id: string;
      total_minor: string;
      record: PurchaseDraft;
    }>(
      `select actor_id,action_id,total_minor::text,record from business_purchase_drafts
     where business_id=$1 and task_id=$2 order by draft_id limit 1001`,
      [task.businessId, task.id]
    )
  ).rows;
  const drafts = records.filter((row) => row.action_id === actionId).map((row) => row.record);
  const result = turn?.toolResult as { recommendation?: unknown; drafts?: unknown } | null;
  const normalize = (value: PurchaseDraft[]) => [...value].sort((a, b) => a.id.localeCompare(b.id));
  const persisted =
    Array.isArray(result?.drafts) &&
    canonicalJson(normalize(result.drafts as PurchaseDraft[])) === canonicalJson(normalize(drafts));
  let constraints: "PASSED" | "FAILED" | "INCONCLUSIVE" = "INCONCLUSIVE";
  let outcome = false;
  let observation: unknown = null;
  const budget = task.constraints.budgetMinor;
  const currency = task.constraints.currency;
  const horizonDays = task.constraints.horizonDays;
  const total = records.reduce((sum, row) => sum + BigInt(row.total_minor), 0n);
  const ownTotal = records
    .filter((row) => row.action_id === actionId)
    .reduce((sum, row) => sum + BigInt(row.total_minor), 0n);
  if (budget !== null && currency !== null && horizonDays !== null && records.length <= 1000) {
    constraints =
      total <= BigInt(budget) &&
      records.every(
        (row) =>
          row.actor_id === task.actorId &&
          row.record.businessId === task.businessId &&
          row.record.taskId === task.id &&
          row.record.actionId === row.action_id &&
          Number.isSafeInteger(row.record.totalMinor) &&
          BigInt(row.record.totalMinor) === BigInt(row.total_minor) &&
          row.record.currency === currency &&
          row.record.status === "DRAFT" &&
          row.record.submissionStatus === "NOT_SUBMITTED" &&
          row.record.requiresSubmissionApproval === true
      )
        ? "PASSED"
        : "FAILED";
    try {
      const at = new Date(turn?.createdAt ?? "invalid");
      if (!Number.isFinite(at.getTime()))
        throw new Cp2Error(409, "procurement_evidence_missing", "Execution timestamp is missing.");
      const source = await observeProcurementInventory(client, task.businessId, at);
      observation = source;
      for (const draft of drafts) {
        if (!Array.isArray(draft.items)) {
          constraints = "FAILED";
          break;
        }
        let cost = 0n;
        for (const item of draft.items) {
          const quote = source.offers.find((offer) => offer.id === item.quoteId);
          if (
            !quote ||
            quote.supplierId !== draft.supplierId ||
            quote.productId !== item.productId ||
            draft.units?.[item.productId] !== quote.unit ||
            !Number.isSafeInteger(item.quantityMilli) ||
            item.quantityMilli < quote.minQuantityMilli ||
            item.quantityMilli % quote.incrementMilli !== 0 ||
            item.quantityMilli > quote.availableQuantityMilli ||
            !Number.isSafeInteger(item.totalMinor)
          ) {
            constraints = "FAILED";
            break;
          }
          const itemCost =
            (BigInt(item.quantityMilli) * BigInt(quote.unitPriceMinor) + 999n) / 1000n;
          if (itemCost !== BigInt(item.totalMinor)) constraints = "FAILED";
          cost += itemCost;
        }
        if (cost !== BigInt(draft.totalMinor)) constraints = "FAILED";
      }
      const remaining = BigInt(budget) - (total - ownTotal);
      if (remaining >= 0n && remaining <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const expected = planInventoryReplenishment({
          businessId: task.businessId,
          budgetMinor: Number(remaining),
          currency,
          horizonDays,
          observation: source,
          now: at
        });
        outcome =
          constraints === "PASSED" &&
          persisted &&
          ["READY", "NOTHING_TO_REPLENISH"].includes(expected.status) &&
          canonicalJson(expected) === canonicalJson(result?.recommendation) &&
          drafts.every(
            (draft) => canonicalJson(draft.recommendation) === canonicalJson(expected)
          ) &&
          canonicalJson(
            drafts
              .flatMap((draft) => draft.items)
              .sort((a, b) => a.productId.localeCompare(b.productId))
          ) ===
            canonicalJson(
              [...expected.items].sort((a, b) => a.productId.localeCompare(b.productId))
            );
      }
    } catch (error) {
      if (
        !(error instanceof Cp2Error) &&
        !(error instanceof Error && error.message.startsWith("Invalid"))
      )
        throw error;
    }
  }
  return {
    constraints,
    persisted,
    outcome,
    state: { records, observation },
    evidenceRefs: drafts.map((draft) => `purchase-draft:${draft.id}`)
  };
}
