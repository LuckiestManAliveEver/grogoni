import type { BusinessEvent } from "@grogoni/event-core";
import type {
  LocalSyncRecord,
  LocalSyncSnapshot,
  SyncChange,
  SyncConflict,
  SyncConflictCategory,
  SyncMutationPayload,
  SyncMutationType,
  SyncPullPage,
  SyncQueueItem,
  SyncQueueStatus,
  SyncQueueSummary
} from "@grogoni/shared-types";

/**
 * Known business-error codes mapped to the conflict category they represent.
 * Any code not listed here (including transport/infra failures) falls back
 * to "generic" — still non-retryable and still blocked from auto-resolution,
 * just without a more specific field/record classification.
 */
const conflictCategoryByCode: Record<string, SyncConflictCategory> = {
  stock_insufficient: "product_quantity",
  payment_exceeds_balance: "money",
  invoice_not_confirmed: "money",
  duplicate_product_detected: "duplicate",
  duplicate_customer_detected: "duplicate",
  duplicate_payment_detected: "duplicate"
};

export const syncQueueStatuses: SyncQueueStatus[] = [
  "pending",
  "processing",
  "synced",
  "failed",
  "conflict"
];

export const syncMutationTypes: SyncMutationType[] = [
  "product.create",
  "customer.create",
  "supplier.create",
  "inventory.adjust",
  "invoice.create",
  "invoice.confirm",
  "payment.record",
  "logistics.create",
  "logistics.update_status"
];

export type LegacySyncQueueStatus = "queued" | "syncing" | "synced" | "failed";

export interface LegacySyncQueueItem {
  event: BusinessEvent;
  status: LegacySyncQueueStatus;
  attempts: number;
  nextAttemptAt: string | null;
}

export interface CreateSyncQueueItemInput {
  id: string;
  idempotencyKey: string;
  businessId: string;
  actorId: string;
  mutationType: SyncMutationType;
  payload: SyncMutationPayload;
  clientCreatedAt: string;
  now: string;
}

export interface ReplayFailureInput {
  code: string;
  message: string;
  statusCode: number;
  now: string;
}

export type SyncPageErrorCode =
  | "account_mismatch"
  | "cursor_gap"
  | "invalid_change_order"
  | "invalid_change_payload"
  | "invalid_page_cursor";

export class SyncPageError extends Error {
  readonly code: SyncPageErrorCode;

  constructor(code: SyncPageErrorCode, message: string) {
    super(message);
    this.name = "SyncPageError";
    this.code = code;
  }
}

export function enqueueEvent(event: BusinessEvent): LegacySyncQueueItem {
  return {
    event,
    status: "queued",
    attempts: 0,
    nextAttemptAt: null
  };
}

export function isSyncMutationType(value: string): value is SyncMutationType {
  return syncMutationTypes.includes(value as SyncMutationType);
}

export function createSyncQueueItem(input: CreateSyncQueueItemInput): SyncQueueItem {
  return {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    businessId: input.businessId,
    actorId: input.actorId,
    mutationType: input.mutationType,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    clientCreatedAt: input.clientCreatedAt,
    createdAt: input.now,
    updatedAt: input.now,
    nextAttemptAt: null,
    result: null,
    conflict: null
  };
}

export function markSyncProcessing(item: SyncQueueItem, now: string): SyncQueueItem {
  return {
    ...item,
    status: "processing",
    attempts: item.attempts + 1,
    updatedAt: now,
    nextAttemptAt: null,
    conflict: null
  };
}

export function markSyncSynced(item: SyncQueueItem, result: unknown, now: string): SyncQueueItem {
  return {
    ...item,
    status: "synced",
    updatedAt: now,
    nextAttemptAt: null,
    result,
    conflict: null
  };
}

export function markSyncRejected(item: SyncQueueItem, failure: ReplayFailureInput): SyncQueueItem {
  const conflict = classifySyncConflict(failure);

  return {
    ...item,
    status: conflict.retryable ? "failed" : "conflict",
    updatedAt: failure.now,
    nextAttemptAt: conflict.retryable ? nextRetryAt(failure.now, item.attempts) : null,
    conflict,
    result: null
  };
}

