# Runtime handoff implementation report

Repository changes are implemented and verified as described below. This is **not a claim that the
reported production request was reproduced or that a shipping local executor was certified**.
The runtime protocol works with compatible executable adapters in tests; installations with no
such adapter remain explicitly unavailable. No production deployment or database change was made.

## 1. Root cause and traced request paths

The old settings hook emitted the installation-disabled message from a frontend build flag and
returned without issuing a runtime handoff request. Its sibling profile/model/runtime requests
could still fail independently. The generic message comes from the 20-second AbortController in
`apps/web/src/lib/api.ts`, which remains unchanged.

Confirmed backend wait points were effective-runtime readiness and model test/activation awaiting
adapter `canRun`/`healthCheck` promises without a service-level deadline. A stalled adapter could
therefore outlive the frontend safeguard. These probes now have a five-second server deadline.
The exact stalled production endpoint is **not established**: no failed URL/request ID or production
trace was supplied. The code cannot justify assigning that particular incident to a specific probe.

Other confirmed architectural bugs were missing backend capability discovery; committing a host
swap before activation validation; omitted handoff methods in the Postgres mutation-interception
list; and permitting a successful runtime response when persistence had not been confirmed.

Final path:

```text
Settings action -> useRuntimeHandoff -> RuntimeHandoffController
-> /v1/runtime/:taskId capabilities / handoffs / transfers
-> RuntimeHandoffDomain -> NativeRuntimeBindingStore -> execution host
-> unpromoted RuntimeHandoff checkpoint -> target prepare/restore
-> receipt or hosted model/agent-adapter readiness -> compare-and-swap commit
-> Postgres persistence barrier -> canonical frontend routing
```

An unsupported target now returns a specific 409 before checkpoint/activation or persistence waits.
A regression test verifies this even with a deliberately stalled persistence queue.

## 2. Architecture and continuity

The existing native agent/model/binding/host/installation graph, immutable RuntimeHandoff,
conversation store, local database, LocalProvider and executor adapter interfaces are reused.
Location is independent of model/provider identity. No retired Execution Fabric or additional
execution framework was introduced.

Task/agent/model identity, checkpoint cursor/state, action IDs/status and context references survive
both directions. Local conversation messages synchronize under their original IDs. Completed hosted
turns record safe checkpoint references; active tool calls finish at the source before a handoff
can start. Pending tool actions require authorization again; tokens/PINs/tool inputs and protected
file contents are not copied. Arbitrary native call stacks are not migrated mid-call.

## 3. Changed files

