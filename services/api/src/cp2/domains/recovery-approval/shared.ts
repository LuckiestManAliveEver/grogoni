/**
 * Trusted-device recovery approval. A signed-out browser asks a device that is still signed in
 * to the same phone account to vouch for it. The request is an auth transaction
 * (purpose "recovery"), so it persists through the same snapshot path as every other recovery
 * proof and needs no migration. Every field below lives in that transaction's metadata.
 *
 * Contract: packages/shared-types/src/recovery-approval.ts.
 * Design and threat model: docs/authentication/trusted-device-recovery-approval.md.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** How long the browser's request stays open for the owner to approve it. */
export const recoveryApprovalTtlMs = 10 * 60_000;
/** After approval, how long the browser has to collect its session. */
export const recoveryApprovalCollectMs = 2 * 60_000;
/** How long a device-security challenge on the trusted device stays valid. */
export const recoveryApprovalChallengeTtlMs = 2 * 60_000;
/** Wrong codes allowed across an account's open requests before they are cancelled. */
export const recoveryApprovalMaxCodeAttempts = 5;
/** Open requests per phone number. When full, new requests are refused; none is cancelled. */
export const recoveryApprovalMaxOpenPerIdentifier = 10;
/** Requests one requester (client address) may start for one number in any 10 minutes. */
export const recoveryApprovalMaxStartsPerClient = 5;
/**
 * After the browser gets in, its probation: for this long it cannot sign out other devices or
 * remove credentials, nothing enrolled since can approve, and the owner can undo the whole login.
 */
export const recoveryApprovalUndoMs = 24 * 60 * 60_000;
export const recoveryApprovalPollIntervalMs = 4_000;

export type RecoveryApprovalStatus = "pending" | "approved" | "declined";

/** Metadata keys on the auth transaction. Kept in one place so nothing else collides with them. */
export const approvalKeys = {
  marker: "recoveryApprovalRequest",
  status: "recoveryApprovalStatus",
  secretHash: "recoveryApprovalSecretHash",
  codeHash: "recoveryApprovalCodeHash",
  client: "recoveryApprovalClient",
  credentialId: "recoveryApprovalCredentialId",
  approvedAt: "recoveryApprovalApprovedAt",
  challengeId: "recoveryApprovalChallengeId",
  challengeNonce: "recoveryApprovalChallengeNonce",
  challengeIssuedAt: "recoveryApprovalChallengeIssuedAt",
  challengeCredentialId: "recoveryApprovalChallengeCredentialId",
  challengeSessionId: "recoveryApprovalChallengeSessionId",
  ceremonyId: "recoveryApprovalCeremonyId",
  clientKey: "recoveryApprovalClientKey",
  approverSessionId: "recoveryApprovalApproverSessionId",
  collectedSessionId: "recoveryApprovalCollectedSessionId",
  collectedFamilyId: "recoveryApprovalCollectedFamilyId",
  collectedAt: "recoveryApprovalCollectedAt",
  credentialSnapshot: "recoveryApprovalCredentialSnapshot",
  trustedFamilies: "recoveryApprovalTrustedFamilies"
} as const;

/**
 * Who started a request, for per-requester limits: a hash of the client address, never the
 * address itself. On Edge the API runs behind `inject`, so the address is the first
 * x-forwarded-for entry, the same one the Edge rate limiter counts (rate-limit.ts).
 */
export function approvalClientKey(forwardedFor: string | undefined, ip: string): string {
  const address = forwardedFor?.split(",")[0]?.trim() || ip;
  return createHash("sha256").update(`grogoni-recovery-approval-client:${address}`).digest("hex");
}

export function createApprovalCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function createApprovalSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createApprovalNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** Bound to the request id, so one request's code hash says nothing about another's. */
export function hashApprovalValue(requestId: string, value: string): string {
  return createHash("sha256")
    .update(`grogoni-recovery-approval:${requestId}:${value}`)
    .digest("hex");
}

export function approvalHashMatches(expected: unknown, requestId: string, value: string): boolean {
  if (typeof expected !== "string" || expected.length !== 64) return false;
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(hashApprovalValue(requestId, value), "hex")
  );
}

/** Accepts "482 915", "482-915" and "482915". Anything else is not a code. */
export function normalizeApprovalCode(value: string): string | null {
  const digits = value.replace(/[\s-]/gu, "");
  return /^\d{6}$/u.test(digits) ? digits : null;
}

/**
 * A short label the owner can recognise ("Chrome on Android"). Only from the user agent the
 * requesting browser sent, so it is a hint, never proof: the code is the proof.
 */
export function describeApprovalClient(userAgent: string | undefined): string {
  const agent = userAgent ?? "";
  const browser = /EdgA?\//u.test(agent)
    ? "Edge"
    : /SamsungBrowser\//u.test(agent)
      ? "Samsung Internet"
      : /OPR\/|Opera/u.test(agent)
        ? "Opera"
        : /Firefox\/|FxiOS\//u.test(agent)
          ? "Firefox"
          : /Chrome\/|CriOS\//u.test(agent)
            ? "Chrome"
            : /Safari\//u.test(agent)
              ? "Safari"
              : "A browser";
  const platform = /Android/u.test(agent)
    ? "Android"
    : /iPhone/u.test(agent)
      ? "iPhone"
      : /iPad/u.test(agent)
        ? "iPad"
        : /Windows/u.test(agent)
          ? "Windows"
          : /Mac OS X|Macintosh/u.test(agent)
            ? "Mac"
            : /CrOS/u.test(agent)
              ? "ChromeOS"
              : /Linux/u.test(agent)
                ? "Linux"
                : null;
  return platform === null ? browser : `${browser} on ${platform}`;
}
