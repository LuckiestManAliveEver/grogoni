// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../apps/web/src/lib/api";
import type * as ApiModule from "../apps/web/src/lib/api";
vi.mock("../apps/web/src/browser-passkeys", () => ({
  browserSupportsWebAuthn: vi.fn(() => false),
  loginWithBrowserPasskey: vi.fn(),
  recoverWithBrowserPasskey: vi.fn()
}));

vi.mock("../apps/web/src/device-messaging", () => ({
  isNativeDeviceHost: vi.fn(() => false),
  deviceMessagingAdapter: { call: vi.fn() }
}));

vi.mock("../apps/web/src/lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../apps/web/src/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const { apiFetch } = await import("../apps/web/src/lib/api");
const { isNativeDeviceHost, deviceMessagingAdapter } =
  await import("../apps/web/src/device-messaging");
const { PhoneFirstAuthentication } = await import("../apps/web/src/PhoneFirstAuthentication");
const { browserSupportsWebAuthn, recoverWithBrowserPasskey, loginWithBrowserPasskey } =
  await import("../apps/web/src/browser-passkeys");

const mockedApiFetch = vi.mocked(apiFetch);
const onAuthenticated = vi.fn();
const onSignUp = vi.fn();
const onForgetRemembered = vi.fn();
const onCancel = vi.fn();

let host: HTMLDivElement;
let root: Root;

function renderLogin() {
  act(() => {
    root.render(
      <PhoneFirstAuthentication
        remembered={null}
        onAuthenticated={onAuthenticated}
        onSignUp={onSignUp}
        onForgetRemembered={onForgetRemembered}
        onCancel={onCancel}
      />
    );
  });
}

function inputByLabel(label: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const match = labels.find((item) => item.textContent?.includes(label));
  const input = match?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${label}`);
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button ${text}`);
  return button;
}

