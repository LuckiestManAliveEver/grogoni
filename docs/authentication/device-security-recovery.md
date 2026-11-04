# Device security account recovery

## Existing architecture

Grogoni uses the same Cp2 authentication store and session cookies for web, PWA and native
Android. PINs and passwords are hashed on the backend. WebAuthn credentials and ceremonies
already live in the passkeys domain. Device recovery previously signed a timestamp and nonce
with a JavaScript IndexedDB key or an Android Keystore key without requesting local user
verification. The existing reset endpoints consume session-bound recovery grants.

The Android app is Kotlin, not Capacitor. No Capacitor runtime or second authentication system
has been introduced. Supabase Edge has direct handlers for selected auth operations; the
remaining operations use the same Cp2 domain implementation with scoped snapshot persistence.
PIN setup now delegates to Cp2 on Edge, so it observes the same single-use recovery policy.

## Browser and PWA

After phone entry, choose Device security and Unlock with device security. A discoverable
WebAuthn ceremony requires user verification. The backend binds its purpose, entered phone,
origin, RP ID and five-minute challenge. Verification checks the signature, user handle,
credential/account association and authenticator counter before issuing a five-minute,
one-use reset grant. Ordinary passkey login never issues this grant. Consumed ceremonies
cannot be replayed. Revoking a passkey also invalidates its outstanding recovery grants.

Existing registered passkeys can authorize recovery. Signup and authenticated account settings
offer explicit passkey enrollment. Private passkey keys never enter JavaScript storage. Multiple
passkeys and devices are supported. Passkeys may be synced by the user's credential provider;
this implementation does not claim that every browser passkey is restricted to one device.

Capability checks distinguish WebAuthn support from a built-in platform authenticator. Browsers
cannot enumerate a user's registered passkeys before the ceremony, or directly inspect screen
lock configuration. The UI explains the prerequisite, offers setup guidance and verified email
fallback, and distinguishes cancellation/no available credential from server rejection. A
WebAuthn browser without a platform authenticator may use a previously registered external
security key or another trusted device. HTTPS is required; localhost works for development,
IP-address RP IDs do not.

The old IndexedDB recovery keys remain for existing bootstrap/session-restore behavior. The
interactive PIN/password recovery screen never uses those unverified JavaScript signatures.
Legacy assertions cannot issue reset grants, and pre-upgrade grants without verified-credential
metadata are rejected. Accounts with an existing PIN, password, or passkey must verify a credential before enrolling
another credential. Accounts with none may set their first credential within 15 minutes of
sign-in. A legacy device-key session restore does not count as a recent sign-in.
Owners with only a legacy key must sign in through an existing credential/fallback, then explicitly
register a passkey. A new passkey is never created by the unauthenticated recovery screen.

## Native Android

Enrollment requires a recent authenticated session and a configured screen lock. New keys use
a v2 alias, are non-exportable P-256 keys in Android Keystore, and require local authentication.
Android 11+ uses BiometricPrompt with BIOMETRIC_STRONG or DEVICE_CREDENTIAL. Android 9/10
uses BiometricPrompt with system screen-lock fallback. Android 6–8 uses the system confirm
credential activity. This supports phones without biometric hardware. Weak face unlock is not
accepted as a strong biometric; device credentials remain available.

The prompt must succeed before recovery signing. Keystore itself enforces a 30-second
strong-biometric/device-credential authorization window. The native client then fetches a
server-generated, account-bound two-minute nonce/timestamp challenge and signs it. A v2 server
credential cannot use the legacy challenge-free protocol. Each challenge permits one verification
attempt. No biometric template, screen-lock PIN, pattern or password is sent to Grogoni.

Old unrestricted Android keys are not silently upgraded. Sign in and explicitly secure the device
again to create the authentication-bound v2 key. Keys invalidated by removing/changing device
security may require re-enrollment. Native and browser credentials remain separate. Clearing
app data or uninstalling removes access to the native key. Local forgetting and server revocation
are separate actions; the account screen provides both.

## Endpoints and persistence

| Endpoint                                            | Behavior                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| POST /auth/passkeys/register/options, /verify       | Authenticated, user-verified enrollment                                                                                                 |
| POST /auth/passkeys/login/options                   | `purpose: pin_recovery`, normalized `identifier`; enumeration-safe discoverable challenge                                               |
| POST /auth/passkeys/login/verify                    | Verify proof and issue a session-bound recovery grant                                                                                   |
| POST /auth/continue                                 | Existing enrollment endpoint; `deviceSecurity: true` requires recent authentication and marks a native credential as challenge-required |
| POST /auth/device/recover/options                   | Native challenge, bound to credential and phone; unknown credentials get the same response shape                                        |
| POST /auth/device/recover                           | Verify native signature with `challengeId` and consume challenge                                                                        |
| GET /auth/device/credentials                        | List current account's enrolled recovery devices without keys                                                                           |
| DELETE /auth/device/credentials/:credentialId       | Revoke a device and its outstanding reset grants                                                                                        |
| POST /auth/pin/recover/device                       | Reset existing PIN using an unexpired grant                                                                                             |
| POST /auth/pin/setup                                | Set first PIN; recovery sessions must have an unused grant                                                                              |
| POST /auth/password/recover/device                  | Reset password using an unexpired grant                                                                                                 |
| POST /auth/recovery/start, /verify, /reset-password | Existing verified email fallback                                                                                                        |