| File                                                                                                                                             | Purpose                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [apps/web/src/AgentProfileSurface.tsx](../../apps/web/src/AgentProfileSurface.tsx)                                                               | Show backend guidance, refresh and saved-operation recovery controls.                                                                               |
| [apps/web/src/hooks/useRuntimeHandoff.ts](../../apps/web/src/hooks/useRuntimeHandoff.ts)                                                         | Use canonical task capabilities or business effective runtime; remove the offline build-flag assumption and render accurate states.                 |
| [apps/web/src/runtime-handoff-controller.ts](../../apps/web/src/runtime-handoff-controller.ts)                                                   | Prepare/restore before commit; persist operation identity; bound adapter preparation; recover lost responses and retry failed returns safely.       |
| [docs/architecture/native-runtime-bindings.md](../../docs/architecture/native-runtime-bindings.md)                                               | Link the canonical transfer lifecycle and correct the previous commit ordering.                                                                     |
| [docs/architecture/runtime-handoff-protocol.md](../../docs/architecture/runtime-handoff-protocol.md)                                             | Preserve the checkpoint/sync/merge contract while replacing contradictory activation and multi-writer claims.                                       |
| [docs/offline/runtime-handoff-frontend.md](../../docs/offline/runtime-handoff-frontend.md)                                                       | Align frontend integration and installation requirements with the new lifecycle.                                                                    |
| [docs/runtime/runtime-handoff-report.md](../../docs/runtime/runtime-handoff-report.md)                                                           | This implementation and verification report.                                                                                                        |
| [docs/runtime/runtime-handoff.md](../../docs/runtime/runtime-handoff.md)                                                                         | Canonical architecture, capabilities, hosts, API, state machine, errors, recovery, security and offline semantics.                                  |
| [e2e/responsive-accessibility.spec.ts](../../e2e/responsive-accessibility.spec.ts)                                                               | Exercise an opened conversation at phone/desktop widths; mock capabilities and a complete authenticated session.                                    |
| [infra/db/migrations/085_runtime_transfers.sql](../../infra/db/migrations/085_runtime_transfers.sql)                                             | Add non-destructive transfer progress storage with foreign keys, state checks and concurrency/idempotency indexes.                                  |
| [packages/offline-runtime/types.ts](../../packages/offline-runtime/types.ts)                                                                     | Persist transfer IDs, retry keys and target host identity in the existing local session.                                                            |
| [packages/shared-types/src/runtime-handoff.ts](../../packages/shared-types/src/runtime-handoff.ts)                                               | Shared capability, transfer, restore-receipt and execution-location contracts.                                                                      |
| [scripts/purge-all-users.sql](../../scripts/purge-all-users.sql)                                                                                 | Classify the new transfer table before its checkpoint/host foreign-key dependencies.                                                                |
| [services/api/src/app.ts](../../services/api/src/app.ts)                                                                                         | Require confirmed persistence for runtime success/recovery responses; return explicit pending-durability errors.                                    |
| [services/api/src/cp2/domains/agent-runtime/domain-deps.ts](../../services/api/src/cp2/domains/agent-runtime/domain-deps.ts)                     | Connect the existing executor to task exclusion and checkpoint capture.                                                                             |
| [services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts](../../services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts) | Supply the authoritative checkpoint to hosted continuation as task data.                                                                            |
| [services/api/src/cp2/domains/agent-runtime/store.ts](../../services/api/src/cp2/domains/agent-runtime/store.ts)                                 | Bound readiness and model activation/test probes; checkpoint completed turns and exclude concurrent transfers.                                      |
| [services/api/src/cp2/domains/native-runtime/store.ts](../../services/api/src/cp2/domains/native-runtime/store.ts)                               | Resolve binding business scope, enforce ownership, and refresh only provisioned device-host leases.                                                 |
| [services/api/src/cp2/domains/runtime-handoff/routes.ts](../../services/api/src/cp2/domains/runtime-handoff/routes.ts)                           | Expose capability, heartbeat, transfer creation/status/completion/failure API contracts.                                                            |
| [services/api/src/cp2/domains/runtime-handoff/store.ts](../../services/api/src/cp2/domains/runtime-handoff/store.ts)                             | Strict transfer lifecycle, unpromoted target checkpoints, verified commit, source preservation, idempotency, expiry and ownership checks.           |
| [services/api/src/cp2/postgres-store.ts](../../services/api/src/cp2/postgres-store.ts)                                                           | Persist transfer records and all handoff mutations, including expired/failed operations; fix omitted mutation interception.                         |
| [services/api/src/cp2/runtime-deadline.ts](../../services/api/src/cp2/runtime-deadline.ts)                                                       | Shared bounded server readiness probe with cancellation.                                                                                            |
| [services/api/src/cp2/store.ts](../../services/api/src/cp2/store.ts)                                                                             | Wire transfer/capability services, owner authorization, live hosted readiness probes and snapshot lifecycle.                                        |
| [tests/runtime-deadline.test.ts](../../tests/runtime-deadline.test.ts)                                                                           | Verify hung probes terminate explicitly and timers/signals clean up.                                                                                |
| [tests/runtime-handoff-domain-unit.test.ts](../../tests/runtime-handoff-domain-unit.test.ts)                                                     | Test capabilities, leases, state continuity, ownership, duplicate/conflicting requests, failed checkpoints/restore, expiry and execution exclusion. |
| [tests/runtime-handoff-frontend.test.ts](../../tests/runtime-handoff-frontend.test.ts)                                                           | Test both directions, exact receipts, local tools, synchronization, loss/reload recovery and retry after hosted activation failure.                 |
| [tests/runtime-handoff-persistence.test.ts](../../tests/runtime-handoff-persistence.test.ts)                                                     | Verify real Postgres persistence and canonical state across two store restarts.                                                                     |
| [tests/runtime-handoff-protocol-migration.test.ts](../../tests/runtime-handoff-protocol-migration.test.ts)                                       | Run existing migration regressions in separate schemas instead of replaying non-idempotent 084 constraints in shared public schema.                 |
| [tests/runtime-handoff-protocol.test.ts](../../tests/runtime-handoff-protocol.test.ts)                                                           | HTTP capability fail-fast under a stalled flush, local/hosted round trip, and preservation of local state when hosted readiness fails.              |
| [tests/runtime-transfer-migration.test.ts](../../tests/runtime-transfer-migration.test.ts)                                                       | Validate fresh/upgrade transfer DDL, safe replay, state constraints, foreign keys and one active operation.                                         |
| [tests/user-purge-script.test.ts](../../tests/user-purge-script.test.ts)                                                                         | Account for the newly classified transfer table.                                                                                                    |