export function summarizeSyncQueue(
  businessId: string,
  items: readonly SyncQueueItem[]
): SyncQueueSummary {
  const summary: SyncQueueSummary = {
    businessId,
    pending: 0,
    processing: 0,
    synced: 0,
    failed: 0,
    conflict: 0,
    total: 0
  };

  for (const item of items) {
    if (item.businessId !== businessId) {
      continue;
    }

    summary[item.status] += 1;
    summary.total += 1;
  }

  return summary;
}

export function classifySyncConflict(input: Omit<ReplayFailureInput, "now">): SyncConflict {
  const retryable = input.statusCode >= 500 || input.statusCode === 429;

  return {
    code: input.code,
    message: input.message,
    statusCode: input.statusCode,
    retryable,
    category: conflictCategoryByCode[input.code] ?? "generic"
  };
}

export function applySyncPullPage<T>(
  snapshot: LocalSyncSnapshot<T>,
  page: SyncPullPage<T>
): LocalSyncSnapshot<T> {
  if (snapshot.accountId !== page.accountId) {
    throw new SyncPageError(
      "account_mismatch",
      "A sync page cannot be applied to another account's local snapshot."
    );
  }

  if (snapshot.cursor === page.nextCursor) {
    return snapshot;
  }

  if (snapshot.cursor !== page.fromCursor) {
    throw new SyncPageError("cursor_gap", "The sync page does not continue the local cursor.");
  }

  validateSyncPullPage(page);

  const records = new Map(
    snapshot.records.map((record) => [syncRecordKey(record), record] as const)
  );

  for (const change of page.changes) {
    const record: LocalSyncRecord<T> = {
      accountId: change.accountId,
      collection: change.collection,
      entityId: change.entityId,
      sequence: change.sequence,
      cursor: change.cursor,
      shopId: change.shopId,
      entity: change.entity,
      changedAt: change.changedAt,
      deletedAt: change.operation === "delete" ? change.changedAt : null,
      tombstoneExpiresAt: change.tombstoneExpiresAt
    };

    records.set(syncRecordKey(record), record);
  }

  return {
    accountId: snapshot.accountId,
    cursor: page.nextCursor,
    records: [...records.values()].sort((left, right) =>
      syncRecordKey(left).localeCompare(syncRecordKey(right))
    )
  };
}

export function validateSyncPullPage<T>(page: SyncPullPage<T>): void {
  if (page.nextCursor.length === 0) {
    throw new SyncPageError("invalid_page_cursor", "A sync page requires a next cursor.");
  }

  let previousSequence = -1;

  for (const change of page.changes) {
    validateSyncChange(page.accountId, change, previousSequence);
    previousSequence = change.sequence;
  }

  const finalChange = page.changes.at(-1);
  if (finalChange !== undefined && finalChange.cursor !== page.nextCursor) {
    throw new SyncPageError(
      "invalid_page_cursor",
      "The page cursor must match the final ordered change."
    );
  }
}

function validateSyncChange<T>(
  accountId: string,
  change: SyncChange<T>,
  previousSequence: number
): void {
  if (change.accountId !== accountId) {
    throw new SyncPageError("account_mismatch", "A page cannot contain another account's data.");
  }

  if (!Number.isSafeInteger(change.sequence) || change.sequence < 0) {
    throw new SyncPageError("invalid_change_order", "Sync sequences must be safe integers.");
  }

  if (change.sequence <= previousSequence) {
    throw new SyncPageError(
      "invalid_change_order",
      "Changes in a sync page must be strictly ordered."
    );
  }

  if (change.cursor.length === 0 || change.entityId.length === 0) {
    throw new SyncPageError(
      "invalid_change_payload",
      "Every sync change requires a cursor and entity identifier."
    );
  }

  if (
    (change.operation === "upsert" && change.entity === null) ||
    (change.operation === "delete" && change.entity !== null) ||
    (change.operation === "upsert" && change.tombstoneExpiresAt !== null) ||
    (change.operation === "delete" && change.tombstoneExpiresAt === null)
  ) {
    throw new SyncPageError(
      "invalid_change_payload",
      "Upserts require an entity; deletes require a null entity and tombstone expiry."
    );
  }
}

function syncRecordKey(record: Pick<LocalSyncRecord, "collection" | "entityId">): string {
  return `${record.collection}:${record.entityId}`;
}

function nextRetryAt(now: string, attempts: number): string {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.parse(now) + delayMs).toISOString();
}
