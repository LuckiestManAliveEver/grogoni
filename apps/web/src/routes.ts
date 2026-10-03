import type { ShellView, GrogoniMode } from "./app-shell";

function routeId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("A route identifier is required.");
  }
  return encodeURIComponent(normalized);
}

export const routes = {
  home: "/",
  chat: "/chat",
  marketplace: "/marketplace",
  sell: "/sell",
  // The owner's Shop Hub. Deliberately under /sell: /shop/:id is a public storefront alias
  // (AppRouter's readStorefrontRoute) and /s/:slug is the API's universal short link.
  shopHub: "/sell/shop",
  workspace: "/workspace",
  conversation: (conversationId: string, mode: GrogoniMode = "marketplace") =>
    `${mode === "seller" ? "/workspace" : routes.marketplace}/conversations/${routeId(conversationId)}`,
  catalogue: "/catalogue",
  product: (productId: string) => `/products/${routeId(productId)}`,
  shop: (shopId: string) => `/shops/${routeId(shopId)}`,
  publicAgent: (agentId: string) => `/agent/${routeId(agentId)}`,
  storefrontProduct: (agentId: string, productId: string) =>
    `/agent/${routeId(agentId)}/products/${routeId(productId)}`,
  agent: (agentId: string) => `/agents/${routeId(agentId)}`,
  customers: "/customers",
  suppliers: "/suppliers",
  pos: "/pos",
  invoices: "/invoices",
  network: "/network",
  sync: "/sync",
  runtime: "/runtime",
  payments: "/payments",
  receipts: "/receipts",
  logistics: "/logistics",
  compliance: "/settings/security",
  beta: "/beta",
  launch: "/launch",
  reports: "/reports",
  notifications: "/notifications",
  settings: "/settings",
  signup: "/signup",
  login: "/login",
  accountDeletion: "/account-deletion",
  terms: "/terms",
  privacy: "/privacy",
  oauthCallback: "/auth/oauth/callback"
} as const;

export type AuthenticationRouteTarget = "login" | "signup";

export function authenticationRoute(target: AuthenticationRouteTarget): string {
  return target === "signup" ? routes.signup : routes.login;
}

export function readAuthenticationRoutePath(pathname: string): AuthenticationRouteTarget | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === routes.signup) return "signup";
  if (path === routes.login) return "login";
  return null;
}

export function readAuthenticationRouteHash(hash: string): AuthenticationRouteTarget | null {
  const target = hash.replace(/^#/, "").trim().toLowerCase();
  return target === "login" || target === "signup" ? target : null;
}

const viewPaths: Partial<Record<ShellView, string>> = {
  home: routes.home,
  chat: routes.chat,
  agent: routes.settings,
  products: routes.catalogue,
  suppliers: routes.suppliers,
  customers: routes.customers,
  pos: routes.pos,
  invoices: routes.invoices,
  network: routes.network,
  sync: routes.sync,
  runtime: routes.runtime,
  payments: routes.payments,
  imports: routes.receipts,
  logistics: routes.logistics,
  compliance: routes.compliance,
  beta: routes.beta,
  launch: routes.launch,
  reports: routes.reports,
  notifications: routes.notifications
};

export interface OwnerRoute {
  mode: GrogoniMode;
  view: ShellView;
  conversationId?: string;
  productId?: string;
  agentId?: string;
  /** An owner panel opened over the view; only the Shop Hub is routable today. */
  panel?: "shop-hub";
}

export function pathForOwnerView(view: ShellView, mode: GrogoniMode): string {
  if (view === "chat") {
    return mode === "seller" ? routes.sell : routes.marketplace;
  }
  return viewPaths[view] ?? routes.chat;
}

export function pathForOwnerRoute(route: OwnerRoute): string {
  if (route.conversationId !== undefined) {
    return routes.conversation(route.conversationId, route.mode);
  }
  if (route.productId !== undefined) {
    return routes.product(route.productId);
  }
  if (route.agentId !== undefined) {
    return routes.agent(route.agentId);
  }
  if (route.panel === "shop-hub") {
    return routes.shopHub;
  }
  return pathForOwnerView(route.view, route.mode);
}

export function readOwnerRoute(pathname: string): OwnerRoute | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === routes.home || path === routes.chat || path === routes.marketplace) {
    return { mode: "marketplace", view: "chat" };
  }
  if (path === routes.sell || path === routes.workspace) {
    return { mode: "seller", view: "chat" };
  }
  if (path === routes.shopHub) {
    return { mode: "seller", view: "chat", panel: "shop-hub" };
  }

  const conversationMatch = path.match(/^\/(marketplace|workspace|sell)\/conversations\/([^/]+)$/);
  if (conversationMatch !== null) {
    const conversationId = readRouteId(conversationMatch[2]);
    if (conversationId === null) return null;
    return {
      mode: conversationMatch[1] === "marketplace" ? "marketplace" : "seller",
      view: "chat",
      conversationId
    };
  }

  const legacyConversationMatch = path.match(/^\/conversations\/([^/]+)$/);
  if (legacyConversationMatch !== null) {
    const conversationId = readRouteId(legacyConversationMatch[1]);
    return conversationId === null ? null : { mode: "marketplace", view: "chat", conversationId };
  }

  const view = (Object.entries(viewPaths) as Array<[ShellView, string]>).find(
    ([, route]) => route === path
  )?.[0];
  if (view !== undefined) return { mode: "seller", view };

  const productMatch = path.match(/^\/products\/([^/]+)$/);
  if (productMatch !== null) {
    const productId = readRouteId(productMatch[1]);
    return productId === null ? null : { mode: "seller", view: "products", productId };
  }

  const agentMatch = path.match(/^\/agents\/([^/]+)$/);
  if (agentMatch !== null) {
    const agentId = readRouteId(agentMatch[1]);
    return agentId === null ? null : { mode: "seller", view: "agent", agentId };
  }
  return null;
}

function readRouteId(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}
