export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TemplateVersionState =
  "DRAFT" | "CANDIDATE" | "EVALUATING" | "PASSED" | "FAILED" | "PROMOTED" | "RETIRED";

export type ObservationState =
  "OBSERVED" | "CANDIDATE_FAILURE" | "REVIEWED" | "CORRECTED" | "APPROVED";

export type DatasetSplit = "TRAINING" | "VALIDATION" | "REGRESSION";
export type OptimizationStrategy =
  | "PROMPT_OPTIMIZATION"
  | "CONTEXT_GISTING"
  | "DATASET_DISTILLATION"
  | "ADAPTER_TRAINING"
  | "FULL_FINE_TUNE"
  | "QUANTIZATION";

export interface TemplateBaseModelRequirements {
  requiredCapabilities: string[];
  minimumContextWindow: number | null;
  preferredModels: string[];
  testedModels: string[];
  incompatibleModels: string[];
}

export interface SourceExpertiseRule {
  id: string;
  match: string;
  output: Record<string, JsonValue>;
  provenance: "AUTHOR" | "CORRECTION" | "IMPORT";
  sourceCorrectionId: string | null;
}

export interface SourceExpertise {
  instructions: string[];
  vocabulary: Record<string, string[]>;
  rules: SourceExpertiseRule[];
}

export interface CompiledExpertiseArtifactDescriptor {
  id: string;
  kind: "PROMPT" | "GIST" | "ADAPTER" | "DELTA" | "VOCABULARY";
  baseModelId: string | null;
  baseArchitecture: string | null;
  objectKey: string | null;
  inlineSha256: string;
  sizeBytes: number;
}

export interface GrogoniModelTemplateManifestV1 {
  format: "grogoni-template";
  formatVersion: 1;
  template: {
    id: string;
    slug: string;
    name: string;
    version: string;
    domain: string;
    businessId: string;
    agentId: string;
  };
  tasks: string[];
  validatedTaskDistribution: {
    id: string;
    description: string;
    suiteIds: string[];
  };
  minimumModelCapability: {
    tier: string;
    requiredCapabilities: string[];
    minimumContextWindow: number | null;
  };
  vocabularySnapshot: {
    id: string;
    algorithm: "APPROVED_VOCABULARY_SHA256_V1";
  };
  capabilities: string[];
  baseModel: {
    mode: "compatible";
    requirements: TemplateBaseModelRequirements;
  };
  expertise: {
    source: SourceExpertise;
    compiledArtifacts: CompiledExpertiseArtifactDescriptor[];
  };
  runtime: {
    prompt: string;
    tools: string[];
    outputSchemas: Array<{ task: string; schema: Record<string, JsonValue> }>;
    contextRequirements: string[];
    constraints: Record<string, JsonValue>;
  };
  evaluation: {
    suiteIds: string[];
    baselineMetrics: Record<string, number | null>;
    templateVocabularySnapshot: string;
    currentVocabularySnapshot: string | null;
  };
  lineage: {
    parentVersionId: string | null;
    improvementRunId: string | null;
    datasetVersionId: string | null;
    createdBy: string;
    createdAt: string;
    changeSummary: string;
  };
  ownership: {
    businessId: string;
    visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  };
  checksums: Record<string, string>;
}

