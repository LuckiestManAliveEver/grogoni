import { createOpenRouterModelAdapter, lunaModel } from "./openrouter-model-runtime.js";
import type { ModelRuntimeAdapter } from "./model-runtime.js";

/** A server-held key serves only operator-configured model IDs, never arbitrary request URLs. */
export function createOpenRouterRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const models: Record<string, string> = environment.OPENROUTER_MODELS
    ? JSON.parse(environment.OPENROUTER_MODELS)
    : { "gpt-6-luna": "openai/gpt-6-luna" };
  if (
    !models ||
    typeof models !== "object" ||
    Array.isArray(models) ||
    Object.entries(models).some(([id, model]) => !id || typeof model !== "string" || !model.trim())
  )
    throw new Error("OPENROUTER_MODELS must map catalog IDs to OpenRouter model IDs.");
  const maxOutputTokens = Number(environment.OPENROUTER_MAX_OUTPUT_TOKENS ?? 2048);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 16384)
    throw new Error("OPENROUTER_MAX_OUTPUT_TOKENS must be between 128 and 16384.");
  const adapters = new Map<string, ModelRuntimeAdapter>();
  return {
    catalog() {
      return Object.entries(models).map(([id, providerModelId]) => ({
        ...lunaModel,
        id,
        label: id === lunaModel.id ? lunaModel.label : providerModelId,
        description:
          "Operator-configured hosted model served through the existing OpenRouter provider.",
        canonicalModelId: providerModelId,
        modelCardUrl: `https://openrouter.ai/${providerModelId}`,
        recommended: id === lunaModel.id,
        contextWindow: null,
        available: Boolean(environment.OPENROUTER_API_KEY?.trim())
      }));
    },
    resolve(input: { modelId: string; executionTarget: string }) {
      if (input.executionTarget !== "backend" || !Object.hasOwn(models, input.modelId))
        return undefined;
      let adapter = adapters.get(input.modelId);
      if (!adapter) {
        adapter = createOpenRouterModelAdapter({
          modelId: input.modelId,
          providerModelId: models[input.modelId]!,
          apiKey: environment.OPENROUTER_API_KEY?.trim() ?? "",
          maxOutputTokens
        });
        adapters.set(input.modelId, adapter);
      }
      return adapter;
    }
  };
}
