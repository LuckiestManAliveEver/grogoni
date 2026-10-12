import { describe, expect, it } from "vitest";
import {
  compileBusinessTask,
  type BusinessTaskStepProposal
} from "../packages/tool-core/src/environments/tasks.js";
import type { BusinessEnvironmentManifest } from "../packages/tool-core/src/environments/contracts.js";
import { runtimeToolRegistry } from "../packages/tool-core/src/registry/index.js";

const manifest: BusinessEnvironmentManifest = {
  id: "grogoni.retail.inventory",
  version: "1.0.0",
  name: "Inventory",
  description: "Inventory task fixture",
  domain: "retail",
  capabilities: ["products.list", "product.stock_adjust"],
  observationSchema: { type: "object" },
  verificationPolicyId: "inventory.verify.v1",
  evaluationPolicyId: "inventory.evaluate.v1",
  executionMode: "LIVE",
  status: "ACTIVE"
};
const first: BusinessTaskStepProposal = {
  id: "observe",
  capability: "products.list",
  input: {},
  dependencies: [],
  expectedOutput: "Authorized products"
};
const second: BusinessTaskStepProposal = {
  id: "adjust",
  capability: "product.stock_adjust",
  input: { productName: "Rice", quantity: 2 },
  dependencies: ["observe"],
  expectedOutput: "Recorded inventory adjustment"
};
function request() {
  return {
    taskId: "conversation-1",
    businessId: "business-1",
    actorId: "actor-1",
    objective: "Check and adjust Rice stock",
    manifest: structuredClone(manifest),
    authorizedCapabilities: [...manifest.capabilities],
    executionMode: "LIVE" as const,
    constraints: { budgetMinor: 1500000, currency: "KES", horizonDays: 3 },
    steps: [structuredClone(first), structuredClone(second)],
    now: new Date("2026-10-12T12:00:00Z")
  };
}

describe("structured business task compiler", () => {
  it("retains the handoff task ID and derives risk, approval, schemas, and scoped replay keys", () => {
    const task = compileBusinessTask(request());
    expect(task.id).toBe("conversation-1");
    expect(task.plan[1]).toMatchObject({
      risk: runtimeToolRegistry["product.stock_adjust"].risk,
      requiresApproval: runtimeToolRegistry["product.stock_adjust"].requiresConfirmation,
      inputSchema: runtimeToolRegistry["product.stock_adjust"].inputSchema,
      idempotencyKey: "business-1:conversation-1:adjust"
    });
    expect(task.constraints).toEqual({ budgetMinor: 1500000, currency: "KES", horizonDays: 3 });
    expect(task.environmentVersion).toBe("1.0.0");
  });

  it("rejects invented, unauthorized, inactive, and read-only write plans", () => {
    const invented = request();
    invented.steps[0]!.capability = "invented.execute" as never;
    expect(() => compileBusinessTask(invented)).toThrow();
    expect(() =>
      compileBusinessTask({ ...request(), authorizedCapabilities: ["products.list"] })
    ).toThrow("authorized");
    expect(() =>
      compileBusinessTask({ ...request(), manifest: { ...manifest, status: "DRAFT" } })
    ).toThrow();
    expect(() => compileBusinessTask({ ...request(), executionMode: "READ_ONLY" })).toThrow(
      "authorized"
    );
    expect(() => compileBusinessTask({ ...request(), executionMode: "SIMULATION" })).toThrow(
      "widen"
    );
  });

  it("rejects cycles, forward references, duplicates, and unbounded steps", () => {
    expect(() =>
      compileBusinessTask({ ...request(), steps: [{ ...first, dependencies: ["adjust"] }, second] })
    ).toThrow("dependency");
    expect(() => compileBusinessTask({ ...request(), steps: [first, first] })).toThrow(
      "dependency"
    );
    expect(() => compileBusinessTask({ ...request(), steps: [] })).toThrow("unbounded");
    expect(() =>
      compileBusinessTask({ ...request(), steps: Array.from({ length: 21 }, () => first) })
    ).toThrow("unbounded");
  });

  it("uses canonical semantic input validation and rejects extra or malformed arguments", () => {
    for (const input of [
      { quantity: 2 },
      { productName: "Rice", quantity: "2" },
      { productName: "Rice", quantity: Number.NaN },
      { productName: "Rice", quantity: 2, confirmed: true }
    ]) {
      expect(() =>
        compileBusinessTask({ ...request(), steps: [first, { ...second, input }] })
      ).toThrow();
    }
  });

  it("rejects malformed budget, currency, and forecasting constraints", () => {
    for (const constraints of [
      { budgetMinor: -1, currency: "KES", horizonDays: 3 },
      { budgetMinor: 1.5, currency: "KES", horizonDays: 3 },
      { budgetMinor: 1500000, currency: null, horizonDays: 3 },
      { budgetMinor: 1500000, currency: "kes", horizonDays: 3 },
      { budgetMinor: null, currency: null, horizonDays: 0 }
    ])
      expect(() => compileBusinessTask({ ...request(), constraints })).toThrow("constraints");
  });

  it("isolates task records and idempotency keys across businesses", () => {
    const source = request();
    const task = compileBusinessTask(source);
    source.steps[1]!.input.quantity = 999;
    expect(task.plan[1]!.input.quantity).toBe(2);
    const other = compileBusinessTask({ ...request(), businessId: "business-2" });
    expect(other.plan[1]!.idempotencyKey).not.toBe(task.plan[1]!.idempotencyKey);
    const left = compileBusinessTask({ ...request(), businessId: "a:b", taskId: "c" });
    const right = compileBusinessTask({ ...request(), businessId: "a", taskId: "b:c" });
    expect(left.plan[0]!.idempotencyKey).not.toBe(right.plan[0]!.idempotencyKey);
  });
});
