import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { BusinessPermission } from "@grogoni/business-core";
import {
  runtimeToolRegistry,
  transitionBusinessEnvironment,
  type BusinessTask,
  type BusinessEnvironmentInstance,
  type BusinessEnvironmentStatus,
  type BusinessEnvironmentCompletionEvidence
} from "@grogoni/tool-core";
import { canonicalJson } from "../model-templates/manifest.js";
import { Cp2Error } from "../../cp2-error.js";
import type { BusinessTaskVerificationReport } from "./business-task-verification.js";

interface Actor {
  sessionId: string | null;
  businessId: string;
}
export interface DurableBusinessEnvironment {
  instance: BusinessEnvironmentInstance;
  revision: number;
  expiresAt: string;
}
type Binding = Pick<
  BusinessEnvironmentInstance,
  "agentId" | "runtimeInstanceId" | "runtimeSessionId"
>;
const conflict = (message: string) => new Cp2Error(409, "business_environment_conflict", message);

/** Binding resolution is server-owned; never accept runtime identities from a task/model proposal. */
export function createPostgresBusinessEnvironmentStore(
  pool: Pool,
  authorize: (input: Actor & { permission: BusinessPermission }) => { userId: string },
  resolveBinding: (actor: Actor) => Binding | Promise<Binding>
) {
  return {
    async get(actor: Actor, taskId: string): Promise<DurableBusinessEnvironment | null> {
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const row = (
        await pool.query<{
          instance: BusinessEnvironmentInstance;
          revision: number;
          expires_at: Date;
        }>(
          `select instance,revision,expires_at from business_environment_instances
         where business_id=$1 and task_id=$2 and actor_id=$3`,
          [actor.businessId, taskId, userId]
        )
      ).rows[0];
      return row
        ? {
            instance: row.instance,
            revision: row.revision,
            expiresAt: row.expires_at.toISOString()
          }
        : null;
    },
    async create(
      actor: Actor,
      taskId: string,
      now = new Date()
    ): Promise<DurableBusinessEnvironment> {
      if (!Number.isFinite(now.getTime())) throw conflict("Invalid environment time.");
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const task = (
        await pool.query<{ task: BusinessTask }>(
          `select task from business_environment_tasks where business_id=$1 and task_id=$2 and actor_id=$3`,
          [actor.businessId, taskId, userId]
        )
      ).rows[0]?.task;
      if (!task) throw new Cp2Error(404, "business_task_not_found", "Task not found.");
      const binding = await resolveBinding(actor);
      if (Object.values(binding).some((id) => !id.trim()))
        throw conflict("Canonical runtime binding is unavailable.");
      const instance: BusinessEnvironmentInstance = {
        ...binding,
        id: randomUUID(),
        businessId: actor.businessId,
        taskId,
        environmentId: task.environmentId,
        environmentVersion: task.environmentVersion,
        executionMode: task.executionMode,
        status: "CREATED",
        suspendedFrom: null
      };
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
      const client = await pool.connect();
      try {
        await client.query("begin");
        // The business lock serializes admission; the following statement sees prior commits.
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `business-environments:${actor.businessId}`
        ]);
        const existing = await client.query(
          "select 1 from business_environment_instances where business_id=$1 and task_id=$2 and actor_id=$3",
          [actor.businessId, taskId, userId]
        );
        if (!existing.rows[0]) {
          const capacity = (
            await client.query<{
              business_active: number;
              actor_active: number;
              business_recent: number;
              actor_recent: number;
            }>(
              `select
            (select count(*)::int from business_environment_instances where business_id=$1 and expires_at>now()
              and instance->>'status' not in ('COMPLETED','FAILED','CANCELLED','EXPIRED')) as business_active,
            (select count(*)::int from business_environment_instances where business_id=$1 and actor_id=$2 and expires_at>now()
              and instance->>'status' not in ('COMPLETED','FAILED','CANCELLED','EXPIRED')) as actor_active,
            (select count(*)::int from business_environment_tasks where business_id=$1 and created_at>now()-interval '1 hour') as business_recent,
            (select count(*)::int from business_environment_tasks where business_id=$1 and actor_id=$2 and created_at>now()-interval '1 hour') as actor_recent`,
              [actor.businessId, userId]
            )
          ).rows[0]!;
          if (
            capacity.business_active >= 6 ||
            capacity.actor_active >= 3 ||
            capacity.business_recent > 100 ||
            capacity.actor_recent > 20
          )
            throw new Cp2Error(
              429,
              "business_environment_capacity",
              "Finish or cancel existing tasks before starting another replenishment task."
            );
        }
        const row = (
          await client.query<{
            instance: BusinessEnvironmentInstance;
            revision: number;
            expires_at: Date;
          }>(
            `insert into business_environment_instances (business_id,task_id,actor_id,instance,expires_at)
         values ($1,$2,$3,$4::jsonb,$5)
         on conflict (business_id,task_id) do update set instance=business_environment_instances.instance
         where business_environment_instances.actor_id=excluded.actor_id
         returning instance,revision,expires_at`,
            [actor.businessId, taskId, userId, JSON.stringify(instance), expiresAt]
          )
        ).rows[0];
        if (!row) throw conflict("Environment ownership does not match.");
        await client.query("commit");
        return {
          instance: row.instance,
          revision: row.revision,
          expiresAt: row.expires_at.toISOString()
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async transition(
      actor: Actor,
      taskId: string,
      expectedRevision: number,
      next: BusinessEnvironmentStatus,
      now = new Date()
    ): Promise<DurableBusinessEnvironment> {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        !Number.isFinite(now.getTime())
      ) {
        throw conflict("Invalid environment revision or time.");
      }
      const { userId } = authorize({ ...actor, permission: "business:read" });
      const client = await pool.connect();
      try {
        await client.query("begin");
        const row = (
          await client.query<{
            instance: BusinessEnvironmentInstance;
            revision: number;
            expires_at: Date;
            task: BusinessTask;
          }>(
            `select e.instance,e.revision,e.expires_at,t.task from business_environment_instances e
           join business_environment_tasks t using (business_id,task_id)
           where e.business_id=$1 and e.task_id=$2 and e.actor_id=$3 and t.actor_id=$3 for update of e`,
            [actor.businessId, taskId, userId]
          )
        ).rows[0];
        if (!row)
          throw new Cp2Error(404, "business_environment_not_found", "Environment not found.");
        if (row.revision !== expectedRevision) throw conflict("Environment revision is stale.");
        if (now >= row.expires_at && next !== "EXPIRED" && next !== "CANCELLED")
          throw conflict("Environment has expired.");
        if (next === "EXPIRED" && now < row.expires_at)
          throw conflict("Environment has not expired.");
        const binding = next === "RUNNING" ? await resolveBinding(actor) : null;
        if (
          next === "RUNNING" &&
          binding !== null &&
          Object.entries(binding).some(
            ([key, value]) => row.instance[key as keyof Binding] !== value
          )
        ) {
          throw conflict("Canonical runtime binding has changed.");
        }
        if (next === "RUNNING" || next === "COMPLETED") {
          for (const step of row.task.plan)
            authorize({
              ...actor,
              permission: runtimeToolRegistry[step.capability]
                .requiredPermission as BusinessPermission
            });
        }
        let completion: BusinessEnvironmentCompletionEvidence | undefined;
        if (next === "COMPLETED") {
          const verified = (
            await client.query<{
              step_id: string;
              status: string;
              runtime_turn_id: string | null;
              report_status: string | null;
              report_turn_id: string | null;
              claim_eligible: boolean | null;
              report: BusinessTaskVerificationReport | null;
            }>(
              `select s.step_id,s.status,s.runtime_turn_id,v.status as report_status,
                    v.runtime_turn_id as report_turn_id,v.claim_eligible,v.report
             from business_environment_task_steps s
             left join lateral (
               select * from business_environment_task_verifications v
               where v.business_id=s.business_id and v.task_id=s.task_id and v.step_id=s.step_id
                 and v.actor_id=$3 order by v.evidence_sequence desc limit 1
             ) v on true where s.business_id=$1 and s.task_id=$2 and s.actor_id=$3
             order by s.step_id for update of s`,
              [actor.businessId, taskId, userId]
            )
          ).rows;
          if (
            row.task.plan.length === 0 ||
            verified.length !== row.task.plan.length ||
            row.task.plan.some((step) => !verified.some((entry) => entry.step_id === step.id))
          ) {
            throw conflict("Every planned step needs independent verification.");
          }
          const checks: BusinessEnvironmentCompletionEvidence["checks"][number][] = [];
          for (const entry of verified) {
            const report = entry.report;
            if (
              entry.status !== "VERIFYING" ||
              !entry.runtime_turn_id ||
              entry.report_status !== "PASSED" ||
              !entry.claim_eligible ||
              entry.report_turn_id !== entry.runtime_turn_id ||
              !report ||
              report.status !== "PASSED" ||
              report.businessId !== actor.businessId ||
              report.actorId !== userId ||
              report.taskId !== taskId ||
              report.stepId !== entry.step_id ||
              report.runtimeTurnId !== entry.runtime_turn_id ||
              report.policyId !==
                row.task.plan.find((step) => step.id === entry.step_id)?.verificationPolicyId
            ) {
              throw conflict("A step has missing, uncertain or mismatched verification.");
            }
            // Validate each report independently, not just the union of six categories across steps.
            transitionBusinessEnvironment({ ...row.instance, status: "VERIFYING" }, "COMPLETED", {
              taskId,
              environmentInstanceId: row.instance.id,
              stateVersion: report.stateVersion,
              checks: report.checks,
              durability: "COMMITTED"
            });
            checks.push(...report.checks);
          }
          completion = {
            taskId,
            environmentInstanceId: row.instance.id,
            durability: "COMMITTED",
            checks,
            stateVersion: createHash("sha256")
              .update(canonicalJson(verified.map((entry) => entry.report)))
              .digest("hex")
          };
        }
        let instance: BusinessEnvironmentInstance;
        try {
          instance = transitionBusinessEnvironment(row.instance, next, completion);
        } catch (error) {
          throw conflict(
            error instanceof Error ? error.message : "Invalid environment transition."
          );
        }
        const updated = (
          await client.query<{ revision: number }>(
            `update business_environment_instances set instance=$4::jsonb,revision=revision+1,
             completion=$5::jsonb,updated_at=$6 where business_id=$1 and task_id=$2 and actor_id=$3 returning revision`,
            [
              actor.businessId,
              taskId,
              userId,
              JSON.stringify(instance),
              completion ? JSON.stringify(completion) : null,
              now
            ]
          )
        ).rows[0]!;
        await client.query("commit");
        return { instance, revision: updated.revision, expiresAt: row.expires_at.toISOString() };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
