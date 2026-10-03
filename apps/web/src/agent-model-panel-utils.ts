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
