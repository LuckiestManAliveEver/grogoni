// @vitest-environment jsdom
//
// joinStaffShop loads the session context itself. That load must count for the current sign-in,
// or a later reconnect/visibility retry re-applies the server's last shop and pulls the user out
// of the shop they just joined. Drives the real useAuthState hook; only apiFetch is mocked.
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

const joinedShop = {
  business: {
    id: "joined-shop",
    name: "Joined Shop",
    language: "en",
    grogoniId: "grogoni.joined-shop"
  },
  membership: { role: "staff" }
};

const sessionContext = {
  accountId: "staff-account",
  userId: "staff-user",
  sessionId: "staff-session",
  conversationId: "staff-conversation",
  activeShopId: null,
  agentId: "grogoni",
  activeModelId: "local",
  mode: "marketplace",
  activeSurface: "conversation",
  permissions: [],
  sessionVersion: 1,
  shops: [joinedShop]
};

type AuthApi = ReturnType<typeof useAuthState>;
let latestApi: AuthApi | null = null;
let container: HTMLDivElement;
let root: Root;

const setBusiness = vi.fn();
const setGrogoniSessionContext = vi.fn();

function Harness() {
  latestApi = useAuthState({
    business: null,
    setBusiness,
    setSession: () => undefined,
    grogoniSessionContext: null,
    setGrogoniSessionContext,
    setAgentSettings: () => undefined,
    setMode: () => undefined,
    setView: () => undefined,
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

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mockedApiFetch.mockReset();
  setBusiness.mockReset();
  setGrogoniSessionContext.mockReset();
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

describe("joinStaffShop and the session-context retry", () => {
  it("counts joinStaffShop's load, so a later retry does not re-apply the context", async () => {
    const retryLoad = vi.fn(async () => false);
    // The sign-in's own load failed (server error while online).
    act(() => latestApi!.sessionContextRetry.track("staff-account", retryLoad));
    await act(async () => undefined);
    expect(retryLoad).toHaveBeenCalledTimes(1);

    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/session/context") return sessionContext;
      throw new Error(`Unexpected request to ${path}`);
    });
    await act(async () => {
      await latestApi!.joinStaffShop(joinedShop as never, () => undefined);
    });

    latestApi!.sessionContextRetry.retry();
    expect(retryLoad).toHaveBeenCalledTimes(1);
  });

  it("ends retrying after a join even when the join's own load fails", async () => {
    const retryLoad = vi.fn(async () => false);
    act(() => latestApi!.sessionContextRetry.track("staff-account", retryLoad));
    await act(async () => undefined);

    mockedApiFetch.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await latestApi!.joinStaffShop(joinedShop as never, () => undefined);
    });

    // A retry here would restore the server's last shop over the joined one.
    latestApi!.sessionContextRetry.retry();
    expect(retryLoad).toHaveBeenCalledTimes(1);
  });

  it("starts no retry while joinStaffShop's own load is running", async () => {
    const retryLoad = vi.fn(async () => false);
    act(() => latestApi!.sessionContextRetry.track("staff-account", retryLoad));
    await act(async () => undefined);
    expect(retryLoad).toHaveBeenCalledTimes(1);

    let answer: (context: unknown) => void = () => undefined;
    mockedApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    let joining: Promise<void> = Promise.resolve();
    await act(async () => {
      joining = latestApi!.joinStaffShop(joinedShop as never, () => undefined);
      await Promise.resolve();
    });

    // The app is shown again mid-join: no second load may race the join.
    latestApi!.sessionContextRetry.retry();
    expect(retryLoad).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(sessionContext);
      await joining;
    });
    latestApi!.sessionContextRetry.retry();
    expect(retryLoad).toHaveBeenCalledTimes(1);
  });

  it("drops a retry that was already in flight when the join started", async () => {
    // The retry goes through the real loader, so a stale apply would call setBusiness after the
    // join switched to the joined shop.
    const answers: Array<(context: unknown) => void> = [];
    mockedApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        })
    );
    act(() =>
      latestApi!.sessionContextRetry.track("staff-account", (shouldApply) =>
        latestApi!.loadGrogoniSessionContext(() => undefined, shouldApply)
      )
    );
    expect(answers).toHaveLength(1);

    let joining: Promise<void> = Promise.resolve();
    await act(async () => {
      joining = latestApi!.joinStaffShop(joinedShop as never, () => undefined);
      await Promise.resolve();
    });
    expect(answers).toHaveLength(2);

    await act(async () => {
      answers[1]!(sessionContext);
      await joining;
    });
    expect(setBusiness).toHaveBeenLastCalledWith(expect.objectContaining({ id: "joined-shop" }));

    // The older retry answers last, pointing at a different shop: it must not apply.
    await act(async () => {
      answers[0]!({
        ...sessionContext,
        activeShopId: "other-shop",
        shops: [{ ...joinedShop, business: { ...joinedShop.business, id: "other-shop" } }]
      });
      await Promise.resolve();
    });
    expect(setBusiness).toHaveBeenLastCalledWith(expect.objectContaining({ id: "joined-shop" }));
  });

  it("does not apply the join's context when the user signed out before it returned", async () => {
    act(() => latestApi!.sessionContextRetry.track("staff-account", async () => false));
    await act(async () => undefined);

    let answer: (context: unknown) => void = () => undefined;
    mockedApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    let joining: Promise<void> = Promise.resolve();
    await act(async () => {
      joining = latestApi!.joinStaffShop(joinedShop as never, () => undefined);
      await Promise.resolve();
    });
    act(() => latestApi!.sessionContextRetry.track(null));

    await act(async () => {
      answer(sessionContext);
      await joining;
    });
    expect(setGrogoniSessionContext).not.toHaveBeenCalled();
  });
});