## 4. Schema changes

Only migration 085 is new: `cp2_runtime_transfers` stores mutable operation progress separately from
immutable `cp2_runtime_handoffs`. It uses the existing CP2 entity/JSON record shape. Generated
columns expose task, status, source/checkpoint IDs and host IDs. Foreign keys reference existing
checkpoints and execution hosts; checks restrict status/identity; indexes enforce one active
transfer per task and unique account/task/idempotency keys. There are no destructive resets or
alterations to existing migrations. Existing native schema fields supply host configuration and
lease metadata.

All migrations through 085 were applied to a disposable Postgres 16 database. The migration runner
was replayed successfully. Dedicated schema tests applied 083/084/085 with 085 repeated; tests also
verified foreign keys, invalid states and concurrency constraints. Production migration state was
not queried or assumed.

## 5. API contracts

Prefix: `/v1/runtime/:taskId`. Authorization uses the existing session cookie. Mutation requests
include `x-grogoni-device-id`; transfer creation requires `Idempotency-Key`.

```http
GET /capabilities
POST /hosts/:hostId/heartbeat
{ "connected": true }

POST /handoffs
Idempotency-Key: unique-attempt-key
{ "targetExecutionHostId": "local-host", "expectedHandoffId": "source-checkpoint" }
```

Creation returns 202 with the transfer ID, `TARGET_ACTIVATING`, `checkpointId`, source/target IDs,
expiry and ownership metadata. An unavailable host returns a deterministic 409 with code/message.
Retries return the same operation; conflicting reuse returns 409.

```http
GET /transfers/:id
GET /handoffs/:checkpointId

POST /transfers/:id/complete
{ "receipt": { "handoffId": "target-checkpoint", "agentId": "same-agent",
  "modelId": "same-model", "harness": true, "artifacts": true,
  "protectedContext": true, "businessState": true } }

POST /transfers/:id/fail
{}
```

Hosted completion uses `{}` and server model/agent-adapter readiness probes. Completion/failure responses
contain the canonical transfer status; FAILED includes `failureCode` and `message`. Runtime durability
that remains unconfirmed returns 503 `RUNTIME_PERSISTENCE_PENDING`. Legacy host swaps require this
acknowledged protocol in both directions. Read-only business status without a selected conversation
uses the existing `/businesses/:businessId/runtime/effective` endpoint.

## 6. State machine

```text
PENDING -> CHECKPOINTING -> CHECKPOINTED -> TARGET_ACTIVATING
        -> RESTORING -> VERIFYING -> COMPLETED
Any nonterminal state -> FAILED
```

The lifecycle is validated in code. Checkpoints remain immutable. One synchronous canonical commit
updates head/binding/instance after target readiness, followed by confirmed database persistence.
This follows the repository's existing single-writer deployment boundary; it does not make multiple
independent CP2 API writers safe.

## 7. Failure and recovery behavior

