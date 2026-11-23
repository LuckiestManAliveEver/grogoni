# Instant messaging, recipient picker and agent sessions: remaining checklist

Implementation update (2026-11-18): see [implementation and release evidence](instant-messaging-implementation-2026-11-18.md). The historical analysis below describes the reviewed revision; production certification remains gated.

Reviewed: 2026-11-17. Repository: `LuckiestManAliveEver/grogoni`.
Local branch: `perf/agent-response-latency`; HEAD: `736ce720` (plus uncommitted system-shop work, not reviewed here).

Scope: compare the prompt **Grogoni: Instant Messaging, Recipient Selection & Agent Session Improvements** with executable source. This is a review and checklist, not an implementation. No latency was measured in this pass; every number below that is not cited to a commit is a target, not a result.

## Verdict

**Not production ready for the prompt's definition of done.** The transport layers underneath are in good shape (server idempotency, a client outbox with backoff, Edge queued agent turns, native SMS delivery reports). The user-visible failures come from the web client coupling the Send action to the agent's reply, and from the "New message" button opening an agent chat instead of a recipient picker.

## Confirmed root causes

### R1. Send is locked for the whole agent turn (the 30-40 s block)

The prompt's "messages appear blocked for 30-40 seconds" is reproduced by reading the code path; it is not a network problem.

1. `apps/web/src/GrogoniApplication.tsx:2122-2125` wraps every send in `runAction("chat-send", () => sendChatDraft(...))`.
2. `apps/web/src/hooks/useAsyncActions.ts:8` drops any second `runAction` with the same key while the first runs, and `GrogoniApplication.tsx:1959` passes `isPending("chat-send")` to the composer as `isSending`.
3. `apps/web/src/ChatComposer.tsx:213` (Enter) and `:265-272` (Send button) refuse to send while `isSending`.
4. `sendChatDraft` does not resolve until the agent has replied:
   - Node API: `services/api/src/cp2/domains/messaging/routes.ts:611` runs `createAgentConversationMessage`, including model inference, inside the `POST /v1/messages` request. The client allows 90 s (`useChatRuntimeState.ts:1221`).
   - Edge API: the message is accepted and the turn queued, but the client then calls `waitForAgentTurn` (`useChatRuntimeState.ts:1224`), which long-polls for up to 180 s (`messaging/agent-turn.ts:34`) before `sendChatDraft` returns.
5. `useChatRuntimeState.ts:285` also holds the `grogoni-runtime-handoff` Web Lock across the entire send and agent wait, so other tabs are refused too.

Result: the person cannot send a second message, even to a human conversation, until Luna answers or times out.

### R2. Awaits that run before the bubble appears

The optimistic bubble for the main path is added at `useChatRuntimeState.ts:830-842`. Before it, the send may wait on:

- the Web Lock (`:285`);
- `GET /v1/conversations/:id` when the active conversation is not loaded (`:325`);
- `ensureAuthenticatedSession()` whenever bootstrap is not `"authenticated"` (`:345`);
- Luna reading every attachment for agent sends (`:426`) — several seconds per image, with no bubble shown;
- the receipt-draft path (`:462-480`), which posts two messages and only then renders them as `delivered`.

### R3. Own-message status describes the agent, not the transport

- Agent path: the user's message stays `pending` ("Sending…") until the agent reply arrives (`useChatRuntimeState.ts:1236-1263`), although the server accepted it in the first round trip.
- Buyer/daemon path: the message is marked `delivered` once the daemon task is submitted (`:721-725`). That is server acceptance, not delivery.
- Receipt path: rendered as `delivered` (`:468`) with no delivery event.
- Human path: after a successful POST the send awaits a full `loadMessagingInbox` (`:1311`) before releasing the composer.

### R4. Sync relies on 4-second polling on the production API

