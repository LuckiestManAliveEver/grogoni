import { pathToFileURL } from "node:url";
import { createModelTemplatesDomain } from "../store.js";
import { executeDeterministicRuleExpertise } from "../strategies.js";
import type { GrogoniModelTemplateManifestV1, TemplateTelemetryEvent } from "../types.js";
import { emptyVocabularySnapshotId } from "../manifest.js";

const businessId = "demo-retail-business";
const accountId = "demo-retail-account";
const actorId = "demo-domain-expert";
const baseModelId = "qwen2.5-0.5b-android";

export async function runRetailProductExpertDemo() {
  const telemetry: TemplateTelemetryEvent[] = [];
  const domain = createModelTemplatesDomain({
    requireAccess: (_sessionId, requestedBusinessId) => {
      if (requestedBusinessId !== businessId) throw new Error("cross-business access");
      return { account: { id: accountId }, user: { id: actorId } };
    },
    resolveBaseModel: (modelId) =>
      modelId === baseModelId
        ? {
            id: baseModelId,
            provider: "local",
            capabilities: ["chat", "structured-output", "offline"],
            contextWindow: 32_768,
            available: true
          }
        : null,
    executeTemplate: (version, input) => executeDeterministicRuleExpertise(version, input),
    emitTelemetry: (event) => telemetry.push(event)
  });
  const initial = domain.createTemplate({
    sessionId: "demo-session",
    businessId,
    manifest: retailProductManifest(),
    baseModelId,
    nativeRuntimeBindingId: "demo-native-runtime-binding"
  });
  const expectedBasmati = productOutput("rice", "cereals", 1, "kg");
  const expectedPishori = productOutput("rice", "cereals", 2, "kg");
  const evaluation = domain.createEvaluationSuite({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    name: "Retail product classification regression suite",
    cases: [
      {
        name: "Known basmati rice",
        input: "1kg basmati rice",
        matcher: { type: "EXACT", expected: expectedBasmati },
        tags: ["baseline"]
      },
      {
        name: "Regional Pishori rice",
        input: "2kg Pishori rice",
        matcher: { type: "EXACT", expected: expectedPishori },
        tags: ["difficult", "regional-vocabulary"]
      }
    ]
  });
  const baselineRun = await domain.runEvaluation({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    suiteId: evaluation.suite.id,
    candidateVersionId: initial.version.id,
    baselineVersionId: null
  });
  domain.promote({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    candidateVersionId: initial.version.id,
    evaluationRunId: baselineRun.id
  });
  domain.createDatasetVersion({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    name: "Dataset v1: held-out regression fixture",
    examples: [{ evaluationCaseId: evaluation.cases[1]!.id, split: "REGRESSION" }]
  });
  const failedOutput = await executeDeterministicRuleExpertise(initial.version, "2kg Pishori rice");
  const observation = domain.recordObservation({
    sessionId: "demo-session",
    businessId,
    templateVersionId: initial.version.id,
    observationInput: "2kg Pishori rice",
    output: failedOutput.output,
    suspectedFailure: true,
    failureReason: "Regional product vocabulary was not recognized."
  });
  const correction = domain.submitCorrection({
    sessionId: "demo-session",
    businessId,
    observationId: observation.id,
    correctedOutput: expectedPishori,
    explanation: "Pishori is a rice variety sold in the cereals category."
  });
  domain.approveCorrection({
    sessionId: "demo-session",
    businessId,
    correctionId: correction.id,
    approve: true
  });
  const datasetV2 = domain.createDatasetVersion({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    name: "Dataset v2: approved regional vocabulary correction",
    examples: [{ correctionId: correction.id, split: "TRAINING" }]
  });
  const improvement = domain.startImprovementRun({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    parentVersionId: initial.version.id,
    datasetVersionId: datasetV2.dataset.id,
    evaluationSuiteId: evaluation.suite.id,
    targetBaseModelId: baseModelId,
    strategy: "PROMPT_OPTIMIZATION"
  });
  const candidateVersionId = improvement.candidateVersionId!;
  const candidateRun = await domain.runEvaluation({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    suiteId: evaluation.suite.id,
    candidateVersionId,
    baselineVersionId: initial.version.id
  });
  const promotion = domain.promote({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id,
    candidateVersionId,
    evaluationRunId: candidateRun.id
  });
  const reportCard = domain.getReportCard({
    sessionId: "demo-session",
    businessId,
    evaluationRunId: candidateRun.id
  });
  const resolved = domain.resolveProductionTemplate({
    businessId,
    agentId: initial.template.agentId,
    modelId: baseModelId
  });
  const rollback = domain.rollback({
    sessionId: "demo-session",
    businessId,
    templateId: initial.template.id
  });
  const portable = domain.exportTemplate({
    sessionId: "demo-session",
    businessId,
    templateVersionId: candidateVersionId
  });
  domain.verifyArtifact({
    manifest: portable.manifest,
    expectedManifestSha256: portable.manifestSha256,
    files: portable.files
  });
  return {
    template: initial.template,
    baseline: baselineRun.metrics,
    candidate: candidateRun.metrics,
    reportCard,
    datasetV2: datasetV2.dataset,
    improvement,
    promotion,
    resolved,
    rollback,
    portable: {
      fileName: portable.fileName,
      manifestSha256: portable.manifestSha256,
      fileCount: Object.keys(portable.files).length
    },
    telemetry
  };
}

