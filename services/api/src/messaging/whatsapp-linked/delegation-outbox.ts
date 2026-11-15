import type { RuntimeChannelDelegation, RuntimeToolName } from "@grogoni/shared-types";
import type {
  ChannelDelegationOutcome,
  ChannelDelegationResolution
} from "../../cp2/domains/agent-runtime/channel-delegation-result.js";

/**
 * Durable outbox for the reply a WhatsApp participant gets once the shop owner resolves a write
 * they asked for under a delegated tool grant (docs/architecture/whatsapp-linked-devices.md,
 * "Delegated-result outbox").
 *
 * The owner's approve or reject request only records an entry. The Node process that hosts the
 * WhatsApp connector drains entries for the businesses it currently serves, re-checks authority at
 * send time and settles each entry once: `sent`, `suppressed` (authority gone) or `failed`
 * (bounded retries exhausted, expired, or a send whose outcome is uncertain). Everything here is
 * pure: the store owns the map, persistence and the actual send.
 */
export type LinkedDelegationResultStatus = "pending" | "sent" | "suppressed" | "failed";

export interface LinkedDelegationResultEntry {
  /** Equal to the idempotency key: one entry per originating delegated turn. */
  id: string;
  idempotencyKey: string;
  businessId: string;
  turnId: string;
  delegation: RuntimeChannelDelegation;
  toolName: RuntimeToolName;
  outcome: ChannelDelegationOutcome;
  /** The owner or staff member who resolved the approval. */
  resolvedBy: string;
  status: LinkedDelegationResultStatus;
  /** Send attempts that reached the channel gateway. Deferrals (cap, not connected) don't count. */
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  /** Why the entry settled as suppressed or failed. */
  reason: string | null;
  /** Canonical outbound message id once sent. */
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

/** What one drain pass did; `deferred` entries stay pending for a later pass. */
export interface LinkedDelegationDrainReport {
  sent: number;
  suppressed: number;
  failed: number;
  deferred: number;
}

export const linkedDelegationOutboxLimits = {
  /** Gateway attempts before the entry settles as failed. */
  maxAttempts: 6,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  /** A reply this late would confuse more than it informs: settle it as failed instead. */
  expiresAfterMs: 24 * 60 * 60_000,
  /**
   * Extra wait before a host that does not serve the business settles an expired entry. The
   * serving host checks expiry right before every send; this margin keeps a sweep on another host
   * from racing a send that started just inside the deadline.
   */
  abandonGraceMs: 60 * 60_000,
  /** Settled entries are kept this long for audit and duplicate suppression, then pruned. */
  retainSettledMs: 7 * 24 * 60 * 60_000,
  /** Same budget as the connector's automatic-reply admission: 60 per business per hour. */
  admissionLimit: 60,
  admissionWindowMs: 60 * 60_000,
  /** Entries handled per drain pass, so one pass never monopolizes the event loop. */
  drainBatch: 50,
  /** Abandoned entries (any business) settled per drain pass. */
  sweepBatch: 200
} as const;

export function linkedDelegationResultKey(turnId: string): string {
  return `whatsapp-result:${turnId}`;
}

export function newLinkedDelegationResultEntry(
  resolution: ChannelDelegationResolution,
  now: Date
): LinkedDelegationResultEntry {
  const key = linkedDelegationResultKey(resolution.turnId);
  const at = now.toISOString();
  return {
    id: key,
    idempotencyKey: key,
    businessId: resolution.businessId,
    turnId: resolution.turnId,
    delegation: { ...resolution.delegation },
    toolName: resolution.toolName,
    outcome: resolution.outcome,
    resolvedBy: resolution.resolvedBy,
    status: "pending",
    attempts: 0,
    nextAttemptAt: at,
    lastErrorCode: null,
    reason: null,
    messageId: null,
    createdAt: at,
    updatedAt: at,
    settledAt: null
  };
}

export function linkedDelegationResultDue(entry: LinkedDelegationResultEntry, now: Date): boolean {
  return entry.status === "pending" && Date.parse(entry.nextAttemptAt) <= now.getTime();
}

export function linkedDelegationResultExpired(
  entry: LinkedDelegationResultEntry,
  now: Date
): boolean {
  return (
    entry.status === "pending" &&
    now.getTime() - Date.parse(entry.createdAt) >= linkedDelegationOutboxLimits.expiresAfterMs
  );
}

/**
 * Pending past its deadline plus `abandonGraceMs`: the business never reconnected (or no host serves
 * it), so any connector host may settle it as failed without serving the business. Without this,
 * such rows stayed pending forever and, being the oldest, filled the drain's bounded load window.
 */
export function linkedDelegationResultAbandoned(
  entry: LinkedDelegationResultEntry,
  now: Date
): boolean {
  return (
    entry.status === "pending" &&
    now.getTime() - Date.parse(entry.createdAt) >=
      linkedDelegationOutboxLimits.expiresAfterMs + linkedDelegationOutboxLimits.abandonGraceMs
  );
}

export function settleLinkedDelegationResult(
  entry: LinkedDelegationResultEntry,
  status: Exclude<LinkedDelegationResultStatus, "pending">,
  now: Date,
  details: { reason?: string | null; messageId?: string | null; errorCode?: string | null } = {}
): LinkedDelegationResultEntry {
  const at = now.toISOString();
  return {
    ...entry,
    status,
    reason: details.reason ?? null,
    messageId: details.messageId ?? entry.messageId,
    lastErrorCode: details.errorCode ?? entry.lastErrorCode,
    updatedAt: at,
    settledAt: at
  };
}

/** Keep the entry pending without spending an attempt (cap reached, channel momentarily busy). */
export function deferLinkedDelegationResult(
  entry: LinkedDelegationResultEntry,
  until: Date,
  now: Date
): LinkedDelegationResultEntry {
  return { ...entry, nextAttemptAt: until.toISOString(), updatedAt: now.toISOString() };
}

/** A gateway attempt failed before anything was sent: back off, or settle once out of attempts. */
export function retryLinkedDelegationResult(
  entry: LinkedDelegationResultEntry,
  now: Date,
  errorCode: string
): LinkedDelegationResultEntry {
  const attempts = entry.attempts + 1;
  if (attempts >= linkedDelegationOutboxLimits.maxAttempts)
    return settleLinkedDelegationResult({ ...entry, attempts }, "failed", now, {
      reason: "retries_exhausted",
      errorCode
    });
  const delay = Math.min(
    linkedDelegationOutboxLimits.maxBackoffMs,
    linkedDelegationOutboxLimits.baseBackoffMs * 2 ** (attempts - 1)
  );
  return {
    ...entry,
    attempts,
    lastErrorCode: errorCode,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    updatedAt: now.toISOString()
  };
}

export function prunableLinkedDelegationResult(
  entry: LinkedDelegationResultEntry,
  now: Date
): boolean {
  return (
    entry.status !== "pending" &&
    entry.settledAt !== null &&
    now.getTime() - Date.parse(entry.settledAt) >= linkedDelegationOutboxLimits.retainSettledMs
  );
}

/**
 * Reconcile an entry read back from the database with the in-memory copy. A settled entry never
 * returns to pending; between two pending copies the most recently updated wins.
 */
export function mergeLinkedDelegationResult(
  local: LinkedDelegationResultEntry | undefined,
  remote: LinkedDelegationResultEntry
): LinkedDelegationResultEntry {
  if (!local) return remote;
  if (local.status !== "pending") return local;
  if (remote.status !== "pending") return remote;
  return Date.parse(remote.updatedAt) > Date.parse(local.updatedAt) ? remote : local;
}

/** Shape check for rows read back from storage: a malformed row is ignored, never sent. */
export function isLinkedDelegationResultEntry(
  value: unknown
): value is LinkedDelegationResultEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const delegation = entry.delegation as Record<string, unknown> | undefined;
  return (
    typeof entry.id === "string" &&
    entry.id === entry.idempotencyKey &&
    entry.id === linkedDelegationResultKey(String(entry.turnId)) &&
    typeof entry.businessId === "string" &&
    ["pending", "sent", "suppressed", "failed"].includes(String(entry.status)) &&
    ["executed", "failed", "rejected"].includes(String(entry.outcome)) &&
    typeof entry.toolName === "string" &&
    typeof entry.resolvedBy === "string" &&
    typeof entry.attempts === "number" &&
    !Number.isNaN(Date.parse(String(entry.nextAttemptAt))) &&
    !Number.isNaN(Date.parse(String(entry.createdAt))) &&
    !Number.isNaN(Date.parse(String(entry.updatedAt))) &&
    !!delegation &&
    ["channelId", "grantId", "ownerId", "sourceMessageId", "actorId"].every(
      (field) => typeof delegation[field] === "string"
    )
  );
}

/**
 * Rolling-hour admission over every automatic send for one business: assistant replies and
 * delegated results share one budget. `ledger` maps each admitted idempotency key to the time it
 * was admitted. Re-admitting a key that is already in the window is free, so a retry of the same
 * reply never spends a second slot. A send leaves the window exactly one hour after it was
 * admitted; when the window is full, `retryAt` is that moment for its oldest send.
 */
export function linkedAutomatedAdmission(
  ledger: ReadonlyMap<string, number>,
  key: string,
  now: number
): { admitted: true } | { admitted: false; retryAt: number } {
  const cutoff = now - linkedDelegationOutboxLimits.admissionWindowMs;
  const existing = ledger.get(key);
  if (existing !== undefined && existing > cutoff) return { admitted: true };
  const live = [...ledger.values()].filter((time) => time > cutoff);
  if (live.length < linkedDelegationOutboxLimits.admissionLimit) return { admitted: true };
  return {
    admitted: false,
    retryAt: Math.min(...live) + linkedDelegationOutboxLimits.admissionWindowMs
  };
}
