import { clearDeviceOnlyMessages } from "../chat-device-only-messages";

const messagingOutboxStoragePrefix = "grogoni.messaging-outbox.v2";
const legacyMessagingOutboxStorageKey = "grogoni.messaging-outbox.v1";
/** Dispatched on window after every outbox write, so the UI can show what is still waiting. */
export const messagingOutboxChangeEvent = "grogoni:messaging-outbox-change";

export interface MessagingOutboxEntry {
  accountId: string;
  clientMessageId: string;
  payload: Record<string, unknown>;
  /** Automatic resends tried so far (manual taps are not limited). */
  attempts?: number;
  /** Epoch ms before which no automatic resend runs. */
  nextAttemptAt?: number;
}

/**
 * Automatic resends per message, and the wait before each: 15 s, 1 min, 4 min. A message to an
 * agent reruns a model turn on every resend, so they stop after this; the resend control in the
 * thread header still sends on a tap. Stored with the entry, so every open tab honors it.
 */
export const outboxAutomaticAttempts = 3;
export function outboxBackoffMs(attempts: number): number {
  return 15_000 * 4 ** attempts;
}

/** Whether an automatic resend may run for this entry now. */
export function outboxEntryDue(entry: MessagingOutboxEntry, now = Date.now()): boolean {
  return (entry.attempts ?? 0) < outboxAutomaticAttempts && (entry.nextAttemptAt ?? 0) <= now;
}

/** Records a failed resend: one more attempt, and the wait before the next. */
export function recordMessagingOutboxAttempt(
  accountId: string,
  clientMessageId: string,
  now = Date.now(),
  storage: MessagingOutboxStorage = localStorage
): MessagingOutboxEntry | null {
  const entry = readMessagingOutbox(accountId, storage).find(
    (candidate) => candidate.clientMessageId === clientMessageId
  );
  if (entry === undefined) return null;
  const attempts = (entry.attempts ?? 0) + 1;
  const updated = { ...entry, attempts, nextAttemptAt: now + outboxBackoffMs(attempts) };
  mutateOutbox(accountId, storage, {
    kind: "attempt",
    clientMessageId,
    attempts,
    nextAttemptAt: updated.nextAttemptAt
  });
  return updated;
}

export interface MessagingOutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readMessagingOutbox(
  accountId: string,
  storage: MessagingOutboxStorage = localStorage
): MessagingOutboxEntry[] {
  discardUnsafeLegacyOutbox(storage);
  return applyOutboxOperations(
    readStoredOutbox(accountId, storage),
    pendingOutbox(storage, accountId)?.operations ?? []
  );
}

let countMemo: { key: string; raw: string | null; count: number } | null = null;

/**
 * How many messages wait in this account's outbox (in one conversation, when given), for
 * rendering: never writes (unlike
 * readMessagingOutbox, which discards the legacy key), never throws (blocked storage reads as 0),
 * and parses only when the stored value changed. Counts this tab's writes that are still waiting
 * for the outbox lock too.
 */
export function countMessagingOutbox(
  accountId: string,
  conversationId?: string | null,
  storage: Pick<MessagingOutboxStorage, "getItem"> = localStorage
): number {
  try {
    const operations = pendingOutbox(storage, accountId)?.operations ?? [];
    const key = `${storageKey(accountId)}#${conversationId === undefined ? "*" : conversationId}`;
    const raw = storage.getItem(storageKey(accountId));
    if (
      operations.length === 0 &&
      countMemo !== null &&
      countMemo.key === key &&
      countMemo.raw === raw
    )
      return countMemo.count;
    const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);
    const stored = Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is MessagingOutboxEntry =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { accountId?: unknown }).accountId === accountId
        )
      : [];
    const count = applyOutboxOperations(stored, operations).filter(
      (entry) =>
        conversationId === undefined ||
        (entry.payload as { conversationId?: unknown } | undefined)?.conversationId ===
          conversationId
    ).length;
    if (operations.length === 0) countMemo = { key, raw, count };
    return count;
  } catch {
    return 0;
  }
}

export function queueMessagingOutbox(
  entry: MessagingOutboxEntry,
  storage: MessagingOutboxStorage = localStorage
): void {
  mutateOutbox(entry.accountId, storage, { kind: "put", entry });
}

export function removeMessagingOutboxEntry(
  accountId: string,
  clientMessageId: string,
  storage: MessagingOutboxStorage = localStorage
): void {
  mutateOutbox(accountId, storage, { kind: "remove", clientMessageId });
}

export function clearMessagingOutbox(
  accountId: string,
  storage: MessagingOutboxStorage = localStorage
): void {
  // The thread copies of queued messages go with the queue.
  clearDeviceOnlyMessages(accountId, storage);
  mutateOutbox(accountId, storage, { kind: "clear" });
}

