# MFA and recovery

Grogoni supports TOTP as a second factor and passkeys as a strong authentication method. TOTP setup
creates an encrypted secret and does not activate the factor until the user supplies a valid code.
Replay of the same TOTP time step is rejected. Enrollments generate single-use recovery codes; only
their hashes are persisted, and newly generated codes invalidate the old set.

PIN and password recovery use a purpose-bound email verification transaction for a linked, verified email.
Phone and SMS recovery are unavailable. Responses for email identifiers are worded generically to
reduce account enumeration: unknown addresses, throttled requests, and email delivery failures all
receive the same response, and the recovery OTP is never included in the response, including in
development. Invalid-code and unknown-transaction verification failures are also indistinguishable.
A successful email challenge grants only the ability to complete that recovery transaction, not a
general login session, and the grant is consumed once. Existing sessions, passkeys, passwords, and
saved MFA recovery codes remain the other supported return paths. Phone PINs can be reset through
an enrolled, verified backup email or a registered passkey/device recovery credential. Legacy
phone-PIN resets that rely on a separate recovery code are no longer the supported path. Email PIN
resets use `/auth/recovery/reset-pin` after `/auth/recovery/verify`, require a matching four-digit
PIN confirmation, enforce PIN strength, and retain any enrolled authenticator factor. A transaction
can reset only one credential.

After either PIN or password reset, existing device sessions are revoked. Security-sensitive factor changes and
recovery-code regeneration require an authenticated session and verification appropriate to the
operation.
