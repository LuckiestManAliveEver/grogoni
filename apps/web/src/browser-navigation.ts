import { pathForOwnerRoute, readOwnerRoute, type OwnerRoute } from "./routes";

const navigationEventName = "grogoni:navigation";
const historyStateVersion = 1;

export interface GrogoniHistoryState {
  grogoni: true;
  version: typeof historyStateVersion;
  key: string;
  depth: number;
  mode: OwnerRoute["mode"];
  view: OwnerRoute["view"];
  conversationId?: string;
  productId?: string;
  agentId?: string;
  scrollX: number;
  scrollY: number;
}

export interface OwnerNavigationOptions {
  replace?: boolean | undefined;
}

export function initializeOwnerHistory(route: OwnerRoute): GrogoniHistoryState {
  const existing = readGrogoniHistoryState(window.history.state);
  const state = createHistoryState(route, {
    key: existing?.key,
    depth: existing?.depth ?? 0
  });
  window.history.replaceState(state, "", currentRelativeUrl());
  return state;
}

export function navigateToOwnerRoute(
  route: OwnerRoute,
  options: OwnerNavigationOptions = {}
): boolean {
  saveCurrentScroll();
  const nextUrl = pathForOwnerRoute(route);
  const existing = readGrogoniHistoryState(window.history.state);
  const sameUrl = currentRelativeUrl() === nextUrl;
  const replace = options.replace === true || sameUrl;
  const state = createHistoryState(route, {
    key: replace ? existing?.key : undefined,
    depth: replace ? (existing?.depth ?? 0) : (existing?.depth ?? 0) + 1
  });

  window.history[replace ? "replaceState" : "pushState"](state, "", nextUrl);
  if (!sameUrl || options.replace === true) {
    dispatchNavigation();
  }
  return !sameUrl;
}

export function navigateToBrowserUrl(
  target: string | URL,
  options: { replace?: boolean; state?: unknown } = {}
): boolean {
  const url = target instanceof URL ? target : new URL(target, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return true;
  }

  const ownerRoute =
    url.search.length === 0 && url.hash.length === 0 ? readOwnerRoute(url.pathname) : null;
  if (ownerRoute !== null) {
    return navigateToOwnerRoute(ownerRoute, { replace: options.replace });
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const sameUrl = currentRelativeUrl() === nextUrl;
  if (sameUrl && options.replace !== true) return false;

  const replace = options.replace === true || sameUrl;
  window.history[options.replace === true || sameUrl ? "replaceState" : "pushState"](
    "state" in options ? options.state : replace ? window.history.state : null,
    "",
    nextUrl
  );
  dispatchNavigation();
  return true;
}

export function readCurrentOwnerRoute(): OwnerRoute | null {
  return readOwnerRoute(window.location.pathname);
}

export function readGrogoniHistoryState(value: unknown): GrogoniHistoryState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<GrogoniHistoryState>;
  if (
    candidate.grogoni !== true ||
    candidate.version !== historyStateVersion ||
    typeof candidate.key !== "string" ||
    typeof candidate.depth !== "number" ||
    (candidate.mode !== "marketplace" && candidate.mode !== "seller") ||
    typeof candidate.view !== "string"
  ) {
    return null;
  }
  return candidate as GrogoniHistoryState;
}

export function canNavigateBackWithinApp(): boolean {
  return (readGrogoniHistoryState(window.history.state)?.depth ?? 0) > 0;
}

export function subscribeToBrowserNavigation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(navigationEventName, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(navigationEventName, listener);
  };
}

export function browserLocationSnapshot(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function installBrowserLinkInterceptor(): () => void {
  function onClick(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (
      anchor.target !== "" ||
      anchor.hasAttribute("download") ||
      anchor.getAttribute("rel")?.split(/\s+/).includes("external")
    ) {
      return;
    }

    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigateToBrowserUrl(url);
  }

  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

function createHistoryState(
  route: OwnerRoute,
  options: { key?: string | undefined; depth: number }
): GrogoniHistoryState {
  return {
    grogoni: true,
    version: historyStateVersion,
    key: options.key ?? createNavigationKey(),
    depth: Math.max(0, options.depth),
    mode: route.mode,
    view: route.view,
    ...(route.conversationId === undefined ? {} : { conversationId: route.conversationId }),
    ...(route.productId === undefined ? {} : { productId: route.productId }),
    ...(route.agentId === undefined ? {} : { agentId: route.agentId }),
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

function saveCurrentScroll() {
  const state = readGrogoniHistoryState(window.history.state);
  if (state === null) return;
  window.history.replaceState(
    { ...state, scrollX: window.scrollX, scrollY: window.scrollY },
    "",
    currentRelativeUrl()
  );
}

function currentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function dispatchNavigation() {
  window.dispatchEvent(new Event(navigationEventName));
}

function createNavigationKey(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `navigation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
