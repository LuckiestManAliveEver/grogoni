import type {
  BusinessEnvironmentCompletionEvidence,
  BusinessEnvironmentInstance,
  BusinessEnvironmentStatus,
  EnvironmentVerificationCategory
} from "./contracts.js";

const transitions: Record<BusinessEnvironmentStatus, readonly BusinessEnvironmentStatus[]> = {
  CREATED: ["READY", "FAILED", "CANCELLED", "EXPIRED"],
  READY: ["RUNNING", "SUSPENDED", "FAILED", "CANCELLED", "EXPIRED"],
  RUNNING: ["AWAITING_APPROVAL", "VERIFYING", "SUSPENDED", "FAILED", "CANCELLED", "EXPIRED"],
  AWAITING_APPROVAL: ["RUNNING", "SUSPENDED", "FAILED", "CANCELLED", "EXPIRED"],
  VERIFYING: ["COMPLETED", "SUSPENDED", "FAILED", "CANCELLED", "EXPIRED"],
  SUSPENDED: ["READY", "RUNNING", "AWAITING_APPROVAL", "VERIFYING", "CANCELLED", "EXPIRED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: []
};

const requiredChecks: readonly EnvironmentVerificationCategory[] = [
  "STRUCTURAL",
  "AUTHORIZATION",
  "CONSTRAINT",
  "EXECUTION",
  "PERSISTENCE",
  "OUTCOME"
];

/** Pure transition validation; callers must persist the result atomically with task state. */
export function transitionBusinessEnvironment(
  instance: BusinessEnvironmentInstance,
  next: BusinessEnvironmentStatus,
  completion?: BusinessEnvironmentCompletionEvidence
): BusinessEnvironmentInstance {
  if (!transitions[instance.status]?.includes(next)) {
    throw new Error(`Invalid environment transition: ${instance.status} -> ${next}`);
  }
  if (
    instance.status === "SUSPENDED" &&
    next !== "CANCELLED" &&
    next !== "EXPIRED" &&
    next !== instance.suspendedFrom
  ) {
    throw new Error("Environment must resume its suspended state.");
  }
  if (next === "COMPLETED") {
    if (
      !completion ||
      completion.taskId !== instance.taskId ||
      completion.environmentInstanceId !== instance.id ||
      !completion.stateVersion.trim() ||
      !["COMMITTED", "NOT_REQUIRED"].includes(completion.durability) ||
      (instance.executionMode === "LIVE" && completion.durability !== "COMMITTED") ||
      completion.checks.some((check) => check.status !== "PASSED") ||
      requiredChecks.some(
        (category) =>
          !completion.checks.some(
            (check) =>
              check.category === category &&
              check.status === "PASSED" &&
              check.evidenceRefs.length > 0 &&
              check.evidenceRefs.every((ref) => ref.trim().length > 0)
          )
      )
    ) {
      throw new Error("Environment completion requires verified, durable task evidence.");
    }
  }
  return {
    ...instance,
    status: next,
    suspendedFrom:
      next === "SUSPENDED"
        ? (instance.status as BusinessEnvironmentInstance["suspendedFrom"])
        : null
  };
}

export function assertBusinessEnvironmentRunning(instance: BusinessEnvironmentInstance): void {
  if (instance.status !== "RUNNING") {
    throw new Error(`Environment cannot execute actions while ${instance.status}.`);
  }
}
