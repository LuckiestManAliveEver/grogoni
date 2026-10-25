# Grogoni conversation-first frontend: architecture and migration roadmap

Status: roadmap adopted and fully implemented — Phases 1-3, 4a-4m (all ShellViews audited), 5 (architectural enforcement), and 6 (permanent tab bar removed) all shipped
Date: 2026-08-21
Design contract: three mockups reviewed as one product system —
`grogoni-shell-mockup.html`, `grogoni-sell-status-mockup.html`,
`grogoni-buy-unified-cart-mockup.html` (not committed to the repo; treat this
document plus the running Buy/Sell implementation as the durable record of
their content).
Decision: **full shell replacement** — home becomes the session list and
Grogoni's permanent UI is reduced to
`GrogoniShell → SessionList → ConversationSession → Composer → GeneratedSurface`,
with every other business view (products, customers, invoices, payments,
suppliers, network, sync, runtime history, imports, logistics, compliance,
beta, launch, reports, notifications) migrated one at a time into
generated-in-conversation surfaces, done incrementally with the existing
view staying live until its replacement genuinely works — never a
big-bang cutover.

## The governing principle

> Conversation is the app. Buy/Sell is a mode, not a page.

Grogoni is not an e-commerce site with chat added. It is a conversation
runtime in which commerce interfaces are rendered. The mockups' shell
explicitly rejects Catalogue and Orders tabs; the session list is the
entire home screen; everything past it — product cards, confirmations,
status posts, cart, checkout — is tool output the agent places into the
thread, not a hard-coded page.

That distinction is an architectural constraint here, not a styling
decision: **a capability's primary frontend representation is a
generated conversation surface, not a permanent page**, unless a concrete
reason says otherwise (see "When a permanent page is still correct"
below).

## Audit: what already matches the mockups

This is the most important finding of the audit. A large fraction of the
Buy/Sell mockups' content already exists in the repository, built during
earlier work on the same underlying product vision, before these specific
HTML files were reviewed together as a system. Nothing here needed to be
invented from scratch.

### Sell flow (`grogoni-sell-status-mockup.html`) — already built

