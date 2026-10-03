# MFA and recovery

Grogoni supports TOTP as a second factor and passkeys as a strong authentication method. TOTP setup
creates an encrypted secret and does not activate the factor until the user supplies a valid code.
Replay of the same TOTP time step is rejected. Enrollments generate single-use recovery codes; only
their hashes are persisted, and newly generated codes invalidate the old set.

Password recovery uses a purpose-bound email verification transaction for a linked, verified email.
Phone and SMS recovery are unavailable. Responses for email identifiers are worded generically to
reduce account enumeration. A successful email challenge grants only the ability to complete that
recovery transaction, not a general login session, and the grant is consumed once. Existing sessions,
passkeys, passwords, and saved MFA recovery codes remain the other supported return paths. Legacy
phone-PIN resets instead require a verified passkey and do not use a separate recovery code.

After password reset, existing device sessions are revoked. Security-sensitive factor changes and
recovery-code regeneration require an authenticated session and verification appropriate to the
operation.
