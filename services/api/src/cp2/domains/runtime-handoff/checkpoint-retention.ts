import type {
  RuntimeHandoff,
  RuntimeTaskHead,
  RuntimeTaskInstance,
  RuntimeTransfer
} from "@grogoni/shared-types";

/**
 * Which runtime checkpoints (cp2_runtime_handoffs) a task keeps. Every agent turn adds one and
 * each copies the last one's actions and context, so without this a conversation's checkpoints
 * grew without end and every request of a member loaded all of them.
 *
 * What reads a checkpoint, and why each kept one is kept:
 * - Resume, every agent turn, swap, capability checks and the computer runtime read the task
 *   head's checkpoint (`activeHandoffId`, resolveHandoff/activeCheckpoint). Kept: the head.
 * - The executor's drift check reads the task instance's checkpoint (a foreign key too). Kept.
 * - Completing a handoff reads the transfer's `checkpointId` and compares `sourceHandoffId`; the
 *   web app (runtime-handoff-controller.ts) fetches `/handoffs/<checkpointId>` to restore it
 *   locally and later as the parent of its offline checkpoints. Kept: every checkpoint any
 *   transfer names (foreign keys too).
 * - Rollback, `GET /handoffs/:id`, `GET /handoff?version=N`, merge and offline sync read any
 *   checkpoint by id or version. Kept: the latest `runtimeCheckpointRecentVersions` versions, the
 *   history these can still reach. An older one answers RUNTIME_HANDOFF_NOT_FOUND (404), which
 *   every one of them already returns for an unknown checkpoint.
 * - A checkpoint without a cloud version (an offline one not yet given one) is never pruned.
 *
 * Everything else is superseded and deleted: older than the latest versions and pointed at by
 * nothing above. That includes an unpromoted branch once it is that many versions behind. The
 * rule looks only at versions and pointers, never at whether a checkpoint has children (a pruned
 * child would make its parent look like an open branch and keep it forever), so a request that
 * loaded only some of a task's checkpoints decides exactly as one that loaded all of them. A task
 * without a head prunes nothing. The rule exists twice, here for the in-memory store and as SQL
 * (`retainedRuntimeCheckpointSql`) for the Edge scope and the Edge write;
 * tests/edge-runtime-checkpoint-scope.test.ts checks they agree.
 */
export const runtimeCheckpointRecentVersions = 20;
/** At most this many checkpoints are deleted per write, so an old backlog drains over writes. */
export const runtimeCheckpointPruneBatch = 200;

export interface RuntimeCheckpointRetentionInput {
  /** The task's checkpoints. */
  handoffs: readonly RuntimeHandoff[];
  head: RuntimeTaskHead | undefined;
  instance: RuntimeTaskInstance | undefined;
  /** The task's transfers. */
  transfers: readonly RuntimeTransfer[];
}

/** The task's superseded checkpoints, oldest first, at most `runtimeCheckpointPruneBatch`. */
export function prunableRuntimeCheckpoints(input: RuntimeCheckpointRetentionInput): string[] {
  const { head } = input;
  if (head === undefined) return [];
  const pinned = new Set<string>([head.activeHandoffId]);
  if (input.instance?.activeHandoffId) pinned.add(input.instance.activeHandoffId);
  for (const transfer of input.transfers) {
    pinned.add(transfer.sourceHandoffId);
    if (transfer.checkpointId !== null) pinned.add(transfer.checkpointId);
  }
  const oldestRecent = head.nextCheckpointVersion - runtimeCheckpointRecentVersions;
  return input.handoffs
    .filter(
      (handoff) =>
        handoff.checkpointVersion !== null &&
        handoff.checkpointVersion < oldestRecent &&
        !pinned.has(handoff.id)
    )
    .sort((left, right) => (left.checkpointVersion ?? 0) - (right.checkpointVersion ?? 0))
    .slice(0, runtimeCheckpointPruneBatch)
    .map((handoff) => handoff.id);
}

/**
 * The same rule as SQL: true for a `cp2_runtime_handoffs` row (named `table`) that is kept.
 * Reads the stored heads, instances and transfers.
 */
export function retainedRuntimeCheckpointSql(table: string): string {
  return `(${table}.checkpoint_version is null
    or not exists (select 1 from public.cp2_runtime_task_heads head where head.entity_id = ${table}.task_id)
    or exists (select 1 from public.cp2_runtime_task_heads head where head.entity_id = ${table}.task_id
      and (head.active_handoff_id = ${table}.entity_id
        or ${table}.checkpoint_version >= head.next_checkpoint_version - ${runtimeCheckpointRecentVersions}))
    or exists (select 1 from public.cp2_runtime_task_instances instance
      where instance.entity_id = ${table}.task_id and instance.active_handoff_id = ${table}.entity_id)
    or exists (select 1 from public.cp2_runtime_transfers transfer where transfer.task_id = ${table}.task_id
      and (transfer.source_handoff_id = ${table}.entity_id or transfer.checkpoint_id = ${table}.entity_id)))`;
}
