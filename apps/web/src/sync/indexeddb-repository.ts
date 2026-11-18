import { applySyncPullPage } from "@grogoni/sync-core";
import type {
  LocalSyncMutation,
  LocalSyncRecord,
  LocalSyncSnapshot,
  SyncCollection,
  SyncPullPage
} from "@grogoni/shared-types";

const databaseVersion = 3;
const recordsStore = "sync_records";
const metadataStore = "sync_metadata";
const mutationsStore = "sync_mutations";
const accountIndex = "by_account";
const messagingOutboxStore = "messaging_outbox";

interface StoredSyncMetadata {
  accountId: string;
  cursor: string | null;
  updatedAt: string;
}

export interface IndexedDbSyncRepositoryOptions {
  databaseName?: string;
  factory?: IDBFactory;
}

export class IndexedDbSyncRepository {
  readonly #database: IDBDatabase;

  constructor(database: IDBDatabase) {
    this.#database = database;
  }

  close(): void {
    this.#database.close();
  }

  async loadMessagingOutbox(): Promise<Array<{ key: string; value: string }>> {
    const tx = this.#database.transaction(messagingOutboxStore, "readonly");
    const done = transactionCompletion(tx);
    const entries = await requestResult<Array<{ key: string; value: string }>>(
      tx.objectStore(messagingOutboxStore).getAll()
    );
    await done;
    return entries;
  }

  async writeMessagingOutbox(key: string, value: string | null): Promise<void> {
    const tx = this.#database.transaction(messagingOutboxStore, "readwrite");
    const done = transactionCompletion(tx);
    if (value === null) tx.objectStore(messagingOutboxStore).delete(key);
    else tx.objectStore(messagingOutboxStore).put({ key, value });
    await done;
  }

  /** A second tab migrating stale browser storage must never overwrite a newer IDB value. */
  async migrateMessagingOutbox(key: string, value: string): Promise<string> {
    const tx = this.#database.transaction(messagingOutboxStore, "readwrite");
    const done = transactionCompletion(tx);
    const store = tx.objectStore(messagingOutboxStore);
    const current = await requestResult<{ key: string; value: string } | undefined>(store.get(key));
    if (current === undefined) store.put({ key, value });
    await done;
    return current?.value ?? value;
  }

  async loadSnapshot<T>(accountId: string): Promise<LocalSyncSnapshot<T>> {
    const transaction = this.#database.transaction([recordsStore, metadataStore], "readonly");
    const completion = transactionCompletion(transaction);
    const recordsRequest = requestResult(
      transaction.objectStore(recordsStore).index(accountIndex).getAll(accountId)
    );
    const metadataRequest = requestResult<StoredSyncMetadata | undefined>(
      transaction.objectStore(metadataStore).get(accountId)
    );
    const [records, metadata] = await Promise.all([recordsRequest, metadataRequest]);
    await completion;

    return {
      accountId,
      cursor: metadata?.cursor ?? null,
      records: (records as LocalSyncRecord<T>[]).sort(compareRecords)
    };
  }

  async applyPullPage<T>(page: SyncPullPage<T>): Promise<LocalSyncSnapshot<T>> {
    const transaction = this.#database.transaction([recordsStore, metadataStore], "readwrite");
    const completion = transactionCompletion(transaction);
    const recordStore = transaction.objectStore(recordsStore);
    const metadataObjectStore = transaction.objectStore(metadataStore);
    const existingRecordsRequest = requestResult(
      recordStore.index(accountIndex).getAll(page.accountId)
    );
    const metadataRequest = requestResult<StoredSyncMetadata | undefined>(
      metadataObjectStore.get(page.accountId)
    );
    const [existingRecords, metadata] = await Promise.all([
      existingRecordsRequest,
      metadataRequest
    ]);
    const snapshot: LocalSyncSnapshot<T> = {
      accountId: page.accountId,
      cursor: metadata?.cursor ?? null,
      records: existingRecords as LocalSyncRecord<T>[]
    };
    const nextSnapshot = applySyncPullPage(snapshot, page);

    for (const change of page.changes) {
      const record = nextSnapshot.records.find(
        (candidate) =>
          candidate.collection === change.collection && candidate.entityId === change.entityId
      );
      if (record !== undefined) {
        recordStore.put(record);
      }
    }

    metadataObjectStore.put({
      accountId: page.accountId,
      cursor: nextSnapshot.cursor,
      updatedAt: page.serverTime
    } satisfies StoredSyncMetadata);

    await completion;
    return { ...nextSnapshot, records: [...nextSnapshot.records].sort(compareRecords) };
  }

