# CP20 Unified Account, Conversation, and Session Foundation

CP20 implements Phase 1 of the refined cross-platform Grogoni architecture. It establishes the
server-authoritative identity and conversation contracts that Android, iOS, web, realtime, sync,
and MCP clients will share.

## Source Concept

Primary source:

- Unified cross-platform architecture concept provided on 2026-07-11.
- Unified messenger frontend concept implemented immediately before this checkpoint.

This checkpoint covers foundation items 1 through 3:

1. Account, shop, and mode lifecycle.
2. Conversation and structured-message domain.
3. Server-authoritative session context and permissions.

## Product Intent

The account is the primary identity. A shop is a resource the account may own or access through a
membership. A newly authenticated account can use marketplace mode without creating a shop.

The same account agent and conversation system serve marketplace and seller work:

```text
Account
  -> stable account agent
  -> session context
       -> marketplace mode (shop optional)
       -> seller mode (active membership required)
  -> conversations
       -> typed messages and generated surfaces
```

The frontend can request a mode change, but the server decides whether the account is allowed to
enter seller mode and returns the effective permission set.

## Shared Contracts

CP20 adds language-neutral domain shapes to `@grogoni/shared-types` for:

- `GrogoniMode`
- `GrogoniChatSurface`
- `GrogoniSessionContext`
- account shop and membership summaries
- conversations and participants
- idempotent conversation messages
- structured text, storefront, owner-control, and confirmation content

The web shell now consumes the shared mode and surface contracts instead of defining a private copy.

## API Surface

```http
GET   /v1/shops
GET   /v1/session/context
PATCH /v1/session/context
GET   /v1/conversations
POST  /v1/conversations
GET   /v1/conversations/{conversationId}
POST  /v1/messages
```

Session context updates support optimistic concurrency through `expectedSessionVersion`.

Message creation requires a client-generated `clientMessageId`. Repeating the same identifier in the
same conversation returns the original message instead of creating a duplicate.

## Permission Rules

- Marketplace mode does not require a shop.
- Seller mode requires an active shop membership.
- Seller permissions are calculated from the server-side membership role.
- Seller-only surfaces cannot be activated in marketplace mode.
- Owner-control messages require seller mode for the same active shop.
- Conversations can only be read by their owning account.
- Public storefront conversations may reference a shop without granting seller permissions.
- A stale session-context version is rejected with a conflict response.

## Persistence

Migration `017_cp20_unified_session_conversations.sql` adds:

- conversations
- conversation participants
- conversation messages
- Grogoni session contexts
- unique per-conversation client-message identifiers
- compatibility persistence collections used by the current CP2 store adapter

Snapshots preserve session context, conversations, participants, messages, and idempotency indexes.

## Audit Events

CP20 records:

- `session.context_updated`
- `conversation.created`
- `message.created`

Existing business and membership events continue to record shop creation and access changes.

## Explicitly Deferred

The following later phases are not implemented by CP20:

- client-side IndexedDB, Room, or SwiftData repositories
- complete offline catch-up and tombstone protocol
- realtime WebSocket delivery
- MCP server and tool security layer
- payment ledger expansion
- marketplace search and ranking
- media and object storage
- Android and iOS applications

The direct-messaging items originally deferred here are implemented by
`CP25_FULL_MESSAGING_PLATFORM.md`. CP20 remains the historical foundation checkpoint; use CP25 for
the current participant access, message lifecycle, media, realtime presence, and notification
contracts.

## Exit Criteria

CP20 passes when:

- an authenticated account can exist and use marketplace mode without a shop
- one account can discover multiple shop memberships
- seller mode requires a valid active membership
- permissions are derived by the server from the membership role
- session context is versioned and detects stale updates
- every session has one stable account agent and active conversation
- conversations are account-scoped and persist across store hydration
- messages have typed content and idempotent client identifiers
- protected owner-control content requires matching seller context
- shared contracts, API routes, migration, audit events, and tests are implemented
- the full repository CI and boundary checks pass
- the checkpoint log is updated

## Rollback

If CP20 must be rolled back, clients can continue using the existing `/session`, `/businesses`, and
business-scoped APIs. Preserve CP20 conversation and session-context tables as dormant data so that
message history is not destroyed. Disable the `/v1/session/context`, `/v1/conversations`, and
`/v1/messages` routes until the checkpoint can be restored.
