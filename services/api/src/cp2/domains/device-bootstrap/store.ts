import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AccountSummary,
  AuthChannel,
  AuthSessionView,
  SessionSummary,
  UserSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { normalizeDestination } from "../../phone-identity.js";
import {
  deviceAccountBootstrapTtlMs,
  deviceRecoveryAssertionPayload,
  deviceRecoveryPublicKeyFingerprint,
  hashDeviceBootstrapKey,
  normalizeDeviceBootstrapIdempotencyKey,
  normalizeDeviceRecoveryCredentialId,
  normalizeDeviceRecoveryPublicKey,
  verifyDeviceRecoverySignature,
  type DeviceAccountBootstrapCredentials,
  type DeviceAccountBootstrapRecord,
  type DeviceRecoveryCredentialRecord
} from "./shared.js";
import type { Cp2Snapshot, SessionRecord } from "../../store.js";

export interface DeviceBootstrapDomainDeps {
  getSession: (sessionId: string | null, now: Date) => AuthSessionView | null;
  requireAccount: (accountId: string) => AccountSummary;
  requireUser: (userId: string | undefined) => UserSummary;
  requireAccountAuthenticationAllowed: (account: AccountSummary) => void;
  requireAnySession: (sessionId: string | null, now: Date) => AuthSessionView;
  createAccount: (
    channel: AccountSummary["primaryAuthChannel"],
    destination: string,
    now: Date,
    identityLevel?: AccountSummary["identityLevel"]
  ) => AccountSummary;
  createSession: (account: AccountSummary, user: UserSummary, now: Date) => SessionSummary;
  consumeSessionRefreshToken: (sessionId: string) => string;
  revokeSessionFamily: (familyId: string, reason: string, now: Date) => void;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  recordSecurityEvent: (
    type: string,
    accountId: string | null,
    outcome: "success" | "failure",
    now: Date,
    metadata: Record<string, string | boolean | null>
  ) => void;
  markSessionPinVerified: (sessionId: string, now: Date) => void;
  resolveIdentityAccount: (type: AuthChannel, normalizedValue: string) => string | undefined;
  requirePinAttemptAllowed: (key: string, now: Date) => void;
  recordFailedPinAttempt: (key: string, now: Date) => void;
  verifyStoredPin: (accountId: string, pin: string, storedHash: string) => boolean;
  /** Constant-time PIN-hash comparison against a dummy hash, run even when no account matched. */
  simulateFailedPinCheck: (pin: string) => void;
  normalizePin: (pin: string) => string;
  mergeDeviceAccountData: (
    sourceAccountId: string,
    sourceUserId: string,
    targetAccountId: string,
    targetUserId: string
  ) => void;
  sessions: Map<string, SessionRecord>;
  users: Map<string, UserSummary>;
  userByAccount: Map<string, string>;
  accountPinHashes: Map<string, string>;
  failedPinAttempts: Map<string, number[]>;
}

export class DeviceBootstrapDomain {
  private readonly deviceAccountBootstraps = new Map<string, DeviceAccountBootstrapRecord>();
  private readonly deviceAccountBootstrapCredentials = new Map<
    string,
    DeviceAccountBootstrapCredentials
  >();
  private readonly deviceRecoveryCredentials = new Map<string, DeviceRecoveryCredentialRecord>();
  private readonly deviceRecoverySessionCredentials = new Map<
    string,
    DeviceAccountBootstrapCredentials
  >();

  constructor(private readonly deps: DeviceBootstrapDomainDeps) {}

  get deviceAccountBootstrapsMap(): Map<string, DeviceAccountBootstrapRecord> {
    return this.deviceAccountBootstraps;
  }

  get deviceRecoveryCredentialsMap(): Map<string, DeviceRecoveryCredentialRecord> {
    return this.deviceRecoveryCredentials;
  }

  get deviceRecoverySessionCredentialsMap(): Map<string, DeviceAccountBootstrapCredentials> {
    return this.deviceRecoverySessionCredentials;
  }

