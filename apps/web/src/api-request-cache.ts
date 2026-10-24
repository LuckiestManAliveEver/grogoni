import { readCachedAuthSession } from "./auth-bootstrap";
import { apiFetch } from "./lib/api";
import { isExplicitOfflineMode } from "./offline-runtime";
import {
  clearAllLocalData,
  createLocalDataRepository,
  type LocalDataDomain
} from "./local-data-repository";
import { recordApiCache } from "./performance";

interface CacheEntry {
  cacheKey: string;
  value: unknown;
  updatedAt: number;
  inFlight: Promise<unknown> | null;
}

function accountCacheScope(): string {
  return readCachedAuthSession()?.account.id ?? "anonymous";
}
function requireCurrentCacheScope(entry: CacheEntry): void {
  if (!entry.cacheKey.startsWith(`${accountCacheScope()}\0`))
    throw new DOMException("The signed-in account changed.", "AbortError");
}

const responseCache = new Map<string, CacheEntry>();
const defaultStaleTimeMs = 30_000;
const mutationListeners = new Set<(path: string) => void>();

export interface CachedGetOptions<T = unknown> {
  force?: boolean;
  onBackgroundUpdate?: (value: T) => void;
  staleTimeMs?: number;
}

export async function getCachedJson<TResponse>(
  path: string,
  options: CachedGetOptions<TResponse> = {}
): Promise<TResponse> {
  if (isExplicitOfflineMode()) return apiFetch<TResponse>(path);
  const now = Date.now();
  const staleTimeMs = options.staleTimeMs ?? staleTimeForPath(path);
  const cacheKey = `${accountCacheScope()}\0${path}`;
  const existing = responseCache.get(cacheKey);

  if (existing?.inFlight !== null && existing?.inFlight !== undefined && existing.updatedAt === 0) {
    recordApiCache(path, "deduplicated");
    return existing.inFlight as Promise<TResponse>;
  }

  if (!options.force && existing !== undefined) {
    if (now - existing.updatedAt < staleTimeMs) {
      recordApiCache(path, "fresh");
      return existing.value as TResponse;
    }

    if (existing.inFlight !== null) {
      recordApiCache(path, "deduplicated");
      return existing.value as TResponse;
    }

    recordApiCache(path, "stale");
    existing.inFlight = refresh<TResponse>(path, existing, options.onBackgroundUpdate);
    void existing.inFlight.catch(() => undefined);
    return existing.value as TResponse;
  }

  if (existing?.inFlight !== null && existing?.inFlight !== undefined) {
    recordApiCache(path, "deduplicated");
    return existing.inFlight as Promise<TResponse>;
  }

  const entry: CacheEntry = existing ?? {
    cacheKey,
    value: undefined,
    updatedAt: 0,
    inFlight: null
  };
  entry.inFlight = hydrateOrRefresh<TResponse>(path, entry, options.onBackgroundUpdate);
  responseCache.set(cacheKey, entry);
  return entry.inFlight as Promise<TResponse>;
}

export async function invalidateApiCacheForMutation(path: string): Promise<void> {
  const normalized = path.split("?")[0] ?? path;
  const businessRoot = normalized.match(/^(\/businesses\/[^/]+)/)?.[1];
  const businessResource = normalized.match(/^(\/businesses\/[^/]+\/[^/]+)/)?.[1];
  const modelSelectionChanged =
    normalized.endsWith("/agent-model") || normalized.endsWith("/ai-model");
  // /api/agents/{agentId} mutations (model activation, removal, ...) live under a different path
  // prefix than /businesses/{businessId}, but agentId and businessId are the same ID in this system
  // (AgentModelPanel's canonicalRuntimeAgentId is business.id) - without this, activating or
  // removing a backend model left the model-binding and runtime/effective GETs serving their
  // pre-mutation cached response for up to staleTimeMs, so the UI silently reverted to the old
  // binding right after a successful activation/removal.
  const agentId = normalized.match(/^\/api\/agents\/([^/]+)/)?.[1];

  for (const key of responseCache.keys()) {
    const path = key.slice(key.indexOf("\0") + 1);
    const cachePath = path.split("?")[0] ?? path;
    const invalid =
      cachePath === normalized ||
      (businessRoot !== undefined && cachePath.startsWith(`${businessRoot}/`)) ||
      (businessResource !== undefined && cachePath.startsWith(businessResource)) ||
      (modelSelectionChanged &&
        businessRoot !== undefined &&
        (cachePath === `${businessRoot}/agent-model` ||
          cachePath === `${businessRoot}/ai-model` ||
          cachePath === `${businessRoot}/agent-profile`)) ||
      (agentId !== undefined &&
        (cachePath.startsWith(`/api/agents/${agentId}/`) ||
          cachePath.startsWith(`/businesses/${agentId}/`))) ||
      (normalized.startsWith("/v1/messages") && cachePath.startsWith("/v1/conversations")) ||
      (normalized.startsWith("/v1/conversations") && cachePath.startsWith("/v1/conversations")) ||
      (normalized.startsWith("/auth/") && cachePath.startsWith("/auth/")) ||
      // A phonebook sync or a connection change alters the whole network graph.
      (normalized.startsWith("/network/") &&
        (cachePath === "/network" || cachePath.startsWith("/network/")));

    if (invalid) responseCache.delete(key);
  }

  try {
    const policy = persistentPolicy(normalized);
    if (businessRoot !== undefined) {
      const businessId = businessRoot.slice("/businesses/".length);
      await createLocalDataRepository("workspace", `business:${businessId}`).clearForLogout();
    } else if (policy !== null) {
      await createLocalDataRepository(policy.domain, policy.scope).invalidate();
    } else if (
      normalized.startsWith("/v1/messages") ||
      normalized.startsWith("/v1/conversations")
    ) {
      await createLocalDataRepository("conversation", "account").invalidate();
    }
  } catch {
    // The server mutation already succeeded. A browser cache failure must not report it as failed.
  }

  for (const listener of mutationListeners) {
    try {
      listener(normalized);
    } catch {
      // Keep one mounted surface from preventing the rest from receiving the mutation.
    }
  }
}

