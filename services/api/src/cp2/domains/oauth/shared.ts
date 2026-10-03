/**
 * Thirteenth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns `userIdentities`, `oauthSessions`,
 * and the derived `identityByProviderSubject`/`identityByEmail` indexes - the second slice
 * carved out of the "core auth/identity/session kernel" the roadmap doc originally flagged as
 * too large/risky to extract as one unit, following the same standard row 11 (Passkeys)
 * established: investigate the actual coupling, don't assume it either way.
 *
 * **The core risk - does OAuth login completion write `sessions`/`accounts` directly - was
 * investigated and the answer is no**, matching row 11's finding for passkeys exactly.
 * `completeOAuthProfileAuthentication` resolves/creates the account via `createAccount`/
 * `requireAccount` callbacks and produces the session via a `createSession` callback, the same
 * "call back up" pattern used throughout this effort. The real coupling was three raw touches
 * into core-kernel Maps this cluster doesn't own (`userByAccount` read, `users` write,
 * `accountByDestination` write) plus the `accountPinHashes` last-login-method guard already
 * solved by row 11's `hasAccountPinHash` callback - all four resolved the same way row 11
 * resolved its own core-kernel coupling: small callbacks `Cp2Store` implements as one-line
 * wrappers around Maps it already owns.
 *
 * `findIdentityByVerifiedEmail` is a public accessor here (not private) because
 * `completeOtpVerification` - still directly on `Cp2Store`, part of the not-yet-extracted OTP
 * cluster - calls it to avoid creating a duplicate account when an OTP-verified email is already
 * linked as an OAuth identity. This is exactly the kind of reverse coupling a Map-name-only grep
 * would miss (it only shows up as a private-method call, never a `this.userIdentities` touch) -
 * caught here by directly reading every method that touches this cluster's private helpers, not
 * just its Maps.
 *
 * `deleteShopOwnedData` (business-scoped, stays on `Cp2Store`) redacts encrypted OAuth tokens on
 * `userIdentities` entries belonging to the account whose shop is being deleted, even though
 * `userIdentities` is account-scoped, not shop-scoped - a pre-existing defense-in-depth step,
 * preserved verbatim via a mutable `userIdentitiesMap` getter, the same pattern used throughout
 * `deleteShopOwnedData`/`deleteAccountOwnedData` for every other extracted domain.
 *
 * `otpTtlMs` moved to the genuinely-shared `text-normalization.ts` rather than either domain's
 * `shared.ts`, since `beginOAuthSession` (this cluster) and `requestOtp` (the not-yet-extracted
 * OTP cluster, still on `Cp2Store`) both need it - the same class of gap row 8 hit for
 * `readBoundedSecurityInteger`/`isSupportedLanguage`.
 */
import type {
  AuthSessionView,
  OAuthProvider,
  OAuthSessionSummary,
  UserIdentitySummary
} from "@grogoni/shared-types";
import type { UserIdentityRecord } from "../../domain-contracts.js";
export type { UserIdentityRecord } from "../../domain-contracts.js";

export interface OAuthSessionRecord extends OAuthSessionSummary {
  accountId: string | null;
  stateHash: string;
  csrfHash: string;
  codeChallenge: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  csrfToken: string;
  expiresAt: string;
  provider: OAuthProvider;
  state: string;
}

export interface OAuthCallbackResult extends AuthSessionView {
  identity: UserIdentitySummary;
  linked: boolean;
  resumed: boolean;
}

export interface ConnectedSocialAccountSummary {
  id: string;
  provider: OAuthProvider;
  providerName: string;
  connected: boolean;
  displayName: string | null;
  email: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
}

export function oauthProviderSubjectKey(provider: OAuthProvider, subject: string): string {
  return `${provider}:${subject}`;
}

export function oauthIdentityEmailKey(provider: OAuthProvider, email: string): string {
  return `${provider}:${email}`;
}

export function oauthEmailLocalPart(subject: string): string {
  return (
    subject
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 64) || "profile"
  );
}

export function userIdentityView(identity: UserIdentityRecord): UserIdentitySummary {
  return {
    id: identity.id,
    accountId: identity.accountId,
    userId: identity.userId,
    provider: identity.provider,
    providerSubject: identity.providerSubject,
    email: identity.email,
    displayName: identity.displayName,
    linkedAt: identity.linkedAt
  };
}

export function oauthSessionView(session: OAuthSessionRecord): OAuthSessionSummary {
  return {
    id: session.id,
    provider: session.provider,
    expiresAt: session.expiresAt,
    completedAt: session.completedAt,
    createdAt: session.createdAt
  };
}
