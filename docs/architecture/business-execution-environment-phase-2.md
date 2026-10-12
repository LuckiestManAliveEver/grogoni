# Business Execution Environment: Phase 2

PHASE: 2 - Structured task contracts, compilation, and persistence
COMMIT: See the Phase 2 pull request history.
STATUS: Implemented; validation and publication in progress.

## Existing Components Reused

Task IDs reuse authorized conversation/handoff IDs. Plans reference canonical
`RuntimeToolName` definitions and use `validateRuntimeToolInput`. Risk, approval
requirements, permissions, and input schemas are derived from `runtimeToolRegistry`.
The existing CP2 authorization bridge checks every proposed capability.

## New Components

- `packages/tool-core/src/environments/tasks.ts`: immutable compiled task contracts
  and a bounded, deterministic validator for proposed multistep plans.
- `services/api/src/cp2/domains/agent-runtime/business-task-store.ts`: awaited,
  PostgreSQL-authoritative task creation and actor-scoped retrieval.
- `business-task-routes.ts` in the same domain: create, get, and list APIs under
  `/businesses/:businessId/runtime/tasks`.
- `business-environment-registry.ts`: trusted registration point, initially empty.
- Compiler, route-boundary, and real PostgreSQL persistence tests.

The CP2 route registration, Node startup, and Edge request path wire in the task
repository. A missing PostgreSQL repository returns 503 after authorization.

## Database Changes

Migration `113_business_tasks.sql` adds `business_environment_tasks`, with a
composite business/task key, actor ownership, environment version, and immutable
compiled task JSON. It is deliberately outside the asynchronous snapshot writer.
JSON identity fields must match the row's scoped columns. The rollback removes
only this new table.

Concurrent identical submissions return the original committed specification.
Changed specifications or actors cannot overwrite an existing task ID. Creation
time is excluded from conflict comparison so network retries remain idempotent.

## Security and Reliability

Creation validates conversation ownership and active business scope before
compilation. Reads are scoped to both business and effective actor. Plans cannot
invent capabilities, widen execution mode, override approval policy, introduce
cycles, reference future steps, or exceed twenty steps. Step arguments use the
canonical schema and semantic validator, with a bounded serialized input size.
Replay keys are business/task/step scoped, delimiter escaped, and bounded.
Budget uses integer minor currency units and requires an explicit currency.

No task action executes in this section. These APIs cannot bypass runtime
permissions or approvals by directly mutating business records.

## Validation

- Compiler and lifecycle tests: 25 passed.
- Real PostgreSQL tests: 4 passed, including concurrent deduplication, ownership
  boundaries, repository recreation, and injected write failure.
- HTTP boundary tests: 5 passed.
- Workspace typecheck, architectural boundaries, API route coverage, and focused
  lint passed before the final route wiring; final regression gates are running.

The database tests create and drop an isolated schema in the local development
database. They do not use production state or mocked persistence.

## Known Limitations and Next Phase

The production environment registry remains empty until execution, verification,
and permission contracts are complete. Natural-language plan generation and task
execution belong to the next section; creating a structured specification is not
business-operation success. Task lifecycle status will be owned by the persisted
environment instance, not by mutating the immutable specification.

The runtime must revalidate current permissions, policy, record state, and exact
approval arguments at execution time. Simulation remains unavailable until
isolated fixtures and external-effect suppression exist. The security section
must add task records to account/business deletion and retention workflows before
activating environments.
