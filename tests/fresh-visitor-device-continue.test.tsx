// @vitest-environment jsdom
//
// Real-behavior regression for audit A01 ("Fresh visitors lose the composer",
// docs/audits/grogoni-home-2026-09-17/audit.md). The existing coverage for continueToGrogoni
// (tests/grogoni-home-progressive-entry.test.ts) only asserts that certain source strings are
// present - it never exercises the actual request continueToGrogoni sends. The bug the audit found:
// continueToGrogoni posted `body: {}` to /auth/continue, which
// services/api/src/cp2/domains/device-bootstrap/shared.ts's normalizeDeviceRecoveryPublicKey
// rejects with 400 device_recovery_key_required for a genuinely fresh visitor (no session cookie
// at all - services/api/src/cp2/domains/device-bootstrap/store.ts's continueWithDevice only skips
// the key requirement when a session already exists). This drives the real useAuthState hook end
// to end - only the network layer (apiFetch) is mocked - so it fails if that wiring regresses.
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

function freshDeviceSession(): unknown {
  return {
    account: {
      id: "device-account-1",
      primaryAuthChannel: "device",
      primaryAuthDestination: "device:abc",
      identityLevel: "device"
    },
    user: {
      id: "user-1",
      accountId: "device-account-1",
      displayName: "Grogoni user",
      language: "en"
    },
    session: { id: "session-1", expiresAt: "2099-01-01T00:00:00.000Z" },
    deviceRecoveryCredentialId: "cred-1"
  };
}

type AuthApi = ReturnType<typeof useAuthState>;

function Harness({ onReady }: { onReady: (api: AuthApi) => void }) {
  const api = useAuthState({
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
  onReady(api);
  return null;
}

describe("fresh visitor device continue (audit A01)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestApi: AuthApi | null;

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    mockedApiFetch.mockReset();
    await clearDeviceRecoveryCredential();
    container = document.createElement("div");
    document.body.appendChild(container);
    latestApi = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness onReady={(api) => (latestApi = api)} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("posts a real EC device public key to /auth/continue for a genuinely fresh visitor, not an empty body", async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/bootstrap") {
        throw new ApiRequestError(401, "The access session must be refreshed.", {
          code: "auth_session_expired"
        });
      }
      if (path === "/auth/continue") {
        return freshDeviceSession();
      }
      throw new Error(`Unexpected request to ${path}`);
    });

    await act(async () => {
      await latestApi!.refreshSession();
    });

    expect(latestApi!.authBootstrapState).toBe("authenticated");
    expect(latestApi!.isAuthOpen).toBe(false);

    const continueCall = mockedApiFetch.mock.calls.find(([path]) => path === "/auth/continue");
    expect(continueCall).toBeDefined();
    const [, options] = continueCall!;
    const body = options?.body as { devicePublicKeyJwk?: JsonWebKey };
    // This is the exact regression: the old body was `{}`, which the server rejects with 400
    // device_recovery_key_required for a visitor with no existing session.
    expect(body.devicePublicKeyJwk).toBeDefined();
    expect(body.devicePublicKeyJwk?.kty).toBe("EC");
    expect(body.devicePublicKeyJwk?.crv).toBe("P-256");
  });

  it("commits the server-issued credential id so a later visit recovers instead of continuing again", async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/bootstrap") {
        throw new ApiRequestError(401, "The access session must be refreshed.", {
          code: "auth_session_expired"
        });
      }
      if (path === "/auth/continue") {
        return freshDeviceSession();
      }
      if (path === "/auth/device/recover") {
        return freshDeviceSession();
      }
      throw new Error(`Unexpected request to ${path}`);
    });

    await act(async () => {
      await latestApi!.continueToGrogoni();
    });

    const { recoverDeviceAccount } = await import("../apps/web/src/device-recovery");
    const recovered = await recoverDeviceAccount();
    expect(recovered).not.toBeNull();

    const recoverCall = mockedApiFetch.mock.calls.find(([path]) => path === "/auth/device/recover");
    expect(recoverCall).toBeDefined();
    const [, options] = recoverCall!;
    const body = options?.body as { credentialId?: string };
    expect(body.credentialId).toBe("cred-1");
  });
});
