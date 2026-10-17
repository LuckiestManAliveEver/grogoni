import { useEffect, useRef, useState } from "react";

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
  /**
   * Whether this sign-in's session context (the account's shops) has loaded, and a way to retry
   * it. Until it loads, "no business" may only mean "not loaded yet", never "has no shop".
   */
  getSessionContextLoad: () => { loaded: boolean; retry: () => void };
  /** The same "loaded" as a render value, so a Sell tap waiting on the load can finish. */
  sessionContextLoaded: boolean;
  registerReset: (domainKey: string, fn: () => void) => void;
}

/** How long a Sell tap waits for the account's shops before it is dropped. */
const sellTapLifetimeMs = 60_000;

export function useNavigationState(deps: UseNavigationStateDeps) {
  const screenStateCacheRef = useRef(createScreenStateCache(deps.preservedScreenLimit));
  const activeViewRef = useRef(deps.view);
  // A Sell tap that had to wait for the account's shops to load: whose, and when.
  // What finishes it: "sell" goes to selling (the shop, or setup), "shop" opens the Shop Hub or,
  // for an account with no shop, `onNoShop` (the shop browser).
  const sellWhenShopLoadsRef = useRef<{
    accountId: string;
    at: number;
    mode: GrogoniMode;
    view: ShellView;
    onNoShop: (() => void) | null;
  } | null>(null);
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

  useEffect(() => {
    const pending = sellWhenShopLoadsRef.current;
    if (pending === null) return;
    // A tap from another sign-in, from long enough ago, or after the user switched mode or went to
    // another screen (the contact book, a module) is dropped: acting on it would move a user who
    // moved on. (Not a route change alone: restoring the account's last place on a cold load
    // changes the route without the user doing anything.)
    if (
      pending.accountId !== session?.account.id ||
      Date.now() - pending.at > sellTapLifetimeMs ||
      mode !== pending.mode ||
      deps.view !== pending.view
    ) {
      sellWhenShopLoadsRef.current = null;
      // "Loading your shop…" would otherwise promise something that is no longer coming.
      setStatusMessage("");
      return;
    }
    if (business === null && !deps.sessionContextLoaded) return;
    sellWhenShopLoadsRef.current = null;
    // The shop arrived (open it) or the load finished without one (setup, or the shop browser).
    if (pending.onNoShop === null) switchMode("seller");
    else if (business !== null) openShopHub();
    else pending.onNoShop();
    // Only these changes finish a pending tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, deps.sessionContextLoaded, session?.account.id, mode, deps.view]);

  function switchMode(nextMode: GrogoniMode) {
    const { setIsBusinessSetupOpen, setBusinessSetupStep } = deps.getBusinessSetupSetters();

    if (nextMode === "seller" && business === null) {
      if (
        session !== null &&
        !deps.getSessionContextLoad().loaded &&
        freshPending("sell") === null
      ) {
        // Opening setup here would offer an owner whose shops failed to load a second shop (the
        // create then fails as a duplicate). Load the shops first, and finish the tap when the
        // shop arrives. A second tap while they still have not loaded goes on to setup, so no
        // one is stuck behind a failing load: a create there opens an existing shop (409).
        waitForShops(null);
        return;
      }
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

  /**
   * A pending wait of this kind (a Sell tap, or a swipe to "the shop") that still counts: same
   * account, not expired. A swipe's wait does not make a first Sell tap look like a second one.
   */
  function freshPending(kind: "sell" | "shop") {
    const pending = sellWhenShopLoadsRef.current;
    if (pending === null || (pending.onNoShop === null) !== (kind === "sell")) return null;
    if (pending.accountId !== session?.account.id || Date.now() - pending.at > sellTapLifetimeMs)
      return null;
    return pending;
  }

  /** Loads the account's shops, then finishes the tap (see the effect above). */
  function waitForShops(onNoShop: (() => void) | null) {
    if (session === null) return;
    sellWhenShopLoadsRef.current = {
      accountId: session.account.id,
      at: Date.now(),
      mode,
      view: deps.view,
      onNoShop
    };
    deps.getSessionContextLoad().retry();
    setStatusMessage("Loading your shop… If this takes long, check your connection.");
  }

  /**
   * "The shop" from a swipe: the Shop Hub for an owner, `browse` (the marketplace of shops) for
   * someone without a shop. While the account's shops have not loaded, which of the two is not
   * known yet, so it waits for them instead of guessing.
   */
  function openShopOrBrowse(browse: () => void) {
    if (business !== null) openShopHub();
    // A second swipe while the shops still have not loaded goes to the shop browser, so a failing
    // load never traps anyone (an owner can still reach the Shop Hub from the menu).
    else if (
      session !== null &&
      !deps.getSessionContextLoad().loaded &&
      freshPending("shop") === null
    )
      waitForShops(browse);
    else {
      sellWhenShopLoadsRef.current = null;
      browse();
    }
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
    openShopOrBrowse,
    closeShopHub,
    updateShopPresenceStatus
  };
}
