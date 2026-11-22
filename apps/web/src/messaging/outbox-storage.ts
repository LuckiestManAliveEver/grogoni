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
// A slow device-database open is still being waited for (it is adopted when it opens).
let adoptingLate = false;
const hydrateTimeoutMs = 3_000;
/** A device database that failed or was blocked is tried again this long after, on next use. */
export const reopenAfterFailureMs = 30_000;
let openFailedAt: number | null = null;
// A newer Grogoni version took the database: this tab's code cannot open it again.
let superseded = false;
/**
 * Dispatched on window when a device database that opened late (after the page-load resend pass
 * ran on the local-storage fallback) is adopted, so that pass runs again with what it brought in.
 */
export const messagingOutboxAdoptedEvent = "grogoni:messaging-outbox-adopted";
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
  superseded = true;
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
  const retry =
    openFailedAt !== null &&
    Date.now() - openFailedAt >= reopenAfterFailureMs &&
    repository === null &&
    !adoptingLate &&
    !superseded;
  if (opening && !retry) return opening;
  openFailedAt = null;
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
    // Bounded: a slow open must not hold every send (they await this). A blocked open already
    // fails fast; a slow one is adopted when it arrives (adopt below), with what was written to
    // local storage meanwhile, so messages left by an earlier page are not hidden all session.
    const openRequest = openIndexedDbSyncRepository();
    const adopt = async (opened: IndexedDbSyncRepository) => {
      // Closed by a newer version before this finished loading: fall back (the catch below).
      let closedWhileLoading = false;
      opened.onVersionClose = () => {
        closedWhileLoading = true;
      };
      const existing = await opened.loadMessagingOutbox();
      for (const entry of existing) values.set(entry.key, entry.value);
      // Existing installations migrate the append-only journal without combining entries. Sends
      // can write to local storage while this awaits (after a late open they no longer wait for
      // it), and storage order is not insertion order: scan again until a pass finds nothing new.
      // That last pass does no await, so nothing is written between it and the switch below.
      const migrated = new Set<string>();
      for (;;) {
        const fresh: Array<[string, string]> = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith(prefix) || migrated.has(key)) continue;
          const value = localStorage.getItem(key);
          if (value !== null) fresh.push([key, value]);
        }
        if (fresh.length === 0) break;
        for (const [key, value] of fresh) {
          if (!values.has(key)) values.set(key, await opened.migrateMessagingOutbox(key, value));
          migrated.add(key);
        }
      }
      if (closedWhileLoading) {
        // The newer tab holds (and sends) what was loaded; this tab works from local storage,
        // for good: its code cannot open the newer database.
        superseded = true;
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
      adoptingLate = false;
      changed();
    };
    const first = await Promise.race([
      openRequest,
      new Promise<"late">((resolve) => setTimeout(() => resolve("late"), hydrateTimeoutMs))
    ]);
    if (first === "late") {
      adoptingLate = true;
      void openRequest
        .then(adopt)
        .then(() => window.dispatchEvent(new Event(messagingOutboxAdoptedEvent)))
        .catch((error: unknown) => {
          adoptingLate = false;
          openFailedAt = Date.now();
          channel?.close();
          channel = null;
          console.warn("[Grogoni] Outbox on local storage.", error);
        });
      throw new Error("Opening the device outbox timed out.");
    }
    await adopt(first);
  })().catch((error: unknown) => {
    // The outbox keeps working on localStorage (messagingOutboxStorage falls back): a device
    // database that cannot open must never turn a send into a failure.
    // A newer version already upgraded the database: this tab's code can never open it again.
    if ((error as { name?: string } | null)?.name === "VersionError") superseded = true;
    if (!adoptingLate) {
      openFailedAt = Date.now();
      channel?.close();
      channel = null;
    }
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
