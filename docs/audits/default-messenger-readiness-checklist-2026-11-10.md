# Default messenger readiness checklist — 2026-11-10

Question reviewed: is Grogoni a complete commerce SMS harness that a mobile user can use as their
default messenger, as a PWA?

**Answer: no.** Two separate reasons:

1. **A PWA cannot be a default SMS app on any phone.** Browsers give web apps no access to the SMS
   inbox, and Android only gives the SMS role to an installed native package. The repository
   already accepts this: carrier messaging lives in the Android app (`apps/android`), which shows
   the shared web UI in a WebView. The installed PWA shows "Your browser cannot read the phone's
   SMS inbox" (`apps/web/src/DeviceMessagingPage.tsx:320`).
2. **The Android app is a working basic SMS client, not yet a daily default messenger.** It has
   only been tested on emulators, and the items below are missing.

Reviewed at commit `5992c3a`. Method: read the Android sources, the shared messenger page, the
native SMS API routes, the PWA manifest and service worker, the release configuration and the
existing audits; ran the three release gates and 15 focused test files (155 tests, all passed).
Nothing was tested on a physical phone or against production.

## What works today

- Android default SMS role, SMS send and receive (multipart), short codes, `sms:`/`mms:` links from
  other apps, quick reply from the call screen.
- Incoming messages are written to an encrypted journal first and recovered after failures.
- Basic MMS: send text plus one attachment, group send, manual download.
- Paged history, search over SMS, phonebook names, per-message delete.
- Private by default: nothing is uploaded unless the user shares one message with a business.
- A shared SMS that looks like an order becomes an invoice on the server.
- Signed APK build 5 is published and the release manifest gate passes.

## 1. Messenger basics that are missing

- [ ] **Conversation list.** The inbox is one flat list of single messages. There are no threads,
      no unread counts and no chat view with the reply box under the messages.
- [ ] **Correct conversation grouping.** "Conversation" filters on the exact address text
      (`LocalSmsInbox.kt:40`), not Android's thread id. The same person written as `0712…` and
      `+254712…` appears as two conversations.
- [ ] **SMS and MMS in one conversation.** They are two separate tabs with separate lists.
- [ ] **Useful notifications.** Every alert says only "New SMS" (`LocalSmsNotifications.kt:33`).
      There is no option to show sender or preview, no reply or mark-read action, no unread badge,
      and tapping opens the inbox, not the conversation.
- [ ] **Live inbox updates.** The page polls every 10 seconds (`DeviceMessagingPage.tsx:170`);
      Android does not tell the page when a message arrives.
- [ ] **Send without a confirmation dialog.** Each send asks a browser confirm box that names the
      SIM by its internal number (`DeviceMessagingPage.tsx:243`).
- [ ] **SIM choice.** Only Android's default SMS SIM is used (`SmsSubscription.kt:8`). If the phone
      is set to "ask every time", nothing can be sent. Received SMS rows do not record which SIM
      got them.
- [ ] **Delivery status.** The delivery receiver accepts any carrier status report as "delivered"
      without reading the status inside it (`SmsResultReceivers.kt:63`), and the result is never
      shown in the UI or stored with the message.
- [ ] **Retry for a failed SMS.** A failed SMS only offers Reply; the text must be typed again.
- [ ] **Drafts.** Unsent text is lost when the page reloads or the app is closed.
- [ ] **Bulk actions.** No delete conversation, multi-select, archive, pin or mute.
- [ ] **Block and spam controls.** No way to block a number or report spam from the app.
- [ ] **Roaming-safe numbers.** A typed local number is read in the country of the current network,
      not the SIM (`DeviceMessagingAdapter.kt:79`), so it resolves to the wrong country when
      roaming.
- [ ] **Contact actions.** No call button, add-to-contacts or contact photos. The phonebook read
      stops at 5,000 numbers.
- [ ] **Languages.** English only; there are no translated Android resources or Swahili UI.
- [ ] **Backup and export of messages.** None, and Android backup is switched off.
- [ ] **Screenshots.** The whole app blocks screen capture (`MainActivity.kt:118`), so a user
      cannot screenshot a payment confirmation. Decide whether that is intended.
- [ ] **RCS.** Not supported and not available to third-party apps. Users coming from Google
      Messages lose RCS chats; say so in onboarding.

## 2. MMS gaps

- [ ] **Incoming MMS with other file types is not stored.** Every part must be JPEG, PNG, GIF, MP4,
      MP3, Ogg or AMR (`MmsTransport.kt:166`). A message containing a contact card, HEIC, WebP or
      3GP part fails as a whole and stays as an unreadable pending transfer.
