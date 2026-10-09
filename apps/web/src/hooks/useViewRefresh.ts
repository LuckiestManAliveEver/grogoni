import { useEffect, useRef } from "react";
import type { ShellView } from "../app-shell";
import { subscribeToApiMutations } from "../api-request-cache";
import { likelyNextOwnerViews, scheduleIdleOwnerPrefetch } from "../prefetch";

type RefreshFn = (businessId: string) => Promise<void>;

interface RefreshRegistration {
  views: readonly string[];
  fn: RefreshFn;
}

function shouldRefreshBusinessDomains(path: string, businessId: string): boolean {
  const businessMutation = path.match(/^\/businesses\/([^/]+)\/([^/]+)/);
  if (businessMutation !== null) {
    const [, mutatedBusinessId, resource] = businessMutation;
    return mutatedBusinessId === businessId && resource !== "runtime";
  }
  return (
    path === "/network" ||
    path.startsWith("/v1/oss-agents/installed") ||
    path.startsWith("/v1/model-artifacts")
  );
}

export function useBusinessViewRefresh(
  businessId: string | null,
  enabled: boolean,
  view: ShellView,
  allRefreshers: () => RefreshFn[]
) {
  const latestRefreshers = useRef(allRefreshers);
  latestRefreshers.current = allRefreshers;
  useEffect(() => {
    if (!enabled || businessId === null) return;
    let refreshTimer: number | null = null;
    const unsubscribe = subscribeToApiMutations((path) => {
      if (!shouldRefreshBusinessDomains(path, businessId) || refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void Promise.allSettled(latestRefreshers.current().map((refresh) => refresh(businessId)));
      }, 50);
    });
    return () => {
      unsubscribe();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [businessId, enabled]);
  useEffect(() => {
    if (!enabled || businessId === null) return;
    const likelyViews = likelyNextOwnerViews(view);
    if (likelyViews.length === 0) return;
    return scheduleIdleOwnerPrefetch(likelyViews, businessId);
  }, [businessId, enabled, view]);
}

export function useViewRefreshRegistry() {
  // Keyed by domain, not appended as a list - registerRefresh is called on every render (so each
  // domain hook's `fn` always closes over its latest deps), and a plain array push would grow
  // unboundedly across renders instead of replacing the previous registration.
  const registry = useRef(new Map<string, RefreshRegistration>());

  function registerRefresh(domainKey: string, views: readonly string[], fn: RefreshFn) {
    registry.current.set(domainKey, { views, fn });
  }

  function refreshersFor(view: string): RefreshFn[] {
    const matches: RefreshFn[] = [];
    for (const registration of registry.current.values()) {
      if (registration.views.includes(view)) matches.push(registration.fn);
    }
    return matches;
  }

  function allRefreshers(): RefreshFn[] {
    return [...registry.current.values()].map((registration) => registration.fn);
  }

  return { allRefreshers, registerRefresh, refreshersFor };
}
