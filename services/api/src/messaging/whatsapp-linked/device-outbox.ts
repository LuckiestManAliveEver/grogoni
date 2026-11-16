import type { LinkedReadReceiptKey } from "./read-receipts.js";

/**
 * Durable outbox for a WhatsApp session hosted on the owner's Android phone
 * (docs/architecture/whatsapp-linked-devices.md, "Device outbox").
 *
 * Production runs on Supabase Edge, which cannot hold a WhatsApp socket. When the owner's phone
 * hosts the session, the `whatsapp_linked` gateway send path queues the message here instead of
 * failing; the phone pulls it with the owner's own session (device-worker-routes.ts), sends it
 * through its sidecar, and acknowledges `sent`, `failed` or `uncertain`. Read receipts for
 * phone-hosted chats queue here too, so they survive the per-request Edge store.
 *
 * Everything here is pure: the store owns the map, persistence, authority checks and the
 * canonical message update.
 */
export type LinkedDeviceOutboxKind = "send" | "read";

export type LinkedDeviceOutboxStatus =
  /** Waiting for the phone. */
  | "pending"
  /** Handed to one device; waiting for its acknowledgement. */
  | "claimed"
  | "sent"
  | "failed"
  /** The phone may have handed it to WhatsApp. Never offered again. */
  | "uncertain"
  /** Authority was gone at pull time (STOP, approval removed, owner changed). Nothing sent. */
  | "suppressed";

export interface LinkedDeviceOutboxEntry {
  /** `send:<canonical message id>` or `read:<canonical message id>`. */
  id: string;
  kind: LinkedDeviceOutboxKind;
  businessId: string;
  /** The owner whose phone session sends it. Re-checked at pull time. */
  ownerId: string;
  channelId: string;
  conversationId: string;
  chat: string;
  /** Canonical message id: the outbound message (send) or the inbound message read (read). */
  messageId: string;
  /** send: the gateway idempotency key the phone's connector journal deduplicates on. */
  idempotencyKey: string | null;
  /** read: WhatsApp message id and sender of the message read. */
  providerMessageId: string | null;
  sender: string | null;
  status: LinkedDeviceOutboxStatus;
  /** Claims handed to a device (send), and retryable failures reported back. */
  claims: number;
  attempts: number;
  /** The device (session deviceId) holding the current claim. */
  claimedBy: string | null;
  claimedAt: string | null;
  /** Opaque per-claim id the acknowledgement must echo. */
  claimId: string | null;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  /** Why the entry settled as failed, uncertain or suppressed. */
  reason: string | null;
  /** WhatsApp message id once sent. */
  deliveredId: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  expiresAt: string;
}

export const linkedDeviceOutboxLimits = {
  /** Unsettled sends per business. A full outbox refuses new sends; it never evicts one. */
  maxPendingSends: 200,
  /** Queued read receipts per business; the oldest are dropped beyond this. */
  maxPendingReads: 500,
  /** A send the phone never picked up within this window fails instead of arriving a day late. */
  sendExpiresAfterMs: 24 * 60 * 60_000,
  /** Same window as server-hosted receipts (read-receipts.ts maxQueuedAgeMs). */
  readExpiresAfterMs: 60 * 60_000,
  /** A claim without an acknowledgement for this long may be re-offered to the same device. */
  claimTimeoutMs: 2 * 60_000,
  /** Claims before an unacknowledged send settles as uncertain. */
  maxClaims: 3,
  /** Retryable failures (phone not connected yet) before the send settles as failed. */
  maxAttempts: 6,
  baseBackoffMs: 15_000,
  maxBackoffMs: 10 * 60_000,
  /** Per pull: sends handed to the phone, and read entries taken. */
  pullSends: 20,
  pullReads: 200,
  /** Settled sends are kept this long for duplicate suppression and audit, then pruned. */
  retainSettledMs: 7 * 24 * 60 * 60_000,
  maxIdempotencyKeyLength: 200
} as const;

export function linkedDeviceSendId(messageId: string): string {
  return `send:${messageId}`;
}

export function linkedDeviceReadId(messageId: string): string {
  return `read:${messageId}`;
}

interface NewEntryBase {
  businessId: string;
  ownerId: string;
  channelId: string;
  conversationId: string;
  chat: string;
  messageId: string;
}

function baseEntry(
  kind: LinkedDeviceOutboxKind,
  input: NewEntryBase,
  now: Date
): LinkedDeviceOutboxEntry {
  const at = now.toISOString();
  const ttl =
    kind === "send"
      ? linkedDeviceOutboxLimits.sendExpiresAfterMs
      : linkedDeviceOutboxLimits.readExpiresAfterMs;
  return {
    id: kind === "send" ? linkedDeviceSendId(input.messageId) : linkedDeviceReadId(input.messageId),
    kind,
    businessId: input.businessId,
    ownerId: input.ownerId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    chat: input.chat,
    messageId: input.messageId,
    idempotencyKey: null,
    providerMessageId: null,
    sender: null,
    status: "pending",
    claims: 0,
    attempts: 0,
    claimedBy: null,
    claimedAt: null,
    claimId: null,
    nextAttemptAt: at,
    lastErrorCode: null,
    reason: null,
    deliveredId: null,
    createdAt: at,
    updatedAt: at,
    settledAt: null,
    expiresAt: new Date(now.getTime() + ttl).toISOString()
  };
}

