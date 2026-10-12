# Business Environment Execution Foundation

Status: partial Phase 3, not activated for production tasks.

The existing runtime now accepts server-compiled task steps through its normal
authorization, validation, policy, confirmation, and capability-dispatch path.
HTTP and MCP request parsers do not accept compiled steps. Canonical action IDs
are stable for a task step so existing domain idempotency mechanisms can reuse
them; this does not make every existing capability idempotent.

Migration 114 adds a native PostgreSQL step journal outside asynchronous CP2
snapshot persistence. A unique business/task/step claim is acknowledged before
dispatch. Concurrent attempts cannot both claim a step. A started claim is never
automatically reclaimed, including after interruption or an uncertain database
acknowledgement. Results require the exact claim and can be recorded once.
Runtime output awaits independent verification; it is never marked verified by
this controller. Observations reference canonical turns and identify their
business, task, step, capability, and timestamp. Full tool results stay in the
canonical runtime record.

The composition service is intentionally not registered as an HTTP endpoint or
wired into chat yet. It requires an explicit authoritative runtime commit hook.
Its journal pool must commit claims independently before any consequential
execution; a pool wrapped inside an uncommitted outer Edge transaction is not a
valid implementation of that requirement. Simulation is rejected until an
isolated adapter exists. Dependency steps remain blocked until the independent
verifier can authorize their progression.

Remaining Phase 3 work: durable exact-action approval recovery across processes,
verified dependency progression, lifecycle/revision fencing, authoritative
uncertain-write reconciliation, and production Node/Edge commit wiring. These
must land before activating any environment or advertising multi-step execution.

Focused tests cover competing claims, repository recreation, tenant and actor
isolation, claim fencing, canonical runtime dispatch, non-model planned steps,
HTTP field stripping, commit ordering, and execution/persistence uncertainty.
