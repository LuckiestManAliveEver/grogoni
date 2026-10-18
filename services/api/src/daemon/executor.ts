import type { createDefaultAgentRuntimeAdapterRegistry } from "../agent-harness/default-agent-runtime-adapters.js";
import { createOpenRouterRuntime } from "../inference/openrouter-runtime.js";
import {
  ModelRuntimeError,
  asModelRuntimeError,
  runtimeProviderFromAdapter,
  type ModelRuntimeAdapter
} from "../inference/model-runtime.js";
import { hostedJsonRequest, hostedEndpoint } from "../inference/hosted-http.js";
import { DaemonTaskError, type DaemonExecutor } from "./worker.js";
import type { DaemonPayload } from "./task-store.js";
import { defaultGrogoniMaxPromptBytes } from "../agent-harness/grogoni-agent-runtime-adapter.js";
import type { RuntimeModelPrompt } from "@grogoni/shared-types";

/** The exact prompt an agent task sends; the gateway sizes it before accepting the task. */
export function daemonAgentPrompt(message: string): RuntimeModelPrompt {
  return { message, allowedTools: [], schemaVersion: "cp11-runtime-model-v1" };
}

export interface DaemonCapabilities {
  agents: boolean;
  maintenance: boolean;
  /** Why the gateway must refuse this payload now (422), or null when it can run. */
  refusal(payload: DaemonPayload): string | null;
}

/**
 * Validates the daemon's execution configuration once, at startup. Anything set but invalid
 * throws, and a daemon that could run nothing refuses to start. Agent tasks need
 * OPENROUTER_API_KEY and a mapped model; maintenance tasks need GROGONI_API_URL and
 * BACKGROUND_JOB_TOKEN. The gateway uses refusal() to reject work that cannot run instead of
 * accepting it and dead-lettering it later.
 */
export function readDaemonCapabilities(
  environment: NodeJS.ProcessEnv,
  defaultModelId: string,
  options: {
    /** The Edge lane runs maintenance jobs in-process, so it needs no GROGONI_API_URL. */
    maintenanceInProcess?: boolean;
  } = {}
): DaemonCapabilities {
  const models = createOpenRouterRuntime(environment);
  const agents = (environment.OPENROUTER_API_KEY?.trim() ?? "") !== "";
  const modelMapped = (modelId: string) =>
    models.resolve({ modelId, executionTarget: "backend" }) !== undefined;
  if (agents && !modelMapped(defaultModelId))
    throw new Error(
      `PLATFORM_DEFAULT_MODEL_ID "${defaultModelId}" is not mapped in OPENROUTER_MODELS.`
    );
  const allowLocal = environment.DAEMON_ALLOW_LOCAL_API?.trim() ?? "";
  if (!["", "true", "false"].includes(allowLocal))
    throw new Error("DAEMON_ALLOW_LOCAL_API must be true or false.");
  const apiUrl = environment.GROGONI_API_URL?.trim() ?? "";
  const maintenance = apiUrl !== "" || options.maintenanceInProcess === true;
  if (apiUrl !== "") {
    hostedEndpoint(apiUrl, allowLocal === "true");
    if (!environment.BACKGROUND_JOB_TOKEN?.trim())
      throw new Error("BACKGROUND_JOB_TOKEN is required when GROGONI_API_URL is set.");
  }
  if (!agents && !maintenance)
    throw new Error(
      "Nothing to run: set OPENROUTER_API_KEY for agent tasks and/or GROGONI_API_URL for maintenance."
    );
  return {
    agents,
    maintenance,
    refusal(payload) {
      if (payload.kind === "maintenance") return maintenance ? null : "JOB_API_NOT_CONFIGURED";
      if (!agents) return "AGENT_RUNTIME_NOT_CONFIGURED";
      if (!modelMapped(payload.modelId)) return "MODEL_NOT_CONFIGURED";
      // Same measure as the Grogoni engine, so oversized (often multibyte) text is refused now
      // rather than accepted and dead-lettered as CONTEXT_TOO_LARGE on its first run.
      const promptBytes = Buffer.byteLength(JSON.stringify(daemonAgentPrompt(payload.message)));
      return payload.agentAdapterId === "grogoni" && promptBytes > defaultGrogoniMaxPromptBytes
        ? "MESSAGE_TOO_LARGE"
        : null;
    }
  };
}

