import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../apps/web/src/device-messaging", () => ({
  isNativeDeviceHost: () => false,
  deviceMessagingAdapter: { call: vi.fn() }
}));
vi.mock("../apps/web/src/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../apps/web/node_modules/@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));
const { apiFetch } = await import("../apps/web/src/lib/api");
const { startAuthentication, startRegistration } =
  await import("../apps/web/node_modules/@simplewebauthn/browser");
const { deviceSecurityCapability, enrollDeviceRecovery, recoverWithDeviceSecurity } =
  await import("../apps/web/src/passkey-recovery");

afterEach(() => vi.clearAllMocks());

describe("browser device security recovery", () => {
  it("does not advertise browser passkeys as device screen-lock recovery", async () => {
    expect(await deviceSecurityCapability()).toEqual({ supported: false, platform: false });
  });

  it("never opens a passkey picker or enrolls a passkey for device recovery", async () => {
    await expect(recoverWithDeviceSecurity("+254712345678")).rejects.toThrow(
      /verified backup email/u
    );
    await expect(enrollDeviceRecovery()).rejects.toThrow(/Android app/u);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(startRegistration).not.toHaveBeenCalled();
  });
});
