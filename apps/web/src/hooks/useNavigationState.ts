import { useRef, useState } from "react";

import type { ChatMessage, ShellView, GrogoniMode } from "../app-shell";
import {
  navigateToBrowserUrl,
  navigateToOwnerRoute,
  readCurrentOwnerRoute,
  readGrogoniHistoryState
} from "../browser-navigation";
import { getErrorMessage } from "../chat-message-plumbing";
import { patchJson } from "../api-helpers";
import { markNavigationCommitted, startNavigationMeasurement } from "../performance";
import { authenticationRoute, pathForOwnerView } from "../routes";
import { createScreenStateCache, restoreScreenScroll } from "../screen-state-cache";
import type {
  ActiveBusiness,
  ProductSummary,
  SessionResponse,
  ShopPresenceStatus,
  ShopPresenceSummary
} from "../grogoni-application-shared";
import { guestBrowsingStorageKey } from "../grogoni-application-shared";

interface UseNavigationStateDeps {
  business: ActiveBusiness | null;
  session: SessionResponse | null;
  mode: GrogoniMode;
  setMode: (mode: GrogoniMode) => void;
  view: ShellView;
  setView: (view: ShellView) => void;
  // Marketplace is called after Navigation (Marketplace's completeMarketplaceIntro needs
  // Navigation's setIsMarketplaceShortcutOpen), so Navigation can't take isMarketplaceIntroComplete
  // as a plain dep without a TDZ error - deferred behind a getter, same reasoning as the Auth/
  // BusinessSetup/Chat setter getters below.
  getIsMarketplaceIntroComplete: () => boolean;
  preservedScreenLimit: number;
  initialMarketplaceShortcutOpen: boolean;
  initialRoutedProductId: string | null;
  populateProductForm: (product: ProductSummary) => void;
  setStatusMessage: (message: string) => void;
  setIsWorkspacePanelOpen: (open: boolean) => void;
  runAction: (key: string, action: () => Promise<void>) => Promise<void>;
  // Auth/BusinessSetup/Chat are called after Navigation (they depend on navigateToView/
  // requireMessagingSignIn at their own hook-call time), so Navigation can't take their setters as
  // plain deps without a TDZ error. Getters defer the read to when openAuth/browseAsGuest/switchMode
  // actually run (a click or an effect, always after every hook in this render has completed) - same
  // getter pattern established in Phase 9 for values, applied here to cross-domain setters instead.
  getAuthSetters: () => {
    setIsAuthOpen: (open: boolean) => void;
    setAuthenticationView: (view: "signup" | "login") => void;
    setIsAccountRestorationOpen: (open: boolean) => void;
  };
  getBusinessSetupSetters: () => {
    setIsBusinessSetupOpen: (open: boolean) => void;
    setBusinessSetupStep: (step: "phone" | "details") => void;
  };
  getChatSetters: () => {
    setIsMessagingInboxOpen: (open: boolean) => void;
    setChatMessages: (messages: (current: ChatMessage[]) => ChatMessage[]) => void;
  };
  // Same getter reasoning as Auth/BusinessSetup/Chat above: Auth (continueToGrogoni's owner) is
  // called after Navigation, so browseAsGuest can't take continueToGrogoni as a plain dep.
  getContinueToGrogoni: () => () => Promise<SessionResponse | null>;
  registerReset: (domainKey: string, fn: () => void) => void;
}

