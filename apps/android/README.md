# Grogoni Android native SMS node

This is the minimal Android execution node for the `native_sms` Channel Gateway provider. It is
not a WebView bridge and the PWA never receives Android telephony privileges.

## Local build

Use JDK 17 and an Android SDK with API 35. From this directory, run the project with a compatible
Gradle installation or import it into Android Studio. Override the API origin for a development
backend with:

```text
./gradlew :app:assembleDebug -PGROGONI_API_ORIGIN=https://your-api.example
```

The configured origin must use HTTPS for a device build. Emulator-only cleartext networking is not
enabled by the manifest.

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

Local JVM contracts live under `app/src/test`. Keystore/SQLite durability tests live under
`app/src/androidTest` and require an Android device or emulator. A real carrier send/receive test
also requires a physical Android phone, an active SIM, Grogoni selected as the default SMS app, and a
review-safe build.
