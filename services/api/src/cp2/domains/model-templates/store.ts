import { randomUUID } from "node:crypto";
import { Cp2Error } from "../../cp2-error.js";
import { EvaluationService } from "../evaluation/service.js";
import {
  assertCompatibleBaseModel,
  bumpMinorVersion,
  canonicalJson,
  estimatePromptTokens,
  manifestSha256,
  sha256,
  validateManifest,
  verifyExportChecksums
} from "./manifest.js";
import { executeDeterministicRuleExpertise, optimizePromptExpertise } from "./strategies.js";
import type {
  BaseModelDescriptor,
  DatasetExampleRecord,
  DatasetSplit,
  DatasetVersionRecord,
  EvaluationCaseRecord,
  EvaluationMatcher,
  EvaluationMetrics,
  EvaluationResultRecord,
  EvaluationRunRecord,
  EvaluationSuiteRecord,
  ExpertCorrectionRecord,
  ExpertiseArtifactRecord,
  ImprovementRunRecord,
  JsonValue,
  JudgeEvaluator,
  ModelTemplateRecord,
  ModelTemplateVersionRecord,
  OptimizationStrategy,
  ProductionObservationRecord,
  GrogoniModelTemplateManifestV1,
  TemplateExecutor,
  TemplatePromotionRecord,
  TemplateReportCard,
  TemplateRuntimeBindingRecord,
  TemplateTelemetryEvent
} from "./types.js";

interface AuthorizedActor {
  account: { id: string };
  user: { id: string };
}

export interface ModelTemplatesDomainDeps {
  requireAccess: (
    sessionId: string | null,
    businessId: string,
    permission: "business:read" | "launch:write",
    now: Date
  ) => AuthorizedActor;
  resolveBaseModel: (modelId: string) => BaseModelDescriptor | null;
  executeTemplate?: TemplateExecutor;
  judgeEvaluator?: JudgeEvaluator;
  emitTelemetry?: (event: TemplateTelemetryEvent) => void;
}

export interface ModelTemplatesSnapshot {
  modelTemplates?: ModelTemplateRecord[];
  modelTemplateVersions?: ModelTemplateVersionRecord[];
  expertiseArtifacts?: ExpertiseArtifactRecord[];
  evaluationSuites?: EvaluationSuiteRecord[];
  evaluationCases?: EvaluationCaseRecord[];
  evaluationRuns?: EvaluationRunRecord[];
  evaluationResults?: EvaluationResultRecord[];
  productionObservations?: ProductionObservationRecord[];
  expertCorrections?: ExpertCorrectionRecord[];
  datasetVersions?: DatasetVersionRecord[];
  datasetExamples?: DatasetExampleRecord[];
  improvementRuns?: ImprovementRunRecord[];
  templatePromotions?: TemplatePromotionRecord[];
  templateRuntimeBindings?: TemplateRuntimeBindingRecord[];
}

export class ModelTemplatesDomain {
  private readonly evaluationService: EvaluationService;
  private readonly modelTemplates = new Map<string, ModelTemplateRecord>();
  private readonly modelTemplateVersions = new Map<string, ModelTemplateVersionRecord>();
  private readonly expertiseArtifacts = new Map<string, ExpertiseArtifactRecord>();
  private readonly evaluationSuites = new Map<string, EvaluationSuiteRecord>();
  private readonly evaluationCases = new Map<string, EvaluationCaseRecord>();
  private readonly evaluationRuns = new Map<string, EvaluationRunRecord>();
  private readonly evaluationResults = new Map<string, EvaluationResultRecord>();
  private readonly productionObservations = new Map<string, ProductionObservationRecord>();
  private readonly expertCorrections = new Map<string, ExpertCorrectionRecord>();
  private readonly datasetVersions = new Map<string, DatasetVersionRecord>();
  private readonly datasetExamples = new Map<string, DatasetExampleRecord>();
  private readonly improvementRuns = new Map<string, ImprovementRunRecord>();
  private readonly templatePromotions = new Map<string, TemplatePromotionRecord>();
  private readonly templateRuntimeBindings = new Map<string, TemplateRuntimeBindingRecord>();

  constructor(private readonly deps: ModelTemplatesDomainDeps) {
    this.evaluationService = new EvaluationService(deps.judgeEvaluator);
  }

  get modelTemplatesMap(): ReadonlyMap<string, ModelTemplateRecord> {
    return this.modelTemplates;
  }
  get modelTemplateVersionsMap(): ReadonlyMap<string, ModelTemplateVersionRecord> {
    return this.modelTemplateVersions;
  }
  get expertiseArtifactsMap(): ReadonlyMap<string, ExpertiseArtifactRecord> {
    return this.expertiseArtifacts;
  }
  get evaluationSuitesMap(): ReadonlyMap<string, EvaluationSuiteRecord> {
    return this.evaluationSuites;
  }
  get evaluationCasesMap(): ReadonlyMap<string, EvaluationCaseRecord> {
    return this.evaluationCases;
  }
  get evaluationRunsMap(): ReadonlyMap<string, EvaluationRunRecord> {
    return this.evaluationRuns;
  }
  get evaluationResultsMap(): ReadonlyMap<string, EvaluationResultRecord> {
    return this.evaluationResults;
  }
  get productionObservationsMap(): ReadonlyMap<string, ProductionObservationRecord> {
    return this.productionObservations;
  }
  get expertCorrectionsMap(): ReadonlyMap<string, ExpertCorrectionRecord> {
    return this.expertCorrections;
  }
  get datasetVersionsMap(): ReadonlyMap<string, DatasetVersionRecord> {
    return this.datasetVersions;
  }
  get datasetExamplesMap(): ReadonlyMap<string, DatasetExampleRecord> {
    return this.datasetExamples;
  }
  get improvementRunsMap(): ReadonlyMap<string, ImprovementRunRecord> {
    return this.improvementRuns;
  }
  get templatePromotionsMap(): ReadonlyMap<string, TemplatePromotionRecord> {
    return this.templatePromotions;
  }
  get templateRuntimeBindingsMap(): ReadonlyMap<string, TemplateRuntimeBindingRecord> {
    return this.templateRuntimeBindings;
  }

  clear(): void {
    for (const map of this.maps()) map.clear();
  }

  restore(snapshot: ModelTemplatesSnapshot): void {
    this.clear();
    restoreMap(this.modelTemplates, snapshot.modelTemplates);
    restoreMap(this.modelTemplateVersions, snapshot.modelTemplateVersions);
    restoreMap(this.expertiseArtifacts, snapshot.expertiseArtifacts);
    restoreMap(this.evaluationSuites, snapshot.evaluationSuites);
    restoreMap(this.evaluationCases, snapshot.evaluationCases);
    restoreMap(this.evaluationRuns, snapshot.evaluationRuns);
    restoreMap(this.evaluationResults, snapshot.evaluationResults);
    restoreMap(this.productionObservations, snapshot.productionObservations);
    restoreMap(this.expertCorrections, snapshot.expertCorrections);
    restoreMap(this.datasetVersions, snapshot.datasetVersions);
    restoreMap(this.datasetExamples, snapshot.datasetExamples);
    restoreMap(this.improvementRuns, snapshot.improvementRuns);
    restoreMap(this.templatePromotions, snapshot.templatePromotions);
    restoreMap(this.templateRuntimeBindings, snapshot.templateRuntimeBindings);
  }

