/**
 * Shop owner change for WhatsApp Linked Devices (docs/architecture/whatsapp-linked-devices.md,
 * "Shop owner change").
 *
 * A linked WhatsApp account belongs to the owner who paired it, never to the shop. When the shop
 * gets a different owner, the connector erases the vault and logs the old session out
 * (connector.ts `load`/`authorizeActive`). The store then removes everything that still carried
 * the former owner's authority (cp2/store.ts `reconcileLinkedWhatsAppOwnership`) and keeps one
 * record per business so the new owner is told why WhatsApp is disconnected.
 *
 * Everything here is pure: the store owns the map, persistence and the cleanup itself.
 */

/** What the cleanup removed when it noticed the change. Counts only: no ids, no content. */
export interface LinkedOwnerChange {
  /** The owner whose WhatsApp session and approvals were removed. */
  previousOwnerId: string;
  detectedAt: string;
  /** Approved chats unbound from the former owner (conversation history stays with them). */
  channelsDetached: number;
  /** Delegated business-tool grants that were active and are now gone. */
  grantsRevoked: number;
  /** Delegated-result replies that will never be sent. */
  resultsSuppressed: number;
  /** Queued WhatsApp read receipts dropped. */
  readReceiptsDropped: number;
}

/** One row per business in `cp2_whatsapp_linked_owner_states` (migration 140). */
export interface LinkedOwnerStateRecord {
  /** Equal to businessId. */
  id: string;
  businessId: string;
  /** The owner whose connector last reported a state, or null once that owner was removed. */
  ownerId: string | null;
  /** Last connector state reported for that owner (connector.ts LinkedState). */
  state: string | null;
  /** Set when an owner change removed the WhatsApp link; cleared once the new owner links again. */
  ownerChange: LinkedOwnerChange | null;
  /** When the current owner dismissed the owner-change notice. */
  acknowledgedAt: string | null;
  /**
   * Where the session last reported from: the owner's Android phone (device-worker-routes.ts) or
   * a server connector. Absent on records written before the device outbox (= server).
   */
  host?: "server" | "android";
  /** Last time the phone checked in (state report or outbox pull), throttled. */
  deviceSeenAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The text the new owner sees. Fixed: it names no person and no account. */
export const linkedOwnerChangeNotice =
  "WhatsApp was disconnected because the shop changed owner. Link WhatsApp again to keep receiving messages.";

export function newLinkedOwnerStateRecord(businessId: string, now: Date): LinkedOwnerStateRecord {
  const at = now.toISOString();
  return {
    id: businessId,
    businessId,
    ownerId: null,
    state: null,
    ownerChange: null,
    acknowledgedAt: null,
    createdAt: at,
    updatedAt: at
  };
}

/** Merges a second detection into an unacknowledged one, so no count is lost. */
export function mergeLinkedOwnerChange(
  existing: LinkedOwnerChange | null,
  next: LinkedOwnerChange
): LinkedOwnerChange {
  if (!existing) return next;
  return {
    previousOwnerId: existing.previousOwnerId,
    detectedAt: existing.detectedAt,
    channelsDetached: existing.channelsDetached + next.channelsDetached,
    grantsRevoked: existing.grantsRevoked + next.grantsRevoked,
    resultsSuppressed: existing.resultsSuppressed + next.resultsSuppressed,
    readReceiptsDropped: existing.readReceiptsDropped + next.readReceiptsDropped
  };
}

/** Shape check for rows read back from storage: a malformed row is ignored. */
export function isLinkedOwnerStateRecord(value: unknown): value is LinkedOwnerStateRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const change = record.ownerChange as Record<string, unknown> | null | undefined;
  const nullableText = (field: unknown) => field === null || typeof field === "string";
  return (
    typeof record.id === "string" &&
    record.id === record.businessId &&
    nullableText(record.ownerId) &&
    nullableText(record.state) &&
    nullableText(record.acknowledgedAt) &&
    (record.host === undefined || record.host === "server" || record.host === "android") &&
    (record.deviceSeenAt === undefined || nullableText(record.deviceSeenAt)) &&
    !Number.isNaN(Date.parse(String(record.createdAt))) &&
    !Number.isNaN(Date.parse(String(record.updatedAt))) &&
    (change === null ||
      (!!change &&
        typeof change === "object" &&
        typeof change.previousOwnerId === "string" &&
        !Number.isNaN(Date.parse(String(change.detectedAt))) &&
        ["channelsDetached", "grantsRevoked", "resultsSuppressed", "readReceiptsDropped"].every(
          (field) => Number.isSafeInteger(change[field]) && Number(change[field]) >= 0
        )))
  );
}
