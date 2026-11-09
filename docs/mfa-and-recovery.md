# MFA and recovery

Grogoni supports TOTP as a second factor and passkeys as a strong authentication method. TOTP setup
creates an encrypted secret and does not activate the factor until the user supplies a valid code.
Replay of the same TOTP time step is rejected. Enrollments generate single-use recovery codes; only
their hashes are persisted, and newly generated codes invalidate the old set.

PIN and password recovery use a purpose-bound email verification transaction for a linked, verified
email (`POST /auth/recovery/start`, `/auth/recovery/verify`, then `/auth/recovery/reset-pin` or
`/auth/recovery/reset-password`).
Phone and SMS recovery are unavailable. Responses for email identifiers are worded generically to
reduce account enumeration. A successful email challenge grants only the ability to complete that
recovery transaction, not a general login session, and the grant is consumed once. An enrolled TOTP
factor is still required. A new PIN must pass the same predictable-PIN checks as PIN setup. Existing
sessions, passkeys, device security, trusted-device approval, and saved MFA recovery codes remain
the other supported return paths.

After a PIN or password reset, existing device sessions are revoked and a recovery notice is sent to
the verified backup email. Security-sensitive factor changes and
recovery-code regeneration require an authenticated session and verification appropriate to the
operation.
