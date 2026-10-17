// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeBusinessStorageKey } from "../apps/web/src/grogoni-application-shared";
import { ApiRequestError } from "../apps/web/src/lib/api";
import type * as ApiHelpers from "../apps/web/src/api-helpers";

vi.mock("../apps/web/src/api-helpers", async () => {
  const actual = await vi.importActual<typeof ApiHelpers>("../apps/web/src/api-helpers");
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn() };
});

const { getJson, postJson } = await import("../apps/web/src/api-helpers");
const { useBusinessSetupState } = await import("../apps/web/src/hooks/useBusinessSetupState");
type Setup = ReturnType<typeof useBusinessSetupState>;

/**
 * Production journey: a person who already had a shop tapped "Create shop" again (their first
 * create's reply never arrived) and was left on "This account has already registered a store."
 * The app now opens the shop they own.
 */
describe("creating a shop when the account already owns one", () => {
  let host: HTMLDivElement;
  let root: Root;
  const deps = {
    setBusiness: vi.fn(),
    setSession: vi.fn(),
    setAgentSettings: vi.fn(),
    setMode: vi.fn(),
    setView: vi.fn(),
    refreshSession: vi.fn(async () => undefined),
    setConversationInbox: vi.fn(),
    setActiveConversationId: vi.fn(),
    loadConversationThread: vi.fn(async () => undefined),
    setStatusMessage: vi.fn()
  };
  let setup: Setup | null = null;

  function Harness() {
    setup = useBusinessSetupState({
      ...deps,
      business: null,
      session: { account: { id: "account-1" } } as never,
      initialSetupDraft: { businessName: "Mama Mboga", language: "en" },
      initialCountryCode: "KE" as never,
      registerReset: () => undefined
    });
    return null;
  }

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    for (const fn of Object.values(deps)) fn.mockClear();
    vi.mocked(getJson).mockReset();
    vi.mocked(postJson).mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await act(async () => setup!.setShopPhoneNumber("0712345678"));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens the owned shop instead of showing the conflict", async () => {
    vi.mocked(postJson).mockImplementation(async (path) => {
      if (path === "/businesses")
        throw new ApiRequestError(409, "This account has already registered a store.", {
          code: "store_already_registered"
        });
      throw new Error(`Unexpected POST ${path}`);
    });
    vi.mocked(getJson).mockResolvedValue({
      shops: [
        {
          business: { id: "biz-1", name: "Mama Mboga", language: "en", grogoniId: "grogoni.mama" },
          membership: { id: "m1", businessId: "biz-1", userId: "u1", role: "owner" }
        }
      ]
    });

    await act(async () => setup!.createBusiness());

    expect(getJson).toHaveBeenCalledWith("/v1/shops");
    expect(deps.setBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ id: "biz-1", role: "owner" })
    );
    expect(deps.setMode).toHaveBeenCalledWith("seller");
    expect(deps.setStatusMessage).toHaveBeenLastCalledWith(
      "You already have a shop, Mama Mboga. Opened it."
    );
    // No welcome message is posted into a shop that already has its history.
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(activeBusinessStorageKey) ?? "null")).toMatchObject({
      id: "biz-1"
    });
  });

  it("shows the conflict when the account turns out to own no shop", async () => {
    vi.mocked(postJson).mockRejectedValue(
      new ApiRequestError(409, "This account has already registered a store.", {
        code: "store_already_registered"
      })
    );
    vi.mocked(getJson).mockResolvedValue({ shops: [] });

    await act(async () => setup!.createBusiness());

    expect(deps.setBusiness).not.toHaveBeenCalled();
    expect(deps.setStatusMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/already registered a store/u)
    );
  });

  it("keeps the 'you already have a shop' context when the shop list cannot load", async () => {
    vi.mocked(postJson).mockRejectedValue(
      new ApiRequestError(409, "This account has already registered a store.", {
        code: "store_already_registered"
      })
    );
    vi.mocked(getJson).mockRejectedValue(new ApiRequestError(503, "Service unavailable"));

    await act(async () => setup!.createBusiness());

    expect(deps.setBusiness).not.toHaveBeenCalled();
    expect(setup!.isBusinessSetupOpen).toBe(false);
    expect(deps.setStatusMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/already has a shop.*tap Sell again/u)
    );
  });

  it("leaves other create failures as they were", async () => {
    vi.mocked(postJson).mockRejectedValue(
      new ApiRequestError(400, "Business name is too long.", { code: "invalid_request" })
    );

    await act(async () => setup!.createBusiness());

    expect(getJson).not.toHaveBeenCalled();
    expect(deps.setBusiness).not.toHaveBeenCalled();
  });
});
