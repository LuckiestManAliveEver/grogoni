import { readAuthenticationRoutePath, readOwnerRoute, routes } from "./routes";

// Pure path matching for AppRouter, kept free of side effects so the router can decide what to
// download before React renders, and so it can be tested without loading the router.

export interface StorefrontRoute {
  agentId: string;
  productId: string | null;
}

/** A public storefront path (/agent/:id[/products/:id], or the /shop|/shops|/soko/:id aliases). */
export function matchStorefrontRoute(pathname: string): StorefrontRoute | null {
  const match =
    pathname.match(/^\/agent\/([^/]+)(?:\/products\/([^/]+))?\/?$/) ??
    pathname.match(/^\/(?:shop|shops|soko)\/([^/]+)\/?$/);

  if (match === null) return null;

  let agentId: string;
  try {
    agentId = decodeURIComponent((match[1] ?? "").replace(/^\//, "")).trim();
  } catch {
    return null;
  }

  if (agentId.length === 0) return null;

  let productId: string | null = null;
  if (match[2] !== undefined) {
    try {
      productId = decodeURIComponent(match[2]).trim() || null;
    } catch {
      return null;
    }
  }

  return { agentId, productId };
}

/**
 * Whether to start downloading the owner app before React renders. Never for a public
 * storefront: a visitor chatting with a shop must not download the owner app. Other paths under
 * the storefront prefixes fall through to the owner app, so they still warm it.
 */
export function shouldWarmOwnerRoute(pathname: string): boolean {
  if (matchStorefrontRoute(pathname) !== null) return false;
  return (
    readOwnerRoute(pathname) !== null ||
    readAuthenticationRoutePath(pathname) !== null ||
    pathname === routes.oauthCallback ||
    /^\/(?:agent|shop|shops|soko)\//u.test(pathname)
  );
}
