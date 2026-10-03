# Platform-agnostic chat commerce audit

Audit date: 2026-08-08  
Remediation verified: 2026-08-09

## Decision

**NOT_READY**

This was the pre-implementation decision that constrained the first change to safe catalogue
prerequisites. It is retained as the audit trail rather than rewritten after the fact.

## Post-remediation decision

**READY_WITH_SMALL_GAPS**

The five repository blockers found by this audit are now closed:

- public storefront sessions create a business-scoped external platform identity, canonical
  storefront conversation/channel, and a hashed, expiring customer capability;
- public customer and agent messages persist in `conversation_messages`, write delivery attempts,
  sync to canonical participants, and support structured canonical product-card content;
- public orders create a canonical draft invoice and return the existing invoice payment summary;
- public catalogue projections and cards include authoritative selling price and a canonical media
  URL when a seller has published product media;
- camera capture now has persisted extraction, review, retry, manual fallback, cancellation,
  cleanup, confirmation, and publication states; publication alone creates/updates the product;
- provider-neutral platform identities, conversation channels, external participants, durable
  update receipts, inbound normalization, and outbound delivery state are persisted by migration 049.

The remaining small gaps are transport-specific: there is no Telegram webhook/secret verifier,
deep-link grant flow, Telegram renderer/sender, or live bot validation. Those gaps belong to the
Telegram adapter phase; native commerce and camera publication do not depend on Telegram
configuration.

Grogoni has strong canonical product, business, authorization, agent-runtime, MCP, conversation,
receipt-OCR, and storefront foundations. The full channel rollout is not safe yet because the
customer-facing storefront message and order paths are parallel JSON-record collections rather
than the canonical `conversations` / `conversation_messages` and invoice/payment paths.
`attemptPublicAgentReply` deliberately exposes no tools, while the authenticated runtime requires
a business member. Connecting Telegram to either path today would therefore create a second
customer commerce runtime or grant an external customer merchant privileges.

The safe implementation scope for this change is the prerequisite catalogue read path:

1. extend the existing low-risk `products.list` runtime tool into a tenant-scoped lexical query;
2. return canonical product identifiers and authoritative selling price/availability;
3. expose the same query through the authenticated, shop-bound MCP gateway;
4. preserve an explicit zero-result response and add isolation/fidelity tests;
5. document the prerequisite work required before camera publication and Telegram can ship.

No Telegram webhook, provider identity, channel mapping, or camera publication state is added while
the canonical customer runtime boundary remains unresolved.

## Audit-driven implementation result

The safe prerequisite was implemented after this audit:

- canonical products now accept normalized, bounded seller-managed aliases;
- the existing `products.list` runtime action performs an authorized query when `query` is present
  and preserves its backward-compatible list result when absent;
- query results expose canonical product ID, business ID, name, unit, selling price, availability,
  and the current null image placeholder without exposing buying cost or raw stock quantity;
- zero results are explicit in both structured output and runtime response;
- authenticated MCP clients can call `grogoni.query_catalogue`; scope, session, membership, and
  shop-token binding are enforced before the catalogue service runs;
- product selection tests pass the returned canonical ID into the existing storefront order
  request flow.

Stages 4 through 6 remain gated by the blockers below. This follows the PRD rule for `NOT_READY`
repositories and avoids treating incomplete public-message/order collections as a new channel
commerce system.

## Baseline capability matrix (before remediation)

Status meanings are those requested by the platform-agnostic chat-commerce PRD.

