import { randomInt, randomUUID } from "node:crypto";
import type { AccountSummary, AuthChannel, SessionSummary, UserSummary } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { normalizeDestination } from "../../phone-identity.js";
import {
  destinationAccountKey,
  hashMatches,
  hashOtp,
  otpTtlMs,
  pinAttemptTrackerMaximumEntries,
  readBoundedSecurityInteger
} from "../../text-normalization.js";
import type { UserIdentityRecord } from "../../domain-contracts.js";
import {
  maxOtpAttempts,
  maxPendingOtpChallenges,
  type OtpChallenge,
  type OtpChallengeDelivery,
  type OtpRequestResult,
  type SmsDeliveryAttemptRecord,
  type VerifyOtpResult
} from "./shared.js";
import type { AccountIdentityRecord, Cp2Snapshot } from "../../store.js";

export interface OtpDomainDeps {
  findIdentityByVerifiedEmail: (email: string) => UserIdentityRecord | undefined;
  resolveIdentityAccount: (type: AuthChannel, normalizedValue: string) => string | undefined;
  resolveAnyIdentityAccount: (type: AuthChannel, normalizedValue: string) => string | undefined;
  createAccount: (
    channel: AccountSummary["primaryAuthChannel"],
    destination: string,
    now: Date
  ) => AccountSummary;
  requireAccount: (accountId: string) => AccountSummary;
  requireUser: (userId: string | undefined) => UserSummary;
  addAccountIdentity: (
    account: AccountSummary,
    user: UserSummary,
    type: AuthChannel,
    value: string,
    isPrimary: boolean,
    now: Date,
    verified: boolean
  ) => AccountIdentityRecord;
  createSession: (account: AccountSummary, user: UserSummary, now: Date) => SessionSummary;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  accountByDestination: Map<string, string>;
  userByAccount: Map<string, string>;
}

export class OtpDomain {
  private readonly otpChallenges = new Map<string, OtpChallenge>();
  private readonly smsDeliveryAttempts = new Map<string, SmsDeliveryAttemptRecord>();
  private readonly otpRequestHistory = new Map<string, number[]>();

  constructor(private readonly deps: OtpDomainDeps) {}

  /**
   * Mutable escape hatch for `Cp2Store`'s `verifyEmailRecovery`/`verifyEmailIdentityMerge`/
   * `verifyPendingEmail` - see this domain's `shared.ts` header comment for why those three keep
   * raw access instead of going through this domain's own validation.
   */
  get otpChallengesMap(): Map<string, OtpChallenge> {
    return this.otpChallenges;
  }

  get smsDeliveryAttemptsMap(): Map<string, SmsDeliveryAttemptRecord> {
    return this.smsDeliveryAttempts;
  }

  clear(): void {
    this.otpChallenges.clear();
    this.smsDeliveryAttempts.clear();
    this.otpRequestHistory.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const challenge of snapshot.otpChallenges ?? []) {
      this.otpChallenges.set(challenge.id, {
        ...challenge,
        purpose: challenge.purpose ?? "signup",
        consumedAt: challenge.consumedAt ?? null,
        resendCount: challenge.resendCount ?? 0,
        nextResendAt: challenge.nextResendAt ?? null,
        provider: challenge.provider ?? null,
        providerMessageId: challenge.providerMessageId ?? null
      });
    }

