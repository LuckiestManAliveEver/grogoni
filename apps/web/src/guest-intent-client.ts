import {
  guestIntentLimits,
  parseGuestIntentResponse,
  type GuestIntent
} from "@grogoni/shared-types";
import { apiCloudFetch } from "./lib/api";
import { isExplicitOfflineMode } from "./offline-runtime";
import {
  guestRouteForIntent,
  routeGuestMessage,
  type GuestRoute
} from "./marketplace-search-reply";

/**
 * How a guest's message is routed: the model-based classifier on the API (POST /v1/guest/intent,
 * services/api/src/guest-intent/README.md) when it answers in time, the rules in
 * marketplace-search-reply.ts otherwise. The guest never waits longer than the budget and never
 * sees a classifier failure: offline, a timeout, a network error, any non-2xx answer, or a body
 * that fails validation all route by rules, silently.
 */
export const guestIntentBudgetMs = 3_000;

export type GuestRouteSource = "model" | "cache" | "rules";

export interface ClassifiedGuestRoute {
  route: GuestRoute;
  source: GuestRouteSource;
  /** Why the rules answered: offline, timeout, error, invalid, too_long. Null otherwise. */
  fallback: string | null;
}

/** Recent model answers, so "hi" or "sugar" sent again does not wait on the model twice. */
const cache = new Map<string, { intent: GuestIntent; query: string | null }>();
const cacheLimit = 100;

export function clearGuestIntentCache() {
  cache.clear();
}

const cacheKey = (message: string) => message.trim().replace(/\s+/gu, " ").toLowerCase();

const offline = () =>
  isExplicitOfflineMode() || (typeof navigator !== "undefined" && navigator.onLine === false);

/** Resolves to null once the budget passes, whatever the request is doing. */
function withinBudget<T>(work: (signal: AbortSignal) => Promise<T>, budgetMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, budgetMs);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

export async function classifyGuestMessage(
  message: string,
  options: { budgetMs?: number } = {}
): Promise<ClassifiedGuestRoute> {
  const rules = (fallback: string): ClassifiedGuestRoute => ({
    route: routeGuestMessage(message),
    source: "rules",
    fallback
  });
  const text = message.trim();
  // Nothing to judge (empty, emoji, punctuation) or too long to send: the rules answer at once.
  if (!/[\p{L}\p{N}]/u.test(text)) return rules("no_text");
  if (text.length > guestIntentLimits.maxMessageChars) return rules("too_long");
  const cached = cache.get(cacheKey(text));
  if (cached !== undefined)
    return {
      route: guestRouteForIntent(cached.intent, cached.query),
      source: "cache",
      fallback: null
    };
  if (offline()) return rules("offline");
  let answer: unknown;
  try {
    answer = await withinBudget(
      (signal) =>
        apiCloudFetch<unknown>("/v1/guest/intent", {
          method: "POST",
          body: { message: text },
          signal,
          timeoutMs: options.budgetMs ?? guestIntentBudgetMs,
          // A refresh and retry would not fit the budget; a 401 just means "use the rules".
          skipAuthRefresh: true
        }),
      options.budgetMs ?? guestIntentBudgetMs
    );
  } catch {
    return rules("error");
  }
  if (answer === null) return rules("timeout");
  const classified = parseGuestIntentResponse(answer, text);
  if (classified === null) return rules("invalid");
  if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey(text), { intent: classified.intent, query: classified.query });
  return {
    route: guestRouteForIntent(classified.intent, classified.query),
    source: "model",
    fallback: null
  };
}
