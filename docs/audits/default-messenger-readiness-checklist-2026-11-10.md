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
- Direct chats between two Grogoni users are end-to-end encrypted in the PWA
  (`apps/web/src/e2ee.ts`). This does not depend on anything in this checklist.
- Contacts can be imported through the Android Chrome contact picker, a vCard or CSV file, or a
  read-only Google Contacts import.

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

## 6. Reaching SMS users over data

Finishing sections 1 to 5 does not let Grogoni reach someone's built-in SMS app over mobile data
or Wi-Fi. That app only receives SMS (carrier signalling, charged per message), MMS (the carrier's
own data service, billed as MMS) and RCS (closed to third-party apps). The last hop is always a
paid carrier message. The options below change who sends it, not whether it is paid.

- [ ] **Phone-and-SIM gateway.** The remote SIM send path is already a small gateway: the server
      queues a message and a linked Android phone sends it from its SIM. Still to add: several
      phones or SIMs per business with failover, push wake-up, rate limits and retries, a delivery
      report that reads the carrier status, and per-message accounting. Carrier terms usually
      forbid bulk sending from consumer SIMs, and Play already treats business sends as a review
      risk. Suits one shop replying from its own number, not bulk traffic.
- [ ] **Direct carrier connection over SMPP.** Not in the code. The client is small (a Node
      library exists), but it needs a carrier or aggregator account first: host, credentials, an
      allow-listed address and a per-message price. Check the licensing rules for bulk messaging
      before planning this.
- [ ] **A host for the SMPP session.** The production API is a Supabase Edge function and cannot
      hold a long-lived connection. The session belongs in an always-on Node process such as the
      optional daemon, added as one more provider in `services/api/src/messaging/channel-gateway.ts`.
- [ ] **Gateway bookkeeping.** Send queue, stored delivery reports, sender ID per business and cost
      tracking.

## 7. Encrypted Grogoni-to-Grogoni chat

Already implemented for direct person-to-person chats: each message is encrypted on the sender's
device with AES-256-GCM and its key is wrapped for the recipient. Shop conversations handled by the
assistant, SMS, MMS and WhatsApp handoffs are not end-to-end encrypted.

- [ ] **Two-phone proof.** "A sends to B, both reload and still decrypt" is still Pending in
      `docs/testing/android-pwa-messenger-acceptance.md`, as is real push delivery.
- [ ] **Key loss.** The private key lives in browser storage. Test that clearing site data or
      changing phone still leaves old messages readable through the recovery path.
- [ ] **Key rotation.** Each message has a one-time key, but the recipient's long-term key never
      rotates, so a leaked key exposes past messages. Weaker than Signal-style encryption.

## 8. Business phonebook

A PWA cannot be the phone's contacts app, cannot read the whole phonebook, cannot write to it and
cannot show caller ID. It can be the business's own contact book: customers, suppliers and staff,
synced to the account. The Android app reads the full phonebook for names, read-only.

Google Contacts is the way to reach the phone's contacts without native code, because the phone's
own contacts app syncs with the user's Google account.

- [ ] **Google sign-in in production.** The import (`services/api/src/cp2/google-contacts.ts`)
      needs `OAUTH_GOOGLE_ENABLED` and client credentials, which are off by default. Not checked on
      the deployed API.
- [ ] **Write-back.** The import asks for read-only access. Writing Grogoni customers and suppliers
      to Google Contacts makes them appear on the phone, with names on calls and texts.
- [ ] **Ongoing sync.** The import runs on demand only. Use Google's sync tokens on a schedule, with
      a rule for conflicts and deletions.
- [ ] **Separate label.** Keep business contacts under their own Google label so they are not mixed
      with personal ones and can be removed cleanly.
- [ ] **Disconnect.** Revoke the token and state what happens to contacts already written.
- [ ] **Google verification.** Contact access is a sensitive permission; Google must verify the app
      first, which needs the final privacy policy.
- [ ] **Consent wording.** Customer numbers are copied into a personal Google account. This matters
      most when a staff member, not the owner, connects theirs.
- [ ] **Coverage.** Only phones whose contacts sync to Google. SIM-only and phone-only contacts are
      not seen; iPhone works only if that Google account is added for contacts.

