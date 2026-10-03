import { useCallback, useEffect, useState } from "react";

import type { AiModelSummary } from "@grogoni/shared-types";

import { getJson, postJson } from "./api-helpers";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { TemplateVocabularyPanel } from "./TemplateVocabularyPanel";
import { getUserFacingErrorMessage } from "./user-facing-error";

// Model Templates recursive expertise flywheel (see docs/frontend/frontend.md) shipped a full
// backend lifecycle - create a template, build an evaluation suite, run evaluations - but the
// frontend only had ModelTemplateReportCardPanel, a read-only viewer of already-promoted report
// cards. This panel is the write-side workbench: create a template, inspect its versions, build
// an evaluation suite one test case at a time, and run an evaluation against it.
//
// packages/shared-types has no Model Template domain types at all today (confirmed by search).
// ModelTemplateReportCardPanel.tsx, the existing read-only viewer for this same domain, already
// established the precedent of defining small local interfaces scoped to exactly what it renders
// rather than adding a shared-types surface for a still-evolving admin domain; this file follows
// that same precedent for consistency rather than inventing a second convention. AiModelSummary is
// the one type this panel needs that already exists in shared-types (used elsewhere, e.g.
// QuickRuntimeSwitcher.tsx), so it is imported and reused rather than redefined.

type TemplateVersionState =
  "DRAFT" | "CANDIDATE" | "EVALUATING" | "PASSED" | "FAILED" | "PROMOTED" | "RETIRED";

interface ModelTemplateSummary {
  id: string;
  name: string;
  slug: string;
  domain: string;
  productionVersionId: string | null;
  createdAt: string;
}

interface ModelTemplateVersionSummary {
  id: string;
  version: string;
  state: TemplateVersionState;
  baseModelId: string;
  createdAt: string;
  manifest: {
    vocabularySnapshot: { id: string };
  };
}

interface EvaluationSuiteSummary {
  id: string;
  name: string;
  description: string;
  version: number;
}

interface EvaluationCaseSummary {
  id: string;
  name: string;
  matcher: { type: string };
  tags: string[];
}

interface EvaluationMetricsSummary {
  taskSuccessRate: number;
  passed: number;
  failed: number;
  total: number;
  regressionCount: number;
  medianLatencyMs: number;
}

interface EvaluationRunSummary {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  metrics: EvaluationMetricsSummary | null;
  baselineMetrics: EvaluationMetricsSummary | null;
  regressionCaseIds: string[];
  errorCode: string | null;
}

interface EvaluationResultSummary {
  id: string;
  caseId: string;
  candidatePassed: boolean;
  score: number;
  evaluatorType: string;
}

type MatcherKind = "EXACT" | "CONTAINS" | "JUDGE";

interface TemplateDraft {
  name: string;
  domain: string;
  slug: string;
  version: string;
  baseModelId: string;
  tasks: string;
  capabilities: string;
  prompt: string;
  instructions: string;
  changeSummary: string;
  validationDistributionId: string;
  validationDescription: string;
  validationSuiteIds: string;
  minimumCapabilityTier: string;
  requiredModelCapabilities: string;
  minimumContextWindow: string;
}

const emptyTemplateDraft: TemplateDraft = {
  name: "",
  domain: "",
  slug: "",
  version: "1.0.0",
  baseModelId: "",
  tasks: "",
  capabilities: "",
  prompt: "",
  instructions: "",
  changeSummary: "Initial version",
  validationDistributionId: "manual-validation",
  validationDescription: "Manual validation distribution",
  validationSuiteIds: "manual-validation",
  minimumCapabilityTier: "declared-runtime",
  requiredModelCapabilities: "chat",
  minimumContextWindow: ""
};

interface CaseDraft {
  name: string;
  inputJson: string;
  matcherKind: MatcherKind;
  expectedJson: string;
  rubric: string;
  minimumScore: string;
  tags: string;
}

