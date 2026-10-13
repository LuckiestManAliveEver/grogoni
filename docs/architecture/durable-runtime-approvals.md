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

The existing daily experience maintenance job also purges approval rows after a
24-hour post-expiry audit window. Account deletion awaits scoped native approval
deletion before anonymizing data or reporting completion; failures retain a
retryable partial-deletion record. Edge maintenance may purge records but cannot
issue, claim or reject approvals inside its snapshot transaction.

Migration 121 adds durable `REJECTED` state and a rejection timestamp. The authenticated
`/businesses/:businessId/runtime/approvals/reject` endpoint requires the exact actor,
business, runtime session, conversation and unexpired token scope. Rejection is a conditional
native update acknowledged before returning; it cannot reopen a claimed token. A concurrent
claim and rejection have only one winner. Rejection does not require a reachable model host
or permission to execute the proposed operation, but does require current business access.

Server-generated chat confirmations carry their original runtime-session/conversation scope.
Chat controls use that scope rather than the most recently selected runtime session. Confirm
and Reject are disabled while a decision is pending and removed locally only after acknowledgement.
Rejected or already-claimed tokens remain unusable if an old message is loaded again; stale UI
is not authorization. Rejection never dispatches a business capability.

Tests cover token hashing, scope binding, expiry, competing claims, persistence
failure, confirmation/rejection through a fresh canonical runtime, racing decisions,
retention, and failed account-deletion recovery. The native task reconciler checks committed
canonical evidence without redispatch; native runtime scope deletion covers the complete task,
verification, supplier quote and purchase-draft graph. Browser coverage asserts that rejection
uses the original approval scope and waits for the server before removing controls.
