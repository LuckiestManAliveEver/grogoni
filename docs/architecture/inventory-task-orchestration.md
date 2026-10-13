# Inventory Task Orchestration

## Canonical Chat Path

The existing `/v1/messages` agent-chat path recognizes the bounded inventory replenishment
recipe from the persisted owner message. It does not trust a separate frontend `agent.message`
to change the budget, objective or execution scope. Unrelated conversations keep their existing
runtime path; encrypted human conversations cannot enter business-agent processing.

The shared `parseInventoryTaskObjective` compiler requires one explicit positive KES budget and
one stock horizon between 1 and 365 days. Ambiguous amounts/horizons, unsupported currencies,
negated requests and unconnected supplier submission ask for clarification without dispatch.
This is a finite first-party recipe, not another autonomous planner or capability dispatcher.

A task uses an idempotently created ordinary personal conversation linked to the source chat.
Its stable existing conversation ID derives from the authenticated business, actor and persisted
message identity; it is also the existing runtime/handoff task identity. Each new owner goal gets
its own immutable contract. Exact message retries retain the same task and cannot duplicate drafts.
The child conversation and runtime session are persisted before native execution begins.

## First-Party Registry

`grogoni.retail.inventory@1.0.0` is the initial active manifest. Its only executable capability is
`procurement.prepare`, with canonical permission/risk policy, independent replenishment verification
and pinned `grogoni.inventory.outcomes.v1` evaluation. It does not activate unsupported sales,
payments, checkout, logistics or third-party environments. Manifests are copied and version pinned;
an in-flight task is not silently upgraded when a future manifest is added.

Current inventory, invoice and supplier read access and draft-write access are checked before
orchestration and by the native domain operation. Existing canonical runtime policy and exact
action UUIDs remain authoritative. A real server-resolved runtime binding is required; no fabricated
runtime identity is used when configuration is unavailable. Deterministic task execution does not
invoke a model and is not counted as a model benchmark.

## Durability and Recovery

The controller composes the existing task, lifecycle, step, reconciler and verifier repositories.
It dispatches the business action only through `createRuntimeTurn` and the canonical capability
dispatcher. Claims commit before dispatch; the business write, canonical turn and step journal each
have awaited acknowledgement boundaries. Independent verification rereads committed records before
native completion. Eligible experience extraction runs afterwards and awaits CP2 persistence.

Node uses the existing PostgreSQL pools and snapshot flush queue. Edge uses independent record
transactions for each native repository operation, not a savepoint around the whole execution.
The canonical runtime snapshot is independently saved before the journal advances, and the outer
request's snapshot baseline advances only after that commit. A later outer rollback therefore cannot
erase an acknowledged canonical turn or reopen a completed native claim. Repeatable-read verification
uses a fresh transaction; the Edge pool facade fails closed if that isolation cannot be established.

Resume reconciles committed evidence for already-started steps and never dispatches them again.
Missing canonical evidence remains incomplete even if purchase drafts exist. Suspension/cancellation
fence subsequent claims and native writes. Resuming a cancelled task returns a conflict. Cancellation
does not require a still-reachable model host. Binding changes and stale revisions fail closed.

## Resource Bounds

Task creation is serialized per business and limited to 20 new tasks per actor/hour and 100 per
business/hour. Environment admission is transactional and capped at three active tasks per actor
and six per business. Exact retries bypass new-admission counting without extending expiry.
The existing 24-hour lifecycle, database statement timeout, finite one-tool recipe, source/line
limits, draft limits and canonical context limits apply. No retry loop or external supplier request
is added.

## Views and Remaining Delivery

Authenticated task views and revision-fenced suspend/resume/cancel controls are exposed at
`/businesses/:businessId/runtime/tasks/:taskId/view` and `/control`. Views use native records and the
latest six-category verification, not assistant prose. They label incomplete/expired results, show
prepared drafts as not submitted, preserve pending business rewards and return bounded source issues.
Agent replies carry a task reference in their existing text-message content for the upcoming chat card.

Supplier offers must already exist through the confirmed canonical quote capability. Submission is
not connected, so no approval button may imply it is available. Adding supplier-offer UI, explicit
approval rejection, chat-card rendering and isolated model benchmarks are separate remaining sections.

## Validation

The PostgreSQL integration fixture exercises the acceptance request through real authenticated chat,
the canonical runtime, independently committed Edge-style native transactions, verification,
evaluation and experience extraction. It asserts budget compliance, not-submitted drafts, ignored
frontend objective substitution, replay deduplication, absent-sales incompleteness, non-replaying
resume and terminal cancellation. Admission-race, lifecycle, recovery, compiler, API authentication
and existing runtime regression suites cover the corresponding boundaries. Fixture adapters never
generate model output; these tests do not claim live supplier submission or model performance.
