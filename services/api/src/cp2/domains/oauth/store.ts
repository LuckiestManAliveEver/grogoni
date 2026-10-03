import { randomUUID } from "node:crypto";
import type {
  AccountSummary,
  AuthChannel,
  AuthSessionView,
  OAuthProvider,
  OAuthSessionSummary,
  SessionSummary,
  UserIdentitySummary,
  UserSummary
} from "@grogoni/shared-types";
import type { BusinessPermission } from "@grogoni/business-core";
import {
  assertOAuthSecretMatches,
  decryptOAuthToken,
  encryptOAuthToken,
  hashOAuthSecret,
  type OAuthProfile,
  type OAuthTokenResponse
} from "../../oauth.js";
import { Cp2Error } from "../../cp2-error.js";
import { otpTtlMs } from "../../text-normalization.js";
import { normalizeDestination } from "../../phone-identity.js";
import { providerDisplayName } from "../../public-identifiers.js";
import type { AccountIdentityRecord, VerifyOtpResult } from "../../store.js";
import {
  oauthEmailLocalPart,
  oauthIdentityEmailKey,
  oauthProviderSubjectKey,
  userIdentityView,
  type ConnectedSocialAccountSummary,
  type OAuthCallbackResult,
  type OAuthStartResult,
  type OAuthSessionRecord,
  type UserIdentityRecord
} from "./shared.js";
import type { Cp2Snapshot } from "../../store.js";

export interface OAuthDomainDeps {
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthSessionView;
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthSessionView;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  createAccount: (
    channel: AccountSummary["primaryAuthChannel"],
    destination: string,
    now: Date
  ) => AccountSummary;
  requireAccount: (accountId: string) => AccountSummary;
  userForAccount: (accountId: string) => UserSummary;
  updateUserDisplayName: (userId: string, displayName: string) => void;
  linkEmailAccountDestination: (email: string, accountId: string) => void;
  addAccountIdentity: (
    account: AccountSummary,
    user: UserSummary,
    type: AuthChannel,
    value: string,
    isPrimary: boolean,
    now: Date,
    verified: boolean
  ) => AccountIdentityRecord;
  promoteAccountIdentityLevel: (
    accountId: string,
    nextLevel: AccountSummary["identityLevel"]
  ) => AccountSummary;
  createSession: (account: AccountSummary, user: UserSummary, now: Date) => SessionSummary;
  markSessionPinVerified: (sessionId: string, now: Date) => void;
  resolveAnyIdentityAccount: (type: AuthChannel, normalizedValue: string) => string | undefined;
  hasAccountPinHash: (accountId: string) => boolean;
}

export class OAuthDomain {
  private readonly userIdentities = new Map<string, UserIdentityRecord>();
  private readonly identityByProviderSubject = new Map<string, string>();
  private readonly identityByEmail = new Map<string, string>();
  private readonly oauthSessions = new Map<string, OAuthSessionRecord>();

  constructor(private readonly deps: OAuthDomainDeps) {}

  get userIdentitiesMap(): Map<string, UserIdentityRecord> {
    return this.userIdentities;
  }

  get oauthSessionsMap(): Map<string, OAuthSessionRecord> {
    return this.oauthSessions;
  }

  getConnectedProviderAccess(input: {
    sessionId: string | null;
    provider: OAuthProvider;
    requiredScope?: string;
    now?: Date;
  }): { accessToken: string; scope: string | null } {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const identity = [...this.userIdentities.values()].find(
      (candidate) =>
        candidate.accountId === session.account.id && candidate.provider === input.provider
    );

    if (identity?.encryptedAccessToken === null || identity?.encryptedAccessToken === undefined) {
      throw new Cp2Error(409, "network_provider_not_connected", "Connect this provider first.");
    }
    if (
      input.requiredScope !== undefined &&
      !identity.scope?.split(/\s+/).includes(input.requiredScope)
    ) {
      throw new Cp2Error(
        409,
        "provider_permission_required",
        "Reconnect this provider and approve contact access."
      );
    }
    if (identity.tokenExpiresAt !== null && Date.parse(identity.tokenExpiresAt) <= now.getTime()) {
      throw new Cp2Error(
        409,
        "provider_token_expired",
        "Provider access expired. Reconnect the provider to continue."
      );
    }

    return {
      accessToken: decryptOAuthToken(identity.encryptedAccessToken),
      scope: identity.scope
    };
  }