async function change(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mockedApiFetch.mockReset();
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
  vi.mocked(recoverWithBrowserPasskey).mockReset();
  vi.mocked(loginWithBrowserPasskey).mockReset();
  vi.mocked(isNativeDeviceHost).mockReturnValue(false);
  vi.mocked(deviceMessagingAdapter.call).mockReset();
  onAuthenticated.mockReset();
  onSignUp.mockReset();
  onForgetRemembered.mockReset();
  onCancel.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("PhoneFirstAuthentication login methods", () => {
  it("waits for login to begin, then tries the passkey before PIN", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
    const completed = { account: { primaryAuthDestination: "+254712345678" } };
    vi.mocked(loginWithBrowserPasskey).mockResolvedValue(completed as never);
    mockedApiFetch.mockResolvedValue({
      preferred: "passkey",
      passkeyAvailable: true,
      passwordFallback: true,
      recoveryAvailable: true
    });
    renderLogin();
    expect(loginWithBrowserPasskey).not.toHaveBeenCalled();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Continue to log in"));
    expect(loginWithBrowserPasskey).toHaveBeenCalledWith("+254712345678");
    expect(onAuthenticated).toHaveBeenCalledWith(completed);
    expect(deviceMessagingAdapter.call).not.toHaveBeenCalled();
  });

  it("falls back to native device security when browser passkeys are unsupported", async () => {
    vi.mocked(isNativeDeviceHost).mockReturnValue(true);
    vi.mocked(deviceMessagingAdapter.call)
      .mockResolvedValueOnce({ screenLock: true })
      .mockResolvedValueOnce({ screenLock: true })
      .mockResolvedValueOnce({ accountId: "native", credentialId: "key" })
      .mockResolvedValueOnce({ signature: "proof" });
    const completed = { account: { id: "native", primaryAuthDestination: "+254712345678" } };
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") return { preferred: "passkey", passkeyAvailable: true };
      if (path === "/auth/device/recover/options") return { challenge: "nonce" };
      if (path === "/auth/device/recover") return completed;
      throw new Error(`Unexpected ${path}`);
    });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Continue to log in"));
    expect(loginWithBrowserPasskey).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledWith(completed);
  });

  it("lets Android retry a failed capability check and reports a missing screen lock", async () => {
    vi.mocked(isNativeDeviceHost).mockReturnValue(true);
    vi.mocked(deviceMessagingAdapter.call)
      .mockRejectedValueOnce(new Error("The device adapter did not start. Reopen the app."))
      .mockResolvedValueOnce({ screenLock: false })
      .mockResolvedValueOnce({ screenLock: true })
      .mockRejectedValueOnce(new Error("Device recovery is not set up."));
    mockedApiFetch.mockResolvedValue({ recoveryAvailable: true, passwordFallback: true });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Trouble logging in?"));
    expect(document.body.textContent).toContain("The device adapter did not start.");
    expect(buttonByText("Try device security again").disabled).toBe(false);
    await click(buttonByText("Try device security again"));
    expect(document.body.textContent).toContain("Set a screen lock in Android Settings");
    await click(buttonByText("Try device security again"));
    expect(deviceMessagingAdapter.call).toHaveBeenLastCalledWith("recoveryCredential", {
      identifier: "+254712345678"
    });
    expect(document.body.textContent).toContain("Device recovery is not set up.");
    expect(buttonByText("Unlock with device security").disabled).toBe(false);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("offers passkey and email recovery in a PWA with no device-security controls", async () => {
    mockedApiFetch.mockResolvedValue({ recoveryAvailable: true, passwordFallback: true });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Trouble logging in?"));

    // No WebAuthn means no registered passkey can work here, so the other device comes first.
    expect(buttonByText("Get an approval code").disabled).toBe(false);
    expect(document.body.textContent).toContain("Registered passkey");
    expect(document.body.textContent).toContain("Approve from a logged-in device");
    expect(document.querySelector('option[value="device"]')).toBeNull();
    expect(document.body.textContent).not.toContain("device security");
    expect(document.body.textContent).not.toContain("Unlock with device security");
    const select = document.querySelector("select")!;
    await act(async () => {
      select.value = "email";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await change(inputByLabel("Backup email"), "backup@example.test");
    expect(buttonByText("Send email recovery code").disabled).toBe(false);
  });

  it("verifies a registered browser passkey before allowing a PIN reset", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
    vi.mocked(recoverWithBrowserPasskey).mockResolvedValue({
      account: { primaryAuthDestination: "+254712345678" }
    } as never);
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") return { recoveryAvailable: true };
      if (path === "/auth/credentials/status") return { hasPin: true, hasPassword: true };
      throw new Error(`Unexpected request ${path}`);
    });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Trouble logging in?"));
    await click(buttonByText("Recover with passkey"));
    expect(recoverWithBrowserPasskey).toHaveBeenCalledWith("+254712345678");
    expect(document.body.textContent).toContain("Identity verified. Choose a new PIN.");
    expect(deviceMessagingAdapter.call).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("offers a direct recovery action from the main login screen", async () => {
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");

    expect(buttonByText("Trouble logging in?")).toBeInstanceOf(HTMLButtonElement);
  });

  it("keeps a failed PIN attempt on the PIN screen even when password login is available", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") {
        return {
          preferred: "pin",
          passkeyAvailable: false,
          passwordFallback: true,
          recoveryAvailable: true,
          smsLogin: false
        };
      }
      if (path === "/auth/pin/login") {
        throw new ApiRequestError(401, "The account credentials are invalid.", {
          code: "auth_credentials_invalid"
        });
      }
      throw new Error(`Unexpected request to ${path}`);
    });

    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Continue to log in"));
    await click(buttonByText("Use account PIN"));
    await change(inputByLabel("4-digit PIN"), "1234");
    await click(buttonByText("Log in"));

    expect(document.body.textContent).toContain(
      "We couldn't sign you in with that PIN. Check your account details and PIN, then try again."
    );
    expect(inputByLabel("4-digit PIN").value).toBe("1234");
    expect(document.body.textContent).not.toContain("Log in with password");
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("submits the password with Enter, the same as the Log in button", async () => {
    const requests: { path: string; body: unknown }[] = [];
    mockedApiFetch.mockImplementation(async (path, init) => {
      const body = init?.body;
      requests.push({
        path: String(path),
        body: typeof body === "string" ? JSON.parse(body) : body
      });
      if (path === "/auth/login/methods") {
        return {
          preferred: "pin",
          passkeyAvailable: false,
          passwordFallback: true,
          recoveryAvailable: false,
          smsLogin: false
        };
      }
      if (path === "/auth/login/password") {
        throw new ApiRequestError(401, "The account credentials are invalid.", {
          code: "auth_credentials_invalid"
        });
      }
      throw new Error(`Unexpected request to ${path}`);
    });

    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    // Enter in the phone field moves on, as the button does.
    await act(async () => {
      inputByLabel("Phone number").form!.requestSubmit();
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    });
    await click(buttonByText("Use a password"));
    expect(document.body.textContent).toContain("Enter the password for this account.");
    expect(document.body.textContent).not.toContain("recovery password");
    const password = inputByLabel("Password");
    await change(password, "correct horse battery");
    expect(password.form).not.toBeNull();
    await act(async () => {
      password.form!.requestSubmit();
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    });

    const login = requests.find((request) => request.path === "/auth/login/password");
    expect(login?.body).toMatchObject({ password: "correct horse battery" });
  });

  it("does not submit an empty password on Enter", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") {
        return {
          preferred: "pin",
          passkeyAvailable: false,
          passwordFallback: true,
          recoveryAvailable: false,
          smsLogin: false
        };
      }
      throw new Error(`Unexpected request to ${path}`);
    });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Continue to log in"));
    await click(buttonByText("Use a password"));
    await act(async () => {
      inputByLabel("Password").form!.requestSubmit();
      await Promise.resolve();
    });
    expect(mockedApiFetch.mock.calls.map(([path]) => path)).not.toContain("/auth/login/password");
  });
  it("keeps email verification valid when retrying a password reset after an MFA error", async () => {
    let resets = 0;
    const completedSession = { account: { id: "recovered" } };
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods")
        return { recoveryAvailable: true, passwordFallback: true };
      if (path === "/auth/recovery/start")
        return {
          transactionId: "email-recovery",
          developmentCode: "123456",
          message: "Check your email."
        };
      if (path === "/auth/recovery/verify") return { verified: true };
      if (path === "/auth/recovery/reset-password") {
        if (++resets === 1)
          throw new ApiRequestError(401, "Check your authenticator code.", {
            code: "mfa_code_invalid"
          });
        return completedSession;
      }
      throw new Error(`Unexpected request to ${path}`);
    });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Trouble logging in?"));
    const select = document.querySelector("select")!;
    await act(async () => {
      select.value = "email";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      const reset = document.querySelectorAll("select")[1]!;
      reset.value = "password";
      reset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await change(inputByLabel("Backup email"), "backup@example.test");
    await click(buttonByText("Send email recovery code"));
    await change(inputByLabel("Password"), "secure new password");
    await change(inputByLabel("Confirm password"), "secure new password");
    await change(inputByLabel("MFA code"), "111111");
    await click(buttonByText("Reset password"));
    expect(onAuthenticated).not.toHaveBeenCalled();
    await change(inputByLabel("MFA code"), "222222");
    await click(buttonByText("Reset password"));
    expect(onAuthenticated).toHaveBeenCalledWith(completedSession);
    expect(
      mockedApiFetch.mock.calls.filter(([path]) => path === "/auth/recovery/verify")
    ).toHaveLength(1);
  });
  it("recovers a PIN through email and retries MFA without reusing the email code", async () => {
    let resets = 0;
    const completed = { account: { id: "email-pin-owner" } };
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") return { recoveryAvailable: true };
      if (path === "/auth/recovery/start")
        return { transactionId: "pin-proof", message: "Check your email." };
      if (path === "/auth/recovery/verify") return { verified: true };
      if (path === "/auth/recovery/reset-pin") {
        if (++resets === 1)
          throw new ApiRequestError(401, "Enter your MFA code.", { code: "mfa_required" });
        return completed;
      }
      throw new Error(`Unexpected ${path}`);
    });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Trouble logging in?"));
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "email";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await change(inputByLabel("Backup email"), "backup@example.test");
    await click(buttonByText("Send email recovery code"));
    expect(host.textContent).toContain("New 4-digit PIN");
    expect(host.textContent).not.toContain("Reset password");
    await change(inputByLabel("Verification code"), "483921");
    await change(inputByLabel("New 4-digit PIN"), "8246");
    await change(inputByLabel("Confirm new PIN"), "7392");
    expect(buttonByText("Reset PIN").disabled).toBe(true);
    await change(inputByLabel("Confirm new PIN"), "8246");
    await click(buttonByText("Reset PIN"));
    expect(onAuthenticated).not.toHaveBeenCalled();
    await change(inputByLabel("MFA code"), "483921");
    await click(buttonByText("Reset PIN"));
    expect(onAuthenticated).toHaveBeenCalledWith(completed);
    expect(
      mockedApiFetch.mock.calls.filter(([path]) => path === "/auth/recovery/verify")
    ).toHaveLength(1);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/recovery/reset-pin",
      expect.objectContaining({
        body: {
          transactionId: "pin-proof",
          pin: "8246",
          pinConfirmation: "8246",
          mfaCode: "483921"
        }
      })
    );
  });
});
