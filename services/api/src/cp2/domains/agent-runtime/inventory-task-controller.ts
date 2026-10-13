import type { Pool } from "pg";
import type { InventoryReplenishmentPlan } from "@grogoni/business-core";
import type { BusinessExecutionTaskView } from "@grogoni/shared-types";
import type { BusinessTask } from "@grogoni/tool-core";
import type { Cp2Store } from "../../store.js";
import { Cp2Error } from "../../cp2-error.js";
import { stableUuid } from "./shared.js";
import { createPostgresBusinessTaskStore } from "./business-task-store.js";
import { createPostgresBusinessTaskStepStore } from "./business-task-step-store.js";
import { createPostgresBusinessEnvironmentStore } from "./business-environment-store.js";
import {
  createPostgresBusinessTaskVerifier,
  type BusinessTaskVerificationReport
} from "./business-task-verification.js";
import { createPostgresBusinessTaskReconciler } from "./business-task-reconciliation.js";
import { executeBusinessTaskRootStep } from "./business-task-execution.js";
import { inventoryReplenishmentEnvironment } from "./inventory-environment.js";
import { parseInventoryTaskObjective } from "./inventory-task-objective.js";
import type { PurchaseDraft } from "./inventory-procurement-store.js";

type Actor = { sessionId: string | null; businessId: string };
type Native = <T>(work: (pool: Pool) => Promise<T>) => Promise<T>;
export interface InventoryTaskController {
  handle(
    input: Actor & { conversationId: string; messageId: string; text: string }
  ): Promise<{ text: string; taskId: string | null } | null>;
  inspect(actor: Actor, taskId: string): Promise<BusinessExecutionTaskView>;
  control(
    actor: Actor,
    taskId: string,
    revision: number,
    command: "SUSPEND" | "RESUME" | "CANCEL"
  ): Promise<BusinessExecutionTaskView>;
}

