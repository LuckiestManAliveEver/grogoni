# Verified task dependencies

Native step claims now admit non-root steps only when each prerequisite's latest
committed independent verification passed for that prerequisite's exact runtime
turn and actor/business/task scope. The prerequisite must still be in VERIFYING
with a durable turn reference; returned output alone is insufficient.

The dependency query and unique claim insert use one PostgreSQL statement
snapshot. Competing claims still have one winner, and a claim is never reclaimed
automatically after interruption. A newer failed or inconclusive report blocks
an older pass. A monotonic evidence sequence orders checks independently of
wall-clock timestamps. Rechecking an identical historical state retains the
original immutable report but refreshes its sequence after the new independent
check; the verifier's step lock serializes checks for the same step.
Pre-migration reports cannot establish observation order and are not eligible to
unlock a dependency until independently rechecked. A migration-assigned sequence
alone is never accepted as proof of historical freshness.

This is internal execution plumbing, not environment activation. Current
verification supports only the first inventory-read policy. Lifecycle fencing,
approval continuation, uncertain-write reconciliation, production Node/Edge
composition, procurement and complete task outcomes remain outstanding.
