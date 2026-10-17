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
  let updated: MessagingOutboxEntry | null = null;
  const entries = readMessagingOutbox(accountId, storage).map((entry) => {
    if (entry.clientMessageId !== clientMessageId) return entry;
    const attempts = (entry.attempts ?? 0) + 1;
    updated = { ...entry, attempts, nextAttemptAt: now + outboxBackoffMs(attempts) };
    return updated;
  });
  storage.setItem(storageKey(accountId), JSON.stringify(entries));
  announceOutboxChange();
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

let countMemo: { key: string; raw: string | null; count: number } | null = null;

/**
 * How many messages wait in this account's outbox (in one conversation, when given), for
 * rendering: never writes (unlike
 * readMessagingOutbox, which discards the legacy key), never throws (blocked storage reads as 0),
 * and parses only when the stored value changed.
 */
export function countMessagingOutbox(
  accountId: string,
  conversationId?: string | null,
  storage: Pick<MessagingOutboxStorage, "getItem"> = localStorage
): number {
  try {
    const key = `${storageKey(accountId)}#${conversationId === undefined ? "*" : conversationId}`;
    const raw = storage.getItem(storageKey(accountId));
    if (countMemo !== null && countMemo.key === key && countMemo.raw === raw)
      return countMemo.count;
    const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);
    const count = Array.isArray(parsed)
      ? parsed.filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { accountId?: unknown }).accountId === accountId &&
            (conversationId === undefined ||
              (entry as { payload?: { conversationId?: unknown } }).payload?.conversationId ===
                conversationId)
        ).length
      : 0;
    countMemo = { key, raw, count };
    return count;
  } catch {
    return 0;
  }
}

export function queueMessagingOutbox(
  entry: MessagingOutboxEntry,
  storage: MessagingOutboxStorage = localStorage
): void {
  const entries = readMessagingOutbox(entry.accountId, storage).filter(
    (candidate) => candidate.clientMessageId !== entry.clientMessageId
  );
  storage.setItem(storageKey(entry.accountId), JSON.stringify([...entries, entry]));
  announceOutboxChange();
}

export function removeMessagingOutboxEntry(
  accountId: string,
  clientMessageId: string,
  storage: MessagingOutboxStorage = localStorage
): void {
  storage.setItem(
    storageKey(accountId),
    JSON.stringify(
      readMessagingOutbox(accountId, storage).filter(
        (entry) => entry.clientMessageId !== clientMessageId
      )
    )
  );
  announceOutboxChange();
}

export function clearMessagingOutbox(
  accountId: string,
  storage: MessagingOutboxStorage = localStorage
): void {
  storage.removeItem(storageKey(accountId));
  discardUnsafeLegacyOutbox(storage);
  // The thread copies of queued messages go with the queue.
  clearDeviceOnlyMessages(accountId, storage);
  announceOutboxChange();
}

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
