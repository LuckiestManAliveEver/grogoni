# Direct website installation

The selected distribution path is **direct installation from grogoni.com**, with the PWA as the
shared web application and an Android package for operating-system SMS/MMS capabilities. Google
Play submission, Play app signing, and Play track approvals are not prerequisites for this path.
The CP26/CP27 Play records remain historical/store-specific; they are not evidence that a direct
APK is ready or blocked.

The web messenger code remains in `apps/web`. Android's default SMS role, carrier transport,
provider storage and recovery require the native adapter in `apps/android`. A browser/PWA by
itself cannot acquire those telephony privileges. The carrier inbox/composer, account screens, authentication workflows and catalogue use the same
React application in `apps/web` on every platform. Android packages that build for offline loading
and supplies a narrowly scoped message-channel adapter for operating-system capabilities. There
is no second native messenger interface.

## Build and prepare

Keep the release signing key and its password configuration outside version control. Local
signing configuration is an owner-readable JSON file (mode 0600), selected by
`GROGONI_RELEASE_SIGNING_CONFIG`. Its keys are the four `GROGONI_RELEASE_*` settings documented in
`apps/android/README.md`. Back up both the key and configuration securely; the same key must be
retained for future updates to this Android package.

```bash
# Requires Android SDK 35, Gradle 8.10.2 and a full JDK 17.
pnpm android:direct:build
pnpm android:direct:prepare --apk apps/android/app/build/outputs/apk/release/app-release.apk \
  --out /tmp/grogoni-direct-download \
  --build-tools "$ANDROID_HOME/build-tools/35.0.0"
```

`GROGONI_GRADLE_BIN` and `GROGONI_ANDROID_BUILD_DIR` select a Gradle binary and prepared Android
source snapshot when needed. Some SDK installations also require their native runtime directory
in `LD_LIBRARY_PATH` for `aapt`.

Preparation verifies the APK signature, rejects debuggable builds and the Android debug signing
identity, reads package/version/SDK metadata from the artifact, checks every packaged shared-web asset
against its bundle manifest, hashes the actual bytes, and emits:

- `android/grogoni-<version>-<code>.apk`;
- `android/release.json` and its schema;
- `.well-known/assetlinks.json` generated from the actual signer certificate;
- `verification.json`, explicitly marked `published: false`.

This command prepares files for review; it does not publish them. Host the verified APK and its
metadata together on the production origin, with the APK present before enabling the install
manifest. Verify the public download bytes and certificate before treating the release as live.
The checked-in public release manifest stays null until an actual release is published.

## Current tester release (unlisted)

Version 0.1.0 (code 2), built from `main` at 7201d248 with this version bump, is available to
testers only. The public install button stays hidden: `apps/web/public/android/release.json` is
still `null`, so grogoni.com does not advertise it.

- Download: https://grogoni.com/android/grogoni-0.1.0-2.apk (redirects to the
  [GitHub pre-release `android-0.1.0-2`](https://github.com/LuckiestManAliveEver/grogoni/releases/tag/android-0.1.0-2),
  which also carries `verification.json`).
- APK SHA-256: `78:63:AB:1C:5C:43:7F:09:E9:53:3E:C5:90:13:2F:4B:19:9E:D3:B0:87:73:63:24:C7:1B:7B:C0:10:85:65:30`
- Signing certificate SHA-256: `C0:AA:FB:59:8D:E5:87:49:DD:50:89:90:6E:F3:B0:8C:77:76:D3:0A:02:A5:D6:AD:61:C4:DE:98:D6:7F:DD:CD`
  (the same key as the earlier 0.1.0 (code 1) candidate, so later releases install as updates).

Before installing, check the download: `sha256sum grogoni-0.1.0-2.apk` must match the APK hash,
and `apksigner verify --print-certs grogoni-0.1.0-2.apk` must show the certificate above. On the
phone, allow installs from the browser when Android asks, open Grogoni, and accept its request to
become the default SMS app. To go back, choose another app under Settings > Apps > Default apps >
SMS app; messages stay in the phone's shared SMS store.

Status: emulator-verified only (Android 11; see Verification). Real carrier SMS/MMS, dual SIM,
roaming and power management are untested, so testers should keep their previous messaging app
installed. To make this release public later, replace the checked-in `release.json` with the
prepared one (its `downloadUrl` already matches the redirect) after physical-phone testing passes.

## Installation boundary

Users install the PWA through their browser, or download the signed APK and approve installation
from that source in Android. The Android app separately requests the default SMS role and the SMS
permissions. Website installation does not grant those permissions automatically.

Direct distribution still follows the target device's installation controls. Android documents
its outside-Play developer-verification and advanced-flow behavior in the
[official verification FAQ](https://developer.android.com/developer-verification/guides/faq).
Emulator installation through ADB does not prove the public installer experience on all devices.

## Verification

Build the debug and instrumentation APKs and run
`bash scripts/test-default-messenger-emulator.sh emulator-5554` on a dedicated emulator. See the
[readiness review](audits/default-messenger-review-2026-11-03.md) and its follow-up for results and
remaining physical-carrier acceptance. Never infer real carrier delivery or update compatibility
from codec/storage tests alone.
