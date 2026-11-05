// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import PhoneSignup from "../apps/web/src/PhoneSignup";
import { PwaPasskeySetup } from "../apps/web/src/PwaPasskeySetup";
import { ApiRequestError, apiFetch } from "../apps/web/src/lib/api";
import type * as ApiModule from "../apps/web/src/lib/api";
import { createBrowserPasskey } from "../apps/web/src/browser-passkeys";
vi.mock("../apps/web/src/browser-passkeys", () => ({
  browserSupportsWebAuthn: () => true,
  createBrowserPasskey: vi.fn()
}));
vi.mock("../apps/web/src/device-messaging", () => ({
  isNativeDeviceHost: () => false,
  deviceMessagingAdapter: { call: vi.fn() }
}));
vi.mock("../apps/web/src/lib/api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  apiFetch: vi.fn()
}));
let host: HTMLDivElement;
let root: Root;
const onAuthenticated = vi.fn();
const session = { account: { id: "account-a" } };
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function button(text: string) {
  const found = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  );
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function fill(label: string, value: string) {
  const input = Array.from(host.querySelectorAll("label"))
    .find((l) => l.textContent?.includes(label))!
    .querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("offers passkey creation after PWA signup, retains the step on cancellation, and completes after registration", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/auth/signup/start") return { transactionId: "signup" };
    if (path === "/auth/signup/complete") return session;
    throw new Error(`Unexpected ${path}`);
  });
  vi.mocked(createBrowserPasskey)
    .mockRejectedValueOnce(new Error("Cancelled"))
    .mockResolvedValueOnce({ id: "passkey" } as never);
  await act(async () =>
    root.render(
      <PhoneSignup onAuthenticated={onAuthenticated} onLogIn={vi.fn()} onCancel={vi.fn()} />
    )
  );
  await fill("Phone number", "0712345678");
  await click("Continue");
  await fill("Display name", "Jane");
  await fill("Password", "secure password");
  await fill("Confirm password", "secure password");
  await act(async () => {
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      input.click();
  });
  await click("Create account");
  expect(onAuthenticated).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Create your passkey");
  expect(host.textContent).not.toContain("Secure this device");
  await click("Create passkey");
  expect(host.textContent).toContain("Cancelled");
  expect(onAuthenticated).not.toHaveBeenCalled();
  await click("Create passkey");
  expect(onAuthenticated).toHaveBeenCalledWith(session);
});
it("lets existing accounts without passkeys create one without a shop", async () => {
  vi.mocked(apiFetch).mockResolvedValue({ passkeys: [] });
  vi.mocked(createBrowserPasskey).mockResolvedValue({ id: "passkey" } as never);
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  await click("Create passkey");
  expect(createBrowserPasskey).toHaveBeenCalledOnce();
  expect(host.textContent).toBe("");
});
function staleSession() {
  return new ApiRequestError(401, "Your session has expired. Sign in again.", {
    code: "recent_authentication_required"
  });
}
function mockAccount(status: { hasPin: boolean; hasPassword: boolean }) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === "/auth/passkeys") return { passkeys: [] };
    if (path === "/auth/credentials/status") return status;
    if (path === "/auth/password/verify" || path === "/auth/pin/verify") return session;
    throw new Error(`Unexpected ${path}`);
  });
}
it("asks an old session for its password, then creates the passkey", async () => {
  mockAccount({ hasPin: false, hasPassword: true });
  vi.mocked(createBrowserPasskey)
    .mockRejectedValueOnce(staleSession())
    .mockResolvedValueOnce({ id: "passkey" } as never);
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  await click("Create passkey");
  expect(host.textContent).not.toContain("expired");
  await fill("Enter your password", "secure password");
  await click("Continue");
  expect(apiFetch).toHaveBeenCalledWith("/auth/password/verify", {
    method: "POST",
    body: { password: "secure password" }
  });
  expect(createBrowserPasskey).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("");
});
it("prefers the PIN and can switch to the password", async () => {
  mockAccount({ hasPin: true, hasPassword: true });
  vi.mocked(createBrowserPasskey)
    .mockRejectedValueOnce(staleSession())
    .mockResolvedValueOnce({ id: "passkey" } as never);
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  await click("Create passkey");
  expect(host.textContent).toContain("Enter your PIN");
  await click("Use your password instead");
  await fill("Enter your password", "secure password");
  await click("Continue");
  expect(apiFetch).toHaveBeenCalledWith("/auth/password/verify", expect.anything());
});
it("keeps the form and shows the error when the password is wrong", async () => {
  mockAccount({ hasPin: false, hasPassword: true });
  vi.mocked(createBrowserPasskey).mockRejectedValueOnce(staleSession());
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  await click("Create passkey");
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ hasPin: false, hasPassword: true })
    .mockRejectedValueOnce(new Error("That password is not correct."));
  await fill("Enter your password", "wrong password");
  await click("Continue");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("not correct");
  expect(host.textContent).toContain("Enter your password");
  expect(createBrowserPasskey).toHaveBeenCalledOnce();
});
it("never sends an account with no PIN or password to sign out", async () => {
  mockAccount({ hasPin: false, hasPassword: false });
  vi.mocked(createBrowserPasskey).mockRejectedValueOnce(staleSession());
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  await click("Create passkey");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "You can add a passkey within 15 minutes of signing in."
  );
  expect(host.textContent).not.toMatch(/sign out|log out/iu);
  expect(host.querySelector("a")).toBeNull();
});
it("asks for the PIN when a session was never PIN-verified", async () => {
  mockAccount({ hasPin: true, hasPassword: false });
  vi.mocked(createBrowserPasskey)
    .mockRejectedValueOnce(
      new ApiRequestError(401, "Login PIN verification is required.", { code: "pin_required" })
    )
    .mockResolvedValueOnce({ id: "passkey" } as never);
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  await click("Create passkey");
  await fill("Enter your PIN", "1234");
  await click("Continue");
  expect(apiFetch).toHaveBeenCalledWith("/auth/pin/verify", {
    method: "POST",
    body: { pin: "1234" }
  });
  expect(host.textContent).toBe("");
});
it("does not prompt existing accounts that already have a passkey", async () => {
  vi.mocked(apiFetch).mockResolvedValue({ passkeys: [{ id: "existing-passkey" }] });
  await act(async () => root.render(<PwaPasskeySetup accountId="existing" />));
  expect(host.textContent).toBe("");
});
