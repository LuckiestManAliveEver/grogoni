// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNavigationState } from "../apps/web/src/hooks/useNavigationState";
import type { ActiveBusiness, SessionResponse } from "../apps/web/src/grogoni-application-shared";

/**
 * Production journey: an owner whose shops had not loaded (the request failed) tapped Sell and was
 * offered "Set up your business", then got a duplicate-shop error. Until the account's shops
 * load, no business means "not loaded yet", so the app loads them instead of offering setup.
 */
describe("Sell before the account's shops have loaded", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setIsBusinessSetupOpen = vi.fn();
  const setStatusMessage = vi.fn();
  const retry = vi.fn();
  const setIsWorkspacePanelOpen = vi.fn();
  let navigation: ReturnType<typeof useNavigationState> | null = null;
  const session = {
    account: { id: "account-1" },
    user: { id: "user-1", phoneNumberE164: "+254712345678" }
  } as unknown as SessionResponse;

  const setMode = vi.fn();
  const otherSession = {
    account: { id: "account-2" },
    user: { id: "user-2", phoneNumberE164: "+254700000002" }
  } as unknown as SessionResponse;
  function Harness({
    loaded,
    signedIn,
    business = null,
    account = session,
    mode = "marketplace",
    view = "chat"
  }: {
    loaded: boolean;
    signedIn: boolean;
    business?: ActiveBusiness | null;
    account?: SessionResponse;
    mode?: "marketplace" | "seller";
    view?: "chat" | "network";
  }) {
    navigation = useNavigationState({
      business,
      session: signedIn ? account : null,
      mode,
      setMode,
      view,
      setView: () => undefined,
      getIsMarketplaceIntroComplete: () => true,
      preservedScreenLimit: 3,
      initialMarketplaceShortcutOpen: false,
      initialRoutedProductId: null,
      populateProductForm: () => undefined,
      setStatusMessage,
      setIsWorkspacePanelOpen,
      runAction: async (_key, action) => action(),
      getAuthSetters: () => ({
        setIsAuthOpen: () => undefined,
        setAuthenticationView: () => undefined,
        setIsAccountRestorationOpen: () => undefined
      }),
      getBusinessSetupSetters: () => ({
        setIsBusinessSetupOpen,
        setBusinessSetupStep: () => undefined
      }),
      getChatSetters: () => ({
        setIsMessagingInboxOpen: () => undefined,
        setChatMessages: () => undefined
      }),
      getContinueToGrogoni: () => async () => null,
      getSessionContextLoad: () => ({ loaded, retry }),
      sessionContextLoaded: loaded,
      registerReset: () => undefined
    });
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    setIsBusinessSetupOpen.mockReset();
    setStatusMessage.mockReset();
    retry.mockReset();
    setIsWorkspacePanelOpen.mockReset();
    setMode.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("loads the shops instead of offering a second shop", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalled();
    expect(setStatusMessage).toHaveBeenCalledWith(expect.stringMatching(/Loading your shop/u));
  });

  it("offers setup once the shops loaded and there are none", () => {
    act(() => root.render(<Harness loaded signedIn />));
    act(() => navigation!.switchMode("seller"));
    expect(retry).not.toHaveBeenCalled();
    expect(setIsBusinessSetupOpen).toHaveBeenCalledWith(true);
  });

  it("sends a signed-out person to sign up, not to a shop load", () => {
    act(() => root.render(<Harness loaded={false} signedIn={false} />));
    act(() => navigation!.switchMode("seller"));
    expect(retry).not.toHaveBeenCalled();
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
    expect(setStatusMessage).toHaveBeenCalledWith("Create your Grogoni account.");
  });

  it("finishes the Sell tap once the owner's shop arrives", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    expect(setMode).not.toHaveBeenCalled();
    const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn business={shop} />));
    expect(setMode).toHaveBeenCalledWith("seller");
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
  });

  it("does not jump to selling when a shop arrives without a pending Sell tap", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn business={shop} />));
    expect(setMode).not.toHaveBeenCalled();
  });

  it("lets a second Sell tap reach setup when the shops still have not loaded", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
    act(() => navigation!.switchMode("seller"));
    expect(setIsBusinessSetupOpen).toHaveBeenCalledWith(true);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("opens setup once the load finishes and the account really has no shop", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
    act(() => root.render(<Harness loaded signedIn />));
    expect(setIsBusinessSetupOpen).toHaveBeenCalledWith(true);
  });

  it("drops a waiting Sell tap when another account signs in", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    const shop = { id: "shop-2", name: "Other", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn account={otherSession} business={shop} />));
    expect(setMode).not.toHaveBeenCalled();
  });

  it("drops a waiting Sell tap after a minute, so a late load does not move the user", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      act(() => root.render(<Harness loaded={false} signedIn />));
      act(() => navigation!.switchMode("seller"));
      vi.setSystemTime(Date.now() + 61_000);
      const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
      act(() => root.render(<Harness loaded signedIn business={shop} />));
      expect(setMode).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a waiting Sell tap once the user switches mode", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn business={shop} mode="seller" />));
    expect(setMode).not.toHaveBeenCalled();
  });

  it("keeps a waiting Sell tap when restoring the last place only changes the route", () => {
    window.history.replaceState(null, "", "/marketplace/conversations/thread-1");
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    window.history.replaceState(null, "", "/marketplace/conversations/restored-thread");
    const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn business={shop} />));
    expect(setMode).toHaveBeenCalledWith("seller");
  });

  it("swipe right waits for the shops, then opens the Shop Hub for an owner", () => {
    const browse = vi.fn();
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.openShopOrBrowse(browse));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(browse).not.toHaveBeenCalled();
    expect(setIsWorkspacePanelOpen).not.toHaveBeenCalled();
    const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn business={shop} />));
    expect(setIsWorkspacePanelOpen).toHaveBeenCalledWith(true);
    expect(browse).not.toHaveBeenCalled();
  });

  it("swipe right opens the shop browser once the shops load and there are none", () => {
    const browse = vi.fn();
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.openShopOrBrowse(browse));
    act(() => root.render(<Harness loaded signedIn />));
    expect(browse).toHaveBeenCalledTimes(1);
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
  });

  it("swipe right browses at once for a signed-out visitor or a loaded account with no shop", () => {
    const browse = vi.fn();
    act(() => root.render(<Harness loaded={false} signedIn={false} />));
    act(() => navigation!.openShopOrBrowse(browse));
    act(() => root.render(<Harness loaded signedIn />));
    act(() => navigation!.openShopOrBrowse(browse));
    expect(browse).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
  });

  it("drops a waiting swipe once the user swipes on to the contact book", () => {
    const browse = vi.fn();
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.openShopOrBrowse(browse));
    act(() => root.render(<Harness loaded={false} signedIn view="network" />));
    const shop = { id: "shop-1", name: "Shop", language: "en", role: "owner" } as ActiveBusiness;
    act(() => root.render(<Harness loaded signedIn business={shop} view="network" />));
    expect(setIsWorkspacePanelOpen).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();
  });

  it("a second swipe while the shops still have not loaded goes to the shop browser", () => {
    const browse = vi.fn();
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.openShopOrBrowse(browse));
    expect(browse).not.toHaveBeenCalled();
    act(() => navigation!.openShopOrBrowse(browse));
    expect(browse).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not treat a first Sell tap as a second one because a swipe is waiting", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.openShopOrBrowse(vi.fn()));
    act(() => navigation!.switchMode("seller"));
    expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
  });

  it("clears 'Loading your shop' when the wait is dropped", () => {
    act(() => root.render(<Harness loaded={false} signedIn />));
    act(() => navigation!.switchMode("seller"));
    expect(setStatusMessage).toHaveBeenLastCalledWith(expect.stringMatching(/Loading your shop/u));
    act(() => root.render(<Harness loaded={false} signedIn view="network" />));
    expect(setStatusMessage).toHaveBeenLastCalledWith("");
  });

  it("does not count an expired wait as the first tap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      act(() => root.render(<Harness loaded={false} signedIn />));
      act(() => navigation!.switchMode("seller"));
      vi.setSystemTime(Date.now() + 61_000);
      act(() => navigation!.switchMode("seller"));
      // A fresh first tap again: it waits for the shops rather than opening setup.
      expect(setIsBusinessSetupOpen).not.toHaveBeenCalledWith(true);
      expect(retry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
