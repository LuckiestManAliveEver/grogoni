# Default messenger remediation — 2026-11-03

The reviewed source blockers have been addressed and tested on an Android 11 (API 30) emulator.
This is a local release candidate, not a production or physical-carrier certification.

## One application codebase

`apps/web` owns the messenger interface, account and catalogue screens, and authentication API
workflows. Android packages the actual Vite build for offline use. Thin Android activities host
shared routes; native code supplies SMS/MMS transport, provider storage, permissions, file access,
background execution and protected Keystore operations. No separate Android messenger/account
forms remain. A nonce-bound, origin-restricted MessagePort connects the shared application to those
adapters. Browser capability detection does not pretend that a PWA has carrier privileges.

## Changes

- Added carrier MMS transport and bounded AOSP PDU codecs, group composition, attachment handling,
  provider persistence, manual confirmed downloads and recovery. No uncertain send is automatically
  replayed. Limits: 300 KiB PDU, 20 recipients, 30 parts; supported MIME types are in the Android README.
- Journal incoming SMS/MMS notifications in encrypted local storage before provider persistence.
  Reconcile partial writes and retry without requiring internet; make provider failures visible.
- Business synchronization defaults off, including legacy upgrades and account changes. Incoming
  personal SMS never uploads automatically. Sharing requires per-message confirmation; legacy
  automatically queued rows are quarantined. Background business work verifies the shared session.
- Added local short-code support, paginated history, search, conversation filtering, deletion and
  privacy-safe notifications. Sending validates the SIM displayed at confirmation and rejects a
  changed default rather than silently using another subscription.
- Replaced the browser's unlocked outbox fallback with a per-operation journal to preserve concurrent
  writes and retries without Web Locks.
- Added a shared-build packaging step and signed direct-download preparation. Preparation rejects
  debug builds/signers, verifies every packaged runtime asset, and records artifact/certificate hashes.
  Android packaging preserves the shared compressed OCR language data with an opaque file suffix;
  the OS host maps the original URL without changing its bytes.

## Evidence

Logs are retained in [the test evidence directory](../testing/default-messenger-2026-11-03/).

| Check                                                               | Result                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Focused shared UI, bridge, authentication, outbox and privacy tests | 64 passed in 14 files                                           |
| Android JVM tests                                                   | 13 passed                                                       |
| Android debug build, instrumentation build and lint                 | Passed                                                          |
| Emulator messenger regression suite                                 | 13 passed                                                       |
| Existing native suite without screen lock                           | 15 reported; 2 recovery cases skipped                           |
| Recovery cases repeated with temporary screen lock                  | Both passed with actual Keystore and system PIN prompt          |
| Injected modem SMS privacy check                                    | Passed; received provider message, no automatic business upload |
| Shared React/provider interface with Wi-Fi and mobile data disabled | Passed                                                          |
| Scoped ESLint, web TypeScript and whitespace checks                 | Passed                                                          |

The emulator suite covers virtual-modem SMS acknowledgements, provider history beyond 100 rows,
fault-injected persistence, deduplication, opt-in defaults, short codes, SIM mismatch rejection,
MMS codec/provider round trips, malformed/oversized MMS rejection and the shared React bridge.
Recovery combines shared TypeScript workflow tests with native Keystore/protocol tests; test-only
native authentication fixtures are not production authentication UI. Emulator PIN/network settings
were restored after testing.

## Direct release and remaining acceptance

The selected path is a directly downloaded, signed APK. No Play approval or legal identity approval
has been invented. Public release metadata remains disabled until a deployment is actually made.
The [signed APK](../../artifacts/android-direct-release/android/grogoni-0.1.0-1.apk) and staged local bundle are in `artifacts/android-direct-release`; they are not published.
Signature and all 96 packaged runtime assets were verified successfully; see the
[release verification record](../testing/default-messenger-2026-11-03/release-verification.json). Its
`verification.json` records the exact APK and signer hashes and the shared-web asset manifest.
The release signing key and private configuration are outside version control under
`backups/android-release/`; retain a secure backup of both for compatible updates. No signing
password was found in reviewable changed/untracked files.

Before recommending this as someone's daily default messenger, test physical phones and real
carrier SMS/MMS delivery, incoming photo/group messages, supported APNs, dual SIM changes, roaming,
process death and power management, and the website installation/update flow. This emulator cannot
establish those results. The current candidate does not claim RCS support. A signed local artifact
and working virtual modem do not prove public availability or real carrier interoperability.
