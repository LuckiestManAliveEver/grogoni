# Stacked owner modules and commerce-flow audit

Status: implemented
Date: 2026-08-21

## Decision

The conversation is the persistent owner window. Secondary owner UI opens in the shared
`StackedModule` primitive and does not add a browser-history entry. The module supplies an explicit
close control, Escape handling, focus containment/restoration, scrim-tap close, and a 72 px
swipe-down close gesture. Its content scrolls independently, so opening and closing it does not
change the conversation's window scroll.

`ChatSurface` remains mounted for the lifetime of the owner shell. Messages and the composer render
before the fixed module layer and continue receiving streamed agent updates while the scrim is
visible. The module effect is keyed only by open state, so underlying stream renders do not refocus
or remount it.

Below the 760 px breakpoint (`useCompactViewport`, the same threshold `useChatInboxState` already
used for the inbox's initial open state), the conversation list also renders through `StackedModule`
instead of a plain `display: none`/`grid` toggle, so it picks up the same scrim, Escape, focus
containment, and swipe-down close as every other secondary surface, and the thread behind it becomes
inert while it's open. At and above 760 px the conversation list stays the non-modal sidebar `<aside>`
next to the thread - a real StackedModule there would incorrectly make the thread inert while both
panes are meant to stay simultaneously visible and interactive. Both branches render the same
`renderConversationListPanel` content; only the outer wrapper and the redundant "Chats"/"Messages"
heading (StackedModule already supplies a title bar) differ.

## Route and deep-link audit

The repository has no router library with a modal-route facility. It uses `AppRouter`, a typed
`OwnerRoute`, and the browser History API adapter in `browser-navigation.ts`.

The following formerly route-selected owner surfaces now use one owner-management module:

- Settings, Model & Agent configuration (`agent`)
- catalogue and product detail (`products`, with `routedProductId` as the initial payload)
- suppliers, customers, invoices, network, sync, runtime, payments, imports/receipts, logistics,
  compliance, beta, launch, reports, and notifications
- Marketplace and the generated workspace use the same primitive as separate module instances

There is no separate owner order-detail route in the current application. Order/fulfilment details
are structured cards in the conversation, so no route conversion was needed.

In-app callers (`navigateToView`, `openProduct`, and `openAgentProfile`) now select module state
without calling `navigateToOwnerRoute`, pushing history, or scrolling the underlying window.
BUY/SELL mode changes and conversation selection remain primary-window navigation.

Old external URLs remain compatibility bootstrap inputs rather than in-app destinations:

| Existing link                                | Window opened            | Pre-opened module/payload          |
| -------------------------------------------- | ------------------------ | ---------------------------------- |
| `/marketplace`                               | marketplace conversation | Marketplace                        |
| `/settings`, `/agents/:agentId`              | seller conversation      | Settings / Agent                   |
| `/catalogue`, `/products/:productId`         | seller conversation      | Catalogue; product ID when present |
| other legacy owner paths such as `/invoices` | seller conversation      | matching owner-management module   |

`readOwnerRoute` decodes these URLs during shell bootstrap. Closing a deep-linked module replaces
the compatibility URL with the active chat URL; it does not create another entry or rely on Back.
The existing OAuth callback routes, authentication/legal pages, public storefront/product links,
and conversation notification links stay routes because they are identity, public-entry, or
primary-conversation windows—not secondary owner surfaces. No converted-surface push-notification
caller was found.

Marketplace actions can write directly to the active composer through `commitDraft`; generated
commerce cards continue to write into the thread through the existing structured-message renderer.

## Photo-to-status audit

The repository already had the full status object and renderer path: `ProductCapturePanel`,
`ProductCaptureItemsCard`, `StatusBroadcastComposer`, `StatusBroadcastCard`, and
`StatusResultCard`, backed by commerce-domain capture and broadcast endpoints. A status is a
time-bounded object with recipients and independently updated view, reply, and resulting-order
counters; it is not represented as a plaintext message.

No vision/detection model is connected. The backend therefore returns one explicitly
`pending_review` placeholder, `detectionAvailable: false`, and no fabricated bounding box. The UI
states that detection is unavailable and lets the seller edit, confirm through the canonical
product mutation path, or reject the item. The contact candidate endpoint defaults to previously
relevant contacts or none—never select-all. Only chosen matched Grogoni contacts receive an in-app
status; unmatched contacts remain an explicit share-sheet handoff.

## BUY/cart/checkout audit

One query already merges catalogue listings and active contact statuses. Ranking lives in the
commerce backend so all clients receive the same order; contact status results win at comparable
relevance and price. Each result and cart row retains `sourceKind`, `sourceId`, and `sourceLabel`.
Checkout groups items by source, creates independent fulfilment handoffs, and reports unavailable or
declined items instead of dropping them or cancelling successful source groups.

No external marketplace connector exists. `marketplaceConnectorAvailable: false` and the visible
“not connected” state are intentional extension points; no real-looking marketplace results are
fabricated.

## Settlement

The binding settlement record is
[`documentation/COMMERCE_SETTLEMENT_DECISION.md`](../../documentation/COMMERCE_SETTLEMENT_DECISION.md).
Current checkout moves no money because live M-Pesa/card/bank capture is deferred. It creates
source-specific orders: catalogue items use draft invoices, while contact pickups settle directly
between buyer and contact. Once a live rail is approved, the recommendation is Option A (separate
source payments behind one checkout action) so Grogoni does not hold funds. Option B would add custody,
refund, reconciliation, and regulatory obligations and is not implemented.

## Verification contracts

- `tests/stacked-modules.test.ts` protects non-navigation opens, persistent conversation rendering,
  close gestures, and legacy deep-link bootstrap behavior.
- `tests/status-broadcast.test.ts` protects honest no-vision behavior, authenticated catalogue
  mutation, selective delivery, and engagement counters.
- `tests/buy-checkout.test.ts` protects contact-first ranking, source attribution, source grouping,
  handoff counts, and surfaced partial failures.
