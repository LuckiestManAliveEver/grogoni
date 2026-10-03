-- Runtime Handoff Protocol.
--
-- Grogoni's native runtime graph (063_native_runtime_bindings.sql onward) resolves *which* agent,
-- model, and execution host a conversation uses. It has never represented the task's in-flight
-- execution state independently of that binding, so swapping the agent, model, or host had no
-- portable checkpoint for the new runtime to resume from. This migration adds that checkpoint.
--
-- Grogoni has no separate `tasks` entity distinct from `conversations` - a conversation *is* the
-- unit of runtime execution here (see docs/architecture/native-runtime-bindings.md). So
-- `task_id` below is populated with the owning conversation's id; the column is still named and
-- exposed as `taskId` throughout the application layer for fidelity with the wider protocol
-- vocabulary (and so a future split of "task" from "conversation" - e.g. multiple concurrent
-- tasks per conversation - only has to add a real tasks table, not rename anything). See
-- docs/architecture/runtime-handoff-protocol.md.
--
-- Every table here follows the repository's existing CP2 generic-entity shape (entity_id,
-- business_id, account_id, user_id, parent_id, record jsonb, updated_at - see
-- 011_cp2_normalized_store.sql) with generated columns and constraints layered on top for
-- referential integrity and fast lookups, exactly like 063_native_runtime_bindings.sql already
-- does for the native runtime graph. entity_id values are application-generated UUIDs
-- (node:crypto randomUUID, the convention used everywhere else in this codebase) rather than a
-- `gen_ulid()` SQL default, since no such function exists in this database.
--
-- Referenced entity types differ from the protocol's reference schema to match what this
-- repository actually has:
--   agents           -> cp2_native_runtime_agents
--   models           -> cp2_native_runtime_models
--   execution hosts  -> cp2_native_execution_hosts
--   runtime instance -> cp2_runtime_task_instances (new - see below; cp2_runtime_sessions is a
--                        distinct, business/user-scoped agentic-planner concept and is not the
--                        per-task "currently executing process" this protocol needs, so it is
--                        deliberately left alone rather than overloaded)
--
-- `conversations`/`cp2_conversations` are not given a real foreign key from the generated
-- `task_id`/`conversation_id` columns below: `conversations.id` is `uuid` while every CP2 record
-- column (including this one) is `text`, and the rest of this codebase never crosses that type
-- boundary with a physical FK (native-runtime tables do the same thing for `runtime_binding_id`
-- in the other direction). Existence is validated in the application layer, exactly like
-- `NativeRuntimeBindingStore.resolveRuntimeBinding` already validates `conversationId` against
-- the in-memory conversations map.