- `apps/web/src/hooks/useInboxRefresh.ts:58` reloads the inbox every 4 s regardless of activity.
- The Edge API answers `/v1/realtime` with `realtime_poll_required` (`services/api/src/edge-domain-routes.ts:819`). WebSocket push exists only on the Node API (`services/api/src/cp2/routes.ts:1545`).
- Incoming human messages can therefore take up to about 4 s to appear, and every open client polls continuously.

### R5. "New message" opens an agent session, not a recipient picker

- The `+ New message` FAB calls `onCreateAgentSession()` (`apps/web/src/ConversationListPanel.tsx:439`).
- The real recipient form sits behind a small "Message a phone number or email" link (`:136-146`). It takes free text, does not normalize to E.164 before creating, and offers no contact search or recent-conversation list.
- The phonebook list (`:384-414`) holds one `phone` per contact (`apps/web/src/phonebook-device-cache.ts:13-19`), so contacts with several numbers lose all but one. Its search matches names only.
- Duplicate-conversation protection exists only for `network-node:` recipients (`apps/web/src/hooks/useChatInboxState.ts:366-390`). A phone or email recipient goes straight to `POST /v1/conversations`; whether the server reuses an existing pair for it is unverified.

### R6. Agent sessions exist, but not inside the agent conversation

- `createAgentSession` (`useChatInboxState.ts:341-354`) creates a new personal conversation. A "session list view" and a "New chat" form exist (`ConversationListPanel.tsx:201-222`).
- The thread header (`apps/web/src/ChatSurface.tsx:488-568`) has no **+ New Session** or **Session history** control.
- The client runtime session is keyed by account + business (`runtimeManagerKey(accountId, businessId)`, `useChatRuntimeState.ts:1209`), not by conversation. Two agent sessions share one server runtime session and its turn limit. Message history is per conversation (`messaging/store.ts`, `runtimeConversationHistory`), but whether runtime checkpoints/task heads leak across sessions is unverified.
- A late agent reply is placed with `placeReplyAfter` into whatever messages are on screen (`useChatRuntimeState.ts:1236-1263`). If the user switched sessions while waiting, the reply is appended to the wrong thread until the next refresh. Suspected from source; needs a failing test to confirm.

## What already exists (reuse, do not rebuild)

- [x] Client-generated message IDs and server idempotency on `conversationId + clientMessageId` (`messaging/store.ts:602`, `:3932`).
- [x] Client outbox with per-conversation ordering, 3 automatic attempts at 15 s / 1 min / 4 min, cross-tab coordination and a manual "Send waiting" control (`apps/web/src/messaging/outbox.ts`, `MessageDeliveryMeta.tsx`; tests `messaging-outbox*.test.ts`).
- [x] Edge queued agent turns with `waitUntil`, lease, long poll and streaming preview (`edge-domain-routes.ts:950-1060`; tests `edge-async-agent-turns`, `edge-agent-turn-long-poll`, `agent-turn-wait`).
- [x] Delivery status vocabulary `draft | queued | pending | sending | retrying | sent | delivered | read | failed` (`packages/shared-types/src/index.ts:486`, `message-delivery-label.ts`).
- [x] Native Android SMS/MMS with sent and delivered receivers (`apps/android/.../sms/SmsResultReceivers.kt:68-75`), per-operation journal, SIM validation, no automatic replay of uncertain sends.
- [x] `libphonenumber-js` already in web, API and shared-types.
- [x] E2EE direct messages (`apps/web/src/e2ee.ts`), with outbox text kept in memory only.
- [x] Consent-scoped phonebook sync and device contact access (`contacts-access.ts`, `device-contacts.ts`, `phonebook-sync.ts`).
- [x] Agent session conversations, recycle bin, rename, pin/mute/archive.

## Remaining checklist

Each item names the outcome it moves and the test that proves it.

### Phase 1: audit gaps to close before building

