# CP23 MCP Tool Gateway Foundation

Status: active
Date opened: 2026-07-12
Target tag: `checkpoint/cp23-mcp-tool-gateway`

CP23 executes Phase 4 of the refined cross-platform Grogoni architecture. It exposes a deliberately
small Model Context Protocol gateway without granting models direct access to databases, host
tools, or unchecked business mutations.

## Phase 4 Scope

1. Implement the MCP 2025-11-25 initialize, ping, tools/list, and tools/call surface over HTTP.
2. Validate browser origins and require bearer authentication on every MCP request.
3. Issue short-lived, revocable MCP tokens whose hashes—not plaintext values—are persisted.
4. Scope tokens to `mcp:read`, `mcp:act`, and optionally one shop.
5. Require a PIN-verified app session before issuing an action-capable token.
6. Route proposed and confirmed actions through the existing Grogoniclaw runtime.
7. Preserve deterministic RBAC, validation, idempotency, audit, and confirmation gates.

## Exposed Tools

| Tool                          | Scope      | Behavior                                                        |
| ----------------------------- | ---------- | --------------------------------------------------------------- |
| `grogoni.list_shops`             | `mcp:read` | Lists server-authorized shop memberships.                       |
| `grogoni.get_sync_changes`       | `mcp:read` | Reads the durable account catch-up journal.                     |
| `grogoni.runtime_turn`           | `mcp:act`  | Produces a runtime plan; high-risk mutations remain unexecuted. |
| `grogoni.confirm_runtime_action` | `mcp:act`  | Confirms exactly one pending action for the same actor/shop.    |

No shell, filesystem, browser, arbitrary HTTP, arbitrary SQL, sampling, prompt export, or generic
host execution tool is exposed.

## Security Invariants

- Plaintext MCP tokens are returned exactly once and never stored in snapshots or Postgres.
- Token lifetime is at most 24 hours and never exceeds the originating login session.
- Revoked, expired, or session-orphaned tokens fail authentication.
- An action token requires recent PIN verification at issuance.
- Shop-bound tokens cannot act on another shop.
- MCP session identifiers are routing state only and never authorization credentials.
- Every request revalidates the bearer token independently of the MCP session ID.
- Requests are rate-limited per access token.
- High-risk business actions require a separate confirmation tool call.

## Transport Position

The initial gateway uses JSON responses over the MCP Streamable HTTP endpoint and does not offer an
SSE listening stream. OAuth 2.1 authorization-code discovery for third-party public clients remains
a later deployment capability; CP23 tokens are first-party credentials provisioned from an existing
authenticated Grogoni session.

## Exit Criteria

CP23 passes when:

- token creation, listing, revocation, hashing, expiry, scope, and shop binding are tested
- invalid bearer tokens and untrusted origins are rejected
- tool discovery reflects token scope
- high-risk mutations remain unchanged before explicit confirmation
- confirmed actions still pass existing runtime RBAC and validators
- migration 019 and rollback are present
- full CI, build, boundary, and production-import checks pass
- the checkpoint is formally tagged

## Verification

Passed:

- `pnpm run ci` (119 tests passed; the environment-gated Postgres test was skipped)
- `pnpm build`
- `pnpm check:production-imports`
- focused bearer authentication, origin, scope, shop-binding, revocation, confirmation, migration,
  and snapshot-secret tests

Pending environment verification:

- apply migrations 018 and 019 using Neon's direct `DIRECT_DATABASE_URL`
- run the read-only `pnpm db:verify-schema` check against Neon
- configure the deployed API with Neon's pooled `DATABASE_URL`
