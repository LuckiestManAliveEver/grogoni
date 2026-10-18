import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileBusinessTask,
  type BusinessEnvironmentInstance,
  type EnvironmentVerificationCategory
} from "@grogoni/tool-core";
import type { RuntimeExperience } from "@grogoni/shared-types";
import type { CompletedBusinessTaskEvidence } from "./business-task-evaluation-reader.js";
import type { BusinessTaskVerificationReport } from "./business-task-verification.js";
import { evaluateBusinessTaskStep } from "./business-task-evaluation.js";
import {
  experienceSourceEvidence,
  independentSourceMasks,
  taskExperienceContextKey
} from "./experience-source-evidence.js";
import { recordVerifiedTaskExperience, verifiedTaskAdvice } from "./task-experience.js";

const now = new Date("2026-10-13T00:00:00Z");
function proof(id: string, invoices: string[], budget = 1500000): CompletedBusinessTaskEvidence {
  const task = compileBusinessTask({
    taskId: id,
    businessId: "business",
    actorId: "owner",
    objective: "Prepare replenishment drafts",
    manifest: {
      id: "grogoni.retail.inventory",
      version: "1.0.0",
      name: "Inventory",
      description: "Fixture",
      domain: "retail",
      capabilities: ["procurement.prepare"],
      observationSchema: {},
      verificationPolicyId: "grogoni.inventory.replenishment.v1",
      evaluationPolicyId: "grogoni.inventory.outcomes.v1",
      executionMode: "LIVE",
      status: "ACTIVE"
    },
    authorizedCapabilities: ["procurement.prepare"],
    executionMode: "LIVE",
    constraints: { budgetMinor: budget, currency: "KES", horizonDays: 3 },
    steps: [
      {
        id: "prepare",
        capability: "procurement.prepare",
        input: { taskId: id },
        dependencies: [],
        expectedOutput: "Drafts"
      }
    ],
    now: new Date(now.getTime() - 60000)
  });
  const instance: BusinessEnvironmentInstance = {
    id: randomUUID(),
    businessId: task.businessId,
    taskId: id,
    agentId: "agent",
    runtimeInstanceId: "runtime",
    runtimeSessionId: "session",
    environmentId: task.environmentId,
    environmentVersion: task.environmentVersion,
    executionMode: "LIVE",
    status: "COMPLETED",
    suspendedFrom: null
  };
  const categories: EnvironmentVerificationCategory[] = [
    "STRUCTURAL",
    "AUTHORIZATION",
    "CONSTRAINT",
    "EXECUTION",
    "PERSISTENCE",
    "OUTCOME"
  ];
  const report: BusinessTaskVerificationReport = {
    id: randomUUID(),
    taskId: id,
    stepId: "prepare",
    businessId: task.businessId,
    actorId: "owner",
    runtimeTurnId: `turn-${id}`,
    stateVersion: "state",
    policyId: "grogoni.inventory.replenishment.v1",
    status: "PASSED",
    checkedAt: new Date(now.getTime() - 1000).toISOString(),
    checks: categories.map((category) => ({
      category,
      status: "PASSED",
      reason: "Fixture",
      evidenceRefs: ["committed"]
    })),
    experienceEvidence: {
      ...experienceSourceEvidence(task.businessId, invoices),
      contextKey: taskExperienceContextKey(task)
    }
  };
  report.evaluation = evaluateBusinessTaskStep(task, instance, report, null);
  return { task, instance, report };
}
describe("verified business task experience eligibility", () => {
  it("promotes the existing RuntimeExperience only after disjoint business-source episodes", () => {
    const map = new Map<string, RuntimeExperience>();
    const first = recordVerifiedTaskExperience(map, proof("one", ["invoice-one"]), now)!;
    expect(first.validationState).toBe("candidate");
    expect(first.corroborationCount).toBe(1);
    const second = recordVerifiedTaskExperience(map, proof("two", ["invoice-two"]), now)!;
    expect(second.id).toBe(first.id);
    expect(second.validationState).toBe("validated");
    expect(second.corroborationCount).toBe(2);
    expect(map.size).toBe(1);
    expect(second.lesson).toContain("submission still requires approval");
  });
  it("deduplicates replay after JSON rehydration without refreshing retention", () => {
    const map = new Map<string, RuntimeExperience>();
    const one = proof("one", ["invoice-one"]);
    recordVerifiedTaskExperience(map, one, now);
    recordVerifiedTaskExperience(map, proof("two", ["invoice-two"]), now);
    const fresh = new Map<string, RuntimeExperience>(JSON.parse(JSON.stringify([...map])));
    const before = structuredClone([...fresh.values()][0]!);
    expect(recordVerifiedTaskExperience(fresh, one, new Date(now.getTime() + 1000))).toEqual(
      before
    );
  });
  it("does not count a new task/turn/report observing the same invoices", () => {
    const map = new Map<string, RuntimeExperience>();
    const first = recordVerifiedTaskExperience(map, proof("one", ["invoice-one"]), now)!;
    const repeat = recordVerifiedTaskExperience(
      map,
      proof("new-turn", ["invoice-one"]),
      new Date(now.getTime() + 1000)
    );
    expect(repeat).toEqual(first);
  });
  it("does not treat partially overlapping sources or hash collisions as independent", () => {
    const left = experienceSourceEvidence("business", ["invoice-one", "shared"]);
    const right = experienceSourceEvidence("business", ["invoice-two", "shared"]);
    expect(independentSourceMasks(left.mask, right.mask)).toBe(false);
    expect(independentSourceMasks(left.mask, left.mask)).toBe(false);
    expect(independentSourceMasks("0".repeat(2048), right.mask)).toBe(false);
    const map = new Map<string, RuntimeExperience>();
    recordVerifiedTaskExperience(map, proof("one", ["invoice-one", "shared"]), now);
    expect(
      recordVerifiedTaskExperience(map, proof("two", ["invoice-two", "shared"]), now)
        ?.corroborationCount
    ).toBe(1);
  });
  it("keeps different budgets as distinct candidates", () => {
    const map = new Map<string, RuntimeExperience>();
    recordVerifiedTaskExperience(map, proof("one", ["invoice-one"]), now);
    recordVerifiedTaskExperience(map, proof("two", ["invoice-two"], 1000000), now);
    expect(map.size).toBe(2);
    expect([...map.values()].every((entry) => entry.validationState === "candidate")).toBe(true);
  });
  it.each([
    "not-completed",
    "failed",
    "inconclusive",
    "missing-check",
    "bad-mask",
    "no-sales",
    "wrong-scope",
    "stale",
    "unsupported-policy"
  ])("rejects ineligible evidence: %s", (kind) => {
    const evidence = proof("one", ["invoice-one"]);
    if (kind === "not-completed") evidence.instance.status = "RUNNING";
    if (kind === "failed") evidence.report.status = "FAILED";
    if (kind === "inconclusive") evidence.report.evaluation!.executionSuccess = null;
    if (kind === "missing-check") evidence.report.checks.pop();
    if (kind === "bad-mask") evidence.report.experienceEvidence!.mask = "0".repeat(2048);
    if (kind === "no-sales") evidence.report.experienceEvidence!.count = 0;
    if (kind === "wrong-scope") evidence.report.actorId = "other";
    if (kind === "stale") evidence.report.checkedAt = "2026-01-01T00:00:00Z";
    if (kind === "unsupported-policy") evidence.task.evaluationPolicyId = "other";
    const map = new Map<string, RuntimeExperience>();
    expect(recordVerifiedTaskExperience(map, evidence, now)).toBeNull();
    expect(map.size).toBe(0);
  });
  it("retrieves only validated, exact-scoped advice and returns detached values", () => {
    const map = new Map<string, RuntimeExperience>();
    const one = proof("one", ["invoice-one"]);
    recordVerifiedTaskExperience(map, one, now);
    expect(
      verifiedTaskAdvice(
        map.values(),
        "business",
        "agent",
        one.task.environmentId,
        "1.0.0",
        taskExperienceContextKey(one.task)
      )
    ).toEqual([]);
    recordVerifiedTaskExperience(map, proof("two", ["invoice-two"]), now);
    const context = taskExperienceContextKey(one.task);
    const matches = verifiedTaskAdvice(
      map.values(),
      "business",
      "agent",
      one.task.environmentId,
      "1.0.0",
      context
    );
    expect(matches).toHaveLength(1);
    for (const [business, agent, version, key] of [
      ["other", "agent", "1.0.0", context],
      ["business", "other", "1.0.0", context],
      ["business", "agent", "2.0.0", context],
      ["business", "agent", "1.0.0", "other"]
    ])
      expect(
        verifiedTaskAdvice(map.values(), business!, agent!, one.task.environmentId, version!, key!)
      ).toEqual([]);
    matches[0]!.environmentScope!.taskIds.push("mutated");
    expect([...map.values()][0]!.environmentScope!.taskIds).not.toContain("mutated");
  });
});
