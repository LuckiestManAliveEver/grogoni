# Default messenger readiness review — November 3, 2026

This is the initial assessment. See the [remediation and test results](default-messenger-remediation-2026-11-03.md) for subsequent fixes and remaining acceptance limits.

Verdict: not ready to recommend as a primary everyday messenger. The native Android app implements a basic SMS client suitable for controlled testing. This assessment concerns the current working tree, including existing uncommitted work; it does not certify the deployed version. No application code was changed during this review.

## Findings

1. **High — MMS cannot be received or composed.** `apps/android/app/src/main/java/market/grogoni/app/sms/NativeSmsReceiver.kt:53` declares an MMS receiver that only attempts an unsupported-message notification. It does not download or persist the multimedia message. Photo and group MMS therefore cannot be used through this default handler. The README explicitly documents this limitation. The UI warning does not supply the missing transport.

2. **High — incoming SMS persistence can fail silently.** `NativeSmsReceiver.kt:41` wraps the provider insert in `runCatching`, ignores both exceptions and a null insert result, and continues to notification and optional backend enqueue. There is no durable local fallback or retry in this receiver. A provider failure can therefore leave an incoming SMS absent from the local inbox while a notification is still attempted. This is a source-confirmed failure path, not a reproduced carrier incident. Android assigns storage and notification responsibility to the default handler: https://developer.android.com/reference/android/provider/Telephony.Sms.Intents . Add durable recovery, observable failure handling, and fault-injection verification before relying on this path.

3. **High — personal SMS can enter business processing.** `GrogoniSessionStore.kt:36` defaults synchronization to enabled. Once a business is selected, `NativeSmsReceiver.kt:15–29` queues every assembled incoming message whose sender normalizes, including its full text; this path has no personal/business or sensitive-content filter. The UI offers a persistent SMS-only pause and explicitly selects a business, so this finding does not establish undisclosed transmission. It does mean personal messages and OTPs from ordinary phone numbers can enter the business backend. Make synchronization an explicit opt-in with clear scope and verified exclusions before recommending mixed personal/business use.

4. **Medium — short-code replies are rejected.** `NativePhoneNormalizer.kt:6–20` permits only E.164-format results with 7–15 digits after the plus sign. `MainActivity.kt:371` applies that normalizer to every manual send. Carrier/service short codes cannot pass, blocking ordinary STOP/HELP and service replies. Carrier destinations need validation appropriate to SMS rather than forcing every destination into E.164.

5. **Medium — older messages are inaccessible through the native inbox.** `LocalSmsInbox.kt:22–35` caps the query reader at 100 messages. The native screen exposes individual messages and Reply, with no pagination or full conversation browser. This does not delete older provider records, but leaves them inaccessible through this screen. The README also identifies the full conversation browser as missing.

6. **Medium, web fallback — concurrent offline outbox writes can be lost without Web Locks.** The focused cross-tab regression test reproduced losses in the deliberately unlocked fallback: 251 missing entries across three rounds with 200 expected entries per round. The supported locked path passed its concurrency test. This result is conditional on `navigator.locks` being unavailable; it is not evidence of loss on all browsers. Use transactional storage or explicitly constrain support before claiming reliable offline behavior in that environment.

7. **Release blocker — release evidence and approvals remain incomplete.** The manifest release gate reports `manifest.release is null`; identity and legal gates report unapproved status and pending ownership/signing/legal fields. These are local repository gate results, not a finding about an unseen Play Console account. Google Play restricts SMS permissions to approved core functionality and requires the appropriate default-handler status: https://support.google.com/googleplay/android-developer/answer/16558241 . Do not describe the present repository state as approved for Play release.

## Validation performed

Fresh focused run: five Vitest files, 27 tests passed:

- `tests/android-native-sms-channel.test.ts`
- `tests/messaging-outbox.test.ts`
- `tests/messaging-outbox-cross-tab.test.ts`
- `tests/service-worker-push.test.ts`
- `tests/messenger-contact-privacy.test.ts`

All three strict release checks failed as described above:

- `node scripts/verify-android-release-manifest.mjs --require-release`
- `node scripts/verify-android-release-identity.mjs --require-approved`
- `node scripts/verify-play-legal-readiness.mjs --require-approved`

The native SMS channel tests exercise injected backend contracts; the service worker tests do not establish actual notification receipt. No new physical-phone, carrier, native Gradle, production deployment, or sustained availability test was performed. Historical browser reports and existing emulator artifacts are not fresh physical-device acceptance evidence.

## Required acceptance evidence

Before primary-messenger use, fix the loss/privacy/destination paths and implement the needed MMS and history features. Verify on physical phones with active SIMs: inbound/outbound and multipart Unicode SMS; delivery failures; no service and recovery; role/permission loss; process death and reboot; notification receipt; dual-SIM changes; and switching back to another default handler. Fault-inject provider/storage failures and verify recovery without duplicate sends or lost messages. Verify personal-message isolation with synchronization both enabled and paused. Complete release artifacts and applicable distribution approvals.

The current implementation has useful foundations: local SMS can operate without login or internet, sends check role/permission/subscription, callbacks distinguish sent from delivered internally, notifications omit message bodies, and backend contract tests verify ownership and deduplication. Those strengths do not resolve the blockers above.
