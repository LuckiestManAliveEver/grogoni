import type { Pool } from "pg";
import type { BusinessPermission } from "@grogoni/business-core";
import {
  compileBusinessTask,
  runtimeToolRegistry,
  type BusinessTask,
  type BusinessEnvironmentManifest
} from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";

interface TaskActor {
  sessionId: string | null;
  businessId: string;
}
type Authorize = (input: TaskActor & { permission: BusinessPermission }) => { userId: string };
type TaskProposal = Omit<
  Parameters<typeof compileBusinessTask>[0],
  "businessId" | "actorId" | "authorizedCapabilities" | "manifest" | "now"
>;

/** Awaited native writes; neither this repository nor its table participates in snapshots. */
export function createPostgresBusinessTaskStore(pool: Pool, authorize: Authorize) {
  return {
    async create(
      actor: TaskActor,
      manifest: BusinessEnvironmentManifest,
      proposal: TaskProposal,
      now = new Date()
    ): Promise<BusinessTask> {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const capabilities = [...new Set(proposal.steps.map((step) => step.capability))];
      for (const capability of capabilities) {
        const definition = runtimeToolRegistry[capability];
        if (!definition)
          throw new Cp2Error(400, "unknown_task_capability", "Unknown task capability.");
        authorize({ ...actor, permission: definition.requiredPermission as BusinessPermission });
      }
      let task: BusinessTask;
      try {
        task = compileBusinessTask({
          ...proposal,
          manifest,
          now,
          businessId: actor.businessId,
          actorId: userId,
          authorizedCapabilities: capabilities
        });
      } catch (error) {
        throw new Cp2Error(
          400,
          "business_task_invalid",
          error instanceof Error ? error.message : "Invalid business task."
        );
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `business-environments:${actor.businessId}`
        ]);
        const existing = await client.query(
          "select 1 from business_environment_tasks where business_id=$1 and task_id=$2",
          [task.businessId, task.id]
        );
        if (!existing.rows[0]) {
          const usage = (
            await client.query<{ business_recent: number; actor_recent: number }>(
              `select count(*)::int as business_recent,count(*) filter(where actor_id=$2)::int as actor_recent
           from business_environment_tasks where business_id=$1 and created_at>now()-interval '1 hour'`,
              [task.businessId, task.actorId]
            )
          ).rows[0]!;
          if (usage.business_recent >= 100 || usage.actor_recent >= 20)
            throw new Cp2Error(
              429,
              "business_task_rate_limit",
              "The business task limit has been reached. Try again later."
            );
        }
        const result = await client.query<{ task: BusinessTask }>(
          `insert into business_environment_tasks
           (business_id,task_id,actor_id,environment_id,environment_version,task)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (business_id,task_id) do update set task=business_environment_tasks.task
         where business_environment_tasks.actor_id=excluded.actor_id
           and business_environment_tasks.task-'createdAt'=excluded.task-'createdAt'
         returning task`,
          [
            task.businessId,
            task.id,
            task.actorId,
            task.environmentId,
            task.environmentVersion,
            JSON.stringify(task)
          ]
        );
        if (!result.rows[0]) {
          throw new Cp2Error(
            409,
            "business_task_conflict",
            "This task identifier already has a different specification."
          );
        }
        await client.query("commit");
        return result.rows[0].task;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async get(actor: TaskActor, taskId: string): Promise<BusinessTask | null> {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const result = await pool.query<{ task: BusinessTask }>(
        `select task from business_environment_tasks
         where business_id=$1 and task_id=$2 and actor_id=$3`,
        [actor.businessId, taskId, userId]
      );
      return result.rows[0]?.task ?? null;
    },
    async list(actor: TaskActor): Promise<BusinessTask[]> {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      return (
        await pool.query<{ task: BusinessTask }>(
          `select task from business_environment_tasks where business_id=$1 and actor_id=$2
         order by created_at desc,task_id limit 50`,
          [actor.businessId, userId]
        )
      ).rows.map((row) => row.task);
    }
  };
}
