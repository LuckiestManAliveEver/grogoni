# Independent Verification Foundation

Status: partial Phase 4, not a completed inventory replenishment verifier.

The initial first-party `grogoni.inventory.read.v1` policy independently verifies
an unfiltered `products.list` step for the version-pinned, read-only inventory
environment. It does not accept a model's explanation or the runtime's completed
status as proof of outcome success.

The verifier reauthorizes the actor, rereads the immutable task, claimed step,
canonical turn, and current inventory from PostgreSQL in one repeatable-read
transaction. It checks canonical action identity, business and actor scope,
arguments, execution status, and independently corroborated inventory output.
All six categories are persisted: structural, authorization, constraint,
execution, persistence, and outcome. Reports carry a state fingerprint,
versioned policy, timestamp, and evidence references.

Migration 117 stores reports outside the CP2 snapshot writer. A report is
returned only after commit, and identical state evidence is deduplicated. No
report marks a whole task complete. Returned output remains inconclusive if
inventory changed, a policy is unsupported, evidence is incomplete, or the
1,000-product observation bound is exceeded. Forged action identity and missing
durable turns fail verification. Verification policy and runtime argument prose
are never executable instructions.

No HTTP verifier endpoint, environment activation, dependency progression, or
experience promotion is enabled by this foundation. Write-specific authoritative
verification, procurement budget/outcome policies, lifecycle fencing, and
durable completion/evaluation still need implementation. The verifier's pool
must supply a real independent PostgreSQL transaction, not an outer-request
transaction facade.

Real PostgreSQL tests cover all-category success, changed inventory, forged
action IDs, absent committed turns, unsupported policies, scope isolation,
authorization failure, repeat evidence, and failed report persistence.