No database migration is needed. Optional ceremony/credential metadata and native challenges
use existing JSON records and auth transactions. Postgres persistence includes the new
mutations; Edge hydration includes the requested native challenge. Rate limits reuse existing
auth/IP controls, cookie handling, origin validation and security audit logs.

Successful resets consume the grant and revoke other account sessions using the existing
policy. Owners receive an in-app security notification in their owned shops, plus a best-effort
transactional email to their verified backup email when configured. Delivery failure is logged
and cannot turn a successful credential mutation into a retry. Accounts without an owned shop
or verified email have no out-of-band notification destination. Email delivery currently has no
durable retry queue.

## Verification

Automated coverage includes WebAuthn user verification, account/origin/RP binding, unknown
credentials, cancellation, challenge expiry/replay, one-use grants, persisted recovery proof,
multiple native devices, credential revocation, PIN/password reset and email fallback. Mobile
Playwright tests use a virtual platform authenticator to produce actual WebAuthn assertions.
Android unit tests verify signature encoding and credential validation. Instrumentation tests
check Keystore properties, missing enrollment, missing screen locks, native recovery/reset,
MFA and email fallback. Interactive screen-lock tests opt in with the instrumentation argument
`deviceSecurityTestPin` on a disposable emulator configured with that PIN; tests never change a
real user's screen lock. Run those tests in a read-only emulator.

Physical fingerprint/face hardware, OEM-specific prompts, Android 6–10 fallback behavior,
Credential Manager synchronization and cross-device passkey transport require device testing
in addition to emulator coverage. Cancellation and invalidated-key paths must always leave
verified email fallback available. Production deployment and real email delivery are separate
from local implementation/testing.

## Implementation files

- Web recovery and enrollment: `apps/web/src/passkey-recovery.ts`,
  `PhoneFirstAuthentication.tsx`, `PhoneSignup.tsx`, `IdentitySecurityPanel.tsx`.
- Native authentication: `apps/android/app/src/main/java/market/grogoni/app/auth/AccountActivity.kt`,
  `DeviceRecoveryKey.kt`, `NativeAuthClient.kt`, plus `apps/android/app/src/main/AndroidManifest.xml`.
- Shared authentication backend: `services/api/src/cp2/domains/passkeys/routes.ts`, `store.ts`,
  `shared.ts`; `services/api/src/cp2/domains/device-bootstrap/routes.ts`, `shared.ts`;
  `services/api/src/cp2/store.ts`, `routes.ts`, `route-helpers.ts`, `email-provider.ts`,
  `postgres-store.ts`, `edge-snapshot-scope.ts`.
- Hosted auth: `supabase/functions/api/auth-routes.ts`.
- New tests: `tests/device-security-passkey-recovery.test.ts`,
  `tests/native-device-recovery-challenge.test.ts`, `tests/passkey-recovery-browser.test.ts`.
- Updated tests: `e2e/mobile-pin-recovery.spec.ts`,
  `apps/android/app/src/androidTest/java/market/grogoni/app/auth/NativeAuthInstrumentedTest.kt`,
  `tests/passkeys.test.ts`, `tests/device-credential-recovery.test.ts`,
  `tests/passkey-fallback-only.test.ts`,
  `tests/passkey-pin-recovery-frontend.test.ts`, `tests/phone-first-authentication-ui.test.tsx`,
  `tests/supabase-edge-auth.test.ts`.
- Documentation: this report, `docs/authentication/phone-first-authentication.md`,
  `apps/android/README.md`.

## Local validation results

- 120 targeted Vitest tests passed across 14 files covering authentication, browser recovery,
  native challenges, legacy-session compatibility, Edge persistence, notifications and recovery UI.
- Three Pixel 7 mobile Chrome browser tests passed, including virtual WebAuthn recovery and the
  existing signup/login journey.
- Fourteen Android JVM unit tests passed. Debug app and instrumentation APK assembly and Android
  lint passed.
- Android 11 emulator instrumentation reported `OK (8 tests)` with one no-screen-lock assumption
  skip after configuring its temporary test PIN. The missing-screen-lock test was separately run
  and passed before configuring that PIN. Actual system screen-lock confirmation unlocked the
  Keystore key and native recovery/reset used the signed server challenge.
- TypeScript typechecks and ESLint cover the changed web/backend code. No database migration,
  deployment or real email send was performed. The read-only emulator was closed and its test
  screen-lock changes were discarded.

Implementation references: [Android authentication APIs](https://developer.android.com/identity/sign-in/biometric-auth),
[Android Keystore](https://developer.android.com/privacy-and-security/keystore),
[SimpleWebAuthn browser](https://simplewebauthn.dev/docs/packages/browser),
[SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server).
