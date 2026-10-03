import type { FastifyInstance, FastifyRequest } from "fastify";
import { Cp2Error } from "../../cp2-error.js";
import { parseRequestBody, sendCp2Error, type BusinessParams } from "../../route-helpers.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import type {
  DatasetSplit,
  EvaluationMatcher,
  JsonValue,
  OptimizationStrategy,
  GrogoniModelTemplateManifestV1
} from "./types.js";

interface TemplateParams extends BusinessParams {
  templateId: string;
}
interface SuiteParams extends TemplateParams {
  suiteId: string;
}
interface EvaluationParams extends BusinessParams {
  evaluationId: string;
}
interface ObservationParams extends BusinessParams {
  observationId: string;
}
interface CorrectionParams extends BusinessParams {
  correctionId: string;
}
interface DatasetParams extends BusinessParams {
  datasetId: string;
}
interface ImprovementParams extends BusinessParams {
  improvementRunId: string;
}
interface VersionParams extends BusinessParams {
  versionId: string;
}
interface VocabularyEntryParams extends BusinessParams {
  vocabularyEntryId: string;
}

export function registerModelTemplateRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/businesses/:businessId/vocabulary/candidates",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          entries: store.listVocabularyCandidates({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          }),
          currentVocabularySnapshot: store.currentVocabularySnapshotId(request.params.businessId)
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/vocabulary/unknown-terms",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return reply.code(201).send(
          store.recordUnknownVocabularyTerm({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            surfaceForm: requiredString(body.surfaceForm, "surfaceForm"),
            sourceSessionId: nullableString(body.sourceSessionId),
            observedCanonicalTerm: nullableString(body.observedCanonicalTerm),
            context: nullableString(body.context)
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/vocabulary/candidates/:vocabularyEntryId/review",
    async (request: FastifyRequest<{ Params: VocabularyEntryParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.reviewVocabularyEntry({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          vocabularyEntryId: request.params.vocabularyEntryId,
          action: requiredVocabularyAction(body.action),
          canonicalTerm: nullableString(body.canonicalTerm)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return reply.code(201).send(
          store.createModelTemplate({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            manifest: body.manifest as unknown as GrogoniModelTemplateManifestV1,
            baseModelId: requiredString(body.baseModelId, "baseModelId"),
            nativeRuntimeBindingId: nullableString(body.nativeRuntimeBindingId),
            executionHostId: nullableString(body.executionHostId)
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/model-templates",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          templates: store.listModelTemplates({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/model-templates/:templateId",
    async (request: FastifyRequest<{ Params: TemplateParams }>, reply) => {
      try {
        return store.getModelTemplate({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          templateId: request.params.templateId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/model-templates/:templateId/versions",
    async (request: FastifyRequest<{ Params: TemplateParams }>, reply) => {
      try {
        return {
          versions: store.listModelTemplateVersions({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            templateId: request.params.templateId
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/model-templates/:templateId/lineage",
    async (request: FastifyRequest<{ Params: TemplateParams }>, reply) => {
      try {
        return store.getModelTemplateLineage({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          templateId: request.params.templateId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/evaluation-suites",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const cases = optionalArray(body.cases).map((item) => {
          const value = requiredRecord(item, "evaluation case");
          return {
            name: requiredString(value.name, "case name"),
            input: value.input as JsonValue,
            matcher: value.matcher as unknown as EvaluationMatcher,
            contextFixture: optionalJsonRecord(value.contextFixture),
            toolFixture: optionalJsonRecord(value.toolFixture),
            tags: optionalStringArray(value.tags)
          };
        });
        const description = optionalString(body.description);
        return reply.code(201).send(
          store.createModelTemplateEvaluationSuite({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            templateId: request.params.templateId,
            name: requiredString(body.name, "name"),
            ...(description === undefined ? {} : { description }),
            cases
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/evaluation-suites/:suiteId/cases",
    async (request: FastifyRequest<{ Params: SuiteParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return reply.code(201).send(
          store.addModelTemplateEvaluationCase({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            suiteId: request.params.suiteId,
            name: requiredString(body.name, "name"),
            caseInput: body.input as JsonValue,
            matcher: body.matcher as unknown as EvaluationMatcher,
            contextFixture: optionalJsonRecord(body.contextFixture),
            toolFixture: optionalJsonRecord(body.toolFixture),
            tags: optionalStringArray(body.tags)
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/evaluations",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const run = await store.runModelTemplateEvaluation({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          templateId: request.params.templateId,
          suiteId: requiredString(body.suiteId, "suiteId"),
          candidateVersionId: requiredString(body.candidateVersionId, "candidateVersionId"),
          baselineVersionId: nullableString(body.baselineVersionId)
        });
        return reply.code(201).send(run);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/evaluations/:evaluationId",
    async (request: FastifyRequest<{ Params: EvaluationParams }>, reply) => {
      try {
        return store.getModelTemplateEvaluation({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          evaluationRunId: request.params.evaluationId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/evaluations/:evaluationId/report-card",
    async (request: FastifyRequest<{ Params: EvaluationParams }>, reply) => {
      try {
        return store.getModelTemplateReportCard({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          evaluationRunId: request.params.evaluationId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/observations",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return reply.code(201).send(
          store.recordModelTemplateObservation({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            templateVersionId: requiredString(body.templateVersionId, "templateVersionId"),
            observationInput: body.input as JsonValue,
            relevantContext: optionalJsonRecord(body.relevantContext),
            output: body.output as JsonValue,
            suspectedFailure: optionalBoolean(body.suspectedFailure) ?? false,
            failureReason: nullableString(body.failureReason),
            sourceConversationId: nullableString(body.sourceConversationId)
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/observations/:observationId/review",
    async (request: FastifyRequest<{ Params: ObservationParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const reason = optionalString(body.reason);
        return store.reviewModelTemplateObservation({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          observationId: request.params.observationId,
          isFailure: requiredBoolean(body.isFailure, "isFailure"),
          ...(reason === undefined ? {} : { reason })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/corrections",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return reply.code(201).send(
          store.submitModelTemplateCorrection({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            observationId: requiredString(body.observationId, "observationId"),
            correctedOutput: body.correctedOutput as JsonValue,
            explanation: requiredString(body.explanation, "explanation"),
            rubric: nullableString(body.rubric)
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/corrections/:correctionId/approval",
    async (request: FastifyRequest<{ Params: CorrectionParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.approveModelTemplateCorrection({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          correctionId: request.params.correctionId,
          approve: requiredBoolean(body.approve, "approve")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/datasets",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const examples = requiredArray(body.examples, "examples").map((item) => {
          const value = requiredRecord(item, "dataset example");
          return {
            correctionId: nullableString(value.correctionId),
            evaluationCaseId: nullableString(value.evaluationCaseId),
            split: requiredDatasetSplit(value.split)
          };
        });
        return reply.code(201).send(
          store.createModelTemplateDatasetVersion({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            templateId: request.params.templateId,
            name: requiredString(body.name, "name"),
            examples
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/datasets/:datasetId",
    async (request: FastifyRequest<{ Params: DatasetParams }>, reply) => {
      try {
        return store.getModelTemplateDataset({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          datasetVersionId: request.params.datasetId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/improvement-runs",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return reply.code(201).send(
          store.startModelTemplateImprovementRun({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId,
            templateId: request.params.templateId,
            parentVersionId: requiredString(body.parentVersionId, "parentVersionId"),
            datasetVersionId: requiredString(body.datasetVersionId, "datasetVersionId"),
            evaluationSuiteId: requiredString(body.evaluationSuiteId, "evaluationSuiteId"),
            targetBaseModelId: requiredString(body.targetBaseModelId, "targetBaseModelId"),
            strategy: requiredStrategy(body.strategy),
            strategyConfig: optionalJsonRecord(body.strategyConfig)
          })
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/improvement-runs/:improvementRunId",
    async (request: FastifyRequest<{ Params: ImprovementParams }>, reply) => {
      try {
        return store.getModelTemplateImprovementRun({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          improvementRunId: request.params.improvementRunId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/promotions",
    async (request: FastifyRequest<{ Params: TemplateParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const maxRegressions = optionalNumber(body.maxRegressions);
        const minimumScoreDelta = optionalNumber(body.minimumScoreDelta);
        return store.promoteModelTemplate({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          templateId: request.params.templateId,
          candidateVersionId: requiredString(body.candidateVersionId, "candidateVersionId"),
          evaluationRunId: requiredString(body.evaluationRunId, "evaluationRunId"),
          ...(maxRegressions === undefined ? {} : { maxRegressions }),
          ...(minimumScoreDelta === undefined ? {} : { minimumScoreDelta })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/model-templates/:templateId/rollback",
    async (request: FastifyRequest<{ Params: TemplateParams }>, reply) => {
      try {
        return store.rollbackModelTemplate({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          templateId: request.params.templateId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/model-template-versions/:versionId/export",
    async (request: FastifyRequest<{ Params: VersionParams }>, reply) => {
      try {
        return store.exportModelTemplate({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          templateVersionId: request.params.versionId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null {
  return optionalString(value) ?? null;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidInput(`${label} must be boolean.`);
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidInput(`${label} must be an array.`);
  return value;
}

function optionalArray(value: unknown): unknown[] {
  return value === undefined ? [] : requiredArray(value, "value");
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw invalidInput(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalJsonRecord(value: unknown): Record<string, JsonValue> {
  return value === undefined ? {} : (requiredRecord(value, "value") as Record<string, JsonValue>);
}

function optionalStringArray(value: unknown): string[] {
  return optionalArray(value).map((item) => requiredString(item, "array item"));
}

function requiredDatasetSplit(value: unknown): DatasetSplit {
  if (value === "TRAINING" || value === "VALIDATION" || value === "REGRESSION") return value;
  throw invalidInput("split must be TRAINING, VALIDATION, or REGRESSION.");
}

function requiredStrategy(value: unknown): OptimizationStrategy {
  const strategies: OptimizationStrategy[] = [
    "PROMPT_OPTIMIZATION",
    "CONTEXT_GISTING",
    "DATASET_DISTILLATION",
    "ADAPTER_TRAINING",
    "FULL_FINE_TUNE",
    "QUANTIZATION"
  ];
  if (typeof value === "string" && strategies.includes(value as OptimizationStrategy)) {
    return value as OptimizationStrategy;
  }
  throw invalidInput("Unknown optimization strategy.");
}

function requiredVocabularyAction(value: unknown): "APPROVE" | "REJECT" {
  if (value === "APPROVE" || value === "REJECT") return value;
  throw invalidInput("action must be APPROVE or REJECT.");
}

function invalidInput(message: string): Cp2Error {
  return new Cp2Error(400, "MODEL_TEMPLATE_REQUEST_INVALID", message);
}