- [ ] **Photo resizing.** The limit is 300 KiB (`MmsTransport.kt:21`) with no compression, so a
      normal camera photo is rejected.
- [ ] **More than one attachment** per message (`MmsTransport.kt:41`).
- [ ] **Automatic download.** Each MMS needs a tap and a confirmation; there is no setting.
- [ ] **Inline pictures.** Attachments open in another app; nothing is shown in the message.
- [ ] **Carrier acknowledgements.** The app never sends the notify-response or acknowledge messages
      after a download, so some carriers may keep re-sending the notification.
- [ ] **MMS search, subject line and delivery reports.**

## 3. Commerce and SMS

- [ ] **Customer messages reach the business only one at a time.** The merchant must open each SMS,
      tap "Share with business" and confirm. There is no rule such as "always share this
      customer".
- [ ] **Messages from named senders cannot be shared.** Sharing requires a normal phone number
      (`DeviceMessagingAdapter.kt:142`), so texts from short codes or senders like a mobile-money
      service are refused.
- [ ] **Assistant replies over SMS.** SMS conversations are created with automatic replies off
      (`services/api/src/cp2/domains/messaging/store.ts:1581`).
- [ ] **Prompt delivery of business replies.** Replies queued on the server are fetched by a
      15-minute background job (`NativeSmsWork.kt:32`). There is no push message to wake the phone.
- [ ] **Commerce actions inside the messenger.** From an SMS you cannot send a catalogue or product
      link, start an order or invoice, or see the customer's record. The messenger and the seller
      workspace are separate screens.
- [ ] **Payments.** Payment records are typed in by hand. The app states that live M-Pesa is
      deferred (`apps/web/src/app-shell.ts:233`); there is no payment request or automatic
      confirmation.
- [ ] **Notifications for internet chats and orders in the Android app.** The service worker is
      not registered inside the app (`apps/web/src/service-worker.ts:4`) and there is no Firebase
      messaging, so nothing arrives while the app is closed.

## 4. Release and distribution

- [ ] **Physical phone testing.** Every row of
      `docs/testing/android-pwa-messenger-acceptance.md` is still "Pending". Real carrier SMS and
      MMS, dual SIM, roaming, reboot, battery saving and process death are untested.
- [ ] **Sideload test on Android 15 and later.** Recent Android versions restrict some sensitive
      settings for apps installed from a download. Confirm on a real phone that a website install
      can still be given the SMS role and SMS permissions.
- [ ] **Update path for installed users.** The update notice is skipped inside the app
      (`apps/web/src/AndroidUpdateNotice.tsx:20`) and the app never checks for a new build. The web
      UI is packaged in the APK, so users stay on old code until they find a new download.
- [ ] **Current code in the published build.** Build 5 was published on 2026-11-06; 11 commits
      have landed since.
- [ ] **Play release identity.** `pnpm android:identity:gate` fails: developer account, legal
      entity, owners and signing recovery are all unset.
- [ ] **Play legal readiness.** `pnpm android:legal:gate` fails: support, privacy and legal
      contacts, the legal entity and the deletion runbook are unset.
- [ ] **Privacy policy and terms.** Both are marked Draft, still contain `[Legal Entity Name]`,
      `[Registered Address]` and `[To Be Inserted]`, and the privacy policy does not mention SMS,
      MMS, camera or location.
- [ ] **Play SMS permission declaration, demo video, feature graphic and screenshots.**
- [ ] **Crash and error reporting in the Android app.** None; failures only go to the device log.
- [ ] **Device key attestation.** `ANDROID_KEY_ATTESTATION_REQUIRED` defaults to false until tested
      on a real phone.
- [ ] **Production check of the SMS sync routes.** The `/v1/devices/native-sms/*` routes pass
      local tests; this review did not confirm them on the deployed API.

## 5. iPhone

- [ ] **No usable iPhone messenger.** `apps/ios` is source only: never compiled, signed or run. It
      is SMS-only, needs iOS 26 and an Apple entitlement that is limited to the EU, and cannot
      read existing messages. On iPhone the PWA can only hand off to Apple's Messages app.

## Suggested order

1. Test build 5 on two real phones with different carriers; fix what breaks.
2. Conversation list with thread grouping, merged SMS and MMS, and real notifications.
3. MMS fixes that lose or reject messages: unsupported parts, photo resizing.
4. In-app update check.
5. Commerce link: per-customer sharing, faster reply delivery, payment request.
6. Final privacy policy and terms, then the Play gates.
