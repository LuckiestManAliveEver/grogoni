import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverInventoryBenchmarkConfigurations,
  inventoryBenchmarkQualityPassed
} from "../services/api/src/benchmarks/inventory-benchmark-config.js";

afterEach(() => vi.unstubAllGlobals());

describe("inventory benchmark configuration", () => {
  it("uses the existing hosted provider mapping and two distinct recipes, not a new model registry", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const result = await discoverInventoryBenchmarkConfigurations({
      INVENTORY_BENCHMARK_PROVIDER: "openrouter"
    });
    expect(result.discoveryStatus).toBe("CONFIGURED_HOSTED_PROVIDER");
    expect(result.configurations.map((item) => item.modelId)).toEqual(["gpt-6-luna", "gpt-6-luna"]);
    expect(new Set(result.configurations.map((item) => item.recipeVersion)).size).toBe(2);
    expect(result.configurations.every((item) => item.adapter.provider === "openrouter")).toBe(
      true
    );
    expect(request).not.toHaveBeenCalled();
    expect(
      await result.configurations[0]!.adapter.canRun({
        modelId: "gpt-6-luna",
        agentId: "test",
        shopId: "test"
      })
    ).toMatchObject({ available: false, errorCode: "CREDENTIAL_MISSING" });
  });

  it("rejects unmapped, duplicated or excessive hosted model IDs", async () => {
    for (const models of ["unmapped", "gpt-6-luna,gpt-6-luna", "one,two,three"])
      await expect(
        discoverInventoryBenchmarkConfigurations({
          INVENTORY_BENCHMARK_PROVIDER: "openrouter",
          INVENTORY_BENCHMARK_MODELS: models
        })
      ).rejects.toThrow();
    await expect(
      discoverInventoryBenchmarkConfigurations({ INVENTORY_BENCHMARK_PROVIDER: "arbitrary" })
    ).rejects.toThrow();
  });

  it("discovers only actual local models and refuses unrelated discovery endpoints", async () => {
    const request = vi.fn(async () =>
      Response.json({ models: [{ name: "smollm2:360m", size: 1000, details: {} }] })
    );
    vi.stubGlobal("fetch", request);
    for (const endpoint of [
      "https://unrelated.example",
      "http://name:password@localhost:11434",
      "file:///tmp/model"
    ])
      await expect(
        discoverInventoryBenchmarkConfigurations({ OLLAMA_BASE_URL: endpoint })
      ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const result = await discoverInventoryBenchmarkConfigurations({});
    expect(result.configurations).toHaveLength(2);
    expect(result.configurations.every((item) => item.modelId === "smollm2:360m")).toBe(true);
    await expect(
      discoverInventoryBenchmarkConfigurations({ INVENTORY_BENCHMARK_MODELS: "not-installed" })
    ).rejects.toThrow("not installed");
  });
});

function evidence() {
  return {
    comparisonStatus: "AVAILABLE",
    baseline: { cases: [{ status: "PASSED" }] },
    models: [0, 1].map(() => ({
      status: "COMPLETED",
      cases: [
        {
          status: "PASSED" as "PASSED" | "FAILED",
          modelInvoked: true,
          modelId: "gpt-6-luna" as string | null
        }
      ]
    }))
  };
}

describe("inventory model quality gate", () => {
  it("requires two complete actual model configurations, not only a green baseline", () => {
    expect(inventoryBenchmarkQualityPassed(evidence())).toBe(true);
    const report = evidence();
    report.models = [];
    expect(inventoryBenchmarkQualityPassed(report)).toBe(false);
  });
  it.each([
    "failed",
    "not-invoked",
    "unknown-model",
    "missing-case",
    "not-run",
    "baseline-failed",
    "no-comparison"
  ])("fails closed for %s", (fault) => {
    const report = evidence();
    if (fault === "failed") report.models[0]!.cases[0]!.status = "FAILED";
    if (fault === "not-invoked") report.models[0]!.cases[0]!.modelInvoked = false;
    if (fault === "unknown-model") report.models[0]!.cases[0]!.modelId = null;
    if (fault === "missing-case") report.models[0]!.cases = [];
    if (fault === "not-run") report.models[0]!.status = "NOT_RUN";
    if (fault === "baseline-failed") report.baseline.cases[0]!.status = "FAILED";
    if (fault === "no-comparison") report.comparisonStatus = "NOT_RUN";
    expect(inventoryBenchmarkQualityPassed(report)).toBe(false);
  });
});
