import type { Pool } from "pg";
import type { BusinessPermission } from "@grogoni/business-core";
import type { BusinessTask, BusinessEnvironmentInstance } from "@grogoni/tool-core";
import { runtimeToolRegistry } from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";
import { stableUuid } from "./shared.js";
import type { BusinessTaskStepRecord } from "./business-task-step-store.js";

type Actor = { sessionId: string | null; businessId: string };

/** Reconciles committed evidence only. This component has no dispatch or approval-claim port. */
export function createPostgresBusinessTaskReconciler(
  pool: Pool,
  authorize: (input: Actor & { permission: BusinessPermission }) => { userId: string }
) {
  return {
    async reconcile(
      actor: Actor,
      taskId: string,
      stepId: string,
      expectedRevision: number
    ): Promise<{ recovered: boolean; reason: string; step: BusinessTaskStepRecord }> {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Cp2Error(
          409,
          "business_environment_revision_invalid",
          "Current revision required."
        );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const scope = [actor.businessId, taskId, userId];
        const environment = (
          await client.query<{ instance: BusinessEnvironmentInstance }>(
            `select instance from business_environment_instances
             where business_id=$1 and task_id=$2 and actor_id=$3 and revision=$4
               and expires_at>now() for update`,
            [...scope, expectedRevision]
          )
        ).rows[0];
        if (
          !environment ||
          !["RUNNING", "VERIFYING", "AWAITING_APPROVAL"].includes(environment.instance.status)
        )
          throw new Cp2Error(
            409,
            "business_environment_not_recoverable",
            "Resume a current environment before reconciliation."
          );
        const row = (
          await client.query<BusinessTaskStepRecord & { task: BusinessTask }>(
            `select s.step_id,s.claim_id,s.status,s.runtime_turn_id,s.observation,t.task
             from business_environment_task_steps s join business_environment_tasks t using(business_id,task_id)
             where s.business_id=$1 and s.task_id=$2 and s.actor_id=$3 and t.actor_id=$3 and s.step_id=$4
             for update of s`,
            [...scope, stepId]
          )
        ).rows[0];
        if (!row) throw new Cp2Error(404, "business_task_step_not_found", "Task step not found.");
        const planned = row.task.plan.find((step) => step.id === stepId);
        if (!planned)
          throw new Cp2Error(409, "business_task_step_invalid", "Stored step is invalid.");
        const definition = runtimeToolRegistry[planned.capability];
        authorize({ ...actor, permission: definition.requiredPermission as BusinessPermission });
        const step: BusinessTaskStepRecord = {
          step_id: row.step_id,
          claim_id: row.claim_id,
          status: row.status,
          runtime_turn_id: row.runtime_turn_id,
          observation: row.observation
        };
        const finish = async (recovered: boolean, reason: string, value = step) => {
          await client.query("commit");
          return { recovered, reason, step: value };
        };
        if (!["RUNNING", "AWAITING_APPROVAL", "INCONCLUSIVE"].includes(row.status))
          return await finish(false, "Step is already recorded or is not recoverable.");
        const actionId = stableUuid(planned.idempotencyKey);
        // The durable action identity is necessary but insufficient: recheck the whole scope,
        // exact arguments and canonical policy result before advancing only to verification.
        const turns = await client.query<{ entity_id: string }>(
          `select r.entity_id from cp2_runtime_turns r
           where r.business_id=$1 and r.record->>'businessId'=$1 and r.record->>'actorId'=$3
             and r.record->>'id'=r.entity_id and r.record->>'sessionId'=$4
             and r.record->'plan'->>'id'=$5 and r.record->'plan'->>'toolName'=$6
             and r.record->'plan'->'input'=$7::jsonb and r.record->>'status'='completed'
             and r.record->'verification'->>'ok'='true'
             and r.record->'verification'->>'roleAllowed'='true'
             and (not $8::boolean or (
               r.record->'verification'->>'confirmationSatisfied'='true' and exists (
                 select 1 from business_runtime_approvals a
                 where a.business_id=$1 and a.actor_id=$3 and a.conversation_id=$2
                   and a.runtime_session_id=$4 and a.status='CLAIMED'
                   and a.claimed_at is not null and a.claimed_at<a.expires_at
                   and a.action->>'id'=$5 and a.action->>'toolName'=$6
                   and a.action->'input'=$7::jsonb
               )
             )) order by r.entity_id limit 2`,
          [
            ...scope,
            environment.instance.runtimeSessionId,
            actionId,
            planned.capability,
            JSON.stringify(planned.input),
            definition.requiresConfirmation
          ]
        );
        if (turns.rows.length !== 1)
          return await finish(
            false,
            "Missing or ambiguous committed canonical evidence; no action was replayed."
          );
        const turnId = turns.rows[0]!.entity_id;
        const observation = {
          schemaVersion: "1.0.0",
          businessId: actor.businessId,
          taskId,
          stepId,
          capability: planned.capability,
          source: { kind: "CANONICAL_RUNTIME_TURN", id: turnId },
          runtimeStatus: "completed",
          verificationStatus: "NOT_VERIFIED",
          reconciled: true
        };
        const updated = await client.query<BusinessTaskStepRecord>(
          `update business_environment_task_steps set status='VERIFYING',runtime_turn_id=$6,
             observation=$7::jsonb,updated_at=now()
           where business_id=$1 and task_id=$2 and actor_id=$3 and step_id=$4 and claim_id=$5
           returning step_id,claim_id,status,runtime_turn_id,observation`,
          [...scope, stepId, row.claim_id, turnId, JSON.stringify(observation)]
        );
        return await finish(
          true,
          "Committed turn recovered; independent verification is still required.",
          updated.rows[0]!
        );
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