| Mockup step                         | Existing implementation                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attach photo                        | Existing product-capture upload pipeline (reused, not duplicated)                                                                                                                                                                                                                                                                                                                                                                       |
| Vision detects items, pins on photo | `packages/shared-types/src/index.ts` `ProductCaptureItemSummary.boundingBox` (normalized `{x,y,width,height}` in `[0,1]`, exactly the mockup's coordinate convention). `detectionAvailable` is honestly `false` today — no real vision model is wired in — and the frontend renders that fact ("Detection isn't available yet — review manually") rather than fabricating pins, per `apps/web/src/ProductCaptureItemsCard.tsx:103-107`. |
| Seller reviews/edits per item       | `ProductCaptureItemsCard.tsx` — confirm/reject per item through `/product-captures/.../items/.../confirm`, never a direct catalogue write                                                                                                                                                                                                                                                                                               |
| Contact picker, never select-all    | `apps/web/src/StatusBroadcastComposer.tsx:28-36` — explicit comment: "Never default to select-all: only pre-check contacts who are both a matched Grogoni account and an existing customer of this business"                                                                                                                                                                                                                            |
| Status posted, tracked              | `apps/web/src/StatusBroadcastCard.tsx` + `StatusBroadcastSummary` (`viewCount`/`replyCount`/`resultingOrderIds`) — a real trackable object, not a plain message                                                                                                                                                                                                                                                                         |

One deliberate deviation from the mockup: its step-3 contact list checks
Pastor Njoroge (labeled "In phonebook", not "Regular customer") by
default, which is inconsistent with its own "contacts-only by default,
trust model" note. The existing, already-tested backend rule
(`defaultSelected` only when `isExistingCustomer && isGrogoniUser`) is more
precisely specified and is what the implementation follows — the mockup's
example checkbox state was not copied literally.

### Buy flow (`grogoni-buy-unified-cart-mockup.html`) — already built

| Mockup step                                                   | Existing implementation                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One query, fan-out, no source picked first                    | `services/api/src/cp2/domains/commerce/store.ts:933-997` `searchBuyFeed` — merges `listPublicStorefronts` and `listStatusBroadcastsReceivedByViewer` server-side                                                                                          |
| Contacts rank above marketplace at comparable price/relevance | Same function, line 989: `buyTextRelevanceScore(...) + (sourceKind === "contact" ? 50 : 0)` — a flat bonus, not unconditional priority; a much stronger catalogue match still outranks a barely-relevant contact result                                   |
| Marketplace connectors                                        | `BuyResultSourceKind = "contact" \| "catalogue" \| "marketplace_connector"` exists in the type system; `marketplaceConnectorAvailable` is always `false` — never fabricated (matches `ProductCaptureItemSummary.detectionAvailable`'s honesty convention) |
| Distinct result rendering by source                           | `apps/web/src/StatusResultCard.tsx` — `buy-source-badge buy-source-${sourceKind}`                                                                                                                                                                         |
| Cart grouped, not merged                                      | `apps/web/src/UnifiedCartSummary.tsx` — grouped by `${sourceKind}:${sourceId}`, one combined total, source label per group                                                                                                                                |
| Checkout: one action, N fulfilment handoffs                   | `services/api/src/cp2/domains/commerce/store.ts:999-1112` `createUnifiedCheckout` — one order per distinct source (draft invoice per business, no-invoice peer order per contact status); failures surfaced, never silently dropped                       |
| Order tracking shows the split                                | `apps/web/src/FulfilmentSplitCard.tsx` — "N contact pickups + M shop orders," independent status per handoff                                                                                                                                              |
| Settlement decision                                           | Recorded explicitly in `documentation/COMMERCE_SETTLEMENT_DECISION.md` — no payment capture today (no live rail exists), recommended direction for when one does                                                                                          |

Both flows are wired into the live conversation renderer already —
`apps/web/src/ChatSurface.tsx:781-804` renders `ProductCaptureItemsCard`
/ `StatusBroadcastCard` / `FulfilmentSplitCard` per-message off structured
metadata, lazy-loaded, not as separate app sections.

### Generated surface protocol — already correctly typed at the wire level, not at the render level

`ConversationMessageContent` (`packages/shared-types/src/index.ts:445-460`)
is already a proper discriminated union by `type`: `text`, `product-card`,
`encrypted`, `storefront`, `owner-controls`, `confirmation`,
`product-capture-progress`, `status-broadcast`, `unified-checkout`. The
server constructs these; nothing renders raw model HTML or executes
model-generated code anywhere in the repository.

The gap was entirely on the frontend rendering path. `mapConversationMessage`
(`apps/web/src/chat-message-plumbing.ts:48-108`) already switches on
`message.content.type` correctly, but then **flattens** each variant into
a growing bag of optional fields on the frontend's own `ChatMessage` type
(`businessCards`, `productCaptureJobId`, `statusBroadcastId`,
`unifiedCheckoutId`, ...), and `ChatSurface.tsx` checked each field with
its own `message.field !== undefined ? <SpecificCard /> : null` block.
Every new surface type meant one more optional field plus one more
if-block, growing without bound — exactly the anti-pattern Stage 4 of the
design brief calls out, just arrived at through field-flattening rather
than phrase-matching. **This is fixed in Phase 1, below.**

### Buy/Sell mode — genuinely not per-session yet, and non-trivial to make so

This is the one place where the mockups describe something the repository
does not yet have, and where "just move a variable" would be wrong.

- `apps/web/src/hooks/useNavigationState.ts` holds `mode: GrogoniMode`
  (`"marketplace" | "seller"`) as a single piece of state for the whole
  app — not a property of any individual conversation.
- The server has an equivalent concept, `GrogoniSessionContext`
  (`packages/shared-types/src/index.ts:1108-1133`), but it is stored
  **one row per account** (`services/api/src/cp2/store.ts:6060-6093`,
  keyed by `session.account.id`, not by conversation), and it already
  gates real authorization: `createConversationMessage` throws
  `seller_context_required` when `context.mode !== "seller"` for an
  owner-controls message (`services/api/src/cp2/domains/messaging/store.ts:2442-2448`).
  Moving `mode` to be per-conversation is therefore not a pure frontend
  change — it changes an authorization input.
- Conversations are already genuinely multi-instance per account (the
  inbox lists `personal` / `storefront` / `order` conversations), but the
  owner's own agent chat is a **singleton**:
  `ensurePersonalAccountConversation` (`services/api/src/cp2/domains/messaging/store.ts:3512-3533`)
  finds or creates exactly one `kind: "personal", activeShopId: null`
  conversation per account. The mockup's session list shows several
  independently-titled owner-agent sessions ("Restock maize", "Chicken
  feed", "School laptop") each with their own mode — today's data model
  supports exactly one.

Making Buy/Sell genuinely per-session therefore requires, in order:
(1) allowing an account to have more than one personal agent conversation,
(2) moving mode (and the authorization check that reads it) from
account-scoped to conversation-scoped, (3) the frontend session-list UI
that lets a user create/open/rename these. This is sequenced as Phase 3
below, after the safer, purely-additive Phase 1 and Phase 2 work, and it
gets a dedicated audit of every `context.mode` read site before any code
changes, per the same discipline used everywhere else in this codebase's
modularization work — trace every call site, don't guess.

## Per-conversation session context (Phase 2 — implemented)

Full audit before any change, then the smallest data-model change that
makes (2) above true without requiring (1) or (3) yet — Phase 2's own
stated scope ("land it behind the existing conversation/session
infrastructure without changing today's single-session behavior yet").

**What the audit found:**

- `getGrogoniSessionContext`/`updateGrogoniSessionContext`
  (`services/api/src/cp2/store.ts`) gate three separate authorization
  invariants on `mode`/`activeShopId`/`activeSurface`: the
  `seller_context_required` check on `owner-controls` messages
  (`domains/messaging/store.ts:2442`), `active_shop_required` (seller mode
  needs an active shop), and `surface_mode_invalid` (`sellerOnlySurfaces =
new Set(["catalogue", "owner-controls", "receipt"])`, `store.ts:275`,
  only reachable in seller mode). None of the three cared how the context
  row was keyed — they only ever read fields off whatever
  `StoredGrogoniSessionContext` they were handed.
- `updateGrogoniSessionContext` already accepted a `conversationId` input
  before this change, but only used it to validate membership and to
  overwrite the single row's `conversationId` field — not to select which
  row to operate on. There was exactly one row per account, full stop.
- Context bootstrap was duplicated verbatim in two places: account/session
  creation (`store.ts`, inside `createSession`) and the lazy
  `ensureGrogoniSessionContext`. Both built the same default-shape object.
  Collapsed into one `buildDefaultSessionContext` helper as part of this
  change — a correctness-neutral cleanup the audit surfaced, not a
  Phase 2 goal in itself.
- The frontend (`apps/web/src/hooks/useAuthState.ts`) genuinely keeps
  `mode`/`view`/`activeConversationId` synced with the backend context
  today, bidirectionally: `loadGrogoniSessionContext` restores frontend state
  from `/v1/session/context` on every login, and a debounced 250ms effect
  in `GrogoniApplication.tsx` (~line 847) `PATCH`es the backend whenever
  frontend mode/shop/surface/conversation drift from the last-known
  server value — already sending its current `activeConversationId` on
  every patch. This is why Phase 2 could ship as a pure backend change:
  the frontend was already conversation-aware, it just had only one
  conversation to be aware of.
- Persistence is a JSON-blob mirror (`cp2_session_contexts` table, one row
  per snapshot-array entry, upserted by `entity_id`), not a structured
  SQL table — the Drizzle-schema `grogoni_session_contexts` table (with its
  own migration history, including 052's deliberate collapse from
  `session_id`-per-row to `account_id`-per-row) is a separate, write-never
  table that only the GDPR purge query touches. No DDL migration was
  needed: the composite key lives entirely in application code
  (`sessionContextKey(accountId, conversationId)` and the
  `recordEntityId` mapping in `postgres-store.ts`), and the periodic
  full-snapshot writer (`saveCollectionRecords`) self-heals any row left
  over from the pre-Phase-2 `entity_id = accountId` scheme on its next
  write, since that row no longer matches any `desiredId`.

**What changed:**

- `sessionContexts` (`store.ts`) is now keyed by
  `sessionContextKey(accountId, conversationId) = "${accountId}:${conversationId}"`,
  not `accountId` alone. `ensureGrogoniSessionContext` takes an optional
  `conversationId`; omitted, it resolves to the account's personal
  conversation exactly as before (so every existing caller is unchanged).
  Passed, it resolves and validates that conversation
  (`requireAccountConversation`) and returns/creates _that conversation's
  own_ context row, defaulting fresh (`mode: "marketplace"`, `activeSurface:
"conversation"`) rather than inheriting the account's other contexts.
- `GET /v1/session/context` accepts an optional `?conversationId=` query
  param. `PATCH /v1/session/context`'s existing `conversationId` body
  field now selects the target row instead of only repointing the single
  row's `conversationId` field.
- The three authorization checks are untouched — they already worked
  against whichever context object they were handed.
- Today's behavior is unchanged: `ensurePersonalAccountConversation` still
  returns the same one conversation per account (Phase 3 hasn't shipped
  multi-session creation yet), so every account still has exactly one
  context row in practice. The change is structural readiness, not a
  behavior flip.
- Regression test:
  `tests/cp20-unified-session-conversations.test.ts` — "gives each
  conversation its own session context row instead of one shared
  account-wide row" creates a second (storefront) conversation the same
  account already participates in, sets a different mode/surface on it via
  `?conversationId=`, and asserts the account's personal conversation's
  context is untouched and `store.snapshot().sessionContexts` now holds
  two independent rows. Verified to fail against the pre-Phase-2 code
  (stashed the implementation, kept the test, confirmed a real
  `AssertionError`) before restoring the fix.

**What Phase 3 still needs**, now that the data model is ready: a way to
create a _second_ personal agent conversation for an account (today only
`ensurePersonalAccountConversation`'s singleton exists), and the
session-list UI itself.

### The 15 conventional top-level views

`apps/web/src/app-shell.ts`'s `ShellView` union has 19 entries: `home`,
`chat`, `agent`, and 16 business views (`products`, `suppliers`, `customers`,
`pos`, `invoices`, `network`, `sync`, `runtime`, `payments`, `imports`,
`logistics`, `compliance`, `beta`, `launch`, `reports`, `notifications`).
`OwnerWorkspace.tsx`'s `renderOwnerWorkspace()` is a single switch statement rendering one
`*Surface` component per view. `GrogoniApplication.tsx` supplies grouped hook bindings and remains the
shell composition root.

The good news for migration risk: every one of these 15 views is already
a clean, self-contained, prop-driven component
(`ProductSurface`, `CustomerSurface`, `InvoiceSurface`, ...), each backed
by its own already-extracted domain hook (`useProductsState`,
`useCustomersState`, `useInvoicesState`, `usePaymentsState`,
`useSuppliersState`, `useNetworkState`, `useSyncState`,
`useRuntimeHistoryState`, `useImportsState`, `useLogisticsState`,
`useReadinessState` for compliance/beta/launch, `useReportsState`,
`useStorefrontCareState`/`useNotificationsState`) from the earlier
OwnerApp state-decomposition effort. None of these components are
entangled with routing. Migrating a view to a generated surface is a
presentation-layer change — reuse the existing Surface component and its
hook unchanged, change how it is _reached_ (a conversation action instead
of permanent top-level navigation), not a business-logic rewrite.

## Multi-session UI (Phase 3 — implemented)

The audit for this phase found the roadmap's own stated blocker
("(1) allowing an account to have more than one personal agent
conversation") was already false: `POST /v1/conversations`'s
`createConversation` always calls `createAccountConversation`, which
mints a fresh `randomUUID()` conversation unconditionally — it was never
a find-or-create. The singleton behavior the earlier audit found belongs
only to `ensurePersonalAccountConversation` (the login-time bootstrap
path). So `{ kind: "personal", activeShopId: null }` with no `recipient`
already created a genuinely new, independent agent session; nothing in
the repo just called it more than once. Phase 3 turned out to be wiring
existing primitives together on the frontend, not new backend capacity.

**The one real gap**: `ConversationInboxItem` (used for both the home
session list and the general chat inbox) could not distinguish "my own
agent session" from "a direct message with another human" — both are
`kind: "personal"` with `activeShopId: null`. Added `hasHumanRecipient:
boolean` to the type, computed server-side in `listConversations`
(`services/api/src/cp2/domains/messaging/store.ts`) from a small
extracted helper, `conversationHasHumanRecipient`, that also replaced an
inline duplicate of the same check already used by
`attemptPublicAgentReply`'s `agent_processing_requires_agent_conversation`
guard.

**What changed:**

- `apps/web/src/ChatSurface.tsx` — `home` now filters `conversations` to
  `kind === "personal" && !hasHumanRecipient` (the account's own agent
  sessions); `chat` is untouched and still shows the full inbox
  (DMs/storefront/order included), so nothing about today's messaging
  behavior regresses. `home`'s heading reads "Sessions" with a "New
  session" action (an inline name form, mirroring the existing "New
  conversation" form's shape) instead of the DM-creation flow.
- `apps/web/src/hooks/useChatInboxState.ts` — `createAgentSession(title?)`
  posts a fresh `{ kind: "personal", activeShopId: null }` conversation
  and switches to it via `selectConversation`.
- `apps/web/src/hooks/useAuthState.ts` — added
  `applySessionContextForConversation(conversationId)`, the per-session
  sibling of `loadGrogoniSessionContext`: fetches
  `/v1/session/context?conversationId=` (Phase 2) and applies that
  conversation's own `mode` instead of the account-wide default.
  `selectConversation` now calls this on every switch, so **Buy/Sell mode
  is genuinely per-session** — switching to a different agent session
  restores that session's own mode instead of carrying over whatever mode
  the previous session was in. The existing debounced sync effect in
  `GrogoniApplication.tsx` (Phase 2) already sent the active
  `conversationId` on every patch, so the write side needed no change —
  only the read side (switching sessions) was missing this.
- `useAuthState`'s hook call moved earlier in `GrogoniApplication.tsx` (right
  after `useChatThreadState`, before `useChatInboxState`), since
  `useChatInboxState` now needs `applySessionContextForConversation` at
  call time. Verified none of `useAuthState`'s own inputs depend on
  anything `useChatThreadState`/`useChatInboxState` produce before
  moving it.

**What Phase 3 deliberately left alone**: `activeShopId` does not travel
with a session switch. An account can only ever hold one shop (creating a
second returns `store_already_registered`), so there is no second
business to switch _to_ yet — this becomes relevant only once Phase 3's
own non-goal (multiple shops per account) is ever revisited, which it
is not here.

Regression tests: `tests/session-list-home.test.ts` (frontend wiring,
source-text) and `tests/cp20-unified-session-conversations.test.ts`
("lets an account hold several independent agent sessions, distinct from
direct messages" — creates two sessions plus one DM, asserts
`hasHumanRecipient` correctly separates them for both participants).
Verified to fail against the pre-Phase-3 code (stashed the
implementation, kept the tests, confirmed real failures) before
restoring the fix.

## Products chat-invokable capability (Phase 4a — implemented)

The first of the 15 per-`ShellView` migration phases. The initial audit
(see "the audit found" in this section) discovered the real scope was far
bigger than "add a card" — closer to a new feature than a refactor. The
user was asked to confirm the calibration before building
(AskUserQuestion, per the Confusion Protocol) and chose the full literal
spec, one domain at a time.

**What the audit found:**

- Two of the four product runtime tools were execution stubs:
  `product.update`/`product.stock_adjust` in `executeRuntimeAction`
  (`services/api/src/cp2/domains/agent-runtime/store.ts`) returned `null`
  unconditionally, regardless of what a valid proposal contained.
- No intent for "edit a product" or "adjust stock" existed in the
  _primary_ free-text parser (`RuleIntent`, `packages/tool-core/src/index.ts`)
  — only `add_product`/`show_products`/etc.
- A second, separate vocabulary matcher already existed
  (`ProductContextScriptMatch`/`createRuntimeToolProposalFromProductContextScript`,
  bilingual EN/SW phrase lists) with `PRODUCT_EDIT`/`PRODUCT_STOCK_ADJUST`
  cases already defined — but both were hard-coded to always return
  `invalid(...)`, meaning even a fully-specified message could never
  produce an executable proposal through it.
- **Critical finding from the first draft of this phase**: the initial
  implementation fixed the _primary_ parser
  (`parseMerchantCommand`/`createRuntimeToolProposal`) and shipped a
  regression test using `parseMerchantCommand` directly - it passed. A
  second, end-to-end test hitting the real
  `POST /businesses/:id/runtime/turns` route failed: `createRuntimeTurn`
  (`agent-runtime/store.ts` ~line 2756-2767) tries the **context-script
  matcher first** and only falls back to `parseMerchantCommand` when it
  doesn't match — and "add product X" always matches the context-script's
  own `PRODUCT_ADD` phrase list. The primary-parser fix was real but
  dead code for this exact case; the actual default path needed the same
  fix applied to `extractProductContextEntities`/
  `createRuntimeToolProposalFromProductContextScript` instead. Caught only
  because the regression test exercised the real HTTP route instead of
  the parser function directly — the harsh-critic discipline this session
  runs on ("re-break the fix, verify against the real path") working
  exactly as intended.
- A currency-tagged number ("ksh 150") was being read as **both** a
  quantity and a price by both parsers' shared bare-number regex — a
  second bug the end-to-end test caught before it shipped. Fixed by
  extracting the currency-tagged span first and excluding it from the
  generic quantity match in both places.

**What changed:**

- Both parsers now support `update_product`/`adjust_stock` intents
  (primary parser: new `intentRules` entries, `extractSlots` extraction,
  `getMissingSlotQuestion` clarification; context-script matcher:
  `PRODUCT_EDIT`/`PRODUCT_UPDATE`/`PRODUCT_STOCK_ADJUST` cases now
  produce `valid()` proposals when their required fields are present,
  instead of always asking a question).
- `product.create` on both paths now carries an optional `sellingPrice`
  when the message includes a currency-tagged number.
- `executeRuntimeAction` implements `product.update`/`product.stock_adjust`
  for real: resolves the named product, applies only the fields the
  message specified (falling back to the existing value for anything
  unmentioned), and calls the sales domain's existing
  `updateProduct`/`adjustProductStock` methods (newly wired into the
  agent-runtime domain's `deps`).
- A new self-contained `ProductManagementCard` (mirrors
  `ProductCaptureItemsCard`'s shape — fetches its own data from
  `businessId` alone, not `useProductsState`/`ProductSurface`, which need
  8 injected deps tied to sibling hooks in `GrogoniApplication.tsx`) is
  posted into the owner's own conversation
  (`useChatRuntimeState.ts`'s `applyRuntimeResult`, after any successful
  `product.create`/`product.update`/`product.stock_adjust` runtime turn)
  via a new `"product-management"` `ConversationMessageContent` variant,
  registered in `generated-surface-registry.tsx` the same way as the
  other three card types.

**What Phase 4a deliberately left alone**: the permanent `products`
`ShellView`/nav entry is **not removed**. The roadmap's own rule is
"legacy pages are removed only after their generated-surface replacement
is proven working — never a big-bang cutover," and this environment has
no browser automation available to prove it live. The chat-invokable path
is additive: an owner can now also manage products entirely through
chat, but the Products page keeps working exactly as before for
everyone who doesn't use it that way yet.

Regression tests: `tests/cp4-rule-parser.test.ts` (new intents, and the
currency/quantity double-counting fix), `tests/cp10-grogoniclaw-runtime.test.ts`
("creates, edits, and adjusts stock for a product through confirmed
runtime turns" — a full propose→confirm cycle against the real HTTP
route, the test that caught both bugs above), `tests/product-management-card.test.ts`
(frontend wiring, source-text). Verified to fail against the
pre-Phase-4a code (stashed the implementation, kept the tests, confirmed
real failures) before restoring the fix.

## Suppliers chat-invokable capability (Phase 4b — implemented)

Same pattern as 4a, applied to suppliers — with a genuinely new failure
mode Phase 4a hadn't surfaced yet.

**What the audit found:**

- No supplier runtime tools existed at all (`RuntimeToolName` had zero
  `supplier.*` entries) — a bigger gap than products, which at least had
  two of four tools working. Added `supplier.create`/`supplier.update`
  (`supplier.delete` deliberately left off the chat-invokable surface,
  matching the existing `product.delete` precedent of requiring a more
  deliberate trigger than loose free-text scoring — see "What Phase 4a
  deliberately left alone").
- Suppliers have no context-script vocabulary of their own (that matcher
  is product-only, `scriptId: "product-vocabulary"`), so the primary
  parser (`parseMerchantCommand`) is the _only_ path — no dual-parser
  sync risk like 4a's.
- **The real catch, found by writing the end-to-end test before trusting
  the parser in isolation (same discipline that caught 4a's bugs)**: the
  product vocabulary's built-in phrase list includes a _bare_ `"edit"`
  and `"badilisha"` entry for `PRODUCT_EDIT` — matching on the verb alone,
  with no requirement that a product noun also be present. `"edit
supplier John Doe 0798765432"` matched `PRODUCT_EDIT` before it ever
  reached the primary parser, with `"supplier john doe"` misread as a
  product name. This is a pre-existing looseness in the product
  vocabulary (several other intents have similarly bare single-word
  phrases — `PRODUCT_LIST` matches on bare `"stock"`/`"product"`/etc. too)
  that was latent and harmless until a second domain started using
  overlapping verbs. Rewriting the whole vocabulary's specificity was out
  of scope for this phase; instead `parseProductContextScriptCommand`
  gained a narrow guard — a message naming another domain noun
  (`supplier`/`msambazaji`) skips product-vocabulary matching entirely
  and falls through to the primary parser, which owns `update_supplier`.
- Reused Phase 4a's currency/quantity double-counting fix pattern for
  phone numbers: `"0712345678"` in a message must not also be read as a
  quantity. `extractSlots` now extracts a phone-shaped run of 7+ digits
  before the generic quantity match, the same way it already excludes a
  currency-tagged price.

**What changed:** `supplier.create`/`supplier.update` tool definitions,
new `add_supplier`/`update_supplier` primary-parser intents (EN/SW), the
product-vocabulary exclusion guard above, `executeRuntimeAction` cases
resolving the named supplier and calling the sales domain's existing
`createSupplier`/`updateSupplier`, a new self-contained
`SupplierManagementCard` (mirrors `ProductManagementCard` — fetches its
own data from `businessId`, not `useSuppliersState`, which needs
`loadReports`/`registerReset`/`registerRefresh` tied to sibling hooks),
registered under a new `"supplier-management"` content type. Permanent
`suppliers` nav entry kept, same reasoning as 4a.

Regression tests: `tests/cp4-rule-parser.test.ts` (new intents, and the
`parseProductContextScriptCommand` exclusion guard — asserts `"edit
supplier..."` returns `null` from the product matcher), `tests/cp10-grogoniclaw-runtime.test.ts`
("creates and edits a supplier through confirmed runtime turns, not the
product vocabulary" — asserts zero products exist after the run, the
guard against the exact regression this phase found), `tests/supplier-management-card.test.ts`
(frontend wiring). Verified to fail against the pre-Phase-4b code before
restoring the fix.

## Customers chat-invokable capability (Phase 4c — implemented)

Same pattern as 4b, applied to customers — this time reusing 4b's own
infrastructure directly rather than rediscovering it.

**What the audit found:**

- `customer.create` already existed and was fully wired (unlike
  suppliers' complete absence) — but hard-coded `phone`/`email`/`notes`
  to `null` regardless of what the message said, the same class of gap
  Phase 4a fixed for product price. No `customer.update` tool existed.
- The product-vocabulary exclusion guard added in Phase 4b
  (`parseProductContextScriptCommand` skipping product matching when the
  message names another domain noun) already had the right shape to
  extend — added `customer`/`customers`/`client`/`clients`/`mteja`/`wateja`
  to the same guard rather than writing a second, parallel mechanism.
  Verified empirically (not assumed) that `"edit customer Mary Wanjiru
0700111222"` collided with `PRODUCT_EDIT`'s bare `"edit"` phrase before
  the guard, exactly like the supplier case.
- Reused 4b's phone-extraction fix in `extractSlots` as-is — no new work
  needed, since it was already unconditional (not gated to a specific
  intent), so `add_customer`/`update_customer` picked it up automatically
  once `createRuntimeToolProposal` started reading `slots.phone`.

**What changed:** `customer.update` tool definition, `update_customer`
primary-parser intent, `executeRuntimeAction`'s `customer.create` case
now carries `phone` (previously always `null`) and a new `customer.update`
case resolving the named customer and calling the sales domain's existing
`updateCustomer`. A new `CustomerManagementCard` (no delete action - no
`deleteCustomer` endpoint exists in this codebase at all, confirmed by
checking rather than assuming, so the card only offers what the REST
contract actually supports), registered under `"customer-management"`.

Regression tests: `tests/cp4-rule-parser.test.ts`, `tests/cp10-grogoniclaw-runtime.test.ts`
("creates and edits a customer through confirmed runtime turns, not the
product vocabulary"), `tests/customer-management-card.test.ts`. Verified
to fail against the pre-Phase-4c code before restoring the fix.

## Invoices chat-invokable capability (Phase 4d — implemented)

A genuinely different shape from 4a-4c, found during the audit rather
than assumed going in.

**What the audit found:**

- `invoice.draft`'s tool proposal has always been hard-coded
  `invalid("Invoice runtime draft needs product and price details.")` -
  unconditionally, regardless of what the message says - and
  `executeRuntimeAction`'s `invoice.draft` case has always been a stub
  returning `null`. Both are original design decisions, not bugs: an
  invoice needs a resolved product, a quantity, and a unit price, and the
  primary parser's `create_invoice` slot extraction has only ever
  captured `customerName` (no product-name extraction exists for
  invoices at all). Getting all of that right from one free-text message
  is a materially harder extraction problem than 4a-4c's single-field
  create/update commands - "2 sugar at 150" requires resolving "sugar" to
  a real product AND disambiguating which number is quantity versus
  price, for a record that moves stock and money once confirmed.
- The frontend itself only ever composes **one line item per invoice
  draft** (`useInvoicesState.ts`'s `createInvoicePayload()` sends a
  single-item array, even though the backend's `InvoiceInput.items`
  accepts multiple) - so matching the permanent page's own scope, not
  exceeding it, an interactive single-item composer is the right shape,
  not a gap.

**The scope decision this phase made**: rather than building a fragile
multi-slot extractor to parse product+quantity+price from text (real NLU
work, not "smallest correct"), the chat trigger reacts to the _existing_
`create_invoice` classification - unconditionally, not gated on tool
execution succeeding (`invoice.draft` never executes for real) - and
opens an interactive `InvoiceManagementCard` pre-filled with whatever
customer name the message named. The owner picks the product from a
dropdown and enters quantity/price there, then the card calls the same
`POST /businesses/:id/invoices` and `.../confirm` endpoints the permanent
page already uses. **No backend parser or execution code changed in this
phase** - `create_invoice`/`invoice.draft`'s existing shape was already
exactly what the new frontend trigger needed; Phase 4d only added the
frontend reaction to a proposal shape that already existed.

Regression tests: `tests/cp10-grogoniclaw-runtime.test.ts` ("classifies
create_invoice and surfaces the extracted customer name for the composer
card" - pins the existing backend contract the new frontend code depends
on; passes unchanged with no backend files stashed, confirming this
phase's only new code is frontend), `tests/invoice-management-card.test.ts`
(frontend wiring - verified to fail without the frontend implementation).

**Capability-first follow-up:** the deterministic one-line free-text parser still clarifies and
opens this composer when product IDs and line details are absent. The registered
`invoice.draft` capability is no longer a stub: validated structured input containing canonical
`items` now executes `SalesDomain.createInvoice` after confirmation. This preserves the safe
composer behavior while making the capability independently addressable by richer callers.

## Payments chat-invokable capability (Phase 4e — implemented)

Same shape as 4d, applied to payments — the second, not the first, time
this "composer card instead of NLU extraction" pattern got used, which
is why it took a fraction of the effort.

**What the audit found:** `payment.record`'s proposal has always been
hard-coded `invalid("Payment runtime draft needs an invoice id and
method.")` — a customer can have several open invoices, and free text
cannot reliably say which one a payment applies to. Same underlying
reason as invoices, confirmed rather than assumed by reading the
existing code and reusing the exact `record_payment`/`payment.record`
proposal shape (`customerName`, `amount`) already extracted by the
primary parser.

**What changed:** A `PaymentManagementCard` opens as soon as a message
classifies as `record_payment` (unconditional on tool execution, same as
invoices), pre-filled with the extracted customer name matched against
`GET /businesses/:id/payment-summaries` (invoices with a balance due) —
picking the first unpaid invoice for that customer if one matches, so
the common case (a customer with one open invoice) needs zero extra
clicks. The owner confirms amount and method, then the card calls the
same `POST /businesses/:id/payments` endpoint the permanent page uses.
No backend parser or execution code changed — extended the _existing_
`record_payment` test to also pin `plan.input` (customerName, amount) as
the contract the new frontend code depends on, rather than adding a
parallel test.

**Capability-first follow-up:** incomplete free text continues to open the composer. Validated
structured input containing `invoiceId`, positive `amount`, and `method` now executes the
registered `payment.record` capability through `SalesDomain.recordPayment` after confirmation.

Regression tests: `tests/cp10-grogoniclaw-runtime.test.ts` (extended, not
duplicated), `tests/payment-management-card.test.ts` (frontend wiring —
verified to fail without the frontend implementation).

## Imports chat-invokable capability (Phase 4f — implemented)

A third distinct shape — this domain was already the _most_ chat-capable
of any so far, and the audit found the gap was narrower than expected.

**What the audit found:**

- "Imports" (the `imports` `ShellView`, "Purchase receipts" in the nav)
  is bulk CSV/document import of product catalogues or supplier lists —
  a different concept from the per-receipt photo OCR flow that actually
  lives under Suppliers (`uploadSupplierReceipt`/`confirmSupplierReceipt`
  in `useSuppliersState.ts`). Confirmed by reading both hooks rather than
  assuming from the nav label.
- Uploading a document is unavoidably a file action — `receipt.scan` and
  `createDocumentImport` both need actual file bytes, which a chat text
  message cannot carry. This is a genuine, permanent constraint, not a
  gap this phase could close.
- **`document_import.confirm` already resolves and executes for real
  from chat today** — `createRuntimeDocumentImportProposal`
  (`agent-runtime/store.ts`) is a third, separate proposal-generation
  path from `parseMerchantCommand`/the product-vocabulary matcher
  (worth knowing given the two false-positive collisions those found in
  4a/4b), triggered by action+document-reference words. It resolves
  "confirm the import" (or a message referencing a specific job ID) to
  the account's latest previewed job automatically, validates it has
  selected rows, and — once confirmed the same way any other
  high-risk tool is — calls the real `confirmProductImport`/
  `confirmSupplierImport`. This was already a complete, shipped feature,
  confirmed by an existing passing end-to-end test
  (`tests/document-agent-import.e2e.test.ts`), not discovered as new.

**What changed:** the one real gap was reviewing and adjusting row
selection _inline_, instead of requiring a trip to the permanent Imports
page before confirming. A new `ImportManagementCard` opens as soon as a
message classifies as `document_import.confirm`, showing the job's rows
with per-row selection (mirroring `ProductCaptureItemsCard`'s review
pattern), then calls the same confirm endpoint the permanent page uses.
No backend parser or execution code changed — extended the existing
end-to-end test to pin `plan.input.importJobId` as the contract the new
frontend code depends on.

Regression tests: `tests/document-agent-import.e2e.test.ts` (extended),
`tests/import-management-card.test.ts` (frontend wiring — verified to
fail without the frontend implementation).

## Network capability (Phase 4g — canonical runtime path)

The owner request "find Dairy Supplier through my network" now plans and executes
`network.route` inside the canonical server runtime. Chat no longer imports the frontend-only
phrase matcher or calls `requestNetworkRoute`; after a successful capability result it only opens
the Network view. The capability preserves the complete request text and delegates to
`NetworkDomain.createAgentRoute`, while the existing target-node button continues to call the
same domain endpoint for the conventional UI workflow.

Phone contact selection, OAuth redirects, and file import/export remain explicit UI/device
workflows because they require browser grants or files, not because Chat holds mutation authority.
Regression coverage lives in `tests/network-route-request-text.test.ts` and the real runtime path
in `tests/network-sync-graph.test.ts`.

## Logistics chat-invokable capability (Phase 4h — implemented)

Unlike network (4g), logistics was judged genuinely chat-relevant: "mark
delivered", "picked up", "out for delivery" are natural merchant
sentences, and the domain already had a real, fully-working backend
mutation (`updateLogisticsStatus` in
`services/api/src/cp2/domains/logistics/store.ts`) that had simply never
been wired into the runtime-tool system.

**What the audit found:**

- `updateLogisticsStatus` was a complete, non-stub method — validates the
  status transition, requires `logistics:write`, updates
  `completedAt`/`cancelledAt`, records a business event. Nothing backend
  needed building from scratch, only wiring.
- No existing `RuntimeToolName`/`RuleIntent` covered logistics at all —
  the fourth domain this session where "the backend mutation exists but
  the runtime-tool layer never learned about it" (after products,
  suppliers before their fixes, and — differently — imports before 4f).
- Like invoices/payments (4d/4e), "mark delivered" can never be fully
  specified from free text alone: a merchant can have several open
  deliveries, and the message rarely states a status precisely enough to
  trust automatically. Same "composer card, no full auto-execution" shape
  as those two phases, not automatic execution.

**What was built:**

- `packages/tool-core/src/index.ts`: a new `update_logistics` rule
  intent (EN/SW phrases — "mark delivered", "out for delivery", "picked
  up", "imefika", "imetumwa"), a `logistics.update_status` runtime tool
  registered as high-risk/confirmation-required, and a proposal that
  extracts the customer name but stays deliberately invalid (needs which
  delivery and the new status) — mirroring `payment.record`'s shape
  exactly.
- `services/api/src/cp2/domains/agent-runtime/store.ts` +
  `services/api/src/cp2/store.ts`: wired `logistics.update_status`
  execution to the existing `LogisticsDomain.updateLogisticsStatus`, no
  new backend mutation logic.
- `LogisticsManagementCard.tsx`: a new self-contained generated card,
  same shape as `PaymentManagementCard` — fetches the business's open
  deliveries, pre-selects one matching the extracted customer name if
  given, lets the owner pick the delivery and the new status, then
  `PATCH`es the same endpoint the permanent Logistics page already uses
  (`useLogisticsState.ts:updateLogisticsStatus`).
- Registered in `generated-surface-registry.tsx` and
  `grogoni-application-shared.ts`; the `logistics-management` message-content
  variant added to `ConversationMessageContent` and validated server-side
  in `messaging/shared.ts`; the trigger in `useChatRuntimeState.ts` posts
  the card as soon as a turn classifies as `logistics.update_status`, not
  gated on execution (it never auto-executes from text alone, same as
  invoices/payments).

Regression tests: `tests/cp4-rule-parser.test.ts` (new parser-level
assertion for `update_logistics`, verified against real parser output
first), `tests/cp10-grogoniclaw-runtime.test.ts` (new end-to-end test
proving the real HTTP route classifies "mark delivered for Mary" as
`logistics.update_status` and stays a non-executing clarification),
`tests/logistics-management-card.test.ts` (frontend wiring — verified to
fail without the frontend implementation). All three verified to fail
with the Phase 4h implementation files stashed, pass with them restored.

## Sync + Runtime audit (Phases 4i-4j — no card, no bug)

Both domains audited honestly, per the same standing instruction as 4g:
judge each domain on its own merits rather than force it into the
chat-capability pattern. Both verdicts are "stays a permanent page, no
generated card" — but for a stronger reason than network's (4g): neither
domain has _any_ natural single-sentence chat phrasing, not even a
partial one.

**Sync** (`useSyncState.ts`) is the offline mutation queue and IndexedDB
catch-up/realtime machinery — `replaySyncQueue`/`replaySyncQueueItem`
retry queued offline writes, `queueMutationAfterNetworkFailure` persists
a mutation locally when a write fails offline. Its only two owner-facing
actions are "replay the sync queue" and "replay one item" — both need a
`syncItemId` a chat message would never carry, and both already have
direct buttons on the permanent Sync page (`GrogoniApplication.tsx:1613`,
`:1624`, wired directly to the domain hook, not through the runtime-tool
system). No `RuntimeToolName`/`RuleIntent` was ever defined for sync, and
grepping every caller of `replaySyncQueue`/`queueMutationAfterNetworkFailure`
confirmed there is no fourth trigger mechanism hiding here the way
`isNetworkDiscoveryRequest` was hiding in the network domain (4g) — sync
really is only reachable from its own page today, which is correct given
what it does.

**Runtime** (`useRuntimeHistoryState.ts`) is session/turn browsing for
the AI runtime itself — `loadRuntimeSessions`, `loadRuntimeTurns`,
`createRuntimeHistorySession`, `restoreOrCreateRuntimeSession`. This is
the plumbing chat _runs on_, not a peer domain chat could invoke: asking
"show me my runtime sessions" through the chat runtime to browse the
chat runtime's own session history is circular in a way none of the
other nine domains audited so far are. No mutation exists to route
through the runtime-tool system in the first place — every function here
either reads (`loadRuntimeSessions`/`loadRuntimeTurns`) or manages the
runtime's own lifecycle (`createManagedRuntimeSession`/`ensureRuntimeSession`),
neither of which a merchant sentence would ever target.

**No bug found in either domain** (unlike 4g, which had one) — both
wiring paths from permanent-page button to REST endpoint were read in
full and found correct.

**Verdict**: no generated card, no new runtime tool, no code change, for
either domain. Both permanent pages stay exactly as important as they
are today.

## Compliance + Beta + Launch audit (Phase 4k — no card, no bug)

Confirms the prediction this document's own "When a permanent page is
still correct" section already made before this phase started: these
three domains are internal-operator/admin readiness dashboards, not
merchant-facing actions, and audited out that way.

`useReadinessState.ts` (all three domains share one hook, mirroring the
backend `domain-modularization-roadmap.md`'s own decision to keep them
together) exposes: security review, verification tier, tax config,
device trust, and account-deletion scheduling for **compliance**; access
status, feature-flag rollout, device tests, support tickets, and
telemetry for **beta**; launch status, rollout settings, checklist items,
and incidents for **launch**. Every one of these is an operator
configuring the _business's platform posture_ (is this shop verified,
is beta access paused, is launch frozen) — not an action a merchant
would ever phrase as a chat sentence the way "mark delivered" or "add
customer Mary" are. None of it maps to a `RuntimeToolName` a merchant's
free text could plausibly trigger, and no `RuleIntent` covers any of it
today. Grepped for a fourth trigger mechanism the way 4g found one for
network — none exists; every mutation here is only reachable from its
own permanent page.

**No bug found** — every load/save/update path was read in full and
correctly threads through to its REST endpoint and `loadReports`
follow-up refresh.

**Verdict**: no generated card, no new runtime tool, no code change, for
all three domains. All three permanent pages stay exactly as important
as they are today.

## Reports + Notifications chat navigation (Phase 4l — implemented)

Unlike sync/runtime (4i-4j) and compliance/beta/launch (4k), reports and
notifications turned out to be genuinely chat-relevant, not operator
dashboards — but the audit found the gap in an unexpected place.

**What the audit found:**

- Both domains were already advertised as reachable through chat:
  `createAgentHelpReply()` (`agent-command-engine.ts`) tells every
  merchant "I can open Products, Suppliers, Customers, Invoices,
  Payments, My Network, Purchase receipts, Reports, or Alerts" — and
  `resolveAgentHelpDestination` already maps `reports`/`notifications`
  aliases to their `ShellView`s. But that path only fires through the
  `extractAgentHelpCommand` prefix ("help me...", "can you help me...").
  A bare **"show reports"** — the exact phrasing `show_products`/
  `show_invoices` already support with no prefix required — fell through
  to `unknown` and got a generic clarification reply instead of
  navigating, even though the agent's own help text implies it should
  work.
- Confirmed this is a real, load-bearing precedent to extend, not a new
  pattern to invent: `show_products`/`show_invoices` are plain
  `RuleIntent`s in the shared `@grogoni/tool-core` parser (used by both the
  frontend's local fallback decision engine and the real backend
  `/runtime/turns` HTTP route, since it's the same package on both
  sides), mapping to a `type: "navigate"` next-action that short-circuits
  locally — no card, no draft, no confirmation.
- Both `reports.summary` and `notifications.list` needed real backend
  wiring, not just a frontend regex: the actual data (`getBusinessReport`,
  `NotificationsDomain.listNotifications`) already existed as working
  public store methods (same ones the permanent pages' REST routes call),
  simply never exposed through the runtime-tool system.
- **A second real bug, one layer deeper than expected**: after wiring the
  new tools with `requiresConfirmation: false` on their own registry
  definitions, "show reports" still came back `needs_confirmation`. Root
  cause was a _third_ place read-only tools must be listed: `services/api/src/cp2/agent-business-runtime.ts`'s
  `skillRequiresOwnerConfirmation()` is a hard-coded allowlist of tool
  names exempt from the default per-skill confirmation requirement —
  `products.list`/`invoices.list` were on it, the two new tools were not,
  so every default agent skill binding for them required explicit owner
  confirmation despite the tool definition itself saying otherwise. This
  is the same "forgot to add the new tool to an existing allowlist" bug
  class as every other phase's dropped-input bug, just one hop further
  from the parser than usual — found by running the real HTTP route
  end-to-end rather than trusting the registry definition alone, per the
  standing "verify the real path" discipline from Phase 4a.

**What was built:** `show_reports`/`show_notifications` `RuleIntent`s
(EN keywords/phrases mirroring `show_products`/`show_invoices` exactly),
`reports.summary`/`notifications.list` read-only `RuntimeToolName`s,
`"reports"`/`"notifications"` added to the navigate `view` union, backend
execution wired to the existing `getBusinessReport`/`listNotifications`
store methods, `skillRequiresOwnerConfirmation` extended, and the
frontend trigger (`useChatRuntimeState.ts`) loads the fresh data and
navigates as soon as either tool executes — identical shape to the
existing `products.list`/`invoices.list` triggers.

Regression tests: `tests/cp4-rule-parser.test.ts` (parser-level, verified
against real parser output first), `tests/cp10-grogoniclaw-runtime.test.ts`
(new end-to-end test proving both tools execute for real through the
HTTP route and return real report/notification data, not just a
clarification), `tests/reports-notifications-navigation.test.ts`
(frontend wiring — verified to fail without the frontend implementation).

## POS terminal chat module (Phase 4m — implemented)

The point-of-sale workflow is deliberately both a permanent seller module and a chat-invokable
module. A checkout needs a visual, multi-line cart, live stock limits, customer selection, tax,
and payment method confirmation; compressing those choices into a free-text mutation would make a
stock-and-money action unnecessarily ambiguous. The seller can open the same screen from the
Workspace “Make a Sale” card, the `/pos` route, ordinary help navigation, or the exact `#pos`
command in their agent conversation.

`#pos` is handled locally before inference routing, so opening the terminal neither consumes a
model call nor accidentally becomes a server tool mutation. The hashtag picker lists it next to
the registered API capabilities. The terminal itself does not introduce another sales store: it
creates a multi-line invoice through `POST /businesses/:id/invoices`, confirms that invoice through
`POST /businesses/:id/invoices/:invoiceId/confirm` (the canonical stock movement), and optionally
records full payment through `POST /businesses/:id/payments`. If payment recording fails after
confirmation, the UI preserves the confirmed invoice and directs the seller to Payments instead
of allowing the cart to be submitted twice.

Regression tests: `tests/chat-module-commands.test.ts` pins exact command matching and
`tests/pos-sale.test.ts` pins the invoice → confirmation → payment sequence, unpaid sales, and the
partial-success failure boundary.

## Architectural enforcement (Phase 5 — implemented)

The last item on the roadmap. With every `ShellView` now audited
(Phases 4a-4m), this phase makes that discipline permanent instead of
relying on the next person to remember to repeat it.

**Import-boundary guard**: `scripts/check-shellview-boundary.mjs`
(wired as `pnpm check:shellview-boundary`, and into the `ci` script)
parses the live `ShellView` union in `apps/web/src/app-shell.ts` and
fails the build if it contains a member not present in the script's own
`approvedShellViews` map — an inline audit trail naming which phase
approved each view and why (shell chrome, a chat-invokable capability
shipped alongside its permanent page, or an audited-and-kept permanent
page). Adding a new `ShellView` now requires deliberately editing this
script and, per its own failure message, writing the audit as a new
section in this document — the exact question this session asked by
hand for every one of the fifteen domain views ("could this be a chat
capability instead of a permanent page?") can no longer be silently
skipped by a future change.

**Registry-only regression coverage**: already existed going into this
phase — `tests/generated-surface-registry.test.ts` (shipped alongside
the original generated-surface protocol in Phases 1-3) asserts
`ChatSurface.tsx` dispatches through `renderGeneratedSurface` keyed by
`content.type` and never grew a per-card `if`/field check as new cards
landed in Phases 4a, 4b, 4c, 4d, 4e, 4f, and 4h — confirmed still true
and still passing after all twelve of those phases' generated-surface
cards shipped, with no changes needed this phase.

Regression tests: `tests/check-shellview-boundary.test.ts` (new — proves
the script passes against the real repository today, fails and names the
offending view when an undocumented `ShellView` is added to a fixture,
and passes when a fixture only uses an already-approved subset).

## Permanent tab bar removed (Phase 6 — implemented)

Phases 1-5 audited every domain view and, where warranted, gave it a
chat-invokable capability — but left `PrimaryNavigation.tsx`, a permanent
6-item nav (Home/Stock/Sales/Docs/Reports/Settings, a desktop side rail
that collapsed to a mobile bottom bar), rendered whenever
`business !== null && mode === "seller"`. That directly contradicted this
document's own opening decision — "Grogoni's permanent UI is reduced to
`GrogoniShell → SessionList → ConversationSession → Composer →
GeneratedSurface`" — even though every domain surface underneath it
already rendered as a `StackedModule` overlay
(`ChatSurface.tsx`'s `owner-management` module, fed
`renderOwnerWorkspace(...)` as `children`) rather than a routed page. The
tab bar, not the rendering mechanism, was the actual gap between the
implementation and the mockups' "nothing is a route" thesis.

Removing it required closing one gap first, since without the tab bar's
own visible active state the Workspace hub becomes the only way to reach
a domain view from the shell chrome:

- **Workspace hub coverage**: `ContextualBusinessCards.tsx` (the existing
  Workspace quick-access panel, itself already a `StackedModule`) covered
  10 of the 15 domain views. Added cards for the 7 it was missing
  (suppliers, sync, runtime, compliance, beta, launch, agent) so every
  destination the tab bar reached stays reachable.
- **Shop Hub (later)**: those hardcoded cards were replaced by the Shop Hub
  (`ShopHub.tsx`, "Go to my shop" at `/sell/shop`), rendered from
  `GET /businesses/:businessId/capabilities` - the canonical tool registry
  grouped into modules and filtered by role. `shop-hub-surfaces.ts` maps
  each module to the screens it opens, and
  `tests/workspace-hub-coverage.test.ts` still requires every navigable
  ShellView to appear there.

A second change was attempted and reverted: making `navigateToView`
(and `openProduct`/`openAgentProfile`) call `navigateToOwnerRoute`
unconditionally, so a domain module opened from in-app navigation (not
just at cold boot) would also push a real URL/history entry, letting the
browser back button close it. This directly contradicted an existing,
deliberately shipped certification in
`e2e/responsive-accessibility.spec.ts` — a test named "secondary modules
preserve the conversation URL and browser history" that asserts opening
_any_ `StackedModule` must never change the URL at all
(`expect(page).toHaveURL(/\/$/)` right after opening the "Account and
agent settings" module, plus an unchanged `history.length`). That
assertion is also embedded in the `openModelLibrary()` helper used by
~15 of the suite's other tests, so the conflict had broad blast radius.
This was caught only after the fact, since `pnpm test:ui-cert` (the
Playwright suite) is not part of `pnpm test` and wasn't run during this
phase's gate - a gap in this phase's own verification plan. Reverted
rather than overriding the existing certification unilaterally: domain
modules remain pure ephemeral React state (as before this phase), and
deep links into them only work at cold boot (typed/bookmarked/shared
URL), same as before this whole phase started. Making them properly
back-button-closeable is a real, separate follow-up that would need to
update the e2e certification deliberately, not as a side effect.

With the hub gap closed, `PrimaryNavigation.tsx` and its CSS were
deleted outright. The commerce object model from the sell/buy mockups
(`StatusBroadcastCard`, `StatusResultCard`, `UnifiedCartSummary`,
`FulfilmentSplitCard`, contact-ranked BUY search, non-select-all contact
picker, per-source fulfilment-handoff splitting) already matched the
mockups going into this phase and needed no change.

Regression tests: `tests/workspace-hub-coverage.test.ts` (new — fails if
a future `ShellView` isn't wired into the Workspace hub, extracting the
live `ShellView` union via the same `checkShellViewBoundary` helper
Phase 5 introduced); `tests/frontend-user-guidance.test.ts` (rewritten —
asserted against the now-deleted `PrimaryNavigation.tsx`; now asserts
the same destinations are reachable via the Workspace hub).
`tests/stacked-modules.test.ts` is unchanged from before this phase - its
"opens secondary surfaces without adding history" assertion turned out to
already be the correct, permanent invariant.

Note for `docs/architecture/frontend-modularization-roadmap.md`: its
Phase 1 table still lists `PrimaryNavigation.tsx` as one of the 8
components extracted in that effort — that record is accurate for its
own point in time and is left untouched; this section is the record of
its later removal.

## Customer home = conversation; shop icon = seller entry (Phase 7 — implemented)

Phase 6 removed the seller's permanent tab bar. This phase closes the
matching gap on the customer side: the customer-facing shell still
carried a permanent Buy/Sell mode toggle, an unconditional Messages
button, and unconditional header Sign up/Log in buttons — the exact
"top nav + big onboarding card" pattern this document's governing
principle rejects, just on the buyer's half of the shell instead of the
seller's. Two invariants now hold for the customer entry point,
enforced by `tests/grogoni-home-progressive-entry.test.ts`:

- **Customer home = conversation.** `/`, `/chat`, and `/marketplace`
  all resolve to the same route (`readOwnerRoute` in `routes.ts`) and
  render the same `mode: "marketplace"` chat shell — there is no
  separate customer landing page. The customer-facing header
  (`GrogoniApplication.tsx`'s `top-bar`/`shell-mode-bar`) carries only the
  `grogoni` wordmark, the hamburger menu, and the shop icon; the
  old Buy/Sell toggle, the unconditional Messages button, and the
  header Sign up/Log in buttons only render at all `mode === "seller"`
  now (message history for a customer lives in the hamburger menu
  instead). A first-time visitor gets one conversational welcome
  message (`createInitialChatMessages` in `app-shell.ts`; on the empty
  home it renders as the plain `home-welcome` heading, with no auth
  action) and three suggestion chips
  (`homeSuggestionPrompts` in `ChatSurface.tsx`) that commit a chat
  draft, not navigate to a page. Commerce results (product/shop/order
  cards) render as generated conversation surfaces via the same
  `renderGeneratedSurface` protocol Phases 1-4 established — this
  phase added no new card types, only removed the navigation chrome
  competing with them for the customer's attention.
- **Hamburger menu = sign-in entry.** The customer home's header has
  no auth buttons and its welcome has no auth action, so a signed-out
  visitor's always-available way to log in or sign up is the top of
  the hamburger menu (`MenuDrawer.tsx`, `signedOut` prop). The
  recognized-device pill adds a shortcut only for a device that
  remembers a past login. "Signed out" is `isSignedOut`
  in `GrogoniApplication.tsx`: no session, or only a device session
  (`identityLevel === "device"`); the auth screen gate uses it. The
  menu items and the seller-mode header buttons use
  `showsSignInEntry` (`isSignedOut && business === null`), and the
  recognized-device pill (`recognizedDeviceLabel`) carries the same
  `business === null` guard: a device
  account can own a shop, and a login would replace that account, so
  a shop owner upgrades by adding a PIN/passkey in account settings
  instead. `business` can briefly be a stale stored shop when the
  server cannot confirm ownership. The session-context load
  (`session-context-retry.ts`, driven from `GrogoniApplication.tsx`)
  retries on reconnect and when the app is shown again until one load
  for the current sign-in applies, then never re-runs. Only the
  sign-in's first load restores where the owner last worked; a retry
  applies data only (it forgets a stored shop the account does not
  belong to) and never moves the user, who may have navigated since.
  Joining a shop (`joinStaffShop`) ends retrying for that sign-in, so
  a retry never moves the user off the shop they just joined. While
  online, a device session returned by bootstrap,
  device recovery, or zero-form continue never dismisses an open
  login/signup screen (`dismissesAuthScreen` in `useAuthState.ts`);
  a real account identity or the visitor (Cancel / Browse as guest)
  does. Before that rule, a device-session visitor was bounced off
  `/login` straight back to chat. The offline-restore path still
  closes the screen, since login needs the network anyway, and so does
  device recovery under an account-deletion/restoration intent, whose
  panel renders only once the screen is closed. Covered by
  `tests/menu-drawer-auth-entry.test.tsx`,
  `tests/device-session-auth-screen.test.tsx`, and
  `e2e/menu-drawer-auth.spec.ts`.
- **Shop icon = seller/business entry point.** The single icon button
  at the top-right of the header (`shop-entry-button` when
  `business === null`, `agent-profile-link` once a shop exists) is the
  only way a customer reaches seller mode from shell chrome. It calls
  `switchMode("seller")`, which itself branches on identity
  (`useNavigationState.ts`): signed-out → opens the sign-up/login
  screen; signed-in without a shop → opens business setup; an existing
  seller → opens the agent/workspace surface directly. A returning
  seller who has navigated away from seller mode (e.g. into Browse) can
  also get back in via "Go to my shop" in the hamburger menu
  (`MenuDrawer.tsx`), since the shop icon itself only starts new shop
  setup for a business-less visitor rather than re-entering an existing
  one.

Progressive identity (guest search/browse without a signup wall,
identity requested only when an action needs it) predates this phase —
see `docs/authentication/progressive-identity.md` and the zero-form
entry tests in the same spec file — and was not re-litigated here.
Session/runtime restoration failure (`useAuthState.ts`'s
`ensureAuthenticatedSession`) already keeps the chat shell mounted on a
bootstrap failure and surfaces the failure as a small, dismissable
`app-action-notice` status line rather than a blocking screen; this
phase relied on that existing behavior rather than changing it.

## Chat gestures and guest chat (October 2026 journey fixes, implemented)

Found by driving the live app in a phone-sized browser. Every item has a gate test.
`pnpm eval:user-journey:local` / `:production` (`scripts/eval-user-journey.mjs`) scores them in a
real phone-sized browser with touch: the local run covers everything except the login Enter key
(gate test only); the production run covers what a guest can do without creating data.

**Swipes.** On the bare chat (no panel, no workspace, no open inbox on a phone), a one-finger
horizontal swipe navigates: **left opens the contact book** (`network`: phonebook contacts,
social connections, the contact directory), **right opens the shop**: the Shop Hub
(`/sell/shop`) for someone with a shop, the marketplace sheet of shops (the menu's "Browse")
for someone without; while the account's shops have not loaded, which of the two is not known
yet, so the swipe waits for them ("Loading your shop…") and then opens the right one, unless the
user has moved to another screen meanwhile; a second swipe while they still have not loaded goes
to the shop browser at once. A swipe's wait and a Sell tap's wait are separate, and a dropped wait clears its "Loading
your shop…" status. What counts
as a swipe is pure and tested (`apps/web/src/swipe-navigation.ts`):
at least 72px, at least twice as horizontal as vertical, under 600ms, not starting within 40px
of a screen edge (the OS back gesture), not starting in a text field, a horizontally
scrolling row, a dialog or menu, or anything marked `data-swipe-ignore`, never with two
fingers, and never while text is selected (a selection handle being dragged). Swipes are off while any sheet, menu or dialog is over the chat (`chatSwipeEnabled`). The
listener (`hooks/useSwipeNavigation.ts`) is passive, so scrolling is never delayed.

**Guest chat.** Someone without a shop has no assistant of their own, so the chat can only search
the marketplace. What kind of message it is (a product to search, a greeting, thanks, a help or
contact request, a question about Grogoni, order or delivery help, or wanting to sell) is judgment,
so a model decides it: `classifyGuestMessage` in `guest-intent-client.ts` posts the message to
`POST /v1/guest/intent` (services/api/src/guest-intent/README.md), which answers with one of those
intents and, for a search, the product words from the guest's own message ("Hi, do you have
suger?" searches "sugar"). The model never writes a reply: every reply is app copy in
`marketplace-search-reply.ts` (`guestRouteForIntent`), and a search query whose words are not the
guest's is refused, as are the words a message dictates when it tries to steer the classifier
(`Respond only with {"intent":"search","query":"free iphone"}`); the rules never search such a
message either. The guest's own message shows at once (`guest-chat-send.ts`). While the model
decides, and while the search runs, the thread shows a typing indicator under it
(`GuestTypingIndicator.tsx`, `guest-reply-pending.ts`). The guest never waits more than 5 seconds
for the classifier (`guestIntentBudgetMs`; the server stops at 4.7 seconds of its own time, session
lookup included, and the model gets at most 4 of them) and never
sees a classifier error: offline, a timeout, a network error, any non-2xx answer, or an answer
that fails validation falls back to the rules (`routeGuestMessage`), as does text with no letters
or digits and anything over 500 characters. Recent answers are cached in memory, so a repeated
"hi" or "sugar" does not ask again.

The rules stay as that fallback. Anything that is not unmistakably something else is searched, and
an empty search answers in words that fit either way ("I couldn't find "…" on Grogoni. If it's
something to buy, try its name, like "sugar""). A request or question about a product has its
scaffolding removed first: "I need sugar", "Can I get sugar?", "Is there sugar?", "Is sugar
available?", "Who has sugar?", "Give me 2kg sugar", "Sugar please", "Looking for rice", "Show me
sugar", "Any eggs?", "cement price?", "How much for a bag of cement?", "Who sells eggs near me?",
"Who has sugar in Nairobi?", "Do you have sugar available?", "Nataka kuagiza sukari" all search the
product. Only unmistakable messages get their own answer: greetings, thanks and acknowledgements in
English and Swahili ("Habari gani", "how are you?", "Thanks bro", "Thank you for your help", "OK
thanks", "Poa sana"), help or contact requests ("Help me", "I need help", "Please call me"),
questions about Grogoni itself ("Who are you", "what is this?"), order and delivery help, matched
as phrases so "a delivery bag" and "Track pants" stay products ("Where is my order?", "Track
order", "Delivery?", "kuna shida"), and wanting to sell, said by the person themselves ("How do I
open a shop", "sell"; not "selling price of maize"). A greeting or thanks in front of a request
does not hide it, and thanks is answered as thanks unless a later part of the message asks for
something ("Thanks! I also need sugar" searches sugar). Emoji and other text with nothing to look
for get the short explanation. The rules misread typos, most Swahili beyond the common phrases, and
long mixed messages; on the eval's labeled set they reach 0.87 intent accuracy and search 14
messages that are not products, which is why the model decides when it can.

A chat search made while another search is running runs on its own. A conversation with a person
or a connected channel is never intercepted, and its messages never reach the classifier: the
message goes to them.

**Device-only messages.** The search exchange, and a message waiting in the outbox, exist only on
this device (`ChatMessage.deviceOnlyIn`, `chat-device-only-messages.ts`). They are kept per
account and merged into every refresh of the conversation they belong to, so the 4-second
refresh, a trip to another thread, or a reload does not lose them. A search exchange expires
after a day; a queued message stays while the outbox holds it. Only text and attachment names
are stored, never attachment data. An end-to-end encrypted message's text is never written to
storage (the outbox holds only its ciphertext): it is kept in the page's memory, so a thread
switch keeps it, and after a reload the thread shows "Encrypted message waiting to send" in its
place, so the waiting count always matches something visible (a plain message whose copy was
lost shows its text from the outbox). When storage is full, the oldest search exchanges go first;
a message waiting in the outbox is never pushed out. Clearing the outbox on
sign-out or reset clears all of these. Each message is placed right after the message it followed
when it was created (`deviceOnlyAfter`, the last message the server has), never by comparing the
phone's clock with the server's; a message waiting in the outbox shows at the end, in the order
it was typed, because the server will place it there when it is sent.
If the user switches thread while a search runs, the exchange waits for its own thread instead of
flashing into the new one. A queued message is dropped once the server has it (matched by its
client message id). Device-only messages offer no server actions (delivery attempts, edit,
delete) and are never part of the history sent to a model (`inferenceHistory`).

**Sending state.** The thread header's resend control appears only while the open conversation has
messages in the outbox ("Send 2 waiting messages"); it used to say "Retry failed" on every
thread. A message keeps the order it was typed in: while an earlier message in the same
conversation is waiting, a new one is not sent past it but queued behind it ("Waiting to send"),
so the conversation, and anything an agent does with it, runs in order. A send that fails with a
retryable error stays in the thread, marked in the sell color with what will happen: "Not sent yet
· retrying" while the outbox resends it on its own, and "Not sent · tap Send waiting at the top to
retry" once those resends are used up (`message-delivery-label.ts`). The outbox resends each
message on its own backoff of 15 seconds, 1 minute and 4 minutes, then stops (a message to an
agent reruns a paid model turn each time); this includes a message that was saved but whose agent
turn failed. A message that stopped holds back only later messages in its own conversation. A
reconnect skips the wait but not the three-try cap. A tap on the resend control sends at once, or
says why it cannot ("Already sending your waiting messages", or another tab is sending them). A Web Lock keeps two tabs from resending the same queue at once, where the browser has Web Locks; queueing and removing an entry are separate localStorage writes and are not locked across tabs. A message the server refuses for good leaves
the queue: its text goes back into the message box when that is clean (its thread is open, the box
is empty, nothing attached), and otherwise it stays in the thread marked "Not sent", where it can
still be read. A resend that finishes after the user opened another thread changes nothing on
screen; that thread's own refresh shows the result. Before, only the browser's `online` event
resent a message, so an online user waited forever. A message sent within the composer's 120 ms
draft sync now always leaves the box empty. Right after a load, while the conversation in
the URL is still being opened, the composer says "Opening this chat…" and holds Send; a message
sent at that moment opens that conversation and goes there, and if it cannot be opened the text
goes back into the box instead of vanishing. A send's own success clears the box only if it still
holds what was sent, so text typed while a send waited is kept. The read marker is skipped while this tab's own send
is running: on the server its agent turn holds the account's write lock, which the marker would
wait behind.

**Shop setup.** A failed launch load used to leave an owner's device thinking it had no shop. The
retry now adopts the account's shop when the device has none (data only, no navigation). A Sell
tap made while the shops are loading finishes when the load does: it opens the shop, or setup if
the account really has none. The waiting tap belongs to the account that made it, lapses after a
minute, and is dropped if the user switches mode meanwhile, so a late load never moves a user who
has moved on (restoring the account's last place on a cold load changes the route on its own and
does not cancel it). A second tap while the shops still have not loaded goes on to
setup, so a failing load never traps anyone, and if a create answers `409
store_already_registered` the app opens the shop the account owns (or says so plainly when the
shop list cannot load either).

**Login.** The credential step is a form, so Enter in the phone, PIN, or password field submits.

## Target architecture

```text
                    GROGONI SHELL
                        │
              ┌─────────┴─────────┐
              │                   │
          Sessions            New Session
              │
              ▼
      Conversation Session
              │
       ┌──────┴──────┐
       │             │
      BUY           SELL
       │             │
       └──────┬──────┘
              │
           Agent
              │
        Tool / capability calls
              │
              ▼
       Generated Surfaces
              │
    ┌─────────┼──────────┐
  Search     Cards      Domain view
  results   /status    (products, invoices, ...)
```

`GrogoniShell → SessionList → ConversationSession → Composer → GeneratedSurface`
are the only permanent frontend concepts. Catalogue, orders, checkout,
status, product management, search results, and the other 15 business
views do not get top-level navigation because implementing them as
conventional pages was easier — that is exactly the shortcut the mockups'
own design notes reject.

### When a permanent page is still correct

Not never. A view stays a permanent, directly-navigable page when:

- it is a settings/identity/security surface with no natural conversation
  phrasing (device sessions, passkeys, MFA, business compliance
  paperwork) — `IdentitySecurityPanel`/`ComplianceSurface` are candidates
  to remain reachable from a menu rather than forced into a chat turn;
- it is accessed far more often via deep link/notification than via a
  fresh conversation (e.g. opening a specific invoice from a payment
  reminder push);
- forcing it through conversation would require inventing a fake natural-
  language phrasing for something that is inherently a form review, not a
  request (bulk CSV import row correction is a plausible example).

Each of the 15 views gets this judgment call made explicitly during its
own migration phase (below), not decided in bulk here. Default assumption
going in: it becomes a generated surface unless a phase's own audit finds
a concrete reason it shouldn't.

## The generated-surface protocol (Phase 1 — implemented)

`ConversationMessageContent` (wire, already correct) is now carried
through to the frontend without flattening. `ChatMessage.content?:
ConversationMessageContent` replaces the five ad hoc optional fields
(`businessCards`, `productCaptureJobId`, `statusBroadcastId`,
`unifiedCheckoutId`, `confirmationToken` stays separate since it is read
independently of card rendering for the confirm-action flow).

`apps/web/src/generated-surface-registry.tsx` is the renderer registry:

```ts
type GeneratedSurfaceRenderer = (props: {
  content: ConversationMessageContent;
  businessId: string | null;
}) => ReactNode | null;

const generatedSurfaceRegistry: Partial<
  Record<ConversationMessageContent["type"], GeneratedSurfaceRenderer>
> = {
  "product-capture-progress": (...) => <ProductCaptureItemsCard ... />,
  "status-broadcast": (...) => <StatusBroadcastCard ... />,
  "unified-checkout": (...) => <FulfilmentSplitCard ... />,
  "owner-controls": (...) => <AccountBackendControls ... />
};

export function renderGeneratedSurface(...): ReactNode | null {
  const renderer = generatedSurfaceRegistry[content.type];
  return renderer === undefined ? null : renderer({ content, businessId });
}
```

An unrecognized `content.type` (a future server addition the client
hasn't shipped a renderer for yet) returns `null` and the message still
renders its `body` text — it degrades safely instead of crashing the
thread. This is the exact behavior required by "unknown surface types
must degrade safely."

Adding a new capability's generated card going forward is: add the
variant to `ConversationMessageContent`, add one registry entry. It does
not require touching `ChatSurface.tsx`'s render body again.

## Roadmap

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1     | Generated-surface protocol: typed content carried through, renderer registry, safe unknown-type fallback                                                                                                                                                                                                                                                                                                                                | **Implemented** (this change)                                                       |
| 2     | Session-list-as-home foundation: audit every `GrogoniSessionContext`/`context.mode` read site; design the per-conversation mode + multi-session data model change; land it behind the existing conversation/session infrastructure without changing today's single-session behavior yet                                                                                                                                                 | **Implemented** (this change) — see "Per-conversation session context" above        |
| 3     | Multi-session UI: session list becomes the home screen (`ConversationInboxItem` already has the shape - title/preview/time/unread); `New session` creates a real personal agent conversation; Buy/Sell toggle persists per-session using Phase 2's data model                                                                                                                                                                           | **Implemented** (this change) — see "Multi-session UI" above                        |
| 4a    | Products: give the domain a chat-invokable capability/tool that renders inline in a session (found to need fixing two runtime-tool execution stubs, adding two new parser intents to both the primary and context-script parsers, and a currency/quantity parsing bug - not a small phase). Permanent `products` nav entry kept until a generated-surface replacement can be proven live in a browser                                   | **Implemented** (this change) — see "Products chat-invokable capability" above      |
| 4b    | Suppliers: same pattern as 4a (found zero existing supplier runtime tools, and a product-vocabulary false-positive that would have silently misrouted supplier edits as product edits)                                                                                                                                                                                                                                                  | **Implemented** (this change) — see "Suppliers chat-invokable capability" above     |
| 4c    | Customers: same pattern as 4a/4b (customer.create already existed but dropped phone/email/notes; added customer.update; extended 4b's product-vocabulary exclusion guard rather than duplicating it)                                                                                                                                                                                                                                    | **Implemented** (this change) — see "Customers chat-invokable capability" above     |
| 4d    | Invoices: found a materially harder problem than 4a-4c (product+quantity+price can't be reliably extracted from free text for a record that moves stock and money) - scoped to an interactive single-item composer card triggered by the existing create_invoice classification, no backend changes needed                                                                                                                              | **Implemented** (this change) — see "Invoices chat-invokable capability" above      |
| 4e    | Payments: same "composer card, no backend change" shape as 4d - `payment.record` has always been hard-coded invalid for the same reason (can't pick which of several open invoices from free text)                                                                                                                                                                                                                                      | **Implemented** (this change) — see "Payments chat-invokable capability" above      |
| 4f    | Imports: found the domain was already mostly chat-capable - `document_import.confirm` already resolves and executes for real from chat via a third, separate proposal path (`createRuntimeDocumentImportProposal`); the one gap was inline row review before confirming                                                                                                                                                                 | **Implemented** (this change) — see "Imports chat-invokable capability" above       |
| 4g    | Network: `network.route` now owns chat-driven network discovery through the canonical runtime; browser-grant workflows remain on the permanent page.                                                                                                                                                                                                                                                                                    | **Implemented** — see "Network capability" above                                    |
| 4h    | Logistics: judged genuinely chat-relevant (unlike 4g) - "mark delivered"/"picked up" are natural merchant sentences and the backend mutation already existed, just never wired into the runtime-tool system. Same "composer card, no backend mutation change" shape as 4d/4e                                                                                                                                                            | **Implemented** (this change) — see "Logistics chat-invokable capability" above     |
| 4i    | Sync: audited honestly - offline mutation queue/IndexedDB machinery with no natural chat phrasing (both actions need a `syncItemId` chat can't carry) and already only reachable from its own page. No fourth trigger mechanism found hiding here (unlike 4g's network). No card, no bug                                                                                                                                                | **Implemented** (this change) — see "Sync + Runtime audit" above                    |
| 4j    | Runtime: audited honestly - session/turn browsing for the AI runtime itself, the plumbing chat runs on rather than a peer domain chat could invoke. No mutation exists to route through the runtime-tool system. No card, no bug                                                                                                                                                                                                        | **Implemented** (this change) — see "Sync + Runtime audit" above                    |
| 4k    | Compliance + Beta + Launch: audited together (one hook, `useReadinessState.ts`, mirrors the backend's own combined-phase decision) - confirmed the doc's own prediction that these are internal-operator platform-posture dashboards, not merchant-facing actions. No card, no bug                                                                                                                                                      | **Implemented** (this change) — see "Compliance + Beta + Launch audit" above        |
| 4l    | Reports + Notifications: audited together - both already advertised as chat-reachable via the help-prefixed path, but the bare `show_products`/`show_invoices`-style phrasing didn't work. Built the missing `show_reports`/`show_notifications` navigate intents, wired to the existing `getBusinessReport`/`listNotifications` store methods, and fixed a second confirmation-allowlist bug found only by testing the real HTTP route | **Implemented** (this change) — see "Reports + Notifications chat navigation" above |
| 5     | Architectural enforcement: import-boundary guard preventing a new permanent `ShellView` from being added without an explicit documented exception; regression tests asserting the generated-surface registry, not a growing if-chain, is the only way `ChatSurface.tsx` picks a card component                                                                                                                                          | **Implemented** (this change) — see "Architectural enforcement" above               |
| 6     | Permanent tab bar removed: filled the Workspace hub's 7 missing domain cards, then deleted `PrimaryNavigation.tsx` and its CSS - the sessions list is now the only fixed shell nav, matching this document's original decision statement. A URL/deep-link sync attempt was reverted after it broke an existing e2e certification; domain modules remain cold-boot-only deep links, unchanged from before this phase                     | **Implemented** (this change) — see "Permanent tab bar removed" above               |

Legacy pages are removed only after their generated-surface replacement
is proven working — never a big-bang cutover. A catalogue page may
disappear while catalogue APIs and their domain hook remain untouched; an
orders page may disappear while order state remains essential. The
distinction is which layer serves conversation vs. permanent navigation,
not whether the underlying capability exists.

## Non-goals (carried forward from the original decomposition discipline)

Do not: create microservices; introduce a second agent runtime, MCP
implementation, or context runtime; inject model-generated HTML or
execute model-generated code; fabricate marketplace connector results;
fabricate contacts access; fabricate payment/settlement success for an
unsupported path; auto-publish AI-extracted listings without seller
confirmation; move business authorization to the client; remove a
permanent view before its generated-surface replacement exists and is
tested.
