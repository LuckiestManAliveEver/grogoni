# Grogoni Android native SMS node

## SMS without internet or agents

The native Android screen reads recent messages directly from Android's SMS provider and sends
manual replies through the selected SIM. It does not require a Grogoni login, business selection,
internet connection, or agent. Make Grogoni the default SMS app and grant SMS permissions first.
Camera, contacts, location, and other unrelated permission grants do not gate SMS sending.

The recent-message list shows up to 100 incoming and outgoing SMS with local send states. Open a
message to read it and choose Reply to fill the recipient. New SMS produces a generic notification
when Android notification permission is granted. Message text is not included in notifications.

Enable **SMS only — pause Grogoni sync and agent processing** for a local-only mode that persists
across app restarts. New SMS received in this mode stays in Android's provider and is not queued for
backend processing, even after sync is re-enabled. Existing queued sync work is retained and paused;
re-enabling sync resumes it. Requests already accepted by the backend cannot be recalled by this
switch. Manual sends do not enter the backend agent path in either mode.

SMS still requires cellular service and sufficient carrier credit. MMS and a full paginated
conversation browser are outside this basic SMS implementation.

This is the minimal Android execution node for the `native_sms` Channel Gateway provider. It is
not a WebView bridge and the PWA never receives Android telephony privileges.

## Local build

Use a full JDK 17 (with `javac`; a JRE alone fails with "does not provide the required capabilities:
[JAVA_COMPILER]"), Gradle 8.10.2, and an Android SDK with API 35. There is no committed Gradle
wrapper. From this directory, run the project with that
Gradle installation or import it into Android Studio. The default API origin is
`https://grogoni.com/api`: production serves the API under `/api` (the `vercel.json` rewrite to the
Supabase Edge function), and `https://grogoni.com` itself is the web app, which answers API paths
with HTML or 405. Override the API origin for a development backend with:

```text
gradle :app:assembleDebug -PGROGONI_API_ORIGIN=https://your-api.example
```

The configured origin must use HTTPS for a device build. Emulator-only cleartext networking is not
enabled by the manifest.

## Release build for Google Play

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

While Play Console registration is in progress, the Android SMS routing handler can still be shipped
onto real phones by hosting a release APK directly from the production site. Build the APK with:

```bash
cd apps/android
gradle :app:assembleRelease
# or from the repo root:
pnpm android:release:apk
```

The signed release APK lands under `app/build/outputs/apk/release/` and can be uploaded to a public
`https://grogoni.com/android/` download path or another production-hosted artifact endpoint. Keep the
download URL in the release notes or onboarding flow so testers can install the app before Play
registration is complete.

This is an interim distribution path only. The Play Console listing remains the long-term distribution
channel once the app identity and policy review are approved.

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

1. Sign in with a Grogoni phone number and PIN, then select a business.
2. Tap **Enable native SMS**. Android must grant the SMS role before the app asks for restricted SMS
   permissions.
3. Ensure Android has a deterministic default SMS subscription. The app does not choose SIM slot 0.
4. The app reports `native_sms_send` and `native_sms_receive` only after the role, corresponding
   permission, telephony feature, and subscription are present.

Google Play restricts SMS permissions to apps that qualify for the default SMS-handler use case and
requires the associated permissions declaration/review. A build should not be distributed through
Play until that policy work is approved.

## Verification

Local JVM contracts live under `app/src/test`; run them and build the debug APK with
`pnpm android:check` (the `android` CI job runs the same command). Keystore/SQLite durability tests live under
`app/src/androidTest` and require an Android device or emulator. A real carrier send/receive test
also requires a physical Android phone, an active SIM, Grogoni selected as the default SMS app, and a
review-safe build.
