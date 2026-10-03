import type {
  LocalSyncMutation,
  LocalSyncSnapshot,
  SyncMutationPayload,
  SyncMutationType,
  SyncPullPage,
  SyncQueueItem
} from "@grogoni/shared-types";
import { readApiBaseUrl } from "../lib/api";

export interface AccountSyncRepository {
  loadSnapshot<T>(accountId: string): Promise<LocalSyncSnapshot<T>>;
  applyPullPage<T>(page: SyncPullPage<T>): Promise<LocalSyncSnapshot<T>>;
  clearAccount(accountId: string): Promise<void>;
}

export interface CatchUpAccountSyncOptions {
  accountId: string;
  repository: AccountSyncRepository;
  fetcher?: typeof fetch;
  endpoint?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface LocalMutationSyncRepository {
  listMutations(accountId: string): Promise<LocalSyncMutation[]>;
  putMutation(mutation: LocalSyncMutation): Promise<void>;
  removeMutation(id: string): Promise<void>;
}

export interface FlushLocalMutationsOptions {
  accountId: string;
  repository: LocalMutationSyncRepository;
  fetcher?: typeof fetch;
  apiBaseUrl?: string;
}

export interface FlushLocalMutationsResult {
  transferred: number;
  replayedBusinesses: string[];
  remaining: number;
}

export function createLocalSyncMutation(input: {
  accountId: string;
  actorId: string;
  businessId: string;
  mutationType: SyncMutationType;
  payload: SyncMutationPayload;
  now?: Date;
  id?: string;
}): LocalSyncMutation {
  const now = (input.now ?? new Date()).toISOString();
  const id = input.id ?? globalThis.crypto.randomUUID();

  return {
    id,
    accountId: input.accountId,
    actorId: input.actorId,
    businessId: input.businessId,
    idempotencyKey: `web-${id}`,
    mutationType: input.mutationType,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    clientCreatedAt: now,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: null,
    result: null,
    conflict: null
  };
}

export async function flushLocalSyncMutations(
  options: FlushLocalMutationsOptions
): Promise<FlushLocalMutationsResult> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? readApiBaseUrl()).replace(/\/+$/u, "");
  const mutations = await options.repository.listMutations(options.accountId);
  const replayBusinesses = new Set<string>();
  let transferred = 0;

  for (const mutation of mutations) {
    const response = await fetcher(
      `${apiBaseUrl}/businesses/${encodeURIComponent(mutation.businessId)}/sync-queue`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: mutation.idempotencyKey,
          mutationType: mutation.mutationType,
          payload: mutation.payload,
          clientCreatedAt: mutation.clientCreatedAt
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Local mutation transfer failed with HTTP ${response.status}.`);
    }

    const accepted = (await response.json()) as SyncQueueItem;
    if (
      accepted.businessId !== mutation.businessId ||
      accepted.idempotencyKey !== mutation.idempotencyKey
    ) {
      throw new Error("Local mutation transfer returned a mismatched queue item.");
    }

    await options.repository.removeMutation(mutation.id);
    replayBusinesses.add(mutation.businessId);
    transferred += 1;
  }

  for (const businessId of replayBusinesses) {
    const response = await fetcher(
      `${apiBaseUrl}/businesses/${encodeURIComponent(businessId)}/sync-queue/replay`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}"
      }
    );
    if (!response.ok) {
      throw new Error(`Server mutation replay failed with HTTP ${response.status}.`);
    }
  }

  return {
    transferred,
    replayedBusinesses: [...replayBusinesses],
    remaining: (await options.repository.listMutations(options.accountId)).length
  };
}

export async function catchUpAccountSync<T = unknown>(
  options: CatchUpAccountSyncOptions
): Promise<LocalSyncSnapshot<T>> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = options.endpoint ?? `${readApiBaseUrl()}/v1/sync/changes`;
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
  const maxPages = Math.max(1, options.maxPages ?? 1_000);
  let snapshot = await options.repository.loadSnapshot<T>(options.accountId);
  let resetAttempted = false;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const parameters = new URLSearchParams({ limit: String(pageSize) });
    if (snapshot.cursor !== null) {
      parameters.set("cursor", snapshot.cursor);
    }
    const response = await fetcher(`${endpoint}?${parameters.toString()}`, {
      credentials: "include"
    });

    if (response.status === 409 && !resetAttempted) {
      await options.repository.clearAccount(options.accountId);
      snapshot = await options.repository.loadSnapshot<T>(options.accountId);
      resetAttempted = true;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Account sync failed with HTTP ${response.status}.`);
    }

    const page = (await response.json()) as SyncPullPage<T>;
    if (page.accountId !== options.accountId) {
      throw new Error("The sync response belongs to another account.");
    }
    snapshot = await options.repository.applyPullPage(page);

    if (!page.hasMore) {
      return snapshot;
    }
  }

  throw new Error("Account sync exceeded the maximum page count.");
}
