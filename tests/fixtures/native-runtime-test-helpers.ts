import type { Cp2Store } from "../../services/api/src/cp2/store";

/**
 * Activates a generic, capability-compatible model as the global default runtime's primary
 * model, so an otherwise-unbound conversation resolves instead of reporting
 * RUNTIME_MODEL_NOT_CONFIGURED. Tests that only need the native runtime binding to resolve to
 * *something* - because they inject their own `runtimeModelProvider`/`modelRuntimeAdapterResolver`
 * and don't care which modelId is selected - can use this instead of constructing their own
 * `AiModelSummary` fixture. See services/api/src/cp2/domains/native-runtime/store.ts and
 * docs/architecture/provider-neutral-runtime.md (no model vendor is required for Grogoni to boot;
 * this mirrors an operator choosing one, not a startup requirement).
 */
export function activateGenericGlobalDefaultModel(store: Cp2Store, checkedAt: string): void {
  store.activateGlobalDefaultModel({
    model: {
      id: "test-global-default-model",
      label: "Test global default model",
      provider: "local",
      description: "A generic test model backing the global default runtime slot.",
      capabilities: ["chat", "tool-routing"],
      available: true,
      source: "huggingface",
      format: "GGUF",
      license: null,
      licenseUrl: null,
      modelCardUrl: null,
      downloadUrl: null,
      fileName: null,
      fileSizeBytes: null,
      minimumMemoryGb: null,
      recommended: false,
      contextWindow: null
    },
    executionTarget: "backend",
    checkedAt,
    updatedBy: "test-fixture"
  });
}
