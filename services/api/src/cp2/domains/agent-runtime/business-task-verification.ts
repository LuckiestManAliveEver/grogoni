import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { BusinessPermission } from "@grogoni/business-core";
import type {
  RuntimeTurnSummary,
  ProductSummary,
  EnvironmentEvaluation
} from "@grogoni/shared-types";
import type {
  BusinessTask,
  BusinessEnvironmentInstance,
  EnvironmentVerificationCategory
} from "@grogoni/tool-core";
import { runtimeToolRegistry } from "@grogoni/tool-core";
import { canonicalJson } from "../model-templates/manifest.js";
import { Cp2Error } from "../../cp2-error.js";
import { stableUuid } from "./shared.js";
import { verifyProcurementDrafts } from "./procurement-verification.js";
import { evaluateBusinessTaskStep } from "./business-task-evaluation.js";

type Status = "PASSED" | "FAILED" | "INCONCLUSIVE";
export interface BusinessTaskVerificationReport {
  id: string;
  taskId: string;
  stepId: string;
  businessId: string;
  actorId: string;
  runtimeTurnId: string;
  stateVersion: string;
  policyId: string;
  status: Status;
  checkedAt: string;
  evaluation?: EnvironmentEvaluation;
  checks: {
    category: EnvironmentVerificationCategory;
    status: Status;
    evidenceRefs: string[];
    reason: string;
  }[];
}