    for (const attempt of snapshot.smsDeliveryAttempts ?? []) {
      if (this.otpChallenges.has(attempt.challengeId)) {
        this.smsDeliveryAttempts.set(attempt.id, attempt);
      }
    }
  }

  requestOtp(input: {
    channel: AuthChannel;
    destination: string;
    purpose?: "signup" | "recovery";
    now?: Date;
  }): OtpRequestResult {
    if (input.channel === "phone") {
      throw new Cp2Error(
        403,
        "phone_pin_only",
        "Phone accounts use a PIN. SMS verification is not available."
      );
    }
    const now = input.now ?? new Date();
    const destination = normalizeDestination(input.channel, input.destination);
    const purpose = input.purpose ?? "signup";
    const requestKey = `${purpose}:${input.channel}:${destination}`;
    this.requireOtpRequestAllowed(requestKey, now);
    this.pruneOtpChallenges(now);
    if (this.otpChallenges.size >= maxPendingOtpChallenges) {
      throw new Cp2Error(
        503,
        "otp_capacity_exceeded",
        "Verification codes are temporarily unavailable."
      );
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const challengeId = randomUUID();
    const expiresAt = new Date(now.getTime() + otpTtlMs).toISOString();
    const createdAt = now.toISOString();

    this.otpChallenges.set(challengeId, {
      id: challengeId,
      channel: input.channel,
      destination,
      purpose,
      codeHash: hashOtp(challengeId, code),
      attempts: 0,
      maxAttempts: maxOtpAttempts,
      expiresAt,
      verifiedAt: null,
      createdAt
    });
    this.recordOtpRequest(requestKey, now);

    return {
      challengeId,
      destination,
      expiresAt,
      devOtp: code
    };
  }

  private requireOtpRequestAllowed(key: string, now: Date): void {
    const windowMs =
      readBoundedSecurityInteger("OTP_RATE_LIMIT_WINDOW_SECONDS", 300, 60, 3_600) * 1000;
    const maximumRequests = readBoundedSecurityInteger("OTP_RATE_LIMIT_MAX_REQUESTS", 5, 1, 20);
    const cooldownMs = readBoundedSecurityInteger("OTP_COOLDOWN_SECONDS", 60, 0, 600) * 1000;
    const cutoff = now.getTime() - windowMs;
    const requests = (this.otpRequestHistory.get(key) ?? []).filter(
      (requestedAt) => requestedAt > cutoff
    );

    if (requests.length === 0) {
      this.otpRequestHistory.delete(key);
      return;
    }

    this.otpRequestHistory.set(key, requests);
    const lastRequestAt = requests.at(-1) ?? 0;
    if (
      requests.length >= maximumRequests ||
      (cooldownMs > 0 && now.getTime() - lastRequestAt < cooldownMs)
    ) {
      throw new Cp2Error(
        429,
        "otp_rate_limited",
        "Please wait before requesting another verification code."
      );
    }
  }

  private recordOtpRequest(key: string, now: Date): void {
    if (
      !this.otpRequestHistory.has(key) &&
      this.otpRequestHistory.size >= pinAttemptTrackerMaximumEntries
    ) {
      const oldestKey = this.otpRequestHistory.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.otpRequestHistory.delete(oldestKey);
    }
    const requests = this.otpRequestHistory.get(key) ?? [];
    requests.push(now.getTime());
    this.otpRequestHistory.set(key, requests);
  }

  private pruneOtpChallenges(now: Date): void {
    for (const [challengeId, challenge] of this.otpChallenges) {
      if (Date.parse(challenge.expiresAt) <= now.getTime()) {
        this.otpChallenges.delete(challengeId);
        for (const [attemptId, attempt] of this.smsDeliveryAttempts) {
          if (attempt.challengeId === challengeId) this.smsDeliveryAttempts.delete(attemptId);
        }
      }
    }
  }

  verifyOtp(input: { challengeId: string; code: string; now?: Date }): VerifyOtpResult {
    const now = input.now ?? new Date();
    const challenge = this.otpChallenges.get(input.challengeId);

    this.validateOtpChallenge(challenge, now);

    if (!hashMatches(hashOtp(challenge.id, input.code), challenge.codeHash)) {
      challenge.attempts += 1;
      throw new Cp2Error(401, "otp_invalid", "OTP code is invalid.");
    }

    return this.completeOtpVerification(challenge, now);
  }

  getOtpChallengeDelivery(challengeId: string, now = new Date()): OtpChallengeDelivery {
    const challenge = this.otpChallenges.get(challengeId);
    this.validateOtpChallenge(challenge, now);

    return {
      challengeId: challenge.id,
      channel: challenge.channel,
      destination: challenge.destination,
      purpose: challenge.purpose,
      expiresAt: challenge.expiresAt
    };
  }

  getOtpChallengeDeliveryByContact(
    input: { channel: AuthChannel; destination: string },
    now = new Date()
  ): OtpChallengeDelivery {
    const destination = normalizeDestination(input.channel, input.destination);
    const challenge = [...this.otpChallenges.values()]
      .reverse()
      .find((item) => item.channel === input.channel && item.destination === destination);
    this.validateOtpChallenge(challenge, now);

    return {
      challengeId: challenge.id,
      channel: challenge.channel,
      destination: challenge.destination,
      purpose: challenge.purpose,
      expiresAt: challenge.expiresAt
    };
  }

  verifyExternallyApprovedOtp(input: { challengeId: string; now?: Date }): VerifyOtpResult {
    const now = input.now ?? new Date();
    const challenge = this.otpChallenges.get(input.challengeId);
    this.validateOtpChallenge(challenge, now);

    return this.completeOtpVerification(challenge, now);
  }

  private validateOtpChallenge(
    challenge: OtpChallenge | undefined,
    now: Date
  ): asserts challenge is OtpChallenge {
    if (challenge === undefined) {
      throw new Cp2Error(404, "otp_not_found", "OTP challenge was not found.");
    }

    if (challenge.verifiedAt !== null) {
      throw new Cp2Error(409, "otp_already_verified", "OTP challenge is already verified.");
    }

    if (challenge.consumedAt != null) {
      throw new Cp2Error(409, "otp_invalidated", "OTP challenge is no longer active.");
    }

    if (Date.parse(challenge.expiresAt) <= now.getTime()) {
      throw new Cp2Error(410, "otp_expired", "OTP challenge has expired.");
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      throw new Cp2Error(429, "otp_attempts_exceeded", "OTP attempts exceeded.");
    }
  }

  private completeOtpVerification(challenge: OtpChallenge, now: Date): VerifyOtpResult {
    challenge.verifiedAt = now.toISOString();
    const destinationKey = destinationAccountKey(challenge.channel, challenge.destination);
    const linkedIdentity =
      challenge.channel === "email"
        ? this.deps.findIdentityByVerifiedEmail(challenge.destination)
        : undefined;
    const existingIdentityAccountId = this.deps.resolveAnyIdentityAccount(
      challenge.channel,
      challenge.destination
    );
    const existingAccountId =
      this.deps.resolveIdentityAccount(challenge.channel, challenge.destination) ??
      this.deps.accountByDestination.get(destinationKey) ??
      linkedIdentity?.accountId;

    if (
      existingIdentityAccountId !== undefined &&
      existingIdentityAccountId !== existingAccountId
    ) {
      throw new Cp2Error(409, "identity_in_use", "This sign-in method is already linked.");
    }

    if (challenge.purpose === "recovery" && existingAccountId === undefined) {
      throw new Cp2Error(
        404,
        "recovery_account_not_found",
        "No Grogoni account is linked to this recovery contact."
      );
    }

    const resumed = existingAccountId !== undefined;
    const account =
      existingAccountId === undefined
        ? this.deps.createAccount(challenge.channel, challenge.destination, now)
        : this.deps.requireAccount(existingAccountId);
    const user = this.deps.requireUser(this.deps.userByAccount.get(account.id));
    this.deps.addAccountIdentity(
      account,
      user,
      challenge.channel,
      challenge.destination,
      account.primaryAuthChannel === challenge.channel &&
        account.primaryAuthDestination === challenge.destination,
      now,
      true
    );
    const session = this.deps.createSession(account, user, now);

    this.deps.recordAuditEvent({
      type: "auth.otp_verified",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: user.id,
      occurredAt: now.toISOString(),
      payload: {
        challengeId: challenge.id,
        channel: challenge.channel,
        destination: challenge.destination
      }
    });

    this.deps.recordAuditEvent({
      type: resumed ? "account.resumed" : "account.created",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: user.id,
      occurredAt: now.toISOString(),
      payload: {
        primaryAuthChannel: account.primaryAuthChannel,
        primaryAuthDestination: account.primaryAuthDestination
      }
    });

    return {
      account,
      user,
      session,
      resumed
    };
  }

  /**
   * Dead code carried over unchanged from the pre-extraction monolith - confirmed zero callers
   * anywhere in the codebase (routes.ts, store.ts, tests/*.test.ts, mcp/*.ts). Preserved as inert
   * weight rather than deleted, the same "flag, don't unilaterally redesign" precedent row 9
   * followed for `publicStorefrontMessages`.
   */
  private verifyOtpCodeOnly(input: { challengeId: string; code: string; now: Date }): void {
    const challenge = this.otpChallenges.get(input.challengeId);
    this.validateOtpChallenge(challenge, input.now);

    if (!hashMatches(hashOtp(challenge.id, input.code), challenge.codeHash)) {
      challenge.attempts += 1;
      throw new Cp2Error(401, "otp_invalid", "OTP code is invalid.");
    }

    challenge.verifiedAt = input.now.toISOString();
  }

  /** Dead code, same as `verifyOtpCodeOnly` above - zero callers anywhere. */
  private markOtpCodeExternallyVerified(input: { challengeId: string; now: Date }): void {
    const challenge = this.otpChallenges.get(input.challengeId);
    this.validateOtpChallenge(challenge, input.now);
    challenge.verifiedAt = input.now.toISOString();
  }

  /** Dead code, same as `verifyOtpCodeOnly` above - zero callers anywhere. */
  private getDeletionOtpDelivery(challengeId: string, now: Date): OtpRequestResult {
    const challenge = this.otpChallenges.get(challengeId);
    this.validateOtpChallenge(challenge, now);

    return {
      challengeId: challenge.id,
      destination: challenge.destination,
      expiresAt: challenge.expiresAt,
      devOtp: ""
    };
  }
}