| Capability                        | Status      | Repository evidence and assessment                                                                                                                                                                              |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical product/catalogue model | PRESENT     | `ProductSummary`, `products`, and `Cp2Store.products` are used by seller CRUD, storefront, imports, inventory, invoices, and runtime tools.                                                                     |
| Catalogue read service            | PRESENT     | `listProducts` remains canonical; `queryCatalogue` returns a public-safe structured projection after server-side authorization.                                                                                 |
| Existing product search           | PRESENT     | `products.list` supports exact name/SKU, explicit alias, token, containment, and bounded edit-similarity matching. Migration 048 adds aliases and a business/name index; no vectors are used.                   |
| Product-card rendering            | PARTIAL     | Storefront tiles/cards exist, retain product ID, unit, and availability, but the public DTO omits selling price and image. Canonical conversation content has no product-card variant.                          |
| Agent runtime                     | PRESENT     | `createRuntimeTurn`, typed proposals, verification, context retrieval, model routing, telemetry, and confirmation are implemented.                                                                              |
| Agent-business-runtime            | PRESENT     | Versioned business profile, context, permissions, skills, instructions, and audience filtering are implemented.                                                                                                 |
| MCP tool registration             | PRESENT     | `/mcp` supports initialization, tool discovery, calls, sessions, and structured results.                                                                                                                        |
| MCP authorization/risk tiers      | PRESENT     | Hashed access tokens, scopes, optional shop binding, role permissions, risk definitions, confirmation, origin checking, and rate limiting are present.                                                          |
| Conversation model                | PRESENT     | Canonical conversations support personal/storefront/order kinds and an active shop.                                                                                                                             |
| Conversation participants         | PARTIAL     | Account, shop, and agent participants exist. There is no external-provider participant/reference and a conversation requires a canonical account owner.                                                         |
| Message persistence               | PRESENT     | Canonical messages include idempotency, delivery state, provider metadata, reply/forward references, and sync.                                                                                                  |
| Unified inbox                     | PARTIAL     | Canonical conversation inbox and realtime sync exist, but public storefront messages are stored in `cp2_public_storefront_messages` and listed separately.                                                      |
| Order creation                    | CONFLICTING | Storefront `PublicOrderSummary` requests use canonical product IDs and validate tenant/stock, but they are stored separately from invoices and do not enter invoice/payment state.                              |
| Existing checkout/payment flow    | PARTIAL     | Cart/order-request UI, invoices, manual payment recording, inventory movement, and payment summaries exist. There is no single customer checkout-to-payment orchestration to reuse for Telegram.                |
| Receipt OCR state machine         | PARTIAL     | The type declares the requested granular lifecycle, but the implementation usually jumps directly to `MATCHING`, `REVIEW_REQUIRED`, `FAILED`, or `COMPLETED`.                                                   |
| OCR retry/failure handling        | PARTIAL     | Worker HTTP retries, timeout, fallback engine, failure codes, manual correction, and a persisted cancel transition exist. No persisted retry transition API exists.                                             |
| Image upload lifecycle            | PARTIAL     | Shared binary validation/scanning and optional object storage exist. Receipt processing is privacy-first and non-retaining; there is no general media record/lifecycle.                                         |
| Product image storage             | MISSING     | Products have no canonical image/media field or product-media table. Storefront product cards have no image.                                                                                                    |
| Business tenancy                  | PRESENT     | Products, invoices, payments, OCR jobs, runtime state, and public requests carry business scope; service methods enforce membership/permissions.                                                                |
| External handoff                  | PRESENT     | Share sheet and SMS composer handoff are implemented and explicitly non-authoritative.                                                                                                                          |
| External identities               | CONFLICTING | `ExternalIdentitySummary` exists for an owner-scoped social-network graph, not provider participants. `connected_channels` exists only in an old migration and is absent from the current Drizzle schema/store. |
| Channel/provider abstractions     | UNUSED      | `MessageChannel` includes Telegram and provider delivery metadata exists, but message creation rejects every selected channel except `grogoni`; no transport interface routes inbound/outbound messages.           |
| Webhook infrastructure            | PARTIAL     | Signed outbound/integration patterns and Fastify routes exist, but there is no general inbound provider webhook registry.                                                                                       |
| Idempotency infrastructure        | PRESENT     | Canonical messages enforce conversation/client and conversation/idempotency uniqueness; sync and signed uploads also use idempotency keys. There is no provider-update uniqueness boundary.                     |
| Realtime inbox updates            | PRESENT     | Conversation/message sync journals, WebSocket notification, unread state, and realtime client support exist.                                                                                                    |
| Logging/observability             | PARTIAL     | Fastify structured logging, audit events, runtime telemetry, delivery attempts, and health checks exist. Provider-specific events do not exist.                                                                 |

## Baseline canonical sources of truth (before remediation)

