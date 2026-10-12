import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BusinessTask, BusinessTaskStepProposal } from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import {
  parseRequestBody,
  parseString,
  parseStringArray,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";
import type { createPostgresBusinessTaskStore } from "./business-task-store.js";
import { businessEnvironmentRegistry } from "./business-environment-registry.js";

export type BusinessTaskStore = ReturnType<typeof createPostgresBusinessTaskStore>;

export function registerBusinessTaskRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  tasks?: BusinessTaskStore,
  registry = businessEnvironmentRegistry
): void {
  function actor(request: FastifyRequest<{ Params: BusinessParams }>) {
    const value = {
      sessionId: readSessionCookie(request.headers.cookie),
      businessId: request.params.businessId
    };
    store.authorizeBusinessPermission({ ...value, permission: "business:read" });
    return value;
  }
  function repository(): BusinessTaskStore {
    if (!tasks)
      throw new Cp2Error(
        503,
        "business_tasks_require_postgres",
        "Business tasks require durable storage."
      );
    return tasks;
  }
  app.get(
    "/businesses/:businessId/runtime/tasks",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        const principal = actor(request);
        return await repository().list(principal);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get(
    "/businesses/:businessId/runtime/tasks/:taskId",
    async (request: FastifyRequest<{ Params: BusinessParams & { taskId: string } }>, reply) => {
      try {
        const principal = actor(request);
        const task = await repository().get(principal, request.params.taskId);
        if (!task)
          throw new Cp2Error(404, "business_task_not_found", "Business task was not found.");
        return task;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post(
    "/businesses/:businessId/runtime/tasks",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) => {
      try {
        const principal = actor(request);
        const repo = repository();
        const body = parseRequestBody(request.body);
        const taskId = parseString(body.taskId, "taskId");
        const conversation = store.getConversation({
          sessionId: principal.sessionId,
          conversationId: taskId
        }).conversation;
        if (conversation.activeShopId !== principal.businessId) {
          throw new Cp2Error(
            403,
            "business_task_conversation_mismatch",
            "Task conversation belongs to a different business."
          );
        }
        const manifest = registry.get(
          parseString(body.environmentId, "environmentId"),
          parseString(body.environmentVersion, "environmentVersion")
        );
        if (!manifest || manifest.status !== "ACTIVE") {
          throw new Cp2Error(
            409,
            "business_environment_unavailable",
            "This business environment is not available."
          );
        }
        if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 20) {
          throw new Cp2Error(
            400,
            "business_task_steps_invalid",
            "Task needs between one and twenty steps."
          );
        }
        const steps: BusinessTaskStepProposal[] = body.steps.map((value) => {
          const step = parseRequestBody(value);
          const capability = parseString(step.capability, "capability");
          const definition = registry
            .capabilityDefinitions(manifest.id, manifest.version)
            .find((candidate) => candidate.name === capability);
          if (!definition)
            throw new Cp2Error(
              400,
              "business_task_capability_invalid",
              "Task capability is unavailable."
            );
          return {
            id: parseString(step.id, "step.id"),
            capability: definition.name,
            input: parseRequestBody(step.input),
            dependencies: parseStringArray(step.dependencies, "dependencies", 20),
            expectedOutput: parseString(step.expectedOutput, "expectedOutput")
          };
        });
        const constraints = parseRequestBody(body.constraints);
        const budgetMinor = constraints.budgetMinor ?? null;
        const currency = constraints.currency ?? null;
        const horizonDays = constraints.horizonDays ?? null;
        if (
          (budgetMinor !== null && typeof budgetMinor !== "number") ||
          (currency !== null && typeof currency !== "string") ||
          (horizonDays !== null && typeof horizonDays !== "number")
        ) {
          throw new Cp2Error(400, "business_task_constraints_invalid", "Invalid task constraints.");
        }
        const executionMode = parseString(body.executionMode, "executionMode");
        if (
          executionMode !== "READ_ONLY" &&
          executionMode !== "SIMULATION" &&
          executionMode !== "LIVE"
        ) {
          throw new Cp2Error(400, "business_task_mode_invalid", "Invalid task execution mode.");
        }
        return await repo.create(principal, manifest, {
          taskId,
          objective: parseString(body.objective, "objective"),
          executionMode,
          steps,
          constraints: { budgetMinor, currency, horizonDays } satisfies BusinessTask["constraints"]
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