- [x] Measure the baseline on the production Edge API: tap → bubble, tap → server ack, tap → composer usable, tap → agent reply. Write a deterministic script (Playwright with network throttling, "Slow 3G" and a 1.5 Mbps / 300 ms RTT profile) that records `performance.now()` marks. Save results under `/tmp/instant-messaging/baseline/`. Evidence: `scripts/measure-instant-messaging.mjs`; live rows in the implementation report (2026-11-19).
- [x] Confirm whether `POST /v1/conversations` with a phone/email recipient reuses an existing conversation for the same pair (server test in `tests/`). Evidence: `tests/edge-conversation-dedupe-postgres.test.ts`.
- [x] Confirm whether `cp2_runtime_sessions` state (turn count, task heads, handoff checkpoints) is shared across agent conversations, with a test that runs two sessions on one business. Evidence: `tests/agent-session-context-isolation.test.ts`.
- [x] Write a failing test for R6's late reply landing in the wrong session. Evidence: `e2e/instant-messaging-certification.spec.ts` ("switching sessions keeps each session's messages in its own thread"); `tests/agent-turn-async-chat.test.tsx`.

### Phase 2: instant, non-blocking send

- [x] **Decouple the composer from the agent turn.** Split `sendChatDraftOnRuntime` into `acceptMessage` (render, persist to outbox, POST, reconcile) and `followAgentTurn` (long poll, preview, reply placement). `runAction("chat-send")` covers only the first. Outcome: composer usable again in under 100 ms after tap. Test: with a model stub that never answers, a second message sends and renders. Evidence: e2e `composer accepts two messages before replies` (3 latency profiles).
- [x] **Release the Web Lock after acceptance**, not after the reply (`useChatRuntimeState.ts:285`). Test: second tab can send to a human conversation while an agent turn runs. Evidence: `tests/messaging-outbox-cross-tab.test.ts`; implementation report.
- [x] **Render before any await.** Move the optimistic bubble ahead of the lock, the conversation fetch, session revalidation and attachment reading (R2). The bubble carries `queued` until its outbox entry is written, then `sending`. Test: bubble present on the first render after tap, with every network call stalled. Evidence: e2e acceptance under 100 ms; `tests/recent-sends.test.ts` keeps the bubble through a read that lands before the send settles.
- [x] **Read attachments after the bubble.** Show the message with its attachment thumbnails at once; Luna extraction runs as part of the agent turn with its own progress line. Evidence: `tests/attachment-bubble-first.test.tsx`.
- [x] **Write to the outbox first, always.** Today the outbox is used only after a failure (`keepInOutbox`). Every send enqueues before the network call, so a reload mid-send cannot lose it. Move the outbox from `localStorage` to the existing IndexedDB repository (`apps/web/src/sync/indexeddb-repository.ts`) for durability and size. E2EE plaintext stays memory-only; ciphertext may be stored. Evidence: `tests/messaging-outbox-idb.test.ts`, `tests/outbox-storage-resilience.test.ts`.
- [x] **Node API parity.** Queue the agent turn after persisting the message on the Node API (reuse the Edge worker shape) so both adapters answer `POST /v1/messages` in one round trip. Test: Node `POST /v1/messages` with a 10 s model stub answers in under 500 ms with `processing.status = "pending"`. Evidence: PostgreSQL messaging gate (implementation report).
- [x] **Truthful statuses (R3).** `sent` = server accepted (HTTP 2xx with persisted id). `delivered` = recipient device acknowledged (E2EE device ack, native SMS delivery report, provider webhook). `read` only from read receipts. Agent-path messages show `sent` once accepted; the agent's progress is a separate placeholder. Remove the `delivered` shortcuts at `useChatRuntimeState.ts:252-255` (background daemon task), `:468`, `:723`. Test: state-machine unit test over every transition, plus one per transport. Evidence: `tests/message-delivered-on-sync.test.ts`, `tests/edge-delivered-postgres.test.ts`.
- [x] **SMS/MMS statuses** come only from `SmsResultReceivers` (`sent`, `delivered`, `failed`). MMS without a delivery report stays `sent`. Test: native bridge contract test that a missing delivery PDU never yields `delivered`. Evidence: `apps/android/.../NativeSmsDeliveryPolicyTest.kt`.
- [x] **Per-message retry.** A tap target on each failed bubble, in addition to the header "Send waiting" button. Same `clientMessageId`, so the server deduplicates. Evidence: `tests/message-retry-button.test.tsx`; e2e `a failed send is retried with the same message id`.
- [x] **Backoff that suits mobile networks.** Retry transport failures quickly (1 s, 2 s, 4 s, 8 s, capped at 60 s, with jitter) on `online` and visibility change. Keep the current slow 15 s / 1 min / 4 min schedule only for resends that rerun an agent turn. Evidence: `outboxEntryDue` transport schedule; implementation report.
- [x] **Deterministic ordering.** Sort by server sequence when present, then `clientTimestamp`, then `clientMessageId`. Test: out-of-order acks keep typed order. Evidence: `tests/conversation-message-order.test.ts`; e2e offline ordering.
- [x] **Replace 4 s polling on Edge (R4).** Use Supabase Realtime (already part of the deployed platform, no new paid service) or SSE from the Edge function on a per-account channel carrying only "conversation X changed"; clients fetch the delta. Keep polling as a fallback, backed off to 30 s when the push channel is healthy and paused when the tab is hidden. Outcome: inbound message visible in under 1 s; fewer requests per idle client per hour. Evidence: `/v1/realtime/messages` SSE: `tests/message-event-stream.test.ts`, `tests/account-message-hints.test.ts`.
- [x] **Delta fetch.** `loadMessagingInbox` reloads the inbox. Add `?since=<cursor>` for the open conversation so a refresh costs one small response. Evidence: `tests/instant-messaging-api.test.ts`; e2e `a message that arrives while the thread is open`.
- [x] Trace: emit `message.send.accepted_ms`, `message.send.ack_ms` and `agent.turn.reply_ms` client marks and a server log line per accepted message, so the performance targets are measured in production. (Client marks exist; the per-message server line is tracked in the remaining list.) **Done (2026-11-22):** the client marks now leave the device: production clients beacon them to `POST /v1/client-timings`, logged as `client_timing` beside `message_accepted` (`docs/deployment/supabase-edge-api.md`, "Send and reply timings"). Evidence: `tests/client-timings.test.ts`, `tests/edge-request-timing.test.ts`.

