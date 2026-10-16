import { repositoryDefaultRuntimePolicy } from "@grogoni/shared-types";
import {
  createOllamaInferenceClient,
  createOllamaModelAdapter,
  type ModelRuntimeAdapter
} from "../inference/model-runtime.js";
import { createOpenRouterRuntime } from "../inference/openrouter-runtime.js";
import type {
  InventoryBenchmarkConfiguration,
  InventoryBenchmarkCaseResult
} from "./inventory-benchmark.js";

function configurationsFor(
  models: string[],
  adapterFor: (id: string) => ModelRuntimeAdapter
): InventoryBenchmarkConfiguration[] {
  const configurations = models.map((modelId) => ({
    id: `${modelId}:inventory-planning-v1`,
    modelId,
    modelVersion: null,
    recipeVersion: "grogoni.inventory.planning.v1",
    adapter: adapterFor(modelId)
  }));
  if (models.length === 1)
    configurations.push({
      id: `${models[0]}:inventory-constraints-first-v1`,
      modelId: models[0]!,
      modelVersion: null,
      recipeVersion: "grogoni.inventory.constraints-first.v1",
      adapter: adapterFor(models[0]!)
    });
  return configurations;
}

export async function discoverInventoryBenchmarkConfigurations(
  environment: NodeJS.ProcessEnv = process.env
) {
  const provider = environment.INVENTORY_BENCHMARK_PROVIDER ?? "ollama";
  if (!["ollama", "openrouter"].includes(provider))
    throw new Error("Unsupported inventory benchmark provider.");
  const requested = (environment.INVENTORY_BENCHMARK_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (requested.length > 2 || new Set(requested).size !== requested.length)
    throw new Error("Request at most two distinct benchmark model IDs.");
  if (provider === "openrouter") {
    const runtime = createOpenRouterRuntime(environment);
    const selected = requested.length
      ? requested
      : [environment.PLATFORM_DEFAULT_MODEL_ID ?? repositoryDefaultRuntimePolicy.modelId];
    return {
      configurations: configurationsFor(selected, (modelId) => {
        const adapter = runtime.resolve({ modelId, executionTarget: "backend" });
        if (!adapter)
          throw new Error(
            "Hosted benchmark models must be mapped in the existing operator runtime configuration."
          );
        return adapter;
      }),
      discoveryStatus: "CONFIGURED_HOSTED_PROVIDER"
    };
  }
  const endpoint = environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const url = new URL(endpoint);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(
      "Inventory benchmark discovery requires a local, credential-free Ollama endpoint."
    );
  let installed: Awaited<ReturnType<ReturnType<typeof createOllamaInferenceClient>["listModels"]>>;
  try {
    installed = await createOllamaInferenceClient({
      baseUrl: endpoint,
      model: "discovery",
      timeoutMs: 5000
    }).listModels();
  } catch {
    return { configurations: [], discoveryStatus: "NOT_RUN_INFERENCE_UNAVAILABLE" };
  }
  const available = installed.map((model) => model.name).sort();
  if (requested.some((id) => !available.includes(id)))
    throw new Error("Requested benchmark model is not installed.");
  const selected = requested.length ? requested : available.slice(0, 2);
  return {
    configurations: configurationsFor(selected, (modelId) =>
      createOllamaModelAdapter({
        modelId,
        ollamaModel: modelId,
        client: createOllamaInferenceClient({ baseUrl: endpoint, model: modelId, timeoutMs: 30000 })
      })
    ),
    discoveryStatus: selected.length ? "AVAILABLE" : "NOT_RUN_NO_INSTALLED_MODELS"
  };
}

export function inventoryBenchmarkQualityPassed(report: {
  comparisonStatus: string;
  baseline: { cases: readonly { status: string }[] };
  models: readonly {
    status: string;
    cases: readonly Pick<InventoryBenchmarkCaseResult, "status" | "modelInvoked" | "modelId">[];
  }[];
}): boolean {
  return (
    report.comparisonStatus === "AVAILABLE" &&
    report.baseline.cases.length > 0 &&
    report.baseline.cases.every((item) => item.status === "PASSED") &&
    report.models.length === 2 &&
    report.models.every(
      (model) =>
        model.status === "COMPLETED" &&
        model.cases.length === report.baseline.cases.length &&
        model.cases.every(
          (item) => item.status === "PASSED" && item.modelInvoked && item.modelId !== null
        )
    )
  );
}
