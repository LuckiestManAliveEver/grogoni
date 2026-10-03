import type { ShopModuleId } from "@grogoni/tool-core";

import type { ShellView } from "./app-shell";
import type { ShopHubSurfaceLabel } from "./shop-hub-copy";

/** Workspace-drawer sub-views a surface can open in place, without leaving the drawer. */
export type ShopHubWorkspaceView =
  "catalogue" | "networkSync" | "businessDashboard" | "storefrontPreview";

export type ShopHubSurface =
  | { kind: "workspace"; view: ShopHubWorkspaceView; label: ShopHubSurfaceLabel }
  | { kind: "view"; view: ShellView; label: ShopHubSurfaceLabel };

/**
 * Where each registry module opens in the app. This maps module ids (from the API) to existing
 * screens only - which modules exist, what they are called and which tools they hold all come from
 * GET /businesses/:businessId/capabilities. A module missing here still renders; it just has no
 * "Open" button, only its agent actions. The first surface is the module's one-tap fix.
 *
 * Every navigable ShellView must appear here (tests/workspace-hub-coverage.test.ts), since the
 * hub is the only way into most domain screens.
 */
export const shopHubSurfaces: Record<ShopModuleId, readonly ShopHubSurface[]> = {
  catalog: [{ kind: "workspace", view: "catalogue", label: "catalogue" }],
  suppliers: [{ kind: "view", view: "suppliers", label: "suppliers" }],
  receipts: [{ kind: "view", view: "imports", label: "imports" }],
  orders: [
    { kind: "view", view: "invoices", label: "invoices" },
    { kind: "view", view: "pos", label: "pos" },
    { kind: "workspace", view: "businessDashboard", label: "businessDashboard" }
  ],
  customers: [{ kind: "view", view: "customers", label: "customers" }],
  network: [
    { kind: "workspace", view: "networkSync", label: "networkSync" },
    { kind: "view", view: "sync", label: "sync" }
  ],
  payments: [{ kind: "view", view: "payments", label: "payments" }],
  delivery: [{ kind: "view", view: "logistics", label: "logistics" }],
  channels: [{ kind: "view", view: "agent", label: "agent" }],
  agent: [
    { kind: "view", view: "agent", label: "agent" },
    { kind: "view", view: "runtime", label: "runtime" }
  ],
  insights: [
    { kind: "view", view: "reports", label: "reports" },
    { kind: "view", view: "notifications", label: "notifications" },
    { kind: "view", view: "compliance", label: "compliance" },
    { kind: "view", view: "launch", label: "launch" },
    { kind: "view", view: "beta", label: "beta" }
  ]
};

export function surfacesForModule(moduleId: string): readonly ShopHubSurface[] {
  return Object.prototype.hasOwnProperty.call(shopHubSurfaces, moduleId)
    ? shopHubSurfaces[moduleId as ShopModuleId]
    : [];
}
