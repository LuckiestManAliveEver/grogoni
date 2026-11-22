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
const hydrateTimeoutMs = 3_000;
let channel: BroadcastChannel | null = null;
const changed = () => window.dispatchEvent(new Event("grogoni:messaging-outbox-change"));
function persist(key: string, value: string | null) {
  writes = writes
    .then(async () => {
      // The device database was closed under us (see useLocalStorageFromNow): local storage.
      if (repository === null) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        return;
      }
      await repository.writeMessagingOutbox(key, value);
      channel?.postMessage({ key, value });
    })
    .catch((error: unknown) => {
      failure = error;
      // Retry the latest value, never an obsolete plaintext payload after deletion/logout. Not
      // after the database was closed under us: useLocalStorageFromNow already moved every value.
      setTimeout(() => {
        if (repository !== null) persist(key, values.get(key) ?? null);
      }, 2_000);
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
/**
 * A newer Grogoni version in another tab upgraded the device database, closing it here. This tab
 * cannot use the newer version, so its waiting messages move to local storage and the outbox works
 * from there; the next load migrates them back into the device database.
 */
function useLocalStorageFromNow() {
  repository = null;
  channel?.close();
  channel = null;
  try {
    for (const [key, value] of values) localStorage.setItem(key, value);
  } catch (error) {
    console.warn("[Grogoni] Outbox move failed.", error);
  }
  values.clear();
  changed();
}
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
    // Bounded: an open blocked by an older tab must not hold every send (they await this).
    let timedOut = false;
    const openRequest = openIndexedDbSyncRepository();
    void openRequest.then(
      (late) => {
        if (timedOut) late.close();
      },
      () => undefined
    );
    const opened = await Promise.race([
      openRequest,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error("Opening the device outbox timed out."));
        }, hydrateTimeoutMs)
      )
    ]);
    // Closed by a newer version before this finished loading: fall back (the catch below).
    let closedWhileLoading = false;
    opened.onVersionClose = () => {
      closedWhileLoading = true;
    };
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
    if (closedWhileLoading) {
      // The newer tab holds (and sends) what was loaded; this tab works from local storage.
      values.clear();
      throw new Error("Outbox upgraded in another tab.");
    }
    repository = opened;
    opened.onVersionClose = useLocalStorageFromNow;
    for (const key of migrated) localStorage.removeItem(key);
    for (const row of received) {
      if (row.value === null) values.delete(row.key);
      else values.set(row.key, row.value);
    }
    loaded = true;
    changed();
  })().catch((error: unknown) => {
    // The outbox keeps working on localStorage (messagingOutboxStorage falls back): a device
    // database that cannot open must never turn a send into a failure. Not retried this session.
    channel?.close();
    channel = null;
    console.warn("[Grogoni] Outbox on local storage.", error);
  });
  return opening;
}
/**
 * Waits for pending outbox writes. A failed device-database write is logged, not thrown: persist()
 * already retries the latest value, and failing here turned an unrelated send into a lost one.
 */
export async function flushMessagingOutbox(): Promise<void> {
  await writes;
  if (failure) {
    console.warn("[Grogoni] Outbox write failed; retrying.", failure);
    failure = null;
  }
}
