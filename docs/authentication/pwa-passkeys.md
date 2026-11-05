# PWA passkeys

Browser/PWA signup offers passkey creation after the account is created. The browser or password
manager owns the credential prompt. Users can finish later if they cancel or their browser does
not support WebAuthn; their password remains available.

Existing signed-in accounts without passkeys receive a Create passkey prompt in the application,
including accounts without a shop. Account security also retains passkey enrollment and management.
Enrollment requires an authenticated session and the backend's recent-authentication checks.

PWA recovery offers Registered passkey and Verified backup email. Passkey recovery uses
`/auth/passkeys/login/options` with `purpose: pin_recovery` and the normalized account identifier,
then verifies the browser assertion through `/auth/passkeys/login/verify`. The backend requires
user verification and enforces the origin, relying-party ID, account binding, expiry and single-use
recovery proof before allowing a PIN or password reset. A new passkey cannot recover an account
unless it was registered to that account beforehand.

Device-security recovery and native recovery-key management are hidden from PWA signup,
recovery and account security. The Android host retains its existing screen-lock recovery flow.
