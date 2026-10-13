import type { BusinessTask, BusinessEnvironmentInstance } from "@grogoni/tool-core";
import type { EnvironmentEvaluation, RuntimeTurnSummary } from "@grogoni/shared-types";
import type { BusinessTaskVerificationReport } from "./business-task-verification.js";
import { runtimeExecutedModelId, runtimeModelEvidence } from "./runtime-model-evidence.js";

/** Derived only from an independent report, not the proposing model's success claim. */
export function evaluateBusinessTaskStep(
  task: BusinessTask,
  instance: BusinessEnvironmentInstance,
  report: BusinessTaskVerificationReport,
  turn: RuntimeTurnSummary | null
): EnvironmentEvaluation {
  const replenishment = report.policyId === "grogoni.inventory.replenishment.v1";
  const planned = task.plan.find((step) => step.id === report.stepId);
  const supported =
    task.environmentId === "grogoni.retail.inventory" &&
    task.environmentVersion === "1.0.0" &&
    task.evaluationPolicyId === "grogoni.inventory.outcomes.v1" &&
    planned?.verificationPolicyId === report.policyId &&
    report.taskId === task.id &&
    report.businessId === task.businessId &&
    report.actorId === task.actorId &&
    instance.taskId === task.id &&
    instance.businessId === task.businessId &&
    instance.environmentId === task.environmentId &&
    instance.environmentVersion === task.environmentVersion &&
    (replenishment || report.policyId === "grogoni.inventory.read.v1");
  const check = (category: string) => {
    const matches = report.checks.filter((entry) => entry.category === category);
    return matches.length === 1 ? matches[0]!.status : "INCONCLUSIVE";
  };
  const complete =
    supported &&
    report.status === "PASSED" &&
    ["STRUCTURAL", "AUTHORIZATION", "CONSTRAINT", "EXECUTION", "PERSISTENCE", "OUTCOME"].every(
      (category) => check(category) === "PASSED"
    );
  const failed =
    report.status === "FAILED" || report.checks.some((entry) => entry.status === "FAILED");
  const executionSuccess = complete ? true : failed ? false : null;
  const outcomeStatus = complete
    ? replenishment
      ? "PENDING"
      : "VERIFIED"
    : failed
      ? "FAILED"
      : "INCONCLUSIVE";
  const model = turn === null ? null : runtimeModelEvidence(turn);
  const nonnegative = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const elapsed = Date.parse(report.checkedAt) - Date.parse(task.createdAt);
  const metric = (category: string) =>
    !supported ? null : check(category) === "PASSED" ? 1 : check(category) === "FAILED" ? 0 : null;
  return {
    verificationId: report.id,
    taskId: task.id,
    stepId: report.stepId,
    environmentId: task.environmentId,
    environmentVersion: task.environmentVersion,
    evaluationPolicyId: task.evaluationPolicyId ?? null,
    executionSuccess,
    constraintViolations: metric("CONSTRAINT") === null ? null : metric("CONSTRAINT") === 1 ? 0 : 1,
    executionAccuracy: metric("OUTCOME"),
    toolCalls: turn?.telemetry?.filter((entry) => entry.state === "tool.executed").length ?? null,
    toolEfficiency: null,
    latencyMs: nonnegative(elapsed),
    modelLatencyMs: nonnegative(model?.durationMs),
    promptTokens: nonnegative(model?.promptTokens),
    completionTokens: nonnegative(model?.completionTokens),
    humanInterventions: turn?.verification
      ? turn.verification.confirmationSatisfied === true
        ? 1
        : 0
      : null,
    // No stockout/forecast reward is inferred from preparing a draft or model prose.
    reward: null,
    outcomeStatus,
    inventory: supported
      ? {
          budgetCompliance: replenishment ? metric("CONSTRAINT") : null,
          orderAccuracy: replenishment ? metric("OUTCOME") : null,
          forecastAccuracy: null,
          stockoutReduction: null
        }
      : null,
    event: {
      id: `business-verification:${report.id}`,
      tenantId: task.businessId,
      shopId: task.businessId,
      agentId: instance.agentId,
      sessionId: instance.runtimeSessionId,
      messageId: null,
      eventType: "business_task_verification",
      outcome:
        executionSuccess === true ? "success" : executionSuccess === false ? "failure" : "partial",
      score: executionSuccess === null ? null : executionSuccess ? 1 : 0,
      reason: complete
        ? "Independent verification passed; delayed business reward is not established."
        : "Independent business outcome is failed, unsupported or inconclusive.",
      metadata: {
        taskId: task.id,
        stepId: report.stepId,
        environmentId: task.environmentId,
        environmentVersion: task.environmentVersion,
        verificationId: report.id,
        outcomeStatus,
        evaluationPolicyId: task.evaluationPolicyId ?? null,
        reward: null
      },
      runtimeVersion: turn?.runtimeVersion ?? 0,
      modelId: turn === null ? null : runtimeExecutedModelId(turn),
      createdAt: report.checkedAt
    }
  };
}