function productOutput(productType: string, category: string, quantity: number, unit: string) {
  return { department: "food", category, productType, quantity, unit };
}

function retailProductManifest(): GrogoniModelTemplateManifestV1 {
  const verbosePrompt = Array.from(
    { length: 8 },
    () =>
      "Always carefully classify the retail product using the full business taxonomy, preserve the measured quantity and unit, and return only the required structured fields."
  ).join(" ");
  return {
    format: "grogoni-template",
    formatVersion: 1,
    template: {
      id: "retail-product-classifier-demo",
      slug: "retail-product-classifier",
      name: "Retail Product Classification Expert",
      version: "1.0.0",
      domain: "retail.catalog",
      businessId,
      agentId: "builtin:shopkeeper"
    },
    tasks: ["catalog.product-classify"],
    validatedTaskDistribution: {
      id: "demo.retail-product-classify",
      description: "Demo retail product classification evaluation distribution.",
      suiteIds: ["demo-suite"]
    },
    minimumModelCapability: {
      tier: "local-chat-2048",
      requiredCapabilities: ["chat"],
      minimumContextWindow: 2048
    },
    vocabularySnapshot: {
      id: emptyVocabularySnapshotId,
      algorithm: "APPROVED_VOCABULARY_SHA256_V1"
    },
    capabilities: ["structured-output", "offline"],
    baseModel: {
      mode: "compatible",
      requirements: {
        requiredCapabilities: ["chat"],
        minimumContextWindow: 2048,
        preferredModels: [baseModelId],
        testedModels: [baseModelId],
        incompatibleModels: []
      }
    },
    expertise: {
      source: {
        instructions: ["Classify retail products and preserve quantity and unit."],
        vocabulary: { rice: ["basmati"] },
        rules: [
          {
            id: "rice:basmati",
            match: "basmati rice",
            output: {
              department: "food",
              category: "cereals",
              productType: "rice",
              quantity: 1,
              unit: "unit"
            },
            provenance: "AUTHOR",
            sourceCorrectionId: null
          }
        ]
      },
      compiledArtifacts: []
    },
    runtime: {
      prompt: verbosePrompt,
      tools: [],
      outputSchemas: [],
      contextRequirements: [],
      constraints: {
        defaultOutput: {
          department: "unknown",
          category: "unknown",
          productType: "unknown",
          quantity: 1,
          unit: "unit"
        }
      }
    },
    evaluation: {
      suiteIds: [],
      baselineMetrics: {},
      templateVocabularySnapshot: emptyVocabularySnapshotId,
      currentVocabularySnapshot: emptyVocabularySnapshotId
    },
    lineage: {
      parentVersionId: null,
      improvementRunId: null,
      datasetVersionId: null,
      createdBy: actorId,
      createdAt: "2026-09-01T00:00:00.000Z",
      changeSummary: "Initial expert-authored product taxonomy."
    },
    ownership: { businessId, visibility: "PRIVATE" },
    checksums: {}
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runRetailProductExpertDemo()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
