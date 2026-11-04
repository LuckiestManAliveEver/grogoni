import type { AuthSessionView } from "@grogoni/shared-types";
import { apiFetch } from "./lib/api";
import { deviceMessagingAdapter, isNativeDeviceHost } from "./device-messaging";

export async function deviceSecurityCapability(): Promise<{
  supported: boolean;
  platform: boolean;
}> {
  if (isNativeDeviceHost()) {
    try {
      const capability = await deviceMessagingAdapter.call<{ screenLock: boolean }>(
        "deviceSecurity"
      );
      return { supported: capability.screenLock, platform: capability.screenLock };
    } catch {
      return { supported: false, platform: false };
    }
  }
  return { supported: false, platform: false };
}

export async function deviceSecurityAvailable(): Promise<boolean> {
  return (await deviceSecurityCapability()).supported;
}

/** Enroll an account-bound native key protected by the existing device screen lock. */
export async function enrollDeviceRecovery(): Promise<null> {
  if (isNativeDeviceHost()) {
    const key = await deviceMessagingAdapter.call<{ publicKeyJwk: JsonWebKey; accountId: string }>(
      "prepareRecoveryKey"
    );
    const enrolled = await apiFetch<AuthSessionView & { deviceRecoveryCredentialId: string }>(
      "/auth/continue",
      {
        method: "POST",
        body: { devicePublicKeyJwk: key.publicKeyJwk, deviceSecurity: true },
        skipAuthRefresh: true
      }
    );
    if (enrolled.account.id !== key.accountId)
      throw new Error("Account changed. Sign in again before securing this device.");
    await deviceMessagingAdapter.call("commitRecoveryKey", {
      credentialId: enrolled.deviceRecoveryCredentialId
    });
    return null;
  }
  throw new Error(
    "Enable device recovery in the Android app. Use verified backup email in a browser."
  );
}

/** Require an OS-verified signature from the previously secured device. */
export async function recoverWithDeviceSecurity(identifier: string): Promise<AuthSessionView> {
  if (isNativeDeviceHost()) {
    const key = await deviceMessagingAdapter.call<{ accountId: string; credentialId: string }>(
      "recoveryCredential",
      { identifier }
    );
    const challenge = await apiFetch<Record<string, unknown>>("/auth/device/recover/options", {
      method: "POST",
      body: { credentialId: key.credentialId, identifier },
      skipAuthRefresh: true
    });
    const assertion = await deviceMessagingAdapter.call<Record<string, unknown>>(
      "signRecoveryChallenge",
      { identifier, challenge }
    );
    const recovered = await apiFetch<AuthSessionView>("/auth/device/recover", {
      method: "POST",
      body: assertion,
      skipAuthRefresh: true
    });
    if (
      recovered.account.id !== key.accountId ||
      recovered.account.primaryAuthDestination !== identifier
    )
      throw new Error("Use the device previously secured for this phone account.");
    return recovered;
  }
  throw new Error(
    "Device unlock recovery is available in the Android app. Use your verified backup email."
  );
}
