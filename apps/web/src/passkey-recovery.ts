import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser";
import type { AuthSessionView, PasskeySummary } from "@grogoni/shared-types";
import { apiFetch, ApiRequestError } from "./lib/api";

export async function deviceSecurityCapability(): Promise<{
  supported: boolean;
  platform: boolean;
}> {
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
export async function enrollRecoveryPasskey(): Promise<PasskeySummary> {
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
