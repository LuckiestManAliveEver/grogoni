// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "../apps/web/src/lib/api";

vi.mock("../apps/web/src/browser-passkeys", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  loginWithBrowserPasskey: vi.fn(),
  recoverWithBrowserPasskey: vi.fn(),
  createBrowserPasskey: vi.fn()
}));
vi.mock("../apps/web/node_modules/@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));
vi.mock("../apps/web/src/device-messaging", () => ({
  isNativeDeviceHost: vi.fn(() => false),
  deviceMessagingAdapter: { call: vi.fn() }
}));
vi.mock("../apps/web/src/lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../apps/web/src/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const { apiFetch, ApiRequestError } = await import("../apps/web/src/lib/api");
const { isNativeDeviceHost, deviceMessagingAdapter } =
  await import("../apps/web/src/device-messaging");
const { createBrowserPasskey, browserSupportsWebAuthn } =
  await import("../apps/web/src/browser-passkeys");
const webauthn = await import("../apps/web/node_modules/@simplewebauthn/browser");
const { PhoneFirstAuthentication } = await import("../apps/web/src/PhoneFirstAuthentication");
const { TrustedDeviceApproval } = await import("../apps/web/src/TrustedDeviceApproval");

const mockedApiFetch = vi.mocked(apiFetch);
const onAuthenticated = vi.fn();
let host: HTMLDivElement;
let root: Root;

const approvedSession = {
  account: { id: "account-1", primaryAuthDestination: "+254712345678" },
  user: { id: "user-1" },
  session: { id: "browser-session" }
};

function render(element: React.ReactElement) {
  act(() => root.render(element));
}

function renderLogin() {
  render(
    <PhoneFirstAuthentication
      remembered={null}
      onAuthenticated={onAuthenticated}
      onSignUp={vi.fn()}
      onForgetRemembered={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button ${text}`);
  return button;
}

function inputByLabel(label: string): HTMLInputElement {
  const match = Array.from(document.querySelectorAll("label")).find((item) =>
    item.textContent?.includes(label)
  );
  const input = match?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${label}`);
  return input;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true
      })
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(isNativeDeviceHost).mockReturnValue(false);
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
  vi.mocked(webauthn.browserSupportsWebAuthn).mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("locked-out PWA with no passkey", () => {
  async function openApproval() {
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Trouble logging in?"));
    await change(document.querySelector("select")!, "approval");
    await click(buttonByText("Get an approval code"));
  }

  it("shows a code, waits for the other device, then creates a passkey here", async () => {
    let polls = 0;
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods")
        return { recoveryAvailable: true, passkeyAvailable: true };
      if (path === "/auth/recovery/device-approval/start")
        return {
          transactionId: "request-1",
          pollSecret: "secret",
          code: "482915",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          pollIntervalMs: 5
        };
      if (path === "/auth/recovery/device-approval/status") {
        polls += 1;
        return polls < 2
          ? { status: "pending", expiresAt: new Date(Date.now() + 600_000).toISOString() }
          : { status: "approved", ...approvedSession };
      }
      if (path === "/auth/credentials/status") return { hasPin: true, hasPassword: false };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    vi.mocked(createBrowserPasskey).mockResolvedValue({ id: "new-passkey" } as never);

    await openApproval();
    expect(document.body.textContent).toContain("482 915");
    expect(document.body.textContent).toContain("Approve a browser");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/device-approval/start",
      expect.objectContaining({ body: { identifier: "+254712345678" } })
    );

    await vi.waitFor(() => expect(document.body.textContent).toContain("Create a passkey"));
    expect(polls).toBe(2);
    expect(onAuthenticated).not.toHaveBeenCalled();

    await click(buttonByText("Create passkey"));
    expect(createBrowserPasskey).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Identity verified. Choose a new PIN.")
    );
    await click(buttonByText("Skip, I will log in with my passkey"));
    expect(onAuthenticated).toHaveBeenCalledWith(approvedSession);
  });

  it("goes to the PIN reset when the person skips the passkey", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") return { recoveryAvailable: true };
      if (path === "/auth/recovery/device-approval/start")
        return {
          transactionId: "request-1",
          pollSecret: "secret",
          code: "000123",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          pollIntervalMs: 5
        };
      if (path === "/auth/recovery/device-approval/status")
        return { status: "approved", ...approvedSession };
      if (path === "/auth/credentials/status") return { hasPin: false, hasPassword: false };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    await openApproval();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Create a passkey"));
    await click(buttonByText("Not now"));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Identity verified. Create a 4-digit PIN.")
    );
    expect(createBrowserPasskey).not.toHaveBeenCalled();
    // Without a new passkey there is no way back in except the PIN, so no skip is offered.
    expect(document.body.textContent).not.toContain("Skip, I will log in with my passkey");
  });

  it("stops waiting when the owner declines, and can start again", async () => {
    let starts = 0;
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") return { recoveryAvailable: true };
      if (path === "/auth/recovery/device-approval/start") {
        starts += 1;
        return {
          transactionId: `request-${starts}`,
          pollSecret: "secret",
          code: "482915",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          pollIntervalMs: 5
        };
      }
      if (path === "/auth/recovery/device-approval/status") return { status: "declined" };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    await openApproval();
    await vi.waitFor(() => expect(document.body.textContent).toContain("declined"));
    await click(buttonByText("Get a new code"));
    await vi.waitFor(() => expect(starts).toBe(2));
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("keeps waiting through a dropped connection", async () => {
    let polls = 0;
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") return { recoveryAvailable: true };
      if (path === "/auth/recovery/device-approval/start")
        return {
          transactionId: "request-1",
          pollSecret: "secret",
          code: "482915",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          pollIntervalMs: 5
        };
      if (path === "/auth/recovery/device-approval/status") {
        polls += 1;
        if (polls === 1) throw new TypeError("Failed to fetch");
        return { status: "approved", ...approvedSession };
      }
      if (path === "/auth/credentials/status") return { hasPin: true, hasPassword: false };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    await openApproval();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Create a passkey"));
    expect(polls).toBe(2);
  });
});

