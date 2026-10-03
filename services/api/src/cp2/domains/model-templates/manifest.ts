import { createHash } from "node:crypto";
import { runtimeToolRegistry } from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";
import type {
  BaseModelDescriptor,
  JsonValue,
  GrogoniModelTemplateManifestV1,
  TemplateBaseModelRequirements
} from "./types.js";

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const taskPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const checksumPattern = /^sha256:[0-9a-f]{64}$/u;
export const emptyVocabularySnapshotId =
  "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function manifestSha256(manifest: GrogoniModelTemplateManifestV1): string {
  return sha256(canonicalJson(manifest));
}

export function estimatePromptTokens(prompt: string): number {
  const text = prompt.trim();
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function validateManifest(manifest: GrogoniModelTemplateManifestV1): void {
  if (manifest.format !== "grogoni-template" || manifest.formatVersion !== 1) {
    throw invalidManifest("Only grogoni-template formatVersion 1 is supported.");
  }
  if (!slugPattern.test(manifest.template.slug)) {
    throw invalidManifest("Template slug must be a lowercase kebab-case identifier.");
  }
  if (!semanticVersionPattern.test(manifest.template.version)) {
    throw invalidManifest("Template version must be semantic versioning (for example 1.2.0).");
  }
  if (
    manifest.template.id.trim().length === 0 ||
    manifest.template.name.trim().length === 0 ||
    manifest.template.domain.trim().length === 0 ||
    manifest.template.businessId.trim().length === 0 ||
    manifest.template.agentId.trim().length === 0
  ) {
    throw invalidManifest("Template identity, name, domain, business, and agent are required.");
  }
  if (manifest.ownership.businessId !== manifest.template.businessId) {
    throw invalidManifest("Manifest ownership must match the template business.");
  }
  if (manifest.tasks.length === 0 || manifest.tasks.some((task) => !taskPattern.test(task))) {
    throw invalidManifest("At least one namespaced task contract is required.");
  }
  if (
    manifest.validatedTaskDistribution.id.trim().length === 0 ||
    manifest.validatedTaskDistribution.description.trim().length === 0 ||
    manifest.validatedTaskDistribution.suiteIds.length === 0
  ) {
    throw invalidManifest("Manifest must declare the validated task distribution.");
  }
  assertUnique(manifest.validatedTaskDistribution.suiteIds, "validated task distribution suites");
  if (
    manifest.minimumModelCapability.tier.trim().length === 0 ||
    manifest.minimumModelCapability.requiredCapabilities.length === 0
  ) {
    throw invalidManifest("Manifest must declare a minimum model capability.");
  }
  assertUnique(
    manifest.minimumModelCapability.requiredCapabilities,
    "minimum model capability requirements"
  );
  if (
    manifest.minimumModelCapability.minimumContextWindow !== null &&
    (!Number.isSafeInteger(manifest.minimumModelCapability.minimumContextWindow) ||
      manifest.minimumModelCapability.minimumContextWindow < 128)
  ) {
    throw invalidManifest(
      "Minimum model capability context window must be null or an integer of at least 128 tokens."
    );
  }
  if (
    manifest.vocabularySnapshot.algorithm !== "APPROVED_VOCABULARY_SHA256_V1" ||
    !checksumPattern.test(manifest.vocabularySnapshot.id)
  ) {
    throw invalidManifest("Manifest must declare a reproducible approved-vocabulary snapshot.");
  }
  if (manifest.evaluation.templateVocabularySnapshot !== manifest.vocabularySnapshot.id) {
    throw invalidManifest("Evaluation vocabulary snapshot must match the template snapshot.");
  }
  if (
    manifest.evaluation.currentVocabularySnapshot !== null &&
    !checksumPattern.test(manifest.evaluation.currentVocabularySnapshot)
  ) {
    throw invalidManifest("Current vocabulary snapshot must be null or a SHA-256 snapshot id.");
  }
  assertUnique(manifest.tasks, "task contracts");
  assertUnique(manifest.capabilities, "capabilities");
  validateRequirements(manifest.baseModel.requirements);
  if (manifest.expertise.source.instructions.some((item) => item.trim().length === 0)) {
    throw invalidManifest("Expertise instructions cannot be empty.");
  }
  for (const rule of manifest.expertise.source.rules) {
    if (rule.id.trim().length === 0 || rule.match.trim().length === 0) {
      throw invalidManifest("Every source expertise rule requires an id and match expression.");
    }
  }
  const allowedTools = new Set(Object.keys(runtimeToolRegistry));
  const unsupportedTool = manifest.runtime.tools.find((tool) => !allowedTools.has(tool));
  if (unsupportedTool !== undefined) {
    throw invalidManifest(`Template declares unsupported tool '${unsupportedTool}'.`);
  }
  for (const artifact of manifest.expertise.compiledArtifacts) {
    if (!checksumPattern.test(artifact.inlineSha256) || artifact.sizeBytes < 0) {
      throw invalidManifest("Compiled artifacts require a SHA-256 checksum and non-negative size.");
    }
    if (
      (artifact.kind === "ADAPTER" || artifact.kind === "DELTA") &&
      (artifact.baseModelId === null || artifact.baseArchitecture === null)
    ) {
      throw invalidManifest("Adapters and deltas must declare their exact base and architecture.");
    }
  }
  for (const [path, checksum] of Object.entries(manifest.checksums)) {
    if (!isSafeArtifactPath(path) || !checksumPattern.test(checksum)) {
      throw invalidManifest(
        "Artifact checksum entries require safe relative paths and SHA-256 values."
      );
    }
  }
}

function validateRequirements(requirements: TemplateBaseModelRequirements): void {
  assertUnique(requirements.requiredCapabilities, "required base capabilities");
  assertUnique(requirements.preferredModels, "preferred models");
  assertUnique(requirements.testedModels, "tested models");
  assertUnique(requirements.incompatibleModels, "incompatible models");
  if (
    requirements.minimumContextWindow !== null &&
    (!Number.isSafeInteger(requirements.minimumContextWindow) ||
      requirements.minimumContextWindow < 128)
  ) {
    throw invalidManifest(
      "Minimum context window must be null or an integer of at least 128 tokens."
    );
  }
  if (
    requirements.testedModels.some((modelId) => requirements.incompatibleModels.includes(modelId))
  ) {
    throw invalidManifest("A tested model cannot also be marked incompatible.");
  }
}

function assertUnique(values: string[], label: string): void {
  if (values.some((value) => value.trim().length === 0) || new Set(values).size !== values.length) {
    throw invalidManifest(`Manifest ${label} must be non-empty and unique.`);
  }
}

function isSafeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

export function assertCompatibleBaseModel(
  requirements: TemplateBaseModelRequirements,
  model: BaseModelDescriptor | null
): BaseModelDescriptor {
  if (model === null || !model.available) {
    throw new Cp2Error(
      409,
      "TEMPLATE_BASE_MODEL_UNAVAILABLE",
      "The selected base model is unavailable."
    );
  }
  if (requirements.incompatibleModels.includes(model.id)) {
    throw new Cp2Error(
      409,
      "TEMPLATE_BASE_MODEL_INCOMPATIBLE",
      "The selected base model is explicitly incompatible with this expertise version."
    );
  }
  const missing = requirements.requiredCapabilities.filter(
    (capability) => !model.capabilities.includes(capability)
  );
  if (missing.length > 0) {
    throw new Cp2Error(
      409,
      "TEMPLATE_BASE_MODEL_INCOMPATIBLE",
      `The selected base model lacks required capabilities: ${missing.join(", ")}.`
    );
  }
  if (
    requirements.minimumContextWindow !== null &&
    (model.contextWindow === null || model.contextWindow < requirements.minimumContextWindow)
  ) {
    throw new Cp2Error(
      409,
      "TEMPLATE_BASE_MODEL_INCOMPATIBLE",
      "The selected base model context window is too small."
    );
  }
  return model;
}

export function verifyExportChecksums(input: {
  files: Record<string, string>;
  checksums: Record<string, string>;
}): void {
  for (const [path, expected] of Object.entries(input.checksums)) {
    if (!Object.hasOwn(input.files, path) || sha256(input.files[path]!) !== expected) {
      throw new Cp2Error(
        400,
        "GROGONI_ARTIFACT_CHECKSUM_INVALID",
        `Artifact checksum failed for '${path}'.`
      );
    }
  }
}

export function bumpMinorVersion(version: string): string {
  const match = semanticVersionPattern.exec(version);
  if (match === null) throw invalidManifest("Parent template version is not semantic versioning.");
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

export function jsonValue(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

function invalidManifest(message: string): Cp2Error {
  return new Cp2Error(400, "GROGONI_MANIFEST_INVALID", message);
}
