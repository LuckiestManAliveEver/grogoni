/**
 * Fourteenth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns `otpChallenges`,
 * `smsDeliveryAttempts`, and the purely in-memory (never persisted) `otpRequestHistory`
 * rate-limit tracker - the third slice carved out of the "core auth/identity/session kernel",
 * following the same standard rows 11 (Passkeys) and 12 (OAuth) established: investigate the
 * actual coupling, don't assume it either way.
 *
 * **The core risk - does OTP completion write `sessions`/`accounts` directly - was investigated
 * and the answer is no**, matching rows 11 and 12 exactly. `completeOtpVerification` resolves or
 * creates the account via `createAccount`/`requireAccount` callbacks and produces the session via
 * a `createSession` callback, the same "call back up" pattern used throughout this whole effort.
 *
 * **The one genuinely new wrinkle this row hit**: three methods elsewhere in `Cp2Store`
 * (`verifyEmailRecovery`, `verifyEmailIdentityMerge`, `verifyPendingEmail` - part of the
 * email-recovery / identity-merge / pending-email-verification cluster, not OTP itself) read and
 * mutate `otpChallenges` records directly, with their own inlined copies of
 * `validateOtpChallenge`'s checks that are subtly different from it (they additionally compare
 * `purpose`/`channel`/`destination` against the caller's own transaction, which `OtpDomain`'s
 * `validateOtpChallenge` has no reason to know about). Rather than force those three methods
 * through new OTP-domain primitives that would have to faithfully replicate their
 * already-slightly-divergent validation rules - real design work, not mechanical extraction -
 * they keep raw mutation access via a `otpChallengesMap` getter, the same escape hatch already
 * used for `deleteShopOwnedData`'s OAuth-token redaction (row 12) and for the mutable getters
 * `CommerceDomain`/`MessagingDomain` hold onto `SalesDomain`'s Maps (row 9).
 */
import type { AuthChannel, AuthSessionView } from "@grogoni/shared-types";

export const maxOtpAttempts = 5;
export const maxPendingOtpChallenges = 10_000;

export interface OtpChallenge {
  id: string;
  channel: AuthChannel;
  destination: string;
  purpose: "signup" | "recovery";
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  verifiedAt: string | null;
  consumedAt?: string | null;
  resendCount?: number;
  nextResendAt?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  createdAt: string;
}

/** Historical delivery records retained only so old database snapshots remain readable. */
export interface SmsDeliveryAttemptRecord {
  id: string;
  challengeId: string;
  provider: string;
  providerMessageId: string | null;
  status: "accepted" | "delivered" | "failed" | "rejected" | "unknown";
  errorCode: string | null;
  attemptNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface OtpChallengeDelivery {
  challengeId: string;
  channel: AuthChannel;
  destination: string;
  purpose: "signup" | "recovery";
  expiresAt: string;
}

export interface OtpRequestResult {
  challengeId: string;
  destination: string;
  expiresAt: string;
  devOtp: string;
}

export interface VerifyOtpResult extends AuthSessionView {
  resumed: boolean;
}
