# Multiplayer Commerce Audit

Date: 2026-09-21

## Existing-System Inventory

- Identity and auth live in `services/api/src/cp2/store.ts`, backed by normalized `cp2_accounts`, `cp2_users`, sessions, PIN/passkey/social auth, MFA, device bootstrap, and retention tables.
- Business identity already has stable canonical IDs in `BusinessSummary.id` and persisted `cp2_businesses`. Public storefront identity is `BusinessSummary.grogoniId`, generated and renamed through `createGlobalShopId`, `renameGrogoniId`, `resolveBusinessByGrogoniId`, and `cp2_grogoni_id_history`.
- Unified chat exists through `conversations`, `conversation_participants`, `conversation_messages`, `grogoni_session_contexts`, and normalized `cp2_conversations` collections. Public storefront sessions, provider channels, managed attachments, delivery state, typing, recycle bin, and sync support reuse this model.
- Conversation participants already support `account`, `shop`, `agent`, and `external`, including external platform identities from Telegram, native SMS, email, and other channel providers.
- Catalogue, products, customers, invoices, payments, logistics, suppliers, purchase records, status broadcasts, and checkout are implemented as CP2 domains under `services/api/src/cp2/domains`.
- Agent/runtime infrastructure already separates agent profiles, model catalog, model templates, native runtime bindings, runtime handoff, MCP token principals, context sources, evaluation events, and runtime transfers.
- MCP/business API authorization is server-side via session, membership, capability token, MCP principal, and domain route checks. Public storefront messages use scoped capability tokens and runtime turns with view-only context.
- Real-time/offline foundations exist through account sync collections, push subscriptions, service worker tests, offline runtime snapshots, message delivery attempts, provider receipts, and sync queue records.
- Frontend surfaces are in `apps/web/src`, with existing PWA, routing, marketplace/seller modes, session-list, storefront, catalogue, and owner panels.

## Implemented In This Pass

- Added email-like commerce addresses derived from the existing storefront handle, for example `mama-mboga@grogoni.com`.
- Added `resolveCommerceIdentity(address)` on the CP2 store. It returns public identity information only: canonical business ID, display name, current commerce address, storefront entry points, catalogue capability, supported interaction types, and availability.
- Added public endpoints:
  - `GET /public/commerce-identities/availability?address=...`
  - `GET /public/commerce-identities/:address`
- Reused `resolveBusinessByGrogoniId` and `cp2_grogoni_id_history`, so retired commerce addresses resolve as stale and redirect to the current address without becoming foreign keys.
- Added shared types for public commerce identity resolution and availability.

## Gaps

- Conversation membership lacks explicit admin/member status fields beyond participant records and per-account UX state. The schema can support this additively in `ConversationParticipantSummary` and `cp2_conversation_participants`.
- Invitation/removal workflows are not yet complete as first-class routes for inviting another authenticated human into an existing shop conversation.
- Message visibility is global per conversation today; per-participant visibility or private agent/tool scratch messages require a new visibility policy field.
- Transaction references exist through invoices, payments, public orders, buy orders, and status orders, but conversations do not yet expose a unified `commerceReferences` projection.
- Agent participation is persisted, but per-agent authorization scopes in a multiplayer conversation need to be made explicit before allowing autonomous commerce mutations.
- Frontend discovery for `address@grogoni.com` is not yet wired into the chat composer or marketplace search box.

## Migration Risks

- Do not use commerce addresses as foreign keys. They are aliases over the canonical business ID and may change.
- `grogoniId` history is intentionally reusable after cooldown. Any long-lived redirect or audit workflow must store business ID plus historical address, not just the address.
- Public identity resolution must not expose owner account IDs, membership rows, runtime bindings, MCP credentials, model/provider configuration, or private product fields.
- Existing single-user conversations rely on the account participant and default agent participant. Participant schema changes must keep those records valid.
- Storefront/public capability tokens are scoped to one business and must remain separate from authenticated account membership.

## Reusable Components

- Identity: `BusinessSummary.id`, `grogoniId`, `cp2_grogoni_id_history`, `normalizeStorefrontLookupId`, reserved handle rules.
- Chat: `MessagingDomain.createConversation`, `createConversationMessage`, `conversationView`, provider channels, platform identities, managed attachments.
- Commerce: `SalesDomain`, `CommerceDomain`, `CommercialRecordsDomain`, `LogisticsDomain`, public storefront sessions and orders.
- Runtime: `AgentRuntimeDomain`, native runtime bindings, runtime handoff protocol, model templates, context sources.
- Authorization: `requireAuthorizedSession`, membership permissions, public storefront capability tokens, MCP token principals.
- Persistence: normalized CP2 collection pattern in `postgres-store.ts`.

## Dependency Map

1. Commerce identity resolver depends on existing business IDs, `grogoniId`, history, presence, and public product projection.
2. Multiplayer conversation routes should extend `MessagingDomain` participants before frontend chat controls are added.
3. Transaction references should be added after invoice/order/payment/logistics projections are unified.
4. Agent authorization should reuse MCP principal and runtime tool boundary work before enabling agent-initiated mutations.
5. Frontend entry points should consume the public resolver after the backend contract is stable.
