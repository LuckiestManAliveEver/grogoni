import { isExplicitOfflineMode, offlineModeEvent, offlineRuntimeEnabled } from "../offline-runtime";
import { useEffect, useRef, useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type { SyncMutationPayload, SyncMutationType } from "@grogoni/shared-types";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, postJson } from "../api-helpers";
import {
  openIndexedDbSyncRepository,
  type IndexedDbSyncRepository
} from "../sync/indexeddb-repository";
import {
  catchUpAccountSync,
  createLocalSyncMutation,
  flushLocalSyncMutations
} from "../sync/sync-client";
import { subscribeToAccountRealtime } from "../sync/realtime-client";
import {
  apiBaseUrl,
  emptySyncSummary,
  type OfflineCacheSnapshot,
  type SessionResponse,
  type SyncQueueItem,
  type SyncQueueResponse,
  type SyncQueueSummary
} from "../grogoni-application-shared";

interface ReplaySyncLoaders {
  loadProducts: (businessId: string) => Promise<void>;
  loadCustomers: (businessId: string) => Promise<void>;
  loadInvoices: (businessId: string) => Promise<void>;
  loadPaymentData: (businessId: string) => Promise<void>;
  loadLogistics: (businessId: string) => Promise<void>;
}

interface UseSyncStateDeps {
  businessId: string | null;
  session: SessionResponse | null;
  setStatusMessage: (message: string) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useSyncState(deps: UseSyncStateDeps) {
  const [syncQueue, setSyncQueue] = useState<SyncQueueItem[]>([]);
  const [syncSummary, setSyncSummary] = useState<SyncQueueSummary>(emptySyncSummary);
  const [offlineCache, setOfflineCache] = useState<OfflineCacheSnapshot | null>(null);
  const syncRepositoryRef = useRef<IndexedDbSyncRepository | null>(null);

  useEffect(() => {
    const session = deps.session;
    if (session === null || globalThis.indexedDB === undefined) {
      return;
    }

    let cancelled = false;
    let closeRepository: (() => void) | undefined;
    let closeRealtime: (() => void) | undefined;
    let openedRepository: IndexedDbSyncRepository | null = null;
    let catchUpPromise: Promise<void> | null = null;
    let synchronize: (() => Promise<void>) | null = null;
    const synchronizeWhenOnline = () => {
      if (navigator.onLine && !isExplicitOfflineMode()) void synchronize?.();
    };
    const modeChanged = () => {
      if (isExplicitOfflineMode()) {
        closeRealtime?.();
        closeRealtime = undefined;
      } else synchronizeWhenOnline();
    };
    window.addEventListener(offlineModeEvent, modeChanged);
    window.addEventListener("online", synchronizeWhenOnline);
    void openIndexedDbSyncRepository()
      .then(async (repository) => {
        if (cancelled) {
          repository.close();
          return;
        }
        closeRepository = () => repository.close();
        openedRepository = repository;
        syncRepositoryRef.current = repository;
        const catchUp = () => {
          if (isExplicitOfflineMode()) return Promise.resolve();
          if (catchUpPromise === null) {
            catchUpPromise = catchUpAccountSync({
              accountId: session.account.id,
              repository,
              endpoint: `${apiBaseUrl}/v1/sync/changes`
            })
              .then(() => undefined)
              .finally(() => {
                catchUpPromise = null;
              });
          }
          return catchUpPromise;
        };
        const startRealtime = () => {
          if (
            cancelled ||
            closeRealtime !== undefined ||
            !navigator.onLine ||
            isExplicitOfflineMode()
          )
            return;
          const realtimeUrl = new URL(`${apiBaseUrl}/v1/realtime`, window.location.origin);
          realtimeUrl.protocol = realtimeUrl.protocol === "https:" ? "wss:" : "ws:";
          closeRealtime = subscribeToAccountRealtime({
            accountId: session.account.id,
            endpoint: realtimeUrl.toString(),
            transport:
              apiBaseUrl.startsWith("/") || apiBaseUrl.includes("/functions/v1/")
                ? "http-poll"
                : "websocket",
            onChangesAvailable: catchUp
          });
        };
        synchronize = async () => {
          if (cancelled || !navigator.onLine || isExplicitOfflineMode()) return;
          const transferred = await flushLocalSyncMutations({
            accountId: session.account.id,
            repository,
            apiBaseUrl
          });
          await catchUp();
          if (!cancelled && transferred.transferred > 0) {
            deps.setStatusMessage(
              `${transferred.transferred} offline change${
                transferred.transferred === 1 ? "" : "s"
              } synced`
            );
          }
          startRealtime();
        };
        if (navigator.onLine) {
          await synchronize();
        } else {
          deps.setStatusMessage("Offline data loaded; pending changes will sync after reconnect");
        }
      })
      .catch(() => {
        if (!cancelled && !navigator.onLine) {
          deps.setStatusMessage("Offline data loaded; catch-up will resume when connected");
        }
      });

    return () => {
      cancelled = true;
      window.removeEventListener(offlineModeEvent, modeChanged);
      window.removeEventListener("online", synchronizeWhenOnline);
      closeRealtime?.();
      if (syncRepositoryRef.current === openedRepository) {
        syncRepositoryRef.current = null;
      }
      closeRepository?.();
    };
    // Mirrors the original OwnerApp effect, which intentionally keyed off session.account.id only -
    // a full `deps` object dependency would re-run this effect, tearing down the IndexedDB
    // repository and realtime subscription, on every OwnerApp render (since `deps` is a fresh
    // object literal each render), not just on an actual session change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.session?.account.id]);

  async function loadSyncQueue(businessId: string) {
    try {
      const response = await getJson<SyncQueueResponse>(`/businesses/${businessId}/sync-queue`);
      setSyncSummary(response.summary);
      setSyncQueue(response.items);
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function loadOfflineCache(businessId: string) {
    try {
      setOfflineCache(
        await getJson<OfflineCacheSnapshot>(`/businesses/${businessId}/offline-cache`)
      );
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function replaySyncQueue(loaders: ReplaySyncLoaders) {
    if (deps.businessId === null) {
      return;
    }

    try {
      await postJson(`/businesses/${deps.businessId}/sync-queue/replay`, {});
      await loadSyncQueue(deps.businessId);
      await loadOfflineCache(deps.businessId);
      await loaders.loadProducts(deps.businessId);
      await loaders.loadCustomers(deps.businessId);
      await loaders.loadInvoices(deps.businessId);
      await loaders.loadPaymentData(deps.businessId);
      await loaders.loadLogistics(deps.businessId);
      deps.setStatusMessage("Sync queue replayed");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function replaySyncQueueItem(syncItemId: string, loaders: ReplaySyncLoaders) {
    if (deps.businessId === null) {
      return;
    }

    try {
      await postJson(`/businesses/${deps.businessId}/sync-queue/${syncItemId}/replay`, {});
      await loadSyncQueue(deps.businessId);
      await loadOfflineCache(deps.businessId);
      await loaders.loadProducts(deps.businessId);
      await loaders.loadCustomers(deps.businessId);
      await loaders.loadInvoices(deps.businessId);
      await loaders.loadPaymentData(deps.businessId);
      await loaders.loadLogistics(deps.businessId);
      deps.setStatusMessage("Sync item replayed");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function queueMutationAfterNetworkFailure(
    error: unknown,
    mutationType: SyncMutationType,
    payload: SyncMutationPayload
  ): Promise<boolean> {
    if (
      isExplicitOfflineMode() ||
      offlineRuntimeEnabled ||
      deps.businessId === null ||
      deps.session === null ||
      globalThis.indexedDB === undefined ||
      (navigator.onLine && !(error instanceof TypeError))
    ) {
      return false;
    }

    let repository = syncRepositoryRef.current;
    let closeAfterWrite = false;

    if (repository === null) {
      repository = await openIndexedDbSyncRepository();
      closeAfterWrite = true;
    }

    try {
      await repository.putMutation(
        createLocalSyncMutation({
          accountId: deps.session.account.id,
          actorId: deps.session.user.id,
          businessId: deps.businessId,
          mutationType,
          payload
        })
      );
      deps.setStatusMessage("Saved offline. This change will sync automatically after reconnect.");
      return true;
    } finally {
      if (closeAfterWrite) {
        repository.close();
      }
    }
  }

  deps.registerReset("sync", () => {
    setSyncQueue([]);
    setSyncSummary(emptySyncSummary);
    setOfflineCache(null);
  });
  deps.registerRefresh("sync", ["home", "sync"], async (businessId) => {
    await Promise.all([loadSyncQueue(businessId), loadOfflineCache(businessId)]);
  });

  return {
    syncQueue,
    syncSummary,
    offlineCache,
    syncRepositoryRef,
    loadSyncQueue,
    loadOfflineCache,
    replaySyncQueue,
    replaySyncQueueItem,
    queueMutationAfterNetworkFailure
  };
}
