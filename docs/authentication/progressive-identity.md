# One-tap signup and progressive identity

## Existing architecture

Grogoni already owned its authentication stack in `services/api/src/cp2`: server-generated account and
user UUIDs, HTTP-only access and rotating refresh cookies, device session metadata, PIN and passkey
credentials, OAuth/email identities, account deletion, and PostgreSQL snapshot/relational
persistence. The web shell restored `/auth/bootstrap`, silently rotated through
`/auth/session/refresh`, and cached only non-secret session summaries. It did not expose refresh
tokens to JavaScript.

Before this change, every account constructor required phone/email/social identity and several
paths required a PIN. A first-time visitor who had no cached session was sent to guest browsing or a
contact form rather than receiving a real account. The session authorization helpers already
treated an account without a PIN as authenticated when it held a valid session, so a second auth
system was unnecessary.

## New user flow

```text
Fresh install
→ Continue to Grogoni
→ POST /auth/continue
→ server-created account + user + secure session
→ personal Grogoni conversation/context
→ Grogoni chat
```

The entry component contains no phone, email, username, PIN, password, OTP, profile, business, or
permission form. Existing users can select **Sign in** to use the unchanged PIN, password, email,
OAuth, or passkey paths.

`POST /auth/continue` returns an already-valid cookie session when one exists. Otherwise it requires
a cryptographically random idempotency key created for that one Continue attempt. The server stores
only its SHA-256 hash for ten minutes. Concurrent calls return the same logical account and session;
after a process restart, a retry may receive a replacement session but still resolves to the same
account. The frontend keeps the attempt key in `localStorage` only until success or its ten-minute
expiry so a PWA relaunch can finish the same attempt. The random key is a short-lived bearer retry
capability, not an account ID, refresh token, or long-term device credential; logs and database rows
never contain its raw value.

The existing access and refresh cookies remain the authentication credentials. They retain the
existing HttpOnly, SameSite, Secure-in-production, CORS, rotation, inactivity, absolute-expiry,
revocation, and refresh-reuse protections.

## Identity model and database changes

Migration `050_progressive_device_identity.sql` adds only:

- `accounts.identity_level`, constrained to `device`, `verified_contact`, or `strong`; existing
  accounts default to `strong` for backward compatibility;
- `cp2_device_account_bootstraps`, the existing PostgreSQL adapter's normalized persistence shape
  for short-lived hashed retry records;
- `cp2_device_recovery_credentials`, containing only device public keys, assertion replay metadata,
  and account ownership. Private recovery keys never leave the device.

The account's internal UUID remains canonical from the first tap. A device account uses
`primary_auth_channel = 'device'` plus a server-generated opaque destination. That destination is a
unique internal label, not a credential. Phone, email, PIN, passkeys, conversations, businesses,
catalogue data, and runtime state all continue to reference the same account/user graph.

## Progressive upgrades

```text
device account
├── add phone → linked account identity, same account UUID
├── verify email → identity_level = verified_contact, same account UUID
├── create PIN → identity_level = strong, same account UUID
└── register passkey → identity_level = strong, same account UUID
```

The existing owner-phone UI and E.164 server normalization are reused. A selected country plus a
number that already contains its calling code normalizes correctly rather than duplicating the
code. Phone and email linking check both canonical and identity indexes before writing. If the
normalized identity belongs to another account, Grogoni requires proof of control before joining the
graphs: the existing account's PIN for a phone collision, or an OTP sent to the existing email for
an email collision. The established account stays canonical while the device account's
conversations, shops, catalogue, runtime state, and recovery credentials move to it. No identity is
silently merged. Linked phone plus a later PIN works with the existing returning PIN login.

Email upgrade uses `/auth/identity/email/start` and `/auth/identity/email/verify`; it attaches a
pending identity to the current session account, sends the existing email OTP, and promotes the same
account only after verification. When the email is already registered, the same start request
creates a merge-scoped challenge and `/auth/identity/email/merge/verify` joins the device data only
after OTP proof. Existing OAuth account linking similarly promotes a device account without
changing ownership.

## Authorization and product behavior

Device-only accounts are ordinary authenticated principals. Existing authorization derives account
and user identity from the secure session cookie, never a supplied account ID. PIN-aware middleware
already asks for PIN verification only when an account actually has a PIN, so chat, session context,
catalogue/store exploration, and other permitted account routes work immediately.

The first session creates the existing personal Grogoni conversation and session context with the
account-level Grogoni agent. Business creation retains its contextual owner-phone requirement; the
initial chat experience does not. Contacts, camera, microphone, notifications, and storage
permissions remain feature-triggered and are not requested by onboarding.

At Continue time, the browser generates a P-256 signing key. It stores the re-imported,
non-exportable private `CryptoKey` in IndexedDB and sends only the public JWK to Grogoni. If cookies are
erased but that site storage remains, startup signs a short-lived nonce and recovers the same
account before showing onboarding. The server verifies the signature, timestamp, credential status,
and replay state before issuing a new rotating session. This is device-bound recovery, not
cross-device recovery; phone, email, PIN, or passkey remains necessary on another device.

Explicit logout revokes the current session family, clears cached local account/workspace data and
the device recovery key, and returns to the Continue screen. It does not delete the account, but it
does intentionally prevent that logged-out browser from silently recovering it. Logout-all also
revokes every server-side device recovery public key for the account, so session revocation cannot
be bypassed by automatic device recovery.

## Abuse prevention and observability

The endpoint uses both the existing global auth rate limiter and the existing per-IP auth limiter.
It does not use CAPTCHA, fingerprinting, IMEI, MAC address, advertising ID, or IP address as an
identity. Server logs and client development telemetry record lifecycle event names and internal
account/session correlation only; they never record raw idempotency keys, cookies, PINs, refresh
tokens, or recovery secrets.

## Remaining limitations

- Device-bound recovery survives cookie erasure, not deletion of all browser/site storage or a move
  to a different device. Adding a verified recovery identity is still the portable recovery path.
- Expired hashed bootstrap records are removed opportunistically by later Continue traffic and are
  harmless after expiry; no new dormant-account deletion policy is introduced.
