import type {
  Ack,
  BusinessChange,
  Collection,
  Entity,
  Operation,
  OfflineOrderIntentOutcome
} from "@grogoni/offline-runtime";
import { same } from "@grogoni/offline-runtime";
import { Cp2Error } from "./cp2-error.js";

export interface OfflineReceipt {
  id: string;
  accountId: string;
  businessId: string;
  deviceId: string;
  localSeq: number;
  operation: Operation;
  ack: Ack;
}
export class OfflineJournal {
  readonly receipts = new Map<string, OfflineReceipt>();
  readonly changes = new Map<string, BusinessChange>();
  /** Idempotency cache for offline order intents, keyed by the intent's own client-generated id.
   *  Unlike `receipts` (below), these have no per-device local sequence to order against - an
   *  intent can arrive from any customer device over BLE, or from a phone number over SMS - so
   *  this only ever dedupes a retried push, it never rejects one as "out of order". */
  private readonly orderIntentOutcomes = new Map<string, OfflineOrderIntentOutcome>();
  private sequence = 0;
  restore(receipts: OfflineReceipt[] = [], changes: BusinessChange[] = [], watermark = 0): void {
    this.receipts.clear();
    this.changes.clear();
    this.sequence = watermark;
    for (const receipt of receipts) this.receipts.set(receipt.id, receipt);
    for (const change of changes) {
      this.changes.set(change.id, change);
      this.sequence = Math.max(this.sequence, change.sequence);
    }
  }
  get cursor(): string {
    return String(this.sequence);
  }
  append(
    businessId: string,
    collection: Collection,
    entityId: string,
    entity: Entity | null
  ): void {
    const change = {
      id: crypto.randomUUID(),
      businessId,
      collection,
      entityId,
      entity: structuredClone(entity),
      sequence: ++this.sequence
    };
    this.changes.set(change.id, change);
  }
  replay(operation: Operation, apply: () => Entity): Ack {
    const key = JSON.stringify([
      operation.accountId,
      operation.storeId,
      operation.deviceId,
      operation.localSeq
    ]);
    const previous = this.receipts.get(key);
    if (previous) {
      if (!same(immutableOperation(previous.operation), immutableOperation(operation)))
        throw new Cp2Error(
          409,
          "offline_sequence_reused",
          "A device sequence cannot be reused for a different operation."
        );
      return structuredClone(previous.ack);
    }
    let max = 0;
    for (const receipt of this.receipts.values()) {
      if (
        receipt.accountId === operation.accountId &&
        receipt.businessId === operation.storeId &&
        receipt.deviceId === operation.deviceId
      )
        max = Math.max(max, receipt.localSeq);
    }
    if (operation.localSeq <= max)
      throw new Cp2Error(
        409,
        "offline_sequence_out_of_order",
        "Device operations must be pushed in order."
      );
    const entity = apply();
    const ack: Ack = {
      id: operation.id,
      localSeq: operation.localSeq,
      status: "ACKED",
      serverOpId: crypto.randomUUID(),
      entity,
      message: null
    };
    this.receipts.set(key, {
      id: key,
      accountId: operation.accountId,
      businessId: operation.storeId,
      deviceId: operation.deviceId,
      localSeq: operation.localSeq,
      operation: structuredClone(operation),
      ack: structuredClone(ack)
    });
    return ack;
  }
  /** Runs `apply()` at most once per intent id; a retried push of the same id returns the
   *  cached outcome instead of re-processing it (so a batch retry after a dropped HTTP response
   *  can never double-confirm or double-reject the same order). */
  replayOrderIntent(
    intentId: string,
    apply: () => OfflineOrderIntentOutcome
  ): OfflineOrderIntentOutcome {
    const cached = this.orderIntentOutcomes.get(intentId);
    if (cached) return structuredClone(cached);
    const outcome = apply();
    this.orderIntentOutcomes.set(intentId, structuredClone(outcome));
    return outcome;
  }
  recordFailure(operation: Operation, ack: Ack): void {
    const key = JSON.stringify([
      operation.accountId,
      operation.storeId,
      operation.deviceId,
      operation.localSeq
    ]);
    if (this.receipts.has(key)) return;
    this.receipts.set(key, {
      id: key,
      accountId: operation.accountId,
      businessId: operation.storeId,
      deviceId: operation.deviceId,
      localSeq: operation.localSeq,
      operation: structuredClone(operation),
      ack: structuredClone(ack)
    });
  }
  pull(businessId: string, since: string | null) {
    if (since !== null && !/^(0|[1-9]\d*)$/.test(since))
      throw new Cp2Error(400, "offline_cursor_invalid", "Invalid sync cursor.");
    const sequence = Number(since ?? "0");
    if (!Number.isSafeInteger(sequence) || sequence > this.sequence)
      throw new Cp2Error(
        409,
        "offline_cursor_invalid",
        "This cursor is ahead of the server. Your pending changes have been retained."
      );
    const available = [...this.changes.values()]
      .filter((change) => change.businessId === businessId && change.sequence > sequence)
      .sort((a, b) => a.sequence - b.sequence);
    const changes = available.slice(0, 100);
    return {
      changes,
      newCursor: available.length > 100 ? String(changes.at(-1)!.sequence) : this.cursor,
      hasMore: available.length > 100
    };
  }
}
function immutableOperation(operation: Operation): unknown {
  return {
    id: operation.id,
    opType: operation.opType,
    collection: operation.collection,
    entityLocalId: operation.entityLocalId,
    entityCloudId: operation.entityCloudId,
    base: operation.base,
    payload: operation.payload,
    createdAtLocal: operation.createdAtLocal
  };
}