/**
 * Cross-tab writes. Every tab of an account reads, changes and writes back the same stored list,
 * so two tabs writing at once used to drop one tab's change (a queued message vanished). Each
 * change is now recorded as an operation and applied to the freshest stored list under the Web
 * Lock `grogoni-outbox-write:<account>`, one tab at a time. The callers stay synchronous: this
 * tab's own reads (readMessagingOutbox, countMessagingOutbox) include its operations that still
 * wait for the lock, and the change event fires at once. The lock callback is synchronous and
 * requests nothing else, so it cannot deadlock and is released even when the write throws; it is
 * a different lock from the resend pass (`grogoni-outbox-resend:<account>`), which holds its lock
 * across network calls and itself writes here. Other tabs learn of a write from the "storage"
 * event.
 *
 * A write that fails (storage full or blocked) stays in this tab, which keeps reading it, and is
 * tried again on its own after 1 s, 2 s, 4 s and so on up to 30 s, and by every later change. Each
 * failure fires `messagingOutboxSaveFailedEvent`, which the chat shows
 * (messaging/useMessagingOutboxSaveFailure.ts), since the caller no longer gets the error thrown at it.
 *
 * Without navigator.locks (every current browser has it) there is no cross-tab lock: each change
 * is one synchronous read-modify-write, as before, and a storage error is thrown to the caller.
 * Two such tabs writing at the same moment can still lose a change;
 * tests/messaging-outbox-cross-tab.test.ts measures how often.
 */
export const messagingOutboxSaveFailedEvent = "grogoni:messaging-outbox-save-failed";
export const messagingOutboxSaveFailureMessage =
  "A waiting message could not be saved on this device. Grogoni keeps it open here and keeps trying; free some storage if this continues.";
export interface MessagingOutboxSaveFailure {
  accountId: string;
  message: string;
}
const outboxRetryMaxMs = 30_000;

type OutboxOperation =
  | { kind: "put"; entry: MessagingOutboxEntry }
  | { kind: "remove"; clientMessageId: string }
  | { kind: "attempt"; clientMessageId: string; attempts: number; nextAttemptAt: number }
  | { kind: "clear" };

interface PendingOutbox {
  accountId: string;
  storage: MessagingOutboxStorage;
  operations: OutboxOperation[];
  /** A lock request is out and has not run yet; it writes every operation queued until it runs. */
  waiting: boolean;
  /** Settles when the latest lock request has run (or failed). */
  flush: Promise<void>;
  /** Failed writes in a row, for the retry delay. */
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
}

interface OutboxLockManager {
  request(name: string, callback: () => void): Promise<unknown>;
}

const pendingByStorage = new WeakMap<object, Map<string, PendingOutbox>>();
const pendingWrites = new Set<PendingOutbox>();

export function messagingOutboxLockName(accountId: string): string {
  return `grogoni-outbox-write:${accountId}`;
}

/** Resolves once every outbox write this tab has made is stored (tests, and before unload). */
export async function settleMessagingOutbox(): Promise<void> {
  while ([...pendingWrites].some((pending) => pending.waiting))
    await Promise.all([...pendingWrites].map((pending) => pending.flush));
}

function outboxLocks(): OutboxLockManager | null {
  const locks = (globalThis as { navigator?: { locks?: OutboxLockManager } }).navigator?.locks;
  return typeof locks?.request === "function" ? locks : null;
}

function pendingOutbox(storage: object, accountId: string): PendingOutbox | undefined {
  return pendingByStorage.get(storage)?.get(accountId);
}

function mutateOutbox(
  accountId: string,
  storage: MessagingOutboxStorage,
  operation: OutboxOperation
): void {
  // Every write drops the unsafe pre-account outbox, as reading it does.
  discardUnsafeLegacyOutbox(storage);
  const locks = outboxLocks();
  if (locks === null) {
    writeOutbox(accountId, storage, [operation]);
    announceOutboxChange();
    return;
  }
  let byAccount = pendingByStorage.get(storage);
  if (byAccount === undefined) pendingByStorage.set(storage, (byAccount = new Map()));
  let pending = byAccount.get(accountId);
  if (pending === undefined) {
    pending = {
      accountId,
      storage,
      operations: [],
      waiting: false,
      flush: Promise.resolve(),
      failures: 0,
      retry: null
    };
    byAccount.set(accountId, pending);
    pendingWrites.add(pending);
  }
  pending.operations.push(operation);
  announceOutboxChange();
  scheduleOutboxFlush(pending, locks);
}

