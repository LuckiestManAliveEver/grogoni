import type { AiModelSummary } from "@grogoni/shared-types";

import type {
  ModelRuntimeAdapter,
  OllamaInferenceClient,
  OllamaInstalledModel
} from "./model-runtime.js";

/**
 * The models installed in local Ollama, as catalog entries the model tab can list and a shop can
 * activate with one click. Each refresh asks Ollama (GET /api/tags) what is installed; between
 * refreshes the last good list is served, so a slow or stopped Ollama never blocks the catalog.
 *
 * The configured default tag (OLLAMA_MODEL) is left out: it already backs the platform default
 * catalog entry, and listing it twice would offer the same model under two ids.
 */
export interface LocalModelCatalog {
  /** Installed models as catalog entries, from the last successful refresh. */
  list(): AiModelSummary[];
  /** The Ollama tag a catalog id stands for, when that model is installed. */
  ollamaTagFor(modelId: string): string | undefined;
  /** Re-reads Ollama. Keeps the previous list when Ollama cannot be reached. */
  refresh(signal?: AbortSignal): Promise<{ ok: boolean; count: number }>;
}

/** "qwen2.5:3b" -> "ollama-qwen2.5-3b": a portable catalog id that survives URLs and the database. */
export function ollamaCatalogModelId(tag: string): string {
  const slug = tag
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `ollama-${slug}`;
}

export function ollamaCatalogEntry(model: OllamaInstalledModel): AiModelSummary {
  const details = [model.parameterSize, model.quantization].filter(
    (value): value is string => value !== null
  );
  return {
    id: ollamaCatalogModelId(model.name),
    label: `${model.name} (local)`,
    provider: "ollama",
    description:
      `Installed in Ollama on the machine running Grogoni${details.length === 0 ? "" : ` (${details.join(", ")})`}. ` +
      "Runs locally with no usage cost.",
    capabilities: ["chat"],
    available: true,
    source: "hosted",
    format: "remote",
    license: null,
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: model.sizeBytes,
    minimumMemoryGb: null,
    recommended: false,
    contextWindow: null,
    canonicalModelId: model.name,
    supportsToolCalling: false,
    supportsStructuredOutput: false
  };
}

export function createOllamaModelCatalog(options: {
  client: Pick<OllamaInferenceClient, "listModels">;
  /** Tags that are already served under another catalog id (the configured default). */
  excludeTags?: readonly string[];
  log?: (event: string, fields: Record<string, unknown>) => void;
}): LocalModelCatalog {
  const excluded = new Set(options.excludeTags ?? []);
  let entries: AiModelSummary[] = [];
  let tagById = new Map<string, string>();

  return {
    list() {
      return entries.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] }));
    },
    ollamaTagFor(modelId) {
      return tagById.get(modelId);
    },
    async refresh(signal) {
      try {
        const installed = await options.client.listModels(signal);
        const nextTags = new Map<string, string>();
        const nextEntries: AiModelSummary[] = [];
        for (const model of installed) {
          if (excluded.has(model.name)) continue;
          const entry = ollamaCatalogEntry(model);
          // Two tags can slug to one id only if they differ in characters the slug drops; keep the
          // first rather than silently serving the wrong weights under a shared id.
          if (nextTags.has(entry.id)) continue;
          nextTags.set(entry.id, model.name);
          nextEntries.push(entry);
        }
        entries = nextEntries.sort((left, right) => left.label.localeCompare(right.label));
        tagById = nextTags;
        return { ok: true, count: entries.length };
      } catch (error) {
        options.log?.("inference.ollama_catalog_refresh_failed", {
          reason: error instanceof Error ? error.message : "unknown"
        });
        return { ok: false, count: entries.length };
      }
    }
  };
}

/**
 * The API's model adapter lookup: adapters registered at boot (the platform default) first, then -
 * for the "local" target only - an Ollama adapter for any installed model in the catalog, created
 * on first use and reused after. A model that is not installed resolves to nothing, so activation
 * fails cleanly instead of pointing a shop at weights that do not exist.
 */
export function createLocalModelAdapterResolver(options: {
  registered: Map<string, ModelRuntimeAdapter>;
  catalog: Pick<LocalModelCatalog, "ollamaTagFor">;
  createAdapter: (input: { modelId: string; ollamaTag: string }) => ModelRuntimeAdapter;
}): (input: { modelId: string; executionTarget: string }) => ModelRuntimeAdapter | undefined {
  return (input) => {
    const key = `${input.executionTarget}:${input.modelId}`;
    const registered = options.registered.get(key);
    if (registered !== undefined || input.executionTarget !== "local") return registered;
    const ollamaTag = options.catalog.ollamaTagFor(input.modelId);
    if (ollamaTag === undefined) return undefined;
    const adapter = options.createAdapter({ modelId: input.modelId, ollamaTag });
    options.registered.set(key, adapter);
    return adapter;
  };
}
