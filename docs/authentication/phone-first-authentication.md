# Phone-first authentication architecture

The canonical account key remains `accounts.id` (UUID). Phone and email identities resolve to that
key through `account_identities`; neither contact value is a database primary key. Existing
`accounts.primary_auth_*`, PIN credentials, OAuth identities, sessions, and passkeys remain readable
during migration.

## State machine

`mobile phone → signup transaction → profile/password (required) → session`

`mobile phone → methods (PIN primary, password secondary) → PIN or password → MFA when configured → session`

`identifier → generic recovery response → channel verification → optional MFA → password reset → rotated session`

`mobile phone → "Trouble logging in?" → signed device recovery key proves identity → new PIN or password`

Phone signup requires a password. Signup optionally enables device recovery, and existing accounts
can enable it in account security settings. The recovery flow never enrolls or authenticates a
passkey. Existing passkeys remain available for account access, but cannot authorize credential
resets. PIN is the primary method on the phone login screen, with password as a secondary option.

Guests receive a cookie-backed device account through `/auth/continue`, without a login or signup
form. Personal and direct conversations use the same messaging APIs throughout that account's
lifetime. Missing sessions are restored with the device key or continued without opening login.

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

Device recovery uses an ECDSA P-256 key stored in IndexedDB with a non-exportable private key.
The signed assertion is verified by `/auth/device/recover`; its resulting session receives a
five-minute, single-use recovery grant. `/auth/pin/recover/device` and
`/auth/password/recover/device` consume the grant and revoke other sessions. Replayed assertions
cannot replenish a consumed grant. Recovery transactions persist across hosted requests.
Passkey recovery endpoints are removed, and passkey recovery ceremonies are rejected.
Verified backup email remains available for recovery.

This browser implementation relies on device and browser storage protection. It does not invoke
an operating-system biometric or screen-lock prompt. Users must keep their device protected;
clearing browser storage removes the local recovery key.

Existing email identities, OAuth records, and Grogoni storefront IDs remain stored for their
non-login uses. Existing accounts need a linked phone number to use the mobile login flow.
Firebase phone authentication and its client code were previously removed; no phone verification
provider, SMS gateway, or SMS recovery route is present.

The audited login-loop failure mode is an expired 15-minute access cookie being treated as a
terminal logout before the rotating refresh cookie is tried, especially when stale PWA navigation
state is involved. The existing client already sent credentials and coalesced refresh attempts; this
rollout preserves that behavior, retains only non-secret cached session display data, and extends
network-only/no-store handling to every new auth and session route alias.
