import type { BusinessEnvironmentManifest } from "@grogoni/tool-core";
import { createBusinessEnvironmentRegistry, runtimeToolRegistry } from "@grogoni/tool-core";
import type { Cp2Store } from "../../store.js";
import { Cp2Error } from "../../cp2-error.js";
import type { createPostgresBusinessTaskStore } from "./business-task-store.js";
import type { createPostgresBusinessTaskStepStore } from "./business-task-step-store.js";

/** Composes the canonical runtime; deliberately not exposed until verification/approval recovery exist. */
export async function executeBusinessTaskRootStep(input: {
  sessionId: string | null;
  businessId: string;
  taskId: string;
  stepId: string;
  expectedEnvironmentRevision: number;
  manifest: BusinessEnvironmentManifest;
  tasks: ReturnType<typeof createPostgresBusinessTaskStore>;
  steps: ReturnType<typeof createPostgresBusinessTaskStepStore>;
  runtime: Pick<Cp2Store, "createRuntimeTurn" | "getConversation">;
  /** Must await the authoritative runtime write, not just queue a snapshot. */
  commitRuntime: () => Promise<void>;
}) {
  const actor = { sessionId: input.sessionId, businessId: input.businessId };
  const task = await input.tasks.get(actor, input.taskId);
  if (!task) throw new Cp2Error(404, "business_task_not_found", "Task not found.");
  const conversation = input.runtime.getConversation({
    sessionId: input.sessionId,
    conversationId: task.id
  });
  if (conversation.conversation.activeShopId !== task.businessId) {
    throw new Cp2Error(
      403,
      "business_task_conversation_mismatch",
      "Conversation is not scoped to this business."
    );
  }
  if (
    input.manifest.id !== task.environmentId ||
    input.manifest.version !== task.environmentVersion
  ) {
    throw new Cp2Error(
      409,
      "business_task_environment_mismatch",
      "Pinned environment is unavailable."
    );
  }
  const step = task.plan.find((candidate) => candidate.id === input.stepId);
  if (!step) throw new Cp2Error(404, "business_task_step_not_found", "Step not found.");
  createBusinessEnvironmentRegistry([input.manifest]).assertCapability(
    task.environmentId,
    task.environmentVersion,
    step.capability
  );
  // Simulation must never accidentally dispatch into live domain operations.
  if (task.executionMode === "SIMULATION") {
    throw new Cp2Error(
      409,
      "business_task_simulation_unavailable",
      "Isolated simulation is not configured."
    );
  }
  if (task.executionMode === "READ_ONLY" && !runtimeToolRegistry[step.capability].readOnly) {
    throw new Cp2Error(
      409,
      "business_task_read_only",
      "Read-only tasks cannot mutate business data."
    );
  }
  const claim = await input.steps.claim(actor, task.id, step.id, input.expectedEnvironmentRevision);
  try {
    const result = await input.runtime.createRuntimeTurn({
      ...actor,
      conversationId: task.id,
      message: task.objective,
      plannedStep: step
    });
    await input.commitRuntime();
    const status =
      result.turn.status === "needs_confirmation"
        ? "AWAITING_APPROVAL"
        : result.turn.status === "completed"
          ? "VERIFYING"
          : "FAILED";
    return await input.steps.record(actor, task.id, step.id, claim.claim_id, {
      status,
      runtimeTurnId: result.turn.id,
      observation: {
        schemaVersion: "1.0.0",
        businessId: task.businessId,
        taskId: task.id,
        stepId: step.id,
        capability: step.capability,
        observedAt: result.turn.createdAt,
        source: { kind: "CANONICAL_RUNTIME_TURN", id: result.turn.id },
        runtimeStatus: result.turn.status,
        context: result.turn.context,
        // Full results remain in the canonical turn; model prose is not verification evidence.
        toolResultRef: result.turn.toolResult === null ? null : result.turn.id,
        verificationStatus: "NOT_VERIFIED"
      }
    });
  } catch (error) {
    // A throw can follow a successful external write. Never classify it as safe to replay.
    await input.steps
      .record(actor, task.id, step.id, claim.claim_id, {
        status: "INCONCLUSIVE",
        runtimeTurnId: null,
        observation: {
          schemaVersion: "1.0.0",
          verificationStatus: "INCONCLUSIVE",
          reason:
            "Execution or persistence acknowledgement failed; authoritative reconciliation required."
        }
      })
      .catch(() => undefined);
    // If even the uncertainty write fails, the original RUNNING claim still prevents replay.
    throw error;
  }
}