/** Finite first-party recipe: every business action still goes through createRuntimeTurn. */
export function createInventoryTaskController(
  runtime: Cp2Store,
  native: Native,
  commitRuntime: () => Promise<void>
): InventoryTaskController {
  const authorize = (input: Parameters<Cp2Store["authorizeBusinessPermission"]>[0]) =>
    runtime.authorizeBusinessPermission(input);
  function authorizeSources(actor: Actor) {
    for (const permission of [
      "business:read",
      "product:read",
      "invoice:read",
      "supplier:read",
      "import:write"
    ] as const)
      authorize({ ...actor, permission });
  }
  const tasks = (pool: Pool) => createPostgresBusinessTaskStore(pool, authorize);
  const steps = (pool: Pool) => createPostgresBusinessTaskStepStore(pool, authorize);
  function environments(pool: Pool, taskId: string) {
    return createPostgresBusinessEnvironmentStore(pool, authorize, async (actor) => {
      const effective = await runtime.getEffectiveRuntime({ ...actor, conversationId: taskId });
      if (!effective.binding)
        throw new Cp2Error(
          503,
          "business_runtime_unavailable",
          "A durable agent runtime binding is required."
        );
      const session = runtime.createRuntimeSession({
        ...actor,
        idempotencyKey: `business-task:${taskId}`
      });
      await commitRuntime();
      return {
        agentId: runtime.getAgentRuntime(actor).agentId,
        runtimeInstanceId: effective.binding.id,
        runtimeSessionId: session.id
      };
    });
  }
  async function inspect(actor: Actor, taskId: string): Promise<BusinessExecutionTaskView> {
    authorizeSources(actor);
    const task = await native((pool) => tasks(pool).get(actor, taskId));
    if (!task) throw new Cp2Error(404, "business_task_not_found", "Task not found.");
    if (
      task.environmentId !== inventoryReplenishmentEnvironment.id ||
      task.environmentVersion !== inventoryReplenishmentEnvironment.version ||
      task.plan.length !== 1 ||
      task.plan[0]?.capability !== "procurement.prepare"
    )
      throw new Cp2Error(
        409,
        "business_task_view_unavailable",
        "This task does not use the supported replenishment recipe."
      );
    const environment = await native((pool) => environments(pool, taskId).get(actor, taskId));
    const journal = await native((pool) => steps(pool).list(actor, taskId));
    const evidence = await native(async (pool) =>
      (
        await pool.query<{
          report: BusinessTaskVerificationReport;
          claim_eligible: boolean;
          status: string;
          runtime_turn_id: string;
        }>(
          `select distinct on(step_id) report,claim_eligible,status,runtime_turn_id from business_environment_task_verifications
       where business_id=$1 and task_id=$2 and actor_id=$3 order by step_id,evidence_sequence desc`,
          [actor.businessId, taskId, task.actorId]
        )
      ).rows.map((row) => ({
        ...row.report,
        claimEligible: row.claim_eligible,
        nativeStatus: row.status,
        nativeTurnId: row.runtime_turn_id
      }))
    );
    const records = await native(
      async (pool) =>
        (
          await pool.query<{ record: PurchaseDraft; supplier_name: string | null }>(
            `select d.record,s.record->>'name' as supplier_name from business_purchase_drafts d
       left join cp2_suppliers s on s.business_id=d.business_id and s.entity_id=d.supplier_id
       where d.business_id=$1 and d.task_id=$2 and d.actor_id=$3 order by d.draft_id limit 21`,
            [actor.businessId, taskId, task.actorId]
          )
        ).rows
    );
    const names = await native(
      async (pool) =>
        (
          await pool.query<{ entity_id: string; name: string | null }>(
            "select entity_id,record->>'name' as name from cp2_products where business_id=$1 order by entity_id limit 501",
            [actor.businessId]
          )
        ).rows
    );
    const recommendation = await native(
      async (pool) =>
        (
          await pool.query<{ plan: InventoryReplenishmentPlan | null }>(
            `select r.record->'toolResult'->'recommendation' as plan from business_environment_task_steps s
       join cp2_runtime_turns r on r.entity_id=s.runtime_turn_id and r.business_id=s.business_id
       where s.business_id=$1 and s.task_id=$2 and s.actor_id=$3 and s.step_id='prepare' limit 1`,
            [actor.businessId, taskId, task.actorId]
          )
        ).rows[0]?.plan
    );
    const issueMessages = {
      STALE_OBSERVATION: "Inventory evidence is out of date.",
      MISSING_INVENTORY: "No inventory records are available.",
      MISSING_DEMAND: "Recent confirmed sales are needed to estimate demand.",
      NO_ELIGIBLE_SUPPLIER:
        "No supplier offer meets the unit, currency, quantity and lead-time requirements.",
      BUDGET_INSUFFICIENT: "The budget cannot cover the required minimum order."
    };
    const allVerified =
      task.plan.length > 0 &&
      task.plan.every((planned) => {
        const step = journal.find((entry) => entry.step_id === planned.id);
        const report = evidence.find((entry) => entry.stepId === planned.id);
        return (
          step?.status === "VERIFYING" &&
          report?.status === "PASSED" &&
          report.claimEligible &&
          report.nativeStatus === "PASSED" &&
          report.nativeTurnId === step.runtime_turn_id &&
          report.taskId === taskId &&
          report.businessId === actor.businessId &&
          report.actorId === task.actorId &&
          report.checks.length === 6 &&
          [
            "STRUCTURAL",
            "AUTHORIZATION",
            "CONSTRAINT",
            "EXECUTION",
            "PERSISTENCE",
            "OUTCOME"
          ].every(
            (category) =>
              report.checks.filter(
                (check) => check.category === category && check.status === "PASSED"
              ).length === 1
          ) &&
          report.runtimeTurnId === step.runtime_turn_id &&
          report.policyId === planned.verificationPolicyId
        );
      });
    const verificationStatus = evidence.some((entry) => entry.status === "FAILED")
      ? "FAILED"
      : allVerified
        ? "PASSED"
        : evidence.length
          ? "INCONCLUSIVE"
          : "NOT_VERIFIED";
    const storedStatus = environment?.instance.status ?? "CREATED";
    const underlying =
      environment &&
      Date.parse(environment.expiresAt) <= Date.now() &&
      !["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(storedStatus)
        ? "EXPIRED"
        : storedStatus;
    const incomplete =
      verificationStatus === "FAILED" ||
      verificationStatus === "INCONCLUSIVE" ||
      journal.some((entry) => ["FAILED", "INCONCLUSIVE"].includes(entry.status)) ||
      records.length > 20;
    const status = ["CANCELLED", "EXPIRED", "SUSPENDED"].includes(underlying)
      ? underlying
      : incomplete || (underlying === "COMPLETED" && !allVerified)
        ? "INCOMPLETE"
        : underlying;
    return {
      taskId,
      businessId: actor.businessId,
      environmentName: inventoryReplenishmentEnvironment.name,
      objective: task.objective,
      status: status as BusinessExecutionTaskView["status"],
      revision: environment?.revision ?? 0,
      verificationStatus,
      budgetMinor: task.constraints.budgetMinor,
      currency: task.constraints.currency,
      horizonDays: task.constraints.horizonDays,
      issues: !Array.isArray(recommendation?.issues)
        ? []
        : recommendation.issues
            .slice(0, 100)
            .filter((issue) => Object.hasOwn(issueMessages, issue.code))
            .map((issue) => ({
              productName:
                issue.productId === null
                  ? null
                  : (names.find((product) => product.entity_id === issue.productId)?.name ??
                    "Product unavailable"),
              message: issueMessages[issue.code]
            })),
      reason: incomplete
        ? "The task is incomplete. Check source data, supplier offers and budget; uncertain actions will not be replayed."
        : underlying === "COMPLETED"
          ? "Purchase drafts are prepared, not submitted. Supplier submission requires separate approval and a connected delivery mechanism."
          : null,
      steps: task.plan.map((entry) => ({
        id: entry.id,
        label: "Prepare purchase drafts",
        status: journal.find((step) => step.step_id === entry.id)?.status ?? "NOT_STARTED"
      })),
      orders:
        records.length > 20
          ? []
          : records.map(({ record, supplier_name }) => ({
              id: record.id,
              supplierName: supplier_name ?? "Supplier unavailable",
              totalMinor: record.totalMinor,
              currency: record.currency,
              submissionStatus: "NOT_SUBMITTED",
              requiresSubmissionApproval: true,
              items: record.items.map((item) => ({
                productName:
                  names.find((product) => product.entity_id === item.productId)?.name ??
                  "Product unavailable",
                quantityMilli: item.quantityMilli,
                unit: record.units[item.productId] ?? "Unit unavailable",
                totalMinor: item.totalMinor
              }))
            })),
      evaluation: evidence.find((entry) => entry.stepId === "prepare")?.evaluation ?? null,
      experienceRetained: null
    };
  }
  async function drive(actor: Actor, task: BusinessTask) {
    authorizeSources(actor);
    let environment = await native((pool) => environments(pool, task.id).get(actor, task.id));
    if (!environment)
      environment = await native((pool) => environments(pool, task.id).create(actor, task.id));
    if (environment.instance.status === "CREATED")
      environment = await native((pool) =>
        environments(pool, task.id).transition(actor, task.id, environment!.revision, "READY")
      );
    if (environment.instance.status === "READY")
      environment = await native((pool) =>
        environments(pool, task.id).transition(actor, task.id, environment!.revision, "RUNNING")
      );
    if (environment.instance.status === "COMPLETED") {
      await runtime.recordVerifiedBusinessTaskExperience({ ...actor, taskId: task.id });
      await commitRuntime();
      return;
    }
    if (!["RUNNING", "VERIFYING"].includes(environment.instance.status)) return;
    const prior = await native((pool) => steps(pool).list(actor, task.id));
    if (prior.length === 0 && environment.instance.status === "RUNNING") {
      await executeBusinessTaskRootStep({
        ...actor,
        taskId: task.id,
        stepId: "prepare",
        expectedEnvironmentRevision: environment!.revision,
        manifest: inventoryReplenishmentEnvironment,
        tasks: { get: (...args) => native((pool) => tasks(pool).get(...args)) },
        steps: {
          claim: (...args) => native((pool) => steps(pool).claim(...args)),
          record: (...args) => native((pool) => steps(pool).record(...args))
        },
        environments: {
          get: (...args) => native((pool) => environments(pool, task.id).get(...args))
        },
        runtime,
        commitRuntime
      });
    } else if (
      prior.some((step) => ["RUNNING", "AWAITING_APPROVAL", "INCONCLUSIVE"].includes(step.status))
    ) {
      await native((pool) =>
        createPostgresBusinessTaskReconciler(pool, authorize).reconcile(
          actor,
          task.id,
          "prepare",
          environment!.revision
        )
      );
    }
    const recorded = await native((pool) => steps(pool).list(actor, task.id));
    if (recorded[0]?.status !== "VERIFYING") return;
    const report = await native((pool) =>
      createPostgresBusinessTaskVerifier(pool, authorize).verify({
        ...actor,
        taskId: task.id,
        stepId: "prepare"
      })
    );
    if (report.status !== "PASSED") return;
    environment = await native((pool) => environments(pool, task.id).get(actor, task.id));
    if (environment?.instance.status === "RUNNING")
      environment = await native((pool) =>
        environments(pool, task.id).transition(actor, task.id, environment!.revision, "VERIFYING")
      );
    if (environment?.instance.status === "VERIFYING")
      await native((pool) =>
        environments(pool, task.id).transition(actor, task.id, environment!.revision, "COMPLETED")
      );
    await runtime.recordVerifiedBusinessTaskExperience({ ...actor, taskId: task.id });
    await commitRuntime();
  }
  return {
    inspect,
    async handle(input) {
      const objective = parseInventoryTaskObjective(input.text);
      if (objective.kind === "OTHER") return null;
      authorizeSources(input);
      const parent = runtime.getConversation({
        sessionId: input.sessionId,
        conversationId: input.conversationId
      }).conversation;
      if (parent.activeShopId !== input.businessId)
        throw new Cp2Error(
          403,
          "business_task_conversation_mismatch",
          "Conversation belongs to another business."
        );
      if (objective.kind === "CLARIFY") return { text: objective.message, taskId: null };
      const { userId } = authorize({ ...input, permission: "business:read" });
      const taskId = stableUuid(`inventory-task:${input.businessId}:${userId}:${input.messageId}`);
      const effective = await runtime.getEffectiveRuntime({
        ...input,
        conversationId: input.conversationId
      });
      if (!effective.binding)
        return {
          text: "I could not start a durable inventory task because the agent runtime is unavailable. No purchase orders were prepared.",
          taskId: null
        };
      runtime.createConversation({
        sessionId: input.sessionId,
        kind: "personal",
        activeShopId: input.businessId,
        taskConversationId: taskId,
        taskParentConversationId: input.conversationId,
        title: "Inventory replenishment",
        runtimeBindingId: effective.binding.id
      });
      runtime.createRuntimeSession({ ...input, idempotencyKey: `business-task:${taskId}` });
      await commitRuntime();
      const task = await native((pool) =>
        tasks(pool).create(input, inventoryReplenishmentEnvironment, {
          taskId,
          objective: input.text,
          constraints: {
            budgetMinor: objective.budgetMinor,
            currency: objective.currency,
            horizonDays: objective.horizonDays
          },
          executionMode: "LIVE",
          steps: [
            {
              id: "prepare",
              capability: "procurement.prepare",
              input: { taskId },
              dependencies: [],
              expectedOutput:
                "Verified purchase drafts within the explicit budget; not submitted orders."
            }
          ]
        })
      );
      try {
        await drive(input, task);
      } catch (error) {
        if (error instanceof Cp2Error && [401, 403].includes(error.statusCode)) throw error;
        // Native claims and committed artifacts remain inspectable; never replay on an error.
        return {
          text: "The inventory task is incomplete. Its recorded state is available for review; no uncertain action was replayed.",
          taskId
        };
      }
      return {
        text: "Inventory task recorded. Review its verified purchase drafts and any incomplete requirements.",
        taskId
      };
    },
    async control(actor, taskId, revision, command) {
      authorizeSources(actor);
      const task = await native((pool) => tasks(pool).get(actor, taskId));
      if (!task) throw new Cp2Error(404, "business_task_not_found", "Task not found.");
      const current = await native((pool) => environments(pool, taskId).get(actor, taskId));
      if (!Number.isSafeInteger(revision) || revision !== (current?.revision ?? 0))
        throw new Cp2Error(409, "business_environment_conflict", "Environment revision is stale.");
      if (
        command === "RESUME" &&
        (!current || ["CREATED", "READY", "RUNNING", "VERIFYING"].includes(current.instance.status))
      ) {
        await drive(actor, task);
        return inspect(actor, taskId);
      }
      const next =
        command === "SUSPEND"
          ? "SUSPENDED"
          : command === "CANCEL"
            ? "CANCELLED"
            : (current?.instance.suspendedFrom ?? "RUNNING");
      await native((pool) => environments(pool, taskId).transition(actor, taskId, revision, next));
      if (command === "RESUME") await drive(actor, task);
      return inspect(actor, taskId);
    }
  };
}
