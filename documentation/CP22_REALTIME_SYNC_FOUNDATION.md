# CP22 Realtime Sync Foundation

Status: active
Date opened: 2026-07-12
Target tag: `checkpoint/cp22-realtime-sync`

CP22 starts Phase 3 of the refined cross-platform Grogoni architecture. It adds authenticated,
account-scoped realtime change hints on top of the durable Phase 2 cursor journal.

## Phase 3 Scope

1. Add a versioned language-neutral realtime event contract.
2. Expose an authenticated WebSocket endpoint at `GET /v1/realtime`.
3. Reject untrusted browser origins before accepting an upgrade.
4. Route change hints only to connections for the affected account.
5. Trigger the existing cursor catch-up flow after connection and after every hint.
6. Reconnect automatically without treating WebSocket delivery as durable state.
7. Preserve polling/cursor catch-up as the recovery mechanism for missed events and server restarts.

## Invariants

- WebSocket events are hints; `GET /v1/sync/changes` remains authoritative.
- Clients never advance a cursor from a WebSocket event.
- Authentication uses the existing secure session cookie.
- An account never receives another account's change hints.
- Browser origins must match the API's configured web-origin allowlist.
- Reconnect always triggers catch-up, making event loss and duplication safe.
- Realtime listener failures cannot fail a committed business mutation.

## Initial Surface

- `realtime.ready` tells an authenticated client to run catch-up immediately.
- `sync.changes_available` identifies the latest account change cursor, sequence, and collection.
- The web client coalesces overlapping catch-up requests and reconnects after transport closure.
- The Fastify WebSocket server caps inbound payloads at 1 KiB because Phase 3 is server-push only.

## Deferred Beyond Initial Phase 3

- cross-instance fan-out through Postgres notifications or a dedicated message broker
- presence and typing indicators
- realtime client-to-server business mutations
- Android and iOS WebSocket adapters
- MCP server and tool security

## Exit Criteria

CP22 passes when:

- realtime contracts are exported from shared types
- unauthenticated and untrusted-origin upgrades fail
- connected accounts receive only their own change hints
- reconnect and hint handling trigger durable cursor catch-up
- listener cleanup occurs on socket close
- repository CI, build, boundary, and production-import checks pass
- the checkpoint log is updated and the checkpoint tag is created
