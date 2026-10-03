import { shopHubCopy } from "./shop-hub-copy";
import type { GrogoniMode } from "./app-shell";

// Pulled out of ChatSurface to keep it under the modularity budget
// (scripts/check-boundaries.mjs).
export type WorkspaceCardView =
  | "cards"
  | "catalogue"
  | "addProduct"
  | "editProduct"
  | "deleteProduct"
  | "manageFields"
  | "networkSync"
  | "storefrontPreview"
  | "businessDashboard";

export function workspaceModuleClassName(view: WorkspaceCardView, mode: GrogoniMode): string {
  if (view === "businessDashboard") return "merchant-dashboard-module";
  return mode === "seller" ? "sell-module" : "buy-module";
}

export function workspacePanelTitle(view: WorkspaceCardView): string {
  if (view === "cards") {
    return shopHubCopy().title;
  }

  if (view === "businessDashboard") {
    return "Business workspace";
  }

  if (view === "networkSync") {
    return "My Network";
  }

  if (view === "storefrontPreview") {
    return "Public shop view";
  }

  return "Catalogue";
}
