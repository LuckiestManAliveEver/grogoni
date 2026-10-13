import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { BusinessPermission } from "@grogoni/business-core";
import { runtimeToolRegistry, type BusinessTask } from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";

interface Actor {
  sessionId: string | null;
  businessId: string;
}
export interface BusinessTaskStepRecord {
  step_id: string;
  claim_id: string;
  status: "RUNNING" | "AWAITING_APPROVAL" | "VERIFYING" | "FAILED" | "INCONCLUSIVE";
  runtime_turn_id: string | null;
  observation: Record<string, unknown> | null;
}

/** A started step is never automatically reclaimed: interrupted writes need reconciliation. */
export function createPostgresBusinessTaskStepStore(
  pool: Pool,
  authorize: (input: Actor & { permission: BusinessPermission }) => { userId: string }
) {
  async function ownedTask(actor: Actor, taskId: string): Promise<BusinessTask> {
    const { userId } = authorize({ ...actor, permission: "business:read" });
    const result = await pool.query<{ task: BusinessTask }>(
      `select task from business_environment_tasks
       where business_id=$1 and task_id=$2 and actor_id=$3`,
      [actor.businessId, taskId, userId]
    );
    if (!result.rows[0]) throw new Cp2Error(404, "business_task_not_found", "Task not found.");
    return result.rows[0].task;
  }
  return {
    async claim(actor: Actor, taskId: string, stepId: string): Promise<BusinessTaskStepRecord> {
      const task = await ownedTask(actor, taskId);
      const step = task.plan.find((candidate) => candidate.id === stepId);
      if (!step) throw new Cp2Error(404, "business_task_step_not_found", "Step not found.");
      authorize({
        ...actor,
        permission: runtimeToolRegistry[step.capability].requiredPermission as BusinessPermission
      });
      // Evidence and the claim are read/written in one statement snapshot.
      const result = await pool.query<BusinessTaskStepRecord>(
        `insert into business_environment_task_steps
          (business_id,task_id,step_id,actor_id,claim_id,status)
         select $1,$2,$3,$4,$5,'RUNNING'
         where not exists (
           select 1 from unnest($6::text[]) as dependency(step_id)
           left join business_environment_task_steps s
             on s.business_id=$1 and s.task_id=$2 and s.step_id=dependency.step_id and s.actor_id=$4
           left join lateral (
             select v.status,v.runtime_turn_id,v.claim_eligible from business_environment_task_verifications v
             where v.business_id=$1 and v.task_id=$2 and v.step_id=dependency.step_id and v.actor_id=$4
             order by v.evidence_sequence desc limit 1
           ) latest on true
           where s.status is distinct from 'VERIFYING' or s.runtime_turn_id is null
             or latest.status is distinct from 'PASSED'
             or latest.claim_eligible is distinct from true
             or latest.runtime_turn_id is distinct from s.runtime_turn_id
         )
         on conflict (business_id,task_id,step_id) do nothing
         returning step_id,claim_id,status,runtime_turn_id,observation`,
        [actor.businessId, taskId, stepId, task.actorId, randomUUID(), step.dependencies]
      );
      if (!result.rows[0]) {
        const started = await pool.query(
          `select 1 from business_environment_task_steps
           where business_id=$1 and task_id=$2 and step_id=$3 and actor_id=$4`,
          [actor.businessId, taskId, stepId, task.actorId]
        );
        if (!started.rows[0]) {
          throw new Cp2Error(
            409,
            "business_task_dependencies_unverified",
            "Dependencies need current, matching independent verification."
          );
        }
        throw new Cp2Error(
          409,
          "business_task_step_already_started",
          "Step already started; inspect its durable result before recovery."
        );
      }
      return result.rows[0];
    },
    async record(
      actor: Actor,
      taskId: string,
      stepId: string,
      claimId: string,
      result: {
        status: Exclude<BusinessTaskStepRecord["status"], "RUNNING">;
        runtimeTurnId: string | null;
        observation: Record<string, unknown>;
      }
    ): Promise<BusinessTaskStepRecord> {
      const task = await ownedTask(actor, taskId);
      const serialized = JSON.stringify(result.observation);
      if (serialized.length > 64000) {
        throw new Cp2Error(
          400,
          "business_task_observation_too_large",
          "Observation exceeds resource limits."
        );
      }
      const updated = await pool.query<BusinessTaskStepRecord>(
        `update business_environment_task_steps
         set status=$6,runtime_turn_id=$7,observation=$8::jsonb,updated_at=now()
         where business_id=$1 and task_id=$2 and step_id=$3 and actor_id=$4
           and claim_id=$5 and status='RUNNING'
         returning step_id,claim_id,status,runtime_turn_id,observation`,
        [
          actor.businessId,
          taskId,
          stepId,
          task.actorId,
          claimId,
          result.status,
          result.runtimeTurnId,
          serialized
        ]
      );
      if (!updated.rows[0]) {
        throw new Cp2Error(
          409,
          "business_task_step_claim_conflict",
          "Step claim is no longer writable."
        );
      }
      return updated.rows[0];
    },
    async list(actor: Actor, taskId: string): Promise<BusinessTaskStepRecord[]> {
      const task = await ownedTask(actor, taskId);
      return (
        await pool.query<BusinessTaskStepRecord>(
          `select step_id,claim_id,status,runtime_turn_id,observation
         from business_environment_task_steps
         where business_id=$1 and task_id=$2 and actor_id=$3 order by created_at,step_id`,
          [actor.businessId, taskId, task.actorId]
        )
      ).rows;
    }
  };
}
