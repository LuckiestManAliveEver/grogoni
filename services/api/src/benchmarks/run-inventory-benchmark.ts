import { writeFile } from "node:fs/promises";
import {
  createOllamaInferenceClient,
  createOllamaModelAdapter
} from "../inference/model-runtime.js";
import {
  runInventoryBenchmark,
  type InventoryBenchmarkConfiguration
} from "./inventory-benchmark.js";
import { assertInventoryBenchmarkDatabase } from "./inventory-fixtures.js";

const databaseUrl = process.env.INVENTORY_BENCHMARK_DATABASE_URL ?? "";
assertInventoryBenchmarkDatabase(databaseUrl);
const endpoint = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const url = new URL(endpoint);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password)
  throw new Error(
    "Inventory benchmark model discovery requires a local, credential-free Ollama endpoint."
  );
const configurations: InventoryBenchmarkConfiguration[] = [];
let discoveryStatus = "AVAILABLE";
try {
  const client = createOllamaInferenceClient({
    baseUrl: endpoint,
    model: "discovery",
    timeoutMs: 5000
  });
  const installed = await client.listModels();
  const requested = (process.env.INVENTORY_BENCHMARK_MODELS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const selected = (
    requested.length ? requested : installed.map((model) => model.name).sort()
  ).slice(0, 2);
  for (const modelId of selected)
    configurations.push({
      id: `${modelId}:inventory-planning-v1`,
      modelId,
      modelVersion: null,
      recipeVersion: "grogoni.inventory.planning.v1",
      adapter: createOllamaModelAdapter({
        modelId,
        ollamaModel: modelId,
        client: createOllamaInferenceClient({ baseUrl: endpoint, model: modelId, timeoutMs: 30000 })
      })
    });
  if (selected.length === 1)
    configurations.push({
      id: `${selected[0]}:inventory-constraints-first-v1`,
      modelId: selected[0]!,
      modelVersion: null,
      recipeVersion: "grogoni.inventory.constraints-first.v1",
      adapter: createOllamaModelAdapter({
        modelId: selected[0]!,
        ollamaModel: selected[0]!,
        client: createOllamaInferenceClient({
          baseUrl: endpoint,
          model: selected[0]!,
          timeoutMs: 30000
        })
      })
    });
  if (!selected.length) discoveryStatus = "NOT_RUN_NO_INSTALLED_MODELS";
} catch {
  discoveryStatus = "NOT_RUN_LOCAL_MODEL_UNAVAILABLE";
}
const report = {
  ...(await runInventoryBenchmark({ databaseUrl, configurations })),
  modelDiscoveryStatus: discoveryStatus
};
const output = process.argv[2] ?? "/tmp/grogoni-inventory-benchmark-report.json";
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    benchmarkId: report.benchmarkId,
    output,
    baselinePassed: report.baseline.cases.filter((item) => item.status === "PASSED").length,
    baselineCases: report.baseline.cases.length,
    modelConfigurationsRun: report.models.filter((item) => item.status === "COMPLETED").length,
    comparisonStatus: report.comparisonStatus,
    modelDiscoveryStatus: discoveryStatus
  })
);
if (report.baseline.cases.some((item) => item.status !== "PASSED")) process.exitCode = 1;
