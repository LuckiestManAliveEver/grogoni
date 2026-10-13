# Verified Task Experiences

## Existing Memory

This extends `RuntimeExperience` and its existing candidate/validated/deprecated lifecycle,
business-scoped snapshot persistence, retention and deletion. It does not introduce another
experience store. The first new trigger is independently verified, completed replenishment
draft preparation. Other triggers need explicit reviewed eligibility rules before activation.

The native verification report captures a source-only fingerprint and a bounded 8,192-bit source
mask over all confirmed invoice IDs actually used by the observation. IDs are hashed with the
business scope; raw invoice contents, customer data, model reasoning and chat transcripts are
not copied into experiences. The fingerprint excludes task/turn IDs, observation timestamps and
verification IDs, so a new execution cannot manufacture new source evidence merely by rerunning.

## Eligibility and Independence

The reader requires a committed completed native environment, an unexpired execution record,
the latest matching independently passed report, its positive supported evaluation, and the
original recorded turn. All six checks must pass. A single supported preparation step and
nonempty sales evidence are required. Current business and source permissions are rechecked.

One eligible episode creates a candidate. Promotion uses the existing threshold of two, but
requires different task IDs and source fingerprints and no intersecting source-mask bits.
Overlapping invoice IDs always intersect. Hash collisions may conservatively reject independent
episodes but can never make overlapping IDs appear independent. Busy shops may therefore retain
a candidate longer; the system never weakens the check to force promotion. The combined mask
and bounded 64-task ledger survive snapshot rehydration; entries are not evicted to reopen replay.
Replays and overlaps neither increase corroboration nor refresh retention.

Matching includes business, agent, environment/version, evaluation and verification policy,
capability sequence, execution mode, exact budget/currency and horizon. Changed constraints create
a separate candidate. No cross-business learning is enabled. Unsupported, stale, incomplete,
failed, empty-source or malformed evidence is ineligible. Existing fallback-reliability lessons
remain a separate trigger, not evidence of business-outcome success.

## Advisory Retrieval and Durability

`businessTaskExperienceAdvice` loads the task context from its authenticated immutable native
record and returns at most five exact-matching validated experiences. It does not accept a
model-supplied context key. Generic runtime recall excludes these task-scoped records and checks
agent identity, so they cannot leak into unrelated objectives or another agent's prompts.
The deterministic lesson explicitly requires current authoritative checks and submission approval;
it does not claim delivery, prevented stockouts or forecast accuracy.

`recordVerifiedBusinessTaskExperience` is a server composition hook, not an exposed capability or
HTTP endpoint. Operational orchestration must invoke it after committed task completion and await
the existing CP2 snapshot persistence barrier before acknowledging retained memory. A failed memory
commit must be reported honestly and retried through existing persistence handling; it must never
replay the prepared business action. Node and Edge share the same native evidence reader.

## Tests

Unit tests cover independent promotion, overlap, replay after rehydration, retention stability,
constraint separation, exact-scoped retrieval, detached returned values, malformed/stale/failed
evidence and absent sales. PostgreSQL tests exercise native completion gating, committed proof
extraction, actor/business isolation, and deduplicated extraction from actual verified draft
records. These tests do not claim online learning or delayed business-outcome improvements.
