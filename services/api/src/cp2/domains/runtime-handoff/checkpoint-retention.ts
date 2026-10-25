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
 *   checkpoint by id or version. Kept: the latest `runtimeCheckpointRecentVersions` versions. An
 *   older one answers RUNTIME_HANDOFF_NOT_FOUND (404), which every one of them already returns
 *   for an unknown checkpoint.
 * - Merge reads the branch tips it is given (nothing else of the branch). Kept for
 *   `runtimeCheckpointBranchDays` days: every checkpoint written off the head's line (created
 *   without promotion, or synced from offline: `branchedAt`), and the parent of each; and every
 *   checkpoint nothing descends from (an unmerged tip, the head before a rollback), counted from
 *   its `createdAt`. A branch left unmerged longer than that is pruned.
 * - A retried offline sync re-reads every checkpoint it sent and the parent of the first; synced
 *   checkpoints carry `branchedAt`, so the retry finds them for the same 30 days and stays the
 *   no-op the protocol promises.
 * - A checkpoint without a cloud version (an offline one not yet given one) is never pruned.
 *
 * Everything else is superseded and deleted. A task without a head prunes nothing. The 30 days
 * also bound a checkpoint that only looks like a tip because its child was pruned while it was
 * pinned. The rule exists twice, here for the in-memory store and as SQL
 * (`retainedRuntimeCheckpointSql`) for the Edge scope and the Edge write;
 * tests/edge-runtime-checkpoint-scope.test.ts checks they agree on the same rows. Times compare
 * as ISO strings in both, so a malformed client `createdAt` can never make the SQL fail.
 */
export const runtimeCheckpointRecentVersions = 20;
/** How long an unmerged branch, a synced batch and the parent they started from are kept. */
export const runtimeCheckpointBranchDays = 30;
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

/** The oldest `branchedAt`/`createdAt` that still keeps a branch, as an ISO string. */
export function runtimeCheckpointBranchCutoff(now: Date): string {
  return new Date(now.getTime() - runtimeCheckpointBranchDays * 86_400_000).toISOString();
}

/** The task's superseded checkpoints, oldest first, at most `runtimeCheckpointPruneBatch`. */
export function prunableRuntimeCheckpoints(
  input: RuntimeCheckpointRetentionInput,
  now: Date
): string[] {
  const { head } = input;
  if (head === undefined) return [];
  const cutoff = runtimeCheckpointBranchCutoff(now);
  const kept = new Set<string>([head.activeHandoffId]);
  if (input.instance?.activeHandoffId) kept.add(input.instance.activeHandoffId);
  for (const transfer of input.transfers) {
    kept.add(transfer.sourceHandoffId);
    if (transfer.checkpointId !== null) kept.add(transfer.checkpointId);
  }
  const ancestors = new Set<string>();
  for (const handoff of input.handoffs) {
    if (handoff.parentHandoffId !== null) ancestors.add(handoff.parentHandoffId);
    for (const merged of handoff.mergedFromHandoffIds ?? []) ancestors.add(merged);
    if (handoff.branchedAt !== undefined && handoff.branchedAt >= cutoff) {
      kept.add(handoff.id);
      if (handoff.parentHandoffId !== null) kept.add(handoff.parentHandoffId);
    }
  }
  const oldestRecent = head.nextCheckpointVersion - runtimeCheckpointRecentVersions;
  return input.handoffs
    .filter(
      (handoff) =>
        handoff.checkpointVersion !== null &&
        handoff.checkpointVersion < oldestRecent &&
        !kept.has(handoff.id) &&
        (ancestors.has(handoff.id) || handoff.createdAt < cutoff)
    )
    .sort((left, right) => (left.checkpointVersion ?? 0) - (right.checkpointVersion ?? 0))
    .slice(0, runtimeCheckpointPruneBatch)
    .map((handoff) => handoff.id);
}

/**
 * The same rule as SQL: true for a `cp2_runtime_handoffs` row (named `table`) that is kept.
 * Reads the stored heads, instances, transfers and checkpoints at the statement's time. Every
 * comparison with a field that may be missing is coalesced: one NULL term would make the whole
 * expression NULL, and `not NULL` deletes nothing.
 */
export function retainedRuntimeCheckpointSql(table: string): string {
  const cutoff = `to_char((now() - interval '${runtimeCheckpointBranchDays} days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  return `(${table}.checkpoint_version is null
    or not exists (select 1 from public.cp2_runtime_task_heads head where head.entity_id = ${table}.task_id)
    or exists (select 1 from public.cp2_runtime_task_heads head where head.entity_id = ${table}.task_id
      and (head.active_handoff_id = ${table}.entity_id
        or ${table}.checkpoint_version >= head.next_checkpoint_version - ${runtimeCheckpointRecentVersions}))
    or exists (select 1 from public.cp2_runtime_task_instances instance
      where instance.entity_id = ${table}.task_id and instance.active_handoff_id = ${table}.entity_id)
    or exists (select 1 from public.cp2_runtime_transfers transfer where transfer.task_id = ${table}.task_id
      and (transfer.source_handoff_id = ${table}.entity_id or transfer.checkpoint_id = ${table}.entity_id))
    or coalesce(${table}.record->>'branchedAt' >= ${cutoff}, false)
    or exists (select 1 from public.cp2_runtime_handoffs branch where branch.task_id = ${table}.task_id
      and branch.parent_handoff_id = ${table}.entity_id and coalesce(branch.record->>'branchedAt' >= ${cutoff}, false))
    or (coalesce(${table}.record->>'createdAt' >= ${cutoff}, false)
      and not exists (select 1 from public.cp2_runtime_handoffs child where child.task_id = ${table}.task_id
        and (child.parent_handoff_id = ${table}.entity_id
          or coalesce(child.record->'mergedFromHandoffIds', '[]'::jsonb) ? ${table}.entity_id))))`;
}
