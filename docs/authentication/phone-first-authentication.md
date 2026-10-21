# Phone-first authentication architecture

The canonical account key remains `accounts.id` (UUID). Phone and email identities resolve to that
key through `account_identities`; neither contact value is a database primary key. Existing
`accounts.primary_auth_*`, PIN credentials, OAuth identities, sessions, and passkeys remain readable
during migration.

## State machine

`mobile phone → signup transaction → profile/password (required) → session`

`mobile phone → methods (PIN primary, password secondary) → PIN or password → MFA when configured → session`

`identifier → generic recovery response → channel verification → optional MFA → password reset → rotated session`

`mobile phone → "Trouble logging in?" → enrolled passkey proves identity → new PIN or password`

Every account gets a real password at signup - `/auth/signup/complete` rejects a request with no
`password`. Passkeys are optional and never load-bearing: creating one (at signup or later, in
account security settings) only registers a backup credential for the "Trouble logging in?"
recovery path on phone accounts, which proves identity with a passkey ceremony before letting the
owner set a new PIN or password. Passkey login is not offered as a normal sign-in method - there is no
device-hint fast path and no "Continue with a passkey" option on the methods screen; PIN is the
primary method there, with password as a secondary option when the account has one.

Passkeys use discoverable WebAuthn credentials and resolve directly to the same account UUID.
Access cookies last 15 minutes; HTTP-only refresh cookies last 30 days and rotate on use. Reuse
revokes the session family. Authentication responses are `no-store` and the service worker treats
all authentication and session URLs as network-only.

## Reused components

- `Cp2Store` account, user, audit-event, and session infrastructure
- scrypt credential format and constant-time comparison patterns
- `libphonenumber-js` E.164 normalization
- SimpleWebAuthn registration/authentication validation
- Fastify origin allowlist and credentialed CORS
- Resend-compatible email provider
- Postgres compatibility snapshot adapter and relational migrations

## Compatibility and obsolete integrations

Signup and login accept mobile phone identifiers only. Email and Grogoni ID login controls and
legacy email OTP session creation are disabled. A signup may attach an optional backup email,
which must be verified in account security before recovery or MFA can use it. A verified backup
email enables email MFA after either PIN or password verification; enabled authenticator factors
and recovery codes remain available. The MFA transaction and email challenge are bounded by
expiry, attempt limits, and single use. No session cookie is issued before the second factor.

Passkey enrollment uses WebAuthn with required user verification. The browser or operating system
chooses the available device unlock (fingerprint, Face ID, device PIN, or password). A device unlock
alone cannot recover an account without an enrolled passkey. Recovery proof lasts five minutes,
is bound to the new session, persists in an internal recovery transaction across hosted requests,
and is consumed by a successful PIN or password mutation. Password reset revokes other sessions.
Email recovery remains available for a verified backup address.

Existing email identities, OAuth records, and Grogoni storefront IDs remain stored for their
non-login uses. Existing accounts need a linked phone number to use the mobile login flow.
Firebase phone authentication and its client code were previously removed; no phone verification
provider, SMS gateway, or SMS recovery route is present.

The audited login-loop failure mode is an expired 15-minute access cookie being treated as a
terminal logout before the rotating refresh cookie is tried, especially when stale PWA navigation
state is involved. The existing client already sent credentials and coalesced refresh attempts; this
rollout preserves that behavior, retains only non-secret cached session display data, and extends
network-only/no-store handling to every new auth and session route alias.