/** Initial first-party policy: independently corroborate an unfiltered inventory read. */
export function createPostgresBusinessTaskVerifier(
  pool: Pool,
  authorize: (input: {
    sessionId: string | null;
    businessId: string;
    permission: BusinessPermission;
  }) => { userId: string }
) {
  return {
    async verify(
      input: { sessionId: string | null; businessId: string; taskId: string; stepId: string },
      now = new Date()
    ): Promise<BusinessTaskVerificationReport> {
      if (!Number.isFinite(now.getTime()))
        throw new Cp2Error(400, "business_verification_time_invalid", "Invalid verification time.");
      const { userId } = authorize({ ...input, permission: "business:read" });
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        const environment = (
          await client.query<{ instance: BusinessEnvironmentInstance }>(
            `select instance from business_environment_instances
           where business_id=$1 and task_id=$2 and actor_id=$3 for update`,
            [input.businessId, input.taskId, userId]
          )
        ).rows[0];
        const row = (
          await client.query<{
            task: BusinessTask;
            runtime_turn_id: string | null;
            status: string;
            turn: RuntimeTurnSummary | null;
          }>(
            `select t.task,s.runtime_turn_id,s.status,r.record as turn
             from business_environment_tasks t
             join business_environment_task_steps s using (business_id,task_id)
             left join cp2_runtime_turns r on r.entity_id=s.runtime_turn_id and r.business_id=t.business_id
             where t.business_id=$1 and t.task_id=$2 and s.step_id=$3
               and t.actor_id=$4 and s.actor_id=$4
             for update of s`,
            [input.businessId, input.taskId, input.stepId, userId]
          )
        ).rows[0];
        if (!row) throw new Cp2Error(404, "business_task_step_not_found", "Task step not found.");
        if (!environment || !["RUNNING", "VERIFYING"].includes(environment.instance.status)) {
          throw new Cp2Error(
            409,
            "business_environment_not_verifiable",
            "Environment is not accepting verification."
          );
        }
        if (row.status !== "VERIFYING" || !row.runtime_turn_id) {
          throw new Cp2Error(
            409,
            "business_task_step_not_verifiable",
            "Step is not ready for independent verification."
          );
        }
        const step = row.task.plan.find((candidate) => candidate.id === input.stepId);
        if (!step)
          throw new Cp2Error(409, "business_task_step_invalid", "Stored task step is invalid.");
        authorize({
          ...input,
          permission: runtimeToolRegistry[step.capability].requiredPermission as BusinessPermission
        });
        const products = (
          await client.query<{ record: ProductSummary }>(
            `select record from cp2_products where business_id=$1 order by entity_id limit 1001`,
            [input.businessId]
          )
        ).rows.map((product) => product.record);
        const readSupported =
          row.task.environmentId === "grogoni.retail.inventory" &&
          row.task.environmentVersion === "1.0.0" &&
          row.task.executionMode === "READ_ONLY" &&
          step.capability === "products.list" &&
          Object.keys(step.input).length === 0 &&
          step.verificationPolicyId === "grogoni.inventory.read.v1";
        const procurementSupported =
          row.task.environmentId === "grogoni.retail.inventory" &&
          row.task.environmentVersion === "1.0.0" &&
          row.task.executionMode === "LIVE" &&
          step.capability === "procurement.prepare" &&
          step.input.taskId === row.task.id &&
          step.verificationPolicyId === "grogoni.inventory.replenishment.v1";
        if (procurementSupported)
          for (const permission of [
            "product:read",
            "invoice:read",
            "supplier:read"
          ] as BusinessPermission[])
            authorize({ ...input, permission });
        const procurement = procurementSupported
          ? await verifyProcurementDrafts(client, row.task, step, row.turn)
          : null;
        const turn = row.turn;
        const structurallyValid =
          turn !== null &&
          turn.businessId === input.businessId &&
          turn.actorId === userId &&
          turn.sessionId === environment.instance.runtimeSessionId &&
          turn.id === row.runtime_turn_id &&
          turn.plan?.id === stableUuid(step.idempotencyKey) &&
          turn.plan.toolName === step.capability &&
          canonicalJson(turn.plan.input) === canonicalJson(step.input);
        const refs = [
          `task:${input.taskId}`,
          `step:${input.stepId}`,
          `turn:${row.runtime_turn_id}`
        ];
        const stateVersion = createHash("sha256")
          .update(
            canonicalJson({
              verifierVersion: "inventory-and-procurement.v3",
              environmentIdentity: {
                id: environment.instance.id,
                runtimeInstanceId: environment.instance.runtimeInstanceId,
                runtimeSessionId: environment.instance.runtimeSessionId,
                environmentVersion: environment.instance.environmentVersion
              },
              task: row.task,
              stepId: input.stepId,
              turn,
              products,
              procurement: procurement?.state ?? null
            })
          )
          .digest("hex");
        const checks: BusinessTaskVerificationReport["checks"] = [];
        const check = (category: EnvironmentVerificationCategory, status: Status, reason: string) =>
          checks.push({
            category,
            status,
            reason,
            evidenceRefs: [...refs, `state:${stateVersion}`, ...(procurement?.evidenceRefs ?? [])]
          });
        check(
          "STRUCTURAL",
          structurallyValid ? "PASSED" : "FAILED",
          "Canonical turn identity and arguments must match the immutable compiled step."
        );
        check(
          "AUTHORIZATION",
          "PASSED",
          "Current business and canonical capability permissions were reauthorized."
        );
        check(
          "CONSTRAINT",
          readSupported ? "PASSED" : (procurement?.constraints ?? "INCONCLUSIVE"),
          readSupported
            ? "The verified operation is read-only and has no monetary side effect."
            : procurementSupported
              ? "Native draft quantities, immutable quote prices and aggregate task budget were checked independently."
              : "No independent constraint policy is implemented for this operation."
        );
        check(
          "EXECUTION",
          structurallyValid && turn?.status === "completed" && turn.verification?.ok
            ? "PASSED"
            : "FAILED",
          "Execution must have completed through the canonical authorized runtime."
        );
        check(
          "PERSISTENCE",
          structurallyValid && (!procurementSupported || procurement?.persisted)
            ? "PASSED"
            : "FAILED",
          "Canonical turn and claimed step were reread from committed PostgreSQL state."
        );
        const normalized = (value: ProductSummary[]) =>
          [...value].sort((a, b) => a.id.localeCompare(b.id));
        const validProductRecords = (value: unknown): value is ProductSummary[] =>
          Array.isArray(value) &&
          value.every(
            (product: unknown) =>
              product !== null &&
              typeof product === "object" &&
              "id" in product &&
              typeof product.id === "string" &&
              "businessId" in product &&
              product.businessId === input.businessId
          );
        const outcome =
          readSupported &&
          structurallyValid &&
          products.length <= 1000 &&
          validProductRecords(products) &&
          validProductRecords(turn?.toolResult) &&
          canonicalJson(normalized(turn.toolResult)) === canonicalJson(normalized(products));
        check(
          "OUTCOME",
          outcome || (structurallyValid && procurement?.outcome) ? "PASSED" : "INCONCLUSIVE",
          outcome || (structurallyValid && procurement?.outcome)
            ? procurementSupported
              ? "Purchase drafts and recommendations match independently read authoritative records and source evidence."
              : "Returned inventory matches independently read authoritative inventory."
            : "Unsupported policy, changed inventory, incomplete evidence, or observation limit; success is unproven."
        );
        const status: Status = checks.some((entry) => entry.status === "FAILED")
          ? "FAILED"
          : checks.every((entry) => entry.status === "PASSED")
            ? "PASSED"
            : "INCONCLUSIVE";
        const report: BusinessTaskVerificationReport = {
          id: randomUUID(),
          taskId: input.taskId,
          stepId: input.stepId,
          businessId: input.businessId,
          actorId: userId,
          runtimeTurnId: row.runtime_turn_id,
          stateVersion,
          policyId: step.verificationPolicyId,
          status,
          checkedAt: now.toISOString(),
          checks
        };
        report.evaluation = evaluateBusinessTaskStep(row.task, environment.instance, report, turn);
        const saved = await client.query<{ report: BusinessTaskVerificationReport }>(
          `insert into business_environment_task_verifications
             (id,business_id,task_id,step_id,actor_id,runtime_turn_id,state_version,status,report)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           on conflict (business_id,task_id,step_id,state_version) do update
             set report=business_environment_task_verifications.report,
                 evidence_sequence=default,claim_eligible=true returning report`,
          [
            report.id,
            input.businessId,
            input.taskId,
            input.stepId,
            userId,
            row.runtime_turn_id,
            stateVersion,
            status,
            JSON.stringify(report)
          ]
        );
        await client.query("commit");
        return saved.rows[0]!.report;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
