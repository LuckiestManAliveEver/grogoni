-- Durable execution event log (docs/architecture/durable-execution-plane.md,
-- docs/architecture/durable-execution-audit.md section 9.1).
--
-- Runtime Handoff Protocol (083_runtime_handoff_protocol.sql onward) already gives Grogoni an
-- immutable checkpoint chain (cp2_runtime_handoffs) and mutable transfer progress
-- (cp2_runtime_transfers). Neither is a fine-grained, append-only, sequence-numbered record of
-- *what happened* during one task's execution (binding resolution, authorization, context
-- resolution, each model/tool invocation) - that is what this table adds, purely additive, next to
-- the existing protocol tables. It never replaces the checkpoint chain and is never itself used to
-- resume execution (RuntimeCheckpoint/RuntimeHandoff rows remain the only resumable snapshot); this
-- table is for recovery diagnosis, audit, and handoff validation only, per the spec's own framing.
--
-- Same generic-entity shape as every other CP2 table (011_cp2_normalized_store.sql), same
-- generated-column pattern as 083_runtime_handoff_protocol.sql. entity_id is an
-- application-generated UUID, matching every other table in this family.
--
-- taskId is a conversation id (see runtime-handoff.ts's own note on task/conversation identity);
-- no physical FK to cp2_conversations for the same reason cp2_runtime_handoffs has none (uuid vs
-- text column types never cross a physical FK boundary in this codebase - see that migration's
-- header note). executionId is an opaque per-attempt identifier (either a runtime-turn id, or the
-- executionId minted on cp2_runtime_task_instances by a rebind/resume/transfer-completion - see
-- the RuntimeHandoffDomain changes in this same change) - deliberately not a foreign key into any
-- single table, since "an execution attempt" spans both a runtime turn and a task-instance rebind.

create table if not exists cp2_runtime_execution_events (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  task_id text generated always as (record ->> 'taskId') stored not null,
  sequence_number bigint generated always as ((record ->> 'sequenceNumber')::bigint) stored not null,
  execution_id text generated always as (record ->> 'executionId') stored,
  runtime_instance_id text generated always as (record ->> 'runtimeInstanceId') stored,
  execution_host_id text generated always as (record ->> 'executionHostId') stored,
  event_type text generated always as (record ->> 'eventType') stored not null,
  constraint cp2_runtime_execution_events_record_check check (
    char_length(record ->> 'taskId') between 1 and 200
    and (record ->> 'sequenceNumber')::bigint >= 1
    and char_length(record ->> 'eventType') between 1 and 80
  ),
  constraint cp2_runtime_execution_events_event_type_check check (
    record ->> 'eventType' in (
      'TASK_CREATED',
      'BINDING_RESOLUTION_STARTED', 'BINDING_RESOLVED',
      'AUTHORIZATION_STARTED', 'AUTHORIZATION_COMPLETED', 'AUTHORIZATION_DENIED',
      'CONTEXT_RESOLUTION_STARTED', 'CONTEXT_RESOLVED',
      'CAPABILITIES_RESOLVED',
      'EXECUTION_STARTED',
      'MODEL_INVOCATION_STARTED', 'MODEL_INVOCATION_COMPLETED', 'MODEL_INVOCATION_FAILED',
      'TOOL_REQUESTED', 'TOOL_AUTHORIZED', 'TOOL_DENIED',
      'TOOL_STARTED', 'TOOL_COMPLETED', 'TOOL_FAILED',
      'CHECKPOINT_CREATED',
      'EXECUTION_SUSPENDED', 'EXECUTION_RESUMED',
      'HANDOFF_STARTED', 'HANDOFF_COMPLETED', 'HANDOFF_FAILED',
      'RUNTIME_REBOUND',
      'EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_CANCELLED',
      -- Addition beyond the spec's required list (durable-execution-audit.md section 9.2): the
      -- explicit, observable record of a fencing rejection - a checkpoint/commit attempt whose
      -- fence token no longer matches the task's current execution. Security-review relevant
      -- (stale-runtime-takeover mitigation must be visible in the event log, not just prevented).
      'EXECUTION_FENCE_REJECTED'
    )
  )
);

-- The actual fencing/ordering guarantee: no two events for the same task may claim the same
-- sequence number, and sequence allocation (see RuntimeHandoffDomain.appendExecutionEvent) always
-- reads-then-writes synchronously within the single CP2 writer process, exactly like
-- cp2_runtime_handoffs_task_version_idx already does for checkpoint versions.
create unique index if not exists cp2_runtime_execution_events_task_sequence_idx
  on cp2_runtime_execution_events (task_id, sequence_number);

-- The hot read path (GET /v1/runtime/:taskId/events, and inspect()) always wants one task's
-- events in order; the unique index above already provides this ordering for free, but an
-- explicit btree on (task_id, sequence_number) is what the unique index physically is, so no
-- second index is needed here - documented for clarity only.

create index if not exists cp2_runtime_execution_events_execution_idx
  on cp2_runtime_execution_events (execution_id)
  where execution_id is not null;

-- Append-only (spec section 2: "Do NOT mutate historical events"). Same immutability trigger shape
-- as cp2_runtime_handoffs_immutable_guard (083_runtime_handoff_protocol.sql) - byte-identical
-- re-saves are tolerated (the snapshot writer unconditionally upserts every in-memory row on every
-- flush; only an actual content change is rejected).
create or replace function cp2_runtime_execution_events_immutable_guard()
returns trigger language plpgsql as $$
begin
  if old.record is distinct from new.record then
    raise exception 'cp2_runtime_execution_events rows are immutable after insertion (entity_id=%)', old.entity_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists cp2_runtime_execution_events_immutable_guard on cp2_runtime_execution_events;
create trigger cp2_runtime_execution_events_immutable_guard
before update on cp2_runtime_execution_events
for each row execute function cp2_runtime_execution_events_immutable_guard();
