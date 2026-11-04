# Grogoni Android capability adapter

## SMS without internet or agents

The shared messenger screen reads messages through the Android adapter directly from Android's SMS provider and sends
manual replies through the selected SIM. It does not require a Grogoni login, business selection,
internet connection, or agent. Make Grogoni the default SMS app and grant SMS permissions first.
Camera, contacts, location, and other unrelated permission grants do not gate SMS sending.

SMS history loads 100 messages per page, with Load older messages, search across history,
conversation filtering, and per-message deletion. Short-code destinations are accepted for local
carrier sends. Open a message to read it and choose Reply to fill the recipient. New SMS produces a generic notification
when Android notification permission is granted. Message text is not included in notifications.

Business synchronization is **off by default**, including after upgrading from legacy implicit
consent, signing out, or switching accounts. Enabling business features requires a confirmation
that explains remote SIM sends and carrier charges. Selecting a business does not enable sharing.
Incoming SMS is never automatically uploaded: use a received message's **More → Share with business**
action and confirm that individual upload. Legacy automatically queued messages are quarantined.
Manual SIM sends remain local. Pausing business features stops queued remote processing; already
accepted backend requests cannot be recalled.

Incoming SMS and MMS notifications are first written to an encrypted local recovery journal.
Android provider failures are visible and retry through network-independent WorkManager jobs and
when the app reopens. Recovery reconciles existing SMS rows to avoid duplicates after process death.
Only deduplication metadata remains after the provider copy is saved.

## MMS and group messages

Open **MMS inbox · pictures and groups** for manual MMS downloads, text/group composition,
attachments, viewing, deletion, and paginated history. Android's subscription-specific SmsManager
handles the carrier APN and transport. MMS requires a configured carrier and mobile data; the
emulator validates local codecs/storage and failure handling, not real carrier interoperability.
Downloads require confirmation, including the receiving SIM, to avoid automatic roaming charges.

Messages have a conservative 300 KiB PDU limit and at most 20 recipients/30 parts. Supported
attachments are JPEG, PNG, GIF, MP4, MP3, Ogg and AMR. Oversized or unsupported content is rejected
explicitly. Failed sends remain drafts for user review; no uncertain send is automatically replayed.
Successful transport callbacks that encounter a local storage failure retain their PDU and can be
recovered from the MMS inbox. The AOSP PDU codec and its license/provenance live under
`app/src/main/java/com/example/android/mmslib`.

SMS still requires cellular service and sufficient carrier credit.

One application UI and its workflows live in `apps/web`. Android loads the packaged build in a
restricted WebView and exposes OS capabilities through a per-navigation authenticated MessagePort.
Generated `.gz` assets use an opaque `.bin` packaging suffix to prevent Android from decompressing
and renaming them; the host serves their original web URLs and bytes.
Ordinary browsers report carrier messaging unavailable. Native activities are thin route hosts;
there are no separate Android messenger, account or catalogue forms.

## Shared account sign-in and recovery

Account, catalogue and messenger screens run from the same `apps/web` build. Shared TypeScript
owns sign-in, MFA, enrollment and recovery API workflows. Android supplies only the protected
Keystore key, system unlock prompt, telephony/provider access and background execution adapters.
The private key never leaves Android Keystore. Device recovery requires a screen lock and an
account-specific enrolled key; without one, use an existing supported account recovery method.

The host prevents screenshots and saved form state. Backend sessions use the pinned HTTPS origin;
linking business features verifies the current account with the backend. Logout/account changes
clear the native business link. Provider SMS remains independent of sign-in.

## Local build

