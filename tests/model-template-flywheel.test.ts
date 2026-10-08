import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RuntimeModelPrompt, RuntimeModelProvider } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { runRetailProductExpertDemo } from "../services/api/src/cp2/domains/model-templates/demo/demo-run";
import {
  emptyVocabularySnapshotId,
  validateManifest
} from "../services/api/src/cp2/domains/model-templates/manifest";
import { createModelTemplatesDomain } from "../services/api/src/cp2/domains/model-templates/store";
import { executeDeterministicRuleExpertise } from "../services/api/src/cp2/domains/model-templates/strategies";
import type {
  ModelTemplateRecord,
  ModelTemplateVersionRecord,
  GrogoniModelTemplateManifestV1,
  TemplateReportCard
} from "../services/api/src/cp2/domains/model-templates/types";

/** Everything the model receives for a turn: trusted agent instructions plus the user turn. */
function promptText(prompt: { message: string; agentInstructions?: string } | undefined): string {
  return prompt === undefined ? "" : [prompt.agentInstructions ?? "", prompt.message].join("\n");
}

const baseModelId = "qwen2.5-0.5b-android";

describe("Grogoni Model Templates expertise flywheel", () => {
  it("runs the deterministic recursive expertise demonstration end to end", async () => {
    const result = await runRetailProductExpertDemo();

    expect(result.baseline).toMatchObject({ taskSuccessRate: 50, passed: 1, failed: 1 });
    expect(result.candidate).toMatchObject({
      taskSuccessRate: 100,
      passed: 2,
      failed: 0,
      regressionCount: 0
    });
    expect(result.reportCard.scoreDelta).toBe(50);
    expect(result.reportCard.promptTokenReductionPercent).toBeGreaterThan(75);
    expect(result.datasetV2).toMatchObject({ version: 2, status: "FROZEN", exampleCount: 1 });
    expect(result.improvement).toMatchObject({
      strategy: "PROMPT_OPTIMIZATION",
      status: "COMPLETED"
    });
    expect(result.promotion.decision).toBe("PROMOTED");
    expect(result.resolved?.compiledInstructions.join("\n")).toContain("pishori rice");
    expect(result.rollback.decision).toBe("ROLLED_BACK");
    expect(result.portable).toMatchObject({
      fileName: "retail-product-classifier-1.1.0.grogoni.com",
      fileCount: 3
    });
    expect(result.telemetry.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "template.created",
        "evaluation.completed",
        "correction.approved",
        "dataset.version_created",
        "improvement.completed",
        "template.promoted",
        "template.rolled_back"
      ])
    );
  });

  it("serves the complete lifecycle over tenant-scoped APIs and compiles promotion into normal runtime prompts", async () => {
    const prompts: RuntimeModelPrompt[] = [];
    const provider: RuntimeModelProvider = {
      name: "model-template-test",
      async complete(prompt) {
        prompts.push(prompt);
        return {
          provider: "model-template-test",
          status: "available",
          outputText: JSON.stringify({ type: "response", message: "Template runtime ready." }),
          durationMs: 1,
          errorCode: null,
          metadata: { promptTokens: 10, completionTokens: 4 }
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009101", "Template Shop");
    const outsider = await createOwnerBusiness(app, "+254700009102", "Other Shop");
    const profile = await api<{ agentId: string }>(
      app,
      "GET",
      `/businesses/${owner.businessId}/agent-profile`,
      owner.cookie
    );

    const created = await api<{
      template: ModelTemplateRecord;
      version: ModelTemplateVersionRecord;
    }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates`,
      owner.cookie,
      {
        manifest: manifest(owner.businessId, profile.agentId),
        baseModelId
      },
      201
    );
    const expectedBasmati = product("rice", "cereals", 1, "kg");
    const expectedPishori = product("rice", "cereals", 2, "kg");
    const suite = await api<{
      suite: { id: string };
      cases: Array<{ id: string }>;
    }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/evaluation-suites`,
      owner.cookie,
      {
        name: "Retail regression suite",
        cases: [
          {
            name: "Basmati",
            input: "1kg basmati rice",
            matcher: { type: "EXACT", expected: expectedBasmati }
          },
          {
            name: "Pishori",
            input: "2kg Pishori rice",
            matcher: { type: "EXACT", expected: expectedPishori }
          }
        ]
      },
      201
    );
    const baseline = await api<{ id: string; metrics: { taskSuccessRate: number } }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/evaluations`,
      owner.cookie,
      {
        suiteId: suite.suite.id,
        candidateVersionId: created.version.id,
        baselineVersionId: null
      },
      201
    );
    expect(baseline.metrics.taskSuccessRate).toBe(50);
    await api(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/promotions`,
      owner.cookie,
      { candidateVersionId: created.version.id, evaluationRunId: baseline.id }
    );
    const observation = await api<{ id: string; state: string; riskFlags: string[] }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/observations`,
      owner.cookie,
      {
        templateVersionId: created.version.id,
        input: "2kg Pishori rice",
        relevantContext: { apiKey: "must-not-survive" },
        output: product("unknown", "unknown", 2, "kg"),
        suspectedFailure: true,
        failureReason: "Pishori was not recognized."
      },
      201
    );
    expect(observation).toMatchObject({
      state: "CANDIDATE_FAILURE",
      riskFlags: ["SECRET_REDACTED"]
    });
    const correction = await api<{ id: string }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/corrections`,
      owner.cookie,
      {
        observationId: observation.id,
        correctedOutput: expectedPishori,
        explanation: "Pishori is rice."
      },
      201
    );
    const unapprovedDataset = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/model-templates/${created.template.id}/datasets`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        name: "Unsafe dataset",
        examples: [{ correctionId: correction.id, split: "TRAINING" }]
      })
    });
    expect(unapprovedDataset.statusCode).toBe(409);
    expect(unapprovedDataset.json()).toMatchObject({ code: "CORRECTION_NOT_APPROVED" });

    await api(
      app,
      "POST",
      `/businesses/${owner.businessId}/corrections/${correction.id}/approval`,
      owner.cookie,
      { approve: true }
    );
    const dataset = await api<{ dataset: { id: string; status: string } }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/datasets`,
      owner.cookie,
      {
        name: "Approved correction v1",
        examples: [{ correctionId: correction.id, split: "TRAINING" }]
      },
      201
    );
    expect(dataset.dataset.status).toBe("FROZEN");
    const unsupported = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/model-templates/${created.template.id}/improvement-runs`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        parentVersionId: created.version.id,
        datasetVersionId: dataset.dataset.id,
        evaluationSuiteId: suite.suite.id,
        targetBaseModelId: baseModelId,
        strategy: "ADAPTER_TRAINING"
      })
    });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toMatchObject({ code: "IMPROVEMENT_STRATEGY_UNSUPPORTED" });

    const improvement = await api<{ candidateVersionId: string; status: string }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/improvement-runs`,
      owner.cookie,
      {
        parentVersionId: created.version.id,
        datasetVersionId: dataset.dataset.id,
        evaluationSuiteId: suite.suite.id,
        targetBaseModelId: baseModelId,
        strategy: "PROMPT_OPTIMIZATION"
      },
      201
    );
    const candidate = await api<{ id: string }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/evaluations`,
      owner.cookie,
      {
        suiteId: suite.suite.id,
        candidateVersionId: improvement.candidateVersionId,
        baselineVersionId: created.version.id
      },
      201
    );
    const report = await api<TemplateReportCard>(
      app,
      "GET",
      `/businesses/${owner.businessId}/evaluations/${candidate.id}/report-card`,
      owner.cookie
    );
    expect(report).toMatchObject({ scoreDelta: 50, correctionsIncorporated: 1 });
    expect(report.promptTokenReductionPercent).toBeGreaterThan(75);
    const unauthorizedPromotion = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/model-templates/${created.template.id}/promotions`,
      headers: jsonHeaders(outsider.cookie),
      payload: JSON.stringify({
        candidateVersionId: improvement.candidateVersionId,
        evaluationRunId: candidate.id
      })
    });
    expect(unauthorizedPromotion.statusCode).toBe(403);
    await api(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/promotions`,
      owner.cookie,
      { candidateVersionId: improvement.candidateVersionId, evaluationRunId: candidate.id }
    );

    await api(app, "POST", `/businesses/${owner.businessId}/runtime/turns`, owner.cookie, {
      message: "Classify 2kg Pishori rice"
    });
    expect(promptText(prompts.at(-1)).toLowerCase()).toContain("pishori rice =>");
    expect(prompts.at(-1)?.modelTemplate).toMatchObject({
      templateId: created.template.id,
      templateVersionId: improvement.candidateVersionId,
      task: "catalog.product-classify",
      allowedTools: [],
      constraints: { defaultOutput: product("unknown", "unknown", 1, "unit") },
      templateVocabularySnapshot: emptyVocabularySnapshotId,
      currentVocabularySnapshot: emptyVocabularySnapshotId
    });
    expect(prompts.at(-1)?.allowedTools).toEqual([]);

    const portable = await api<{
      manifest: GrogoniModelTemplateManifestV1;
      manifestSha256: string;
      files: Record<string, string>;
    }>(
      app,
      "GET",
      `/businesses/${owner.businessId}/model-template-versions/${improvement.candidateVersionId}/export`,
      owner.cookie
    );
    expect(() =>
      store.verifyModelTemplateArtifact({
        manifest: portable.manifest,
        expectedManifestSha256: portable.manifestSha256,
        files: { ...portable.files, "runtime/prompt.txt": "tampered" }
      })
    ).toThrowError(expect.objectContaining({ code: "GROGONI_ARTIFACT_CHECKSUM_INVALID" }));

    const crossTenant = await app.inject({
      method: "GET",
      url: `/businesses/${owner.businessId}/model-templates/${created.template.id}`,
      headers: { cookie: outsider.cookie }
    });
    expect(crossTenant.statusCode).toBe(403);

    const rollback = await api<{ decision: string }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/model-templates/${created.template.id}/rollback`,
      owner.cookie,
      {}
    );
    expect(rollback.decision).toBe("ROLLED_BACK");
    const snapshot = store.snapshot();
    expect(snapshot.modelTemplates).toHaveLength(1);
    expect(snapshot.modelTemplateVersions).toHaveLength(2);
    expect(snapshot.datasetVersions).toHaveLength(1);

    await app.close();
  });

  it("detects a candidate regression and persists a rejected promotion decision", async () => {
    const businessId = "regression-shop";
    const domain = createModelTemplatesDomain({
      requireAccess: () => ({ account: { id: "account" }, user: { id: "owner" } }),
      resolveBaseModel: () => ({
        id: baseModelId,
        provider: "local",
        capabilities: ["chat"],
        contextWindow: 4096,
        available: true
      }),
      executeTemplate: async (version, input) => {
        if (version.version === "1.1.0" && input === "1kg basmati rice") {
          return { output: product("unknown", "unknown", 1, "kg") };
        }
        return executeDeterministicRuleExpertise(version, input);
      }
    });
    const created = domain.createTemplate({
      sessionId: "session",
      businessId,
      manifest: manifest(businessId, "agent"),
      baseModelId
    });
    const suite = domain.createEvaluationSuite({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      name: "Regression gate",
      cases: [
        {
          name: "Basmati",
          input: "1kg basmati rice",
          matcher: { type: "EXACT", expected: product("rice", "cereals", 1, "kg") }
        },
        {
          name: "Pishori",
          input: "2kg Pishori rice",
          matcher: { type: "EXACT", expected: product("rice", "cereals", 2, "kg") }
        }
      ]
    });
    const baseline = await domain.runEvaluation({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      suiteId: suite.suite.id,
      candidateVersionId: created.version.id,
      baselineVersionId: null
    });
    domain.promote({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      candidateVersionId: created.version.id,
      evaluationRunId: baseline.id
    });
    const observation = domain.recordObservation({
      sessionId: "session",
      businessId,
      templateVersionId: created.version.id,
      observationInput: "2kg Pishori rice",
      output: product("unknown", "unknown", 2, "kg"),
      suspectedFailure: true
    });
    const correction = domain.submitCorrection({
      sessionId: "session",
      businessId,
      observationId: observation.id,
      correctedOutput: product("rice", "cereals", 2, "kg"),
      explanation: "Pishori is rice."
    });
    domain.approveCorrection({
      sessionId: "session",
      businessId,
      correctionId: correction.id,
      approve: true
    });
    const dataset = domain.createDatasetVersion({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      name: "Correction",
      examples: [{ correctionId: correction.id, split: "TRAINING" }]
    });
    const improvement = domain.startImprovementRun({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      parentVersionId: created.version.id,
      datasetVersionId: dataset.dataset.id,
      evaluationSuiteId: suite.suite.id,
      targetBaseModelId: baseModelId,
      strategy: "PROMPT_OPTIMIZATION"
    });
    const run = await domain.runEvaluation({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      suiteId: suite.suite.id,
      candidateVersionId: improvement.candidateVersionId!,
      baselineVersionId: created.version.id
    });
    expect(run.regressionCaseIds).toEqual([suite.cases[0]!.id]);
    expect(run.metrics).toMatchObject({ taskSuccessRate: 50, regressionCount: 1 });
    const rejected = domain.promote({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      candidateVersionId: improvement.candidateVersionId!,
      evaluationRunId: run.id,
      maxRegressions: 0
    });
    expect(rejected).toMatchObject({ decision: "REJECTED", regressionCount: 1 });
  });

  it("rejects promotion cleanly when a custom threshold is stricter than the evaluation's own gate", async () => {
    // Regression test: promote() used to throw TEMPLATE_VERSION_TRANSITION_INVALID instead of
    // returning a REJECTED decision whenever the caller's minimumScoreDelta/maxRegressions was
    // stricter than what runEvaluation's own internal gate already required. That happened
    // because a version whose own gate passed reaches state PASSED, and the transition table
    // did not allow PASSED -> FAILED, so promote()'s own rejection branch crashed instead of
    // recording the rejection.
    const businessId = "strict-threshold-shop";
    const domain = createModelTemplatesDomain({
      requireAccess: () => ({ account: { id: "account" }, user: { id: "owner" } }),
      resolveBaseModel: () => ({
        id: baseModelId,
        provider: "local",
        capabilities: ["chat"],
        contextWindow: 4096,
        available: true
      }),
      executeTemplate: (version, input) => executeDeterministicRuleExpertise(version, input)
    });
    const created = domain.createTemplate({
      sessionId: "session",
      businessId,
      manifest: manifest(businessId, "agent"),
      baseModelId
    });
    const suite = domain.createEvaluationSuite({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      name: "Strict threshold suite",
      cases: [
        {
          name: "Basmati",
          input: "1kg basmati rice",
          matcher: { type: "EXACT", expected: product("rice", "cereals", 1, "unit") }
        }
      ]
    });
    const run = await domain.runEvaluation({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      suiteId: suite.suite.id,
      candidateVersionId: created.version.id,
      baselineVersionId: null
    });
    expect(run.regressionCaseIds).toEqual([]);
    const passedState = domain.listVersions({
      sessionId: "session",
      businessId,
      templateId: created.template.id
    });
    expect(passedState[0]?.state).toBe("PASSED");

    const rejected = domain.promote({
      sessionId: "session",
      businessId,
      templateId: created.template.id,
      candidateVersionId: created.version.id,
      evaluationRunId: run.id,
      minimumScoreDelta: 1000
    });
    expect(rejected.decision).toBe("REJECTED");
    const versions = domain.listVersions({
      sessionId: "session",
      businessId,
      templateId: created.template.id
    });
    expect(versions[0]?.state).toBe("FAILED");
  });

  it("validates provider-independent manifests and rejects unsafe tools or architecture-free adapters", () => {
    const valid = manifest("business", "agent");
    expect(() => validateManifest(valid)).not.toThrow();
    expect(() =>
      validateManifest({ ...valid, runtime: { ...valid.runtime, tools: ["shell.exec"] } })
    ).toThrowError(expect.objectContaining({ code: "GROGONI_MANIFEST_INVALID" }));
    expect(() =>
      validateManifest({
        ...valid,
        expertise: {
          ...valid.expertise,
          compiledArtifacts: [
            {
              id: "unsafe-adapter",
              kind: "ADAPTER",
              baseModelId: null,
              baseArchitecture: null,
              objectKey: "adapters/model.bin",
              inlineSha256: `sha256:${"0".repeat(64)}`,
              sizeBytes: 10
            }
          ]
        }
      })
    ).toThrowError(expect.objectContaining({ code: "GROGONI_MANIFEST_INVALID" }));
  });

  it("adds a forward-only relational migration without reviving retired execution fabric tables", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/081_model_template_expertise_flywheel.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("create table if not exists cp2_model_templates");
    expect(migration).toContain("create table if not exists cp2_template_dataset_versions");
    expect(migration).toContain("references cp2_model_template_versions(entity_id)");
    expect(migration).toContain("frozen model-template records are immutable");
    expect(migration).not.toMatch(/create table[^;]*execution_fabric/iu);
    expect(migration).not.toMatch(/bytea/iu);
  });
});

