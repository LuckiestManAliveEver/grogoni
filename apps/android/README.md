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

## Native account sign-in and recovery

Open **Account · sign in or recover PIN/password** on the SMS screen. Native sign-in accepts
phone-number PIN or password accounts, including email, authenticator, and recovery-code MFA.
A successful login opens account controls; choose **Return to SMS** and select your business.
Account creation and backup-email management are available through the linked website.

While signed in, choose **Secure this device for recovery**. This registers an account-specific,
non-exportable P-256 key in Android Keystore. The private key never leaves the device; PINs and
passwords are not stored. Keep your device screen lock enabled. Sign-out preserves the recovery
key; **Forget recovery key on this device** removes it locally. Uninstalling/clearing app data
requires another recovery method. Browser recovery keys and native-app keys are separate.

If you forget your PIN/password, enter the same phone number and choose the corresponding
**Recover … with this device** action. Device proof must succeed before a reset is offered; the
server permits a single credential mutation per recovery grant. Expired grants require another
verification and are never automatically replayed through session refresh.

Without the device key, use **Send email recovery code** with a previously verified backup email,
verify the code, and set a new password (including an authenticator code if required). You can now
sign in with that password even if you forgot your PIN. To replace the PIN as well, secure this
device after email recovery and use **Reset PIN using this device**. Phone/SMS recovery is not
supported by the backend. Without a previously registered key or verified backup email, this app
cannot bypass account ownership checks.

The account screen prevents screenshots and saved-state persistence of secrets. Network calls
require HTTPS, reject redirects, and run off the UI thread. Logout clears the native session even
if the backend is unreachable. Switching accounts clears the selected business. Durable remote
SMS queues/results are account-scoped, including late carrier callbacks; another account cannot
upload them. Pre-ownership queue rows are retained locally but quarantined rather than assigned
to a new account. SMS in Android's provider remains independent of Grogoni sign-in.

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

Release tasks reject missing keystore configuration; they do not produce unsigned distribution artifacts.

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

1. For synchronization, open Account, sign in with a PIN or password, return to SMS and select a business. Local SMS does not require sign-in.
2. Tap **Continue SMS setup**. Android must grant the SMS role before the app asks for restricted SMS
   permissions.
3. Ensure Android has a deterministic default SMS subscription. The app does not choose SIM slot 0.
4. The app reports `native_sms_send` and `native_sms_receive` only after the role, corresponding
   permission, telephony feature, and subscription are present.

Google Play restricts SMS permissions to apps that qualify for the default SMS-handler use case and
requires the associated permissions declaration/review. A build should not be distributed through
Play until that policy work is approved.

The app does not request permissions at startup. The device-permissions button excludes SMS and
call-log permissions until the SMS role is held. Telephony detection uses the legacy telephony
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

MMS transport and a full paginated conversation browser remain outside this SMS node. The screen
warns about MMS support, MMS compose/group-recipient intents are rejected, and incoming MMS
pushes produce an unsupported-message notification when notifications are available. Choose an
MMS-capable default app if those features are required.
