import { emptyState, scopeKey, type LocalState, type Scope } from "../types.js";

export interface LocalDatabase {
  read(scope: Scope): Promise<LocalState>;
  /** Callback must be synchronous: mutations, sequence allocation and log commit atomically. */
  transaction<T>(scope: Scope, change: (state: LocalState) => T): Promise<T>;
  close(): void;
}

export async function openLocalDatabase(
  factory: IDBFactory = globalThis.indexedDB,
  name = "grogoni-offline-runtime"
): Promise<LocalDatabase> {
  if (!factory) throw new Error("Persistent device storage is unavailable.");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("scopes");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Grogoni tabs to upgrade offline storage."));
  });
  function run<T>(
    scope: Scope,
    mode: IDBTransactionMode,
    change: (state: LocalState) => T
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("scopes", mode);
      const store = tx.objectStore("scopes");
      const request = store.get(scopeKey(scope));
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const state: LocalState = request.result ?? emptyState(scope);
          result = change(state);
          if (result instanceof Promise)
            throw new Error("Local transactions cannot await external work.");
          if (mode === "readwrite") store.put(state, scopeKey(scope));
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Offline transaction aborted."));
      tx.onerror = () => {
        failure ??= tx.error;
      };
    });
  }
  return {
    read: (scope) => run(scope, "readonly", (state) => state),
    transaction: (scope, change) => run(scope, "readwrite", change),
    close: () => db.close()
  };
}