Use a full JDK 17 (with `javac`; a JRE alone fails with "does not provide the required capabilities:
[JAVA_COMPILER]"), Gradle 8.10.2, and an Android SDK with API 35. There is no committed Gradle
wrapper. From this directory, run the project with that
Gradle installation or import it into Android Studio. First run `pnpm android:web:bundle` from
the repository root; Android pre-build rejects missing shared assets. The default API origin is
`https://grogoni.com/api`: production serves the API under `/api` (the `vercel.json` rewrite to the
Supabase Edge function), and `https://grogoni.com` itself is the web app, which answers API paths
with HTML or 405. Override the API origin for a development backend with:

```text
gradle :app:assembleDebug -PGROGONI_API_ORIGIN=https://your-api.example
```

The configured origin must use HTTPS for a device build. Emulator-only cleartext networking is not
enabled by the manifest.

## Optional Google Play build

Create a keystore and configure the required environment variables before generating a release bundle:

```bash
cd apps/android
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias grogoni \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Then set the signing values in your shell before building:

```bash
export GROGONI_RELEASE_STORE_FILE="$PWD/release.keystore"
export GROGONI_RELEASE_STORE_PASSWORD="your-keystore-password"
export GROGONI_RELEASE_KEY_ALIAS="grogoni"
export GROGONI_RELEASE_KEY_PASSWORD="your-key-password"
```

A Play bundle can then be generated with:

```bash
gradle :app:bundleRelease
```

The generated `.aab` file is located under `app/build/outputs/bundle/release/` and is the artifact to
upload in the Google Play Console.

## Direct APK distribution from grogoni.com

The selected installation path is a signed APK hosted directly on the production website.
The APK packages the same shared web application. Build its assets before invoking Gradle:

```bash
pnpm android:web:bundle
# Signed direct-release build from the repository root:
pnpm android:direct:build
```

Release tasks reject missing keystore configuration; they do not produce unsigned distribution artifacts.

The signed release APK lands under `app/build/outputs/apk/release/` and can be uploaded to a public
`https://grogoni.com/android/` download path or another production-hosted artifact endpoint. Keep the
download URL in the release notes or onboarding flow so testers can install the app before Play
registration is complete.

Direct website distribution does not depend on completing the Play Console workflow. Use
`pnpm android:direct:build` and `pnpm android:direct:prepare` for the verified direct-download
workflow described in `docs/direct-android-installation.md`.

You can also keep a local `keystore.properties` file next to the project root when developing locally,
with the same keys used by Gradle:

```properties
storeFile=release.keystore
storePassword=your-keystore-password
keyAlias=grogoni
keyPassword=your-key-password
```

This file is intentionally ignored by Git and should never be committed.

## Setup contract

1. For synchronization, open Account, sign in with a PIN or password, return to SMS and select a business. Local SMS does not require sign-in.
2. Tap **Continue SMS setup**. Android must grant the SMS role before the app asks for restricted SMS
   permissions.
3. Ensure Android has a deterministic default SMS subscription. The app does not choose SIM slot 0.
4. The app reports `native_sms_send` and `native_sms_receive` only after the role, corresponding
   permission, telephony feature, and subscription are present.

Google Play restricts SMS permissions to apps that qualify for the default SMS-handler use case and
requires the associated permissions declaration/review. A build should not be distributed through
Play until that policy work is approved.

The app does not request permissions at startup. SMS permissions are requested only after the SMS role is held. Call-log permissions are not requested. Telephony detection uses the legacy telephony
feature below API 33 and the messaging-specific feature on API 33 and later.

App Links remain unconfigured (`assetlinks.json` is an empty array) until a real release certificate
is available. Generate the file with `GROGONI_RELEASE_CERT_SHA256` and
`pnpm android:release:assetlinks`, or supply the release keystore environment variables.
The generator rejects missing, malformed, and placeholder fingerprints. For Google Play builds,
use the Play app-signing certificate, which can differ from the upload certificate.

## Verification

Local JVM contracts live under `app/src/test`; run them, build the debug APK and check API compatibility with
`pnpm android:check` (the `android` CI job runs the same command). Keystore/SQLite durability tests live under
`app/src/androidTest` and require an Android device or emulator. A real carrier send/receive test
also requires a physical Android phone, an active SIM, Grogoni selected as the default SMS app, and a
review-safe build.

Authentication instrumentation tests exercise the real Android Keystore with an injected API
transport and verify MFA, recovery requests, cookie rotation and account isolation. They complement
server recovery integration tests; they do not establish production email delivery or carrier SMS
service. Run `gradle :app:connectedDebugAndroidTest` with an emulator/device connected.

For a dedicated API 30 emulator, build the debug app and instrumentation APK, then run:

```bash
ANDROID_HOME=/path/to/android-sdk bash scripts/test-default-messenger-emulator.sh emulator-5554
```

Run the script from the repository root. The `android-device` CI job runs it on every push and
pull request, on an API 30 x86_64 emulator, and keeps the reports as a build artifact.
`GROGONI_ANDROID_BUILD_DIR` selects another prepared Android build directory. The script grants the SMS role, injects an emulator SMS with business
features enabled, verifies it stays local, and runs the SMS/MMS and existing native suites.
Physical carrier SMS/MMS, roaming and real dual-SIM acceptance remain required before a daily-use
recommendation. See [the remediation report](../../docs/audits/default-messenger-remediation-2026-11-03.md)
for the tested boundary and direct-download candidate.
