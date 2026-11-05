import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../apps/web/node_modules/@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));
vi.mock("../apps/web/src/lib/api", () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import("../apps/web/src/lib/api");
const { startAuthentication, startRegistration, browserSupportsWebAuthn } =
  await import("../apps/web/node_modules/@simplewebauthn/browser");
const { createBrowserPasskey, recoverWithBrowserPasskey } =
  await import("../apps/web/src/browser-passkeys");
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
  vi.stubGlobal("navigator", { platform: "Android" });
});
describe("browser passkey ceremonies", () => {
  it("registers only after the browser creates a credential", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ceremonyId: "register", options: { challenge: "nonce" } })
      .mockResolvedValueOnce({ id: "passkey" });
    vi.mocked(startRegistration).mockResolvedValue({ id: "credential" } as never);
    await expect(createBrowserPasskey()).resolves.toEqual({ id: "passkey" });
    expect(apiFetch).toHaveBeenLastCalledWith("/auth/passkeys/register/verify", {
      method: "POST",
      body: { ceremonyId: "register", label: "Android passkey", response: { id: "credential" } }
    });
  });
  it("does not register a cancelled credential", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ceremonyId: "register", options: {} });
    vi.mocked(startRegistration).mockRejectedValue(new Error("Cancelled"));
    await expect(createBrowserPasskey()).rejects.toThrow("Cancelled");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it("requests account-bound recovery proof rather than ordinary login", async () => {
    const session = { account: { primaryAuthDestination: "+254712345678" } };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ceremonyId: "recover", options: { userVerification: "required" } })
      .mockResolvedValueOnce(session);
    vi.mocked(startAuthentication).mockResolvedValue({ id: "proof" } as never);
    await expect(recoverWithBrowserPasskey("+254712345678")).resolves.toEqual(session);
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/auth/passkeys/login/options", {
      method: "POST",
      body: { purpose: "pin_recovery", identifier: "+254712345678" },
      skipAuthRefresh: true
    });
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { userVerification: "required" }
    });
  });
  it("rejects a different account and never resets credentials", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ceremonyId: "recover", options: {} })
      .mockResolvedValueOnce({ account: { primaryAuthDestination: "other" } });
    vi.mocked(startAuthentication).mockResolvedValue({} as never);
    await expect(recoverWithBrowserPasskey("+254712345678")).rejects.toThrow(
      "registered for this phone account"
    );
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