| Condition                                | Result                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| No compatible local runtime              | Capability unavailable; disabled control; immediate explicit 409 if called directly          |
| Local bridge disappears or lease expires | Commit rejected; operation FAILED; source remains canonical                                  |
| Checkpoint failure                       | CHECKPOINT_FAILED; old head/binding preserved                                                |
| Restore or hosted readiness failure      | FAILED; source preserved; explicit retry can use a new attempt key                           |
| Duplicate / crossing request             | Return canonical operation or explicit conflict; no duplicate active operation               |
| Browser refresh                          | Reload the durable operation via saved identity; Resume handoff or Go hosted; no blind rerun |
| Lost completion response                 | Recover completed canonical state; never roll back a completed transfer                      |
| In-flight hosted turn                    | Immediate HANDOFF_IN_PROGRESS; let the original turn save its checkpoint, then retry         |
| Unconfirmed DB persistence               | Explicit 503; refresh canonical operation before changing routing                            |

Offline means local execution with eventual synchronization. It does not log out the account, erase
hosted data, or permanently disable syncing. Account/business/host ownership, initiating device and
business-owner membership are checked on the backend, including retries. Existing protected-context
and owner PIN boundaries remain in force.

## 8–9. Tests and verification

All commands used Node 22.19.0 from the installed local toolchain.

| Verification                                                  | Result                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Full Vitest suite (`node node_modules/vitest/vitest.mjs run`) | 237 files passed; 1,160 tests passed; 41 skipped (242 files / 1,201 tests total) |
| Subsequent affected runtime/model suites                      | 6 files, 88 tests passed after final runtime/retry refinements                   |
| Latest frontend controller regression rerun                   | 21 tests passed                                                                  |
| Live Postgres migration suites                                | 7 tests passed in isolated schemas                                               |
| Live Postgres handoff persistence/restart test                | 1 test passed                                                                    |
| `pnpm typecheck`                                              | Passed across the workspace; affected packages checked again after final edits   |
| `pnpm lint`                                                   | Passed                                                                           |
| `pnpm build`                                                  | Passed; affected packages rebuilt after final edits                              |
| Playwright settings handoff tests                             | Passed at 360px and 1280px (2 tests)                                             |
| Boundary / retired-runtime / ESM import checks                | Passed                                                                           |
| Migration runner: fresh DB and replay                         | Passed through migration 085                                                     |

The broad suite was followed by targeted reruns as fixes were finalized. Environment-dependent tests
in the broad suite remain skipped; the handoff migration and restart tests were run separately with
`CP2_POSTGRES_TEST_DATABASE_URL` set to the disposable database. Earlier regression failures were
fixed: personal-conversation business scope, purge table counts, lost-response return handling,
legacy migration-test isolation and incomplete browser mock session metadata.

Relevant commands:

```sh
pnpm typecheck
pnpm lint
pnpm build
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run tests/runtime-handoff-domain-unit.test.ts tests/runtime-handoff-frontend.test.ts tests/runtime-handoff-protocol.test.ts tests/runtime-deadline.test.ts tests/model-activation-runtime.test.ts tests/zero-setup-native-runtime.test.ts
# With CP2_POSTGRES_TEST_DATABASE_URL pointing only at the disposable database:
node node_modules/vitest/vitest.mjs run tests/runtime-transfer-migration.test.ts tests/runtime-handoff-protocol-migration.test.ts tests/runtime-handoff-persistence.test.ts
pnpm exec playwright test e2e/responsive-accessibility.spec.ts --grep 'runtime handoff is visible' --workers=1
pnpm check:boundaries
pnpm check:retired-runtime-references
pnpm check:esm-relative-imports
# With DATABASE_URL pointing only at the disposable database:
node services/api/scripts/migrate-db.mjs
node services/api/scripts/verify-db-schema.mjs
```

## 10. Remaining requirements and verification limits

- A real device/bridge and compatible executable adapter must be provisioned to certify live local
  execution. This checkout has no shipping full LocalHandoffHost implementation or installer;
  business-data caching and the standalone local model are insufficient. No live device was available.
- The failed production request URL/ID and server trace are still needed to identify the exact
  original production stall. The frontend-disabled path itself issued no handoff request.
- Applying migration 085 and deploying these changes to the actual installation has not been done.
  Production schema state and the single-writer deployment topology require deployment verification.

These limits mean the original production incident and live-executor acceptance criteria are not
claimed complete. The [canonical runtime document](runtime-handoff.md) records the supported adapter
contract, deployment boundary and remaining installation requirement explicitly.
