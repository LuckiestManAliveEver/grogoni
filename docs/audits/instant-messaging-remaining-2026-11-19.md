# Instant messaging: what remains (2026-11-19)

Status after `fb45130f` (deployed: Edge API and grogoni.com). This list supersedes the open items of the [original checklist](instant-messaging-checklist-2026-11-17.md) and the [implementation report](instant-messaging-implementation-2026-11-18.md). Each item says how to tell it is done. Evidence was checked against the code and tests on 2026-11-19; "untested" means the behavior exists in code but no test proves it.

## Where things stand

| Metric                       | Target          | Measured live (grogoni.com, 2026-11-19)                 |
| ---------------------------- | --------------- | ------------------------------------------------------- |
| Tap → own bubble             | < 100 ms        | 20-77 ms ✅                                             |
| Tap → composer usable        | < 100 ms        | Same as bubble ✅                                       |
| Tap → server acknowledgement | < 1 s           | 2.2-3.4 s ❌ (server part 0.30-0.44 s; rest is network) |
| Inbound message visible      | < 1 s with push | Not measured ❌                                         |
| Idle API requests            | Low             | 9 per minute (was 11)                                   |
| Edge request, warm           | -               | 300-440 ms (was 1.55-1.75 s, every request cold)        |

## 1. Performance (blocks "instant")

- [ ] **Decide on snapshot query planning.** The `load` stage (165-190 ms warm) is mostly PostgreSQL planning a 154-arm `UNION ALL` on every request. The fix (parameterized SQL plus prepared statements through Neon's pooler, so plans are cached) is a production-risk change. Needs a decision first. Done when: `load` under 50 ms in `Server-Timing`, the full PostgreSQL lane is green, and there are no `prepared statement` errors in Edge logs for 24 h.
- [ ] **Measure acknowledgement from a Kenyan network.** All live numbers so far come from one machine with unstable connectivity. Run `scripts/measure-instant-messaging.mjs --live` from Safaricom and Airtel mobile data. Done when: before/after rows from a Kenyan network are in the audit doc.
- [ ] **Decide the Edge region if Kenya acknowledgement stays above 1 s.** Functions are pinned to `us-east-1` next to Neon `us-east-2`. Options: a closer region for both, or accept the network floor. Done when: decision recorded with measurements.
- [ ] **Measure inbound visibility.** Write a two-account harness: account A sends, and we time until B's open thread shows the message (SSE hint → delta read). Done when: the p50 and p90 are in the audit doc against the < 1 s target.
- [ ] **Load-test the hint stream.** Every open SSE stream re-checks the session and queries the journal every 500 ms, about 2 transactions per second per connected user. Done when: database CPU and Edge cost are measured at 100 and 1,000 concurrent streams, and the interval or design is adjusted if needed.
- [ ] **Decide the idle fallback cadence.** The remaining 9 requests per minute are the stream reconnect, the deliberate 30 s fallback checks (sync, inbox, open conversation), the notifications poll and a health check. Done when: the cadence is decided, for example a longer fallback while push is healthy.
- [ ] **Watch isolate retirement.** Isolates now serve about 7 requests before `EarlyDrop`. Done when: a saved logs query (`SELECT log_attributes['reason'], count() … event_message = 'shutdown'`) is reviewed after a day of real traffic and the median requests per isolate is recorded.

## 2. Behavior that exists but is unverified

- [ ] **"Delivered" for Grogoni-to-Grogoni messages.** Acceptance is now `sent`; confirm that something moves a message to `delivered` (recipient device acknowledgement). If nothing does, users see `sent` until `read`. Done when: a test proves the transition, or the gap is fixed.
- [ ] **SMS/MMS statuses from `SmsResultReceivers` only (R3).** No test found. Done when: a native-bridge contract test shows a missing delivery PDU never yields `delivered`.
- [ ] **Agent session context isolation.** No test that session B's model request contains none of session A's messages. Done when: a test asserts on the prompt the server builds.
- [ ] **Session header, New Session and session history UI.** Present in `ChatSurface.tsx` but untested. Done when: component tests cover opening history, starting an empty session, and the 360 px layout.
- [ ] **Active session restored after reload.** No test. Done when: a reload test restores the same session.
- [ ] **Independent session lists per agent.** No test. Done when: a two-agent test.
- [ ] **Auto-title from the first message.** Implemented in the messaging store (first 60 characters) but untested; "editable" is unverified. Done when: a store test, plus a rename check.
- [ ] **Per-message retry button.** Present in `MessageDeliveryMeta.tsx` but untested. Done when: a component test proves retry reuses the same `clientMessageId`.
- [ ] **Conversation dedupe under concurrency.** The server takes a direct-pair lock; no test of two concurrent creates found. Done when: a PostgreSQL test proves concurrent creates return one conversation.
- [ ] **Picker: recents and explicit transport choice.** Untested. Done when: picker tests cover the recents section and the Grogoni-versus-SMS labelling.
- [ ] **Attachments after the bubble.** Thumbnails at once, with Luna extraction progress as part of the agent turn. Unverified. Done when: a test with stalled extraction shows the bubble first.
- [ ] **Tenant boundaries on picker lookups and session history.** Delta reads and the push stream are covered; these are not. Done when: tests prove neither returns another account's data.
- [ ] **No tokens or cookies in outbox entries or client logs.** Done when: a test over the stored outbox payload shape.

## 3. Certification

- [ ] **Offline browser certification.** Typed offline → shows `queued` → survives reload → sends in order on reconnect, in Playwright with `context.setOffline`. Done when: green in CI.
- [ ] **Throttled Playwright suite.** `e2e/instant-messaging.spec.ts` covers only "two messages before replies". Add: slow model, slow server, failed plus manual retry, ordering, picker flows, session switching. Done when: green in CI.
- [ ] **Android emulator run.** SMS status mapping and the picker's contact permission on API 30 with 2 GB RAM. Done when: results are recorded.
- [ ] **Physical low-end Android and real Kenyan carrier.** Required before claiming the mobile targets. Done when: device model, carrier and the measured table are recorded.
- [ ] **Rerun the paid evals.** The 2026-11-18 results (Luna streaming 5/5, Jane's Shop 6/6) predate today's lazy loading of the agent loop. Run `pnpm eval:openrouter-streaming` and the inventory quality gate. Done when: they pass at their thresholds.
- [ ] **Independent review that approves.** Both earlier review rounds returned REQUEST_CHANGES. Done when: a fresh, cold review of the final code approves it.

## 4. Operations and housekeeping

- [ ] **Install the Supabase CLI permanently.** `pnpm deploy:api:supabase` needs it on `PATH` or `SUPABASE_CLI`. Today it runs from `/tmp/grogoni-supabase-cli/supabase`, which a reboot can delete. Adding `supabase@3.2.0` as a dev dependency needs approval. Done when: a deploy works without `/tmp`.
- [ ] **Tick the original checklist.** Many items in `instant-messaging-checklist-2026-11-17.md` are done but unticked. Done when: each is ticked with its evidence, or moved here.
- [ ] **Server log line per accepted message (trace item).** Client marks exist and `edge_request_timing` logs every route; there is no dedicated per-message acceptance line. Done when: added, or explicitly dropped.
- [ ] **Remove local test databases.** 20 throwaway databases in the local Docker Postgres (`grogoni_ci*_2026111*`, `grogoni_cihead*`, plus the `*_benchmark` ones). Done when: dropped.
- [ ] **Stop Codex's leftover processes.** The headless Android emulator and a stalled JDK download from 2026-11-18. Done when: stopped, or confirmed gone.
