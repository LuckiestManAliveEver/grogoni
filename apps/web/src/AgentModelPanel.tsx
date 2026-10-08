import { useEffect, useRef, useState } from "react";

import type {
  AgentModelActivationResult,
  AgentModelBindingRemovalResult,
  AgentModelBindingSummary,
  EffectiveRuntimeSummary,
  ModelRuntimeHealthSummary
} from "@grogoni/shared-types";

import {
  readClientInferencePreferences,
  saveClientInferencePreferences,
  type ClientInferencePreferences
} from "./inference/preferences";

import { navigateToBrowserUrl } from "./browser-navigation";

import { ApiRequestError } from "./lib/api";

import {
  type ActiveBusiness,
  type AgentSettings,
  type AiModelSummary,
  backendModelProbeRequestTimeoutMs,
  clientInferenceFeatureFlags
} from "./grogoni-application-shared";

import { postJson, deleteJson, getJson } from "./api-helpers";
import { formatDate, formatLatency, formatExecutionTarget } from "./formatters";
import { isAgentModel } from "./owner-app-bootstrap";
import { normalizeSearchText } from "./agent-command-engine";
import { getErrorMessage } from "./chat-message-plumbing";
import {
  applyDeploymentRuntimeAvailability,
  isIncludedModel,
  isServerExecutionTarget,
  servedExecutionTarget
} from "./agent-model-panel-utils";
import { backendModelRuntimeStatusMessage } from "./backend-model-runtime-status";
import { McpAccessTokensPanel } from "./McpAccessTokensPanel";

// Local UI state for the activate/test button, not a backend runtime concept - activation is a
// single request/response against the canonical runtime binding API, not a multi-stage local
// process, so this only ever takes these four values.
type ModelActivationState = "idle" | "validating" | "active" | "failed";

export interface AgentModelPanelProps {
  accountId: string;
  business: ActiveBusiness;
  agent: AgentSettings;
  isEditing: boolean;
  updateAgent: (patch: Partial<AgentSettings>) => void;
  onAgentChange: (agent: AgentSettings) => void;
  profileMessage: string;
  setProfileMessage: (message: string) => void;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  copyStorefrontValue: (value: string, label: string) => Promise<void>;
  aiModels: AiModelSummary[];
  setAiModels: (models: AiModelSummary[]) => void;
  activeAiModelId: string;
  setActiveAiModelId: (modelId: string) => void;
}

/**
 * The advanced counterpart to QuickRuntimeSwitcher.tsx's simple "pick an agent + model" dropdown:
 * this panel shows the full model binding (with a real test/activate/remove round trip against
 * /api/agents/:agentId/models/:modelId/{test,activate} and /api/agents/:agentId/model-binding).
 * Every catalog model runs on the API's local Ollama runtime (execution target "local", see
 * docs/local-first-cloud-audit.md); there is no cloud provider or private per-device model copy.
 */