create table if not exists cp2_runtime_handoffs (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  task_id text generated always as (record ->> 'taskId') stored,
  conversation_id text generated always as (record ->> 'conversationId') stored,
  parent_handoff_id text generated always as (record ->> 'parentHandoffId') stored,
  agent_id text generated always as (record #>> '{runtime,agentId}') stored,
  model_id text generated always as (record #>> '{runtime,modelId}') stored,
  execution_host_id text generated always as (record #>> '{runtime,executionHostId}') stored,
  checkpoint_version bigint generated always as (
    case
      when record ->> 'checkpointVersion' is null then null
      else (record ->> 'checkpointVersion')::bigint
    end
  ) stored,
  constraint cp2_runtime_handoffs_record_check check (
    char_length(record ->> 'taskId') between 1 and 200
    and char_length(record ->> 'conversationId') between 1 and 200
    and char_length(record ->> 'goal') >= 1
    and char_length(record ->> 'currentState') >= 1
    and record #>> '{runtime,agentId}' is not null
    and record #>> '{runtime,modelId}' is not null
    and record #>> '{runtime,executionHostId}' is not null
    and (record ->> 'schemaVersion')::integer >= 1
  ),
  constraint cp2_runtime_handoffs_parent_fk
    foreign key (parent_handoff_id) references cp2_runtime_handoffs (entity_id),
  constraint cp2_runtime_handoffs_agent_fk
    foreign key (agent_id) references cp2_native_runtime_agents (entity_id),
  constraint cp2_runtime_handoffs_model_fk
    foreign key (model_id) references cp2_native_runtime_models (entity_id),
  constraint cp2_runtime_handoffs_host_fk
    foreign key (execution_host_id) references cp2_native_execution_hosts (entity_id)
);

create index if not exists cp2_runtime_handoffs_parent_idx
  on cp2_runtime_handoffs (parent_handoff_id);

-- Cloud-authoritative ordering. Nullable so an offline-created checkpoint (future work, see
-- docs/architecture/runtime-handoff-protocol.md#offline-causal-ancestry) can exist before a
-- server assigns it a canonical version; `parent_handoff_id` alone carries causality until then.
create unique index if not exists cp2_runtime_handoffs_task_version_idx
  on cp2_runtime_handoffs (task_id, checkpoint_version)
  where checkpoint_version is not null;

-- Handoffs are immutable after insertion (invariant 1.1). Re-saving a row with byte-identical
-- `record` content is allowed since this repository's snapshot writer (postgres-store.ts
-- saveCollectionRecords) unconditionally upserts every in-memory row on every flush; only an
-- actual content change is rejected. Documented migration/repair tooling can still bypass this
-- by dropping and recreating the trigger, which is the point - it is not meant to be convenient.
create or replace function cp2_runtime_handoffs_immutable_guard()
returns trigger language plpgsql as $$
begin
  if old.record is distinct from new.record then
    raise exception 'cp2_runtime_handoffs rows are immutable after insertion (entity_id=%)', old.entity_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists cp2_runtime_handoffs_immutable_guard on cp2_runtime_handoffs;
create trigger cp2_runtime_handoffs_immutable_guard
before update on cp2_runtime_handoffs
for each row execute function cp2_runtime_handoffs_immutable_guard();

-- The authoritative mutable task-state pointer (invariant 1.2). One row per task; entity_id *is*
-- the task_id, so uniqueness is the primary key rather than a separate constraint.
create table if not exists cp2_runtime_task_heads (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  active_handoff_id text generated always as (record ->> 'activeHandoffId') stored not null,
  next_checkpoint_version bigint generated always as (
    (record ->> 'nextCheckpointVersion')::bigint
  ) stored,
  constraint cp2_runtime_task_heads_record_check check (
    record ->> 'activeHandoffId' is not null
    and (record ->> 'nextCheckpointVersion')::bigint >= 1
  ),
  constraint cp2_runtime_task_heads_active_handoff_fk
    foreign key (active_handoff_id) references cp2_runtime_handoffs (entity_id)
);

-- Per-task runtime execution pointer (adapts invariant 1.2/3.3's "runtime_instances" to this
-- repository, see header note above). `active_handoff_id` is what this executor *believes* it is
-- currently running; comparing it against cp2_runtime_task_heads.active_handoff_id for the same
-- task is exactly the drift check resolveHandoff() performs.
create table if not exists cp2_runtime_task_instances (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  active_handoff_id text generated always as (record ->> 'activeHandoffId') stored,
  status text generated always as (record ->> 'status') stored,
  constraint cp2_runtime_task_instances_record_check check (
    record ->> 'status' in ('STARTING', 'READY', 'RUNNING', 'DEGRADED', 'FAILED', 'STOPPED')
  ),
  constraint cp2_runtime_task_instances_active_handoff_fk
    foreign key (active_handoff_id) references cp2_runtime_handoffs (entity_id)
);

-- Idempotency dedup store (spec section 6.2). No prior generic idempotency-key primitive existed
-- in this codebase (the closest prior art, device-bootstrap's key-hash map, is single-purpose and
-- not reusable across domains) so this is new, narrowly-scoped infrastructure: a request/response
-- cache keyed by (operation_type, idempotency_key), consulted before a checkpoint/swap mutation
-- runs and written atomically with it. entity_id is the hash of that pair, which is what makes
-- entity_id doubling as the dedup key work with the shared CP2 upsert-by-entity_id writer.
create table if not exists cp2_runtime_operation_dedup (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  operation_type text generated always as (record ->> 'operationType') stored,
  idempotency_key text generated always as (record ->> 'idempotencyKey') stored,
  constraint cp2_runtime_operation_dedup_record_check check (
    char_length(record ->> 'operationType') between 1 and 80
    and char_length(record ->> 'idempotencyKey') between 1 and 200
  )
);

create index if not exists cp2_runtime_operation_dedup_lookup_idx
  on cp2_runtime_operation_dedup (operation_type, idempotency_key);