export function useNavigationState(deps: UseNavigationStateDeps) {
  const screenStateCacheRef = useRef(createScreenStateCache(deps.preservedScreenLimit));
  const activeViewRef = useRef(deps.view);
  activeViewRef.current = deps.view;
  const [isMarketplaceShortcutOpen, setIsMarketplaceShortcutOpen] = useState(
    deps.initialMarketplaceShortcutOpen
  );
  const [shopPresenceStatus, setShopPresenceStatus] = useState<ShopPresenceStatus>("online");
  const [routedProductId, setRoutedProductId] = useState<string | null>(
    deps.initialRoutedProductId
  );

  const {
    business,
    session,
    mode,
    setMode,
    setView,
    populateProductForm,
    setStatusMessage,
    setIsWorkspacePanelOpen,
    runAction
  } = deps;

  function navigateToView(
    nextView: ShellView,
    options?: { replace?: boolean; mode?: GrogoniMode }
  ) {
    const nextMode = options?.mode ?? mode;
    const nextPath = pathForOwnerView(nextView, nextMode);
    const measurement = startNavigationMeasurement(nextPath);
    screenStateCacheRef.current.write(activeViewRef.current, {
      scrollX: window.scrollX,
      scrollY: window.scrollY
    });
    setMode(nextMode);
    setView(nextView);
    setRoutedProductId(null);
    setIsMarketplaceShortcutOpen(false);
    if (nextView !== "chat" && nextView !== "home") {
      markNavigationCommitted(measurement);
      return;
    }
    const nextRoute = { mode: nextMode, view: nextView };
    navigateToOwnerRoute(nextRoute, { replace: options?.replace });
    markNavigationCommitted(measurement);
    restoreScreenScroll(screenStateCacheRef.current, nextView);
  }

  function openProduct(product: ProductSummary) {
    populateProductForm(product);
    setMode("seller");
    setView("products");
    setRoutedProductId(product.id);
    setIsMarketplaceShortcutOpen(false);
  }

  function openAgentProfile() {
    if (business === null) return;
    setMode("seller");
    setView("agent");
    setIsMarketplaceShortcutOpen(false);
  }

  function returnToChat() {
    const currentState = readGrogoniHistoryState(window.history.state);
    const deepLinkedModule =
      currentState !== null && currentState.view !== "chat" && currentState.view !== "home";
    setView("chat");
    setRoutedProductId(null);
    setIsWorkspacePanelOpen(false);
    if (deepLinkedModule) {
      navigateToOwnerRoute({ mode, view: "chat" }, { replace: true });
    }
  }

  function requireMessagingSignIn() {
    openAuth();
    setStatusMessage("Sign in to send end-to-end encrypted messages.");
  }

  function openAuth(intent: "signup" | "login" = "login") {
    const { setIsBusinessSetupOpen } = deps.getBusinessSetupSetters();
    const { setIsAuthOpen, setAuthenticationView } = deps.getAuthSetters();
    sessionStorage.removeItem(guestBrowsingStorageKey);
    setIsBusinessSetupOpen(false);
    setIsAuthOpen(true);
    setAuthenticationView(intent);
    setStatusMessage(
      intent === "signup" ? "Create your Grogoni account." : "Log in to your account."
    );
    navigateToBrowserUrl(authenticationRoute(intent), { state: window.history.state });
  }

  function browseAsGuest() {
    const { setIsAuthOpen, setIsAccountRestorationOpen } = deps.getAuthSetters();
    const { setIsBusinessSetupOpen } = deps.getBusinessSetupSetters();
    const { setIsMessagingInboxOpen } = deps.getChatSetters();
    sessionStorage.setItem(guestBrowsingStorageKey, "true");
    setIsAuthOpen(false);
    setIsBusinessSetupOpen(false);
    setIsAccountRestorationOpen(false);
    setIsMessagingInboxOpen(false);
    setMode("marketplace");
    setView("chat");
    // Not setIsMarketplaceShortcutOpen(true): that panel is a modal (StackedModule) that makes the
    // rest of the shell inert, including the chat welcome message's own Log in button - trapping a
    // guest who just chose "Browse as guest" behind an unrequested panel instead of landing them on
    // the plain chat home, same as any other non-deliberate arrival at marketplace mode.
    navigateToOwnerRoute({ mode: "marketplace", view: "chat" }, { replace: true });
    setStatusMessage("Browsing as a guest.");
    // "Guest" only means skipping the signup form here, not going without Grogoni's own zero-form
    // entry (docs/authentication/progressive-identity.md) - continueToGrogoni gives this browser the
    // same real, cookie-backed device account cold boot already gets everyone else, so messaging
    // works immediately instead of hitting a sign-in wall the moment a guest tries to use it.
    void deps.getContinueToGrogoni()();
  }

  function switchMode(nextMode: GrogoniMode) {
    const { setIsBusinessSetupOpen, setBusinessSetupStep } = deps.getBusinessSetupSetters();

    if (nextMode === "seller" && business === null) {
      if (session === null) {
        // A shop needs an account, so the shop icon (or the menu's "Set up your shop") goes
        // straight to signup; the signup screen links to login. The home welcome has no auth
        // buttons since #41, so this used to point at a button that no longer existed.
        openAuth("signup");
        return;
      }

      setBusinessSetupStep(
        typeof session.user.phoneNumberE164 === "string" && session.user.phoneNumberE164.length > 0
          ? "details"
          : "phone"
      );
      setIsBusinessSetupOpen(true);
      setStatusMessage(
        session.user.phoneNumberE164
          ? "Set up your business to start selling."
          : "Add your phone number to register your first shop."
      );
      return;
    }

    if (nextMode === mode) {
      return;
    }

    const { setChatMessages } = deps.getChatSetters();
    const nextPath = pathForOwnerView("chat", nextMode);
    const measurement = startNavigationMeasurement(nextPath);
    setMode(nextMode);
    navigateToOwnerRoute({ mode: nextMode, view: "chat" });
    setIsMarketplaceShortcutOpen(
      nextMode === "marketplace" && deps.getIsMarketplaceIntroComplete()
    );
    setView("chat");
    setIsWorkspacePanelOpen(false);
    markNavigationCommitted(measurement);
    setChatMessages((messages) => [
      ...messages,
      {
        id: `mode-${nextMode}-${Date.now()}`,
        author: "grogoniclaw",
        body:
          nextMode === "seller"
            ? `Seller controls are ready for ${business?.name ?? "your shop"}. You can use a card below or tell me what to change.`
            : "Marketplace mode restored. Tell me what you want to find, or explore a storefront below."
      }
    ]);
  }

  /** "Go to my shop": the Shop Hub at /sell/shop, over seller chat. Back closes it again. */
  function openShopHub() {
    if (business === null) {
      switchMode("seller");
      return;
    }
    navigateToOwnerRoute({ mode: "seller", view: "chat", panel: "shop-hub" });
    setIsWorkspacePanelOpen(true);
  }

  function closeShopHub() {
    setIsWorkspacePanelOpen(false);
    if (readCurrentOwnerRoute()?.panel === "shop-hub") {
      navigateToOwnerRoute({ mode: "seller", view: "chat" }, { replace: true });
    }
  }

  function updateShopPresenceStatus(nextStatus: ShopPresenceStatus) {
    if (business === null) return;

    void runAction("presence-update", async () => {
      try {
        const presence = await patchJson<ShopPresenceSummary>(
          `/businesses/${business.id}/presence`,
          { status: nextStatus }
        );
        setShopPresenceStatus(presence.status);
        setStatusMessage(`Shop status set to ${presence.status} across devices`);
      } catch (error) {
        setStatusMessage(getErrorMessage(error));
      }
    });
  }

  deps.registerReset("navigation", () => {
    setIsMarketplaceShortcutOpen(false);
    setShopPresenceStatus("online");
    setRoutedProductId(null);
  });

  return {
    isMarketplaceShortcutOpen,
    setIsMarketplaceShortcutOpen,
    shopPresenceStatus,
    setShopPresenceStatus,
    routedProductId,
    setRoutedProductId,
    screenStateCacheRef,
    navigateToView,
    openProduct,
    openAgentProfile,
    returnToChat,
    requireMessagingSignIn,
    openAuth,
    browseAsGuest,
    switchMode,
    openShopHub,
    closeShopHub,
    updateShopPresenceStatus
  };
}
