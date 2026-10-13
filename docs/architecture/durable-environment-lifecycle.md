# Durable environment lifecycle

Environment instances now have native PostgreSQL state, a revision and a bounded
24-hour lifetime. Their business, actor and environment version come from the
immutable task; agent and runtime identities come from a server-owned resolver.
Repeated creation returns the existing identity and never extends its lifetime.

Transitions reuse the canonical pure lifecycle contract. A row lock and expected
revision reject stale controllers, including competing suspend/resume requests.
Running rechecks canonical capability permissions and the pinned runtime binding.
Suspended instances can resume only their previous state, and terminal instances
cannot reopen. Expired instances cannot execute.

Step claims lock the instance and require RUNNING, an exact revision and a future
expiry. A suspension prevents new claims, not an already claimed in-flight
external operation; interruption is not permission to replay. Journal results can
still record that operation's uncertainty or outcome after a suspension.
Native canonical approval claims take the same instance lock and reject stopped,
expired or rebound task environments without consuming the token. Ordinary
approvals with no associated environment retain their existing behavior.

Completion is assembled server-side from the latest native verifier report for
every planned step, bound to business, actor, task, step, exact runtime turn and
policy. All six categories must pass independently for every step. The lifecycle
write and evidence commit before success is returned. Verifiers take the same
instance lock before the step lock, preventing a late report from racing terminal
completion. Completion rechecks current capability permissions.

This remains internal plumbing. Production Node/Edge composition, durable approval
continuation, authoritative uncertain-write reconciliation, native-record privacy
cleanup, procurement, evaluation and remaining implementation phases are not yet
complete. No environment is activated.
