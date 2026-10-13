import type { EnvironmentEvaluation } from "@grogoni/shared-types";
import type { BusinessPermission } from "@grogoni/business-core";
import type { createPostgresRuntimeApprovalStore } from "./runtime-approval-store.js";
import type { BusinessTask, BusinessEnvironmentInstance } from "@grogoni/tool-core";
import type { BusinessTaskVerificationReport } from "./business-task-verification.js";

type Actor = { sessionId: string | null; businessId: string };
export interface CompletedBusinessTaskEvidence {
  task: BusinessTask;
  instance: BusinessEnvironmentInstance;
  report: BusinessTaskVerificationReport;
}
export interface BusinessTaskEvaluationReader {
  list(actor: Actor): Promise<EnvironmentEvaluation[]>;
  taskContext?(actor: Actor, taskId: string): Promise<BusinessTask | null>;
  completedTask?(actor: Actor, taskId: string): Promise<CompletedBusinessTaskEvidence | null>;
}

/** Read the existing verification journal, never maintain a competing evaluation database. */
export function createBusinessTaskEvaluationReader(
  database: Parameters<typeof createPostgresRuntimeApprovalStore>[0],
  authorize: (input: Actor & { permission: BusinessPermission }) => { userId: string }
): BusinessTaskEvaluationReader {
  return {
    async taskContext(actor, taskId) {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      return (
        (
          await database.query<{ task: BusinessTask }>(
            "select task from business_environment_tasks where business_id=$1 and task_id=$2 and actor_id=$3",
            [actor.businessId, taskId, userId]
          )
        ).rows[0]?.task ?? null
      );
    },
    async completedTask(actor, taskId) {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const row = (
        await database.query<CompletedBusinessTaskEvidence>(
          `select t.task,e.instance,v.report from business_environment_tasks t
         join business_environment_instances e using(business_id,task_id)
         join business_environment_task_steps s using(business_id,task_id)
         join lateral (select * from business_environment_task_verifications v
           where v.business_id=s.business_id and v.task_id=s.task_id and v.step_id=s.step_id and v.actor_id=$3
           order by evidence_sequence desc limit 1) v on true
         where t.business_id=$1 and t.task_id=$2 and t.actor_id=$3 and e.actor_id=$3 and s.actor_id=$3
           and e.instance->>'status'='COMPLETED' and e.completion is not null and e.expires_at>now()
           and jsonb_array_length(t.task->'plan')=1 and s.status='VERIFYING'
           and v.runtime_turn_id=s.runtime_turn_id and v.status='PASSED' and v.claim_eligible
           and v.report->'evaluation'->>'executionSuccess'='true' limit 1`,
          [actor.businessId, taskId, userId]
        )
      ).rows[0];
      return row?.report.experienceEvidence ? row : null;
    },
    async list(actor) {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const rows = await database.query<{ evaluation: EnvironmentEvaluation | null }>(
        `with latest as (
           select distinct on(task_id,step_id) report,evidence_sequence
           from business_environment_task_verifications where business_id=$1 and actor_id=$2
           order by task_id,step_id,evidence_sequence desc
         ) select report->'evaluation' as evaluation from latest
           order by evidence_sequence desc limit 200`,
        [actor.businessId, userId]
      );
      return rows.rows
        .map((row) => row.evaluation)
        .filter(
          (value): value is EnvironmentEvaluation =>
            value !== null &&
            value.event?.shopId === actor.businessId &&
            value.event.tenantId === actor.businessId
        );
    }
  };
}
