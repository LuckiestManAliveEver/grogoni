import { describe, expect, it } from "vitest";
import type {
  BusinessEnvironmentCompletionEvidence,
  BusinessEnvironmentInstance,
  BusinessEnvironmentManifest,
  BusinessEnvironmentStatus
} from "../packages/tool-core/src/environments/contracts.js";
import {
  assertBusinessEnvironmentRunning,
  transitionBusinessEnvironment
} from "../packages/tool-core/src/environments/lifecycle.js";
import { createBusinessEnvironmentRegistry } from "../packages/tool-core/src/environments/registry.js";
import { runtimeToolRegistry } from "../packages/tool-core/src/registry/index.js";

const manifest: BusinessEnvironmentManifest = {
  id: "grogoni.retail.inventory",
  version: "1.0.0",
  name: "Inventory",
  description: "Observe inventory records.",
  domain: "retail",
  capabilities: ["products.list"],
  observationSchema: { type: "object" },
  verificationPolicyId: "inventory.verify.v1",
  evaluationPolicyId: "inventory.evaluate.v1",
  executionMode: "READ_ONLY",
  status: "DRAFT"
};

function instance(status: BusinessEnvironmentStatus = "CREATED"): BusinessEnvironmentInstance {
  return {
    id: "environment-1",
    businessId: "business-1",
    agentId: "agent-1",
    runtimeInstanceId: "runtime-1",
    runtimeSessionId: "session-1",
    taskId: "task-1",
    environmentId: manifest.id,
    environmentVersion: manifest.version,
    executionMode: "LIVE",
    status,
    suspendedFrom: null
  };
}

function evidence(): BusinessEnvironmentCompletionEvidence {
  return {
    taskId: "task-1",
    environmentInstanceId: "environment-1",
    stateVersion: "record-version-1",
    durability: "COMMITTED",
    checks: (
      ["STRUCTURAL", "AUTHORIZATION", "CONSTRAINT", "EXECUTION", "PERSISTENCE", "OUTCOME"] as const
    ).map((category) => ({ category, status: "PASSED", evidenceRefs: ["record:1"] }))
  };
}

describe("business environment manifests", () => {
  it("derives permissions from canonical tools and rejects policy overrides", () => {
    const registry = createBusinessEnvironmentRegistry([manifest]);
    expect(registry.requiredPermissions(manifest.id, manifest.version)).toEqual([
      runtimeToolRegistry["products.list"].requiredPermission
    ]);
    const [definition] = registry.capabilityDefinitions(manifest.id, manifest.version);
    expect(definition).toEqual(runtimeToolRegistry["products.list"]);
    definition!.inputSchema.properties.injected = { type: "string", description: "injected" };
    expect(runtimeToolRegistry["products.list"].inputSchema.properties.injected).toBeUndefined();
    expect(() =>
      createBusinessEnvironmentRegistry([
        { ...manifest, requiredPermissions: [] } as BusinessEnvironmentManifest
      ])
    ).toThrow("override capability policy");
    expect(() =>
      createBusinessEnvironmentRegistry([
        { ...manifest, requiresConfirmation: false } as BusinessEnvironmentManifest
      ])
    ).toThrow("override capability policy");
  });

  it("rejects invented capabilities, duplicate versions, and writes in read-only mode", () => {
    expect(() =>
      createBusinessEnvironmentRegistry([
        {
          ...manifest,
          capabilities: ["invented.execute"]
        } as unknown as BusinessEnvironmentManifest
      ])
    ).toThrow("Unknown environment capability");
    expect(() => createBusinessEnvironmentRegistry([manifest, manifest])).toThrow("Duplicate");
    expect(() =>
      createBusinessEnvironmentRegistry([{ ...manifest, capabilities: ["product.stock_adjust"] }])
    ).toThrow("Read-only");
  });

  it("pins versions and protects definitions from caller mutation", () => {
    const source = structuredClone(manifest);
    const registry = createBusinessEnvironmentRegistry([source, { ...manifest, version: "2.0.0" }]);
    source.name = "changed";
    const first = registry.get(manifest.id, "1.0.0")!;
    first.name = "also changed";
    (first.observationSchema as Record<string, unknown>).type = "array";
    expect(registry.get(manifest.id, "1.0.0")).toEqual(manifest);
    expect(registry.get(manifest.id, "3.0.0")).toBeNull();
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects unavailable capabilities and inactive definitions", () => {
    const registry = createBusinessEnvironmentRegistry([manifest]);
    expect(() =>
      registry.assertCapability(manifest.id, manifest.version, "products.list")
    ).toThrow();
    const active = createBusinessEnvironmentRegistry([{ ...manifest, status: "ACTIVE" }]);
    expect(() =>
      active.assertCapability(manifest.id, manifest.version, "products.list")
    ).not.toThrow();
    expect(() =>
      active.assertCapability(manifest.id, manifest.version, "payment.record")
    ).toThrow();
    expect(() => active.assertCapability(manifest.id, "2.0.0", "products.list")).toThrow();
  });

  it.each(["", "1", "latest", "1.0", "01.0.0"])("rejects unpinned version %s", (version) => {
    expect(() => createBusinessEnvironmentRegistry([{ ...manifest, version }])).toThrow();
  });
});

