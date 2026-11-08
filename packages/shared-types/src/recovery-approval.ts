/**
 * Trusted-device recovery approval: a signed-out browser asks a device that is still signed in
 * to vouch for it. See docs/authentication/trusted-device-recovery-approval.md.
 *
 * The browser shows a 6-digit code. The person types it on the trusted device and confirms with
 * that device's screen lock (an Android recovery key or a passkey). The browser then receives a
 * session with a one-use, five-minute recovery grant, which lets it create a passkey and reset
 * its PIN or password.
 */
import type { AuthSessionView } from "./index.js";

/** POST /auth/recovery/device-approval/start (signed-out browser). */
export interface RecoveryApprovalStartRequest {
  /** E.164 phone number of the account to recover. */
  identifier: string;
}

export interface RecoveryApprovalStartResponse {
  transactionId: string;
  /** Proves the poller is the browser that started the request. Never shown to the person. */
  pollSecret: string;
  /** Shown to the person, typed on the trusted device. */
  code: string;
  expiresAt: string;
  pollIntervalMs: number;
}

/** POST /auth/recovery/device-approval/status (signed-out browser). */
export interface RecoveryApprovalStatusRequest {
  transactionId: string;
  pollSecret: string;
}

export type RecoveryApprovalStatusResponse =
  | { status: "pending"; expiresAt: string }
  | { status: "declined" | "expired" }
  | ({ status: "approved" } & AuthSessionView);

/** A request awaiting the signed-in owner. The code is never listed: it must be typed. */
export interface RecoveryApprovalRequestSummary {
  requestId: string;
  /** Short browser and platform label, from the requesting browser's user agent. */
  client: string;
  requestedAt: string;
  expiresAt: string;
}

/** GET /auth/recovery/device-approval/pending (trusted, signed-in device). */
export interface RecoveryApprovalPendingResponse {
  requests: RecoveryApprovalRequestSummary[];
  /** The signed-in owner's own phone number, which keys this device's Android recovery key. */
  phone: string;
  /** Browsers let in during the last 24 hours, each of which the owner can still undo. */
  recentApprovals: RecoveryApprovalRecentSummary[];
}

export interface RecoveryApprovalRecentSummary {
  requestId: string;
  client: string;
  loggedInAt: string;
  /** Until then the browser is on probation and undo is available. */
  undoUntil: string;
}

export type RecoveryApprovalMethod = "device" | "passkey";

/** POST /auth/recovery/device-approval/options (trusted, signed-in device). */
export interface RecoveryApprovalOptionsRequest {
  code: string;
  method: RecoveryApprovalMethod;
  /** Required for `device`: this phone's Android recovery key id. */
  credentialId?: string;
}

export type RecoveryApprovalOptionsResponse = RecoveryApprovalRequestSummary &
  (
    | {
        method: "device";
        challenge: { challengeId: string; nonce: string; issuedAt: number; expiresAt: string };
      }
    | {
        method: "passkey";
        ceremonyId: string;
        /** PublicKeyCredentialRequestOptionsJSON for @simplewebauthn/browser. */
        options: Record<string, unknown>;
      }
  );

/** POST /auth/recovery/device-approval/approve (trusted, signed-in device). */
export type RecoveryApprovalApproveRequest =
  | {
      requestId: string;
      method: "device";
      credentialId: string;
      challengeId: string;
      nonce: string;
      issuedAt: number;
      signature: string;
    }
  | {
      requestId: string;
      method: "passkey";
      ceremonyId: string;
      /** AuthenticationResponseJSON from @simplewebauthn/browser. */
      response: Record<string, unknown>;
    };

export interface RecoveryApprovalApproveResponse {
  approved: true;
}

/** POST /auth/recovery/device-approval/decline (trusted, signed-in device). */
export interface RecoveryApprovalDeclineRequest {
  requestId: string;
}

export interface RecoveryApprovalDeclineResponse {
  declined: true;
}