  async listActive<T>(
    accountId: string,
    collection: SyncCollection
  ): Promise<LocalSyncRecord<T>[]> {
    const snapshot = await this.loadSnapshot<T>(accountId);
    return snapshot.records.filter(
      (record) => record.collection === collection && record.deletedAt === null
    );
  }

  async putMutation(mutation: LocalSyncMutation): Promise<void> {
    const transaction = this.#database.transaction(mutationsStore, "readwrite");
    const completion = transactionCompletion(transaction);
    transaction.objectStore(mutationsStore).put(mutation);
    await completion;
  }

  async listMutations(accountId: string): Promise<LocalSyncMutation[]> {
    const transaction = this.#database.transaction(mutationsStore, "readonly");
    const completion = transactionCompletion(transaction);
    const mutations = await requestResult<LocalSyncMutation[]>(
      transaction.objectStore(mutationsStore).index(accountIndex).getAll(accountId)
    );
    await completion;
    return mutations.sort((left, right) =>
      left.clientCreatedAt.localeCompare(right.clientCreatedAt)
    );
  }

  async removeMutation(id: string): Promise<void> {
    const transaction = this.#database.transaction(mutationsStore, "readwrite");
    const completion = transactionCompletion(transaction);
    transaction.objectStore(mutationsStore).delete(id);
    await completion;
  }

  async clearAccount(accountId: string): Promise<void> {
    const transaction = this.#database.transaction([recordsStore, metadataStore], "readwrite");
    const completion = transactionCompletion(transaction);
    const recordStore = transaction.objectStore(recordsStore);
    const keys = await requestResult(recordStore.index(accountIndex).getAllKeys(accountId));

    for (const key of keys) {
      recordStore.delete(key);
    }
    transaction.objectStore(metadataStore).delete(accountId);
    await completion;
  }

  async clearAllAccountData(accountId: string): Promise<void> {
    await this.clearAccount(accountId);
    const transaction = this.#database.transaction(mutationsStore, "readwrite");
    const completion = transactionCompletion(transaction);
    const mutationStore = transaction.objectStore(mutationsStore);
    const mutationKeys = await requestResult(
      mutationStore.index(accountIndex).getAllKeys(accountId)
    );
    for (const key of mutationKeys) {
      mutationStore.delete(key);
    }
    await completion;
  }
}

export async function openIndexedDbSyncRepository(
  options: IndexedDbSyncRepositoryOptions = {}
): Promise<IndexedDbSyncRepository> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new Error("IndexedDB is unavailable in this runtime.");
  }

  const request = factory.open(options.databaseName ?? "grogoni-sync", databaseVersion);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(messagingOutboxStore))
      database.createObjectStore(messagingOutboxStore, { keyPath: "key" });
    if (!database.objectStoreNames.contains(recordsStore)) {
      const store = database.createObjectStore(recordsStore, {
        keyPath: ["accountId", "collection", "entityId"]
      });
      store.createIndex(accountIndex, "accountId", { unique: false });
    }
    if (!database.objectStoreNames.contains(metadataStore)) {
      database.createObjectStore(metadataStore, { keyPath: "accountId" });
    }
    if (!database.objectStoreNames.contains(mutationsStore)) {
      const store = database.createObjectStore(mutationsStore, { keyPath: "id" });
      store.createIndex(accountIndex, "accountId", { unique: false });
    }
  };

  return new IndexedDbSyncRepository(await requestResult(request));
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

function compareRecords<T>(left: LocalSyncRecord<T>, right: LocalSyncRecord<T>): number {
  const collectionOrder = left.collection.localeCompare(right.collection);
  return collectionOrder === 0 ? left.entityId.localeCompare(right.entityId) : collectionOrder;
}