describe("business environment lifecycle", () => {
  it("runs the approval and verification lifecycle without mutating its input", () => {
    const initial = instance();
    let current = transitionBusinessEnvironment(initial, "READY");
    current = transitionBusinessEnvironment(current, "RUNNING");
    current = transitionBusinessEnvironment(current, "AWAITING_APPROVAL");
    current = transitionBusinessEnvironment(current, "RUNNING");
    current = transitionBusinessEnvironment(current, "VERIFYING");
    current = transitionBusinessEnvironment(current, "COMPLETED", evidence());
    expect(current.status).toBe("COMPLETED");
    expect(initial.status).toBe("CREATED");
    expect(current.businessId).toBe(initial.businessId);
    expect(current.environmentVersion).toBe(initial.environmentVersion);
  });

  it.each(["READY", "RUNNING", "AWAITING_APPROVAL", "VERIFYING"] as const)(
    "suspends %s and resumes only that state",
    (status) => {
      const suspended = transitionBusinessEnvironment(instance(status), "SUSPENDED");
      expect(() => assertBusinessEnvironmentRunning(suspended)).toThrow();
      expect(transitionBusinessEnvironment(suspended, status).suspendedFrom).toBeNull();
      const other = status === "RUNNING" ? "READY" : "RUNNING";
      expect(() => transitionBusinessEnvironment(suspended, other)).toThrow("suspended state");
    }
  );

  it.each(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] as const)(
    "prevents replay after terminal status %s",
    (status) => {
      expect(() => transitionBusinessEnvironment(instance(status), "RUNNING")).toThrow();
      expect(() => assertBusinessEnvironmentRunning(instance(status))).toThrow();
    }
  );

  it("rejects skipped verification, missing checks, failed checks, and uncertain persistence", () => {
    expect(() =>
      transitionBusinessEnvironment(instance("RUNNING"), "COMPLETED", evidence())
    ).toThrow();
    const verifying = instance("VERIFYING");
    expect(() => transitionBusinessEnvironment(verifying, "COMPLETED")).toThrow();
    for (const invalid of [
      { ...evidence(), taskId: "another-task" },
      { ...evidence(), environmentInstanceId: "another-instance" },
      { ...evidence(), stateVersion: "" },
      { ...evidence(), durability: "UNCERTAIN" as const },
      { ...evidence(), durability: "NOT_REQUIRED" as const },
      { ...evidence(), checks: evidence().checks.slice(1) },
      {
        ...evidence(),
        checks: evidence().checks.map((check) => ({ ...check, status: "INCONCLUSIVE" as const }))
      },
      {
        ...evidence(),
        checks: evidence().checks.map((check) => ({ ...check, status: "FAILED" as const }))
      },
      { ...evidence(), checks: evidence().checks.map((check) => ({ ...check, evidenceRefs: [] })) }
    ]) {
      expect(() => transitionBusinessEnvironment(verifying, "COMPLETED", invalid)).toThrow();
    }
  });
});
