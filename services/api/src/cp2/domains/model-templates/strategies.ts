import { Cp2Error } from "../../cp2-error.js";
import { estimatePromptTokens, sha256 } from "./manifest.js";
import type {
  DatasetExampleRecord,
  JsonValue,
  ModelTemplateVersionRecord,
  GrogoniModelTemplateManifestV1,
  SourceExpertiseRule,
  TemplateExecutionResult
} from "./types.js";

export async function executeDeterministicRuleExpertise(
  version: ModelTemplateVersionRecord,
  input: JsonValue
): Promise<TemplateExecutionResult> {
  if (typeof input !== "string") {
    throw new Cp2Error(
      422,
      "DETERMINISTIC_EXPERT_INPUT_UNSUPPORTED",
      "The deterministic rule expert accepts a text input."
    );
  }
  const normalized = input.trim().toLowerCase();
  const rule = version.manifest.expertise.source.rules.find((candidate) =>
    candidate.match
      .toLowerCase()
      .split("|")
      .map((term) => term.trim())
      .filter(Boolean)
      .some((term) => normalized.includes(term))
  );
  const defaultOutput = version.manifest.runtime.constraints.defaultOutput;
  const output = rule === undefined ? cloneRecord(defaultOutput) : structuredClone(rule.output);
  const quantity = parseQuantityAndUnit(input);
  if (quantity !== null) {
    output.quantity = quantity.quantity;
    output.unit = quantity.unit;
  }
  return {
    output,
    promptTokens: version.promptTokenEstimate,
    completionTokens: estimatePromptTokens(JSON.stringify(output)),
    totalContextTokens: version.promptTokenEstimate + estimatePromptTokens(input),
    peakMemoryBytes: 0,
    estimatedCost: 0
  };
}

export function optimizePromptExpertise(input: {
  parent: ModelTemplateVersionRecord;
  examples: DatasetExampleRecord[];
  candidateVersion: string;
  improvementRunId: string;
  datasetVersionId: string;
  targetBaseModelId: string;
  actorId: string;
  createdAt: string;
}): {
  manifest: GrogoniModelTemplateManifestV1;
  promptTokenEstimate: number;
  artifactSizeBytes: number;
} {
  const parent = structuredClone(input.parent.manifest);
  const uniqueInstructions = [
    ...new Set(parent.expertise.source.instructions.map(compactInstruction))
  ]
    .filter(Boolean)
    .sort();
  const correctionRules = input.examples
    .filter((example) => example.split === "TRAINING" && typeof example.input === "string")
    .map((example): SourceExpertiseRule => ({
      id: `correction:${example.correctionId ?? example.id}`,
      match: normalizeRuleMatch(example.input as string),
      output: cloneRecord(example.expectedOutput),
      provenance: "CORRECTION",
      sourceCorrectionId: example.correctionId
    }));
  const ruleByMatch = new Map<string, SourceExpertiseRule>();
  for (const rule of [...parent.expertise.source.rules, ...correctionRules]) {
    ruleByMatch.set(rule.match.toLowerCase(), rule);
  }
  const rules = [...ruleByMatch.values()];
  const prompt = [
    ...uniqueInstructions,
    ...rules.map((rule) => `${rule.match} => ${JSON.stringify(rule.output)}`)
  ].join("\n");
  const promptChecksum = sha256(prompt);
  const artifactSizeBytes = Buffer.byteLength(prompt, "utf8");
  const manifest: GrogoniModelTemplateManifestV1 = {
    ...parent,
    template: { ...parent.template, version: input.candidateVersion },
    baseModel: {
      ...parent.baseModel,
      requirements: {
        ...parent.baseModel.requirements,
        preferredModels: [
          input.targetBaseModelId,
          ...parent.baseModel.requirements.preferredModels.filter(
            (modelId) => modelId !== input.targetBaseModelId
          )
        ]
      }
    },
    expertise: {
      source: {
        ...parent.expertise.source,
        instructions: uniqueInstructions,
        rules
      },
      compiledArtifacts: [
        ...parent.expertise.compiledArtifacts.filter((artifact) => artifact.kind !== "PROMPT"),
        {
          id: `prompt:${input.improvementRunId}`,
          kind: "PROMPT",
          baseModelId: null,
          baseArchitecture: null,
          objectKey: null,
          inlineSha256: promptChecksum,
          sizeBytes: artifactSizeBytes
        }
      ]
    },
    runtime: { ...parent.runtime, prompt },
    lineage: {
      parentVersionId: input.parent.id,
      improvementRunId: input.improvementRunId,
      datasetVersionId: input.datasetVersionId,
      createdBy: input.actorId,
      createdAt: input.createdAt,
      changeSummary: `Prompt optimization incorporated ${correctionRules.length} approved corrections.`
    },
    checksums: { ...parent.checksums, "runtime/prompt.txt": promptChecksum }
  };
  return { manifest, promptTokenEstimate: estimatePromptTokens(prompt), artifactSizeBytes };
}

function compactInstruction(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/^(please|always remember to|you must always)\s+/iu, "")
    .replace(/[.!]+$/u, "");
}

function normalizeRuleMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|gram|grams|l|ml|pcs?|pieces?|units?|packs?)\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function parseQuantityAndUnit(input: string): { quantity: number; unit: string } | null {
  const match = input.match(
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(kg|g|gram|grams|l|ml|pc|pcs|piece|pieces|unit|units|pack|packs)\b/iu
  );
  if (match === null) return null;
  const rawUnit = match[2]!.toLowerCase();
  const unit =
    rawUnit === "gram" || rawUnit === "grams"
      ? "g"
      : rawUnit === "pc" || rawUnit === "pcs" || rawUnit === "piece" || rawUnit === "pieces"
        ? "unit"
        : rawUnit.endsWith("s")
          ? rawUnit.slice(0, -1)
          : rawUnit;
  return { quantity: Number(match[1]), unit };
}

function cloneRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    ? structuredClone(value)
    : {};
}