---

# Part 2: commerce and agents

Question reviewed: once Part 1 is done, is Grogoni a complete place where businesses, people and AI
agents do business with each other?

**Answer: no.** People and agents can find goods, agree an order and plan a delivery, but no money
moves inside Grogoni, an order has no working life cycle after it is placed, and nothing tells a
buyer whether a shop can be trusted.

Method: read the commerce, sales, supplier, compliance, fulfilment and agent tool code, the
outside-agent (MCP) server, and the store's persistence notes. No commerce flow was run end to end
and production was not checked.

## 9. What exists today

- Catalogue, stock, customers, invoices, manual payment records, debts and reports.
- A public storefront where a guest can chat and place an order request.
- Marketplace search and a cart that splits one checkout into one order per shop.
- Purchase orders from one shop to a supplier, sent in Grogoni, by email or by WhatsApp. A supplier
  on Grogoni can accept or reject in the app.
- Delivery planning: routes, vehicles, loads, driver manifests and a delivered state.
- A shop assistant with about 60 tools. Consequential tools (invoices, payments, messages,
  purchase orders, checkout) need an explicit confirmation for each action.
- A connection for outside AI agents. With the owner's PIN-approved token an outside agent can
  search the marketplace, read a catalogue and inbox, send messages (including encrypted ones),
  place orders and run delivery tools.
- Staff roles and invitations.

## 10. Orders and checkout

- [ ] **Order life cycle in the owner's app.** Orders are created as "requested". The only code
      that changes a marketplace order's status is the external shop-system API
      (`services/api/src/cp2/store.ts:7777`). The owner's app has no accept, reject or complete
      action, and guest storefront orders never change status at all.
- [ ] **Seller alert for a new marketplace order.** No notification type exists for orders
      (`packages/shared-types/src/index.ts:3865`), and I found no screen in the owner's app that
      lists marketplace orders. The seller sees only a new draft invoice.
- [ ] **Buyer order history and tracking.** A buyer can fetch one checkout by its id. There is no
      "my orders" list.
- [ ] **Buyer told when status changes.** A status update through the shop-system API changes the
      record only. It does not message the buyer, touch the invoice or check that the change makes
      sense (a cancelled order can be set back to accepted).
- [ ] **Delivery details at checkout.** A checkout item carries no address, delivery choice or fee.
- [ ] **Stock held for an order.** Stock is checked when the invoice is confirmed, not when the
      order is placed, so two buyers can both order the last unit.
- [ ] **Cancel, return and credit.** Invoices are only "draft" or "confirmed"
      (`packages/shared-types/src/index.ts:2568`). There is no void, return or credit note.
- [ ] **Orders from source offers.** The unified commerce report says offers cannot yet become
      real orders.

## 11. Money

- [ ] **A payment rail.** Payment methods are all manual records
      (`packages/shared-types/src/index.ts:2627`), and the checkout type notes that there is no
      real payment rail. Buyers and sellers settle outside Grogoni.
- [ ] **Payment confirmation.** Nothing verifies that a recorded payment happened.
- [ ] **Refunds.** The assistant is told to pass refund requests to the owner; there is no refund
      record or flow.
- [ ] **Disputes.** No code.
- [ ] **Holding funds and paying sellers.** No code.
- [ ] **Platform fees and billing for shops.** Not found.

## 12. Trust and safety

- [ ] **Verified businesses.** A shop's verification tier is set by the shop itself; the evidence
      types are "none", "owner attestation" or "business document"
      (`packages/shared-types/src/index.ts:3069`). Nobody at the platform reviews it and buyers do
      not see it.
- [ ] **Ratings and reviews.** None.
- [ ] **Report a shop, listing or user.** Users can block a contact. I found no way to report abuse.
- [ ] **Platform controls.** The platform operator role can only edit the model catalogue. There is
      no way to suspend a shop or remove a listing short of the database.
- [ ] **Customer support.** Support tickets exist only as a beta feature inside a shop's own
      workspace.

## 13. The shop's own assistant