export function newLinkedDeviceSend(
  input: NewEntryBase & { idempotencyKey: string },
  now: Date
): LinkedDeviceOutboxEntry {
  return { ...baseEntry("send", input, now), idempotencyKey: input.idempotencyKey };
}

export function newLinkedDeviceRead(
  input: NewEntryBase & { providerMessageId: string; sender: string },
  now: Date
): LinkedDeviceOutboxEntry {
  return {
    ...baseEntry("read", input, now),
    providerMessageId: input.providerMessageId,
    sender: input.sender
  };
}

export function linkedDeviceEntrySettled(entry: LinkedDeviceOutboxEntry): boolean {
  return entry.status !== "pending" && entry.status !== "claimed";
}

export function settleLinkedDeviceEntry(
  entry: LinkedDeviceOutboxEntry,
  status: Exclude<LinkedDeviceOutboxStatus, "pending" | "claimed">,
  now: Date,
  details: { reason?: string | null; errorCode?: string | null; deliveredId?: string | null } = {}
): LinkedDeviceOutboxEntry {
  const at = now.toISOString();
  return {
    ...entry,
    status,
    reason: details.reason ?? null,
    lastErrorCode: details.errorCode ?? entry.lastErrorCode,
    deliveredId: details.deliveredId ?? entry.deliveredId,
    claimId: null,
    updatedAt: at,
    settledAt: at
  };
}

export type LinkedDeviceClaimDecision =
  /** Hand it to this device under a fresh claim. */
  | { action: "offer"; entry: LinkedDeviceOutboxEntry }
  /** Leave it: claimed by a device that may still acknowledge, or backing off. */
  | { action: "wait" }
  /** Settle it now; never offered again. */
  | {
      action: "settle";
      status: "failed" | "uncertain";
      reason: string;
    };

/**
 * Whether a send may be handed to `deviceId` now. The rule that keeps an uncertain delivery from
 * being resent blindly:
 *
 * - A pending send is offered under a fresh claim.
 * - A claimed send whose claim has not timed out waits for its acknowledgement.
 * - A timed-out claim is offered again only to the **same** device, with the same idempotency
 *   key. That device's encrypted connector journal records the key before handing anything to
 *   WhatsApp, so a re-offer of something it already sent returns the stored result, and one it
 *   handed over without an answer comes back `uncertain`. Another device has no such journal:
 *   for it the send settles `uncertain` instead of going out a second time.
 * - After `maxClaims` claims it settles `uncertain` as well.
 */
export function claimLinkedDeviceSend(
  entry: LinkedDeviceOutboxEntry,
  deviceId: string,
  claimId: string,
  now: Date
): LinkedDeviceClaimDecision {
  if (entry.kind !== "send" || linkedDeviceEntrySettled(entry)) return { action: "wait" };
  const time = now.getTime();
  if (entry.status === "pending") {
    if (Date.parse(entry.expiresAt) <= time)
      return { action: "settle", status: "failed", reason: "expired" };
    if (Date.parse(entry.nextAttemptAt) > time) return { action: "wait" };
  } else {
    if (
      time - Date.parse(entry.claimedAt ?? entry.updatedAt) <
      linkedDeviceOutboxLimits.claimTimeoutMs
    )
      return { action: "wait" };
    if (entry.claimedBy !== deviceId)
      return { action: "settle", status: "uncertain", reason: "claim_lost_other_device" };
    if (entry.claims >= linkedDeviceOutboxLimits.maxClaims)
      return { action: "settle", status: "uncertain", reason: "claim_unacknowledged" };
  }
  const at = now.toISOString();
  return {
    action: "offer",
    entry: {
      ...entry,
      status: "claimed",
      claims: entry.claims + 1,
      claimedBy: deviceId,
      claimedAt: at,
      claimId,
      updatedAt: at
    }
  };
}

/** A failure the phone reported before anything reached WhatsApp: back off or give up. */
export function retryLinkedDeviceSend(
  entry: LinkedDeviceOutboxEntry,
  now: Date,
  errorCode: string
): LinkedDeviceOutboxEntry {
  const attempts = entry.attempts + 1;
  if (attempts >= linkedDeviceOutboxLimits.maxAttempts)
    return settleLinkedDeviceEntry({ ...entry, attempts }, "failed", now, {
      reason: "retries_exhausted",
      errorCode
    });
  const delay = Math.min(
    linkedDeviceOutboxLimits.maxBackoffMs,
    linkedDeviceOutboxLimits.baseBackoffMs * 2 ** (attempts - 1)
  );
  return {
    ...entry,
    status: "pending",
    attempts,
    // A failure before handoff is a clean slate for the claim rule: nothing went out.
    claims: 0,
    claimedBy: null,
    claimedAt: null,
    claimId: null,
    lastErrorCode: errorCode,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    updatedAt: now.toISOString()
  };
}