const emptyCaseDraft: CaseDraft = {
  name: "",
  inputJson: "{}",
  matcherKind: "EXACT",
  expectedJson: "{}",
  rubric: "",
  minimumScore: "0.7",
  tags: ""
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function generateManifestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `template-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ModelTemplateWorkbenchPanel({ businessId }: { businessId: string }) {
  const { isPending, runAction } = useAsyncActions();
  const templatesPath = `/businesses/${businessId}/model-templates`;

  const [templates, setTemplates] = useState<ModelTemplateSummary[] | null>(null);
  const [models, setModels] = useState<AiModelSummary[]>([]);
  const [message, setMessage] = useState("");
  const [vocabularySnapshotId, setVocabularySnapshotId] = useState<string | null>(null);
  const handleVocabularySnapshot = useCallback((snapshotId: string) => {
    setVocabularySnapshotId(snapshotId);
  }, []);

  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(emptyTemplateDraft);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [versionsByTemplate, setVersionsByTemplate] = useState<
    Record<string, ModelTemplateVersionSummary[]>
  >({});
  const [suitesByTemplate, setSuitesByTemplate] = useState<
    Record<string, EvaluationSuiteSummary[]>
  >({});
  const [casesBySuite, setCasesBySuite] = useState<Record<string, EvaluationCaseSummary[]>>({});

  const [isCreatingSuite, setIsCreatingSuite] = useState(false);
  const [suiteName, setSuiteName] = useState("");
  const [suiteDescription, setSuiteDescription] = useState("");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  const [isAddingCase, setIsAddingCase] = useState(false);
  const [caseDraft, setCaseDraft] = useState<CaseDraft>(emptyCaseDraft);

  const [candidateVersionId, setCandidateVersionId] = useState("");
  const [baselineVersionId, setBaselineVersionId] = useState("");
  const [lastRun, setLastRun] = useState<{
    run: EvaluationRunSummary;
    results: EvaluationResultSummary[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [templatesResponse, modelsResponse] = await Promise.all([
          getJson<{ templates: ModelTemplateSummary[] }>(templatesPath),
          getJson<{ models: AiModelSummary[] }>("/v1/ai-models")
        ]);
        if (cancelled) return;
        setTemplates(templatesResponse.templates);
        setModels(modelsResponse.models.filter((model) => model.available));
      } catch (error) {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [templatesPath]);

  async function loadVersions(templateId: string) {
    const response = await getJson<{ versions: ModelTemplateVersionSummary[] }>(
      `${templatesPath}/${encodeURIComponent(templateId)}/versions`
    );
    setVersionsByTemplate((current) => ({ ...current, [templateId]: response.versions }));
    if (response.versions.length > 0) {
      setCandidateVersionId(response.versions[response.versions.length - 1]!.id);
    }
  }

  function openTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    setSelectedSuiteId(null);
    setCandidateVersionId("");
    setBaselineVersionId("");
    setLastRun(null);
    void runAction(`workbench-open-${templateId}`, async () => {
      try {
        await loadVersions(templateId);
      } catch (error) {
        setMessage(getUserFacingErrorMessage(error));
      }
    });
  }

  async function createTemplate() {
    const name = templateDraft.name.trim();
    const domain = templateDraft.domain.trim();
    const slug = templateDraft.slug.trim().length > 0 ? templateDraft.slug.trim() : slugify(name);
    const tasks = splitList(templateDraft.tasks);
    if (name.length === 0 || domain.length === 0 || templateDraft.baseModelId.length === 0) {
      setMessage("Enter a name, domain, and base model.");
      return;
    }
    if (slug.length === 0 || tasks.length === 0) {
      setMessage(
        "Enter a slug and at least one namespaced task (for example support.answer-question)."
      );
      return;
    }
    if (vocabularySnapshotId === null) {
      setMessage("Wait for the approved vocabulary snapshot to load.");
      return;
    }
    if (
      templateDraft.validationDistributionId.trim().length === 0 ||
      templateDraft.validationDescription.trim().length === 0 ||
      splitList(templateDraft.validationSuiteIds).length === 0 ||
      templateDraft.minimumCapabilityTier.trim().length === 0 ||
      splitList(templateDraft.requiredModelCapabilities).length === 0
    ) {
      setMessage("Complete the validation distribution and minimum model capability fields.");
      return;
    }
    const minimumContextWindow = templateDraft.minimumContextWindow.trim();
    const parsedContextWindow =
      minimumContextWindow === "" ? null : Number.parseInt(minimumContextWindow, 10);
    if (
      parsedContextWindow !== null &&
      (!Number.isInteger(parsedContextWindow) || parsedContextWindow < 1)
    ) {
      setMessage("Minimum context window must be a positive whole number.");
      return;
    }
    const manifestId = generateManifestId();
    const nowIso = new Date().toISOString();
    const created = await postJson<{
      template: ModelTemplateSummary;
      version: ModelTemplateVersionSummary;
    }>(templatesPath, {
      baseModelId: templateDraft.baseModelId,
      manifest: {
        format: "grogoni-template",
        formatVersion: 1,
        template: {
          id: manifestId,
          slug,
          name,
          version: templateDraft.version.trim() || "1.0.0",
          domain,
          businessId,
          agentId: businessId
        },
        tasks,
        validatedTaskDistribution: {
          id: templateDraft.validationDistributionId.trim(),
          description: templateDraft.validationDescription.trim(),
          suiteIds: splitList(templateDraft.validationSuiteIds)
        },
        minimumModelCapability: {
          tier: templateDraft.minimumCapabilityTier.trim(),
          requiredCapabilities: splitList(templateDraft.requiredModelCapabilities),
          minimumContextWindow: parsedContextWindow
        },
        vocabularySnapshot: {
          id: vocabularySnapshotId,
          algorithm: "APPROVED_VOCABULARY_SHA256_V1"
        },
        capabilities: splitList(templateDraft.capabilities),
        baseModel: {
          mode: "compatible",
          requirements: {
            requiredCapabilities: [],
            minimumContextWindow: null,
            preferredModels: [],
            testedModels: [],
            incompatibleModels: []
          }
        },
        expertise: {
          source: {
            instructions: splitList(templateDraft.instructions),
            vocabulary: {},
            rules: []
          },
          compiledArtifacts: []
        },
        runtime: {
          prompt: templateDraft.prompt,
          tools: [],
          outputSchemas: [],
          contextRequirements: [],
          constraints: {}
        },
        evaluation: {
          suiteIds: [],
          baselineMetrics: {},
          templateVocabularySnapshot: vocabularySnapshotId,
          currentVocabularySnapshot: vocabularySnapshotId
        },
        lineage: {
          parentVersionId: null,
          improvementRunId: null,
          datasetVersionId: null,
          createdBy: "",
          createdAt: nowIso,
          changeSummary: templateDraft.changeSummary.trim()
        },
        ownership: { businessId, visibility: "PRIVATE" },
        checksums: {}
      }
    });
    setTemplates((current) => [created.template, ...(current ?? [])]);
    setVersionsByTemplate((current) => ({
      ...current,
      [created.template.id]: [created.version]
    }));
    setTemplateDraft(emptyTemplateDraft);
    setIsCreatingTemplate(false);
    setMessage(`Template "${created.template.name}" created.`);
    openTemplate(created.template.id);
  }

  async function createSuite() {
    if (selectedTemplateId === null) return;
    const name = suiteName.trim();
    if (name.length === 0) {
      setMessage("Enter an evaluation suite name.");
      return;
    }
    const created = await postJson<{
      suite: EvaluationSuiteSummary;
      cases: EvaluationCaseSummary[];
    }>(`${templatesPath}/${encodeURIComponent(selectedTemplateId)}/evaluation-suites`, {
      name,
      description: suiteDescription.trim(),
      cases: []
    });
    setSuitesByTemplate((current) => ({
      ...current,
      [selectedTemplateId]: [...(current[selectedTemplateId] ?? []), created.suite]
    }));
    setCasesBySuite((current) => ({ ...current, [created.suite.id]: [] }));
    setSelectedSuiteId(created.suite.id);
    setSuiteName("");
    setSuiteDescription("");
    setIsCreatingSuite(false);
    setMessage(`Evaluation suite "${created.suite.name}" created.`);
  }

  function buildMatcher(draft: CaseDraft): Record<string, unknown> {
    if (draft.matcherKind === "JUDGE") {
      return {
        type: "JUDGE",
        rubric: draft.rubric,
        minimumScore: Number.parseFloat(draft.minimumScore) || 0
      };
    }
    return { type: draft.matcherKind, expected: JSON.parse(draft.expectedJson) };
  }

  async function addCase() {
    if (selectedTemplateId === null || selectedSuiteId === null) return;
    const name = caseDraft.name.trim();
    if (name.length === 0) {
      setMessage("Enter a test case name.");
      return;
    }
    let input: unknown;
    let matcher: Record<string, unknown>;
    try {
      input = JSON.parse(caseDraft.inputJson);
      matcher = buildMatcher(caseDraft);
    } catch {
      setMessage("Case input and expected value must be valid JSON.");
      return;
    }
    const created = await postJson<EvaluationCaseSummary>(
      `${templatesPath}/${encodeURIComponent(selectedTemplateId)}/evaluation-suites/${encodeURIComponent(
        selectedSuiteId
      )}/cases`,
      { name, input, matcher, tags: splitList(caseDraft.tags) }
    );
    setCasesBySuite((current) => ({
      ...current,
      [selectedSuiteId]: [...(current[selectedSuiteId] ?? []), created]
    }));
    setCaseDraft(emptyCaseDraft);
    setIsAddingCase(false);
    setMessage(`Test case "${created.name}" added.`);
  }

  async function runEvaluation() {
    if (selectedTemplateId === null || selectedSuiteId === null) return;
    if (candidateVersionId === "") {
      setMessage("Choose a candidate version to evaluate.");
      return;
    }
    const run = await postJson<EvaluationRunSummary>(
      `${templatesPath}/${encodeURIComponent(selectedTemplateId)}/evaluations`,
      {
        suiteId: selectedSuiteId,
        candidateVersionId,
        ...(baselineVersionId === "" ? {} : { baselineVersionId })
      }
    );
    // Evaluations run to completion inside runModelTemplateEvaluation before the POST responds
    // (services/api/src/cp2/domains/model-templates/store.ts) - there is no background job, so a
    // single follow-up GET for per-case results is enough; no polling loop is needed.
    const detail = await getJson<{ run: EvaluationRunSummary; results: EvaluationResultSummary[] }>(
      `/businesses/${businessId}/evaluations/${encodeURIComponent(run.id)}`
    );
    setLastRun(detail);
    setMessage(
      run.status === "COMPLETED"
        ? `Evaluation completed: ${run.metrics?.passed ?? 0}/${run.metrics?.total ?? 0} passed.`
        : `Evaluation failed${run.errorCode === null ? "" : ` (${run.errorCode})`}.`
    );
  }

  const versions =
    selectedTemplateId === null ? [] : (versionsByTemplate[selectedTemplateId] ?? []);
  const suites = selectedTemplateId === null ? [] : (suitesByTemplate[selectedTemplateId] ?? []);
  const cases = selectedSuiteId === null ? [] : (casesBySuite[selectedSuiteId] ?? []);
  const selectedTemplate =
    (templates ?? []).find((template) => template.id === selectedTemplateId) ?? null;

  return (
    <div className="record-form model-template-workbench-panel">
      <div className="section-heading">
        <p className="eyebrow">Executable expertise</p>
        <h3>Model Template workbench</h3>
        <p>Create a template, build an evaluation suite, and run evaluations against it.</p>
      </div>
      {message.length > 0 ? (
        <p className="shell-note" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}

      <TemplateVocabularyPanel
        businessId={businessId}
        onSnapshotChange={handleVocabularySnapshot}
      />

      <div className="row-actions">
        <button type="button" onClick={() => setIsCreatingTemplate((open) => !open)}>
          {isCreatingTemplate ? "Cancel" : "New template"}
        </button>
      </div>

      {isCreatingTemplate ? (
        <div className="nested-card">
          <label>
            Name
            <input
              value={templateDraft.name}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            Domain
            <input
              value={templateDraft.domain}
              placeholder="customer-support"
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, domain: event.target.value }))
              }
            />
          </label>
          <label>
            Slug
            <input
              value={templateDraft.slug}
              placeholder={slugify(templateDraft.name) || "auto-generated-from-name"}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, slug: event.target.value }))
              }
            />
          </label>
          <label>
            Version
            <input
              value={templateDraft.version}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, version: event.target.value }))
              }
            />
          </label>
          <label>
            Base model
            <select
              value={templateDraft.baseModelId}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, baseModelId: event.target.value }))
              }
            >
              <option value="">Choose a base model…</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tasks (namespaced, comma or newline separated)
            <input
              value={templateDraft.tasks}
              placeholder="support.answer-question"
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, tasks: event.target.value }))
              }
            />
          </label>
          <label>
            Validated distribution ID
            <input
              value={templateDraft.validationDistributionId}
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  validationDistributionId: event.target.value
                }))
              }
            />
          </label>
          <label>
            Validation description
            <input
              value={templateDraft.validationDescription}
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  validationDescription: event.target.value
                }))
              }
            />
          </label>
          <label>
            Validation suite IDs (comma separated)
            <input
              value={templateDraft.validationSuiteIds}
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  validationSuiteIds: event.target.value
                }))
              }
            />
          </label>
          <label>
            Minimum capability tier
            <input
              value={templateDraft.minimumCapabilityTier}
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  minimumCapabilityTier: event.target.value
                }))
              }
            />
          </label>
          <label>
            Required model capabilities (comma separated)
            <input
              value={templateDraft.requiredModelCapabilities}
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  requiredModelCapabilities: event.target.value
                }))
              }
            />
          </label>
          <label>
            Minimum context window (optional)
            <input
              type="number"
              min="1"
              value={templateDraft.minimumContextWindow}
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  minimumContextWindow: event.target.value
                }))
              }
            />
          </label>
          <label>
            Capabilities (optional, comma separated)
            <input
              value={templateDraft.capabilities}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, capabilities: event.target.value }))
              }
            />
          </label>
          <label>
            Prompt (optional)
            <textarea
              value={templateDraft.prompt}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, prompt: event.target.value }))
              }
            />
          </label>
          <label>
            Expertise instructions (optional, one per line)
            <textarea
              value={templateDraft.instructions}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, instructions: event.target.value }))
              }
            />
          </label>
          <label>
            Change summary
            <input
              value={templateDraft.changeSummary}
              onChange={(event) =>
                setTemplateDraft((current) => ({ ...current, changeSummary: event.target.value }))
              }
            />
          </label>
          <div className="row-actions">
            <button
              type="button"
              disabled={isPending("workbench-create-template")}
              onClick={() =>
                void runAction("workbench-create-template", async () => {
                  try {
                    await createTemplate();
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            >
              Create template
            </button>
          </div>
        </div>
      ) : null}

      {templates === null ? <p className="shell-note">Loading templates…</p> : null}
      {templates !== null && templates.length === 0 ? (
        <p className="shell-note">No Model Templates yet.</p>
      ) : null}
      {templates !== null &&
        templates.map((template) => (
          <article className="nested-card" key={template.id}>
            <div className="nested-card-title-row">
              <div>
                <p className="eyebrow">{template.domain}</p>
                <h3>{template.name}</h3>
                <p>{template.slug}</p>
              </div>
              <span className="model-badge status-ready">
                {template.productionVersionId === null ? "No production version" : "In production"}
              </span>
            </div>
            <div className="row-actions">
              <button
                className="secondary"
                type="button"
                disabled={isPending(`workbench-open-${template.id}`)}
                onClick={() => openTemplate(template.id)}
              >
                {selectedTemplateId === template.id ? "Selected" : "Open workbench"}
              </button>
            </div>
          </article>
        ))}

      {selectedTemplate === null ? null : (
        <div className="nested-card">
          <div className="section-heading">
            <p className="eyebrow">Workbench</p>
            <h3>{selectedTemplate.name}</h3>
          </div>

          <h3>Versions</h3>
          {versions.length === 0 ? (
            <p className="shell-note">No versions yet.</p>
          ) : (
            versions.map((version) => (
              <div className="template-version-row" key={version.id}>
                <p>
                  {version.version} · {version.state} · base {version.baseModelId}
                </p>
                <span
                  className={
                    vocabularySnapshotId === version.manifest.vocabularySnapshot.id
                      ? "model-badge status-ready"
                      : "model-badge status-warning"
                  }
                >
                  {vocabularySnapshotId === version.manifest.vocabularySnapshot.id
                    ? "Vocabulary current"
                    : "Vocabulary drift"}
                </span>
              </div>
            ))
          )}

          <h3>Evaluation suites</h3>
          <div className="row-actions">
            <button type="button" onClick={() => setIsCreatingSuite((open) => !open)}>
              {isCreatingSuite ? "Cancel" : "New evaluation suite"}
            </button>
          </div>
          {isCreatingSuite ? (
            <div className="nested-card">
              <label>
                Suite name
                <input value={suiteName} onChange={(event) => setSuiteName(event.target.value)} />
              </label>
              <label>
                Description (optional)
                <input
                  value={suiteDescription}
                  onChange={(event) => setSuiteDescription(event.target.value)}
                />
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending("workbench-create-suite")}
                  onClick={() =>
                    void runAction("workbench-create-suite", async () => {
                      try {
                        await createSuite();
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  Create suite
                </button>
              </div>
            </div>
          ) : null}
          {suites.length === 0 ? (
            <p className="shell-note">No evaluation suites yet.</p>
          ) : (
            <label>
              Selected suite
              <select
                value={selectedSuiteId ?? ""}
                onChange={(event) => setSelectedSuiteId(event.target.value || null)}
              >
                <option value="">Choose a suite…</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name} (v{suite.version})
                  </option>
                ))}
              </select>
            </label>
          )}

          {selectedSuiteId === null ? null : (
            <>
              <h3>Test cases</h3>
              <div className="row-actions">
                <button type="button" onClick={() => setIsAddingCase((open) => !open)}>
                  {isAddingCase ? "Cancel" : "Add test case"}
                </button>
              </div>
              {isAddingCase ? (
                <div className="nested-card">
                  <label>
                    Case name
                    <input
                      value={caseDraft.name}
                      onChange={(event) =>
                        setCaseDraft((current) => ({ ...current, name: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Input (JSON)
                    <textarea
                      value={caseDraft.inputJson}
                      onChange={(event) =>
                        setCaseDraft((current) => ({ ...current, inputJson: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Matcher
                    <select
                      value={caseDraft.matcherKind}
                      onChange={(event) =>
                        setCaseDraft((current) => ({
                          ...current,
                          matcherKind: event.target.value as MatcherKind
                        }))
                      }
                    >
                      <option value="EXACT">Exact match</option>
                      <option value="CONTAINS">Contains</option>
                      <option value="JUDGE">Judge rubric</option>
                    </select>
                  </label>
                  {caseDraft.matcherKind === "JUDGE" ? (
                    <>
                      <label>
                        Rubric
                        <textarea
                          value={caseDraft.rubric}
                          onChange={(event) =>
                            setCaseDraft((current) => ({ ...current, rubric: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        Minimum score (0-1)
                        <input
                          value={caseDraft.minimumScore}
                          onChange={(event) =>
                            setCaseDraft((current) => ({
                              ...current,
                              minimumScore: event.target.value
                            }))
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <label>
                      Expected output (JSON)
                      <textarea
                        value={caseDraft.expectedJson}
                        onChange={(event) =>
                          setCaseDraft((current) => ({
                            ...current,
                            expectedJson: event.target.value
                          }))
                        }
                      />
                    </label>
                  )}
                  <label>
                    Tags (optional, comma separated)
                    <input
                      value={caseDraft.tags}
                      onChange={(event) =>
                        setCaseDraft((current) => ({ ...current, tags: event.target.value }))
                      }
                    />
                  </label>
                  <div className="row-actions">
                    <button
                      type="button"
                      disabled={isPending("workbench-add-case")}
                      onClick={() =>
                        void runAction("workbench-add-case", async () => {
                          try {
                            await addCase();
                          } catch (error) {
                            setMessage(getUserFacingErrorMessage(error));
                          }
                        })
                      }
                    >
                      Save test case
                    </button>
                  </div>
                </div>
              ) : null}
              {cases.length === 0 ? (
                <p className="shell-note">No test cases yet.</p>
              ) : (
                cases.map((item) => (
                  <p key={item.id}>
                    {item.name} · {item.matcher.type}
                    {item.tags.length > 0 ? ` · ${item.tags.join(", ")}` : ""}
                  </p>
                ))
              )}

              <h3>Run evaluation</h3>
              <label>
                Candidate version
                <select
                  value={candidateVersionId}
                  onChange={(event) => setCandidateVersionId(event.target.value)}
                >
                  <option value="">Choose a version…</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.version} ({version.state})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Baseline version (optional)
                <select
                  value={baselineVersionId}
                  onChange={(event) => setBaselineVersionId(event.target.value)}
                >
                  <option value="">Use production version</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.version} ({version.state})
                    </option>
                  ))}
                </select>
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending("workbench-run-evaluation") || cases.length === 0}
                  onClick={() =>
                    void runAction("workbench-run-evaluation", async () => {
                      try {
                        await runEvaluation();
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  Run evaluation
                </button>
              </div>

              {lastRun === null ? null : (
                <div className="nested-card">
                  <div className="nested-card-title-row">
                    <h3>Evaluation result</h3>
                    <span
                      className={`model-badge ${
                        lastRun.run.status === "COMPLETED" ? "status-ready" : "status-failed"
                      }`}
                    >
                      {lastRun.run.status}
                    </span>
                  </div>
                  {lastRun.run.metrics === null ? null : (
                    <div className="metric-grid">
                      <div className="metric">
                        <span>Task score</span>
                        <strong>{lastRun.run.metrics.taskSuccessRate}%</strong>
                      </div>
                      <div className="metric">
                        <span>Passed</span>
                        <strong>
                          {lastRun.run.metrics.passed}/{lastRun.run.metrics.total}
                        </strong>
                      </div>
                      <div className="metric">
                        <span>Regressions</span>
                        <strong>{lastRun.run.metrics.regressionCount}</strong>
                      </div>
                    </div>
                  )}
                  {lastRun.results.map((result) => (
                    <p key={result.id}>
                      {result.candidatePassed ? "Passed" : "Failed"} · {result.evaluatorType} ·
                      score {result.score}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
