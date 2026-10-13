import type { EnvironmentEvaluation } from "@grogoni/shared-types";
import type { BusinessPermission } from "@grogoni/business-core";
import type { createPostgresRuntimeApprovalStore } from "./runtime-approval-store.js";

type Actor = { sessionId: string | null; businessId: string };
export interface BusinessTaskEvaluationReader {
  list(actor: Actor): Promise<EnvironmentEvaluation[]>;
}

/** Read the existing verification journal, never maintain a competing evaluation database. */
export function createBusinessTaskEvaluationReader(
  database: Parameters<typeof createPostgresRuntimeApprovalStore>[0],
  authorize: (input: Actor & { permission: BusinessPermission }) => { userId: string }
): BusinessTaskEvaluationReader {
  return {
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
