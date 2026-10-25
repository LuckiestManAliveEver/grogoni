import type { GrogoniMode, ShellView } from "./app-shell";
import { readOwnerRoute, routes, type OwnerRoute } from "./routes";

/**
 * Where a session context restore leaves the owner (docs/frontend/frontend.md, "Deep links on
 * restore"). A cold load of a URL that names a place (/sell/shop, a conversation, a module) keeps
 * that place; the bare root restores the account's last place. Pure, so it is tested directly.
 */
export interface DeepLinkedPlace {
  /** The normalized path the app was opened at. */
  path: string;
  route: OwnerRoute;
}

export interface RestoredPlace {
  mode: GrogoniMode;
  view: ShellView;
  /** The conversation to open; undefined leaves the current one alone. */
  conversationId: string | null | undefined;
  /** Where to move the URL (replace); null keeps the URL as it is. */
  navigateTo: OwnerRoute | null;
}

// "/chat" is the old chat alias: like the root it names no mode or place of its own.
const barePaths = new Set<string>([routes.home, routes.chat]);

export function normalizeRestorePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** The place a cold-load URL names, or null for the bare root and non-owner pages. */
export function readDeepLinkedPlace(pathname: string): DeepLinkedPlace | null {
  const path = normalizeRestorePath(pathname);
  if (barePaths.has(path)) return null;
  const route = readOwnerRoute(path);
  return route === null ? null : { path, route };
}

export function resolveRestoredPlace(input: {
  deepLink: DeepLinkedPlace | null;
  currentPath: string;
  hasShop: boolean;
  last: { mode: GrogoniMode; view: ShellView; conversationId: string | null };
}): RestoredPlace {
  const { deepLink, last } = input;
  // No deep link, or the user already left it (an auth screen, a tap): the last place wins.
  if (deepLink === null || normalizeRestorePath(input.currentPath) !== deepLink.path) {
    return {
      mode: last.mode,
      view: last.view,
      conversationId: last.conversationId,
      navigateTo: {
        mode: last.mode,
        view: last.view,
        ...(last.view === "chat" && last.conversationId !== null
          ? { conversationId: last.conversationId }
          : {})
      }
    };
  }
  const route = deepLink.route;
  if (route.mode === "seller" && !input.hasShop) {
    // A seller link for an account with no shop: the Shop Hub, which offers shop setup, instead
    // of a seller screen with no shop behind it.
    return {
      mode: "seller",
      view: "chat",
      conversationId: undefined,
      navigateTo:
        route.panel === "shop-hub" ? null : { mode: "seller", view: "chat", panel: "shop-hub" }
    };
  }
  return {
    mode: route.mode,
    view: route.view,
    // A link without a conversation keeps the device's own: the URL does not name another one.
    conversationId: route.conversationId,
    navigateTo: null
  };
}