### Phase 3: New Message recipient picker

- [x] **Point the FAB at the picker.** `ConversationListPanel.tsx:439` opens a `RecipientPicker`; agent sessions move to the agent header (Phase 4). Keep the session-list view's "New chat". Evidence: e2e `New Message opens the picker`.
- [x] **Manual entry** with `libphonenumber-js` `parsePhoneNumberFromString(input, "KE")`, accepting `07xx`, `01xx`, `+2547xx`, `2547xx` and international numbers; show the formatted E.164 before continuing; reject invalid numbers inline. Reuse `PhoneNumberField.tsx` and `country-dial-codes.ts`. Tests: table of Kenyan Safaricom/Airtel/Telkom prefixes, landlines, short codes, spaces/dashes, and non-KE numbers. Evidence: `tests/recipient-picker.test.tsx`; e2e with a typed Kenyan number.
- [x] **Contact search** over name and every number (normalized digits), through existing `contacts-access.ts` / `device-contacts.ts`. On Android use the native contacts bridge; on the web use the Contact Picker API where supported. No upload of the contact book without the existing explicit sync consent. Evidence: `tests/recipient-picker.test.tsx`.
- [x] **Multiple numbers per contact.** Extend `DevicePhonebookContact` to `phones: { e164; label }[]` with a migration of the cached shape; the picker asks which number. Test: a contact with mobile + work numbers shows both. Evidence: `tests/phonebook-sync.test.ts`, `tests/recipient-picker.test.tsx`.
- [x] **Recent conversations** section at the top of the picker, searchable, opening the existing thread. Evidence: `tests/recipient-picker.test.tsx` (recents).
- [x] **Permission handling.** Ask for contacts only when the user taps "Choose from contacts"; a denial leaves manual entry fully usable and shows how to re-enable. Test: denied permission path. Evidence: Web: gesture-triggered access (implementation report). Android permission on the emulator is still open, see the remaining list.
- [x] **Dedupe by normalized destination.** Before creating, look up an existing conversation by E.164 or lowercased email (client) and enforce it server-side with a unique key on the participant pair / external destination. Test: creating twice returns the same conversation id; concurrent create races return one. Evidence: `tests/edge-conversation-dedupe-postgres.test.ts`.
- [x] **Transport choice stays explicit.** The picker result shows whether the recipient is a Grogoni account (E2EE direct message) or SMS-only, and keeps the existing "Send as SMS" handoff. Never silently convert one to the other. Evidence: `tests/recipient-picker.test.tsx` (Grogoni and SMS stay separate).

