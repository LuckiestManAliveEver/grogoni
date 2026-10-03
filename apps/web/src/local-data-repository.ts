import { markIndexedDbReadEnd, markIndexedDbReadStart, recordCacheHydration } from "./performance";

export type LocalDataStatus = "hydrated" | "stale" | "refreshing" | "offline" | "failed" | "empty";

export interface LocalDataSnapshot<T> {
  status: LocalDataStatus;
  value: T | null;
  updatedAt: number | null;
  error: unknown | null;
}

interface StoredLocalData<T = unknown> {
  id: string;
  scope: string;
  domain: LocalDataDomain;
  key: string;
  schemaVersion: number;
  updatedAt: number;
  value: T;
}

export type LocalDataDomain =
  "session" | "shop" | "conversation" | "catalogue" | "model" | "workspace" | "sync";

export interface LocalDataRepository<T> {
  readCached(key: string): Promise<LocalDataSnapshot<T>>;
  writeCached(key: string, value: T): Promise<void>;
  refresh(
    key: string,
    loader: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
  invalidate(key?: string): Promise<void>;
  subscribe(key: string, listener: (snapshot: LocalDataSnapshot<T>) => void): () => void;
  clearForLogout(): Promise<void>;
}

const databaseName = "grogoni-local-data";
const databaseVersion = 1;
const entriesStore = "entries";
const scopeIndex = "by_scope";
const domainIndex = "by_scope_domain";
const recordSchemaVersion = 1;
const memory = new Map<string, StoredLocalData>();
const listeners = new Map<string, Set<(snapshot: LocalDataSnapshot<unknown>) => void>>();
const refreshSequence = new Map<string, number>();
let databasePromise: Promise<IDBDatabase> | null = null;

export function createLocalDataRepository<T>(
  domain: LocalDataDomain,
  scope: string
): LocalDataRepository<T> {
  const normalizedScope = scope.trim() || "anonymous";

  return {
    async readCached(key) {
      const id = recordId(normalizedScope, domain, key);
      const inMemory = memory.get(id) as StoredLocalData<T> | undefined;
      if (inMemory !== undefined) {
        return snapshotFromRecord(inMemory);
      }
      if (globalThis.indexedDB === undefined) {
        return emptySnapshot();
      }

      const measurement = markIndexedDbReadStart(domain);
      try {
        const database = await openDatabase();
        const transaction = database.transaction(entriesStore, "readonly");
        const record = await requestResult<StoredLocalData<T> | undefined>(
          transaction.objectStore(entriesStore).get(id)
        );
        await transactionCompletion(transaction);
        if (record === undefined || record.schemaVersion !== recordSchemaVersion) {
          recordCacheHydration(domain, "empty");
          return emptySnapshot();
        }
        memory.set(id, record);
        recordCacheHydration(domain, "hydrated");
        return snapshotFromRecord(record);
      } catch (error) {
        return { status: "failed", value: null, updatedAt: null, error };
      } finally {
        markIndexedDbReadEnd(measurement);
      }
    },

    async writeCached(key, value) {
      const record: StoredLocalData<T> = {
        id: recordId(normalizedScope, domain, key),
        scope: normalizedScope,
        domain,
        key,
        schemaVersion: recordSchemaVersion,
        updatedAt: Date.now(),
        value
      };
      memory.set(record.id, record);
      notify(record.id, snapshotFromRecord(record));
      if (globalThis.indexedDB === undefined) return;
      const database = await openDatabase();
      const transaction = database.transaction(entriesStore, "readwrite");
      transaction.objectStore(entriesStore).put(record);
      await transactionCompletion(transaction);
    },

    async refresh(key, loader, signal) {
      const id = recordId(normalizedScope, domain, key);
      const sequence = (refreshSequence.get(id) ?? 0) + 1;
      refreshSequence.set(id, sequence);
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      notify(id, {
        ...(await this.readCached(key)),
        status: navigatorOnline() ? "refreshing" : "offline"
      });
      try {
        const value = await loader(controller.signal);
        if (refreshSequence.get(id) !== sequence || controller.signal.aborted) {
          return value;
        }
        await this.writeCached(key, value);
        return value;
      } catch (error) {
        const cached = await this.readCached(key);
        notify(id, {
          ...cached,
          status: navigatorOnline() ? "failed" : "offline",
          error
        });
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },

    async invalidate(key) {
      const database = globalThis.indexedDB === undefined ? null : await openDatabase();
      if (key !== undefined) {
        const id = recordId(normalizedScope, domain, key);
        memory.delete(id);
        refreshSequence.set(id, (refreshSequence.get(id) ?? 0) + 1);
        if (database !== null) {
          const transaction = database.transaction(entriesStore, "readwrite");
          transaction.objectStore(entriesStore).delete(id);
          await transactionCompletion(transaction);
        }
        notify(id, emptySnapshot());
        return;
      }

      await deleteMatching(database, normalizedScope, domain);
    },

    subscribe(key, listener) {
      const id = recordId(normalizedScope, domain, key);
      const entries =
        listeners.get(id) ?? new Set<(snapshot: LocalDataSnapshot<unknown>) => void>();
      entries.add(listener as (snapshot: LocalDataSnapshot<unknown>) => void);
      listeners.set(id, entries);
      return () => {
        entries.delete(listener as (snapshot: LocalDataSnapshot<unknown>) => void);
        if (entries.size === 0) listeners.delete(id);
      };
    },

    async clearForLogout() {
      await deleteMatching(
        globalThis.indexedDB === undefined ? null : await openDatabase(),
        normalizedScope
      );
    }
  };
}

export function sessionRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("session", scope);
}

export function shopRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("shop", scope);
}

