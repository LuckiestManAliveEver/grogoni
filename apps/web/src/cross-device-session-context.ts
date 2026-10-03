import type { GrogoniChatSurface, GrogoniMode, GrogoniSessionContext } from "@grogoni/shared-types";
import type { ShellView } from "./app-shell";
import { ApiRequestError } from "./lib/api";

export function surfaceForShellView(view: ShellView, mode: GrogoniMode): GrogoniChatSurface {
  if (mode === "marketplace") return "conversation";
  if (view === "chat") return "conversation";
  if (view === "products") return "catalogue";
  if (view === "pos" || view === "invoices" || view === "payments" || view === "logistics") {
    return "order";
  }
  if (view === "imports") return "receipt";
  return "owner-controls";
}

export function shellViewForSurface(surface: GrogoniChatSurface, mode: GrogoniMode): ShellView {
  if (mode === "marketplace") return "chat";
  if (surface === "catalogue" || surface === "product") return "products";
  if (surface === "order") return "invoices";
  if (surface === "receipt") return "imports";
  if (surface === "owner-controls") return "home";
  return "chat";
}

export interface GrogoniSessionContextPatch {
  mode?: GrogoniMode;
  activeShopId?: string | null;
  activeSurface?: GrogoniChatSurface;
  conversationId?: string;
}

// PATCH /v1/session/context uses optimistic concurrency (expectedSessionVersion):
// concurrent writers (another tab, another device, a stale in-flight request) race
// each other and the loser gets back a 409 session_context_conflict. A single retry
// is not enough - if two other writers land back to back, that lone retry's refetch
// can itself already be stale by the time its PATCH lands, producing a second 409
// (this is the "409 twice in a row" pattern seen in production logs). Retry with a
// fresh version fetched each time, up to SESSION_CONTEXT_PATCH_MAX_ATTEMPTS, before
// giving up and letting the caller know the update was dropped.
export const SESSION_CONTEXT_PATCH_MAX_ATTEMPTS = 3;

export async function applySessionContextPatchWithConflictRetry(
  patch: GrogoniSessionContextPatch,
  initialSessionVersion: number,
  deps: {
    patchContext: (body: Record<string, unknown>) => Promise<GrogoniSessionContext>;
    fetchLatestContext: () => Promise<GrogoniSessionContext>;
    onDropped?: (attempts: number) => void;
  }
): Promise<GrogoniSessionContext | null> {
  let expectedSessionVersion = initialSessionVersion;

  for (let attempt = 1; attempt <= SESSION_CONTEXT_PATCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await deps.patchContext({ ...patch, expectedSessionVersion });
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "session_context_conflict") {
        throw error;
      }
      if (attempt === SESSION_CONTEXT_PATCH_MAX_ATTEMPTS) {
        deps.onDropped?.(attempt);
        return null;
      }
      const latest = await deps.fetchLatestContext();
      expectedSessionVersion = latest.sessionVersion;
    }
  }
  return null;
}
