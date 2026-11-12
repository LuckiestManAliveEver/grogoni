# PWA passkeys

Browser/PWA signup includes a passkey step after the account is created. The browser or password
manager owns the credential prompt. Users can finish later if they cancel. A browser without
WebAuthn skips passkeys; the password remains available.

Passkey prompts do not appear automatically while browsing or using a guest session. A user who
logs in with a PIN or password and has no passkey is offered one during that login, each time
until they have one. Account
security retains explicit passkey enrollment and management. Login method discovery prefers
passkeys and attempts a registered passkey only after the user continues the login form. Native
Android can fall back to an enrolled screen-lock recovery key when passkeys are unavailable;
the PWA retains PIN/password and verified-email alternatives and never uses native device security.
Enrollment requires a credential proven within 15 minutes, which protects against an old stolen
session. An older session is asked for its PIN or password in place (`/auth/pin/verify`,
`/auth/password/verify`), then enrollment continues. Those routes run in `auth-routes.ts`, because
the domain store is rebuilt per request and cannot count attempts: the durable limit there allows 5
wrong answers per account in 15 minutes, across PIN and password together.

An account with neither cannot prove anything, so it stays signed in and is told it can add a passkey
within 15 minutes of signing in. It is never told to sign out, because it could not get back in.
`usePasskeyEnrollment.tsx` owns this flow.

PWA recovery offers Registered passkey, Approve from a logged-in device, and Verified backup email.
A browser without WebAuthn starts on the approval option. An account with no passkey gets a code
here, approves it on a device that is still logged in, then creates its passkey in this browser
(see `trusted-device-recovery-approval.md`). Passkey recovery uses
`/auth/passkeys/login/options` with `purpose: pin_recovery` and the normalized account identifier,
then verifies the browser assertion through `/auth/passkeys/login/verify`. The backend requires
user verification and enforces the origin, relying-party ID, account binding, expiry and single-use
recovery proof before allowing a PIN or password reset. A new passkey cannot recover an account
unless it was registered to that account beforehand.

Device-security recovery and native recovery-key management are hidden from PWA signup,
recovery and account security. The Android host retains its existing screen-lock recovery flow.

## The browser device key

The browser keeps an IndexedDB key for one-tap guest accounts. It involves no user verification, so
`Cp2Store.recoverWithDeviceCredential` refuses it once the account can sign in another way: its current
phone number with a PIN or password, or a phone-primary account with a passkey (`accountCanSignIn`). The
refusal records `auth.device_recovery_refused`, the browser deletes the key, and the app starts a new
guest session until the user logs in. The key keeps working for any other account, because refusing
it would lock that user out.

This rule is on the server, so it also covers the same browser key inside the Android WebView.
Android screen-lock credentials (`requiresServerChallenge`) are unaffected.

Known limits:

- An account with no sign-in of its own is still restored by the key, whatever its identity level.
  That includes a guest with a shop or phone but no credential, and a guest with only a verified
  email. A guest shop owner is asked to add a passkey or PIN (`SecureShopPrompt.tsx`), the one prompt
  a guest gets, because registering a shop is something they started. Adding a credential to an
  account with a phone turns it into a phone account, so passkey login and recovery work.
- Android screen-lock enrollment sends an Android Key Attestation chain, which the server checks in
  `android-key-attestation.ts`: pinned Google root, hardware-backed key, user authentication
  required, this app's package and signer, and the account. It is recorded as `attested`. Set
  `ANDROID_KEY_ATTESTATION_REQUIRED=true` to refuse unproven keys, after the attesting Android build
  is out and tested on a real phone. Add Play App Signing's digest to `ANDROID_ATTESTATION_SIGNERS`.
  Edge also checks Google's revocation list and treats an unreadable list as unproven; the Node
  server has no network step, so run enforcement on Edge.
