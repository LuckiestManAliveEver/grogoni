# Durable Runtime Approvals

Runtime confirmation now uses native PostgreSQL approvals when running the
PostgreSQL API or the production Supabase domain adapter. Migration 115 stores
token digests, exact server-proposed actions, actor/business/runtime-session and
conversation bindings, proposal intent, expiry, and single-use claim state.
Tokens are valid for 15 minutes. Raw tokens are not stored in the approval table.

Confirmation first authenticates the current caller, then atomically claims the
bound approval. The canonical runtime revalidates arguments, entity references,
current role, and current skill policy before its existing capability dispatcher
runs. It passes the authenticated request session and conversation to the
dispatcher. It does not pick an arbitrary browser session for the same user.

Both PostgreSQL and in-memory confirmations consume the token before dispatch.
An execution timeout may follow a successful external write, so a retryable
exception no longer reopens the same approval. Reconciliation is required after
uncertain writes. A claimed approval is not evidence of successful execution or
durable business-state persistence.

Supabase commits approval records through the existing independent record
transaction connection, not the outer snapshot transaction or its coordination
lock. Rolling back a request after an external write cannot reopen its approval.
In-memory stores retain bounded-expiry ephemeral approvals for local/test use;
they do not provide cross-process recovery.

Tests cover token hashing, scope binding, expiry, competing claims, persistence
failure, and confirmation through a fresh canonical runtime with no in-memory
pending actions. Production retention/account-deletion cleanup and authoritative
reconciliation must be completed before enabling business environment execution.
