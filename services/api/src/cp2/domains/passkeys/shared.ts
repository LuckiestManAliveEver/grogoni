/**
 * Twelfth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns `passkeys`, `passkeyCeremonies`, and
 * `passkeyPinRecoveryGrants` - the first slice carved out of the "core auth/identity/session"
 * kernel that an earlier row of the roadmap doc flagged as too large/risky to extract as one
 * unit. Passkeys turned out extractable with the exact same pattern as every other domain -
 * nothing here required a raw mutable reference into `sessions`/`accounts`, confirmed by reading
 * every ceremony-completion method body directly rather than inferring from names.
 *
 * `completePasskeyAuthentication` creates a session via a `createSession` callback (the "call
 * back up" pattern used throughout this whole effort) rather than writing `sessions` directly.
 * The one real coupling problem was `recoverPhoneAccountPinWithPasskey`, which raw-iterated
 * `sessions` to revoke every other session for the account and raw-read/wrote
 * `accountPinHashes` to reset the login PIN - both patterns already duplicated inline in several
 * `Cp2Store`-only methods (`changePassword`, `resetRecoveredPassword`, `revokeSessionsForAccount`),
 * confirming `sessions`/`accountPinHashes` are core-kernel state that legitimately stays put. Four
 * small new callbacks (`revokeOtherSessionsForAccount`, `resetAccountPinHash`,
 * `hasAccountPinHash`, `hasPasswordCredential`) resolve it the same way every other domain
 * resolves a dependency on not-yet-extracted core state - Cp2Store implements each as a one-line
 * wrapper around Maps it already owns. `normalizePin` is injected as a callback too (rather than
 * moved or value-imported back from store.ts, which would recreate the circular-value-import
 * problem `cp2-error.ts`/`money.ts`/`text-normalization.ts` were split out to avoid) so that
 * `recoverPhoneAccountPinWithPasskey` keeps validating the PIN format at the exact same point in
 * its control flow as before the extraction - normalizing it lazily inside a hashing callback
 * instead would silently reorder which error wins when both the PIN and the session are invalid.
 *
 * Recovery grants are persisted as internal, session-bound auth transactions through callbacks
 * into Cp2Store so proof survives the hosted runtime's per-request snapshot hydration.
 */
import type { PasskeySummary } from "@grogoni/shared-types";

export const passkeyCeremonyTtlMs = 5 * 60 * 1000;
export const passkeyPinRecoveryGrantTtlMs = 5 * 60 * 1000;
export const maxPendingPasskeyCeremonies = 1_000;

export interface PasskeyCredentialRecord extends PasskeySummary {
  accountId: string;
  userId: string;
  webauthnUserId: string;
  publicKey: string;
  counter: number;
}

export interface PasskeyCeremonyRecord {
  id: string;
  kind: "registration" | "authentication";
  purpose?: "login" | "pin_recovery";
  accountId: string | null;
  challenge: string;
  webauthnUserId: string | null;
  expiresAt: string;
  createdAt: string;
}

export function passkeyView(passkey: PasskeyCredentialRecord): PasskeySummary {
  return {
    id: passkey.id,
    label: passkey.label,
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    transports: [...passkey.transports],
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt
  };
}

export function normalizePasskeyLabel(label: string | undefined): string {
  const normalized = label?.trim();
  return normalized === undefined || normalized.length === 0 ? "Passkey" : normalized.slice(0, 80);
}
