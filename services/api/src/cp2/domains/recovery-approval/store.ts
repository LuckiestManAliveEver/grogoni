import { randomUUID } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON
} from "@simplewebauthn/server";
import type {
  AuthSessionView,
  RecoveryApprovalOptionsResponse,
  RecoveryApprovalPendingResponse,
  RecoveryApprovalRequestSummary,
  RecoveryApprovalStartResponse,
  RecoveryApprovalStatusResponse
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import type { AuthTransactionRecord } from "../../store.js";
import {
  approvalHashMatches,
  approvalKeys as keys,
  createApprovalCode,
  createApprovalNonce,
  createApprovalSecret,
  hashApprovalValue,
  normalizeApprovalCode,
  recoveryApprovalChallengeTtlMs,
  recoveryApprovalCollectMs,
  recoveryApprovalMaxCodeAttempts,
  recoveryApprovalMaxOpenPerIdentifier,
  recoveryApprovalMaxStartsPerClient,
  recoveryApprovalUndoMs,
  recoveryApprovalPollIntervalMs,
  recoveryApprovalTtlMs,
  type RecoveryApprovalStatus
} from "./shared.js";

export interface RecoveryApprovalDomainDeps {
  authTransactions: () => Iterable<AuthTransactionRecord>;
  getAuthTransaction: (id: string) => AuthTransactionRecord | undefined;
  deleteAuthTransaction: (id: string) => void;
  createAuthTransaction: (
    purpose: AuthTransactionRecord["purpose"],
    accountId: string | null,
    now: Date,
    override: Partial<AuthTransactionRecord>
  ) => AuthTransactionRecord;
  requireAnySession: (sessionId: string | null, now: Date) => AuthSessionView;
  /**
   * The normalized id of this account's Android screen-lock key, or null. Only keys enrolled with
   * device security (requiresServerChallenge) and not revoked count: the plain browser key
   * involves no user verification.
   */
  approvingDeviceKeyId: (credentialId: string, accountId: string) => string | null;
  /** The Android recovery signature over (credential, nonce, issuedAt), as DeviceRecoveryKey.kt signs. */
  verifyDeviceKeySignature: (
    credentialId: string,
    nonce: string,
    issuedAt: number,
    signature: string
  ) => Promise<boolean>;
  beginPasskeyApproval: (input: {
    accountId: string;
    approvalRequestId: string;
    rpId: string;
    origin: string;
    now: Date;
  }) => Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>;
  verifyPasskeyApproval: (input: {
    ceremonyId: string;
    accountId: string;
    approvalRequestId: string;
    rpId: string;
    origin: string;
    response: AuthenticationResponseJSON;
    now: Date;
  }) => Promise<string>;
  /** Whether the key or passkey that approved is still this account's and not revoked. */
  approvingCredentialActive: (credentialId: string, accountId: string) => boolean;
  /** New session for the browser, user-verified, with a one-use credential recovery grant. */
  issueApprovedSession: (
    accountId: string,
    approvingCredentialId: string,
    /** Kept signed in when the browser later resets the PIN or password. */
    approverSessionId: string | null,
    now: Date
  ) => AuthSessionView;
  sessionFamily: (sessionId: string) => string | null;
  /** Families of the account's live sessions, which stay trusted through a browser's probation. */
  liveSessionFamilies: (accountId: string) => string[];
  /**
   * The account's PIN hash, password credential and user phone fields at collection, as JSON.
   * The hashes are copies of what the account already stores, kept for 24 hours so undo can
   * restore the owner's own PIN, password and phone.
   */
  credentialSnapshot: (accountId: string) => string;
  /**
   * Undoes everything a browser let in by approval could have done to keep access: signs out
   * every session created since (except the approving device), revokes passkeys and device keys
   * enrolled since, and removes a PIN or password reset since.
   */
  undoApprovedLogin: (input: {
    accountId: string;
    collectedSessionId: string;
    collectedFamilyId: string | null;
    collectedAt: string;
    approverSessionId: string;
    credentialSnapshot: string | null;
    trustedFamilies: string[];
    now: Date;
  }) => void;
  recordSecurityEvent: (
    type: string,
    accountId: string | null,
    outcome: "success" | "failure",
    now: Date,
    metadata: Record<string, string | boolean | null>
  ) => void;
}

type ApproveInput =
  | {
      sessionId: string | null;
      requestId: string;
      method: "device";
      credentialId: string;
      challengeId: string;
      nonce: string;
      issuedAt: number;
      signature: string;
      now?: Date;
    }
  | {
      sessionId: string | null;
      requestId: string;
      method: "passkey";
      ceremonyId: string;
      response: AuthenticationResponseJSON;
      rpId: string;
      origin: string;
      now?: Date;
    };

/**
 * A signed-out browser starts a request and shows a 6-digit code. The owner types that code on a
 * device still signed in to the same phone account and confirms with its screen lock: the
 * Android recovery key (Keystore, user authentication required) or a user-verified passkey. The
 * browser then collects a session holding a one-use recovery grant.
 *
 * Starting a request never looks up the account, so it reveals nothing about whether the number
 * is registered. The request is matched to an account only when its owner approves it.
 */
export class RecoveryApprovalDomain {
  constructor(private readonly deps: RecoveryApprovalDomainDeps) {}

  start(input: {
    identifier: string;
    client: string;
    /** approvalClientKey of the requester. */
    clientKey: string;
    now?: Date;
  }): RecoveryApprovalStartResponse {
    const now = input.now ?? new Date();
    if (!/^\+[1-9]\d{6,14}$/u.test(input.identifier))
      throw new Cp2Error(
        400,
        "recovery_identifier_required",
        "Enter your international phone number."
      );
    // Durable per-requester limit, the same for registered and unknown numbers. Keyed by
    // requester as well as number, so nobody can keep someone else's number refused.
    const recent = [...this.deps.authTransactions()].filter(
      (record) =>
        isApprovalRequest(record) &&
        record.identifierValue === input.identifier &&
        record.metadata[keys.clientKey] === input.clientKey &&
        now.getTime() - Date.parse(record.createdAt) < recoveryApprovalTtlMs
    );
    if (recent.length >= recoveryApprovalMaxStartsPerClient)
      throw new Cp2Error(
        429,
        "recovery_approval_rate_limited",
        "Too many approval codes from this device. Wait 10 minutes, then try again."
      );
    this.prune(now, input.identifier);
    const code = createApprovalCode();
    const pollSecret = createApprovalSecret();
    const id = randomUUID();
    const transaction = this.deps.createAuthTransaction("recovery", null, now, {
      id,
      identifierType: "phone",
      identifierValue: input.identifier,
      expiresAt: new Date(now.getTime() + recoveryApprovalTtlMs).toISOString(),
      metadata: {
        [keys.marker]: true,
        [keys.status]: "pending",
        [keys.secretHash]: hashApprovalValue(id, pollSecret),
        [keys.codeHash]: hashApprovalValue(id, code),
        [keys.client]: input.client.slice(0, 60),
        [keys.clientKey]: input.clientKey
      }
    });
    this.deps.recordSecurityEvent("auth.recovery_approval_requested", null, "success", now, {
      requestId: transaction.id,
      client: input.client.slice(0, 60)
    });
    return {
      transactionId: transaction.id,
      pollSecret,
      code,
      expiresAt: transaction.expiresAt,
      pollIntervalMs: recoveryApprovalPollIntervalMs
    };
  }

  /** Polled by the browser. On approval it consumes the request and returns the new session. */
  status(input: {
    transactionId: string;
    pollSecret: string;
    now?: Date;
  }): RecoveryApprovalStatusResponse {
    const now = input.now ?? new Date();
    const request = this.deps.getAuthTransaction(input.transactionId);
    if (
      request === undefined ||
      !isApprovalRequest(request) ||
      !approvalHashMatches(request.metadata[keys.secretHash], request.id, input.pollSecret)
    )
      throw new Cp2Error(404, "recovery_approval_not_found", "Start the approval again.");
    const status = request.metadata[keys.status] as RecoveryApprovalStatus;
    if (status === "declined") return { status: "declined" };
    if (
      request.consumedAt !== null ||
      Date.parse(request.expiresAt) <= now.getTime() ||
      request.attempts >= recoveryApprovalMaxCodeAttempts
    )
      return { status: "expired" };
    if (status === "pending") return { status: "pending", expiresAt: request.expiresAt };

    const credentialId = request.metadata[keys.credentialId];
    if (request.accountId === null || typeof credentialId !== "string")
      throw new Cp2Error(500, "recovery_approval_corrupt", "Start the approval again.");
    // Revoking the approving key or passkey before the browser collects withdraws the approval.
    if (!this.deps.approvingCredentialActive(credentialId, request.accountId)) {
      request.metadata[keys.status] = "declined";
      request.consumedAt = now.toISOString();
      return { status: "declined" };
    }
    // Issue before consuming, so a failure leaves the approval collectable. Both happen in this one
    // request, so an approval still yields exactly one session however often the browser polls.
    const approverSessionId = request.metadata[keys.approverSessionId];
    // Devices signed in before this browser got in. For 24 hours only they are trusted.
    const trustedFamilies = this.deps.liveSessionFamilies(request.accountId);
    const session = this.deps.issueApprovedSession(
      request.accountId,
      credentialId,
      typeof approverSessionId === "string" ? approverSessionId : null,
      now
    );
    request.consumedAt = now.toISOString();
    request.metadata[keys.collectedSessionId] = session.session.id;
    request.metadata[keys.trustedFamilies] = JSON.stringify(trustedFamilies);
    request.metadata[keys.collectedFamilyId] = this.deps.sessionFamily(session.session.id);
    request.metadata[keys.collectedAt] = now.toISOString();
    // What the browser could change, so undo can put it back rather than delete it. Read before
    // the browser has used its grant: issueApprovedSession above changes no credential.
    request.metadata[keys.credentialSnapshot] = this.deps.credentialSnapshot(request.accountId);
    // Kept for the probation window: the owner can undo it, and the browser stays restricted.
    request.expiresAt = new Date(now.getTime() + recoveryApprovalUndoMs).toISOString();
    this.deps.recordSecurityEvent(
      "auth.recovery_approval_completed",
      request.accountId,
      "success",
      now,
      { requestId: request.id, sessionId: session.session.id, credentialId }
    );
    return { status: "approved", ...session };
  }

  /**
   * Browsers let in for this account in the last 24 hours. While one is listed, that browser's
   * session family is on probation and credentials enrolled since cannot approve.
   */
  private collectedApprovals(accountId: string, now: Date): AuthTransactionRecord[] {
    return [...this.deps.authTransactions()].filter(
      (record) =>
        isApprovalRequest(record) &&
        record.accountId === accountId &&
        record.metadata[keys.status] === "approved" &&
        record.consumedAt !== null &&
        typeof record.metadata[keys.collectedAt] === "string" &&
        Date.parse(record.expiresAt) > now.getTime()
    );
  }

  /**
   * Whether this session family is on probation: within 24 hours of a browser being let in by
   * approval, any family that was not already signed in at that moment. That covers the browser
   * itself and every later login, whether by the PIN it reset, a passkey it added, or a device
   * key it enrolled (including through Edge's direct /auth/continue handler).
   */
  inProbation(sessionFamilyId: string, accountId: string, now = new Date()): boolean {
    return this.collectedApprovals(accountId, now).some(
      (record) => !trustedFamiliesOf(record).includes(sessionFamilyId)
    );
  }

  /** Credentials created at or after this time cannot approve another browser. */
  probationCutoff(accountId: string, now = new Date()): string | null {
    const times = this.collectedApprovals(accountId, now)
      .map((record) => String(record.metadata[keys.collectedAt]))
      .sort();
    return times[0] ?? null;
  }

  /** The owner's open requests, newest first. Codes are never listed: they must be typed. */
  pending(input: { sessionId: string | null; now?: Date }): RecoveryApprovalPendingResponse {
    const now = input.now ?? new Date();
    const approver = this.requireApprover(input.sessionId, now);
    const phone = approver.account.primaryAuthDestination;
    return {
      phone,
      requests: this.openRequests(phone, now)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(summary),
      recentApprovals: this.collectedApprovals(approver.account.id, now)
        .filter((record) => record.identifierValue === phone)
        .sort((left, right) =>
          String(right.metadata[keys.collectedAt]).localeCompare(
            String(left.metadata[keys.collectedAt])
          )
        )
        .map((record) => ({
          requestId: record.id,
          client: String(record.metadata[keys.client] ?? "A browser"),
          loggedInAt: String(record.metadata[keys.collectedAt]),
          undoUntil: record.expiresAt
        }))
    };
  }

  /**
   * Checks the typed code, then issues the trusted device's screen-lock challenge for that request.
   * A wrong code counts against every open request for the number, so 5 guesses end them all.
   */
  async options(input: {
    sessionId: string | null;
    code: string;
    method: "device" | "passkey";
    credentialId?: string;
    rpId?: string;
    origin?: string;
    now?: Date;
  }): Promise<RecoveryApprovalOptionsResponse> {
    const now = input.now ?? new Date();
    const approver = this.requireTrustedApprover(input.sessionId, now);
    const code = normalizeApprovalCode(input.code);
    const open = this.openRequests(approver.account.primaryAuthDestination, now);
    const request =
      code === null
        ? undefined
        : open.find((candidate) =>
            approvalHashMatches(candidate.metadata[keys.codeHash], candidate.id, code)
          );
    if (request === undefined) {
      for (const candidate of open) candidate.attempts += 1;
      this.deps.recordSecurityEvent(
        "auth.recovery_approval_code_rejected",
        approver.account.id,
        "failure",
        now,
        { openRequests: String(open.length) }
      );
      throw new Cp2Error(
        400,
        "recovery_approval_code_invalid",
        open.length === 0
          ? "No browser is waiting for approval. Start again on the other device."
          : "That code does not match. Check the code on the other screen."
      );
    }
    clearChallenge(request);
    if (input.method === "device") {
      const keyId = this.requireApprovingDeviceKey(input.credentialId, approver);
      const nonce = createApprovalNonce();
      const challengeId = randomUUID();
      Object.assign(request.metadata, {
        [keys.challengeId]: challengeId,
        [keys.challengeNonce]: nonce,
        [keys.challengeIssuedAt]: String(now.getTime()),
        [keys.challengeCredentialId]: keyId,
        [keys.challengeSessionId]: approver.session.id
      });
      return {
        ...summary(request),
        method: "device",
        challenge: {
          challengeId,
          nonce,
          issuedAt: now.getTime(),
          expiresAt: new Date(now.getTime() + recoveryApprovalChallengeTtlMs).toISOString()
        }
      };
    }
    if (input.rpId === undefined || input.origin === undefined)
      throw new Cp2Error(403, "passkey_origin_not_allowed", "Passkeys are not available here.");
    const ceremony = await this.deps.beginPasskeyApproval({
      accountId: approver.account.id,
      approvalRequestId: request.id,
      rpId: input.rpId,
      origin: input.origin,
      now
    });
    Object.assign(request.metadata, {
      [keys.ceremonyId]: ceremony.ceremonyId,
      [keys.challengeSessionId]: approver.session.id
    });
    return {
      ...summary(request),
      method: "passkey",
      ceremonyId: ceremony.ceremonyId,
      options: ceremony.options as unknown as Record<string, unknown>
    };
  }

  /** Verifies the screen-lock proof and binds the request to this account. One attempt each. */
  async approve(input: ApproveInput): Promise<{ approved: true }> {
    const now = input.now ?? new Date();
    const approver = this.requireTrustedApprover(input.sessionId, now);
    const request = this.requireOpenRequest(input.requestId, approver, now);
    const challengeSession = request.metadata[keys.challengeSessionId];
    let credentialId: string;
    if (input.method === "device") {
      const expected = {
        challengeId: request.metadata[keys.challengeId],
        nonce: request.metadata[keys.challengeNonce],
        issuedAt: request.metadata[keys.challengeIssuedAt],
        credentialId: request.metadata[keys.challengeCredentialId]
      };
      clearChallenge(request);
      const keyId = this.deps.approvingDeviceKeyId(input.credentialId, approver.account.id);
      if (
        challengeSession !== approver.session.id ||
        expected.challengeId !== input.challengeId ||
        expected.nonce !== input.nonce ||
        expected.issuedAt !== String(input.issuedAt) ||
        keyId === null ||
        expected.credentialId !== keyId ||
        now.getTime() - input.issuedAt > recoveryApprovalChallengeTtlMs ||
        !(await this.deps.verifyDeviceKeySignature(
          keyId,
          input.nonce,
          input.issuedAt,
          input.signature
        ))
      ) {
        this.rejectProof(request, approver, now, "device");
      }
      credentialId = keyId;
    } else {
      const ceremonyId = request.metadata[keys.ceremonyId];
      clearChallenge(request);
      if (challengeSession !== approver.session.id || ceremonyId !== input.ceremonyId)
        this.rejectProof(request, approver, now, "passkey");
      try {
        credentialId = await this.deps.verifyPasskeyApproval({
          ceremonyId: input.ceremonyId,
          accountId: approver.account.id,
          approvalRequestId: request.id,
          rpId: input.rpId,
          origin: input.origin,
          response: input.response,
          now
        });
      } catch {
        this.rejectProof(request, approver, now, "passkey");
      }
    }
    request.accountId = approver.account.id;
    request.metadata[keys.status] = "approved";
    request.metadata[keys.credentialId] = credentialId;
    request.metadata[keys.approvedAt] = now.toISOString();
    request.metadata[keys.approverSessionId] = approver.session.id;
    const collectBy = now.getTime() + recoveryApprovalCollectMs;
    if (Date.parse(request.expiresAt) < collectBy)
      request.expiresAt = new Date(collectBy).toISOString();
    this.deps.recordSecurityEvent(
      "auth.recovery_approval_approved",
      approver.account.id,
      "success",
      now,
      { requestId: request.id, method: input.method, credentialId }
    );
    return { approved: true };
  }

  /** Ends a pending request, or withdraws an approval the browser has not collected yet. */
  decline(input: { sessionId: string | null; requestId: string; now?: Date }): {
    declined: true;
  } {
    const now = input.now ?? new Date();
    const approver = this.requireTrustedApprover(input.sessionId, now);
    const collected = this.collectedApproval(input.requestId, approver, now);
    if (collected !== undefined) {
      const sessionId = String(collected.metadata[keys.collectedSessionId]);
      this.deps.undoApprovedLogin({
        accountId: approver.account.id,
        collectedSessionId: sessionId,
        collectedFamilyId: stringOrNull(collected.metadata[keys.collectedFamilyId]),
        collectedAt: String(collected.metadata[keys.collectedAt] ?? collected.createdAt),
        approverSessionId: approver.session.id,
        credentialSnapshot: stringOrNull(collected.metadata[keys.credentialSnapshot]),
        trustedFamilies: trustedFamiliesOf(collected),
        now
      });
      collected.metadata[keys.status] = "declined";
      collected.expiresAt = now.toISOString();
      this.deps.recordSecurityEvent(
        "auth.recovery_approval_withdrawn",
        approver.account.id,
        "success",
        now,
        { requestId: collected.id, sessionId }
      );
      return { declined: true };
    }
    const request = this.requireOpenRequest(input.requestId, approver, now, true);
    clearChallenge(request);
    request.metadata[keys.status] = "declined";
    request.consumedAt = now.toISOString();
    this.deps.recordSecurityEvent(
      "auth.recovery_approval_declined",
      approver.account.id,
      "success",
      now,
      { requestId: request.id }
    );
    return { declined: true };
  }

  private rejectProof(
    request: AuthTransactionRecord,
    approver: AuthSessionView,
    now: Date,
    method: "device" | "passkey"
  ): never {
    request.attempts += 1;
    this.deps.recordSecurityEvent(
      "auth.recovery_approval_proof_rejected",
      approver.account.id,
      "failure",
      now,
      { requestId: request.id, method }
    );
    throw new Cp2Error(
      401,
      "recovery_approval_proof_invalid",
      "Screen lock confirmation failed. Enter the code again to retry."
    );
  }

  /** Approvers are signed-in phone accounts. Guests have no number to match a request to. */
  /** Approving, declining and undoing are for devices signed in before any recent approval. */
  private requireTrustedApprover(sessionId: string | null, now: Date): AuthSessionView {
    const session = this.requireApprover(sessionId, now);
    const family = this.deps.sessionFamily(session.session.id);
    if (family === null || this.inProbation(family, session.account.id, now))
      throw new Cp2Error(
        403,
        "recovery_approval_probation",
        "This device logged in less than 24 hours after a browser was approved, so it cannot approve or undo. Use a device that was already logged in."
      );
    return session;
  }

  private requireApprover(sessionId: string | null, now: Date): AuthSessionView {
    const session = this.deps.requireAnySession(sessionId, now);
    if (
      session.account.primaryAuthChannel !== "phone" ||
      !/^\+[1-9]\d{6,14}$/u.test(session.account.primaryAuthDestination ?? "")
    )
      throw new Cp2Error(
        403,
        "recovery_approval_phone_required",
        "Sign in to your phone account on this device to approve."
      );
    return session;
  }

  private requireApprovingDeviceKey(
    credentialId: string | undefined,
    approver: AuthSessionView
  ): string {
    const keyId =
      credentialId === undefined
        ? null
        : this.deps.approvingDeviceKeyId(credentialId, approver.account.id);
    if (keyId === null)
      throw new Cp2Error(
        409,
        "recovery_approval_device_missing",
        "Turn on device security for this phone in Account security, then approve."
      );
    return keyId;
  }

  /** An approval this owner made that a browser collected less than 24 hours ago. */
  private collectedApproval(
    requestId: string,
    approver: AuthSessionView,
    now: Date
  ): AuthTransactionRecord | undefined {
    const record = this.deps.getAuthTransaction(requestId);
    return record !== undefined &&
      isApprovalRequest(record) &&
      record.accountId === approver.account.id &&
      record.identifierValue === approver.account.primaryAuthDestination &&
      record.metadata[keys.status] === "approved" &&
      record.consumedAt !== null &&
      typeof record.metadata[keys.collectedSessionId] === "string" &&
      Date.parse(record.expiresAt) > now.getTime()
      ? record
      : undefined;
  }

  private requireOpenRequest(
    requestId: string,
    approver: AuthSessionView,
    now: Date,
    includeUncollected = false
  ): AuthTransactionRecord {
    const request = this.openRequests(
      approver.account.primaryAuthDestination,
      now,
      includeUncollected ? approver.account.id : null
    ).find((candidate) => candidate.id === requestId);
    if (request === undefined)
      throw new Cp2Error(
        404,
        "recovery_approval_not_found",
        "This request has ended. Start again on the other device."
      );
    return request;
  }

  /** Pending requests for the number, plus (when an account is given) its uncollected approvals. */
  private openRequests(
    phone: string | null,
    now: Date,
    approvedFor: string | null = null
  ): AuthTransactionRecord[] {
    return [...this.deps.authTransactions()].filter(
      (record) =>
        isApprovalRequest(record) &&
        record.identifierValue === phone &&
        (record.metadata[keys.status] === "pending" ||
          (approvedFor !== null &&
            record.metadata[keys.status] === "approved" &&
            record.accountId === approvedFor)) &&
        record.consumedAt === null &&
        record.attempts < recoveryApprovalMaxCodeAttempts &&
        Date.parse(record.expiresAt) > now.getTime()
    );
  }

  /** Drops expired requests, then refuses a new one while the number is at its open cap. */
  private prune(now: Date, identifier: string): void {
    for (const record of [...this.deps.authTransactions()]) {
      if (
        isApprovalRequest(record) &&
        record.identifierValue === identifier &&
        Date.parse(record.expiresAt) <= now.getTime()
      )
        this.deps.deleteAuthTransaction(record.id);
    }
    const open = () =>
      [...this.deps.authTransactions()].filter(
        (record) =>
          isApprovalRequest(record) &&
          record.identifierValue === identifier &&
          record.consumedAt === null &&
          record.metadata[keys.status] === "pending"
      );
    // Refuse rather than evict. Requester keys come from a header a caller can vary, so any
    // eviction rule could be steered into cancelling the owner's own, older request.
    if (open().length >= recoveryApprovalMaxOpenPerIdentifier)
      throw new Cp2Error(
        429,
        "recovery_approval_busy",
        "Too many approval codes are open for this number. Try again in 10 minutes."
      );
  }
}

function isApprovalRequest(record: AuthTransactionRecord): boolean {
  return record.purpose === "recovery" && record.metadata[keys.marker] === true;
}

function clearChallenge(request: AuthTransactionRecord): void {
  for (const key of [
    keys.challengeId,
    keys.challengeNonce,
    keys.challengeIssuedAt,
    keys.challengeCredentialId,
    keys.challengeSessionId,
    keys.ceremonyId
  ])
    delete request.metadata[key];
}

function summary(request: AuthTransactionRecord): RecoveryApprovalRequestSummary {
  return {
    requestId: request.id,
    client: String(request.metadata[keys.client] ?? "A browser"),
    requestedAt: request.createdAt,
    expiresAt: request.expiresAt
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function trustedFamiliesOf(record: AuthTransactionRecord): string[] {
  try {
    const parsed: unknown = JSON.parse(String(record.metadata[keys.trustedFamilies] ?? "[]"));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
