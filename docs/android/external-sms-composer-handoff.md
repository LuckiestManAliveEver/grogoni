# External SMS composer handoff

For the current cross-device contract, see `docs/messaging/cross-device-sms.md`. The repository
diagnosis below describes the original implementation before the Android native node was added.

## Repository diagnosis

The owner-facing product remains a React 19/Vite progressive web application in `apps/web`. It is
not a Capacitor, React Native, Flutter, or Trusted Web Activity shell for the web app.

A native Android SMS node now lives in `apps/android` (Gradle project, `AndroidManifest.xml`, and
Kotlin sources). It is deliberately narrow: it reads Android's SMS provider, sends manual replies
through the selected SIM, and implements the `native_sms` Channel Gateway provider. It does not
host the Grogoni web UI and the PWA never receives Android telephony privileges. See
`apps/android/README.md` and `docs/messaging/cross-device-sms.md` for the current contract.

Android release identity is proposed and verified by `config/android-release-identity.json` and
`documentation/CP26_ANDROID_RELEASE_IDENTITY.md`; Play Console ownership, signing, and policy
approvals remain pending, so interim distribution is described in `apps/android/README.md`.

The authenticated chat send flow is:

1. `ChatSurface` in `apps/web/src/GrogoniApplication.tsx` renders the composer and calls `onSend`.
2. `sendChatDraft()` creates an optimistic chat item, clears the draft, encrypts human direct
   messages, and posts to `POST /v1/messages`.
3. `services/api/src/cp2/routes.ts` parses that request.
4. `services/api/src/cp2/store.ts` currently accepts only the `grogoni` server delivery channel and
   records delivery attempts.

Direct-conversation creation accepts an exact phone number or email, but the API rejects contacts
without a Grogoni account. Conversation participant responses identify accounts, shops, and agents;
they do not expose another account's private phone number. Shop identities use alphanumeric global
IDs such as `254A12345678`, and are not telephone numbers. Optional browser contact selection exists
for network sync, not chat delivery. There was no SMS, telephone, or external-intent helper and no
dual-SIM handling.

## Mode A implementation

`apps/web/src/messaging/sms-handoff.ts` defines the explicit composer channels:

- `grogoni`
- `sms_external_app`
- `sms_native`
- `unsupported`

Normal chat remains `grogoni`. SMS is selected only when the user presses **Send as SMS**.
`sms_native` is disabled; this change does not send with `SmsManager` or make Grogoni a default SMS
handler.

The confirmation sheet:

- keeps the original Grogoni draft and attachments untouched;
- collects a phone number when the active conversation does not expose one;
- shows the contact label independently of the normalized number;
- previews editable text;
- warns about carrier charges and messages longer than 160 characters;
- explains that attachments are not included;
- offers Cancel and Continue to SMS app.

After handoff, Grogoni does not create a chat message and does not report sent, delivered, read, or
failed-delivery state. It only says that the composer handoff was requested.

## Phone normalization

The existing `libphonenumber-js` dependency is reused. Numbers are normalized to E.164. A default
country is used only for input without an international prefix. Kenyan `0712…`, `011…`, `254…`,
and `+254…` forms are supported. Valid international `+` numbers are not forced to Kenya.
Empty/invalid input and values containing letters or the `grogoni:` prefix are rejected.

## Android and PWA behavior

The PWA fallback builds a user-initiated, safely encoded
`sms:+254…?body=<encoded text>` navigation. Apple browser links use the recipient-only
`sms:+254…` format and retain the text for copying. The operating system delegates the URI to a compatible handler and
the selected SMS app or Android system owns dual-SIM choice. No SMS app package is hard-coded.

A typed `window.GrogoniAndroid.openSmsComposer(recipient, body)` contract is preferred when a future
Android wrapper supplies it. That wrapper must implement Mode A with `Intent.ACTION_SENDTO`, a
`smsto:` URI, the `sms_body` extra, and `resolveActivity()` before `startActivity()`. It must not
export an intent receiver or accept arbitrary inbound intent data.

Browser navigation does not expose whether an SMS handler actually opened or whether the user sent
the message. The browser attempts dispatch on every device; it does not infer SMS capability from the user agent. Mobile browser URI handling varies by
browser and installed SMS apps. A production Android wrapper therefore still needs a separate
native implementation and device tests.

## Privacy telemetry

`POST /v1/message-handoffs` writes a minimal audit event containing the requesting account,
optional shop and conversation IDs, `sms_external_app`, timestamp, handoff status, and normalized
error code. The phone number, contact label, and message body are not sent to this endpoint.

## Permissions

The **web** SMS handoff path (Mode A/browser fallback) adds no Android manifest entries and
requests no SMS permissions: it only navigates an `sms:` URI.

The native Android node in `apps/android` does request the restricted SMS permissions
(`READ_SMS`, `RECEIVE_SMS`, `SEND_SMS`, `WRITE_SMS`) because it implements the default SMS-handler
role, along with the other device permissions it declares in
`apps/android/app/src/main/AndroidManifest.xml`. Those permissions are gated behind the SMS role and
are subject to Google Play default-SMS-handler policy review; they are granted at runtime only after
the user enables native SMS, as described in `apps/android/README.md`.