- [ ] **Delegated authority.** Every consequential action needs a person to confirm it, one at a
      time. There is no rule such as "accept orders under a set value" and no spending limit, so an
      assistant cannot trade unattended.
- [ ] **Unconfirmed stock and product changes.** Creating a product and adjusting stock run without
      confirmation (`packages/tool-core/src/domains/products.ts:69`, `:129`). This is deliberate,
      but both change what buyers see.
- [ ] **Limits on AI cost.** Usage budgets are unlimited unless set (`.env.example`).
- [ ] **Assistant replies on SMS.** Off, as noted in Part 1.
- [ ] **Live checks.** The agent tests use scripted model replies. Behaviour with the real model on
      real shop data was not verified here.

## 14. Outside agents

- [ ] **Value limits per connection.** A token has two permissions, read and act. An agent with
      "act" prepares a checkout and then confirms it itself (`services/api/src/mcp/routes.ts:761`,
      `:779`), and confirms its own proposed actions (`:717`). No limit on order value or count.
      Low risk while orders carry no payment; a blocker once they do.
- [ ] **Checkout confirmation that survives restarts.** Pending checkouts sit in process memory
      (`services/api/src/mcp/routes.ts:41`). Check that prepare and confirm still pair up on the
      deployed Edge API, where requests may not share memory.
- [ ] **A record of who acted.** Confirm that orders and messages placed by an outside agent are
      marked as such for the other party.
- [ ] **Agent-to-agent trade.** A buying agent can order from a shop, and a shop's assistant can
      prepare a purchase order, but each side still needs a person to approve. No negotiation or
      quote exchange between two agents runs on its own.

## 15. Business to business

- [ ] **What happens after a supplier accepts.** Acceptance changes no stock and no payment record
      on either side.
- [ ] **Replies outside Grogoni.** A supplier's email or WhatsApp reply does not update the order.
- [ ] **Purchase orders by SMS.** Channels are Grogoni, email and WhatsApp only.
- [ ] **WhatsApp sending.** Needs an operator to configure a sender and an approved template per
      buying shop.
- [ ] **Verified wholesalers and resale.** Listed as not built in the unified commerce report.

## 16. Tax, currency and countries

- [ ] **Tax compliance.** A shop can store a tax rate and a KRA PIN. There is no link to the tax
      authority's invoicing system and no tax-compliant receipt.
- [ ] **One country.** Kenya is the only tax country (`packages/shared-types/src/index.ts:3075`).
- [ ] **One currency.** The app formats all money as Kenyan shillings
      (`apps/web/src/formatters.ts:14`).

## 17. Reliability and operations

- [ ] **Acknowledged writes can be lost.** The server answers from memory and saves to the database
      afterwards. A crash in between loses that write (`docs/single-instance-store-ceiling.md`).
      Unacceptable once orders carry money.
- [ ] **One server only.** All shop data must fit in one process, and a second instance would
      diverge. The repo's own note says this is safe for a closed beta only.
- [ ] **Login rate limits** are held in memory and reset on restart.
- [ ] **Monitoring.** A metrics endpoint exists but nothing collects it, and there are no alerts.
- [ ] **Full test run.** The last recorded full run (2026-10-25) had 15 failures and was not
      repeated cleanly. This review ran focused tests only.

## Suggested order for Part 2

1. Make orders work end to end in the owner's app: alert, accept or reject, complete, tell the
   buyer, hold stock.
2. Fix lost writes before any money feature.
3. One real payment method with confirmation and refunds.
4. Platform controls: report, suspend, reviewed verification.
5. Limits for outside agents, then delegated authority for the shop assistant.
6. Tax-compliant receipts.

---

## Suggested order for Part 1

1. Test build 5 on two real phones with different carriers; fix what breaks. Include the encrypted
   chat and push rows.
2. Conversation list with thread grouping, merged SMS and MMS, and real notifications.
3. MMS fixes that lose or reject messages: unsupported parts, photo resizing.
4. In-app update check.
5. Commerce link: per-customer sharing, faster reply delivery, payment request.
6. Final privacy policy and terms, then the Play gates and Google verification.
7. Google Contacts write-back and ongoing sync.
8. SMPP only after a carrier or aggregator account exists.
