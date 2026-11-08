import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type {
  RecoveryApprovalOptionsResponse,
  RecoveryApprovalPendingResponse,
  RecoveryApprovalStartResponse,
  RecoveryApprovalStatusResponse
} from "@grogoni/shared-types";
import { apiFetch } from "./lib/api";
import { deviceMessagingAdapter, isNativeDeviceHost } from "./device-messaging";

/**
 * Trusted-device recovery approval. The signed-out browser starts a request and shows a code. The
 * owner types it on a device that is still signed in and confirms with that device's screen lock.
 * See docs/authentication/trusted-device-recovery-approval.md.
 */

// Signed-out browser side.

export function startRecoveryApproval(identifier: string): Promise<RecoveryApprovalStartResponse> {
  return apiFetch<RecoveryApprovalStartResponse>("/auth/recovery/device-approval/start", {
    method: "POST",
    body: { identifier },
    skipAuthRefresh: true
  });
}

export function recoveryApprovalStatus(
  request: Pick<RecoveryApprovalStartResponse, "transactionId" | "pollSecret">
): Promise<RecoveryApprovalStatusResponse> {
  return apiFetch<RecoveryApprovalStatusResponse>("/auth/recovery/device-approval/status", {
    method: "POST",
    body: { transactionId: request.transactionId, pollSecret: request.pollSecret },
    skipAuthRefresh: true
  });
}

/** "482915" → "482 915", easier to read aloud and to type. */
export function formatApprovalCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

// Trusted, signed-in device side.

export function pendingRecoveryApprovals(): Promise<RecoveryApprovalPendingResponse> {
  return apiFetch<RecoveryApprovalPendingResponse>("/auth/recovery/device-approval/pending");
}

export function declineRecoveryApproval(requestId: string): Promise<{ declined: true }> {
  return apiFetch<{ declined: true }>("/auth/recovery/device-approval/decline", {
    method: "POST",
    body: { requestId }
  });
}

/** The Android recovery key for this phone, when this is the app and the key is set up. */
async function nativeApprovalKey(phone: string): Promise<string | null> {
  if (!isNativeDeviceHost()) return null;
  try {
    const key = await deviceMessagingAdapter.call<{ credentialId: string | null }>(
      "recoveryCredential",
      { identifier: phone }
    );
    return typeof key.credentialId === "string" && key.credentialId.length > 0
      ? key.credentialId
      : null;
  } catch {
    return null;
  }
}

export type ApprovalMethodAvailability =
  { method: "device"; credentialId: string } | { method: "passkey" } | { method: null };

/** Android screen-lock key first, then a passkey in this browser. */
export async function recoveryApprovalMethod(phone: string): Promise<ApprovalMethodAvailability> {
  const credentialId = await nativeApprovalKey(phone);
  if (credentialId !== null) return { method: "device", credentialId };
  return browserSupportsWebAuthn() ? { method: "passkey" } : { method: null };
}

/** Step 1: checks the typed code. Returns which browser asked, and its screen-lock challenge. */
export function checkRecoveryApprovalCode(input: {
  code: string;
  method: Exclude<ApprovalMethodAvailability, { method: null }>;
}): Promise<RecoveryApprovalOptionsResponse> {
  return apiFetch<RecoveryApprovalOptionsResponse>("/auth/recovery/device-approval/options", {
    method: "POST",
    body: {
      code: input.code,
      method: input.method.method,
      ...(input.method.method === "device" ? { credentialId: input.method.credentialId } : {})
    }
  });
}

/**
 * Step 2, after the owner has seen which browser asked: this device's screen lock confirms
 * (fingerprint, face or screen-lock PIN). The prompt appears here, never on the other browser.
 */
export async function confirmRecoveryApproval(
  options: RecoveryApprovalOptionsResponse,
  phone: string
): Promise<void> {
  if (options.method === "device") {
    const assertion = await deviceMessagingAdapter.call<{
      challengeId: string;
      credentialId: string;
      issuedAt: number;
      nonce: string;
      signature: string;
    }>("signRecoveryChallenge", { identifier: phone, challenge: options.challenge });
    await apiFetch("/auth/recovery/device-approval/approve", {
      method: "POST",
      body: { requestId: options.requestId, method: "device", ...assertion }
    });
    return;
  }
  const response = await startAuthentication({
    optionsJSON: options.options as unknown as PublicKeyCredentialRequestOptionsJSON
  });
  await apiFetch("/auth/recovery/device-approval/approve", {
    method: "POST",
    body: {
      requestId: options.requestId,
      method: "passkey",
      ceremonyId: options.ceremonyId,
      response
    }
  });
}