### Phase 4: + New Session inside every agent conversation

- [x] **Header controls.** In `ChatSurface.tsx` header, for agent conversations: `Agent name | Session history | + New Session`, sized for 360 px screens (icon buttons with labels, 44 px targets). Evidence: superseded by #83: agent chats keep the header-less home layout and sessions open from the inbox; `e2e/instant-messaging-certification.spec.ts`.
- [x] **New Session** calls the existing `createAgentSession` with the current agent/business, opens the empty thread, and never copies prior messages. Evidence: superseded by #83: agent chats keep the header-less home layout and sessions open from the inbox; `e2e/instant-messaging-certification.spec.ts`.
- [x] **Runtime session per conversation.** Change `runtimeManagerKey` to include `conversationId`, so each agent session has its own server runtime session and turn limit. Test: two sessions on one business keep separate turn counts and contexts. Evidence: Implementation report; `tests/agent-session-context-isolation.test.ts`.
- [x] **Context isolation test.** Session A learns a fact; Session B's model request contains none of A's messages (assert on the prompt the server builds). Evidence: `tests/agent-session-context-isolation.test.ts`.
- [x] **Session history panel** listing the agent's sessions with title, created time and last message; reopening continues that session. Evidence: superseded by #83: agent chats keep the header-less home layout and sessions open from the inbox; `e2e/instant-messaging-certification.spec.ts`.
- [x] **Pending replies stay with their session.** `followAgentTurn` captures `conversationId` and writes the reply only into that conversation's cache; if another thread is open, it updates the inbox preview and unread count instead. Test: switch session mid-turn; reply appears only in the original. Evidence: `e2e/instant-messaging-certification.spec.ts` ("switching sessions keeps each session's messages in its own thread").
- [x] **Restart persistence.** The active session id per agent is restored from the route/`screen-state-cache.ts` after reload. Test: reload restores the same session. Evidence: `e2e/instant-messaging-certification.spec.ts` ("a reload reopens the same agent session with its messages").
- [x] **Multiple agents.** Sessions are listed per agent (Grogoni Daemon, Luna, shop agents). Test: two agents, independent session lists. Evidence: since #83 one Chats list with each session's agent badge; `tests/agent-sessions-per-agent.test.ts`, `tests/new-session-keeps-agent.test.tsx`.
- [x] **Titles.** Auto-title from the first user message (deterministic truncation, editable), not a model call. Evidence: `tests/conversation-auto-title.test.ts`.

### Phase 5: reliability, security and offline

