// @vitest-environment jsdom
//
// A session-context retry runs after a failed launch load, when the user may already have moved
// on from the device cache. It must refresh data only (and forget a stored shop the account does
// not belong to), never restore the server's last mode, view, conversation or route. Only the
// sign-in's first load ("restore") does that. Drives the real useAuthState hook.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiModule from "../apps/web/src/lib/api";

vi.mock("../apps/web/src/lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../apps/web/src/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const { apiFetch } = await import("../apps/web/src/lib/api");
const { useAuthState } = await import("../apps/web/src/hooks/useAuthState");

const mockedApiFetch = vi.mocked(apiFetch);
const activeBusinessStorageKey = "grogoni.chatFirst.activeBusiness";

const ownedShop = {
  business: { id: "owned-shop", name: "Owned Shop", language: "en", grogoniId: "grogoni.owned" },
  membership: { role: "owner" }
};

const serverContext = {
  accountId: "account-1",
  userId: "user-1",
  sessionId: "session-1",
  conversationId: "server-last-conversation",
  activeShopId: "owned-shop",
  agentId: "owned-shop",
  activeModelId: "local",
  mode: "seller",
  activeSurface: "conversation",
  permissions: [],
  sessionVersion: 1,
  shops: [ownedShop]
};

const spies = {
  setBusiness: vi.fn(),
  setMode: vi.fn(),
  setView: vi.fn(),
  setGrogoniSessionContext: vi.fn(),
  setActiveConversationId: vi.fn()
};

type AuthApi = ReturnType<typeof useAuthState>;
let latestApi: AuthApi | null = null;
let container: HTMLDivElement;
let root: Root;

function Harness() {
  latestApi = useAuthState({
    business: null,
    setBusiness: spies.setBusiness,
    setSession: () => undefined,
    grogoniSessionContext: null,
    setGrogoniSessionContext: spies.setGrogoniSessionContext,
    setAgentSettings: () => undefined,
    setMode: spies.setMode,
    setView: spies.setView,
    setStatusMessage: () => undefined,
    setNetworkGraph: () => undefined,
    navigateToView: () => undefined,
    loadMarketplaceIntroState: async () => undefined,
    validateStoredBusiness: async () => undefined,
    accountDeletionIntent: false,
    accountRestorationIntent: false,
    initialAuthenticationTarget: null,
    initialCountryCode: "+254",
    initialOwnerAuth: null,
    registerReset: () => undefined
  });
  return null;
}

function storeShop(id: string) {
  localStorage.setItem(
    activeBusinessStorageKey,
    JSON.stringify({ id, name: id, language: "en", role: "owner", grogoniId: `grogoni.${id}` })
  );
}

async function load(apply: "restore" | "refresh"): Promise<boolean> {
  let applied = false;
  await act(async () => {
    applied = await latestApi!.loadGrogoniSessionContext(
      spies.setActiveConversationId,
      () => true,
      apply
    );
  });
  return applied;
}

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  for (const spy of Object.values(spies)) spy.mockReset();
  mockedApiFetch.mockReset();
  mockedApiFetch.mockResolvedValue(serverContext);
  window.history.replaceState(null, "", "/marketplace/conversations/user-picked-conversation");
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("session context refresh (retry) versus restore (sign-in)", () => {
  it("refresh forgets a stored shop the account does not belong to, and moves nothing", async () => {
    storeShop("previous-account-shop");
    await load("refresh");

    expect(spies.setGrogoniSessionContext).toHaveBeenCalledWith(serverContext);
    expect(spies.setBusiness).toHaveBeenCalledWith(null);
    expect(localStorage.getItem(activeBusinessStorageKey)).toBeNull();
    expect(spies.setMode).not.toHaveBeenCalled();
    expect(spies.setView).not.toHaveBeenCalled();
    expect(spies.setActiveConversationId).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/marketplace/conversations/user-picked-conversation");
  });

  it("refresh keeps a stored shop the account still belongs to", async () => {
    storeShop("owned-shop");
    await load("refresh");

    expect(spies.setBusiness).not.toHaveBeenCalled();
    expect(localStorage.getItem(activeBusinessStorageKey)).not.toBeNull();
  });

  it("refresh with no stored shop leaves the shop alone", async () => {
    // Reported as applied, so the retry stops instead of looping on every reconnect.
    await expect(load("refresh")).resolves.toBe(true);
    expect(spies.setBusiness).not.toHaveBeenCalled();
  });

  it("restore still brings the owner back to where they last worked", async () => {
    await load("restore");

    expect(spies.setBusiness).toHaveBeenCalledWith(expect.objectContaining({ id: "owned-shop" }));
    expect(spies.setMode).toHaveBeenCalledWith("seller");
    expect(spies.setActiveConversationId).toHaveBeenCalledWith("server-last-conversation");
    expect(window.location.pathname).toBe("/workspace/conversations/server-last-conversation");
  });

  it("refresh drops an answer when the user changed shop while it was in flight", async () => {
    let answer: (context: unknown) => void = () => undefined;
    mockedApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    let refreshing: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      refreshing = latestApi!.loadGrogoniSessionContext(
        spies.setActiveConversationId,
        () => true,
        "refresh"
      );
      await Promise.resolve();
    });

    // The user creates a shop meanwhile; the server's answer was built before it existed.
    storeShop("just-created-shop");
    let applied = true;
    await act(async () => {
      answer({ ...serverContext, shops: [] });
      applied = await refreshing;
    });

    expect(applied).toBe(false);
    expect(spies.setBusiness).not.toHaveBeenCalled();
    expect(spies.setGrogoniSessionContext).not.toHaveBeenCalled();
    expect(localStorage.getItem(activeBusinessStorageKey)).toContain("just-created-shop");
  });
});
