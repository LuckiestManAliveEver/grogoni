# Offline commerce: order intents over BLE and SMS

## What this adds

A merchant device can now receive orders while offline, from two transports:

- **BLE** - a nearby customer's own Grogoni app sends an order over `packages/offline-runtime/providers/peer-provider.ts`'s existing nearby-mesh transport.
- **SMS** - a remote customer texts the merchant's own SIM (the existing `native_sms` channel,
  `docs/architecture/android-native-sms-channel.md`); the text is parsed into structured order
  items when the buffered message finally reaches the server.

Neither transport is allowed to touch committed stock on its own. Both produce an
`OfflineOrderIntent` (`packages/shared-types/src/index.ts`) - a client- or server-authored,
idempotency-keyed claim that gets reconciled against real inventory exactly once, by exactly one
function: `Cp2Store.pushOfflineOrderIntents` (`services/api/src/cp2/store.ts`).

Payment capture (M-Pesa STK push, callback verification, cash reconciliation UX) is explicitly out
of scope here. `OfflineOrderIntent.paymentMethod`/`paymentReference` exist so that work has
somewhere to land later; this pass never charges anyone.

## Data model

`packages/offline-runtime`'s local SQLite store gains one additive table,
`pending_offline_orders` (`db/migrations/002_offline_orders.sql` - a new migration file, not an
edit to `001_initial.sql`). It holds an `OfflineOrderIntent` plus its last known
`OfflineOrderIntentOutcome`, with `status` one of `pending_sync | confirmed | rejected | partial`.
Recording an intent (`offline-orders/intent.ts`'s `recordPendingOfflineOrder`) only ever writes to
this table - it never touches `rows` (the product mirror), so a captured order is always
"provisional" until synced, exactly like the rollout plan's existing rule for every other offline
write.

## The one reconciliation path

Two entry points, one function:

```text
BLE order_intent frame → PeerProvider.orderIntentSink → recordPendingOfflineOrder (local only)
                                                              │
                                                     device reconnects, syncs
                                                              ▼
                                          POST /sync/order-intents ──┐
                                                                      ├──► Cp2Store.pushOfflineOrderIntents
inbound SMS text → parseOfflineOrderText → (already online) ────────┘         │
                                                                                ▼
                                                          createInvoice + confirmInvoice
                                                          (existing sales domain, unmodified)
```

`pushOfflineOrderIntents` does nothing but call the sales domain's existing, synchronous
`createInvoice`/`confirmInvoice` - the same functions the online invoice UI uses. `confirmInvoice`
already does the check-then-decrement stock guard the rest of the app relies on
(`services/api/src/cp2/domains/sales/store.ts`); this feature adds no new stock-mutation code
path. Because the whole reconciliation body is synchronous (no `await` between reading
`product.quantity` and confirming), two intents racing for the same unit - whichever transport
they arrived over - resolve deterministically: the first one this Node process reaches wins, the
second sees the reduced quantity and is rejected or partially fulfilled. This is the same
single-authoritative-process guarantee `docs/offline/rollout-plan.md` already documents for
`/sync/push`; running more than one API process would break it identically for both endpoints.

An item that doesn't fully fit is never silently dropped from a larger order - the endpoint
reports `confirmedItems`/`rejectedItems` per line, and the overall intent status is `confirmed`
(everything fit), `partial` (some did), or `rejected` (nothing did, or no item matched the
catalogue at all).

Idempotency is per-intent-id, tracked in `OfflineJournal.replayOrderIntent`
(`services/api/src/cp2/offline-runtime.ts`) - a retried push of the same intent id returns the
cached outcome rather than re-running it. Known gap: unlike `OfflineJournal.receipts` (used for
`/sync/push`), this cache is **not** included in `Cp2Store`'s snapshot/restore cycle, so it does
not survive a server process restart. A retried push after a restart, in the narrow window between
confirming an order and the client receiving that ACK, could create a second invoice for the same
intent. This mirrors the same risk `/sync/push` already carries for anything before its receipt is
durably persisted, but is not yet closed here - flagged as a follow-up, not fixed in this pass.

Sequence numbers require no new machinery: every entity `createInvoice`/`confirmInvoice`/customer
creation touches already flows through `Cp2Store.appendBusinessEvent` into
`OfflineJournal.append`, the same process-local counter every other CP2 mutation uses.

## Customer identity

Every `OfflineOrderIntent.customerClaim` is either `{ type: "account", accountId }` (a BLE buyer's
own authenticated Grogoni account) or `{ type: "phone", phone }` (an SMS sender's number) - never a
BLE device name or address, matching `peer-provider.ts`'s existing rule that a transport never
supplies identity. An `account` claim is verified against a real registered account
(`Cp2Store.requireAccount`, via `linkCustomerAccount`) before a customer record is created or
reused; a forged or nonexistent account id makes the whole intent's customer-resolution step
fail, and the intent is rejected rather than attributed to the wrong customer.

## BLE envelope extension

`PeerProvider` (`packages/offline-runtime/providers/peer-provider.ts`) gains two envelope kinds on
top of its existing conversation-message transport, sharing the same fragmentation/relay/dedup
frame format (one new header byte distinguishes them - see the file's `HEADER_BYTES`/`KIND_*`
constants):

- `catalogue_digest` - a small (≤512 byte), fire-and-forget beacon (`storeId`, a product-list hash,
  and the merchant's last sync sequence). Never carries the catalogue itself. A peer that sees a
  stale digest is expected to `connect(deviceId)` for a direct delta pull rather than wait for or
  request a full broadcast - `PeerProvider` does not initiate that pull itself, it only exposes the
  digest via `onCatalogueDigest`.
- `order_intent` - queued and retried through the exact same outbox/resend-cap machinery as a
  conversation message (`PeerOutboxEnvelope`'s `"order_intent"` variant), because losing a captured
  order silently on a flaky BLE link would be worse than losing a chat message. Received frames are
  validated (`validateOfflineOrderIntent`) and handed to an injected `orderIntentSink` - the
  constructor's third argument - and nothing else. Left unwired, a device simply drops order_intent
  frames instead of silently accepting them; production wiring passes
  `offline-orders/intent.ts`'s `recordPendingOfflineOrder`, which only ever writes to
  `pending_offline_orders`.

`PeerProvider.supports()` gained the two new op names (`peer.catalogueDigest.broadcast`,
`peer.orderIntent.send`) but still returns `false` for every real business-mutation op
(`catalogue.create`, `orders.confirmInvoice`, ...) - see the existing comment at the top of the
class. This BLE path stays behind its own separate gate, additive to
`OFFLINE_RUNTIME_ENABLED`/`VITE_OFFLINE_RUNTIME_ENABLED`, matching the rollout plan's "BLE remains
a separately gated prototype" stance; this change does not flip either flag anywhere.

## SMS ordering

`services/api/src/cp2/domains/agent-runtime/offline-order-planning.ts` parses free text like
`"2 sugar 1kg, 1 soap"` deterministically - regex + string matching, no model call, since this is
exactly the same-input-same-output work the project's "deterministic space" rule says belongs in
code. A segment is comma/semicolon/newline-separated; each must be quantity-led
(`"<number> <name>"`) and match exactly one product by name or alias (falling back to an
unambiguous substring match). If **any** segment fails to parse or match, the **whole** message is
treated as ambiguous - no partial order is created from the segments that did parse, because that
would silently ship less than the customer asked for. `services/api/src/cp2/domains/messaging/store.ts`'s
`ingestNativeSmsMessage` calls this right after the existing canonical-message ingestion:

- Not order-shaped at all (no quantity-led segment) → left alone, no reply, no intent.
- Order-shaped but ambiguous → a deterministic, templated clarification SMS is sent back
  (`offlineOrderClarificationMessage`), no intent created.
- Cleanly parsed → one `OfflineOrderIntent` (`transport: "sms"`, a `phone` customer claim from the
  sender's number) goes straight into `Cp2Store.pushOfflineOrderIntents` - the same function the
  BLE path's `/sync/order-intents` route calls - and the resulting outcome is sent back as a
  second deterministic, templated SMS (`offlineOrderOutcomeMessage`): confirmed, partial (with
  what wasn't available), or rejected (with why).

Both reply sends reuse the existing `MessagingDomain.sendChannelMessage`/`ChannelGateway`
`native_sms` adapter - the same queue-to-device path any other outbound SMS already takes. They
are system-initiated transactional replies, not the AI agent's automatic replies (which stay off
for this channel, per the existing `automaticRepliesEnabled: false` conversation metadata).

`NativeSmsInboundResult.orderIntentOutcome` (`packages/shared-types/src/index.ts`) surfaces the
outcome (or `null`) to whatever already reads that ingestion response.

## What this does not add

- No payment capture of any kind.
- No change to `render.yaml`, the Vercel/`ai-runtime` service, or any inference boundary.
- `OFFLINE_RUNTIME_ENABLED`/`VITE_OFFLINE_RUNTIME_ENABLED` are not flipped anywhere by this change.
- No new merchant-facing UI screen. `pending_offline_orders`' `status` field is the data a future
  "provisional orders" screen would read; building that screen is not part of this pass.
- Cross-process durability for order-intent idempotency (see "known gap" above).