describe("approving on the trusted device", () => {
  const pending = {
    phone: "+254712345678",
    requests: [
      {
        requestId: "request-1",
        client: "Chrome on Android",
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString()
      }
    ]
  };

  it("confirms with the Android screen lock after the code is typed", async () => {
    vi.mocked(isNativeDeviceHost).mockReturnValue(true);
    vi.mocked(deviceMessagingAdapter.call).mockImplementation(async (method: string) => {
      if (method === "recoveryCredential") return { accountId: "account-1", credentialId: "key-1" };
      if (method === "signRecoveryChallenge")
        return {
          challengeId: "challenge-1",
          credentialId: "key-1",
          issuedAt: 1,
          nonce: "nonce",
          signature: "signed"
        };
      throw new Error(method);
    });
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/recovery/device-approval/pending") return pending;
      if (path === "/auth/recovery/device-approval/options")
        return {
          ...pending.requests[0],
          method: "device",
          challenge: { challengeId: "challenge-1", nonce: "nonce", issuedAt: 1, expiresAt: "" }
        };
      if (path === "/auth/recovery/device-approval/approve") return { approved: true };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    render(<TrustedDeviceApproval mode="prompt" />);
    await settle();
    expect(document.body.textContent).toContain("A browser wants to log in");
    expect(document.body.textContent).toContain("Chrome on Android");
    expect(document.body.textContent).toContain("If someone sent you a code");
    expect(buttonByText("Continue").disabled).toBe(true);

    await change(inputByLabel("Code from the other browser"), "482 915");
    await click(buttonByText("Continue"));
    await settle();
    // The owner sees which browser asked before any screen-lock prompt.
    expect(document.body.textContent).toContain("Let in Chrome on Android?");
    expect(deviceMessagingAdapter.call).not.toHaveBeenCalledWith(
      "signRecoveryChallenge",
      expect.anything()
    );
    await click(buttonByText("Approve with screen lock"));
    await settle();

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/device-approval/options",
      expect.objectContaining({
        body: { code: "482 915", method: "device", credentialId: "key-1" }
      })
    );
    expect(deviceMessagingAdapter.call).toHaveBeenCalledWith("signRecoveryChallenge", {
      identifier: "+254712345678",
      challenge: expect.objectContaining({ challengeId: "challenge-1" })
    });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/device-approval/approve",
      expect.objectContaining({
        body: expect.objectContaining({
          requestId: "request-1",
          method: "device",
          signature: "signed"
        })
      })
    );
    expect(document.body.textContent).toContain("Approved Chrome on Android");
  });

  it("lets the owner undo an approval the browser has not collected", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/recovery/device-approval/pending") return pending;
      if (path === "/auth/recovery/device-approval/options")
        return {
          ...pending.requests[0],
          method: "passkey",
          ceremonyId: "ceremony-1",
          options: { challenge: "c" }
        };
      if (path === "/auth/recovery/device-approval/approve") return { approved: true };
      if (path === "/auth/recovery/device-approval/decline") return { declined: true };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    vi.mocked(webauthn.startAuthentication).mockResolvedValue({ id: "passkey" } as never);
    render(<TrustedDeviceApproval mode="panel" />);
    await settle();
    await change(inputByLabel("Code from the other browser"), "482915");
    await click(buttonByText("Continue"));
    await settle();
    await click(buttonByText("Approve with passkey"));
    await settle();
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
    await click(buttonByText("Undo, this wasn't me"));
    await settle();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/device-approval/decline",
      expect.objectContaining({ body: { requestId: "request-1" } })
    );
    expect(document.body.textContent).toContain("Approval withdrawn");
  });

  it("offers to add a passkey when a browser approver has none", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/recovery/device-approval/pending") return pending;
      if (path === "/auth/recovery/device-approval/options")
        throw new ApiRequestError(409, "Add a passkey", {
          code: "recovery_approval_passkey_missing"
        });
      throw new Error(`Unexpected request ${String(path)}`);
    });
    render(<TrustedDeviceApproval mode="panel" />);
    await settle();
    await change(inputByLabel("Code from the other browser"), "482915");
    await click(buttonByText("Continue"));
    await settle();
    expect(buttonByText("Create passkey on this device").disabled).toBe(false);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it("declines a request the owner did not start", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/recovery/device-approval/pending") return pending;
      if (path === "/auth/recovery/device-approval/decline") return { declined: true };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    render(<TrustedDeviceApproval mode="prompt" />);
    await settle();
    await click(buttonByText("This wasn't me"));
    await settle();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/device-approval/decline",
      expect.objectContaining({ body: { requestId: "request-1" } })
    );
    expect(document.body.textContent).toContain("That browser was not let in");
  });

  it("lists browsers let in during the last 24 hours, with undo, after a reload", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/recovery/device-approval/pending")
        return {
          phone: "+254712345678",
          requests: [],
          recentApprovals: [
            {
              requestId: "request-9",
              client: "Firefox on Windows",
              loggedInAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
              undoUntil: new Date(Date.now() + 21 * 60 * 60_000).toISOString()
            }
          ]
        };
      if (path === "/auth/recovery/device-approval/decline") return { declined: true };
      throw new Error(`Unexpected request ${String(path)}`);
    });
    render(<TrustedDeviceApproval mode="panel" />);
    await settle();
    expect(document.body.textContent).toContain("Firefox on Windows · logged in 3 hours ago");
    await click(buttonByText("Undo, this wasn't me"));
    await settle();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/device-approval/decline",
      expect.objectContaining({ body: { requestId: "request-9" } })
    );
    expect(document.body.textContent).toContain("That browser is signed out");
    expect(document.body.textContent).not.toContain("Firefox on Windows · logged in");
  });

  function passkeyApproval() {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/recovery/device-approval/pending") return pending;
      if (path === "/auth/recovery/device-approval/options")
        return {
          ...pending.requests[0],
          method: "passkey",
          ceremonyId: "ceremony-1",
          options: { challenge: "c" }
        };
      if (path === "/auth/recovery/device-approval/approve") return { approved: true };
      throw new Error(`Unexpected request ${String(path)}`);
    });
  }

  it("goes back to code entry when the owner cancels the screen lock", async () => {
    passkeyApproval();
    const cancelled = new Error("cancelled");
    cancelled.name = "NotAllowedError";
    vi.mocked(webauthn.startAuthentication).mockRejectedValue(cancelled);
    render(<TrustedDeviceApproval mode="panel" />);
    await settle();
    await change(inputByLabel("Code from the other browser"), "482915");
    await click(buttonByText("Continue"));
    await settle();
    await click(buttonByText("Approve with passkey"));
    await settle();
    expect(document.body.textContent).toContain("Screen lock confirmation was cancelled");
    expect(document.body.textContent).not.toContain("Let in Chrome on Android?");
    expect(inputByLabel("Code from the other browser").value).toBe("");
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      "/auth/recovery/device-approval/approve",
      expect.anything()
    );
  });

  it("keeps the prompt's outcome until Done, then hides it", async () => {
    passkeyApproval();
    vi.mocked(webauthn.startAuthentication).mockResolvedValue({ id: "passkey" } as never);
    render(<TrustedDeviceApproval mode="prompt" />);
    await settle();
    expect(buttonByText("Not now")).toBeTruthy();
    await change(inputByLabel("Code from the other browser"), "482915");
    await click(buttonByText("Continue"));
    await settle();
    await click(buttonByText("Approve with passkey"));
    await settle();
    // The request list is cleared, but the approval stays on screen with its undo.
    expect(document.body.textContent).toContain("Approved Chrome on Android");
    await click(buttonByText("Done"));
    expect(host.textContent).toBe("");
  });

  it("shows nothing to guests or while no request is open", async () => {
    mockedApiFetch.mockRejectedValue(
      new ApiRequestError(403, "Sign in", { code: "recovery_approval_phone_required" })
    );
    render(<TrustedDeviceApproval mode="panel" />);
    await settle();
    expect(host.textContent).toBe("");

    mockedApiFetch.mockResolvedValue({ phone: "+254712345678", requests: [] });
    act(() => root.unmount());
    root = createRoot(host);
    render(<TrustedDeviceApproval mode="prompt" />);
    await settle();
    expect(host.textContent).toBe("");
  });
});
