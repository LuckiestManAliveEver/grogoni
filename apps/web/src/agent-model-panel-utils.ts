import type { ModelExecutionTarget } from "@grogoni/shared-types";
import type { AiModelSummary } from "./grogoni-application-shared";

export function isDownloadableCatalogModel(model: AiModelSummary): boolean {
  return model.source === "huggingface" || model.source === "github";
}

/** Preserve deployment-owned runtime availability when merging registry discovery results. */
export function applyDeploymentRuntimeAvailability(
  models: AiModelSummary[],
  deploymentCatalog: AiModelSummary[]
): AiModelSummary[] {
  const availabilityByModelId = new Map(
    deploymentCatalog
      .filter((model) => model.runtimeAvailability !== undefined)
      .map((model) => [model.id, model.runtimeAvailability] as const)
  );
  return models.map((model) => {
    const runtimeAvailability = availabilityByModelId.get(model.id);
    return runtimeAvailability === undefined
      ? model
      : { ...model, runtimeAvailability: { ...runtimeAvailability } };
  });
}

/**
 * The target the API says a configured adapter serves this model on (GET /v1/ai-models ->
 * hostedExecutionTarget). Local-first deployments serve through Ollama on "local"; the retired
 * hosted runtime ("vercel") is never assumed. Falls back to "local" for responses that predate the
 * field, matching the API's local-mode platform default.
 */
export function servedExecutionTarget(model: AiModelSummary | undefined): ModelExecutionTarget {
  return model?.hostedExecutionTarget ?? "local";
}

/** Targets the API runs itself (local Ollama, server-side router, legacy hosted bindings). */
export function isServerExecutionTarget(target: ModelExecutionTarget): boolean {
  return target === "local" || target === "backend" || target === "vercel";
}