| Domain                 | Canonical source                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products               | `ProductSummary`; `Cp2Store.products`; relational `products`; normalized `cp2_products` snapshot collection                                                                         |
| Inventory/availability | `ProductSummary.quantity` plus `inventory_movements`; availability is `quantity > 0`                                                                                                |
| Prices                 | `ProductSummary.buyingPrice` and `sellingPrice`; public commerce must use `sellingPrice` only                                                                                       |
| Businesses             | `BusinessSummary`; `businesses`; `Cp2Store.businesses`                                                                                                                              |
| Accounts               | `AccountSummary`; `accounts`; phone-first account identities and sessions                                                                                                           |
| Business memberships   | `MembershipSummary`; `business_memberships`; `requireAuthorizedSession` / role permission map                                                                                       |
| Conversations          | `ConversationSummary`; `conversations`; `Cp2Store.conversations`                                                                                                                    |
| Messages               | `ConversationMessageSummary`; `conversation_messages`; canonical idempotency maps and delivery attempts                                                                             |
| Orders                 | Customer order requests: `PublicOrderSummary` / `cp2_public_orders`. Merchant accounting order facts: confirmed `InvoiceSummary` and `InvoiceItemSummary`. This split is a blocker. |
| Payments               | `PaymentSummary`; `payments`; payment recording is tied to an invoice                                                                                                               |
| OCR jobs               | `ReceiptOCRJobSummary`; `receipt_ocr_jobs`; `Cp2Store.receiptOCRJobs`                                                                                                               |
| Media                  | No canonical media entity. Binary upload processing delegates to scanner/object storage and returns a storage key; receipt input is not retained.                                   |
| Authorization          | Session/PIN verification, `businessMemberships`, role-to-permission checks, MCP scopes/shop binding, runtime skill and confirmation policy                                          |

The PostgreSQL adapter persists both relational tables and normalized JSON record collections. New
features must account for both boundaries rather than changing only the Drizzle declaration or only
the in-memory snapshot.

## Existing flows

### Chat message to agent

Authenticated Grogoni agent chat calls `createAgentConversationMessage`. It first persists a canonical
user message through `createConversationMessage`, builds canonical history, calls
`createRuntimeTurn`, then persists the agent response as a canonical message. Direct human chats are
excluded from agent processing. A storefront visitor uses `createPublicStorefrontMessage`, which
writes a different collection and calls `attemptPublicAgentReply`.

### Agent to MCP/tool invocation

The in-process agent runtime parses or asks a configured model for a typed `RuntimeToolProposal`,
validates it against `runtimeToolRegistry`, business policy, role permissions, rate limits, and
confirmation rules, then calls `executeRuntimeAction`. It does not make an HTTP MCP round trip.
External MCP clients call `grogoni.runtime_turn`, which enters that same runtime.

### MCP to business service

The MCP bearer token resolves an authenticated session and optional shop binding. `requiredShop`
rejects a model/client-supplied shop that differs from the token binding. Runtime execution then
calls the same `Cp2Store` service methods used by HTTP routes.

### Product rendering

The storefront derives `PublicStorefrontProductSummary` from canonical products and renders tiles
and a product detail card in `GrogoniApplication.tsx`. The current public projection exposes ID, name,
unit, and boolean availability, not price or image. Runtime tool results are rendered primarily as
text/navigation state, not canonical conversation product-card content.

### Product to order

The storefront cart retains canonical product IDs. `createPublicOrder` resolves each ID within the
storefront's business and revalidates positive stock and quantity. It creates a request record; it
does not create an invoice, reserve/decrement stock, or initiate payment.

### Order to payment

Invoices are created/confirmed in the merchant business core. Payments are manually recorded
against an existing invoice. There is no current automated public-order-to-invoice/payment handoff.

### Image upload to OCR

The receipt route authorizes `import:write`, validates MIME/size/signature, optionally scans the
binary, calls the bounded OCR worker, schema-validates extraction, parses fields and matches
contacts, then creates a reviewable receipt OCR job. The worker removes temporary files and the API
does not retain the original by default.

### OCR to review to confirmed data