export interface ModelTemplateRecord {
  id: string;
  businessId: string;
  accountId: string;
  agentId: string;
  slug: string;
  name: string;
  domain: string;
  tasks: string[];
  productionVersionId: string | null;
  previousProductionVersionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelTemplateVersionRecord {
  id: string;
  templateId: string;
  businessId: string;
  accountId: string;
  version: string;
  state: TemplateVersionState;
  manifest: GrogoniModelTemplateManifestV1;
  manifestSha256: string;
  baseModelId: string;
  nativeRuntimeBindingId: string | null;
  executionHostId: string | null;
  promptTokenEstimate: number;
  artifactSizeBytes: number;
  createdBy: string;
  createdAt: string;
}

export interface ExpertiseArtifactRecord extends CompiledExpertiseArtifactDescriptor {
  descriptorId: string;
  templateVersionId: string;
  businessId: string;
  accountId: string;
  status: "AVAILABLE" | "INVALID" | "RETIRED";
  createdAt: string;
}

export type EvaluationMatcher =
  | { type: "EXACT"; expected: JsonValue }
  | { type: "CONTAINS"; expected: JsonValue }
  | { type: "SCHEMA"; schema: Record<string, JsonValue> }
  | {
      type: "CONSTRAINTS";
      requiredPaths: string[];
      prohibitedPaths: string[];
      numericTolerances: Array<{ path: string; expected: number; tolerance: number }>;
    }
  | { type: "TOOL_CALL"; tool: string; arguments: Record<string, JsonValue> }
  | { type: "JUDGE"; rubric: string; minimumScore: number };

export interface EvaluationSuiteRecord {
  id: string;
  templateId: string;
  businessId: string;
  accountId: string;
  name: string;
  description: string;
  version: number;
  frozenAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface EvaluationCaseRecord {
  id: string;
  suiteId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  name: string;
  input: JsonValue;
  contextFixture: Record<string, JsonValue>;
  toolFixture: Record<string, JsonValue>;
  matcher: EvaluationMatcher;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

export interface EvaluationMetrics {
  taskSuccessRate: number;
  passed: number;
  failed: number;
  total: number;
  structuredOutputValidityRate: number | null;
  toolCallCorrectnessRate: number | null;
  medianLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalContextTokens: number;
  artifactSizeBytes: number;
  throughputPerSecond: number;
  estimatedCostPerTask: number | null;
  peakMemoryBytes: number | null;
  regressionCount: number;
}

export interface EvaluationRunRecord {
  id: string;
  suiteId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  candidateVersionId: string;
  baselineVersionId: string | null;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  metrics: EvaluationMetrics | null;
  baselineMetrics: EvaluationMetrics | null;
  regressionCaseIds: string[];
  errorCode: string | null;
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
}

export interface EvaluationResultRecord {
  id: string;
  evaluationRunId: string;
  caseId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  candidatePassed: boolean;
  baselinePassed: boolean | null;
  evaluatorType: EvaluationMatcher["type"];
  score: number;
  latencyMs: number;
  output: JsonValue;
  details: Record<string, JsonValue>;
  createdAt: string;
}

export interface ProductionObservationRecord {
  id: string;
  templateVersionId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  baseModelId: string;
  nativeRuntimeBindingId: string | null;
  executionHostId: string | null;
  state: ObservationState;
  input: JsonValue;
  relevantContext: Record<string, JsonValue>;
  output: JsonValue;
  failureReason: string | null;
  riskFlags: string[];
  sourceConversationId: string | null;
  createdBy: string;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpertCorrectionRecord {
  id: string;
  observationId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  correctedOutput: JsonValue;
  explanation: string;
  rubric: string | null;
  status: "SUBMITTED" | "APPROVED" | "REJECTED";
  submittedBy: string;
  approvedBy: string | null;
  submittedAt: string;
  approvedAt: string | null;
}

export interface DatasetVersionRecord {
  id: string;
  templateId: string;
  businessId: string;
  accountId: string;
  version: number;
  name: string;
  status: "FROZEN";
  contentSha256: string;
  exampleCount: number;
  sourceCorrectionIds: string[];
  createdBy: string;
  createdAt: string;
}

export interface DatasetExampleRecord {
  id: string;
  datasetVersionId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  correctionId: string | null;
  evaluationCaseId: string | null;
  split: DatasetSplit;
  input: JsonValue;
  expectedOutput: JsonValue;
  provenance: Record<string, JsonValue>;
  createdAt: string;
}

export interface ImprovementRunRecord {
  id: string;
  templateVersionId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  datasetVersionId: string;
  evaluationSuiteId: string;
  targetBaseModelId: string;
  strategy: OptimizationStrategy;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  strategyConfig: Record<string, JsonValue>;
  candidateVersionId: string | null;
  errorCode: string | null;
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
}

export interface TemplatePromotionRecord {
  id: string;
  templateId: string;
  candidateVersionId: string;
  baselineVersionId: string | null;
  evaluationRunId: string;
  businessId: string;
  accountId: string;
  decision: "PROMOTED" | "REJECTED" | "ROLLED_BACK";
  regressionThreshold: number;
  regressionCount: number;
  reason: string;
  actorId: string;
  createdAt: string;
}

export interface TemplateRuntimeBindingRecord {
  id: string;
  templateVersionId: string;
  templateId: string;
  businessId: string;
  accountId: string;
  baseModelId: string;
  nativeRuntimeBindingId: string | null;
  executionHostId: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  updatedAt: string;
}

export interface TemplateReportCard {
  templateId: string;
  templateName: string;
  versionId: string;
  version: string;
  state: TemplateVersionState;
  baseModelId: string;
  previousVersion: string | null;
  metrics: EvaluationMetrics;
  previousMetrics: EvaluationMetrics | null;
  scoreDelta: number | null;
  promptTokenReductionPercent: number | null;
  correctionsIncorporated: number;
  evaluationRunId: string;
}

export interface TemplateTelemetryEvent {
  event:
    | "template.created"
    | "template.version_created"
    | "evaluation.started"
    | "evaluation.completed"
    | "evaluation.regression_detected"
    | "correction.submitted"
    | "correction.approved"
    | "dataset.version_created"
    | "improvement.started"
    | "improvement.completed"
    | "improvement.failed"
    | "template.promoted"
    | "template.rolled_back";
  businessId: string;
  templateId: string;
  templateVersionId?: string;
  resourceId?: string;
  occurredAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface BaseModelDescriptor {
  id: string;
  provider: string;
  capabilities: string[];
  contextWindow: number | null;
  available: boolean;
}

export interface TemplateExecutionResult {
  output: JsonValue;
  promptTokens?: number;
  completionTokens?: number;
  totalContextTokens?: number;
  peakMemoryBytes?: number | null;
  estimatedCost?: number | null;
}

export type TemplateExecutor = (
  version: ModelTemplateVersionRecord,
  input: JsonValue,
  fixtures: { context: Record<string, JsonValue>; tools: Record<string, JsonValue> }
) => Promise<TemplateExecutionResult>;

export type JudgeEvaluator = (input: {
  rubric: string;
  minimumScore: number;
  caseInput: JsonValue;
  output: JsonValue;
}) => Promise<{ score: number; passed: boolean; reason: string }>;
