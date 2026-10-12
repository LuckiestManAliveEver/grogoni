import type { RuntimeToolDefinition, RuntimeToolName } from "../contracts/runtime.js";
import { runtimeToolRegistry } from "../registry/index.js";
import type { BusinessEnvironmentManifest } from "./contracts.js";

const manifestFields = new Set([
  "id",
  "version",
  "name",
  "description",
  "domain",
  "capabilities",
  "observationSchema",
  "verificationPolicyId",
  "evaluationPolicyId",
  "executionMode",
  "status"
]);

function validateManifest(manifest: BusinessEnvironmentManifest): void {
  if (Object.keys(manifest).some((key) => !manifestFields.has(key))) {
    throw new Error("Environment manifests cannot override capability policy.");
  }
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(manifest.id) ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(manifest.version) ||
    [
      manifest.name,
      manifest.description,
      manifest.domain,
      manifest.verificationPolicyId,
      manifest.evaluationPolicyId
    ].some((value) => typeof value !== "string" || !value.trim()) ||
    !["READ_ONLY", "SIMULATION", "LIVE"].includes(manifest.executionMode) ||
    !["DRAFT", "ACTIVE", "DEPRECATED"].includes(manifest.status) ||
    !manifest.observationSchema ||
    typeof manifest.observationSchema !== "object" ||
    Array.isArray(manifest.observationSchema) ||
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.length === 0 ||
    new Set(manifest.capabilities).size !== manifest.capabilities.length
  ) {
    throw new Error("Invalid business environment manifest.");
  }
  for (const name of manifest.capabilities) {
    if (!Object.hasOwn(runtimeToolRegistry, name)) {
      throw new Error(`Unknown environment capability: ${name}`);
    }
    if (
      manifest.executionMode === "READ_ONLY" &&
      !runtimeToolRegistry[name as RuntimeToolName].readOnly
    ) {
      throw new Error(`Read-only environment cannot include ${name}.`);
    }
  }
}

/** Trusted, first-party definitions only. No execution or dynamic plugin loading. */
export function createBusinessEnvironmentRegistry(
  manifests: readonly BusinessEnvironmentManifest[]
) {
  const entries = new Map<string, BusinessEnvironmentManifest>();
  for (const manifest of manifests) {
    validateManifest(manifest);
    const key = `${manifest.id}@${manifest.version}`;
    if (entries.has(key)) throw new Error(`Duplicate environment version: ${key}`);
    entries.set(key, structuredClone(manifest));
  }
  return {
    get(id: string, version: string): BusinessEnvironmentManifest | null {
      const manifest = entries.get(`${id}@${version}`);
      return manifest ? structuredClone(manifest) : null;
    },
    list(): BusinessEnvironmentManifest[] {
      return [...entries.values()].map((manifest) => structuredClone(manifest));
    },
    requiredPermissions(id: string, version: string): string[] {
      const manifest = entries.get(`${id}@${version}`);
      if (!manifest) throw new Error("Unknown environment version.");
      return [
        ...new Set(
          manifest.capabilities.map((name) => runtimeToolRegistry[name].requiredPermission)
        )
      ];
    },
    capabilityDefinitions(id: string, version: string): RuntimeToolDefinition[] {
      const manifest = entries.get(`${id}@${version}`);
      if (!manifest) throw new Error("Unknown environment version.");
      return manifest.capabilities.map((name) => structuredClone(runtimeToolRegistry[name]));
    },
    assertCapability(id: string, version: string, toolName: RuntimeToolName): void {
      const manifest = entries.get(`${id}@${version}`);
      if (!manifest || manifest.status !== "ACTIVE" || !manifest.capabilities.includes(toolName)) {
        throw new Error("Environment capability is unavailable.");
      }
      // Authorization and approval are still enforced by the canonical runtime on every call.
    }
  };
}
