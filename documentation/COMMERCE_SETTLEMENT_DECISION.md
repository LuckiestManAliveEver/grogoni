# Commerce Settlement Decision — Contacts-as-Source Buy/Sell

Status: recorded retroactively, decision already implemented
Date recorded: 2026-08-19
Implementing commit: `070d20f` — "Implement sell-flow status broadcasts and buy-flow unified checkout"
Scope: the status-broadcast sell flow and unified-cart buy flow described in
the v2 conversation-first commerce prompts (photo → detected items → status
broadcast to contacts; unified search/cart/checkout across a buyer's own
catalogue and contacts' active statuses).

This is not a numbered checkpoint. The feature was built and merged directly
(`070d20f`, 2026-08-17) rather than through the formal checkpoint procedure
(`documentation/README.md`'s "Standard Checkpoint Procedure"), so this
document does not claim a baseline/decision-log pair with a passed
checkpoint tag. Its purpose is narrower: record the settlement-model
decision the v2 prompts required as an explicit deliverable, since the
existing implementation only documents it inline in code comments and one
commit message, not as a standalone written record.

## The decision the v2 prompts asked for

The prompts named two options and required an explicit choice before
building unified checkout:

- **Option A — split payment.** One checkout action initiates N separate
  payments (one per source). Grogoni never holds buyer funds.
- **Option B — Grogoni as intermediary.** The buyer pays Grogoni once; Grogoni
  settles with each source on a separate schedule, holding funds and
  bearing reconciliation/refund/liability risk in between.

## What was actually implemented: neither — no payment capture at all

`createUnifiedCheckout`
(`services/api/src/cp2/domains/commerce/store.ts:1006-1112`) fans one
checkout action into one order per distinct source and moves zero money:

- **Catalogue-sourced items** (from a business's public storefront) get a
  draft invoice created through the existing invoice machinery
  (`buildStoredInvoice`, `status: "draft"`) plus a `BuyOrderSummary` in
  `"requested"` state. This is the same "requested"/draft-invoice state the
  pre-existing guest storefront checkout already used — no new payment
  concept was introduced. Whether/how that invoice is later paid is
  whatever payment path the business already uses for any other invoice.
- **Contact-sourced items** (from a phone contact's posted status) get a
  `StatusOrderSummary` with **no `invoiceId` field at all** — the type
  definition (`packages/shared-types/src/index.ts:1533-1555`) documents
  why: "Contacts are not businesses and have no invoice/payment machinery
  ... payment is handled directly between buyer and seller-contact, out of
  band, the same way a real-world peer sale would be." Grogoni records that a
  pickup was requested and tracks its status (`requested` → `accepted` /
  `rejected` → `completed`), but never touches money for it.
- **Marketplace-connector items** are rejected outright at checkout with
  the reason `"No marketplace connector is available for this item."` —
  consistent with `marketplaceConnectorAvailable` always being `false`
  everywhere else in the buy feed. There is no third case to make a
  settlement decision about yet, because there is no integrated external
  marketplace to settle with.

## Why this is the right call, not a shortcut

Both Option A and Option B assume a live payment rail exists to split or
intermediate. One does not exist yet:

- CP8 (Payments and Debt Tracking) explicitly deferred live provider
  integration on entry: `CP8-D06` — "Keep live M-Pesa/card/bank webhook
  reconciliation deferred... CP8 should not implement live payment provider
  callbacks unless a later hardening checkpoint is also scoped"
  (`documentation/checkpoints/cp8/DECISION_LOG.md`), re-deferred to
  CP14/CP15. Neither checkpoint's decision log records taking it back up.
  The current codebase confirms this is still true today: `"Manual payment
records track invoice payments and customer debt. Live M-Pesa integration
is intentionally deferred."` (`apps/web/src/app-shell.ts:196`).
- Building split-payment logic (Option A) with no payment rail to split
  across would be fabricated. Building Grogoni-as-intermediary logic
  (Option B) with no settlement rail to eventually pay sources out from
  would create funds-holding liability with no corresponding operational
  or compliance capability to discharge it. Both would be exactly the kind
  of "implement checkout's money-movement logic without first tracing what
  the existing payment integration actually supports" the prompts warned
  against.
- The chosen path — create real, trackable orders/handoffs and defer money
  movement to whatever payment mechanism the source already has (a
  business's existing invoice-and-manual-payment flow; direct peer payment
  for a contact sale) — is honest about what the platform can currently
  guarantee and does not block the rest of the flow (ranked search,
  grouped cart, fulfilment tracking) on a payment decision that isn't
  ready to be made.

## Recommendation for when a live payment rail exists

Once M-Pesa (or another rail) is actually live, this becomes a real,
answerable decision instead of a moot one. Recommendation at that point:
**Option A (split payment) for catalogue-sourced items, no change for
contact-sourced items.**

- Catalogue orders already resolve to a specific business's existing
  invoice; charging the buyer directly against that invoice via whatever
  rail the business already uses is a natural extension of "Grogoni never
  holds buyer funds" and requires no new settlement/reconciliation
  surface.
- Contact orders should keep the peer-to-peer, out-of-band model
  permanently, independent of whichever rail catalogue orders adopt —
  contacts are not businesses, have no invoicing relationship with Grogoni,
  and forcing one into existence to route a payment through Grogoni would be
  a bigger, separate product decision (effectively turning a contact into
  a merchant) that this settlement question shouldn't force.
- Option B (Grogoni-as-intermediary) is not recommended for either source
  kind: it would require Grogoni to take on refund, reconciliation, and
  regulatory liability for money it doesn't need to touch to make either
  flow work, for no corresponding product benefit over Option A.

This recommendation is not a commitment to implement — it requires the
same product/engineering sign-off the original prompts called for, once a
live payment rail is actually in scope.

## Evidence

- `services/api/src/cp2/domains/commerce/store.ts:999-1112` —
  `createUnifiedCheckout`.
- `packages/shared-types/src/index.ts:1507-1593` — `BuyOrderSummary`,
  `StatusOrderSummary`, `UnifiedCheckoutSummary`, `BuyCheckoutItemInput`.
- `apps/web/src/FulfilmentSplitCard.tsx` — post-checkout rendering of the
  no-payment order/handoff state.
- `documentation/checkpoints/cp8/DECISION_LOG.md` — `CP8-D06` and the
  M-Pesa deferral-to-CP14/CP15 row.
- `apps/web/src/app-shell.ts:196` — current-state confirmation that live
  M-Pesa integration is still deferred.
- `tests/buy-checkout.test.ts` — verifies the fan-out/ranking/no-merge
  behavior; does not and should not assert any payment-capture behavior,
  since none exists.