  deleteBusinessData(businessId: string): number {
    let deleted = 0;
    for (const map of this.maps()) {
      for (const [id, value] of map) {
        if (
          value !== null &&
          typeof value === "object" &&
          "businessId" in value &&
          value.businessId === businessId
        ) {
          map.delete(id);
          deleted += 1;
        }
      }
    }
    return deleted;
  }

  deleteBusinessesInScope(scope: ReadonlySet<string>): number {
    let deleted = 0;
    for (const businessId of scope) deleted += this.deleteBusinessData(businessId);
    return deleted;
  }

  createTemplate(input: {
    sessionId: string | null;
    businessId: string;
    manifest: GrogoniModelTemplateManifestV1;
    baseModelId: string;
    nativeRuntimeBindingId?: string | null;
    executionHostId?: string | null;
    now?: Date;
  }): { template: ModelTemplateRecord; version: ModelTemplateVersionRecord } {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    validateManifest(input.manifest);
    if (
      input.manifest.template.businessId !== input.businessId ||
      input.manifest.ownership.businessId !== input.businessId
    ) {
      throw new Cp2Error(
        403,
        "TEMPLATE_TENANT_MISMATCH",
        "Template ownership belongs to another business."
      );
    }
    if (
      [...this.modelTemplates.values()].some(
        (template) =>
          template.businessId === input.businessId && template.slug === input.manifest.template.slug
      )
    ) {
      throw new Cp2Error(
        409,
        "TEMPLATE_SLUG_EXISTS",
        "A template with this slug already exists in the business."
      );
    }
    assertCompatibleBaseModel(
      input.manifest.baseModel.requirements,
      this.deps.resolveBaseModel(input.baseModelId)
    );
    const templateId = randomUUID();
    const createdAt = now.toISOString();
    const manifest = structuredClone(input.manifest);
    manifest.template.businessId = input.businessId;
    manifest.ownership.businessId = input.businessId;
    manifest.lineage.createdBy = actor.user.id;
    manifest.lineage.createdAt = createdAt;
    validateManifest(manifest);
    const template: ModelTemplateRecord = {
      id: templateId,
      businessId: input.businessId,
      accountId: actor.account.id,
      agentId: manifest.template.agentId,
      slug: manifest.template.slug,
      name: manifest.template.name,
      domain: manifest.template.domain,
      tasks: [...manifest.tasks],
      productionVersionId: null,
      previousProductionVersionId: null,
      createdBy: actor.user.id,
      createdAt,
      updatedAt: createdAt
    };
    const version = this.insertVersion({
      template,
      manifest,
      baseModelId: input.baseModelId,
      nativeRuntimeBindingId: input.nativeRuntimeBindingId ?? null,
      executionHostId: input.executionHostId ?? null,
      state: "DRAFT",
      actorId: actor.user.id,
      now
    });
    this.modelTemplates.set(template.id, template);
    this.emit("template.created", template, version, undefined, now, {
      baseModelId: input.baseModelId
    });
    return { template: clone(template), version: clone(version) };
  }

  listTemplates(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ModelTemplateRecord[] {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    return [...this.modelTemplates.values()]
      .filter((item) => item.businessId === input.businessId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  getTemplate(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    now?: Date;
  }): ModelTemplateRecord {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    return clone(this.requireTemplate(input.businessId, input.templateId));
  }

  listVersions(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    now?: Date;
  }): ModelTemplateVersionRecord[] {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    this.requireTemplate(input.businessId, input.templateId);
    return this.versionsForTemplate(input.templateId).map(clone);
  }

  getLineage(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    now?: Date;
  }): {
    template: ModelTemplateRecord;
    versions: ModelTemplateVersionRecord[];
    promotions: TemplatePromotionRecord[];
  } {
    const template = this.getTemplate(input);
    return {
      template,
      versions: this.versionsForTemplate(input.templateId).map(clone),
      promotions: [...this.templatePromotions.values()]
        .filter((item) => item.templateId === input.templateId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(clone)
    };
  }

  createEvaluationSuite(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    name: string;
    description?: string;
    cases?: Array<{
      name: string;
      input: JsonValue;
      contextFixture?: Record<string, JsonValue>;
      toolFixture?: Record<string, JsonValue>;
      matcher: EvaluationMatcher;
      tags?: string[];
    }>;
    now?: Date;
  }): { suite: EvaluationSuiteRecord; cases: EvaluationCaseRecord[] } {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const template = this.requireTemplate(input.businessId, input.templateId);
    const createdAt = now.toISOString();
    const suite: EvaluationSuiteRecord = {
      id: randomUUID(),
      templateId: template.id,
      businessId: template.businessId,
      accountId: template.accountId,
      name: boundedText(input.name, "evaluation suite name", 120),
      description: boundedOptionalText(input.description, 1000),
      version:
        Math.max(
          0,
          ...[...this.evaluationSuites.values()]
            .filter((item) => item.templateId === template.id)
            .map((item) => item.version)
        ) + 1,
      frozenAt: null,
      createdBy: actor.user.id,
      createdAt
    };
    this.evaluationSuites.set(suite.id, suite);
    const cases = (input.cases ?? []).map((item) =>
      this.insertEvaluationCase(suite, item, actor.user.id, now)
    );
    return { suite: clone(suite), cases: cases.map(clone) };
  }