export function conversationRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("conversation", scope);
}

export function catalogueRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("catalogue", scope);
}

export function modelRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("model", scope);
}

export function syncRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("sync", scope);
}

export function workspaceRepository<T>(scope: string): LocalDataRepository<T> {
  return createLocalDataRepository<T>("workspace", scope);
}

export async function clearAllLocalData(): Promise<void> {
  memory.clear();
  refreshSequence.clear();
  if (globalThis.indexedDB === undefined) return;
  const database = await openDatabase();
  const transaction = database.transaction(entriesStore, "readwrite");
  transaction.objectStore(entriesStore).clear();
  await transactionCompletion(transaction);
}

async function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise !== null) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(entriesStore)) {
        const store = database.createObjectStore(entriesStore, { keyPath: "id" });
        store.createIndex(scopeIndex, "scope", { unique: false });
        store.createIndex(domainIndex, ["scope", "domain"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Unable to open the local data cache."));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("The local data cache upgrade is blocked by another tab."));
    };
  });
  return databasePromise;
}

async function deleteMatching(
  database: IDBDatabase | null,
  scope: string,
  domain?: LocalDataDomain
): Promise<void> {
  const prefix = `${scope}\u0000${domain === undefined ? "" : `${domain}\u0000`}`;
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  if (database === null) return;
  const transaction = database.transaction(entriesStore, "readwrite");
  const store = transaction.objectStore(entriesStore);
  const index = domain === undefined ? store.index(scopeIndex) : store.index(domainIndex);
  const query = domain === undefined ? scope : [scope, domain];
  const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(query));
  for (const key of keys) store.delete(key);
  await transactionCompletion(transaction);
}

function recordId(scope: string, domain: LocalDataDomain, key: string): string {
  return `${scope}\u0000${domain}\u0000${key}`;
}

function snapshotFromRecord<T>(record: StoredLocalData<T>): LocalDataSnapshot<T> {
  return {
    status: "hydrated",
    value: record.value,
    updatedAt: record.updatedAt,
    error: null
  };
}

function emptySnapshot<T>(): LocalDataSnapshot<T> {
  return { status: "empty", value: null, updatedAt: null, error: null };
}

function notify<T>(id: string, snapshot: LocalDataSnapshot<T>): void {
  for (const listener of listeners.get(id) ?? []) {
    listener(snapshot as LocalDataSnapshot<unknown>);
  }
}

function navigatorOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}
