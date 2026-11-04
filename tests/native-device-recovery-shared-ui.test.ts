import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "../apps/web/src/lib/api";
vi.mock("../apps/web/src/device-messaging", () => ({
  isNativeDeviceHost: () => true,
  deviceMessagingAdapter: { call: vi.fn() }
}));
vi.mock("../apps/web/src/lib/api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  apiFetch: vi.fn()
}));
const { apiFetch } = await import("../apps/web/src/lib/api");
const { deviceMessagingAdapter } = await import("../apps/web/src/device-messaging");
const { enrollDeviceRecovery, recoverWithDeviceSecurity } =
  await import("../apps/web/src/passkey-recovery");
const account = { id: "account-a", primaryAuthDestination: "+15551234567" };
beforeEach(() => vi.resetAllMocks());
describe("native recovery through the shared authentication workflow", () => {
  it("uses the native public key while the shared code performs backend enrollment", async () => {
    vi.mocked(deviceMessagingAdapter.call)
      .mockResolvedValueOnce({ publicKeyJwk: { kty: "EC" }, accountId: account.id })
      .mockResolvedValueOnce({});
    vi.mocked(apiFetch).mockResolvedValueOnce({
      account,
      deviceRecoveryCredentialId: "credential-a"
    });
    await enrollDeviceRecovery();
    expect(apiFetch).toHaveBeenCalledWith("/auth/continue", {
      method: "POST",
      body: { devicePublicKeyJwk: { kty: "EC" }, deviceSecurity: true },
      skipAuthRefresh: true
    });
    expect(deviceMessagingAdapter.call).toHaveBeenLastCalledWith("commitRecoveryKey", {
      credentialId: "credential-a"
    });
  });
  it("refuses to commit enrollment after the account changes", async () => {
    vi.mocked(deviceMessagingAdapter.call).mockResolvedValueOnce({
      publicKeyJwk: {},
      accountId: account.id
    });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      account: { ...account, id: "other" },
      deviceRecoveryCredentialId: "credential-a"
    });
    await expect(enrollDeviceRecovery()).rejects.toThrow("Account changed");
    expect(deviceMessagingAdapter.call).toHaveBeenCalledTimes(1);
  });
  it("requires the OS-verified signature before submitting recovery proof", async () => {
    const challenge = { challengeId: "one-use", issuedAt: 123, nonce: "nonce" };
    const assertion = { ...challenge, credentialId: "credential-a", signature: "os-signature" };
    vi.mocked(deviceMessagingAdapter.call)
      .mockResolvedValueOnce({ accountId: account.id, credentialId: "credential-a" })
      .mockResolvedValueOnce(assertion);
    vi.mocked(apiFetch).mockResolvedValueOnce(challenge).mockResolvedValueOnce({ account });
    await expect(recoverWithDeviceSecurity(account.primaryAuthDestination)).resolves.toEqual({
      account
    });
    expect(deviceMessagingAdapter.call).toHaveBeenLastCalledWith("signRecoveryChallenge", {
      identifier: account.primaryAuthDestination,
      challenge
    });
    expect(apiFetch).toHaveBeenLastCalledWith("/auth/device/recover", {
      method: "POST",
      body: assertion,
      skipAuthRefresh: true
    });
  });
  it("does not submit a recovery request if device unlock is cancelled", async () => {
    vi.mocked(deviceMessagingAdapter.call)
      .mockResolvedValueOnce({ accountId: account.id, credentialId: "credential-a" })
      .mockRejectedValueOnce(new Error("Device unlock cancelled"));
    vi.mocked(apiFetch).mockResolvedValueOnce({
      challengeId: "one-use",
      issuedAt: 123,
      nonce: "nonce"
    });
    await expect(recoverWithDeviceSecurity(account.primaryAuthDestination)).rejects.toThrow(
      "cancelled"
    );
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a successful response for a different account", async () => {
    vi.mocked(deviceMessagingAdapter.call)
      .mockResolvedValueOnce({ accountId: account.id, credentialId: "credential-a" })
      .mockResolvedValueOnce({ signature: "os-signature" });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ account: { ...account, id: "other" } });
    await expect(recoverWithDeviceSecurity(account.primaryAuthDestination)).rejects.toThrow(
      "previously secured"
    );
  });
});
