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

const { apiFetch, ApiRequestError } = await import("../apps/web/src/lib/api");
const { useAuthState } = await import("../apps/web/src/hooks/useAuthState");
const { queueMessagingOutbox, readMessagingOutbox } =
  await import("../apps/web/src/messaging/outbox");
const { saveDeviceOnlyMessages, readDeviceOnlyMessages } =
  await import("../apps/web/src/chat-device-only-messages");

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

/** A cold load at `path`: the hook reads the deep link when it mounts. */
async function remountAt(path: string) {
  act(() => root.unmount());
  window.history.replaceState(null, "", path);
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
}

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

  it("refresh with no stored shop adopts the account's shop without moving the user", async () => {
    // The restore failed, so this device never learned the account owns a shop. Leaving business
    // null made Sell offer the owner "Set up your business" and a second create then failed 409.
    // Reported as applied, so the retry stops instead of looping on every reconnect.
    await expect(load("refresh")).resolves.toBe(true);
    expect(spies.setBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owned-shop", role: "owner" })
    );
    expect(JSON.parse(localStorage.getItem(activeBusinessStorageKey) ?? "null")).toMatchObject({
      id: "owned-shop"
    });
    expect(spies.setMode).not.toHaveBeenCalled();
    expect(spies.setView).not.toHaveBeenCalled();
    expect(spies.setActiveConversationId).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/marketplace/conversations/user-picked-conversation");
  });

  it("refresh with no stored shop and an account without shops sets no shop", async () => {
    mockedApiFetch.mockResolvedValue({ ...serverContext, activeShopId: null, shops: [] });
    await expect(load("refresh")).resolves.toBe(true);
    expect(spies.setBusiness).not.toHaveBeenCalled();
  });

  it("restore at the bare root brings the owner back to where they last worked", async () => {
    await remountAt("/");

    await load("restore");

    expect(spies.setBusiness).toHaveBeenCalledWith(expect.objectContaining({ id: "owned-shop" }));
    expect(spies.setMode).toHaveBeenCalledWith("seller");
    expect(spies.setActiveConversationId).toHaveBeenCalledWith("server-last-conversation");
    expect(window.location.pathname).toBe("/workspace/conversations/server-last-conversation");
  });

  it("restores the explicit conversation instead of requesting the account's default thread", async () => {
    const requested = { ...serverContext, conversationId: "user-picked-conversation" };
    mockedApiFetch.mockImplementation(async (path) =>
      path === "/v1/session/context?conversationId=user-picked-conversation"
        ? requested
        : serverContext
    );
    await load("restore");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/v1/session/context?conversationId=user-picked-conversation"
    );
    expect(spies.setActiveConversationId).toHaveBeenCalledWith("user-picked-conversation");
    expect(window.location.pathname).toBe("/workspace/conversations/user-picked-conversation");
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
  it("a late initial restore refreshes data without moving a chat the user has started", async () => {
    let answer: (context: unknown) => void = () => undefined;
    mockedApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    let userStartedChat = false;
    let loading: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      loading = latestApi!.loadGrogoniSessionContext(
        spies.setActiveConversationId,
        () => true,
        "restore",
        () => !userStartedChat
      );
    });
    userStartedChat = true;
    await act(async () => {
      answer(serverContext);
      await loading;
    });
    expect(spies.setGrogoniSessionContext).toHaveBeenCalledWith(serverContext);
    expect(spies.setMode).not.toHaveBeenCalled();
    expect(spies.setView).not.toHaveBeenCalled();
    expect(spies.setActiveConversationId).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/marketplace/conversations/user-picked-conversation");
  });
});

