import {
  openIndexedDbSyncRepository,
  type IndexedDbSyncRepository
} from "../sync/indexeddb-repository";

const prefix = "grogoni.messaging-outbox.";
const values = new Map<string, string>();
let repository: IndexedDbSyncRepository | null = null;
let opening: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let failure: unknown = null;
let channel: BroadcastChannel | null = null;
const changed = () => window.dispatchEvent(new Event("grogoni:messaging-outbox-change"));
function persist(key: string, value: string | null) {
  writes = writes
    .then(async () => {
      await repository!.writeMessagingOutbox(key, value);
      channel?.postMessage({ key, value });
    })
    .catch((error: unknown) => {
      failure = error;
      // Retry the latest value, never an obsolete plaintext payload after deletion/logout.
      setTimeout(() => persist(key, values.get(key) ?? null), 2_000);
    });
}
const cache = {
  get length() {
    return values.size;
  },
  key(index: number) {
    return [...values.keys()][index] ?? null;
  },
  getItem(key: string) {
    return values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    values.set(key, value);
    persist(key, value);
  },
  removeItem(key: string) {
    values.delete(key);
    persist(key, null);
  }
};
/** Synchronous reads use a hydrated device cache; network sends await the IDB transaction. */
export function messagingOutboxStorage(): Storage | typeof cache {
  return repository ? cache : localStorage;
}
export async function hydrateMessagingOutbox(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  if (opening) return opening;
  opening = (async () => {
    const received: Array<{ key: string; value: string | null }> = [];
    let loaded = false;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("grogoni.messaging-outbox.idb");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const entry = event.data as { key?: unknown; value?: unknown };
        if (
          typeof entry.key !== "string" ||
          !entry.key.startsWith(prefix) ||
          (entry.value !== null && typeof entry.value !== "string")
        )
          return;
        const row = { key: entry.key, value: entry.value as string | null };
        if (!loaded) received.push(row);
        else {
          if (row.value === null) values.delete(row.key);
          else values.set(row.key, row.value);
          changed();
        }
      };
    }
    const opened = await openIndexedDbSyncRepository();
    const existing = await opened.loadMessagingOutbox();
    for (const entry of existing) values.set(entry.key, entry.value);
    // Existing installations migrate the append-only journal without combining entries.
    const migrated: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      if (!values.has(key)) {
        values.set(key, await opened.migrateMessagingOutbox(key, value));
      }
      migrated.push(key);
    }
    repository = opened;
    for (const key of migrated) localStorage.removeItem(key);
    for (const row of received) {
      if (row.value === null) values.delete(row.key);
      else values.set(row.key, row.value);
    }
    loaded = true;
    changed();
  })().catch((error: unknown) => {
    channel?.close();
    channel = null;
    opening = null;
    throw error;
  });
  return opening;
}
export async function flushMessagingOutbox(): Promise<void> {
  await writes;
  if (failure) {
    const error = failure;
    failure = null;
    throw error;
  }
}
