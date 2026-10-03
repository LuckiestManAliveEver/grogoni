# CP21 Offline Client Data and Catch-up Foundation

Status: active
Date opened: 2026-07-12
Target tag: `checkpoint/cp21-offline-client-sync`

CP21 starts Phase 2 of the refined cross-platform Grogoni architecture. It builds the local-data and
incremental catch-up layer deferred by CP20 while preserving the server as the authority for
identity, permissions, session context, conversations, and structured messages.

## Phase 2 Scope

1. Define language-neutral cursor, change, tombstone, and pull-page contracts.
2. Apply server pages deterministically and reject gaps, cross-account data, and malformed deletes.
3. Add an IndexedDB-backed web repository for synced entities and cursor metadata.
4. Add an account-scoped server catch-up endpoint with bounded pages and opaque cursors.
5. Persist deletions as tombstones long enough for offline clients to observe them.
6. Connect web hydration and retry behavior to the repository without weakening server checks.
7. Document equivalent Room and SwiftData storage mappings for later native clients.

## Implemented Phase 2 Surface

- `GET /v1/sync/changes` returns bounded account-scoped pages using opaque cursors.
- Session contexts, shops, conversations, messages, and shop deletions append ordered changes.
- Deletes carry tombstones with a 90-day minimum retention timestamp.
- Existing CP20 snapshots are backfilled into a first sync journal when Phase 2 starts.
- The web client stores records, tombstones, and cursor metadata in one IndexedDB transaction.
- Web startup hydrates the account repository and catches up until the server reports no more pages.
- Invalid or expired cursors trigger one safe local reset and full account catch-up.
- Supported offline mutations are persisted in IndexedDB, transferred to the server queue in client
  creation order after reconnect, removed locally only after server acceptance, and replayed with
  their original idempotency keys.
- Migration `018_cp21_account_sync_changes.sql` persists the journal in relational Postgres with an
  explicit rollback and health count.

The implementation and repository CI are complete. The checkpoint remains active until migration
018 and the read-only schema verification run against the configured Neon database.

## Invariants

- Cursors are opaque to clients and only advance after a complete page is committed locally.
- Every page and local snapshot belongs to exactly one account.
- Changes in a page are strictly ordered by server sequence.
- Upserts contain an entity payload; deletes contain no entity payload.
- Deletes remain represented as tombstones until the server retention window has elapsed.
- Reapplying the same committed page is safe and does not duplicate records.
- Seller-scoped data never grants permissions; session permissions still come from the server.

## Deferred Beyond Phase 2

- realtime WebSocket delivery
- MCP server and tool security
- Android Room and iOS SwiftData implementations
- media/object replication
- marketplace search and ranking

## Native Repository Mapping

Room and SwiftData implementations should preserve the same three logical stores used by web:

| Logical store  | Identity                         | Required fields                                                                          |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Synced entity  | account + collection + entity ID | sequence, cursor, shop ID, payload, changed/deleted/expiry timestamps                    |
| Sync metadata  | account                          | last committed cursor and update timestamp                                               |
| Local mutation | mutation ID                      | account, business, actor, idempotency key, mutation type/payload, status and retry state |

An expired-cursor reset clears synced entities and metadata but must retain local mutations. A full
account sign-out/delete operation may clear all three stores after the caller has handled pending
mutations explicitly.

## Exit Criteria

CP21 passes when:

- shared sync contracts and deterministic page application are test-covered
- IndexedDB persists account-scoped entities, tombstones, queue records, and cursors atomically
- the API exposes bounded account-scoped catch-up pages
- stale or invalid cursors fail safely
- deletions propagate through tombstones
- web startup can hydrate from local data and catch up from the server
- offline mutations retain CP7 idempotency and conflict behavior
- full repository CI and boundary checks pass
- the checkpoint log is updated and the checkpoint tag is created

## Verification

Passed:

- `pnpm run ci` (112 tests passed; the environment-gated Postgres test was skipped)
- `pnpm build`
- `pnpm check:production-imports`
- focused cursor, paging, account-isolation, tombstone, migration, and hydration tests

Pending environment verification:

- configure the deployed API with Neon's pooled `DATABASE_URL`
- apply migration 018 using Neon's direct `DIRECT_DATABASE_URL`
- run the read-only `pnpm db:verify-schema` check against the Neon branch

The state-creating `tests/cp2-postgres-store.test.ts` integration test is intentionally not run
against the sole Neon branch because it creates durable application records.
