# Native runtime bindings

## Repository architecture before cutover

Grogoni had three overlapping persisted concepts. `cp2_agent_model_bindings` held one verified
server model and one optional OpenAI fallback. The feature-flagged Execution Fabric held
preferences, host identities, and installations in separate CP2 envelopes. Conversations and
runtime sessions did not reference either concept. With `EXECUTION_FABRIC_ENABLED=true`, the
model-preference UI wrote ranking hints but no verified host or installation, while chat bypassed
the durable legacy binding and replanned each turn.

That split caused the observed unbound activation behavior: the flagged “Use with Agent” surface
wrote `cp2_model_preferences`, but the activation/readiness path looked for an active
`cp2_agent_model_bindings` record. A preference could therefore appear saved in the UI while the
agent remained structurally unbound. It was not a missing model-catalog row or a foreign-key
failure.

## Native graph

Migration `063_native_runtime_bindings.sql` adds normalized CP2 envelopes for independent agents,
models, execution hosts, installations, runtime bindings, and generic binding-model roles. A
conversation stores `runtimeBindingId`; `cp2_conversations.runtime_binding_id` is a generated,
foreign-keyed projection of that authoritative JSON record. The relational compatibility
`conversations` table receives the same nullable foreign key.

The in-process `NativeRuntimeBindingStore` resolves:

```text
conversation -> runtime binding -> agent -> enabled model roles
             -> model installation -> execution host -> existing adapter
```

Roles are arbitrary strings. `primary` and ordered `fallback` roles have database uniqueness
guards. A deferred constraint trigger requires exactly one enabled primary before an active
binding transaction commits. Existing `cp2_runtime_sessions` and `cp2_runtime_turns` already
provide runtime-instance lifecycle, so no duplicate runtime-instance table was added.

## Assignment is not resolution

Agent and model are independent, swappable slots, not a hardcoded pairing baked into the
conversation. Assigning a binding to a conversation (creating the conversation, or an explicit
`runtimeBindingId`) only validates that the binding is structurally sound: it is active, its agent
is active, contract versions match, and it has exactly one enabled primary role. It does not check
whether that primary's installation and host currently report available - a business's model being
briefly unreachable must never block opening or continuing a conversation, only generating a new
reply. Full availability resolution, including the fallback search, happens only at turn time, in
`resolveRuntimeBinding`.

Because the binding lives on the conversation row in Postgres, not on any device, swapping the
active agent or model (the "Use with agent" flow, `POST /api/agents/:id/models/:modelId/activate`)
changes what a conversation will use for its _next_ turn without touching its message history, and
without requiring the swap and the next message to come from the same device. Any authenticated
session for the account sees the same conversation, the same messages, and the same binding.
`tests/model-activation-runtime.test.ts`'s "continues the same conversation with full history from
a second device session after swapping the active model" exercises this directly: it opens a
conversation and sends a message on one session, swaps the active model, sends the next message
from a second session signed in with the same credentials, and asserts all four messages (both
replies, from both models) persist in one conversation.

## Availability and compatibility

Resolution performs no HTTP requests. A candidate is available only when:

- the binding, agent, and model are active;
- the binding-model relation is enabled;
- a matching installation is persisted as `available`; and
- its execution host is persisted as `available`.

`lastKnownHealthyAt` records the observation that produced availability; activation writes it only
after the existing adapter health check succeeds. Missing and unavailable records produce explicit
codes. The resolver compares runtime contract versions and the agent's declared
`requiredModelCapabilities` with model capabilities. It never silently substitutes an arbitrary
provider. Persisted fallbacks are tried by numeric priority and stable role ID.

Endpoints remain credential-free. Execution hosts do not own provider credentials. Provider
credential references belong to model/provider configuration; raw credentials are rejected from
endpoint-shaped data by migration constraints and are never copied into binding configuration.

## Default and activation

The global default is an unconfigured provider-neutral binding for `builtin:grogoni-agent:v1`. It has
no mandatory model, provider, host, or installation. Grogoni therefore starts without a configured
model vendor; attempting inference before a model is assigned returns
`RUNTIME_MODEL_NOT_CONFIGURED` at turn time. Verified activation can assign any compatible model
and one of the four provider-neutral targets. Provider-backed backend models, browser models,
installed-app models, and remote-shop-device models all pass through their relevant readiness or
health checks before activation.

The existing “Use with agent” API now writes both the legacy rollback record and the native graph
in the same CP2 snapshot transaction, then rebinds the account's shop/agent conversations. Removing
the model deactivates the native binding and returns affected conversations to the global default.
New conversations accept an authorized explicit binding or receive the active shop binding/global
default on the server.

## Retired selection architecture and backfill

Migration `065_retire_execution_fabric.sql` permanently removes the old preference, host, and
installation tables after preserving their information in the native graph. Legacy host and
installation rows become native `unavailable` records because the old persisted state did not
contain durable liveness proof. Every legacy preference becomes an inactive synthetic agent plus a
draft binding with ordered model roles and the original policy fields in configuration. This is a
lossless, deterministic archive: it requires no operator choice and cannot accidentally become an
executable binding.

The former server domain, browser adapter, planner package, preference endpoints, environment
flags, snapshot collections, and tests have been deleted. The boundary check now rejects any new
production source containing retired selection dependencies or terminology. Historical migration
`060_execution_fabric_entities.sql` remains unchanged so a new database can replay its history
before migration 065 archives and removes it.

The compatibility command remains safe both before and after migration 065 (retired source tables
are treated as already archived):

```bash
pnpm db:backfill-native-runtime --dry-run
pnpm db:backfill-native-runtime
```

The compatibility script maps active, successfully verified legacy agent-model bindings as active
native bindings. It archives every old preference scope as a draft binding and maps all old hosts
and installations as unavailable native records. Stable IDs and upserts make it idempotent. It
still reports genuine conflicts such as multiple active verified bindings for one agent, but the
old preference/host/installation shapes no longer produce ambiguous mappings or require operator
resolution.

## Database verification

`db:verify-schema` runs in a read-only transaction and checks all migration checksums, constraints,
indexes, the absence of retired tables, and the provider-neutral global default binding. The
production Render build runs it immediately after migrations with `REQUIRE_NEON_DATABASE=true`; verification
fails unless the connection is an actual Neon hostname. Local Postgres remains useful for migration
replay, but it can no longer satisfy the production database gate.

## Observability

Runtime turn telemetry records the conversation, native binding, agent, configured primary,
actually selected model, fallback reason, host, and installation IDs. It does not record prompts,
credentials, or host secrets.

## Runtime Handoff Protocol

This document covers _which_ agent/model/host a conversation resolves to. It does not represent
the task's in-flight execution state (goal, progress, next action) independently of that
resolution - swapping the agent, model, or host has nothing to hand the new runtime beyond "start
fresh." [runtime-handoff-protocol.md](./runtime-handoff-protocol.md) adds that: an immutable,
portable checkpoint per task, a task-head pointer, and a Prepare/Restore/Verify/Commit transfer lifecycle
built on top of `NativeRuntimeBindingStore.validateCandidateExecutionChain`/
`materializeConversationBinding`, reusing this document's compatibility rules and binding-value
semantics rather than duplicating them.

## Hosted/local transfer

Execution location changes use the existing native binding graph and immutable RuntimeHandoff.
See [the canonical runtime handoff contract](../runtime/runtime-handoff.md) for capabilities,
device leases, target restore receipts, source preservation, durability and recovery. A healthy
model installation alone does not prove that its agent adapter can execute on a local device.