export function AgentModelPanel({
  accountId,
  business,
  agent,
  isEditing,
  updateAgent,
  onAgentChange,
  profileMessage,
  setProfileMessage,
  pendingProfileAction,
  runProfileAction,
  copyStorefrontValue,
  aiModels,
  setAiModels,
  activeAiModelId,
  setActiveAiModelId
}: AgentModelPanelProps) {
  const canonicalRuntimeAgentId = business.id;
  const [visibleAiModels, setVisibleAiModels] = useState<AiModelSummary[]>([]);
  const [activeAgentModelBinding, setActiveAgentModelBinding] =
    useState<AgentModelBindingSummary | null>(null);
  const [effectiveRuntime, setEffectiveRuntime] = useState<EffectiveRuntimeSummary | null>(null);
  const [serverBackendRuntime, setServerBackendRuntime] = useState<
    Record<
      string,
      {
        status: "available" | "unavailable";
        latencyMs: number | null;
        errorCode: string | null;
      }
    >
  >({});
  const [activatingModelId, setActivatingModelId] = useState<string | null>(null);
  // Set only while a merchant-funded activation (any model but smollm2-360m) awaits explicit
  // confirmation - activateServerBackendModel is never called until the merchant confirms, so a
  // single click can never switch this agent onto a billable model without that confirmation.
  const [pendingCostConfirmationModelId, setPendingCostConfirmationModelId] = useState<
    string | null
  >(null);
  const [testingBackendModelId, setTestingBackendModelId] = useState<string | null>(null);
  const [failedActivationModelId, setFailedActivationModelId] = useState<string | null>(null);
  const [modelActivationState, setModelActivationState] = useState<ModelActivationState>("idle");
  const [modelLibraryLoaded, setModelLibraryLoaded] = useState(false);
  const [modelLibraryLoading, setModelLibraryLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelRuntimeBusy, setModelRuntimeBusy] = useState(false);
  const modelRuntimeBusyRef = useRef(false);
  const [inferencePreferences, setInferencePreferences] = useState<ClientInferencePreferences>(() =>
    readClientInferencePreferences(accountId, business.id)
  );
  useEffect(() => {
    setInferencePreferences(readClientInferencePreferences(accountId, business.id));
    void loadCanonicalAgentModelBinding();
    const params = new URLSearchParams(location.search);
    const initialSearch = params.get("ai_search") ?? "";
    setModelSearch(initialSearch);
  }, [accountId, business.id]);

  useEffect(() => {
    if (!modelLibraryLoaded) return;
    const onPopState = () => {
      const params = new URLSearchParams(location.search);
      const searchParam = params.get("ai_search") ?? "";
      setModelSearch(searchParam);
      void loadAiModels(searchParam);
      const selectedModel = params.get("ai_model");
      if (selectedModel) {
        updateAgent({ model: selectedModel });
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [modelLibraryLoaded]);

  async function openModelLibrary() {
    if (modelLibraryLoaded || modelLibraryLoading) return;
    setModelLibraryLoading(true);
    setProfileMessage("Opening model settings…");
    try {
      const initialSearch = new URLSearchParams(location.search).get("ai_search") ?? "";
      await loadAiModels(initialSearch);
      setModelLibraryLoaded(true);
      setProfileMessage("Model settings ready.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    } finally {
      setModelLibraryLoading(false);
    }
  }

  function updateInferencePreferences(patch: Partial<ClientInferencePreferences>) {
    const next = saveClientInferencePreferences(accountId, business.id, {
      ...inferencePreferences,
      ...patch
    });
    setInferencePreferences(next);
    setProfileMessage("Client-first inference preferences saved.");
  }

  async function loadAiModels(search?: string) {
    const offlineDefaults: AiModelSummary[] = [];
    try {
      const normalizedSearch = search?.trim() ?? "";
      const [registry, searchResults, canonicalBinding, resolvedRuntime] = await Promise.all([
        getJson<{ models: AiModelSummary[] }>("/v1/ai-models"),
        normalizedSearch.length > 0
          ? getJson<{ models: AiModelSummary[] }>(
              `/v1/ai-models?search=${encodeURIComponent(normalizedSearch)}`
            )
          : Promise.resolve(null),
        getJson<{ binding: AgentModelBindingSummary | null }>(
          `/api/agents/${encodeURIComponent(
            canonicalRuntimeAgentId
          )}/model-binding?shopId=${encodeURIComponent(business.id)}`
        ).catch(() => ({ binding: null })),
        getJson<EffectiveRuntimeSummary>(`/businesses/${business.id}/runtime/effective`)
      ]);
      const allModels = applyDeploymentRuntimeAvailability(registry.models, registry.models);
      const visibleModels = applyDeploymentRuntimeAvailability(
        searchResults?.models ?? registry.models,
        registry.models
      );
      const effectiveModelId = resolvedRuntime.model.id;
      setAiModels(allModels);
      setVisibleAiModels(visibleModels);
      setActiveAiModelId(effectiveModelId);
      setActiveAgentModelBinding(canonicalBinding.binding);
      setEffectiveRuntime(resolvedRuntime);
      if (!isEditing && isAgentModel(effectiveModelId)) {
        updateAgent({ model: effectiveModelId });
      }
    } catch (error) {
      const matchingDefaults = offlineDefaults.filter((model) =>
        (search?.trim().length ?? 0) === 0
          ? true
          : normalizeSearchText(
              `${model.label} ${model.description} ${model.capabilities.join(" ")}`
            ).includes(normalizeSearchText(search ?? ""))
      );
      setAiModels(offlineDefaults);
      setVisibleAiModels(matchingDefaults);
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function searchAiModels() {
    const s = modelSearch.trim();
    try {
      const u = new URL(location.href);
      if (s) u.searchParams.set("ai_search", s);
      else u.searchParams.delete("ai_search");
      navigateToBrowserUrl(`${u.pathname}${u.search}`, { replace: true });
    } catch {
      /* ignore history update errors in unusual environments */
    }
    await loadAiModels(s);
  }

  async function loadCanonicalAgentModelBinding(): Promise<EffectiveRuntimeSummary | null> {
    if (!navigator.onLine) return effectiveRuntime;
    try {
      const [response, resolvedRuntime] = await Promise.all([
        getJson<{ binding: AgentModelBindingSummary | null }>(
          `/api/agents/${encodeURIComponent(
            canonicalRuntimeAgentId
          )}/model-binding?shopId=${encodeURIComponent(business.id)}`
        ),
        getJson<EffectiveRuntimeSummary>(`/businesses/${business.id}/runtime/effective`)
      ]);
      setActiveAgentModelBinding(response.binding);
      setEffectiveRuntime(resolvedRuntime);
      setActiveAiModelId(resolvedRuntime.model.id);
      return resolvedRuntime;
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
      return null;
    }
  }

  async function testServerBackendModel(model: AiModelSummary) {
    if (modelRuntimeBusyRef.current || !navigator.onLine) {
      setProfileMessage("Connect to the internet to test the model.");
      return;
    }
    modelRuntimeBusyRef.current = true;
    setModelRuntimeBusy(true);
    setTestingBackendModelId(model.id);
    try {
      setProfileMessage(`Testing ${model.label} through real local inference…`);
      const result = await postJson<{ healthCheck: ModelRuntimeHealthSummary }>(
        `/api/agents/${encodeURIComponent(
          canonicalRuntimeAgentId
        )}/models/${encodeURIComponent(model.id)}/test`,
        {
          shopId: business.id,
          executionTarget: servedExecutionTarget(model)
        },
        { timeoutMs: backendModelProbeRequestTimeoutMs }
      );
      setServerBackendRuntime((current) => ({
        ...current,
        [model.id]: {
          status: "available",
          latencyMs: result.healthCheck.latencyMs,
          errorCode: null
        }
      }));
      setProfileMessage(
        `Model verified. ${model.label} responded from ${
          result.healthCheck.executionTarget
        } in ${formatLatency(result.healthCheck.latencyMs)}.`
      );
    } catch (error) {
      setServerBackendRuntime((current) => ({
        ...current,
        [model.id]: {
          status: "unavailable",
          latencyMs: null,
          errorCode: error instanceof ApiRequestError ? error.code : null
        }
      }));
      setProfileMessage(getErrorMessage(error));
    } finally {
      modelRuntimeBusyRef.current = false;
      setModelRuntimeBusy(false);
      setTestingBackendModelId(null);
    }
  }

  function requestActivateServerBackendModel(model: AiModelSummary) {
    if (!isIncludedModel(model)) {
      setPendingCostConfirmationModelId(model.id);
      return;
    }
    void activateServerBackendModel(model);
  }

  async function activateServerBackendModel(model: AiModelSummary) {
    if (modelRuntimeBusyRef.current || !navigator.onLine) {
      setProfileMessage("Connect to the internet to activate the model.");
      return;
    }
    setPendingCostConfirmationModelId(null);
    modelRuntimeBusyRef.current = true;
    setModelRuntimeBusy(true);
    setActivatingModelId(model.id);
    setModelActivationState("validating");
    try {
      setProfileMessage(`Verifying and activating ${model.label} for ${agent.name}…`);
      const result = await postJson<AgentModelActivationResult>(
        `/api/agents/${encodeURIComponent(
          canonicalRuntimeAgentId
        )}/models/${encodeURIComponent(model.id)}/activate`,
        {
          shopId: business.id,
          executionTarget: servedExecutionTarget(model),
          executionMode: "LOCAL_FIRST",
          permissions: {
            allowInstalledApp: false,
            allowRemoteShopDevice: inferencePreferences.ownerNodeAllowed
          },
          ...(isIncludedModel(model) ? {} : { costResponsibility: "merchant" })
        },
        { timeoutMs: backendModelProbeRequestTimeoutMs }
      );
      setActiveAgentModelBinding(result.binding);
      setServerBackendRuntime((current) => ({
        ...current,
        [model.id]: {
          status: "available",
          latencyMs: result.healthCheck.latencyMs,
          errorCode: null
        }
      }));
      setActiveAiModelId(result.binding.modelId);
      updateAgent({ model: result.binding.modelId });
      onAgentChange({ ...agent, model: result.binding.modelId });
      setModelActivationState("active");
      setFailedActivationModelId(null);
      await loadCanonicalAgentModelBinding();
      setProfileMessage(
        `${model.label} is active for ${agent.name}. Verified in ${formatLatency(
          result.healthCheck.latencyMs
        )}.`
      );
    } catch (error) {
      setModelActivationState("failed");
      setFailedActivationModelId(model.id);
      setProfileMessage(`${getErrorMessage(error)} The previous working model remains active.`);
      await loadCanonicalAgentModelBinding();
    } finally {
      modelRuntimeBusyRef.current = false;
      setModelRuntimeBusy(false);
      setActivatingModelId(null);
    }
  }

  async function removeServerBackendModelFromAgent(model: AiModelSummary) {
    if (
      modelRuntimeBusyRef.current ||
      !navigator.onLine ||
      explicitAgentModelBinding?.status !== "active" ||
      explicitAgentModelBinding.modelId !== model.id
    ) {
      if (!navigator.onLine) {
        setProfileMessage("Connect to the internet to remove this model from the agent.");
      }
      return;
    }
    modelRuntimeBusyRef.current = true;
    setModelRuntimeBusy(true);
    setActivatingModelId(model.id);
    try {
      setProfileMessage(`Removing ${model.label} from ${agent.name}…`);
      const result = await deleteJson<AgentModelBindingRemovalResult>(
        `/api/agents/${encodeURIComponent(
          canonicalRuntimeAgentId
        )}/model-binding?shopId=${encodeURIComponent(business.id)}`
      );
      if (result.binding !== null || result.agentId !== canonicalRuntimeAgentId) {
        throw new Error("The backend did not remove the active model binding.");
      }
      const resolvedRuntime = await loadCanonicalAgentModelBinding();
      if (resolvedRuntime === null) {
        throw new Error("The backend did not resolve the platform default runtime.");
      }
      setActiveAgentModelBinding(null);
      setActiveAiModelId(resolvedRuntime.model.id);
      updateAgent({ model: resolvedRuntime.model.id });
      onAgentChange({ ...agent, model: resolvedRuntime.model.id });
      setModelActivationState("idle");
      setFailedActivationModelId(null);
      setProfileMessage(
        `${model.label} is no longer preferred for ${agent.name}. Chat will continue with automatic execution.`
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
      await loadCanonicalAgentModelBinding();
    } finally {
      modelRuntimeBusyRef.current = false;
      setModelRuntimeBusy(false);
      setActivatingModelId(null);
    }
  }

  const activeAiModel = aiModels.find((model) => model.id === activeAiModelId);
  const explicitAgentModelBinding =
    effectiveRuntime?.source === "default" ? null : activeAgentModelBinding;
  const activeBackendBinding =
    explicitAgentModelBinding?.status === "active" &&
    isServerExecutionTarget(explicitAgentModelBinding.executionTarget);
  const activeBackendConfigured =
    activeBackendBinding && activeAiModel?.runtimeAvailability?.backend === "configured";
  const serverBackendModels = visibleAiModels.filter(
    (model) => model.runtimeAvailability?.backend === "configured"
  );
  // Deliberately keyed off aiModels (the full deployment catalog), not visibleAiModels (which is
  // search-filtered) - typing into the model search box must never make this banner flicker to
  // "Unavailable" just because the current search happens to exclude every backend-configured model.
  const grogoniAiReady = effectiveRuntime?.ready === true;
  return (
    <>
      <div className="record-form agent-model-panel">
        <div className="section-heading">
          <p className="eyebrow">Grogoni AI · {grogoniAiReady ? "Ready" : "Unavailable"}</p>
          <h3>Advanced model preferences</h3>
          <p>
            Execution is automatic. Grogoni runs the model through Ollama on the machine running
            Grogoni; there is no cloud AI provider to configure.
          </p>
        </div>
        {modelActivationState !== "idle" && profileMessage.length > 0 ? (
          <p className="shell-note" role="status" aria-live="polite">
            {profileMessage}
          </p>
        ) : null}
        <article className="agent-model-current">
          <div>
            <span className="model-badge">Current model</span>
            <span className={`model-badge status-${explicitAgentModelBinding?.status ?? "failed"}`}>
              {explicitAgentModelBinding?.status === "active"
                ? `Active for ${agent.name}`
                : "Automatic"}
            </span>
          </div>
          <h4>
            {explicitAgentModelBinding === null
              ? grogoniAiReady
                ? (effectiveRuntime?.model.name ?? "Grogoni AI is ready")
                : "Grogoni AI is unavailable"
              : (activeAiModel?.label ?? explicitAgentModelBinding.modelId)}
          </h4>
          <p>
            {explicitAgentModelBinding === null
              ? grogoniAiReady
                ? "A compatible execution host and model are selected automatically when you chat."
                : "No local model is available. Start Ollama and pull the configured model."
              : `Running on: ${formatExecutionTarget(explicitAgentModelBinding.executionTarget)}`}
          </p>
          <small>
            {explicitAgentModelBinding?.lastVerifiedAt === null ||
            explicitAgentModelBinding?.lastVerifiedAt === undefined
              ? "No download or activation required"
              : `Verified ${formatDate(explicitAgentModelBinding.lastVerifiedAt)}`}
          </small>
          {activeBackendBinding && !activeBackendConfigured ? (
            <small role="status">
              Backend inference is no longer configured for this deployment. Remove this binding or
              switch to an available model.
            </small>
          ) : null}
          <div className="ai-model-card-actions">
            {!activeBackendBinding || activeBackendConfigured ? (
              <button
                className="secondary"
                type="button"
                disabled={explicitAgentModelBinding === null || modelRuntimeBusy}
                onClick={() => {
                  const model = aiModels.find(
                    (candidate) => candidate.id === explicitAgentModelBinding?.modelId
                  );
                  if (model !== undefined) void testServerBackendModel(model);
                }}
              >
                Test model
              </button>
            ) : null}
            {activeBackendBinding && activeAiModel !== undefined ? (
              <button
                className="secondary"
                type="button"
                disabled={modelRuntimeBusy}
                onClick={() => void removeServerBackendModelFromAgent(activeAiModel)}
              >
                Remove from agent
              </button>
            ) : null}
            <button type="button" onClick={() => void openModelLibrary()}>
              Switch model
            </button>
          </div>
        </article>
        <McpAccessTokensPanel
          accountId={accountId}
          businessId={business.id}
          pendingProfileAction={pendingProfileAction}
          runProfileAction={runProfileAction}
          setProfileMessage={setProfileMessage}
          copyStorefrontValue={copyStorefrontValue}
        />
        <details className="agent-model-advanced">
          <summary>Advanced routing</summary>
          <section className="browser-model-control" aria-label="Client-first inference routing">
            <div>
              <strong>Client-first route permissions</strong>
              <p>
                Grogoni routes chat through the configured local model. A signed-in, shop-owned
                device (for example a merchant's own laptop) can additionally be registered as an
                allowed execution host. Server tools remain confirmation-gated.
              </p>
            </div>
            <label className="browser-model-toggle">
              <input
                type="checkbox"
                checked={inferencePreferences.ownerNodeAllowed}
                disabled={!clientInferenceFeatureFlags.ownerNode || modelRuntimeBusy}
                onChange={(event) =>
                  updateInferencePreferences({ ownerNodeAllowed: event.target.checked })
                }
              />
              Allow another signed-in shop device
            </label>
            <small>
              Prompts may be relayed only to an authenticated device registered for this shop and
              model.
            </small>
          </section>
        </details>
      </div>

      <div className="record-form ai-model-library">
        <div className="section-heading">
          <p className="eyebrow">Local AI</p>
          <h3>Model library</h3>
          <p>
            Browse Grogoni's local model catalog. Every model runs through the local Grogoni
            runtime.
          </p>
        </div>

        {!modelLibraryLoaded ? (
          <div className="deferred-model-library">
            <p>The local model catalog stays paused until you open this library.</p>
            <button
              type="button"
              disabled={modelLibraryLoading}
              aria-busy={modelLibraryLoading}
              onClick={() => void openModelLibrary()}
            >
              {modelLibraryLoading ? "Opening model settings…" : "Open model library"}
            </button>
          </div>
        ) : (
          <>
            {serverBackendModels.length > 0 ? (
              <section aria-label="Grogoni local models">
                <div className="section-subheading">
                  <h4>Grogoni local models</h4>
                  <p>
                    Available means the deployed runtime passed a real model probe. Active means
                    this agent has a persisted binding that passed real local inference.
                  </p>
                </div>
                <div className="ai-model-catalog">
                  {serverBackendModels.map((model) => {
                    const activeForAgent =
                      explicitAgentModelBinding?.status === "active" &&
                      explicitAgentModelBinding.modelId === model.id &&
                      isServerExecutionTarget(explicitAgentModelBinding.executionTarget);
                    const runtime = serverBackendRuntime[model.id];
                    const runtimeLabel =
                      runtime?.status === "available"
                        ? "Available"
                        : runtime?.status === "unavailable"
                          ? "Unavailable"
                          : "Not verified";
                    return (
                      <article className="ai-model-card" key={`backend:${model.id}`}>
                        <div>
                          <p className="eyebrow">
                            Local · {activeForAgent ? `Active for ${agent.name}` : runtimeLabel}
                          </p>
                          <h4>{model.label}</h4>
                          <p>{model.description}</p>
                          <small>{model.capabilities.join(" · ")}</small>
                          {runtime?.status === "unavailable" ? (
                            <small role="status">
                              {backendModelRuntimeStatusMessage(runtime.errorCode)}
                            </small>
                          ) : runtime?.status === "available" ? (
                            <small>
                              Model verified in {formatLatency(runtime.latencyMs ?? 0)}.
                            </small>
                          ) : null}
                          {failedActivationModelId === model.id ? (
                            <small role="status">
                              Activation failed. The previous working model remains active - try
                              again or pick a different model.
                            </small>
                          ) : null}
                          {pendingCostConfirmationModelId === model.id ? (
                            <div className="shell-note" role="alertdialog">
                              <small>
                                {model.label} is merchant-funded through {model.provider}. Your
                                business will be billed for its inference usage. Switch anyway?
                              </small>
                              <div className="ai-model-card-actions">
                                <button
                                  type="button"
                                  disabled={modelRuntimeBusy}
                                  onClick={() => void activateServerBackendModel(model)}
                                >
                                  Confirm switch
                                </button>
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={modelRuntimeBusy}
                                  onClick={() => setPendingCostConfirmationModelId(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <div className="ai-model-card-actions">
                          <button
                            className="secondary"
                            type="button"
                            disabled={modelRuntimeBusy}
                            onClick={() => void testServerBackendModel(model)}
                          >
                            {testingBackendModelId === model.id ? "Testing…" : "Test model"}
                          </button>
                          <button
                            type="button"
                            aria-pressed={activeForAgent}
                            disabled={modelRuntimeBusy}
                            onClick={() =>
                              activeForAgent
                                ? void removeServerBackendModelFromAgent(model)
                                : requestActivateServerBackendModel(model)
                            }
                          >
                            {activeForAgent
                              ? activatingModelId === model.id
                                ? "Removing…"
                                : "Remove from agent"
                              : activatingModelId === model.id
                                ? "Activating…"
                                : "Use with agent"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <div className="ai-model-search">
              <label>
                Search models
                <input
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="Search models, e.g. SmolLM"
                />
              </label>
              <div className="ai-model-search-actions">
                <button type="button" onClick={() => void searchAiModels()}>
                  Search local models
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setModelSearch("");
                    try {
                      const u = new URL(location.href);
                      u.searchParams.delete("ai_search");
                      navigateToBrowserUrl(`${u.pathname}${u.search}`, { replace: true });
                    } catch {
                      /* ignore history update errors in unusual environments */
                    }
                    void loadAiModels();
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function mergeAiModelCatalogs(
  primary: AiModelSummary[],
  additional: AiModelSummary[]
): AiModelSummary[] {
  const models: AiModelSummary[] = [];
  const ids = new Set<string>();
  const downloads = new Set<string>();

  for (const model of [...primary, ...additional]) {
    const downloadKey = normalizeModelDownloadUrl(model.downloadUrl);
    if (ids.has(model.id) || (downloadKey !== null && downloads.has(downloadKey))) {
      continue;
    }
    ids.add(model.id);
    if (downloadKey !== null) downloads.add(downloadKey);
    models.push({ ...model, capabilities: [...model.capabilities] });
  }

  return models;
}

export function normalizeModelDownloadUrl(downloadUrl: string | null): string | null {
  if (downloadUrl === null) return null;
  try {
    const url = new URL(downloadUrl);
    return `${url.origin}${decodeURIComponent(url.pathname).toLowerCase()}`;
  } catch {
    return downloadUrl.split("?")[0]?.toLowerCase() ?? null;
  }
}