function scheduleOutboxFlush(pending: PendingOutbox, locks: OutboxLockManager): void {
  if (pending.waiting) return;
  pending.waiting = true;
  pending.flush = locks
    .request(messagingOutboxLockName(pending.accountId), () => {
      // Cleared first: a change made after this point needs (and gets) its own lock request.
      pending.waiting = false;
      flushPendingOutbox(pending);
    })
    .then(
      () => {
        pending.failures = 0;
      },
      (error: unknown) => {
        pending.waiting = false;
        pending.failures += 1;
        // Kept in this tab's operations (it still reads them) and tried again below.
        console.warn("Could not save the messaging outbox.", error);
        announceOutboxSaveFailure(pending.accountId, error);
        retryOutboxFlush(pending, locks);
      }
    );
}

function retryOutboxFlush(pending: PendingOutbox, locks: OutboxLockManager): void {
  if (pending.retry !== null || typeof setTimeout !== "function") return;
  const delay = Math.min(outboxRetryMaxMs, 1_000 * 2 ** (pending.failures - 1));
  pending.retry = setTimeout(() => {
    pending.retry = null;
    if (pending.operations.length > 0) scheduleOutboxFlush(pending, locks);
  }, delay);
}

function announceOutboxSaveFailure(accountId: string, error: unknown): void {
  if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
  window.dispatchEvent(
    new CustomEvent<MessagingOutboxSaveFailure>(messagingOutboxSaveFailedEvent, {
      detail: { accountId, message: error instanceof Error ? error.message : String(error) }
    })
  );
}

function flushPendingOutbox(pending: PendingOutbox): void {
  const operations = pending.operations.splice(0);
  if (operations.length === 0) return;
  try {
    writeOutbox(pending.accountId, pending.storage, operations);
  } catch (error) {
    pending.operations.unshift(...operations);
    throw error;
  }
}

/** One synchronous read-modify-write of the stored list. */
function writeOutbox(
  accountId: string,
  storage: MessagingOutboxStorage,
  operations: OutboxOperation[]
): void {
  const cleared = operations.some((operation) => operation.kind === "clear");
  const entries = applyOutboxOperations(readStoredOutbox(accountId, storage), operations);
  if (cleared && entries.length === 0) storage.removeItem(storageKey(accountId));
  else storage.setItem(storageKey(accountId), JSON.stringify(entries));
}

function applyOutboxOperations(
  stored: MessagingOutboxEntry[],
  operations: readonly OutboxOperation[]
): MessagingOutboxEntry[] {
  let entries = stored;
  for (const operation of operations) {
    if (operation.kind === "clear") entries = [];
    else if (operation.kind === "put")
      entries = [
        ...entries.filter(
          (candidate) => candidate.clientMessageId !== operation.entry.clientMessageId
        ),
        operation.entry
      ];
    else if (operation.kind === "remove")
      entries = entries.filter(
        (candidate) => candidate.clientMessageId !== operation.clientMessageId
      );
    else
      entries = entries.map((candidate) =>
        candidate.clientMessageId === operation.clientMessageId &&
        operation.attempts > (candidate.attempts ?? 0)
          ? { ...candidate, attempts: operation.attempts, nextAttemptAt: operation.nextAttemptAt }
          : candidate
      );
  }
  return entries;
}

function readStoredOutbox(
  accountId: string,
  storage: Pick<MessagingOutboxStorage, "getItem">
): MessagingOutboxEntry[] {
  try {
    const stored = JSON.parse(storage.getItem(storageKey(accountId)) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (entry): entry is MessagingOutboxEntry =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { accountId?: unknown }).accountId === accountId &&
        typeof (entry as { clientMessageId?: unknown }).clientMessageId === "string" &&
        typeof (entry as { payload?: unknown }).payload === "object" &&
        (entry as { payload?: unknown }).payload !== null &&
        !Array.isArray((entry as { payload?: unknown }).payload)
    );
  } catch {
    return [];
  }
}

// A tab that closes while a write still waits for the lock writes it at once (without the lock)
// rather than losing it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function")
  window.addEventListener("pagehide", () => {
    for (const pending of pendingWrites) {
      try {
        flushPendingOutbox(pending);
      } catch {
        /* Storage blocked or full: nothing more can be done while the page goes away. */
      }
    }
  });

function announceOutboxChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(messagingOutboxChangeEvent));
}

function storageKey(accountId: string): string {
  return `${messagingOutboxStoragePrefix}:${accountId}`;
}

function discardUnsafeLegacyOutbox(storage: MessagingOutboxStorage): void {
  if (storage.getItem(legacyMessagingOutboxStorageKey) !== null) {
    storage.removeItem(legacyMessagingOutboxStorageKey);
  }
}