  addEvaluationCase(input: {
    sessionId: string | null;
    businessId: string;
    suiteId: string;
    name: string;
    caseInput: JsonValue;
    contextFixture?: Record<string, JsonValue>;
    toolFixture?: Record<string, JsonValue>;
    matcher: EvaluationMatcher;
    tags?: string[];
    now?: Date;
  }): EvaluationCaseRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const suite = this.requireSuite(input.businessId, input.suiteId);
    if (suite.frozenAt !== null) {
      throw new Cp2Error(
        409,
        "EVALUATION_SUITE_IMMUTABLE",
        "A used evaluation suite is immutable; create a new suite version."
      );
    }
    return clone(
      this.insertEvaluationCase(
        suite,
        {
          name: input.name,
          input: input.caseInput,
          matcher: input.matcher,
          ...(input.contextFixture === undefined ? {} : { contextFixture: input.contextFixture }),
          ...(input.toolFixture === undefined ? {} : { toolFixture: input.toolFixture }),
          ...(input.tags === undefined ? {} : { tags: input.tags })
        },
        actor.user.id,
        now
      )
    );
  }

  async runEvaluation(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    suiteId: string;
    candidateVersionId: string;
    baselineVersionId?: string | null;
    now?: Date;
  }): Promise<EvaluationRunRecord> {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const template = this.requireTemplate(input.businessId, input.templateId);
    const suite = this.requireSuite(input.businessId, input.suiteId);
    if (suite.templateId !== template.id) throw notFound("Evaluation suite");
    const candidate = this.requireVersion(input.businessId, input.candidateVersionId);
    if (candidate.templateId !== template.id) throw notFound("Template version");
    const baselineId =
      input.baselineVersionId === undefined
        ? template.productionVersionId
        : input.baselineVersionId;
    const baseline = baselineId === null ? null : this.requireVersion(input.businessId, baselineId);
    const cases = this.casesForSuite(suite.id);
    if (cases.length === 0) {
      throw new Cp2Error(409, "EVALUATION_SUITE_EMPTY", "Evaluation requires at least one case.");
    }
    const run: EvaluationRunRecord = {
      id: randomUUID(),
      suiteId: suite.id,
      templateId: template.id,
      businessId: template.businessId,
      accountId: template.accountId,
      candidateVersionId: candidate.id,
      baselineVersionId: baseline?.id ?? null,
      status: "RUNNING",
      metrics: null,
      baselineMetrics: null,
      regressionCaseIds: [],
      errorCode: null,
      startedBy: actor.user.id,
      startedAt: now.toISOString(),
      completedAt: null
    };
    this.evaluationRuns.set(run.id, run);
    this.updateVersionState(candidate, "EVALUATING");
    this.evaluationSuites.set(suite.id, {
      ...suite,
      frozenAt: suite.frozenAt ?? now.toISOString()
    });
    this.emit("evaluation.started", template, candidate, run.id, now, { caseCount: cases.length });
    const executor = this.deps.executeTemplate ?? executeDeterministicRuleExpertise;
    try {
      const [candidateExecution, baselineExecution] = await Promise.all([
        this.evaluationService.execute({ version: candidate, cases, executor }),
        baseline === null
          ? Promise.resolve(null)
          : this.evaluationService.execute({ version: baseline, cases, executor })
      ]);
      const baselineByCase = new Map(
        (baselineExecution?.results ?? []).map((result) => [result.caseId, result])
      );
      const regressionCaseIds = candidateExecution.results
        .filter((result) => baselineByCase.get(result.caseId)?.passed === true && !result.passed)
        .map((result) => result.caseId);
      const metrics = calculateMetrics(
        candidate,
        candidateExecution.results,
        candidateExecution.durationMs,
        regressionCaseIds.length
      );
      const baselineMetrics =
        baseline === null || baselineExecution === null
          ? null
          : calculateMetrics(baseline, baselineExecution.results, baselineExecution.durationMs, 0);
      for (const result of candidateExecution.results) {
        const stored: EvaluationResultRecord = {
          id: randomUUID(),
          evaluationRunId: run.id,
          caseId: result.caseId,
          templateId: template.id,
          businessId: template.businessId,
          accountId: template.accountId,
          candidatePassed: result.passed,
          baselinePassed: baselineByCase.get(result.caseId)?.passed ?? null,
          evaluatorType: result.evaluatorType,
          score: result.score,
          latencyMs: result.latencyMs,
          output: result.output,
          details: result.details,
          createdAt: now.toISOString()
        };
        this.evaluationResults.set(stored.id, stored);
      }
      const completed: EvaluationRunRecord = {
        ...run,
        status: "COMPLETED",
        metrics,
        baselineMetrics,
        regressionCaseIds,
        completedAt: new Date().toISOString()
      };
      this.evaluationRuns.set(run.id, completed);
      const gatesPassed =
        regressionCaseIds.length === 0 &&
        (baselineMetrics === null || metrics.taskSuccessRate >= baselineMetrics.taskSuccessRate);
      this.updateVersionState(
        this.requireVersion(input.businessId, candidate.id),
        gatesPassed ? "PASSED" : "FAILED"
      );
      this.emit("evaluation.completed", template, candidate, run.id, new Date(), {
        passed: metrics.passed,
        failed: metrics.failed,
        regressions: regressionCaseIds.length
      });
      if (regressionCaseIds.length > 0) {
        this.emit("evaluation.regression_detected", template, candidate, run.id, new Date(), {
          regressions: regressionCaseIds.length
        });
      }
      return clone(completed);
    } catch (error) {
      const failed: EvaluationRunRecord = {
        ...run,
        status: "FAILED",
        errorCode: error instanceof Cp2Error ? error.code : "EVALUATION_FAILED",
        completedAt: new Date().toISOString()
      };
      this.evaluationRuns.set(run.id, failed);
      this.updateVersionState(this.requireVersion(input.businessId, candidate.id), "FAILED");
      throw error;
    }
  }

  getEvaluation(input: {
    sessionId: string | null;
    businessId: string;
    evaluationRunId: string;
    now?: Date;
  }): { run: EvaluationRunRecord; results: EvaluationResultRecord[] } {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    const run = this.requireEvaluationRun(input.businessId, input.evaluationRunId);
    return {
      run: clone(run),
      results: [...this.evaluationResults.values()]
        .filter((result) => result.evaluationRunId === run.id)
        .map(clone)
    };
  }

  getReportCard(input: {
    sessionId: string | null;
    businessId: string;
    evaluationRunId: string;
    now?: Date;
  }): TemplateReportCard {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    const run = this.requireEvaluationRun(input.businessId, input.evaluationRunId);
    if (run.status !== "COMPLETED" || run.metrics === null) {
      throw new Cp2Error(409, "REPORT_CARD_NOT_READY", "The evaluation report card is not ready.");
    }
    const template = this.requireTemplate(input.businessId, run.templateId);
    const version = this.requireVersion(input.businessId, run.candidateVersionId);
    const previous =
      run.baselineVersionId === null
        ? null
        : this.requireVersion(input.businessId, run.baselineVersionId);
    const incorporated = version.manifest.expertise.source.rules.filter(
      (rule) => rule.provenance === "CORRECTION"
    ).length;
    return {
      templateId: template.id,
      templateName: template.name,
      versionId: version.id,
      version: version.version,
      state: version.state,
      baseModelId: version.baseModelId,
      previousVersion: previous?.version ?? null,
      metrics: clone(run.metrics),
      previousMetrics: run.baselineMetrics === null ? null : clone(run.baselineMetrics),
      scoreDelta:
        run.baselineMetrics === null
          ? null
          : round(run.metrics.taskSuccessRate - run.baselineMetrics.taskSuccessRate),
      promptTokenReductionPercent:
        previous === null || previous.promptTokenEstimate === 0
          ? null
          : round(
              ((previous.promptTokenEstimate - version.promptTokenEstimate) /
                previous.promptTokenEstimate) *
                100
            ),
      correctionsIncorporated: incorporated,
      evaluationRunId: run.id
    };
  }

  recordObservation(input: {
    sessionId: string | null;
    businessId: string;
    templateVersionId: string;
    observationInput: JsonValue;
    relevantContext?: Record<string, JsonValue>;
    output: JsonValue;
    suspectedFailure?: boolean;
    failureReason?: string | null;
    sourceConversationId?: string | null;
    now?: Date;
  }): ProductionObservationRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const version = this.requireVersion(input.businessId, input.templateVersionId);
    const template = this.requireTemplate(input.businessId, version.templateId);
    const safeInput = sanitizeBoundedJson(input.observationInput, 32_000, "observation input");
    const safeContext = sanitizeBoundedRecord(
      input.relevantContext ?? {},
      16_000,
      "observation context"
    );
    const safeOutput = sanitizeBoundedJson(input.output, 32_000, "observation output");
    const riskFlags = detectRiskFlags(safeInput, safeContext, safeOutput);
    const record: ProductionObservationRecord = {
      id: randomUUID(),
      templateVersionId: version.id,
      templateId: template.id,
      businessId: template.businessId,
      accountId: template.accountId,
      baseModelId: version.baseModelId,
      nativeRuntimeBindingId: version.nativeRuntimeBindingId,
      executionHostId: version.executionHostId,
      state: input.suspectedFailure ? "CANDIDATE_FAILURE" : "OBSERVED",
      input: safeInput,
      relevantContext: safeContext,
      output: safeOutput,
      failureReason:
        input.failureReason === null || input.failureReason === undefined
          ? null
          : boundedText(input.failureReason, "failure reason", 1000),
      riskFlags,
      sourceConversationId: input.sourceConversationId ?? null,
      createdBy: actor.user.id,
      reviewedBy: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.productionObservations.set(record.id, record);
    return clone(record);
  }

  reviewObservation(input: {
    sessionId: string | null;
    businessId: string;
    observationId: string;
    isFailure: boolean;
    reason?: string;
    now?: Date;
  }): ProductionObservationRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const observation = this.requireObservation(input.businessId, input.observationId);
    if (!input.isFailure) {
      const reviewed = {
        ...observation,
        state: "REVIEWED" as const,
        failureReason: null,
        reviewedBy: actor.user.id,
        updatedAt: now.toISOString()
      };
      this.productionObservations.set(reviewed.id, reviewed);
      return clone(reviewed);
    }
    const reviewed = {
      ...observation,
      state: "REVIEWED" as const,
      failureReason: boundedText(
        input.reason ?? observation.failureReason ?? "Marked incorrect by an expert.",
        "failure reason",
        1000
      ),
      reviewedBy: actor.user.id,
      updatedAt: now.toISOString()
    };
    this.productionObservations.set(reviewed.id, reviewed);
    return clone(reviewed);
  }

  submitCorrection(input: {
    sessionId: string | null;
    businessId: string;
    observationId: string;
    correctedOutput: JsonValue;
    explanation: string;
    rubric?: string | null;
    now?: Date;
  }): ExpertCorrectionRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const observation = this.requireObservation(input.businessId, input.observationId);
    if (observation.state !== "CANDIDATE_FAILURE" && observation.state !== "REVIEWED") {
      throw new Cp2Error(
        409,
        "OBSERVATION_NOT_CORRECTABLE",
        "Only a suspected or reviewed failure can be corrected."
      );
    }
    const correction: ExpertCorrectionRecord = {
      id: randomUUID(),
      observationId: observation.id,
      templateId: observation.templateId,
      businessId: observation.businessId,
      accountId: observation.accountId,
      correctedOutput: sanitizeBoundedJson(input.correctedOutput, 32_000, "corrected output"),
      explanation: boundedText(input.explanation, "correction explanation", 2000),
      rubric:
        input.rubric === null || input.rubric === undefined
          ? null
          : boundedText(input.rubric, "correction rubric", 2000),
      status: "SUBMITTED",
      submittedBy: actor.user.id,
      approvedBy: null,
      submittedAt: now.toISOString(),
      approvedAt: null
    };
    this.expertCorrections.set(correction.id, correction);
    this.productionObservations.set(observation.id, {
      ...observation,
      state: "CORRECTED",
      reviewedBy: observation.reviewedBy ?? actor.user.id,
      updatedAt: now.toISOString()
    });
    this.emit(
      "correction.submitted",
      this.requireTemplate(input.businessId, observation.templateId),
      this.requireVersion(input.businessId, observation.templateVersionId),
      correction.id,
      now,
      {}
    );
    return clone(correction);
  }

  approveCorrection(input: {
    sessionId: string | null;
    businessId: string;
    correctionId: string;
    approve: boolean;
    now?: Date;
  }): ExpertCorrectionRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const correction = this.requireCorrection(input.businessId, input.correctionId);
    if (correction.status !== "SUBMITTED") {
      throw new Cp2Error(
        409,
        "CORRECTION_ALREADY_REVIEWED",
        "This correction has already been reviewed."
      );
    }
    const updated: ExpertCorrectionRecord = {
      ...correction,
      status: input.approve ? "APPROVED" : "REJECTED",
      approvedBy: actor.user.id,
      approvedAt: now.toISOString()
    };
    this.expertCorrections.set(updated.id, updated);
    const observation = this.requireObservation(input.businessId, correction.observationId);
    if (input.approve) {
      this.productionObservations.set(observation.id, {
        ...observation,
        state: "APPROVED",
        updatedAt: now.toISOString()
      });
      this.emit(
        "correction.approved",
        this.requireTemplate(input.businessId, correction.templateId),
        this.requireVersion(input.businessId, observation.templateVersionId),
        correction.id,
        now,
        {}
      );
    }
    return clone(updated);
  }

  createDatasetVersion(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    name: string;
    examples: Array<{
      correctionId?: string | null;
      evaluationCaseId?: string | null;
      split: DatasetSplit;
    }>;
    now?: Date;
  }): { dataset: DatasetVersionRecord; examples: DatasetExampleRecord[] } {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const template = this.requireTemplate(input.businessId, input.templateId);
    if (input.examples.length === 0) {
      throw new Cp2Error(400, "DATASET_EMPTY", "A dataset version requires at least one example.");
    }
    const materialized = input.examples.map((requested) =>
      this.materializeDatasetExample(template, requested, now)
    );
    const contentSha256 = sha256(
      canonicalJson(
        materialized.map((item) => ({
          input: item.input,
          expectedOutput: item.expectedOutput,
          split: item.split,
          correctionId: item.correctionId,
          evaluationCaseId: item.evaluationCaseId
        }))
      )
    );
    const dataset: DatasetVersionRecord = {
      id: randomUUID(),
      templateId: template.id,
      businessId: template.businessId,
      accountId: template.accountId,
      version:
        Math.max(
          0,
          ...[...this.datasetVersions.values()]
            .filter((item) => item.templateId === template.id)
            .map((item) => item.version)
        ) + 1,
      name: boundedText(input.name, "dataset name", 120),
      status: "FROZEN",
      contentSha256,
      exampleCount: materialized.length,
      sourceCorrectionIds: materialized
        .map((item) => item.correctionId)
        .filter((value): value is string => value !== null),
      createdBy: actor.user.id,
      createdAt: now.toISOString()
    };
    this.datasetVersions.set(dataset.id, dataset);
    const storedExamples = materialized.map((item) => {
      const record = { ...item, id: randomUUID(), datasetVersionId: dataset.id };
      this.datasetExamples.set(record.id, record);
      return record;
    });
    this.emit("dataset.version_created", template, undefined, dataset.id, now, {
      version: dataset.version,
      exampleCount: dataset.exampleCount
    });
    return { dataset: clone(dataset), examples: storedExamples.map(clone) };
  }

  getDataset(input: {
    sessionId: string | null;
    businessId: string;
    datasetVersionId: string;
    now?: Date;
  }): { dataset: DatasetVersionRecord; examples: DatasetExampleRecord[] } {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    const dataset = this.datasetVersions.get(input.datasetVersionId);
    if (dataset === undefined || dataset.businessId !== input.businessId) throw notFound("Dataset");
    return {
      dataset: clone(dataset),
      examples: [...this.datasetExamples.values()]
        .filter((example) => example.datasetVersionId === dataset.id)
        .map(clone)
    };
  }

  startImprovementRun(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    parentVersionId: string;
    datasetVersionId: string;
    evaluationSuiteId: string;
    targetBaseModelId: string;
    strategy: OptimizationStrategy;
    strategyConfig?: Record<string, JsonValue>;
    now?: Date;
  }): ImprovementRunRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const template = this.requireTemplate(input.businessId, input.templateId);
    const parent = this.requireVersion(input.businessId, input.parentVersionId);
    const dataset = this.datasetVersions.get(input.datasetVersionId);
    const suite = this.requireSuite(input.businessId, input.evaluationSuiteId);
    if (
      parent.templateId !== template.id ||
      dataset === undefined ||
      dataset.businessId !== input.businessId ||
      dataset.templateId !== template.id ||
      suite.templateId !== template.id
    ) {
      throw new Cp2Error(
        404,
        "IMPROVEMENT_INPUT_NOT_FOUND",
        "Improvement inputs must belong to this template and business."
      );
    }
    assertCompatibleBaseModel(
      parent.manifest.baseModel.requirements,
      this.deps.resolveBaseModel(input.targetBaseModelId)
    );
    const run: ImprovementRunRecord = {
      id: randomUUID(),
      templateVersionId: parent.id,
      templateId: template.id,
      businessId: template.businessId,
      accountId: template.accountId,
      datasetVersionId: dataset.id,
      evaluationSuiteId: suite.id,
      targetBaseModelId: input.targetBaseModelId,
      strategy: input.strategy,
      status: "RUNNING",
      strategyConfig: sanitizeBoundedRecord(input.strategyConfig ?? {}, 8000, "strategy config"),
      candidateVersionId: null,
      errorCode: null,
      startedBy: actor.user.id,
      startedAt: now.toISOString(),
      completedAt: null
    };
    this.improvementRuns.set(run.id, run);
    this.emit("improvement.started", template, parent, run.id, now, { strategy: input.strategy });
    if (input.strategy !== "PROMPT_OPTIMIZATION") {
      const failed = {
        ...run,
        status: "FAILED" as const,
        errorCode: "IMPROVEMENT_STRATEGY_UNSUPPORTED",
        completedAt: now.toISOString()
      };
      this.improvementRuns.set(run.id, failed);
      this.emit("improvement.failed", template, parent, run.id, now, { strategy: input.strategy });
      throw new Cp2Error(
        422,
        "IMPROVEMENT_STRATEGY_UNSUPPORTED",
        `${input.strategy} is declared by the architecture but no worker is configured for it.`
      );
    }
    const examples = [...this.datasetExamples.values()].filter(
      (example) => example.datasetVersionId === dataset.id
    );
    const optimized = optimizePromptExpertise({
      parent,
      examples,
      candidateVersion: bumpMinorVersion(parent.version),
      improvementRunId: run.id,
      datasetVersionId: dataset.id,
      targetBaseModelId: input.targetBaseModelId,
      actorId: actor.user.id,
      createdAt: now.toISOString()
    });
    validateManifest(optimized.manifest);
    const candidate = this.insertVersion({
      template,
      manifest: optimized.manifest,
      baseModelId: input.targetBaseModelId,
      nativeRuntimeBindingId: parent.nativeRuntimeBindingId,
      executionHostId: parent.executionHostId,
      state: "CANDIDATE",
      actorId: actor.user.id,
      now,
      promptTokenEstimate: optimized.promptTokenEstimate,
      artifactSizeBytes: optimized.artifactSizeBytes
    });
    const completed = {
      ...run,
      status: "COMPLETED" as const,
      candidateVersionId: candidate.id,
      completedAt: now.toISOString()
    };
    this.improvementRuns.set(run.id, completed);
    this.emit("improvement.completed", template, candidate, run.id, now, {
      strategy: input.strategy,
      promptTokensBefore: parent.promptTokenEstimate,
      promptTokensAfter: candidate.promptTokenEstimate
    });
    return clone(completed);
  }

  getImprovementRun(input: {
    sessionId: string | null;
    businessId: string;
    improvementRunId: string;
    now?: Date;
  }): ImprovementRunRecord {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    const run = this.improvementRuns.get(input.improvementRunId);
    if (run === undefined || run.businessId !== input.businessId) throw notFound("Improvement run");
    return clone(run);
  }

  promote(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    candidateVersionId: string;
    evaluationRunId: string;
    maxRegressions?: number;
    minimumScoreDelta?: number;
    now?: Date;
  }): TemplatePromotionRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const template = this.requireTemplate(input.businessId, input.templateId);
    const candidate = this.requireVersion(input.businessId, input.candidateVersionId);
    const evaluation = this.requireEvaluationRun(input.businessId, input.evaluationRunId);
    if (
      candidate.templateId !== template.id ||
      evaluation.candidateVersionId !== candidate.id ||
      evaluation.status !== "COMPLETED" ||
      evaluation.metrics === null
    ) {
      throw new Cp2Error(
        409,
        "PROMOTION_EVALUATION_INVALID",
        "Promotion requires the candidate's completed evaluation."
      );
    }
    const maxRegressions = input.maxRegressions ?? 0;
    const minimumScoreDelta = input.minimumScoreDelta ?? 0;
    const scoreDelta =
      evaluation.baselineMetrics === null
        ? evaluation.metrics.taskSuccessRate
        : evaluation.metrics.taskSuccessRate - evaluation.baselineMetrics.taskSuccessRate;
    const allowed =
      evaluation.regressionCaseIds.length <= maxRegressions && scoreDelta >= minimumScoreDelta;
    const promotion: TemplatePromotionRecord = {
      id: randomUUID(),
      templateId: template.id,
      candidateVersionId: candidate.id,
      baselineVersionId: evaluation.baselineVersionId,
      evaluationRunId: evaluation.id,
      businessId: template.businessId,
      accountId: template.accountId,
      decision: allowed ? "PROMOTED" : "REJECTED",
      regressionThreshold: maxRegressions,
      regressionCount: evaluation.regressionCaseIds.length,
      reason: allowed
        ? "Candidate met the configured correctness and regression gates."
        : `Candidate failed promotion gates: ${evaluation.regressionCaseIds.length} regressions, score delta ${round(scoreDelta)}.`,
      actorId: actor.user.id,
      createdAt: now.toISOString()
    };
    this.templatePromotions.set(promotion.id, promotion);
    if (!allowed) {
      this.updateVersionState(candidate, "FAILED");
      return clone(promotion);
    }
    const prior =
      template.productionVersionId === null
        ? null
        : this.requireVersion(input.businessId, template.productionVersionId);
    if (prior !== null) this.updateVersionState(prior, "PASSED");
    this.updateVersionState(candidate, "PROMOTED");
    this.modelTemplates.set(template.id, {
      ...template,
      previousProductionVersionId: prior?.id ?? null,
      productionVersionId: candidate.id,
      updatedAt: now.toISOString()
    });
    for (const binding of this.templateRuntimeBindings.values()) {
      if (binding.templateId === template.id && binding.status === "ACTIVE") {
        this.templateRuntimeBindings.set(binding.id, {
          ...binding,
          status: "INACTIVE",
          updatedAt: now.toISOString()
        });
      }
    }
    const binding: TemplateRuntimeBindingRecord = {
      id: randomUUID(),
      templateVersionId: candidate.id,
      templateId: template.id,
      businessId: template.businessId,
      accountId: template.accountId,
      baseModelId: candidate.baseModelId,
      nativeRuntimeBindingId: candidate.nativeRuntimeBindingId,
      executionHostId: candidate.executionHostId,
      status: "ACTIVE",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.templateRuntimeBindings.set(binding.id, binding);
    this.emit("template.promoted", template, candidate, promotion.id, now, {
      regressions: promotion.regressionCount
    });
    return clone(promotion);
  }

  rollback(input: {
    sessionId: string | null;
    businessId: string;
    templateId: string;
    now?: Date;
  }): TemplatePromotionRecord {
    const now = input.now ?? new Date();
    const actor = this.writeActor(input.sessionId, input.businessId, now);
    const template = this.requireTemplate(input.businessId, input.templateId);
    if (template.productionVersionId === null || template.previousProductionVersionId === null) {
      throw new Cp2Error(
        409,
        "TEMPLATE_ROLLBACK_UNAVAILABLE",
        "No previous promoted version is available."
      );
    }
    const current = this.requireVersion(input.businessId, template.productionVersionId);
    const previous = this.requireVersion(input.businessId, template.previousProductionVersionId);
    this.updateVersionState(current, "PASSED");
    this.updateVersionState(previous, "PROMOTED");
    this.modelTemplates.set(template.id, {
      ...template,
      productionVersionId: previous.id,
      previousProductionVersionId: current.id,
      updatedAt: now.toISOString()
    });
    for (const binding of this.templateRuntimeBindings.values()) {
      if (binding.templateId === template.id) {
        this.templateRuntimeBindings.set(binding.id, {
          ...binding,
          status: binding.templateVersionId === previous.id ? "ACTIVE" : "INACTIVE",
          updatedAt: now.toISOString()
        });
      }
    }
    const lastEvaluation = [...this.evaluationRuns.values()]
      .filter((run) => run.candidateVersionId === previous.id && run.status === "COMPLETED")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const rollback: TemplatePromotionRecord = {
      id: randomUUID(),
      templateId: template.id,
      candidateVersionId: previous.id,
      baselineVersionId: current.id,
      evaluationRunId: lastEvaluation?.id ?? "rollback:previously-evaluated",
      businessId: template.businessId,
      accountId: template.accountId,
      decision: "ROLLED_BACK",
      regressionThreshold: 0,
      regressionCount: 0,
      reason: `Rolled back from ${current.version} to ${previous.version}.`,
      actorId: actor.user.id,
      createdAt: now.toISOString()
    };
    this.templatePromotions.set(rollback.id, rollback);
    this.emit("template.rolled_back", template, previous, rollback.id, now, {
      fromVersion: current.version,
      toVersion: previous.version
    });
    return clone(rollback);
  }

  resolveProductionTemplate(input: {
    businessId: string;
    agentId: string;
    modelId: string;
    task?: string;
    currentVocabularySnapshot?: string;
  }): {
    templateId: string;
    templateVersionId: string;
    version: string;
    compiledInstructions: string[];
    nativeRuntimeBindingId: string | null;
    baseModelId: string;
    task: string | null;
    allowedTools: string[];
    contextRequirements: string[];
    outputSchema?: Record<string, JsonValue>;
    constraints: Record<string, JsonValue>;
    templateVocabularySnapshot: string;
    currentVocabularySnapshot: string;
  } | null {
    const promoted = [...this.modelTemplates.values()].filter(
      (item) =>
        item.businessId === input.businessId &&
        item.agentId === input.agentId &&
        item.productionVersionId !== null
    );
    const taskMatches =
      input.task === undefined ? [] : promoted.filter((item) => item.tasks.includes(input.task!));
    if (taskMatches.length > 1) {
      throw new Cp2Error(
        409,
        "TEMPLATE_TASK_AMBIGUOUS",
        "More than one promoted model template handles this task."
      );
    }
    const template =
      taskMatches.length === 1 ? taskMatches[0] : promoted.length === 1 ? promoted[0] : undefined;
    if (template?.productionVersionId === null || template === undefined) return null;
    const version = this.requireVersion(input.businessId, template.productionVersionId);
    const selectedTask =
      input.task !== undefined && template.tasks.includes(input.task)
        ? input.task
        : template.tasks.length === 1
          ? template.tasks[0]!
          : (input.task ?? null);
    const outputSchema = version.manifest.runtime.outputSchemas.find(
      (schema) => schema.task === selectedTask
    );
    assertCompatibleBaseModel(
      version.manifest.baseModel.requirements,
      this.deps.resolveBaseModel(input.modelId)
    );
    return {
      templateId: template.id,
      templateVersionId: version.id,
      version: version.version,
      compiledInstructions: [
        version.manifest.runtime.prompt,
        ...version.manifest.expertise.source.instructions
      ].filter(Boolean),
      nativeRuntimeBindingId: version.nativeRuntimeBindingId,
      baseModelId: input.modelId,
      task: selectedTask,
      allowedTools: [...version.manifest.runtime.tools],
      contextRequirements: [...version.manifest.runtime.contextRequirements],
      ...(outputSchema === undefined ? {} : { outputSchema: structuredClone(outputSchema.schema) }),
      constraints: structuredClone(version.manifest.runtime.constraints),
      templateVocabularySnapshot: version.manifest.evaluation.templateVocabularySnapshot,
      currentVocabularySnapshot:
        input.currentVocabularySnapshot ??
        version.manifest.evaluation.currentVocabularySnapshot ??
        version.manifest.evaluation.templateVocabularySnapshot
    };
  }

  exportTemplate(input: {
    sessionId: string | null;
    businessId: string;
    templateVersionId: string;
    now?: Date;
  }): {
    mediaType: "application/vnd.grogoni.template+json";
    fileName: string;
    manifest: GrogoniModelTemplateManifestV1;
    manifestSha256: string;
    files: Record<string, string>;
  } {
    this.readActor(input.sessionId, input.businessId, input.now ?? new Date());
    const version = this.requireVersion(input.businessId, input.templateVersionId);
    const template = this.requireTemplate(input.businessId, version.templateId);
    const manifest = structuredClone(version.manifest);
    const files: Record<string, string> = {
      "runtime/prompt.txt": manifest.runtime.prompt,
      "expertise/source.json": canonicalJson(manifest.expertise.source),
      "lineage.json": canonicalJson(manifest.lineage)
    };
    manifest.checksums = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, sha256(content)])
    );
    validateManifest(manifest);
    verifyExportChecksums({ files, checksums: manifest.checksums });
    return {
      mediaType: "application/vnd.grogoni.template+json",
      fileName: `${template.slug}-${version.version}.grogoni.com`,
      manifest,
      manifestSha256: manifestSha256(manifest),
      files
    };
  }

  verifyArtifact(input: {
    manifest: GrogoniModelTemplateManifestV1;
    expectedManifestSha256: string;
    files: Record<string, string>;
  }): void {
    validateManifest(input.manifest);
    if (manifestSha256(input.manifest) !== input.expectedManifestSha256) {
      throw new Cp2Error(
        400,
        "GROGONI_ARTIFACT_CHECKSUM_INVALID",
        "Manifest checksum verification failed."
      );
    }
    verifyExportChecksums({ files: input.files, checksums: input.manifest.checksums });
  }

  private insertVersion(input: {
    template: ModelTemplateRecord;
    manifest: GrogoniModelTemplateManifestV1;
    baseModelId: string;
    nativeRuntimeBindingId: string | null;
    executionHostId: string | null;
    state: ModelTemplateVersionRecord["state"];
    actorId: string;
    now: Date;
    promptTokenEstimate?: number;
    artifactSizeBytes?: number;
  }): ModelTemplateVersionRecord {
    if (
      this.versionsForTemplate(input.template.id).some(
        (version) => version.version === input.manifest.template.version
      )
    ) {
      throw new Cp2Error(
        409,
        "TEMPLATE_VERSION_EXISTS",
        "This semantic template version already exists."
      );
    }
    const id = randomUUID();
    const manifest = structuredClone(input.manifest);
    manifest.lineage = { ...manifest.lineage };
    const version: ModelTemplateVersionRecord = {
      id,
      templateId: input.template.id,
      businessId: input.template.businessId,
      accountId: input.template.accountId,
      version: manifest.template.version,
      state: input.state,
      manifest,
      manifestSha256: manifestSha256(manifest),
      baseModelId: input.baseModelId,
      nativeRuntimeBindingId: input.nativeRuntimeBindingId,
      executionHostId: input.executionHostId,
      promptTokenEstimate:
        input.promptTokenEstimate ?? estimatePromptTokens(manifest.runtime.prompt),
      artifactSizeBytes:
        input.artifactSizeBytes ?? Buffer.byteLength(canonicalJson(manifest), "utf8"),
      createdBy: input.actorId,
      createdAt: input.now.toISOString()
    };
    this.modelTemplateVersions.set(version.id, version);
    for (const descriptor of manifest.expertise.compiledArtifacts) {
      const artifact: ExpertiseArtifactRecord = {
        ...descriptor,
        id: randomUUID(),
        descriptorId: descriptor.id,
        templateVersionId: version.id,
        businessId: version.businessId,
        accountId: version.accountId,
        status: "AVAILABLE",
        createdAt: input.now.toISOString()
      };
      this.expertiseArtifacts.set(artifact.id, artifact);
    }
    this.emit("template.version_created", input.template, version, version.id, input.now, {
      state: version.state,
      baseModelId: version.baseModelId
    });
    return version;
  }

  private insertEvaluationCase(
    suite: EvaluationSuiteRecord,
    input: {
      name: string;
      input: JsonValue;
      contextFixture?: Record<string, JsonValue>;
      toolFixture?: Record<string, JsonValue>;
      matcher: EvaluationMatcher;
      tags?: string[];
    },
    actorId: string,
    now: Date
  ): EvaluationCaseRecord {
    validateMatcher(input.matcher);
    const record: EvaluationCaseRecord = {
      id: randomUUID(),
      suiteId: suite.id,
      templateId: suite.templateId,
      businessId: suite.businessId,
      accountId: suite.accountId,
      name: boundedText(input.name, "evaluation case name", 160),
      input: sanitizeBoundedJson(input.input, 32_000, "evaluation input"),
      contextFixture: sanitizeBoundedRecord(input.contextFixture ?? {}, 32_000, "context fixture"),
      toolFixture: sanitizeBoundedRecord(input.toolFixture ?? {}, 32_000, "tool fixture"),
      matcher: clone(input.matcher),
      tags: [...new Set(input.tags ?? [])].map((tag) => boundedText(tag, "evaluation tag", 60)),
      createdBy: actorId,
      createdAt: now.toISOString()
    };
    this.evaluationCases.set(record.id, record);
    return record;
  }

  private materializeDatasetExample(
    template: ModelTemplateRecord,
    requested: {
      correctionId?: string | null;
      evaluationCaseId?: string | null;
      split: DatasetSplit;
    },
    now: Date
  ): Omit<DatasetExampleRecord, "id" | "datasetVersionId"> {
    if (requested.correctionId !== null && requested.correctionId !== undefined) {
      const correction = this.requireCorrection(template.businessId, requested.correctionId);
      const observation = this.requireObservation(template.businessId, correction.observationId);
      if (
        correction.templateId !== template.id ||
        correction.status !== "APPROVED" ||
        observation.state !== "APPROVED"
      ) {
        throw new Cp2Error(
          409,
          "CORRECTION_NOT_APPROVED",
          "Only explicitly approved corrections can enter a dataset."
        );
      }
      return {
        templateId: template.id,
        businessId: template.businessId,
        accountId: template.accountId,
        correctionId: correction.id,
        evaluationCaseId: null,
        split: requested.split,
        input: clone(observation.input),
        expectedOutput: clone(correction.correctedOutput),
        provenance: {
          source: "production_correction",
          observationId: observation.id,
          templateVersionId: observation.templateVersionId,
          baseModelId: observation.baseModelId,
          approvedBy: correction.approvedBy
        },
        createdAt: now.toISOString()
      };
    }
    if (requested.evaluationCaseId !== null && requested.evaluationCaseId !== undefined) {
      if (requested.split === "TRAINING") {
        throw new Cp2Error(
          409,
          "EVALUATION_TRAINING_LEAKAGE",
          "Evaluation cases cannot be copied into the training split."
        );
      }
      const evaluationCase = this.evaluationCases.get(requested.evaluationCaseId);
      if (evaluationCase === undefined || evaluationCase.templateId !== template.id) {
        throw notFound("Evaluation case");
      }
      const expectedOutput =
        evaluationCase.matcher.type === "EXACT" || evaluationCase.matcher.type === "CONTAINS"
          ? evaluationCase.matcher.expected
          : null;
      return {
        templateId: template.id,
        businessId: template.businessId,
        accountId: template.accountId,
        correctionId: null,
        evaluationCaseId: evaluationCase.id,
        split: requested.split,
        input: clone(evaluationCase.input),
        expectedOutput: clone(expectedOutput),
        provenance: { source: "evaluation_case", suiteId: evaluationCase.suiteId },
        createdAt: now.toISOString()
      };
    }
    throw new Cp2Error(
      400,
      "DATASET_EXAMPLE_SOURCE_REQUIRED",
      "A dataset example requires a correction or evaluation case source."
    );
  }

  private updateVersionState(
    version: ModelTemplateVersionRecord,
    state: ModelTemplateVersionRecord["state"]
  ): void {
    const allowed: Record<
      ModelTemplateVersionRecord["state"],
      ModelTemplateVersionRecord["state"][]
    > = {
      DRAFT: ["EVALUATING", "PASSED", "FAILED", "RETIRED"],
      CANDIDATE: ["EVALUATING", "FAILED", "RETIRED"],
      EVALUATING: ["PASSED", "FAILED"],
      // A version whose own evaluation gate passed can still be rejected by a stricter,
      // caller-supplied promotion policy (see promote()'s maxRegressions/minimumScoreDelta) -
      // that rejection must be able to move it to FAILED, not just to a re-evaluation.
      PASSED: ["PROMOTED", "EVALUATING", "FAILED", "RETIRED"],
      FAILED: ["EVALUATING", "RETIRED"],
      PROMOTED: ["PASSED", "RETIRED"],
      RETIRED: []
    };
    if (version.state === state) return;
    if (!allowed[version.state].includes(state)) {
      throw new Cp2Error(
        409,
        "TEMPLATE_VERSION_TRANSITION_INVALID",
        `Cannot move template version from ${version.state} to ${state}.`
      );
    }
    this.modelTemplateVersions.set(version.id, { ...version, state });
  }

  private readActor(sessionId: string | null, businessId: string, now: Date): AuthorizedActor {
    return this.deps.requireAccess(sessionId, businessId, "business:read", now);
  }

  private writeActor(sessionId: string | null, businessId: string, now: Date): AuthorizedActor {
    return this.deps.requireAccess(sessionId, businessId, "launch:write", now);
  }

  private requireTemplate(businessId: string, templateId: string): ModelTemplateRecord {
    const template = this.modelTemplates.get(templateId);
    if (template === undefined || template.businessId !== businessId) throw notFound("Template");
    return template;
  }

  private requireVersion(businessId: string, versionId: string): ModelTemplateVersionRecord {
    const version = this.modelTemplateVersions.get(versionId);
    if (version === undefined || version.businessId !== businessId)
      throw notFound("Template version");
    return version;
  }

  private requireSuite(businessId: string, suiteId: string): EvaluationSuiteRecord {
    const suite = this.evaluationSuites.get(suiteId);
    if (suite === undefined || suite.businessId !== businessId) throw notFound("Evaluation suite");
    return suite;
  }

  private requireEvaluationRun(businessId: string, runId: string): EvaluationRunRecord {
    const run = this.evaluationRuns.get(runId);
    if (run === undefined || run.businessId !== businessId) throw notFound("Evaluation run");
    return run;
  }

  private requireObservation(
    businessId: string,
    observationId: string
  ): ProductionObservationRecord {
    const observation = this.productionObservations.get(observationId);
    if (observation === undefined || observation.businessId !== businessId)
      throw notFound("Observation");
    return observation;
  }

  private requireCorrection(businessId: string, correctionId: string): ExpertCorrectionRecord {
    const correction = this.expertCorrections.get(correctionId);
    if (correction === undefined || correction.businessId !== businessId)
      throw notFound("Correction");
    return correction;
  }

  private versionsForTemplate(templateId: string): ModelTemplateVersionRecord[] {
    return [...this.modelTemplateVersions.values()]
      .filter((version) => version.templateId === templateId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private casesForSuite(suiteId: string): EvaluationCaseRecord[] {
    return [...this.evaluationCases.values()]
      .filter((item) => item.suiteId === suiteId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private emit(
    event: TemplateTelemetryEvent["event"],
    template: ModelTemplateRecord,
    version: ModelTemplateVersionRecord | undefined,
    resourceId: string | undefined,
    now: Date,
    metadata: TemplateTelemetryEvent["metadata"]
  ): void {
    this.deps.emitTelemetry?.({
      event,
      businessId: template.businessId,
      templateId: template.id,
      ...(version === undefined ? {} : { templateVersionId: version.id }),
      ...(resourceId === undefined ? {} : { resourceId }),
      occurredAt: now.toISOString(),
      metadata
    });
  }

  private maps(): Array<Map<string, unknown>> {
    return [
      this.modelTemplates,
      this.modelTemplateVersions,
      this.expertiseArtifacts,
      this.evaluationSuites,
      this.evaluationCases,
      this.evaluationRuns,
      this.evaluationResults,
      this.productionObservations,
      this.expertCorrections,
      this.datasetVersions,
      this.datasetExamples,
      this.improvementRuns,
      this.templatePromotions,
      this.templateRuntimeBindings
    ] as Array<Map<string, unknown>>;
  }
}

function calculateMetrics(
  version: ModelTemplateVersionRecord,
  results: Awaited<ReturnType<EvaluationService["execute"]>>["results"],
  durationMs: number,
  regressionCount: number
): EvaluationMetrics {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const schemaResults = results.filter((result) => result.evaluatorType === "SCHEMA");
  const toolResults = results.filter((result) => result.evaluatorType === "TOOL_CALL");
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const costs = results.map((result) => result.usage.estimatedCost).filter(isNumber);
  const memory = results.map((result) => result.usage.peakMemoryBytes).filter(isNumber);
  return {
    taskSuccessRate: total === 0 ? 0 : round((passed / total) * 100),
    passed,
    failed: total - passed,
    total,
    structuredOutputValidityRate:
      schemaResults.length === 0
        ? null
        : round(
            (schemaResults.filter((result) => result.passed).length / schemaResults.length) * 100
          ),
    toolCallCorrectnessRate:
      toolResults.length === 0
        ? null
        : round((toolResults.filter((result) => result.passed).length / toolResults.length) * 100),
    medianLatencyMs: round(median(latencies)),
    promptTokens: sum(results.map((result) => result.usage.promptTokens)),
    completionTokens: sum(results.map((result) => result.usage.completionTokens)),
    totalContextTokens: sum(results.map((result) => result.usage.totalContextTokens)),
    artifactSizeBytes: version.artifactSizeBytes,
    throughputPerSecond: durationMs === 0 ? total : round(total / (durationMs / 1000)),
    estimatedCostPerTask: costs.length === 0 ? null : round(sum(costs) / costs.length),
    peakMemoryBytes: memory.length === 0 ? null : Math.max(...memory),
    regressionCount
  };
}

function validateMatcher(matcher: EvaluationMatcher): void {
  if (
    matcher.type === "JUDGE" &&
    (matcher.rubric.trim().length === 0 || matcher.minimumScore < 0)
  ) {
    throw new Cp2Error(
      400,
      "EVALUATION_MATCHER_INVALID",
      "Judge evaluation requires a rubric and non-negative threshold."
    );
  }
  if (
    matcher.type === "CONSTRAINTS" &&
    matcher.numericTolerances.some(
      (item) =>
        item.path.trim().length === 0 || item.tolerance < 0 || !Number.isFinite(item.expected)
    )
  ) {
    throw new Cp2Error(
      400,
      "EVALUATION_MATCHER_INVALID",
      "Numeric tolerances must be finite and non-negative."
    );
  }
}

function sanitizeBoundedJson(value: JsonValue, maxBytes: number, label: string): JsonValue {
  const sanitized = redactSecrets(clone(value));
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > maxBytes) {
    throw new Cp2Error(413, "TEMPLATE_DATA_TOO_LARGE", `${label} exceeds the permitted size.`);
  }
  return sanitized;
}

function sanitizeBoundedRecord(
  value: Record<string, JsonValue>,
  maxBytes: number,
  label: string
): Record<string, JsonValue> {
  return sanitizeBoundedJson(value, maxBytes, label) as Record<string, JsonValue>;
}

function redactSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /password|secret|credential|api[-_]?key|access[-_]?token/iu.test(key)
        ? "[REDACTED]"
        : redactSecrets(child)
    ])
  );
}

