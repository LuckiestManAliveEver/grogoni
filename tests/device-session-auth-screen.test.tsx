// @vitest-environment jsdom
//
// Regression: a visitor holding only a device session (docs/authentication/progressive-identity.md)
// could never reach the login/signup screen. Tapping Log in (menu drawer, recognized-device pill)
// or deep-linking to /login opened the screen, then the next successful /auth/bootstrap closed it
// again and redirected to chat, because every successful bootstrap dismissed the auth screen
// regardless of identity level. A device session is not the identity that visitor asked for, so
// only a real account identity (or the visitor) may dismiss the screen. Drives the real
// useAuthState hook; only apiFetch is mocked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { ApiRequestError } from "../apps/web/src/lib/api";
import type * as ApiModule from "../apps/web/src/lib/api";

vi.mock("../apps/web/src/lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../apps/web/src/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const { apiFetch } = await import("../apps/web/src/lib/api");
const { useAuthState } = await import("../apps/web/src/hooks/useAuthState");
const { clearDeviceRecoveryCredential } = await import("../apps/web/src/device-recovery");

const mockedApiFetch = vi.mocked(apiFetch);

function sessionAt(identityLevel: "device" | "verified_contact"): unknown {
  return {
    authenticated: true,
    account: {
      id: `${identityLevel}-account`,
      primaryAuthChannel: identityLevel === "device" ? "device" : "phone",
      primaryAuthDestination: identityLevel === "device" ? "device:abc" : "+254712345678",
      identityLevel
    },
    user: { id: "user-1", displayName: "Visitor", language: "en" },
    session: { id: "session-1", expiresAt: "2099-01-01T00:00:00.000Z" },
    deviceRecoveryCredentialId: "cred-1"
  };
}

type AuthApi = ReturnType<typeof useAuthState>;

let container: HTMLDivElement;
let root: Root;
let latestApi: AuthApi | null;
const navigateToView = vi.fn();

async function mount(
  initialAuthenticationTarget: "login" | "signup" | null,
  { accountRestorationIntent = false } = {}
) {
  function Harness() {
    latestApi = useAuthState({
      business: null,
      setBusiness: () => undefined,
      setSession: () => undefined,
      grogoniSessionContext: null,
      setGrogoniSessionContext: () => undefined,
      setAgentSettings: () => undefined,
      setMode: () => undefined,
      setView: () => undefined,
      setStatusMessage: () => undefined,
      setNetworkGraph: () => undefined,
      navigateToView,
      loadMarketplaceIntroState: async () => undefined,
      validateStoredBusiness: async () => undefined,
      accountDeletionIntent: false,
      accountRestorationIntent,
      initialAuthenticationTarget,
      initialCountryCode: "+254",
      initialOwnerAuth: null,
      registerReset: () => undefined
    });
    return null;
  }
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
}

function bootstrapReturns(identityLevel: "device" | "verified_contact") {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path === "/auth/bootstrap") return sessionAt(identityLevel);
    throw new Error(`Unexpected request to ${path}`);
  });
}

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  sessionStorage.clear();
  mockedApiFetch.mockReset();
  navigateToView.mockReset();
  await clearDeviceRecoveryCredential();
  container = document.createElement("div");
  document.body.appendChild(container);
  latestApi = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a device-only session never dismisses the login/signup screen", () => {
  it("keeps a /login deep link on the login screen when bootstrap returns a device session", async () => {
    await mount("login");
    expect(latestApi!.isAuthOpen).toBe(true);
    bootstrapReturns("device");

    await act(async () => {
      await latestApi!.refreshSession();
    });

    expect(latestApi!.authBootstrapState).toBe("authenticated");
    expect(latestApi!.isAuthOpen).toBe(true);
    expect(navigateToView).not.toHaveBeenCalled();
  });

  it("keeps the screen a visitor opened from the menu open through a later bootstrap", async () => {
    await mount(null);
    act(() => latestApi!.setIsAuthOpen(true));
    bootstrapReturns("device");

    await act(async () => {
      await latestApi!.refreshSession();
    });

    expect(latestApi!.isAuthOpen).toBe(true);
  });

  it("keeps the screen open when bootstrap fails and the device account is recovered", async () => {
    await mount("login");
    // Commit a device recovery credential first, the way a returning visitor would have one.
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/continue") return sessionAt("device");
      throw new Error(`Unexpected request to ${path}`);
    });
    await act(async () => {
      await latestApi!.continueToGrogoni();
    });
    expect(latestApi!.isAuthOpen).toBe(true);

    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/bootstrap") {
        throw new ApiRequestError(401, "The access session must be refreshed.", {
          code: "auth_session_expired"
        });
      }
      if (path === "/auth/device/recover") return sessionAt("device");
      throw new Error(`Unexpected request to ${path}`);
    });
    await act(async () => {
      await latestApi!.refreshSession();
    });

    expect(mockedApiFetch.mock.calls.some(([path]) => path === "/auth/device/recover")).toBe(true);
    expect(latestApi!.authBootstrapState).toBe("authenticated");
    expect(latestApi!.isAuthOpen).toBe(true);
  });

  it("still closes the screen for an account-restoration intent after device recovery", async () => {
    // The restoration panel renders only once isAuthOpen is false; HEAD closed it here
    // unconditionally, and keeping it open would trap the visitor on a phone login form.
    await mount(null, { accountRestorationIntent: true });
    expect(latestApi!.isAuthOpen).toBe(true);
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/continue") return sessionAt("device");
      throw new Error(`Unexpected request to ${path}`);
    });
    await act(async () => {
      await latestApi!.continueToGrogoni();
    });

    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/bootstrap") {
        throw new ApiRequestError(401, "The access session must be refreshed.", {
          code: "auth_session_expired"
        });
      }
      if (path === "/auth/device/recover") return sessionAt("device");
      throw new Error(`Unexpected request to ${path}`);
    });
    await act(async () => {
      await latestApi!.refreshSession();
    });

    expect(mockedApiFetch.mock.calls.some(([path]) => path === "/auth/device/recover")).toBe(true);
    expect(latestApi!.isAuthOpen).toBe(false);
  });

  it("still dismisses the screen and returns to chat for a real account session", async () => {
    await mount("login");
    bootstrapReturns("verified_contact");

    await act(async () => {
      await latestApi!.refreshSession();
    });

    expect(latestApi!.isAuthOpen).toBe(false);
    expect(navigateToView).toHaveBeenCalledWith("chat", { replace: true, mode: "marketplace" });
  });
});
