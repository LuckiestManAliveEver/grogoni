import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { AuthSessionView, PasskeySummary } from "@grogoni/shared-types";
import type { PasskeyRegistrationOptionsResponse } from "./grogoni-application-shared";
import { apiFetch } from "./lib/api";
import { invalidateApiCacheForMutation } from "./api-request-cache";

export { browserSupportsWebAuthn };

export async function createBrowserPasskey(
  label = `${navigator.platform || "This browser"} passkey`
): Promise<PasskeySummary> {
  if (!browserSupportsWebAuthn())
    throw new Error(
      "Passkeys are not supported in this browser. Use your password or verified backup email."
    );
  const challenge = await apiFetch<PasskeyRegistrationOptionsResponse>(
    "/auth/passkeys/register/options",
    { method: "POST", body: {} }
  );
  const response = await startRegistration({ optionsJSON: challenge.options });
  const passkey = await apiFetch<PasskeySummary>("/auth/passkeys/register/verify", {
    method: "POST",
    body: {
      ceremonyId: challenge.ceremonyId,
      label,
      response
    }
  });
  await invalidateApiCacheForMutation("/auth/passkeys/register/verify");
  return passkey;
}

export async function loginWithBrowserPasskey(identifier: string): Promise<AuthSessionView> {
  return authenticateBrowserPasskey(identifier, "login");
}

export async function recoverWithBrowserPasskey(identifier: string): Promise<AuthSessionView> {
  return authenticateBrowserPasskey(identifier, "pin_recovery");
}

async function authenticateBrowserPasskey(
  identifier: string,
  purpose: "login" | "pin_recovery"
): Promise<AuthSessionView> {
  if (!browserSupportsWebAuthn())
    throw new Error("Passkeys are not supported in this browser. Use your verified backup email.");
  const challenge = await apiFetch<{
    ceremonyId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/auth/passkeys/login/options", {
    method: "POST",
    body: { purpose, identifier },
    skipAuthRefresh: true
  });
  const response = await startAuthentication({ optionsJSON: challenge.options });
  const session = await apiFetch<AuthSessionView>("/auth/passkeys/login/verify", {
    method: "POST",
    body: { ceremonyId: challenge.ceremonyId, response },
    skipAuthRefresh: true
  });
  if (session.account.primaryAuthDestination !== identifier)
    throw new Error("Use a passkey registered for this phone account.");
  return session;
}