export function prunableLinkedDeviceEntry(entry: LinkedDeviceOutboxEntry, now: Date): boolean {
  return (
    linkedDeviceEntrySettled(entry) &&
    entry.settledAt !== null &&
    now.getTime() - Date.parse(entry.settledAt) >= linkedDeviceOutboxLimits.retainSettledMs
  );
}

/** One acknowledgement from the phone, validated. */
export interface LinkedDeviceAck {
  id: string;
  claimId: string;
  outcome: "sent" | "failed" | "uncertain";
  deliveredId?: string;
  code?: string;
  retryable?: boolean;
}

const entryIdPattern = /^send:[A-Za-z0-9_.:-]{1,160}$/;
const claimIdPattern = /^[A-Za-z0-9-]{8,64}$/;
const providerIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const codePattern = /^[A-Za-z_]{2,64}$/;

/** Strict parse of `{results: [...]}`; null for anything malformed. At most `pullSends` items. */
export function parseLinkedDeviceAcks(value: unknown): LinkedDeviceAck[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > linkedDeviceOutboxLimits.pullSends
  )
    return null;
  const acks: LinkedDeviceAck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { id, claimId, outcome, deliveredId, code, retryable } = item as Record<string, unknown>;
    if (typeof id !== "string" || !entryIdPattern.test(id)) return null;
    if (typeof claimId !== "string" || !claimIdPattern.test(claimId)) return null;
    if (outcome !== "sent" && outcome !== "failed" && outcome !== "uncertain") return null;
    if (
      deliveredId !== undefined &&
      (typeof deliveredId !== "string" || !providerIdPattern.test(deliveredId))
    )
      return null;
    if (code !== undefined && (typeof code !== "string" || !codePattern.test(code))) return null;
    if (retryable !== undefined && typeof retryable !== "boolean") return null;
    if (outcome === "sent" && deliveredId === undefined) return null;
    acks.push({
      id,
      claimId,
      outcome,
      ...(deliveredId === undefined ? {} : { deliveredId: deliveredId as string }),
      ...(code === undefined ? {} : { code: code as string }),
      ...(retryable === undefined ? {} : { retryable: retryable as boolean })
    });
  }
  return acks;
}

/** What one pull hands to the phone. */
export interface LinkedDeviceSendCommand {
  id: string;
  claimId: string;
  chat: string;
  conversationId: string;
  idempotencyKey: string;
  text: string;
  quotedMessage?: { id: string; sender: string | null; fromMe: boolean; text: string };
}

export interface LinkedDeviceReceiptBatch {
  chat: string;
  keys: LinkedReadReceiptKey[];
}

/**
 * Reconcile an entry read back from storage with the in-memory copy. A settled entry never
 * returns to pending; between two unsettled copies the most recently updated wins.
 */
export function mergeLinkedDeviceEntry(
  local: LinkedDeviceOutboxEntry | undefined,
  remote: LinkedDeviceOutboxEntry
): LinkedDeviceOutboxEntry {
  if (!local) return remote;
  if (linkedDeviceEntrySettled(local)) return local;
  if (linkedDeviceEntrySettled(remote)) return remote;
  return Date.parse(remote.updatedAt) > Date.parse(local.updatedAt) ? remote : local;
}

const statuses = new Set<string>([
  "pending",
  "claimed",
  "sent",
  "failed",
  "uncertain",
  "suppressed"
]);

/** Shape check for rows read back from storage: a malformed row is ignored, never sent. */
export function isLinkedDeviceOutboxEntry(value: unknown): value is LinkedDeviceOutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string" && field.length > 0;
  const date = (field: unknown) => typeof field === "string" && !Number.isNaN(Date.parse(field));
  if (
    !(entry.kind === "send" || entry.kind === "read") ||
    !text(entry.messageId) ||
    entry.id !== `${entry.kind}:${String(entry.messageId)}` ||
    !["businessId", "ownerId", "channelId", "conversationId", "chat"].every((field) =>
      text(entry[field])
    ) ||
    !statuses.has(String(entry.status)) ||
    !Number.isSafeInteger(entry.claims) ||
    !Number.isSafeInteger(entry.attempts) ||
    !["nextAttemptAt", "createdAt", "updatedAt", "expiresAt"].every((field) => date(entry[field]))
  )
    return false;
  if (entry.kind === "send")
    return (
      text(entry.idempotencyKey) &&
      String(entry.idempotencyKey).length <= linkedDeviceOutboxLimits.maxIdempotencyKeyLength
    );
  return text(entry.providerMessageId) && text(entry.sender);
}