function detectRiskFlags(...values: JsonValue[]): string[] {
  const text = JSON.stringify(values).toLowerCase();
  const flags: string[] = [];
  if (
    /ignore (all|previous|prior) (instructions|rules)|system prompt|developer message/iu.test(text)
  ) {
    flags.push("PROMPT_INJECTION_SUSPECTED");
  }
  if (/\[REDACTED\]/u.test(JSON.stringify(values))) flags.push("SECRET_REDACTED");
  return flags;
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Cp2Error(
      400,
      "TEMPLATE_INPUT_INVALID",
      `${label} must contain 1-${maximum} characters.`
    );
  }
  return normalized;
}

function boundedOptionalText(value: string | undefined, maximum: number): string {
  if (value === undefined || value.trim().length === 0) return "";
  return boundedText(value, "description", maximum);
}

function restoreMap<T extends { id: string }>(map: Map<string, T>, records: T[] | undefined): void {
  for (const record of records ?? []) map.set(record.id, clone(record));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function notFound(resource: string): Cp2Error {
  return new Cp2Error(404, "MODEL_TEMPLATE_RESOURCE_NOT_FOUND", `${resource} was not found.`);
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2
    : (values[middle] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export const createModelTemplatesDomain = (deps: ModelTemplatesDomainDeps) =>
  new ModelTemplatesDomain(deps);
