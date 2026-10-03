import type {
  RuntimeRegistryContext,
  RuntimeRegistryProviderId,
  RuntimeRegistrySearchItem,
  RuntimeRegistrySearchQuery,
  RuntimeRegistrySearchResult
} from "@grogoni/shared-types";
import type { RuntimeRegistryAdapter } from "./types.js";

export interface RuntimeRegistrySearchServiceDeps {
  adapters: Partial<Record<RuntimeRegistryProviderId, RuntimeRegistryAdapter>>;
  now?: () => number;
  cacheTtlMs?: number;
}

export interface RuntimeRegistrySearchService {
  search(
    query: RuntimeRegistrySearchQuery,
    context: RuntimeRegistryContext
  ): Promise<RuntimeRegistrySearchResult>;
}

const minimumQueryLength = 2;
const defaultLimit = 20;
const maxLimit = 50;
const defaultCacheTtlMs = 60_000;

interface CachedSearch {
  expiresAt: number;
  result: RuntimeRegistrySearchResult;
}

/**
 * Fans a unified search out to every requested provider concurrently, isolates per-provider
 * failures, enforces minimum query length + bounded result counts, and caches short-lived results
 * with a cache key that never lets one account's connected-search results leak into another
 * account's results or into the public (unconnected) cache -- see buildCacheKey below.
 */
export function createRuntimeRegistrySearchService(
  deps: RuntimeRegistrySearchServiceDeps
): RuntimeRegistrySearchService {
  const now = deps.now ?? Date.now;
  const cacheTtlMs = deps.cacheTtlMs ?? defaultCacheTtlMs;
  const cache = new Map<string, CachedSearch>();

  return {
    async search(query, context) {
      const trimmedQuery = query.query.trim();
      if (trimmedQuery.length < minimumQueryLength) {
        return { items: [], providers: {} };
      }
      const limit = clamp(query.limit ?? defaultLimit, 1, maxLimit);
      const requestedProviders = query.providers ?? allProviderIds(deps.adapters);
      const providerIds = requestedProviders.filter(
        (providerId) => deps.adapters[providerId] !== undefined
      );
      const normalizedQuery: RuntimeRegistrySearchQuery = {
        ...query,
        query: trimmedQuery,
        limit
      };

      const cacheKey = buildCacheKey(normalizedQuery, providerIds, context);
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now()) {
        return cloneResult(cached.result);
      }

      const outcomes = await Promise.allSettled(
        providerIds.map(async (providerId) => {
          const adapter = deps.adapters[providerId]!;
          const items = await adapter.search(normalizedQuery, context);
          return { providerId, items };
        })
      );

      const items: RuntimeRegistrySearchItem[] = [];
      const providers: RuntimeRegistrySearchResult["providers"] = {};
      outcomes.forEach((outcome, index) => {
        const providerId = providerIds[index]!;
        if (outcome.status === "fulfilled") {
          providers[providerId] = { status: "ok" };
          items.push(...outcome.value.items);
        } else {
          providers[providerId] = {
            status: "error",
            errorMessage: describeError(outcome.reason)
          };
        }
      });

      // Underlying provider catalogs (github-model-catalog.ts, huggingface-model-catalog.ts,
      // github-agent-catalog.ts, huggingface-agent-catalog.ts) do not yet implement pagination, so
      // there is no next-page cursor to hand back today; `cursor` is still accepted on the request
      // and threaded through to each adapter so a future paginated provider can act on it without
      // an API shape change here.
      const result: RuntimeRegistrySearchResult = { items: items.slice(0, limit), providers };
      cache.set(cacheKey, { expiresAt: now() + cacheTtlMs, result });
      return cloneResult(result);
    }
  };
}

function allProviderIds(
  adapters: Partial<Record<RuntimeRegistryProviderId, RuntimeRegistryAdapter>>
): RuntimeRegistryProviderId[] {
  return Object.keys(adapters) as RuntimeRegistryProviderId[];
}

/** The isolation boundary the caller depends on: `context.connected ? accountId : "public"` is
 *  always part of the key, so a connected account's results are never served back to a different
 *  account, and never leak into the shared public (unconnected) cache bucket. */
function buildCacheKey(
  query: RuntimeRegistrySearchQuery,
  providerIds: RuntimeRegistryProviderId[],
  context: RuntimeRegistryContext
): string {
  return JSON.stringify({
    query: query.query.toLowerCase(),
    kinds: [...(query.kinds ?? [])].sort(),
    providers: [...providerIds].sort(),
    cursor: query.cursor ?? null,
    limit: query.limit ?? null,
    scope: context.connected ? `account:${context.accountId}` : "public"
  });
}

function cloneResult(result: RuntimeRegistrySearchResult): RuntimeRegistrySearchResult {
  return {
    items: result.items.map((item) => ({ ...item, compatibility: { ...item.compatibility } })),
    providers: { ...result.providers },
    ...(result.cursor === undefined ? {} : { cursor: result.cursor })
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function describeError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "Provider search failed.";
}
