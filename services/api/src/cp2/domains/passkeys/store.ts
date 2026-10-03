import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import type {
  AccountSummary,
  AuthSessionView,
  PasskeySummary,
  UserSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import {
  maxPendingPasskeyCeremonies,
  normalizePasskeyLabel,
  passkeyCeremonyTtlMs,
  passkeyPinRecoveryGrantTtlMs,
  passkeyView,
  type PasskeyCeremonyRecord,
  type PasskeyCredentialRecord
} from "./shared.js";
import type { Cp2Snapshot } from "../../store.js";

export interface PasskeyDomainDeps {
  requireAnySession: (sessionId: string | null, now: Date) => AuthSessionView;
  requireRecentlyAuthenticatedSession: (sessionId: string | null, now: Date) => AuthSessionView;
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthSessionView;
  markSessionPinVerified: (sessionId: string, now: Date) => void;
  getSession: (sessionId: string | null, now?: Date) => AuthSessionView | null;
  requireAccount: (accountId: string) => AccountSummary;
  requireUser: (userId: string | undefined) => UserSummary;
  requireAccountAuthenticationAllowed: (account: AccountSummary) => void;
  createSession: (account: AccountSummary, user: UserSummary, now: Date) => { id: string };
  promoteAccountIdentityLevel: (
    accountId: string,
    nextLevel: AccountSummary["identityLevel"]
  ) => AccountSummary;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  normalizePin: (pin: string) => string;
  hasAccountPinHash: (accountId: string) => boolean;
  resetAccountPinHash: (accountId: string, normalizedPin: string) => void;
  hasPasswordCredential: (accountId: string) => boolean;
  revokeOtherSessionsForAccount: (
    accountId: string,
    exceptSessionId: string,
    reason: string,
    now: Date
  ) => void;
  passkeyAuthenticationVerifier?: typeof verifyAuthenticationResponse;
}

export class PasskeyDomain {
  private readonly passkeys = new Map<string, PasskeyCredentialRecord>();
  private readonly passkeyCeremonies = new Map<string, PasskeyCeremonyRecord>();
  private readonly passkeyPinRecoveryGrants = new Map<string, string>();

  constructor(private readonly deps: PasskeyDomainDeps) {}

  get passkeysMap(): Map<string, PasskeyCredentialRecord> {
    return this.passkeys;
  }

  get passkeyCeremoniesMap(): Map<string, PasskeyCeremonyRecord> {
    return this.passkeyCeremonies;
  }

  clear(): void {
    this.passkeys.clear();
    this.passkeyCeremonies.clear();
    this.passkeyPinRecoveryGrants.clear();
  }

  consumePinRecoveryGrant(sessionId: string): void {
    this.passkeyPinRecoveryGrants.delete(sessionId);
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const passkey of snapshot.passkeys ?? []) {
      this.passkeys.set(passkey.id, passkey);
    }
    for (const ceremony of snapshot.passkeyCeremonies ?? []) {
      this.passkeyCeremonies.set(ceremony.id, ceremony);
    }
  }

  recoverPhoneAccountPinWithPasskey(input: {
    sessionId: string | null;
    pin: string;
    now?: Date;
  }): AuthSessionView {
    const now = input.now ?? new Date();
    const pin = this.deps.normalizePin(input.pin);
    const session = this.deps.requireAnySession(input.sessionId, now);
    this.prunePasskeyPinRecoveryGrants(now);
    const grantExpiresAt = this.passkeyPinRecoveryGrants.get(session.session.id);

    if (grantExpiresAt === undefined || Date.parse(grantExpiresAt) <= now.getTime()) {
      throw new Cp2Error(
        401,
        "passkey_pin_recovery_required",
        "Verify a passkey before resetting this phone account PIN."
      );
    }

    if (session.account.primaryAuthChannel !== "phone") {
      throw new Cp2Error(
        409,
        "phone_pin_recovery_not_applicable",
        "Passkey PIN recovery is available only for phone accounts."
      );
    }

    if (!this.deps.hasAccountPinHash(session.account.id)) {
      throw new Cp2Error(409, "pin_not_set", "Login PIN has not been set.");
    }

    // Eligibility failures above must leave the short-lived proof available so the caller can
    // take the correct setup/recovery path. The mutation is synchronous, so consuming immediately
    // after it succeeds is atomic with respect to another request and never burns a grant on a
    // credential-write exception.
    this.deps.resetAccountPinHash(session.account.id, pin);
    this.passkeyPinRecoveryGrants.delete(session.session.id);
    this.deps.revokeOtherSessionsForAccount(
      session.account.id,
      session.session.id,
      "pin_recovery",
      now
    );

    this.deps.markSessionPinVerified(session.session.id, now);
    this.deps.recordAuditEvent({
      type: "auth.pin_recovered",
      aggregateType: "account",
      aggregateId: session.account.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        method: "passkey"
      }
    });

    return this.deps.requireAnySession(session.session.id, now);
  }

  renamePasskey(input: {
    sessionId: string | null;
    credentialId: string;
    label: string;
    now?: Date;
  }): PasskeySummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireRecentlyAuthenticatedSession(input.sessionId, now);
    const passkey = this.passkeys.get(input.credentialId);
    if (!passkey || passkey.accountId !== session.account.id)
      throw new Cp2Error(404, "passkey_not_found", "Passkey was not found.");
    passkey.label = normalizePasskeyLabel(input.label);
    return passkeyView(passkey);
  }

  async beginPasskeyRegistration(input: {
    sessionId: string | null;
    rpId: string;
    now?: Date;
  }): Promise<{
    ceremonyId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    const now = input.now ?? new Date();
    const session = this.deps.requireRecentlyAuthenticatedSession(input.sessionId, now);
    this.prunePasskeyCeremonies(now);
    const accountPasskeys = [...this.passkeys.values()].filter(
      (passkey) => passkey.accountId === session.account.id
    );
    const userName = session.account.primaryAuthDestination;
    const displayName = session.user.displayName.trim() || userName;
    const options = await generateRegistrationOptions({
      rpName: "Grogoni",
      rpID: input.rpId,
      userID: new TextEncoder().encode(session.account.id),
      userName,
      userDisplayName: displayName,
      attestationType: "none",
      excludeCredentials: accountPasskeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports as AuthenticatorTransportFuture[]
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      },
      supportedAlgorithmIDs: [-7, -257]
    });
    const ceremony: PasskeyCeremonyRecord = {
      id: randomUUID(),
      kind: "registration",
      accountId: session.account.id,
      challenge: options.challenge,
      webauthnUserId: options.user.id,
      expiresAt: new Date(now.getTime() + passkeyCeremonyTtlMs).toISOString(),
      createdAt: now.toISOString()
    };
    this.passkeyCeremonies.set(ceremony.id, ceremony);

    return {
      ceremonyId: ceremony.id,
      options
    };
  }

  async completePasskeyRegistration(input: {
    sessionId: string | null;
    ceremonyId: string;
    label?: string;
    origin: string;
    rpId: string;
    response: RegistrationResponseJSON;
    now?: Date;
  }): Promise<PasskeySummary> {
    const now = input.now ?? new Date();
    const session = this.deps.requireRecentlyAuthenticatedSession(input.sessionId, now);
    const ceremony = this.takePasskeyCeremony(input.ceremonyId, "registration", now);

    if (ceremony.accountId !== session.account.id || ceremony.webauthnUserId === null) {
      throw new Cp2Error(403, "passkey_ceremony_invalid", "Passkey registration is invalid.");
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: input.origin,
        expectedRPID: input.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257]
      });
    } catch {
      throw new Cp2Error(401, "passkey_registration_invalid", "Passkey registration failed.");
    }

    if (!verification.verified) {
      throw new Cp2Error(401, "passkey_registration_invalid", "Passkey registration failed.");
    }

    const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
    if (this.passkeys.has(credential.id)) {
      throw new Cp2Error(409, "passkey_exists", "This passkey is already registered.");
    }

    const passkey: PasskeyCredentialRecord = {
      id: credential.id,
      accountId: session.account.id,
      userId: session.user.id,
      webauthnUserId: ceremony.webauthnUserId,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      label: normalizePasskeyLabel(input.label),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: [...(credential.transports ?? [])],
      createdAt: now.toISOString(),
      lastUsedAt: null
    };
    this.passkeys.set(passkey.id, passkey);
    this.deps.promoteAccountIdentityLevel(session.account.id, "strong");
    this.deps.recordAuditEvent({
      type: "auth.passkey_registered",
      aggregateType: "account",
      aggregateId: session.account.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        credentialId: passkey.id,
        deviceType: passkey.deviceType,
        backedUp: passkey.backedUp
      }
    });

    return passkeyView(passkey);
  }

  async beginPasskeyAuthentication(input: {
    rpId: string;
    purpose?: "login" | "pin_recovery";
    now?: Date;
  }): Promise<{
    ceremonyId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const now = input.now ?? new Date();
    this.prunePasskeyCeremonies(now);
    this.prunePasskeyPinRecoveryGrants(now);
    const options = await generateAuthenticationOptions({
      rpID: input.rpId,
      userVerification: "required"
    });
    const ceremony: PasskeyCeremonyRecord = {
      id: randomUUID(),
      kind: "authentication",
      purpose: input.purpose ?? "login",
      accountId: null,
      challenge: options.challenge,
      webauthnUserId: null,
      expiresAt: new Date(now.getTime() + passkeyCeremonyTtlMs).toISOString(),
      createdAt: now.toISOString()
    };
    this.passkeyCeremonies.set(ceremony.id, ceremony);

    return {
      ceremonyId: ceremony.id,
      options
    };
  }

  async completePasskeyAuthentication(input: {
    ceremonyId: string;
    origin: string;
    rpId: string;
    response: AuthenticationResponseJSON;
    now?: Date;
  }): Promise<AuthSessionView> {
    const now = input.now ?? new Date();
    const ceremony = this.takePasskeyCeremony(input.ceremonyId, "authentication", now);
    const passkey = this.passkeys.get(input.response.id);

    if (passkey === undefined) {
      throw new Cp2Error(401, "passkey_unknown", "Passkey sign-in failed.");
    }

    if (
      input.response.response.userHandle !== undefined &&
      input.response.response.userHandle !== passkey.webauthnUserId
    ) {
      throw new Cp2Error(401, "passkey_user_mismatch", "Passkey sign-in failed.");
    }

    let verification;
    try {
      verification = await (
        this.deps.passkeyAuthenticationVerifier ?? verifyAuthenticationResponse
      )({
        response: input.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: input.origin,
        expectedRPID: input.rpId,
        credential: {
          id: passkey.id,
          publicKey: Buffer.from(passkey.publicKey, "base64url"),
          counter: passkey.counter,
          transports: passkey.transports as AuthenticatorTransportFuture[]
        },
        requireUserVerification: true
      });
    } catch {
      throw new Cp2Error(401, "passkey_authentication_invalid", "Passkey sign-in failed.");
    }

    if (!verification.verified) {
      throw new Cp2Error(401, "passkey_authentication_invalid", "Passkey sign-in failed.");
    }

    passkey.counter = verification.authenticationInfo.newCounter;
    passkey.backedUp = verification.authenticationInfo.credentialBackedUp;
    passkey.deviceType = verification.authenticationInfo.credentialDeviceType;
    passkey.lastUsedAt = now.toISOString();
    const account = this.deps.requireAccount(passkey.accountId);
    this.deps.requireAccountAuthenticationAllowed(account);
    const user = this.deps.requireUser(passkey.userId);
    const createdSession = this.deps.createSession(account, user, now);
    this.deps.markSessionPinVerified(createdSession.id, now);
    if (ceremony.purpose === "pin_recovery") {
      this.passkeyPinRecoveryGrants.set(
        createdSession.id,
        new Date(now.getTime() + passkeyPinRecoveryGrantTtlMs).toISOString()
      );
    }
    this.deps.recordAuditEvent({
      type: "auth.passkey_login",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: user.id,
      occurredAt: now.toISOString(),
      payload: {
        credentialId: passkey.id,
        purpose: ceremony.purpose ?? "login"
      }
    });

    return this.deps.requireAnySession(createdSession.id, now);
  }

  listPasskeys(input: { sessionId: string | null; now?: Date }): PasskeySummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    return [...this.passkeys.values()]
      .filter((passkey) => passkey.accountId === session.account.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(passkeyView);
  }

  revokePasskey(input: { sessionId: string | null; credentialId: string; now?: Date }): {
    revoked: true;
  } {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const passkey = this.passkeys.get(input.credentialId);

    if (passkey === undefined || passkey.accountId !== session.account.id) {
      throw new Cp2Error(404, "passkey_not_found", "Passkey was not found.");
    }

    const remainingPasskeys = [...this.passkeys.values()].filter(
      (candidate) => candidate.accountId === session.account.id && candidate.id !== passkey.id
    );
    if (
      remainingPasskeys.length === 0 &&
      !this.deps.hasPasswordCredential(session.account.id) &&
      !this.deps.hasAccountPinHash(session.account.id)
    ) {
      throw new Cp2Error(
        409,
        "final_login_method_required",
        "Add another login method before removing this passkey."
      );
    }

    this.passkeys.delete(passkey.id);
    this.deps.recordAuditEvent({
      type: "auth.passkey_revoked",
      aggregateType: "account",
      aggregateId: session.account.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        credentialId: passkey.id
      }
    });

    return { revoked: true };
  }

  private prunePasskeyCeremonies(now: Date): void {
    for (const [ceremonyId, ceremony] of this.passkeyCeremonies) {
      if (Date.parse(ceremony.expiresAt) <= now.getTime()) {
        this.passkeyCeremonies.delete(ceremonyId);
      }
    }

    if (this.passkeyCeremonies.size < maxPendingPasskeyCeremonies) {
      return;
    }

    const overflow = [...this.passkeyCeremonies.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, this.passkeyCeremonies.size - maxPendingPasskeyCeremonies + 1);
    for (const ceremony of overflow) {
      this.passkeyCeremonies.delete(ceremony.id);
    }
  }

  private prunePasskeyPinRecoveryGrants(now: Date): void {
    for (const [sessionId, expiresAt] of this.passkeyPinRecoveryGrants) {
      if (Date.parse(expiresAt) <= now.getTime() || this.deps.getSession(sessionId, now) === null) {
        this.passkeyPinRecoveryGrants.delete(sessionId);
      }
    }
  }

  private takePasskeyCeremony(
    ceremonyId: string,
    kind: PasskeyCeremonyRecord["kind"],
    now: Date
  ): PasskeyCeremonyRecord {
    this.prunePasskeyCeremonies(now);
    const ceremony = this.passkeyCeremonies.get(ceremonyId);
    this.passkeyCeremonies.delete(ceremonyId);

    if (ceremony === undefined || ceremony.kind !== kind) {
      throw new Cp2Error(400, "passkey_ceremony_invalid", "Passkey request expired or is invalid.");
    }

    return ceremony;
  }
}
