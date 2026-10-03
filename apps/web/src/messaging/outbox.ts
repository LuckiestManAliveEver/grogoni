const messagingOutboxStoragePrefix = "grogoni.messaging-outbox.v2";
const legacyMessagingOutboxStorageKey = "grogoni.messaging-outbox.v1";

export interface MessagingOutboxEntry {
  accountId: string;
  clientMessageId: string;
  payload: Record<string, unknown>;
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

export function queueMessagingOutbox(
  entry: MessagingOutboxEntry,
  storage: MessagingOutboxStorage = localStorage
): void {
  const entries = readMessagingOutbox(entry.accountId, storage).filter(
    (candidate) => candidate.clientMessageId !== entry.clientMessageId
  );
  storage.setItem(storageKey(entry.accountId), JSON.stringify([...entries, entry]));
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
}

export function clearMessagingOutbox(
  accountId: string,
  storage: MessagingOutboxStorage = localStorage
): void {
  storage.removeItem(storageKey(accountId));
  discardUnsafeLegacyOutbox(storage);
}

function storageKey(accountId: string): string {
  return `${messagingOutboxStoragePrefix}:${accountId}`;
}

function discardUnsafeLegacyOutbox(storage: MessagingOutboxStorage): void {
  if (storage.getItem(legacyMessagingOutboxStorageKey) !== null) {
    storage.removeItem(legacyMessagingOutboxStorageKey);
  }
}
