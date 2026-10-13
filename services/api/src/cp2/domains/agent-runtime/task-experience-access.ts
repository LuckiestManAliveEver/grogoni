import type { RuntimeExperience } from "@grogoni/shared-types";
import type { AgentRuntimeDomainDeps } from "./domain-deps.js";
import type { BusinessAgentProfileSummary } from "./shared.js";
import { taskExperienceContextKey } from "./experience-source-evidence.js";
import { recordVerifiedTaskExperience, verifiedTaskAdvice } from "./task-experience.js";

export interface TaskExperienceInput {
  sessionId: string | null;
  businessId: string;
  taskId: string;
  now?: Date;
}
interface State {
  experiences: Map<string, RuntimeExperience>;
  deps: Pick<AgentRuntimeDomainDeps, "requireAuthorizedSession" | "businessTaskEvaluations">;
  profile: (businessId: string, now: Date) => BusinessAgentProfileSummary;
}

function authorize(state: State, input: TaskExperienceInput, now: Date) {
  for (const permission of [
    "business:read",
    "product:read",
    "invoice:read",
    "supplier:read",
    "import:write"
  ] as const)
    state.deps.requireAuthorizedSession(input.sessionId, input.businessId, permission, now);
}

export async function retainCompletedTaskExperience(
  state: State,
  input: TaskExperienceInput
): Promise<RuntimeExperience | null> {
  const now = input.now ?? new Date();
  authorize(state, input, now);
  const proof = await state.deps.businessTaskEvaluations?.completedTask?.(input, input.taskId);
  if (!proof) return null;
  const profile = state.profile(input.businessId, now);
  if (
    !profile.memoryPolicy.reusableWorkflowMemoryEnabled ||
    proof.instance.agentId !== profile.agentId
  )
    return null;
  return recordVerifiedTaskExperience(state.experiences, proof, now);
}

export async function retrieveBusinessTaskAdvice(
  state: State,
  input: TaskExperienceInput
): Promise<RuntimeExperience[]> {
  const now = input.now ?? new Date();
  authorize(state, input, now);
  const task = await state.deps.businessTaskEvaluations?.taskContext?.(input, input.taskId);
  if (!task) return [];
  const profile = state.profile(input.businessId, now);
  if (!profile.memoryPolicy.reusableWorkflowMemoryEnabled) return [];
  return verifiedTaskAdvice(
    state.experiences.values(),
    input.businessId,
    profile.agentId,
    task.environmentId,
    task.environmentVersion,
    taskExperienceContextKey(task)
  );
}