  clear(): void {
    this.userIdentities.clear();
    this.identityByProviderSubject.clear();
    this.identityByEmail.clear();
    this.oauthSessions.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const identity of snapshot.userIdentities) {
      const persistedIdentity = identity as UserIdentitySummary &
        Partial<
          Pick<
            UserIdentityRecord,
            | "encryptedAccessToken"
            | "encryptedRefreshToken"
            | "encryptedIdToken"
            | "tokenType"
            | "tokenExpiresAt"
            | "scope"
            | "updatedAt"
          >
        >;
      const record = {
        ...persistedIdentity,
        encryptedAccessToken: persistedIdentity.encryptedAccessToken ?? null,
        encryptedRefreshToken: persistedIdentity.encryptedRefreshToken ?? null,
        encryptedIdToken: persistedIdentity.encryptedIdToken ?? null,
        tokenType: persistedIdentity.tokenType ?? null,
        tokenExpiresAt: persistedIdentity.tokenExpiresAt ?? null,
        scope: persistedIdentity.scope ?? null,
        updatedAt: persistedIdentity.updatedAt ?? identity.linkedAt
      };
      this.userIdentities.set(record.id, record);
      this.identityByProviderSubject.set(
        oauthProviderSubjectKey(record.provider, record.providerSubject),
        record.id
      );

      if (record.email !== null) {
        this.identityByEmail.set(oauthIdentityEmailKey(record.provider, record.email), record.id);
      }
    }

