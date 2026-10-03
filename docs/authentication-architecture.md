# Authentication architecture

Grogoni uses a phone-first account model with one canonical account UUID. Phone and optional email
identities are normalized and linked to that account. Phone identifiers are not proof of phone
ownership and are stored as unverified. A password is optional; passkeys, TOTP factors, recovery
codes, and persistent device sessions are stored as separate account-scoped records.

Phone signup creates a short-lived transaction that is consumed exactly once by account creation.
It does not create or send a verification code. Legacy phone-PIN recovery requires a verified
passkey ceremony; phone PIN recovery codes are no longer generated, stored, or accepted. Users can
also return with a password, linked verified email, or an existing session.
Email verification and email password recovery continue to use purpose-bound email OTPs.

Return access does not send SMS. The web app first restores its HTTP-only cookie session,
then silently rotates the refresh credential if the 15-minute access session has expired. Refresh
families have a sliding 30-day inactivity limit and a non-sliding 180-day absolute limit by default.
Every refresh rotates the token; reuse of a rotated token revokes the entire family. Password and
legacy PIN remain explicit fallbacks for accounts that already have them.

After signup, the UI recommends creating a passkey. Accounts without a password cannot defer that
prompt in the signup flow. Returning users are shown
passkey first, using enumeration-safe method discovery that returns the same public capabilities for
known and unknown identifiers. Passkeys use WebAuthn with user verification required. TOTP secrets are encrypted at rest and
recovery codes are stored as one-way hashes. Browser authentication uses secure, HTTP-only cookies;
the service worker never caches `/auth/*` responses. Auth, session, and logout responses carry both
`Cache-Control: no-store` and `Pragma: no-cache`.

See [passkeys.md](./passkeys.md), [mfa-and-recovery.md](./mfa-and-recovery.md), and
[persistent-passwordless-access.md](./persistent-passwordless-access.md) for operating details.
The browser-to-agent lifecycle, refresh race prevention, tenancy checks, and API-to-inference trust
boundary are documented in
[agent-session-contract.md](./authentication/agent-session-contract.md).