function manifest(businessId: string, agentId: string): GrogoniModelTemplateManifestV1 {
  return {
    format: "grogoni-template",
    formatVersion: 1,
    template: {
      id: "retail-template-test",
      slug: "retail-product-classifier",
      name: "Retail Product Classification Expert",
      version: "1.0.0",
      domain: "retail.catalog",
      businessId,
      agentId
    },
    tasks: ["catalog.product-classify"],
    validatedTaskDistribution: {
      id: "test.retail-product-classify",
      description: "Retail product classification test distribution.",
      suiteIds: ["suite:test"]
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
    capabilities: ["structured-output"],
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
        instructions: ["Classify products and preserve quantity and unit."],
        vocabulary: { rice: ["basmati"] },
        rules: [
          {
            id: "rice:basmati",
            match: "basmati rice",
            output: product("rice", "cereals", 1, "unit"),
            provenance: "AUTHOR",
            sourceCorrectionId: null
          }
        ]
      },
      compiledArtifacts: []
    },
    runtime: {
      prompt: "Always carefully classify the product and preserve quantity and unit. ".repeat(20),
      tools: [],
      outputSchemas: [],
      contextRequirements: [],
      constraints: { defaultOutput: product("unknown", "unknown", 1, "unit") }
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
      createdBy: "owner",
      createdAt: "2026-09-02T00:00:00.000Z",
      changeSummary: "Initial expert version."
    },
    ownership: { businessId, visibility: "PRIVATE" },
    checksums: {}
  };
}

function product(productType: string, category: string, quantity: number, unit: string) {
  return {
    department: productType === "unknown" ? "unknown" : "food",
    category,
    productType,
    quantity,
    unit
  };
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
): Promise<{ businessId: string; cookie: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const header = signup.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) throw new Error("Expected session cookie.");
  const cookie = raw.split(";")[0] ?? raw;
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(business.statusCode).toBe(200);
  return { businessId: business.json<{ business: { id: string } }>().business.id, cookie };
}

async function api<T = unknown>(
  app: ReturnType<typeof buildApi>,
  method: "GET" | "POST",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
  expectedStatus = 200
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    headers: jsonHeaders(cookie),
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
  });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response.json<T>();
}

function jsonHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie })
  };
}