export function subscribeToApiMutations(listener: (path: string) => void): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function clearApiRequestCache(): void {
  responseCache.clear();
}

export async function clearPersistentApiRequestCache(): Promise<void> {
  responseCache.clear();
  await clearAllLocalData();
}

async function hydrateOrRefresh<TResponse>(
  path: string,
  entry: CacheEntry,
  onBackgroundUpdate?: (value: TResponse) => void
): Promise<TResponse> {
  const persistent = persistentRepository<TResponse>(path);
  if (persistent !== null) {
    const cached = await persistent.readCached(path);
    requireCurrentCacheScope(entry);
    if (cached.value !== null) {
      entry.value = cached.value;
      entry.updatedAt = cached.updatedAt ?? Date.now();
      entry.inFlight = refresh(path, entry, onBackgroundUpdate, persistent);
      void entry.inFlight.catch(() => undefined);
      recordApiCache(path, "stale");
      return cached.value;
    }
  }
  return refresh(path, entry, onBackgroundUpdate, persistent);
}

function refresh<TResponse>(
  path: string,
  entry: CacheEntry,
  onBackgroundUpdate?: (value: TResponse) => void,
  persistent = persistentRepository<TResponse>(path)
): Promise<TResponse> {
  return apiFetch<TResponse>(path)
    .then(async (value) => {
      requireCurrentCacheScope(entry);
      entry.value = value;
      entry.updatedAt = Date.now();
      await persistent?.writeCached(path, value);
      onBackgroundUpdate?.(value);
      return value;
    })
    .catch((error) => {
      if (entry.updatedAt === 0) responseCache.delete(entry.cacheKey);
      throw error;
    })
    .finally(() => {
      entry.inFlight = null;
    });
}

function persistentRepository<T>(path: string) {
  const policy = persistentPolicy(path);
  return policy === null ? null : createLocalDataRepository<T>(policy.domain, policy.scope);
}

function persistentPolicy(path: string): { domain: LocalDataDomain; scope: string } | null {
  const pathname = path.split("?")[0] ?? path;
  const business = pathname.match(/^\/businesses\/([^/]+)\/(.+)$/);
  if (business !== null) {
    const scope = `business:${business[1]}`;
    const resource = business[2] ?? "";
    if (/^(?:products|suppliers|customers|invoices)(?:\/|$)/.test(resource)) {
      return {
        domain: resource.startsWith("products") ? "catalogue" : "shop",
        scope
      };
    }
    if (
      /^(?:reports|knowledge|notifications|payments|payment-summaries|customer-debts|imports|logistics|offline-cache|sync-queue)(?:\/|$)/.test(
        resource
      )
    ) {
      return { domain: resource.includes("sync") ? "sync" : "workspace", scope };
    }
    if (/^(?:agent-model|ai-model|agent-profile)(?:\/|$)/.test(resource)) {
      return { domain: "model", scope };
    }
  }
  const accountId = readCachedAuthSession()?.account.id;
  // Old unscoped records are deliberately not hydrated into an account's private inbox.
  if (pathname === "/network")
    return accountId ? { domain: "workspace", scope: `account:${accountId}` } : null;
  if (pathname === "/v1/conversations")
    return accountId ? { domain: "conversation", scope: `account:${accountId}` } : null;
  return null;
}

function staleTimeForPath(path: string): number {
  if (/\/(?:ai-models|agent-profile|product-fields)(?:[/?]|$)/.test(path)) {
    return 5 * 60_000;
  }
  if (/\/(?:reports|notifications|conversations|runtime)(?:[/?]|$)/.test(path)) {
    return 15_000;
  }
  return defaultStaleTimeMs;
}