`createReceiptOCRJob` retains blocks, confidence, evidence, structured extraction, candidates, and
failure guidance. `confirmReceiptOCRJob` requires an authorized seller, resolves/creates the
supplier and optional sales agent, creates the canonical purchase receipt/line items, and marks the
job complete. The code enforces the write boundary, although not every declared intermediate state
is persisted.

### Conversation to inbox

Canonical messages update conversation timestamps, write participant-scoped sync changes, enqueue
notifications, and appear through the unified conversation inbox. Public storefront message
records bypass that flow and have a separate seller endpoint/view.

## Architectural conflicts and blockers found (resolved by remediation)

1. **Customer runtime authorization:** `createRuntimeTurn` requires a business membership. The only
   unauthenticated customer agent path advertises no tools. A safe customer capability principal is
   required before catalogue/order tools can be used from native storefront or Telegram.
2. **Parallel customer messages:** public storefront messages do not become canonical messages, so
   routing Telegram there would violate the one-conversation-runtime invariant and unified inbox.
3. **Parallel order facts:** public order requests do not enter invoice/payment orchestration. There
   is no existing checkout/payment handoff for a channel adapter to reuse.
4. **External participant shape:** the existing external identity is owner-network data, not a
   global/provider identity that may participate without a Grogoni account. Reusing it would conflate
   relationship discovery with authentication.
5. **Channel migration drift:** `connected_channels` is present in migration 015 but absent from the
   current Drizzle schema, store snapshot, routes, and authorization model.
6. **Product media:** no canonical product-media lifecycle exists. Camera uploads cannot safely be
   promoted to permanent product images.
7. **Camera state execution:** receipt OCR supplies useful extraction/provenance primitives, but
   persisted retry/cancel states and a product extraction contract/provider do not yet exist.
8. **Production durability:** provider update deduplication must be a database uniqueness boundary;
   process-local maps are insufficient across API instances or restarts.

## Implementation plan mapped to the repository

### Safe prerequisite delivered in this change

- Extend the existing `products.list` tool rather than add a duplicate `catalogue.query` runtime
  action.
- Add optional lexical `query` input and canonical structured product projections.
- Keep authorization in `requireAuthorizedSession` and MCP shop binding, never in model-supplied
  input.
- Match only products from the resolved business and never infer price, stock, or substitutes.
- Add a direct MCP catalogue-query façade only if it delegates to the same store method.

### Required follow-up before Phase 1 customer launch

- Introduce a server-issued customer capability/principal bound to a business and conversation.
- Move native storefront messages into canonical conversations and use one customer-safe agent
  runtime with a small allowlist (`products.list`, order handoff only).
- Add a canonical structured product-card message content variant and reuse it in web/provider
  renderers.
- Define the authoritative public-order-to-existing-invoice/payment transition, including
  inventory validation and idempotency.

### Required follow-up before Phase 1B

- Add a product-extraction job contract that reuses `BinaryUploadPipeline`, OCR worker limits,
  provenance/evidence, retry semantics, and cleanup policy.
- Add canonical optional product description/category/aliases and a product-media entity or an
  existing-equivalent storage contract.
- Enforce `REVIEW_REQUIRED -> CONFIRMED -> PUBLISHED` in the service and database; only publication
  may call canonical product create/update.

### Required follow-up before Phase 2 and Telegram

- Extend canonical participants with a distinct platform identity reference; do not modify
  `account_identities` during `/start`.
- Add canonical `conversation_channels`, `platform_identities`, deep-link grants, and provider
  update receipts with business-scoped unique constraints.
- Normalize Telegram updates into canonical messages and invoke the same customer runtime used by
  native storefront chat.
- Route canonical outbound messages through a provider registry and delivery attempts; inbox UI
  remains provider-neutral.
- Add secret-token verification, shared-bot deep-link grants, revocation/expiry, retries, structured
  logging, and production fail-closed configuration without making Telegram startup mandatory.

## Deployment/runtime blocker status

The repository has scripts for lint, typecheck, test, build, production-import checks, render
inference-boundary checks, schema verification, and runtime verification. Telegram configuration is
absent and therefore cannot be live-tested. Receipt OCR is optional locally and requires the OCR
worker plus scanner/storage policy in deployment. A real Telegram E2E claim is not possible in this
change.