export function createDaemonExecutor(
  environment: NodeJS.ProcessEnv,
  options: {
    /**
     * Runs a maintenance job in-process. The Edge lane passes this so a job never costs a second
     * function invocation; without it, jobs are triggered over HTTP at GROGONI_API_URL.
     */
    runMaintenance?: (job: string, signal: AbortSignal) => Promise<unknown>;
  } = {}
): DaemonExecutor {
  const models = createOpenRouterRuntime(environment);
  let agents: Promise<ReturnType<typeof createDefaultAgentRuntimeAdapterRegistry>> | undefined;
  const execute: DaemonExecutor = async (task, signal) => {
    const payload = task.payload;
    if (payload.kind === "maintenance") {
      const { edgeJobDefinitions } = await import("../edge-job-runner.js");
      if (!Object.hasOwn(edgeJobDefinitions, payload.job))
        throw new DaemonTaskError("UNKNOWN_JOB", false);
      if (options.runMaintenance) return await options.runMaintenance(payload.job, signal);
      if (!environment.GROGONI_API_URL || !environment.BACKGROUND_JOB_TOKEN)
        throw new DaemonTaskError("JOB_API_NOT_CONFIGURED", false);
      const base = hostedEndpoint(
        environment.GROGONI_API_URL,
        environment.DAEMON_ALLOW_LOCAL_API?.trim() === "true"
      );
      const url = new URL(
        `${base.pathname.replace(/\/$/u, "")}/internal/jobs/${payload.job}/run`,
        base
      );
      try {
        return await hostedJsonRequest({
          url,
          signal,
          timeoutMs: 120_000,
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-job-token": environment.BACKGROUND_JOB_TOKEN
            },
            body: "{}"
          }
        });
      } catch (error) {
        // hostedJsonRequest speaks in model-provider codes; job API failures get their own so
        // operators never mistake a maintenance outage for a model outage.
        if (error instanceof ModelRuntimeError)
          throw error.retryable
            ? new DaemonTaskError("JOB_API_UNAVAILABLE", true)
            : new DaemonTaskError("JOB_API_REJECTED", false);
        throw error;
      }
    }
    const adapter = models.resolve({ modelId: payload.modelId, executionTarget: "backend" });
    agents ??= import("../agent-harness/default-agent-runtime-adapters.js").then(
      ({ createDefaultAgentRuntimeAdapterRegistry }) => createDefaultAgentRuntimeAdapterRegistry()
    );
    const agentAdapter = (await agents).resolve(payload.agentAdapterId);
    if (!adapter || !agentAdapter) throw new DaemonTaskError("RUNTIME_NOT_CONFIGURED", false);
    // runtimeProviderFromAdapter flattens a model failure into a completion code and drops the
    // runtime's own retryable verdict; capture it here so transient failures are retried.
    let modelFailureRetryable: boolean | undefined;
    const tracked: ModelRuntimeAdapter = Object.assign(
      Object.create(adapter) as ModelRuntimeAdapter,
      {
        generate: async (request: Parameters<ModelRuntimeAdapter["generate"]>[0]) => {
          try {
            return await adapter.generate(request);
          } catch (error) {
            modelFailureRetryable = asModelRuntimeError(error).retryable;
            throw error;
          }
        }
      }
    );
    const context = {
      modelId: payload.modelId,
      agentId: `daemon:${payload.agentAdapterId}`,
      shopId: "daemon-operator",
      signal
    };
    const now = new Date().toISOString();
    const result = await agentAdapter.execute({
      agent: {
        id: context.agentId,
        businessId: null,
        accountId: null,
        name: "Grogoni daemon",
        provider: payload.agentAdapterId,
        packageRef: null,
        version: "1",
        runtimeContractVersion: "1",
        capabilities: ["chat"],
        configuration: { runtimeAdapterId: payload.agentAdapterId },
        status: "active",
        createdAt: now,
        updatedAt: now
      },
      bindingId: `daemon:${task.id}`,
      executionHostId: null,
      modelId: payload.modelId,
      conversationId: task.id,
      shopId: context.shopId,
      userMessage: payload.message,
      prompt: daemonAgentPrompt(payload.message),
      model: runtimeProviderFromAdapter({ adapter: tracked, context }),
      allowedTools: [],
      signal
    });
    if (result.completion.status !== "available")
      throw new DaemonTaskError(
        result.completion.errorCode ?? "MODEL_UNAVAILABLE",
        result.completion.status === "timeout" ||
          (modelFailureRetryable ??
            ["RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(result.completion.errorCode ?? ""))
      );
    return result;
  };
  return async (task, signal) => {
    try {
      return await execute(task, signal);
    } catch (error) {
      if (error instanceof ModelRuntimeError)
        throw new DaemonTaskError(error.code, error.retryable);
      throw error;
    }
  };
}
