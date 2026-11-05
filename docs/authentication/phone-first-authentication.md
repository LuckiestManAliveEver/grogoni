# Phone-first authentication architecture

The canonical account key remains `accounts.id` (UUID). Phone and email identities resolve to that
key through `account_identities`; neither contact value is a database primary key. Existing
`accounts.primary_auth_*`, PIN credentials, OAuth identities, sessions, and passkeys remain readable
during migration.

## State machine

`mobile phone → signup transaction → profile/password (required) → session`

`user chooses login → mobile phone → registered passkey first → PIN/password alternatives (or enrolled native Android device key) → session`

`identifier → generic recovery response → channel verification → optional MFA → password reset → rotated session`

`mobile phone → "Trouble logging in?" → Device security → user-verified passkey or Android Keystore proof → new PIN or password`

Phone signup requires a password and then offers explicit device-security recovery enrollment.
Existing accounts can enroll in account security settings. Browser recovery requires a previously
registered WebAuthn passkey with user verification; ordinary passkey login cannot authorize
credential resets. Native Android recovery requires authentication to unlock an enrolled Keystore
key and a fresh server challenge. Passkey login is preferred when enabled, with PIN/password alternatives.
See [Device security recovery](device-security-recovery.md) for the protocol, compatibility,
revocation, notification policy and testing details.

Guests receive a cookie-backed device account through `/auth/continue`, without a login or signup
form. Personal and direct conversations use the same messaging APIs throughout that account's
lifetime. Missing sessions are restored with the device key or continued without opening login.
Guests can browse, buy and use personal app functions without enrolling a PIN or passkey. Store
setup and store-management APIs require a signed-in account as well as ordinary membership checks.

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

Interactive browser recovery uses server-generated WebAuthn challenges bound to the supplied
phone account, origin, RP ID and recovery purpose. Native recovery signs a server challenge with
an authentication-bound P-256 Android Keystore key. Both issue five-minute, single-use recovery
grants for the existing PIN/password reset endpoints. Recovery transactions persist across hosted
requests. Verified backup email remains available when no enrolled credential can be used.

Legacy IndexedDB keys still support device-account session restoration; they are not used by the
interactive browser PIN/password recovery screen. Passkey enrollment requires an authenticated,
explicit user action. Legacy native keys require re-enrollment to gain device authentication.

Existing email identities, OAuth records, and Grogoni storefront IDs remain stored for their
non-login uses. Existing accounts need a linked phone number to use the mobile login flow.
Firebase phone authentication and its client code were previously removed; no phone verification
provider, SMS gateway, or SMS recovery route is present.

The audited login-loop failure mode is an expired 15-minute access cookie being treated as a
terminal logout before the rotating refresh cookie is tried, especially when stale PWA navigation
state is involved. The existing client already sent credentials and coalesced refresh attempts; this
rollout preserves that behavior, retains only non-secret cached session display data, and extends
network-only/no-store handling to every new auth and session route alias.
