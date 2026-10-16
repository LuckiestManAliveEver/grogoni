import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runInventoryBenchmark } from "./inventory-benchmark.js";
import {
  discoverInventoryBenchmarkConfigurations,
  inventoryBenchmarkQualityPassed
} from "./inventory-benchmark-config.js";
import { assertInventoryBenchmarkDatabase } from "./inventory-fixtures.js";

const databaseUrl = process.env.INVENTORY_BENCHMARK_DATABASE_URL ?? "";
assertInventoryBenchmarkDatabase(databaseUrl);
const { values, positionals } = parseArgs({
  options: { output: { type: "string" }, "require-model-pass": { type: "boolean" } },
  allowPositionals: true
});
if (positionals.length > 1) throw new Error("Provide at most one benchmark output path.");
const requireModels =
  values["require-model-pass"] === true ||
  process.env.INVENTORY_BENCHMARK_REQUIRE_MODEL_PASS === "true";
const { configurations, discoveryStatus } = await discoverInventoryBenchmarkConfigurations();
const benchmarkReport = {
  ...(await runInventoryBenchmark({ databaseUrl, configurations })),
  modelDiscoveryStatus: discoveryStatus
};
const output = values.output ?? positionals[0] ?? "/tmp/grogoni-inventory-benchmark-report.json";
const modelQualityPassed = inventoryBenchmarkQualityPassed(benchmarkReport);
const report = {
  ...benchmarkReport,
  evaluationSettings: {
    provider: process.env.INVENTORY_BENCHMARK_PROVIDER ?? "ollama",
    hostedMaxOutputTokens:
      process.env.INVENTORY_BENCHMARK_PROVIDER === "openrouter"
        ? Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 2048)
        : null
  },
  modelQualityGate: { required: requireModels, passed: modelQualityPassed }
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    benchmarkId: report.benchmarkId,
    output,
    baselinePassed: report.baseline.cases.filter((item) => item.status === "PASSED").length,
    baselineCases: report.baseline.cases.length,
    modelConfigurationsRun: report.models.filter((item) => item.status === "COMPLETED").length,
    comparisonStatus: report.comparisonStatus,
    modelDiscoveryStatus: discoveryStatus,
    modelQualityGate: report.modelQualityGate
  })
);
if (
  report.baseline.cases.some((item) => item.status !== "PASSED") ||
  (requireModels && !modelQualityPassed)
)
  process.exitCode = 1;
