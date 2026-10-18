import type {
  RuntimeToolInputSchema,
  RuntimeToolName,
  RuntimeToolRisk
} from "../contracts/runtime.js";
import { runtimeToolRegistry } from "../registry/index.js";
import { validateRuntimeToolInput } from "../validation/runtime.js";
import type { BusinessEnvironmentExecutionMode, BusinessEnvironmentManifest } from "./contracts.js";
import { createBusinessEnvironmentRegistry } from "./registry.js";

export interface BusinessTaskPlanStep {
  id: string;
  capability: RuntimeToolName;
  input: Record<string, unknown>;
  inputSchema: RuntimeToolInputSchema;
  dependencies: string[];
  risk: RuntimeToolRisk;
  requiresApproval: boolean;
  expectedOutput: string;
  verificationPolicyId: string;
  idempotencyKey: string;
}

export interface BusinessTask {
  /** Existing handoff task identifier; no parallel task identity is minted. */
  id: string;
  businessId: string;
  actorId: string;
  environmentId: string;
  environmentVersion: string;
  /** Absent only on legacy tasks; new tasks pin the server-owned evaluation policy. */
  evaluationPolicyId?: string;
  objective: string;
  constraints: { budgetMinor: number | null; currency: string | null; horizonDays: number | null };
  allowedCapabilities: RuntimeToolName[];
  successCriteria: readonly ["ALL_STEPS_VERIFIED", "NO_CONSTRAINT_VIOLATIONS"];
  executionMode: BusinessEnvironmentExecutionMode;
  plan: BusinessTaskPlanStep[];
  createdAt: string;
}

export interface BusinessTaskStepProposal {
  id: string;
  capability: RuntimeToolName;
  input: Record<string, unknown>;
  dependencies: string[];
  expectedOutput: string;
}

/** Model proposals supply intent and arguments; policy metadata is always server-derived. */
export function compileBusinessTask(input: {
  taskId: string;
  businessId: string;
  actorId: string;
  objective: string;
  manifest: BusinessEnvironmentManifest;
  authorizedCapabilities: readonly RuntimeToolName[];
  executionMode: BusinessEnvironmentExecutionMode;
  constraints: BusinessTask["constraints"];
  steps: readonly BusinessTaskStepProposal[];
  now: Date;
}): BusinessTask {
  const registry = createBusinessEnvironmentRegistry([input.manifest]);
  if (
    [input.taskId, input.businessId, input.actorId].some((id) => !id.trim() || id.length > 200) ||
    !input.objective.trim() ||
    input.objective.length > 4000 ||
    !Number.isFinite(input.now.getTime()) ||
    input.steps.length === 0 ||
    input.steps.length > 20
  ) {
    throw new Error("Invalid or unbounded business task.");
  }
  if (input.executionMode !== input.manifest.executionMode && input.executionMode !== "READ_ONLY") {
    throw new Error("Task execution mode cannot widen its environment.");
  }
  const constraints = input.constraints;
  if (
    (constraints.budgetMinor !== null &&
      (!Number.isSafeInteger(constraints.budgetMinor) || constraints.budgetMinor < 0)) ||
    (constraints.currency !== null && !/^[A-Z]{3}$/u.test(constraints.currency)) ||
    (constraints.budgetMinor === null) !== (constraints.currency === null) ||
    (constraints.horizonDays !== null &&
      (!Number.isInteger(constraints.horizonDays) ||
        constraints.horizonDays < 1 ||
        constraints.horizonDays > 365))
  ) {
    throw new Error("Invalid business task constraints.");
  }
  const seen = new Set<string>();
  const plan = input.steps.map((step): BusinessTaskPlanStep => {
    registry.assertCapability(input.manifest.id, input.manifest.version, step.capability);
    const definition = runtimeToolRegistry[step.capability];
    if (
      !input.authorizedCapabilities.includes(step.capability) ||
      (input.executionMode === "READ_ONLY" && !definition.readOnly)
    ) {
      throw new Error("Task capability is not authorized.");
    }
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(step.id) ||
      seen.has(step.id) ||
      step.dependencies.some((id) => !seen.has(id)) ||
      new Set(step.dependencies).size !== step.dependencies.length ||
      !step.expectedOutput.trim() ||
      step.expectedOutput.length > 1000
    ) {
      throw new Error("Invalid task step or dependency graph.");
    }
    if (!step.input || typeof step.input !== "object" || Array.isArray(step.input)) {
      throw new Error("Task inputs must be objects.");
    }
    // Existing schema required flags are prompt metadata; semantic validation remains canonical.
    for (const [key, value] of Object.entries(step.input)) {
      const schema = definition.inputSchema.properties[key];
      if (!schema) throw new Error(`Unknown task argument: ${key}`);
      const matches =
        schema.type === "array"
          ? Array.isArray(value)
          : schema.type === "object"
            ? value !== null && typeof value === "object" && !Array.isArray(value)
            : typeof value === schema.type;
      if (!matches || (typeof value === "number" && !Number.isFinite(value))) {
        throw new Error(`Invalid task argument: ${key}`);
      }
    }
    const serialized = JSON.stringify(step.input);
    if (serialized.length > 16000) throw new Error("Task step input exceeds resource limits.");
    const validation = validateRuntimeToolInput(step.capability, step.input);
    if (!validation.ok) throw new Error(validation.errors.join(" "));
    const idempotencyKey = [input.businessId, input.taskId, step.id]
      .map(encodeURIComponent)
      .join(":");
    if (idempotencyKey.length > 200)
      throw new Error("Task idempotency key exceeds resource limits.");
    seen.add(step.id);
    return {
      id: step.id,
      capability: step.capability,
      input: structuredClone(step.input),
      inputSchema: structuredClone(definition.inputSchema),
      dependencies: [...step.dependencies],
      risk: definition.risk,
      requiresApproval: definition.requiresConfirmation,
      expectedOutput: step.expectedOutput.trim(),
      verificationPolicyId: input.manifest.verificationPolicyId,
      idempotencyKey
    };
  });
  return {
    id: input.taskId,
    businessId: input.businessId,
    actorId: input.actorId,
    environmentId: input.manifest.id,
    environmentVersion: input.manifest.version,
    evaluationPolicyId: input.manifest.evaluationPolicyId,
    objective: input.objective.trim(),
    constraints: structuredClone(constraints),
    allowedCapabilities: [...new Set(plan.map((step) => step.capability))],
    successCriteria: ["ALL_STEPS_VERIFIED", "NO_CONSTRAINT_VIOLATIONS"],
    executionMode: input.executionMode,
    plan,
    createdAt: input.now.toISOString()
  };
}
