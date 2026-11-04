import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser";
import type { AuthSessionView, PasskeySummary } from "@grogoni/shared-types";
import { apiFetch, ApiRequestError } from "./lib/api";
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
      return { supported: true, platform: capability.screenLock };
    } catch {
      return { supported: false, platform: false };
    }
  }
  if (!browserSupportsWebAuthn() || !globalThis.isSecureContext)
    return { supported: false, platform: false };
  try {
    return { supported: true, platform: await platformAuthenticatorIsAvailable() };
  } catch {
    return { supported: true, platform: false };
  }
}

export async function deviceSecurityAvailable(): Promise<boolean> {
  return (await deviceSecurityCapability()).supported;
}

/** Called only by an explicit enrollment action after authentication. WebAuthn holds the key. */
export async function enrollRecoveryPasskey(): Promise<PasskeySummary | null> {
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
  const challenge = await apiFetch<{
    ceremonyId: string;
    options: Parameters<typeof startRegistration>[0]["optionsJSON"];
  }>("/auth/passkeys/register/options", { method: "POST", body: {}, skipAuthRefresh: true });
  const response = await startRegistration({ optionsJSON: challenge.options });
  return apiFetch<PasskeySummary>("/auth/passkeys/register/verify", {
    method: "POST",
    body: { ceremonyId: challenge.ceremonyId, response, label: "Device security recovery" },
    skipAuthRefresh: true
  });
}

/** Discoverable credentials avoid disclosing whether a supplied phone account exists. */
export async function recoverWithPasskey(identifier: string): Promise<AuthSessionView> {
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
  try {
    const challenge = await apiFetch<{
      ceremonyId: string;
      options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
    }>("/auth/passkeys/login/options", {
      method: "POST",
      body: { purpose: "pin_recovery", identifier },
      skipAuthRefresh: true
    });
    const response = await startAuthentication({ optionsJSON: challenge.options });
    return await apiFetch<AuthSessionView>("/auth/passkeys/login/verify", {
      method: "POST",
      body: { ceremonyId: challenge.ceremonyId, response },
      skipAuthRefresh: true
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "passkey_unknown") {
      throw new Error(
        "Device recovery is not set up. Use your verified backup email or another registered recovery method."
      );
    }
    if (
      error instanceof Error &&
      (error.name === "NotAllowedError" || error.name === "WebAuthnError")
    ) {
      throw new Error(
        "Device unlock was cancelled or no registered passkey was available. Try again or use your verified backup email."
      );
    }
    throw error;
  }
}