  clear(): void {
    this.deviceAccountBootstraps.clear();
    this.deviceAccountBootstrapCredentials.clear();
    this.deviceRecoveryCredentials.clear();
    this.deviceRecoverySessionCredentials.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const bootstrap of snapshot.deviceAccountBootstraps ?? []) {
      this.deviceAccountBootstraps.set(bootstrap.id, bootstrap);
    }
    for (const credential of snapshot.deviceRecoveryCredentials ?? []) {
      this.deviceRecoveryCredentials.set(credential.id, credential);
    }
  }

  /** Called from `rebuildDerivedIndexesAfterAccountPurge` to prune orphaned ephemeral caches. */
  pruneOrphanedEphemeralCredentials(hasSession: (sessionId: string) => boolean): void {
    for (const keyHash of this.deviceAccountBootstrapCredentials.keys()) {
      if (!this.deviceAccountBootstraps.has(keyHash)) {
        this.deviceAccountBootstrapCredentials.delete(keyHash);
      }
    }
    for (const assertionHash of this.deviceRecoverySessionCredentials.keys()) {
      const sessionId = this.deviceRecoverySessionCredentials.get(assertionHash)?.sessionId;
      if (sessionId === undefined || !hasSession(sessionId)) {
        this.deviceRecoverySessionCredentials.delete(assertionHash);
      }
    }
  }

  continueWithDevice(input: {
    sessionId: string | null;
    idempotencyKey: string | null;
    devicePublicKeyJwk?: unknown;
    now?: Date;
  }): AuthSessionView & { refreshToken: string | null } {
    const now = input.now ?? new Date();
    const existingSession = this.deps.getSession(input.sessionId, now);
    if (existingSession !== null) {
      if (input.devicePublicKeyJwk === undefined) {
        return { ...existingSession, isNewAccount: false, refreshToken: null };
      }
      const deviceCredential = this.ensureDeviceRecoveryCredential(
        existingSession.account.id,
        normalizeDeviceRecoveryPublicKey(input.devicePublicKeyJwk),
        now
      );
      return {
        ...existingSession,
        isNewAccount: false,
        deviceRecoveryCredentialId: deviceCredential.id,
        refreshToken: null
      };
    }

    const idempotencyKey = normalizeDeviceBootstrapIdempotencyKey(input.idempotencyKey);
    const keyHash = hashDeviceBootstrapKey(idempotencyKey);
    const devicePublicKeyJwk = normalizeDeviceRecoveryPublicKey(input.devicePublicKeyJwk);
    this.pruneDeviceAccountBootstraps(now);
    const existingBootstrap = this.deviceAccountBootstraps.get(keyHash);

    if (existingBootstrap !== undefined) {
      const account = this.deps.requireAccount(existingBootstrap.accountId);
      this.deps.requireAccountAuthenticationAllowed(account);
      const user = this.deps.requireUser(this.deps.userByAccount.get(account.id));
      const deviceCredential = this.ensureDeviceRecoveryCredential(
        account.id,
        devicePublicKeyJwk,
        now
      );
      const credentials = this.deviceAccountBootstrapCredentials.get(keyHash);
      const replayedSession = this.deps.getSession(existingBootstrap.sessionId, now);

      if (
        replayedSession !== null &&
        credentials !== undefined &&
        credentials.sessionId === replayedSession.session.id
      ) {
        return {
          ...replayedSession,
          isNewAccount: false,
          deviceRecoveryCredentialId: deviceCredential.id,
          refreshToken: credentials.refreshToken
        };
      }

      if (replayedSession !== null) {
        const replayedSessionRecord = this.deps.sessions.get(replayedSession.session.id);
        if (replayedSessionRecord !== undefined) {
          this.deps.revokeSessionFamily(
            replayedSessionRecord.sessionFamilyId,
            "device_bootstrap_replayed",
            now
          );
        }
      }

      const replacement = this.deps.createSession(account, user, now);
      const refreshToken = this.deps.consumeSessionRefreshToken(replacement.id);
      this.deviceAccountBootstraps.set(keyHash, {
        ...existingBootstrap,
        sessionId: replacement.id,
        expiresAt: new Date(now.getTime() + deviceAccountBootstrapTtlMs).toISOString()
      });
      this.deviceAccountBootstrapCredentials.set(keyHash, {
        sessionId: replacement.id,
        refreshToken
      });
      return {
        ...this.deps.requireAnySession(replacement.id, now),
        isNewAccount: false,
        deviceRecoveryCredentialId: deviceCredential.id,
        refreshToken
      };
    }

    const account = this.deps.createAccount(
      "device",
      `device:${randomBytes(24).toString("base64url")}`,
      now,
      "device"
    );
    const user = this.deps.requireUser(this.deps.userByAccount.get(account.id));
    this.deps.users.set(user.id, { ...user, displayName: "Grogoni user" });
    const deviceCredential = this.ensureDeviceRecoveryCredential(
      account.id,
      devicePublicKeyJwk,
      now
    );
    const session = this.deps.createSession(account, this.deps.requireUser(user.id), now);
    const refreshToken = this.deps.consumeSessionRefreshToken(session.id);
    const bootstrap: DeviceAccountBootstrapRecord = {
      id: keyHash,
      accountId: account.id,
      sessionId: session.id,
      expiresAt: new Date(now.getTime() + deviceAccountBootstrapTtlMs).toISOString(),
      createdAt: now.toISOString()
    };
    this.deviceAccountBootstraps.set(keyHash, bootstrap);
    this.deviceAccountBootstrapCredentials.set(keyHash, { sessionId: session.id, refreshToken });

    this.deps.recordAuditEvent({
      type: "auth.device_account_created",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: user.id,
      occurredAt: now.toISOString(),
      payload: { identityLevel: "device" }
    });
    this.deps.recordAuditEvent({
      type: "account.created",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: user.id,
      occurredAt: now.toISOString(),
      payload: { primaryAuthChannel: "device", identityLevel: "device" }
    });

    return {
      ...this.deps.requireAnySession(session.id, now),
      isNewAccount: true,
      deviceRecoveryCredentialId: deviceCredential.id,
      refreshToken
    };
  }

  recoverWithDeviceCredential(input: {
    credentialId: string;
    nonce: string;
    issuedAt: number;
    signature: string;
    now?: Date;
  }): AuthSessionView & { refreshToken: string } {
    const now = input.now ?? new Date();
    const credentialId = normalizeDeviceRecoveryCredentialId(input.credentialId);
    const nonce = input.nonce.trim();
    const signature = input.signature.trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce) || !/^[A-Za-z0-9_-]{64,256}$/u.test(signature)) {
      throw new Cp2Error(401, "device_recovery_invalid", "Device recovery failed.");
    }
    if (
      !Number.isSafeInteger(input.issuedAt) ||
      Math.abs(now.getTime() - input.issuedAt) > 2 * 60 * 1000
    ) {
      throw new Cp2Error(401, "device_recovery_expired", "Device recovery has expired.");
    }

    const credential = this.deviceRecoveryCredentials.get(credentialId);
    if (credential === undefined || credential.revokedAt !== null) {
      throw new Cp2Error(401, "device_recovery_invalid", "Device recovery failed.");
    }
    const payload = deviceRecoveryAssertionPayload(credentialId, nonce, input.issuedAt);
    const assertionHash = createHash("sha256")
      .update(`${payload}.${signature}`)
      .digest("base64url");
    const isReplay = credential.lastAssertionHash === assertionHash;
    if (!isReplay && !verifyDeviceRecoverySignature(credential.publicKeyJwk, payload, signature)) {
      throw new Cp2Error(401, "device_recovery_invalid", "Device recovery failed.");
    }

    const account = this.deps.requireAccount(credential.accountId);
    this.deps.requireAccountAuthenticationAllowed(account);
    const user = this.deps.requireUser(this.deps.userByAccount.get(account.id));
    if (isReplay && credential.lastSessionId !== null) {
      const replayed = this.deps.getSession(credential.lastSessionId, now);
      const credentials = this.deviceRecoverySessionCredentials.get(assertionHash);
      if (
        replayed !== null &&
        credentials !== undefined &&
        credentials.sessionId === replayed.session.id
      ) {
        return { ...replayed, isNewAccount: false, refreshToken: credentials.refreshToken };
      }
      if (replayed !== null) {
        const record = this.deps.sessions.get(replayed.session.id);
        if (record !== undefined) {
          this.deps.revokeSessionFamily(record.sessionFamilyId, "device_recovery_replayed", now);
        }
      }
    }

    const session = this.deps.createSession(account, user, now);
    const refreshToken = this.deps.consumeSessionRefreshToken(session.id);
    credential.lastAssertionHash = assertionHash;
    credential.lastAssertionAt = now.toISOString();
    credential.lastSessionId = session.id;
    credential.updatedAt = now.toISOString();
    this.deviceRecoverySessionCredentials.set(assertionHash, {
      sessionId: session.id,
      refreshToken
    });
    this.deps.recordSecurityEvent("auth.device_recovered", account.id, "success", now, {});
    return { ...this.deps.requireAnySession(session.id, now), isNewAccount: false, refreshToken };
  }

  private ensureDeviceRecoveryCredential(
    accountId: string,
    publicKeyJwk: Record<string, unknown>,
    now: Date
  ): DeviceRecoveryCredentialRecord {
    const fingerprint = deviceRecoveryPublicKeyFingerprint(publicKeyJwk);
    const existing = [...this.deviceRecoveryCredentials.values()].find(
      (credential) =>
        deviceRecoveryPublicKeyFingerprint(credential.publicKeyJwk) === fingerprint &&
        credential.revokedAt === null
    );
    if (existing !== undefined) {
      if (existing.accountId !== accountId) {
        throw new Cp2Error(409, "device_credential_in_use", "This device is already linked.");
      }
      return existing;
    }
    const credential: DeviceRecoveryCredentialRecord = {
      id: randomUUID(),
      accountId,
      publicKeyJwk,
      lastAssertionHash: null,
      lastAssertionAt: null,
      lastSessionId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revokedAt: null
    };
    this.deviceRecoveryCredentials.set(credential.id, credential);
    return credential;
  }

  private pruneDeviceAccountBootstraps(now: Date): void {
    for (const [keyHash, bootstrap] of this.deviceAccountBootstraps) {
      if (Date.parse(bootstrap.expiresAt) <= now.getTime()) {
        this.deviceAccountBootstraps.delete(keyHash);
        this.deviceAccountBootstrapCredentials.delete(keyHash);
      }
    }
  }

  mergeCurrentDeviceAccountWithPin(input: {
    sessionId: string | null;
    channel: AuthChannel;
    destination: string;
    pin: string;
    now?: Date;
  }): AuthSessionView & { refreshToken: string } {
    const now = input.now ?? new Date();
    const sourceSession = this.deps.requireAnySession(input.sessionId, now);
    if (sourceSession.account.primaryAuthChannel !== "device") {
      throw new Cp2Error(
        409,
        "account_merge_not_available",
        "Only a device account can be joined to an existing account."
      );
    }
    const destination = normalizeDestination(input.channel, input.destination);
    const targetAccountId = this.deps.resolveIdentityAccount(input.channel, destination);
    if (targetAccountId === undefined || targetAccountId === sourceSession.account.id) {
      throw new Cp2Error(401, "auth_credentials_invalid", "The account credentials are invalid.");
    }
    const targetAccount = this.deps.requireAccount(targetAccountId);
    this.deps.requireAccountAuthenticationAllowed(targetAccount);
    const pin = this.deps.normalizePin(input.pin);
    const attemptKey = `merge:${input.channel}:${destination}`;
    this.deps.requirePinAttemptAllowed(attemptKey, now);
    const pinHash = this.deps.accountPinHashes.get(targetAccount.id);
    if (pinHash === undefined) {
      this.deps.simulateFailedPinCheck(pin);
      this.deps.recordFailedPinAttempt(attemptKey, now);
      throw new Cp2Error(401, "auth_credentials_invalid", "The account credentials are invalid.");
    }
    if (!this.deps.verifyStoredPin(targetAccount.id, pin, pinHash)) {
      this.deps.recordFailedPinAttempt(attemptKey, now);
      throw new Cp2Error(401, "auth_credentials_invalid", "The account credentials are invalid.");
    }
    this.deps.failedPinAttempts.delete(attemptKey);

    const targetUserId = this.deps.requireUser(this.deps.userByAccount.get(targetAccount.id)).id;
    this.deps.mergeDeviceAccountData(
      sourceSession.account.id,
      sourceSession.user.id,
      targetAccount.id,
      targetUserId
    );
    const session = this.deps.createSession(
      this.deps.requireAccount(targetAccount.id),
      this.deps.requireUser(targetUserId),
      now
    );
    this.deps.markSessionPinVerified(session.id, now);
    const refreshToken = this.deps.consumeSessionRefreshToken(session.id);
    for (const bootstrap of this.deviceAccountBootstraps.values()) {
      if (
        bootstrap.accountId === targetAccount.id &&
        !this.deps.sessions.has(bootstrap.sessionId)
      ) {
        bootstrap.sessionId = session.id;
      }
    }
    this.deps.recordSecurityEvent("auth.device_account_merged", targetAccount.id, "success", now, {
      sourceIdentityLevel: sourceSession.account.identityLevel,
      proof: "pin"
    });
    return { ...this.deps.requireAnySession(session.id, now), isNewAccount: false, refreshToken };
  }
}
