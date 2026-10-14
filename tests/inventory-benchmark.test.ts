import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";
import {
  assertInventoryBenchmarkDatabase,
  inventoryBenchmarkFixtures,
  inventoryBenchmarkVersion
} from "../services/api/src/benchmarks/inventory-fixtures";
import { parseInventoryTaskObjective } from "../packages/tool-core/src/index";
import { runInventoryBenchmark } from "../services/api/src/benchmarks/inventory-benchmark";
import { createInventoryBenchmarkSandbox } from "../services/api/src/benchmarks/inventory-sandbox";

const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg") as {
  Pool: new (options: { connectionString: string; max: number }) => {
    query(sql: string, values: string[]): Promise<{ rowCount: number | null }>;
    end(): Promise<void>;
  };
};

describe("isolated inventory benchmark contract", () => {
  it("versions seven model-independent fixtures with bounded explicit objectives", () => {
    expect(inventoryBenchmarkVersion).toBe("grogoni.retail.inventory.benchmark.v1");
    expect(inventoryBenchmarkFixtures).toHaveLength(7);
    expect(new Set(inventoryBenchmarkFixtures.map((item) => item.id)).size).toBe(7);
    for (const fixture of inventoryBenchmarkFixtures)
      expect(parseInventoryTaskObjective(fixture.goal)).toMatchObject({
        kind: "PREPARE",
        budgetMinor: fixture.budgetMinor,
        currency: "KES",
        horizonDays: 3
      });
  });
  it.each([
    "postgresql://user:pass@production.example/grogoni_inventory_benchmark",
    "postgresql://user:pass@127.0.0.1/grogoni_market",
    "postgresql://user:pass@127.0.0.1/grogoni_inventory_benchmark?options=-csearch_path=public",
    "https://127.0.0.1/grogoni_inventory_benchmark"
  ])(
    "refuses production or override-bearing connections before any model or database work: %s",
    async (databaseUrl) => {
      expect(() => assertInventoryBenchmarkDatabase(databaseUrl)).toThrow();
      await expect(runInventoryBenchmark({ databaseUrl })).rejects.toThrow();
    }
  );
  it("accepts only a dedicated loopback benchmark database", () => {
    expect(() =>
      assertInventoryBenchmarkDatabase(
        "postgresql://grogoni:fixture@127.0.0.1/grogoni_inventory_benchmark"
      )
    ).not.toThrow();
  });
});

const databaseUrl = process.env.INVENTORY_BENCHMARK_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("canonical inventory benchmark on an isolated local database", () => {
  it("routes test-double proposals through validation and never dispatches extra arguments", async () => {
    // These adapters test harness wiring, not model performance; they are never CLI results.
    const generate = vi.fn<ModelRuntimeAdapter["generate"]>(async ({ context, prompt }) => ({
      text: JSON.stringify({
        type: "tool",
        toolName: "procurement.prepare",
        input: {
          taskId: JSON.parse(prompt.message).taskId,
          ...(context.modelId === "hostile-unit-fixture" ? { budgetMinor: 1 } : {})
        }
      }),
      modelId: context.modelId,
      provider: "unit-test",
      executionTarget: "local",
      latencyMs: 1
    }));
    const adapter: ModelRuntimeAdapter = {
      provider: "unit-test",
      executionTarget: "local",
      canRun: async () => ({ available: true, errorCode: null, message: null }),
      healthCheck: async () => {
        throw new Error("not used");
      },
      generate
    };
    const report = await runInventoryBenchmark({
      databaseUrl: databaseUrl!,
      configurations: [
        {
          id: "canonical-unit-fixture",
          modelId: "canonical-unit-fixture",
          modelVersion: "test-only",
          recipeVersion: "fixture-v1",
          adapter
        },
        {
          id: "hostile-unit-fixture",
          modelId: "hostile-unit-fixture",
          modelVersion: "test-only",
          recipeVersion: "fixture-v1",
          adapter
        }
      ]
    });
    expect(generate).toHaveBeenCalledTimes(14);
    expect(
      report.models[0]!.cases.every((item) => item.status === "PASSED" && item.modelInvoked)
    ).toBe(true);
    expect(
      report.models[1]!.cases.every(
        (item) =>
          item.status === "FAILED" &&
          item.decision === "INVALID_PROPOSAL" &&
          item.canonicalTrace.length === 0 &&
          item.draftTotalMinor === null
      )
    ).toBe(true);
    expect(report.comparisonStatus).toBe("AVAILABLE");
  }, 120000);
  it("removes its exact isolated schema after an interrupted case", async () => {
    const sandbox = await createInventoryBenchmarkSandbox(
      databaseUrl!,
      inventoryBenchmarkFixtures[0]!,
      new Date()
    );
    const schemaId = sandbox.schemaId;
    await sandbox.close();
    const pool = new Pool({ connectionString: databaseUrl!, max: 1 });
    try {
      expect(
        (await pool.query("select 1 from pg_namespace where nspname=$1", [schemaId])).rowCount
      ).toBe(0);
    } finally {
      await pool.end();
    }
  }, 30000);
  it("independently verifies all seven deterministic cases without claiming model results", async () => {
    const generate = vi.fn(async () => {
      throw new Error("Unavailable models cannot generate.");
    });
    const unavailable: ModelRuntimeAdapter = {
      provider: "unit-test-unavailable",
      executionTarget: "local",
      canRun: async () => ({ available: false, errorCode: "MODEL_UNAVAILABLE", message: null }),
      healthCheck: async () => {
        throw new Error("not used");
      },
      generate
    };
    const report = await runInventoryBenchmark({
      databaseUrl: databaseUrl!,
      configurations: [
        {
          id: "unavailable-one",
          modelId: "fixture-one",
          modelVersion: null,
          recipeVersion: "fixture-v1",
          adapter: unavailable
        },
        {
          id: "unavailable-two",
          modelId: "fixture-two",
          modelVersion: null,
          recipeVersion: "fixture-v1",
          adapter: unavailable
        }
      ]
    });
    expect(report.baseline.cases.map((item) => [item.fixtureId, item.status])).toEqual(
      inventoryBenchmarkFixtures.map((item) => [item.id, "PASSED"])
    );
    expect(report.baseline.modelId).toBeNull();
    expect(
      report.baseline.cases.every(
        (item) => !item.modelInvoked && item.modelId === null && item.promptTokens === null
      )
    ).toBe(true);
    expect(
      report.baseline.cases
        .flatMap((item) => item.canonicalTrace)
        .every((turn) => !turn.modelInvoked)
    ).toBe(true);
    expect(
      report.models.every((model) => model.status === "NOT_RUN" && model.cases.length === 0)
    ).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(report.comparisonStatus).toBe("NOT_RUN");
    expect(report.isolation.externalBusinessWrites).toBe(false);
  }, 120000);
});
