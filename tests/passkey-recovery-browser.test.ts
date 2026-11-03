import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "../apps/web/src/lib/api";
import { ApiRequestError } from "../apps/web/src/lib/api";

vi.mock("../apps/web/node_modules/@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  platformAuthenticatorIsAvailable: vi.fn(async () => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));
vi.mock("../apps/web/src/lib/api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  apiFetch: vi.fn()
}));

const { apiFetch } = await import("../apps/web/src/lib/api");
const {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration
} = await import("../apps/web/node_modules/@simplewebauthn/browser");
const { deviceSecurityCapability, recoverWithPasskey } =
  await import("../apps/web/src/passkey-recovery");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("browser device security recovery", () => {
  it("distinguishes unsupported WebAuthn from a browser using another trusted authenticator", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.mocked(browserSupportsWebAuthn).mockReturnValueOnce(false);
    expect(await deviceSecurityCapability()).toEqual({ supported: false, platform: false });
    vi.mocked(platformAuthenticatorIsAvailable).mockResolvedValueOnce(false);
    expect(await deviceSecurityCapability()).toEqual({ supported: true, platform: false });
    expect(apiFetch).not.toHaveBeenCalled(); // Capability is never treated as enrollment or ownership.
  });

  it("does not create or verify a credential when the user cancels recovery", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ceremonyId: "one-use", options: {} });
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      new DOMException("Cancelled", "NotAllowedError")
    );
    await expect(recoverWithPasskey("+254712345678")).rejects.toThrow(
      /cancelled.*verified backup email/u
    );
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("explains missing or revoked enrollment and preserves the email fallback", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ceremonyId: "one-use", options: {} });
    vi.mocked(startAuthentication).mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof startAuthentication>>
    );
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiRequestError(401, "Unknown credential", { code: "passkey_unknown" })
    );
    await expect(recoverWithPasskey("+254712345678")).rejects.toThrow(
      /Device recovery is not set up.*verified backup email/u
    );
    expect(startRegistration).not.toHaveBeenCalled();
  });
});