describe("restore keeps the place a cold-load URL names", () => {
  it("keeps /sell/shop open and still restores the shop", async () => {
    await remountAt("/sell/shop");
    await load("restore");

    expect(window.location.pathname).toBe("/sell/shop");
    expect(spies.setBusiness).toHaveBeenCalledWith(expect.objectContaining({ id: "owned-shop" }));
    expect(spies.setMode).toHaveBeenCalledWith("seller");
    expect(spies.setView).toHaveBeenCalledWith("chat");
    expect(spies.setActiveConversationId).not.toHaveBeenCalled();
  });

  it("keeps a conversation URL in its own mode, over the account's last seller place", async () => {
    // beforeEach mounted at /marketplace/conversations/user-picked-conversation.
    await load("restore");

    expect(window.location.pathname).toBe("/marketplace/conversations/user-picked-conversation");
    expect(spies.setMode).toHaveBeenCalledWith("marketplace");
    expect(spies.setActiveConversationId).toHaveBeenCalledWith("user-picked-conversation");
    expect(spies.setBusiness).toHaveBeenCalledWith(expect.objectContaining({ id: "owned-shop" }));
    expect(localStorage.getItem("grogoni.chatFirst.mode")).toBe("marketplace");
  });

  it("keeps a module URL", async () => {
    await remountAt("/catalogue");
    await load("restore");

    expect(window.location.pathname).toBe("/catalogue");
    expect(spies.setMode).toHaveBeenCalledWith("seller");
    expect(spies.setView).toHaveBeenCalledWith("products");
  });

  it("keeps the Shop Hub, which offers setup, for an account with no shop", async () => {
    mockedApiFetch.mockResolvedValue({
      ...serverContext,
      mode: "marketplace",
      activeShopId: null,
      shops: []
    });
    await remountAt("/sell/shop");
    await load("restore");

    expect(window.location.pathname).toBe("/sell/shop");
    expect(spies.setMode).toHaveBeenCalledWith("seller");
    expect(spies.setBusiness).toHaveBeenCalledWith(null);
  });

  it("sends another seller link to the Shop Hub's setup for an account with no shop", async () => {
    mockedApiFetch.mockResolvedValue({
      ...serverContext,
      mode: "marketplace",
      activeShopId: null,
      shops: []
    });
    await remountAt("/workspace/conversations/someone-elses-shop-chat");
    await load("restore");

    expect(window.location.pathname).toBe("/sell/shop");
    expect(spies.setMode).toHaveBeenCalledWith("seller");
    expect(spies.setActiveConversationId).not.toHaveBeenCalled();
  });

  it("uses the deep link once: a later sign-in restores the last place", async () => {
    await remountAt("/sell/shop");
    await load("restore");
    expect(window.location.pathname).toBe("/sell/shop");

    await load("restore");
    expect(window.location.pathname).toBe("/workspace/conversations/server-last-conversation");
  });

  it("joining a shop as the first applied load restores the last place and uses up the deep link", async () => {
    await remountAt("/sell/shop");
    await act(async () => {
      await latestApi!.joinStaffShop(ownedShop as never, spies.setActiveConversationId);
    });
    expect(window.location.pathname).not.toBe("/sell/shop");
    expect(spies.setActiveConversationId).toHaveBeenCalledWith("server-last-conversation");

    // The deep link is gone: a later sign-in restores the last place too.
    window.history.replaceState(null, "", "/sell/shop");
    await load("restore");
    expect(window.location.pathname).toBe("/workspace/conversations/server-last-conversation");
  });

  it("joining a shop after the launch restore kept the URL restores the last place", async () => {
    await remountAt("/sell/shop");
    await load("restore");
    expect(window.location.pathname).toBe("/sell/shop");

    spies.setActiveConversationId.mockReset();
    await act(async () => {
      await latestApi!.joinStaffShop(ownedShop as never, spies.setActiveConversationId);
    });
    expect(spies.setActiveConversationId).toHaveBeenCalledWith("server-last-conversation");
  });

  it("restores the last place when the user already left the deep link", async () => {
    await remountAt("/sell/shop");
    window.history.replaceState(null, "", "/login");
    await load("restore");

    expect(window.location.pathname).toBe("/workspace/conversations/server-last-conversation");
  });
});

describe("a refused session refresh", () => {
  it("asks to sign in but keeps the waiting messages and their thread copies on the device", async () => {
    // docs/frontend/frontend.md, "Session expiry and silent refresh": past the refresh limit the
    // app asks to sign in; only logout (resetClientToStartup) clears what is waiting to send.
    queueMessagingOutbox({
      accountId: "account-1",
      clientMessageId: "waiting-1",
      payload: { content: { type: "text", text: "Add 5 bags of sugar" } }
    });
    saveDeviceOnlyMessages("account-1", [
      {
        id: "waiting-1",
        author: "owner",
        body: "Add 5 bags of sugar",
        status: "failed",
        outboxState: "retrying",
        deviceOnlyIn: "conversation-1"
      } as never
    ]);

    let handled = false;
    act(() => {
      handled = latestApi!.rejectDefinitiveAuthenticationFailure(
        new ApiRequestError(401, "The refresh session has expired.", {
          code: "auth_refresh_expired"
        })
      );
    });

    expect(handled).toBe(true);
    expect(readMessagingOutbox("account-1").map((entry) => entry.clientMessageId)).toEqual([
      "waiting-1"
    ]);
    expect(readDeviceOnlyMessages("account-1").map((message) => message.id)).toEqual(["waiting-1"]);
  });
});
