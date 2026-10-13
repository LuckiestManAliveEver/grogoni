import { randomUUID } from "node:crypto";
import type { RuntimeExperience } from "@grogoni/shared-types";
import type { CompletedBusinessTaskEvidence } from "./business-task-evaluation-reader.js";
import {
  independentSourceMasks,
  mergeSourceMasks,
  taskExperienceContextKey
} from "./experience-source-evidence.js";
import { runtimeExperienceValidationThreshold } from "./shared.js";

export function recordVerifiedTaskExperience(
  experiences: Map<string, RuntimeExperience>,
  proof: CompletedBusinessTaskEvidence,
  now: Date
): RuntimeExperience | null {
  const { task, instance, report } = proof;
  const source = report.experienceEvidence;
  const age = now.getTime() - Date.parse(report.checkedAt);
  if (
    !Number.isFinite(now.getTime()) ||
    instance.status !== "COMPLETED" ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 86400_000 ||
    task.plan.length !== 1 ||
    task.plan[0]?.capability !== "procurement.prepare" ||
    task.plan[0]?.verificationPolicyId !== report.policyId ||
    task.environmentId !== "grogoni.retail.inventory" ||
    task.environmentVersion !== "1.0.0" ||
    task.evaluationPolicyId !== "grogoni.inventory.outcomes.v1" ||
    report.status !== "PASSED" ||
    report.evaluation?.executionSuccess !== true ||
    report.checks.length !== 6 ||
    !["STRUCTURAL", "AUTHORIZATION", "CONSTRAINT", "EXECUTION", "PERSISTENCE", "OUTCOME"].every(
      (category) =>
        report.checks.filter((entry) => entry.category === category && entry.status === "PASSED")
          .length === 1
    ) ||
    report.taskId !== task.id ||
    report.businessId !== task.businessId ||
    report.actorId !== task.actorId ||
    instance.taskId !== task.id ||
    instance.businessId !== task.businessId ||
    instance.environmentId !== task.environmentId ||
    instance.environmentVersion !== task.environmentVersion ||
    !source ||
    !Number.isInteger(source.count) ||
    source.count < 1 ||
    source.count > 10000 ||
    source.contextKey !== taskExperienceContextKey(task) ||
    !/^[0-9a-f]{64}$/u.test(source.fingerprint) ||
    !/^[0-9a-f]{64}$/u.test(source.contextKey) ||
    !/^[0-9a-f]{2048}$/u.test(source.mask) ||
    !/[1-9a-f]/u.test(source.mask)
  )
    return null;
  const lessonKey = `verified-replenishment:${source.contextKey}`;
  const existing = [...experiences.values()].find(
    (entry) =>
      entry.shopId === task.businessId &&
      entry.tenantId === task.businessId &&
      entry.agentId === instance.agentId &&
      entry.lessonKey === lessonKey &&
      entry.environmentScope?.environmentId === task.environmentId &&
      entry.environmentScope.environmentVersion === task.environmentVersion &&
      entry.validationState !== "deprecated"
  );
  const scope = existing?.environmentScope;
  if (
    existing &&
    (!scope ||
      scope.taskIds.includes(task.id) ||
      scope.sourceFingerprints.includes(source.fingerprint) ||
      scope.taskIds.length >= 64 ||
      !independentSourceMasks(scope.sourceMask, source.mask))
  )
    return structuredClone(existing);
  const count = (existing?.corroborationCount ?? 0) + 1;
  const experience: RuntimeExperience = {
    id: existing?.id ?? randomUUID(),
    tenantId: task.businessId,
    shopId: task.businessId,
    agentId: instance.agentId,
    taskType: "unknown",
    lessonKey,
    recipeId: null,
    recipeVersion: null,
    situation:
      "Budgeted inventory replenishment with committed sales and owner-confirmed supplier quotes.",
    lesson:
      "Recheck current inventory, confirmed sales, exact product units and all-in supplier prices before preparing budgeted drafts. Draft preparation does not establish delivery or prevent stockouts; submission still requires approval.",
    evidenceRefs: [...(existing?.evidenceRefs ?? []), `verification:${report.id}`],
    toolSequence: ["procurement.prepare"],
    resultType: "procurement.prepare",
    verificationResult: "PASSED",
    outcome: "successful",
    validationState: count >= runtimeExperienceValidationThreshold ? "validated" : "candidate",
    corroborationCount: count,
    corroboratingTurnIds: [...(existing?.corroboratingTurnIds ?? []), report.runtimeTurnId],
    sourceTurnId: report.runtimeTurnId,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    deprecatedAt: null,
    environmentScope: {
      environmentId: task.environmentId,
      environmentVersion: task.environmentVersion,
      contextKey: source.contextKey,
      sourceMask: scope ? mergeSourceMasks(scope.sourceMask, source.mask) : source.mask,
      sourceFingerprints: [...(scope?.sourceFingerprints ?? []), source.fingerprint],
      taskIds: [...(scope?.taskIds ?? []), task.id]
    }
  };
  experiences.set(experience.id, experience);
  return structuredClone(experience);
}

export function verifiedTaskAdvice(
  experiences: Iterable<RuntimeExperience>,
  businessId: string,
  agentId: string,
  environmentId: string,
  environmentVersion: string,
  contextKey: string
): RuntimeExperience[] {
  return [...experiences]
    .filter(
      (entry) =>
        entry.validationState === "validated" &&
        entry.shopId === businessId &&
        entry.tenantId === businessId &&
        entry.agentId === agentId &&
        entry.environmentScope?.environmentId === environmentId &&
        entry.environmentScope.environmentVersion === environmentVersion &&
        entry.environmentScope.contextKey === contextKey
    )
    .slice(0, 5)
    .map((entry) => structuredClone(entry));
}