    for (const oauthSession of snapshot.oauthSessions) {
      const persistedSession = oauthSession as OAuthSessionSummary &
        Partial<
          Pick<
            OAuthSessionRecord,
            | "accountId"
            | "stateHash"
            | "csrfHash"
            | "codeChallenge"
            | "codeVerifier"
            | "redirectUri"
          >
        >;
      this.oauthSessions.set(persistedSession.id, {
        ...persistedSession,
        accountId: persistedSession.accountId ?? null,
        stateHash: persistedSession.stateHash ?? "",
        csrfHash: persistedSession.csrfHash ?? "",
        codeChallenge: persistedSession.codeChallenge ?? "",
        codeVerifier: persistedSession.codeVerifier ?? "",
        redirectUri: persistedSession.redirectUri ?? ""
      });
    }
  }

  rebuildIdentityIndex(): void {
    this.identityByProviderSubject.clear();
    this.identityByEmail.clear();
    for (const identity of this.userIdentities.values()) {
      this.identityByProviderSubject.set(
        oauthProviderSubjectKey(identity.provider, identity.providerSubject),
        identity.id
      );
      if (identity.email !== null) {
        this.identityByEmail.set(
          oauthIdentityEmailKey(identity.provider, identity.email),
          identity.id
        );
      }
    }
  }

  authenticateSocialProfile(input: {
    provider: string;
    email: string;
    displayName?: string;
    now?: Date;
  }): VerifyOtpResult {
    const result = this.completeOAuthProfileAuthentication({
      provider: input.provider as OAuthProvider,
      profile: {
        providerSubject: normalizeDestination("email", input.email),
        email: input.email,
        emailVerified: true,
        displayName: input.displayName ?? null
      },
      tokens: {},
      ...(input.now === undefined ? {} : { now: input.now })
    });

    return {
      account: result.account,
      user: result.user,
      session: result.session,
      resumed: result.resumed
    };
  }

  beginOAuthSession(input: {
    accountSessionId: string | null;
    authorizationUrl: string;
    codeChallenge: string;
    codeVerifier: string;
    csrfToken: string;
    provider: OAuthProvider;
    redirectUri: string;
    state: string;
    now?: Date;
  }): OAuthStartResult {
    const now = input.now ?? new Date();
    const accountSession =
      input.accountSessionId === null
        ? null
        : this.deps.requirePinVerifiedSession(input.accountSessionId, now);
    const oauthSession: OAuthSessionRecord = {
      id: randomUUID(),
      provider: input.provider,
      accountId: accountSession?.account.id ?? null,
      stateHash: hashOAuthSecret(input.state),
      csrfHash: hashOAuthSecret(input.csrfToken),
      codeChallenge: input.codeChallenge,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      expiresAt: new Date(now.getTime() + otpTtlMs).toISOString(),
      completedAt: null,
      createdAt: now.toISOString()
    };

    this.oauthSessions.set(oauthSession.id, oauthSession);
    this.deps.recordAuditEvent({
      type: "auth.oauth_started",
      aggregateType: "oauth_session",
      aggregateId: oauthSession.id,
      actorId: accountSession?.user.id ?? "anonymous",
      occurredAt: now.toISOString(),
      payload: {
        provider: input.provider,
        accountId: accountSession?.account.id ?? null
      }
    });

    return {
      authorizationUrl: input.authorizationUrl,
      csrfToken: input.csrfToken,
      expiresAt: oauthSession.expiresAt,
      provider: input.provider,
      state: input.state
    };
  }

  getOAuthExchangeData(input: {
    provider: OAuthProvider;
    state: string;
    csrfToken: string;
    now?: Date;
  }): { codeVerifier: string; redirectUri: string } {
    const oauthSession = this.getOAuthSessionForCallback(input);

    return {
      codeVerifier: oauthSession.codeVerifier,
      redirectUri: oauthSession.redirectUri
    };
  }

  private getOAuthSessionForCallback(input: {
    provider: OAuthProvider;
    state: string;
    csrfToken: string;
    now?: Date;
  }): OAuthSessionRecord {
    const now = input.now ?? new Date();
    const stateHash = hashOAuthSecret(input.state);
    const oauthSession = [...this.oauthSessions.values()].find(
      (session) =>
        session.provider === input.provider &&
        session.completedAt === null &&
        session.stateHash === stateHash
    );

    if (oauthSession === undefined) {
      throw new Cp2Error(404, "oauth_session_not_found", "OAuth session was not found.");
    }

    if (Date.parse(oauthSession.expiresAt) <= now.getTime()) {
      throw new Cp2Error(410, "oauth_session_expired", "OAuth session has expired.");
    }

    assertOAuthSecretMatches(input.state, oauthSession.stateHash, "oauth_state_invalid");
    assertOAuthSecretMatches(input.csrfToken, oauthSession.csrfHash, "oauth_csrf_invalid");

    return oauthSession;
  }

  completeOAuthCallback(input: {
    provider: OAuthProvider;
    state: string;
    csrfToken: string;
    profile: OAuthProfile;
    tokens: OAuthTokenResponse;
    now?: Date;
  }): OAuthCallbackResult {
    const now = input.now ?? new Date();
    const oauthSession = this.getOAuthSessionForCallback({
      provider: input.provider,
      state: input.state,
      csrfToken: input.csrfToken,
      now
    });
    const result = this.completeOAuthProfileAuthentication({
      provider: input.provider,
      profile: input.profile,
      tokens: input.tokens,
      linkAccountId: oauthSession.accountId,
      now
    });

    oauthSession.completedAt = now.toISOString();

    return result;
  }

  completeOAuthProfileAuthentication(input: {
    provider: OAuthProvider;
    profile: OAuthProfile;
    tokens: OAuthTokenResponse;
    linkAccountId?: string | null;
    now?: Date;
  }): OAuthCallbackResult {
    const now = input.now ?? new Date();
    const normalizedEmail =
      input.profile.email === null || !input.profile.emailVerified
        ? null
        : normalizeDestination("email", input.profile.email);
    const providerSubject = input.profile.providerSubject.trim();

    if (providerSubject.length === 0) {
      throw new Cp2Error(400, "oauth_profile_invalid", "OAuth profile subject is required.");
    }

    const linkedIdentityId = this.identityByProviderSubject.get(
      oauthProviderSubjectKey(input.provider, providerSubject)
    );
    const emailIdentityId =
      normalizedEmail === null
        ? undefined
        : this.identityByEmail.get(oauthIdentityEmailKey(input.provider, normalizedEmail));
    const emailAccountId =
      normalizedEmail === null
        ? undefined
        : this.deps.resolveAnyIdentityAccount("email", normalizedEmail);
    const accountId =
      input.linkAccountId ??
      (linkedIdentityId === undefined
        ? undefined
        : this.userIdentities.get(linkedIdentityId)?.accountId) ??
      (emailIdentityId === undefined
        ? undefined
        : this.userIdentities.get(emailIdentityId)?.accountId) ??
      emailAccountId;

    if (normalizedEmail !== null && emailAccountId !== undefined && accountId !== emailAccountId) {
      throw new Cp2Error(409, "identity_in_use", "This sign-in method is already linked.");
    }
    const primaryDestination =
      normalizedEmail ??
      `${input.provider}.${oauthEmailLocalPart(providerSubject)}@oauth.grogoni.local`;
    const account =
      accountId === undefined
        ? this.deps.createAccount("email", primaryDestination, now)
        : this.deps.requireAccount(accountId);
    const user = this.deps.userForAccount(account.id);
    const displayName = input.profile.displayName?.trim();

    if (displayName !== undefined && displayName.length > 0 && user.displayName !== displayName) {
      this.deps.updateUserDisplayName(user.id, displayName);
    }

    if (normalizedEmail !== null) {
      this.deps.linkEmailAccountDestination(normalizedEmail, account.id);
    }

    const nextUser = this.deps.userForAccount(account.id);
    if (normalizedEmail !== null) {
      this.deps.addAccountIdentity(
        account,
        nextUser,
        "email",
        normalizedEmail,
        account.primaryAuthChannel === "email" &&
          account.primaryAuthDestination === normalizedEmail,
        now,
        true
      );
    }
    const identity = this.upsertUserIdentity({
      account,
      user: nextUser,
      provider: input.provider,
      providerSubject,
      email: normalizedEmail,
      displayName: displayName ?? null,
      tokens: input.tokens,
      now
    });
    this.deps.promoteAccountIdentityLevel(account.id, "verified_contact");
    const session = this.deps.createSession(account, nextUser, now);
    this.deps.markSessionPinVerified(session.id, now);
    const resumed = accountId !== undefined;

    this.deps.recordAuditEvent({
      type: "auth.oauth_completed",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: nextUser.id,
      occurredAt: now.toISOString(),
      payload: {
        provider: input.provider,
        identityId: identity.id,
        linked: resumed,
        email: normalizedEmail
      }
    });

    this.deps.recordAuditEvent({
      type: resumed ? "account.resumed" : "account.created",
      aggregateType: "account",
      aggregateId: account.id,
      actorId: nextUser.id,
      occurredAt: now.toISOString(),
      payload: {
        primaryAuthChannel: account.primaryAuthChannel,
        primaryAuthDestination: account.primaryAuthDestination
      }
    });

    return {
      account,
      user: nextUser,
      session,
      identity: userIdentityView(identity),
      linked: resumed,
      resumed
    };
  }

  listLoginAccounts(input: {
    sessionId: string | null;
    now?: Date;
  }): ConnectedSocialAccountSummary[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());

    return [...this.userIdentities.values()]
      .filter((identity) => identity.accountId === session.account.id)
      .map((identity) => ({
        id: identity.id,
        provider: identity.provider,
        providerName: providerDisplayName(identity.provider),
        connected: true,
        displayName: identity.displayName,
        email: identity.email,
        connectedAt: identity.linkedAt,
        lastUsedAt: identity.updatedAt
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  disconnectLoginAccount(input: { sessionId: string | null; identityId: string; now?: Date }): {
    disconnected: true;
    identityId: string;
  } {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const identity = this.userIdentities.get(input.identityId);

    if (identity === undefined || identity.accountId !== session.account.id) {
      throw new Cp2Error(
        404,
        "social_identity_not_found",
        "Connected login account was not found."
      );
    }

    const remainingIdentities = [...this.userIdentities.values()].filter(
      (candidate) => candidate.accountId === session.account.id && candidate.id !== identity.id
    );

    if (!this.deps.hasAccountPinHash(session.account.id) && remainingIdentities.length === 0) {
      throw new Cp2Error(
        409,
        "last_login_method",
        "Add and verify another login method before disconnecting the last login account."
      );
    }

    this.userIdentities.delete(identity.id);
    this.identityByProviderSubject.delete(
      oauthProviderSubjectKey(identity.provider, identity.providerSubject)
    );

    if (identity.email !== null) {
      this.identityByEmail.delete(oauthIdentityEmailKey(identity.provider, identity.email));
    }

    this.deps.recordAuditEvent({
      type: "auth.login_identity_disconnected",
      aggregateType: "account",
      aggregateId: session.account.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        provider: identity.provider,
        identityId: identity.id
      }
    });

    return {
      disconnected: true,
      identityId: identity.id
    };
  }

  listConnectedSocialAccounts(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ConnectedSocialAccountSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );

    return [...this.userIdentities.values()]
      .filter((identity) => identity.accountId === session.account.id)
      .map((identity) => ({
        id: identity.id,
        provider: identity.provider,
        providerName: providerDisplayName(identity.provider),
        connected: true,
        displayName: identity.displayName,
        email: identity.email,
        connectedAt: identity.linkedAt,
        lastUsedAt: identity.updatedAt
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  disconnectSocialAccount(input: {
    sessionId: string | null;
    businessId: string;
    identityId: string;
    now?: Date;
  }): { disconnected: true; identityId: string } {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    const identity = this.userIdentities.get(input.identityId);

    if (identity === undefined || identity.accountId !== session.account.id) {
      throw new Cp2Error(
        404,
        "social_identity_not_found",
        "Connected social account was not found."
      );
    }

    const remainingIdentities = [...this.userIdentities.values()].filter(
      (candidate) => candidate.accountId === session.account.id && candidate.id !== identity.id
    );

    if (!this.deps.hasAccountPinHash(session.account.id) && remainingIdentities.length === 0) {
      throw new Cp2Error(
        409,
        "last_login_method",
        "Add and verify another login method before disconnecting the last social account."
      );
    }

    this.userIdentities.delete(identity.id);
    this.identityByProviderSubject.delete(
      oauthProviderSubjectKey(identity.provider, identity.providerSubject)
    );

    if (identity.email !== null) {
      this.identityByEmail.delete(oauthIdentityEmailKey(identity.provider, identity.email));
    }

    this.deps.recordAuditEvent({
      type: "auth.social_identity_disconnected",
      aggregateType: "account",
      aggregateId: session.account.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        provider: identity.provider,
        identityId: identity.id
      }
    });

    return {
      disconnected: true,
      identityId: identity.id
    };
  }

  private upsertUserIdentity(input: {
    account: AccountSummary;
    user: UserSummary;
    provider: OAuthProvider;
    providerSubject: string;
    email: string | null;
    displayName: string | null;
    tokens: OAuthTokenResponse;
    now: Date;
  }): UserIdentityRecord {
    const providerSubjectKey = oauthProviderSubjectKey(input.provider, input.providerSubject);
    const existingIdentityId = this.identityByProviderSubject.get(providerSubjectKey);
    const tokenExpiresAt =
      input.tokens.expiresIn === undefined
        ? null
        : new Date(input.now.getTime() + input.tokens.expiresIn * 1000).toISOString();
    const existingIdentity =
      existingIdentityId === undefined ? undefined : this.userIdentities.get(existingIdentityId);
    const identity: UserIdentityRecord = {
      id: existingIdentity?.id ?? randomUUID(),
      accountId: input.account.id,
      userId: input.user.id,
      provider: input.provider,
      providerSubject: input.providerSubject,
      email: input.email,
      displayName: input.displayName,
      encryptedAccessToken:
        input.tokens.accessToken === undefined
          ? (existingIdentity?.encryptedAccessToken ?? null)
          : encryptOAuthToken(input.tokens.accessToken),
      encryptedRefreshToken:
        input.tokens.refreshToken === undefined
          ? (existingIdentity?.encryptedRefreshToken ?? null)
          : encryptOAuthToken(input.tokens.refreshToken),
      encryptedIdToken:
        input.tokens.idToken === undefined
          ? (existingIdentity?.encryptedIdToken ?? null)
          : encryptOAuthToken(input.tokens.idToken),
      tokenType: input.tokens.tokenType ?? existingIdentity?.tokenType ?? null,
      tokenExpiresAt: tokenExpiresAt ?? existingIdentity?.tokenExpiresAt ?? null,
      scope: input.tokens.scope ?? existingIdentity?.scope ?? null,
      linkedAt: existingIdentity?.linkedAt ?? input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };

    this.userIdentities.set(identity.id, identity);
    this.identityByProviderSubject.set(providerSubjectKey, identity.id);

    if (input.email !== null) {
      this.identityByEmail.set(oauthIdentityEmailKey(input.provider, input.email), identity.id);
    }

    return identity;
  }

  findIdentityByVerifiedEmail(email: string): UserIdentityRecord | undefined {
    return [...this.userIdentities.values()].find((identity) => identity.email === email);
  }
}