- [x] Duplicate prevention across retry and reconnect: test that resending after a lost response returns the same message and the same agent turn (Edge already does; add Node parity). Evidence: e2e `a failed send is retried with the same message id and ends sent, without a duplicate`.
- [x] Tenant boundary tests for the new paths: picker lookups, delta fetch, push channel subscription and session history never return another account's data. Evidence: `tests/picker-session-tenant-boundary.test.ts`, `tests/message-event-stream.test.ts`.
- [x] Push channel authorization: subscriptions are per account, revalidated on session expiry, carry ids only (no message text). Evidence: `tests/message-event-stream.test.ts`.
- [x] Agent failure isolation: a model outage leaves human messaging fully working. Test with the model adapter throwing. Evidence: `tests/agent-outage-human-messaging.test.ts`.
- [x] Offline: messages typed offline show `queued`, survive reload, and send in order on reconnect. Test with Playwright `context.setOffline`. Evidence: e2e `messages typed offline wait, then send in typed order on reconnect and survive a reload`.
- [x] No tokens or cookies in client logs or outbox entries (lint rule or test over the stored payload shape). Evidence: `tests/outbox-no-credentials.test.tsx`.
- [x] Migrations, if any (conversation destination unique key, per-conversation runtime session): additive, backfilled, tested with `tests/*-migration.test.ts` patterns on PostgreSQL. Evidence: No PostgreSQL migration; IndexedDB v2 to v3 in `tests/messaging-outbox-idb.test.ts`.

### Phase 6: tests and certification

- [x] Gate tests (Vitest, under 2 s each) for every item above. Evidence: Vitest gate files listed above.
- [x] Playwright suite under throttled network covering: optimistic display, slow model, slow server, offline/online, failed + manual retry, ordering, picker flows, session switching. Evidence: `e2e/instant-messaging.spec.ts`, CI step `Instant messaging certification`.
- [x] PostgreSQL Edge suite for Node/Edge parity of the queued turn and dedupe constraints. Evidence: `tests/edge-*-postgres.test.ts` in the PostgreSQL lane.
- [ ] Android emulator run (API 30, 2 GB RAM profile) for SMS status mapping and picker contact permission. (Tracked in the remaining list.)
- [ ] Physical low-end Android device and real Kenyan carrier run. Not available from this environment; required before claiming the mobile targets. (Tracked in the remaining list.)
- [x] Periodic eval: agent replies remain correct after the send/turn split (reuse `pnpm eval:openrouter-streaming` and the inventory quality gate). (Tracked in the remaining list.) **Done (2026-11-23):** `pnpm eval:agent-turn-split` (`scripts/eval-agent-turn-split.ts`) drives the Edge pipeline on PostgreSQL with the real model: stock and price, a follow-up that needs the previous turn, a sold-out item, two quick sends, and a resend that must not run a second turn. 5/5. It found that a read tool the agent chose answered with its plan and "Done.", dropping the data; fixed in `createRuntimeResponse` (`tests/runtime-read-replies.test.ts`). Weekly in `.github/workflows/agent-eval.yml` once `OPENROUTER_API_KEY` and `AGENT_TURN_EVAL_ENABLED` are set.

### Phase 7: delivery evidence

- [ ] Before/after table from the Phase 1 script: tap → bubble, tap → ack, tap → composer usable, inbound visibility, idle requests per hour. (Inbound visibility is tracked in the remaining list.)
- [x] Final report listing root causes (R1-R6), files changed, migrations, tests run with counts, skipped lanes and remaining risks. Evidence: Implementation report plus the remaining list.

## Targets to measure (not yet measured)

| Metric                            | Target                       | Current (from source)                 |
| --------------------------------- | ---------------------------- | ------------------------------------- |
| Tap → own bubble                  | < 100 ms                     | Unmeasured; blocked by R2 awaits      |
| Tap → composer usable again       | < 100 ms                     | Until agent reply or 90-180 s timeout |
| Tap → server ack (normal network) | < 1 s                        | Unmeasured                            |
| Inbound human message visible     | < 1 s with push              | Up to ~4 s (poll interval)            |
| Agent reply (model only, p50)     | Existing: 2.4 s (`a6402287`) | 2.4 s p50 measured 2026-11-17         |

## Priority order

1. R1 + R2 (send/turn split, render before awaits). Largest user-visible fix, client only, no migration.
2. R5 picker with manual entry and dedupe.
3. R6 header controls, per-conversation runtime session, pending-reply isolation.
4. R3 truthful statuses.
5. R4 push channel on Edge and delta fetch.
6. Node API queued turns for parity.
