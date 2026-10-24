# Runtime Handoff Protocol

The canonical hosted/local lifecycle, capability contract, security and recovery documentation is
[Runtime handoff](../runtime/runtime-handoff.md). That document supersedes the former
commit-before-activation sequence and its claim that a failed activation should replace the
last known-good runtime. It also corrects the old claim that LISTEN/NOTIFY synchronizes independent
CP2 writer processes.

`RuntimeHandoff` remains an immutable portable task checkpoint, independent of executor configuration,
conversation transcript and long-term memory. A task is currently a conversation; the protocol keeps
`taskId` for future task/conversation separation. Native agent/model/host references use the existing
native runtime graph. No retired execution framework is involved.

## Checkpoint and task-head contracts

Checkpoints retain goal, current state, completed/pending actions, decisions, rejected paths,
next action, context/artifact references, tests, runtime identity, schema/checkpoint versions,
parent/merge ancestry, and timestamp. Runtime progress references protected data; it does not copy
protected context or secrets. Conversation messages remain separately stored.

`cp2_runtime_task_heads` owns the authoritative `activeHandoffId` and version allocator.
`cp2_runtime_task_instances` records the executor's active checkpoint and lifecycle. A checkpoint
can exist without being active. Migration 083's immutable trigger permits byte-identical snapshot
upserts while rejecting content changes; 084 adds the index on the existing JSON `createdAt` field.
Migration 085 stores mutable transfer lifecycle separately from checkpoint history.

Checkpoint history is bounded. A task keeps its head's checkpoint, its instance's, every checkpoint
a transfer names, checkpoints without a cloud version, and its latest 20 versions; older ones are
deleted on the write that adds a newer one (`checkpoint-retention.ts`, migration 123). Rollback,
reads by id or version, merge and offline sync reach that window; an older checkpoint answers
`RUNTIME_HANDOFF_NOT_FOUND`. A kept checkpoint's `parentHandoffId` stays as recorded ancestry even
when the parent is gone. Idempotency records carry their account and task (migration 124).

The source runtime remains authoritative until the target has restored and passed verification.
Target activation failure cannot replace the source's binding/head. Host changes through the
legacy `/swaps/host` endpoint return `HANDOFF_RESTORE_REQUIRED`; clients must use the acknowledged
transfer contract. Legacy model/agent changes still validate a candidate binding before committing.

## Existing REST and MCP operations

All REST paths have prefix `/v1/runtime/:taskId`. The session/account owns the task; business runtime
controls require owner membership. MCP wrappers apply their existing token scopes and principal
resolution before invoking the same domain. MCP retries are authorized before dedup lookup.

| Endpoint                             | Behavior                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /`                              | Resolve head/checkpoint/instance; bootstrap a legacy checkpoint if necessary |
| `GET /handoff?version=N`             | Read the current checkpoint or canonical version                             |
| `GET /handoffs/:id`                  | Read an owned immutable checkpoint                                           |
| `POST /checkpoints`                  | Create an immutable checkpoint; promotion requires `expectedHandoffId`       |
| `POST /swaps/agent` / `/swaps/model` | Validate and materialize a native binding, checkpoint and commit             |
| `POST /swaps/host`                   | Host changes require the acknowledged transfer API                           |
| `POST /resume`                       | Resume the current canonical checkpoint                                      |
| `POST /rollback`                     | Select a kept earlier checkpoint (latest 20 versions); erases nothing itself |
| `POST /checkpoints/sync`             | Validate and insert a causal offline checkpoint chain                        |
| `POST /merge`                        | Create a new checkpoint combining explicitly selected branches               |

Promotion, swap, rollback, sync and merge use optimistic head checks. Active transfers exclude
other head mutations. Nonpromoted checkpoints remain branches; they do not silently replace the
active runtime. Idempotency records are account/task scoped and persisted through the normal CP2
snapshot writer. New transfer requests additionally bind the key to target/source/device.

## Offline causality and merge

Offline checkpoints carry client-generated IDs and parent references, with null canonical versions.
Synchronization validates duplicate content, task ownership, schema, ancestry and runtime-reference
existence before allocating cloud versions. A host being temporarily offline does not invalidate a
historical checkpoint's reference. Conflicts preserve the local branch; no implicit last-write-wins
promotion is allowed. The existing merge API creates a new immutable child with
`mergedFromHandoffIds`; it never edits prior checkpoints. There is no automatic semantic merge or
visual merge editor in this checkout.

## Concurrency and deployment

Atomic in-memory mutations rely on one authoritative API writer. The Postgres snapshot advisory lock
and unique indexes do not remove that deployment restriction. Successful runtime responses must
cross the persistence barrier; a pending flush returns an explicit recoverable error. Apply all
migrations with the normal migration runner before deploying the runtime API.

See the canonical document for the complete transition sequence, API examples, deadlines, host
leases, failure codes, frontend recovery, installation requirements and verification limits.
