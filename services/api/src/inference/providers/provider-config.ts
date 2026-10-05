import type { InferenceExecutionTarget, ModelCapabilities } from "./contract.js";

/**
 * Provider *types* are adapter implementations; provider *ids* are configured instances. Since the
 * local-first runtime (docs/local-first-cloud-audit.md) the only type is "local": generation runs on
 * the requesting member's own device. Server-side generation goes through local Ollama
 * (inference/model-runtime.ts), never this router. Rows of any retired hosted type
 * (openai, anthropic, zai, openai-compatible) still stored in inference_providers are skipped.
 */
export type InferenceProviderType = "local";

export const inferenceProviderTypes = ["local"] as const satisfies readonly InferenceProviderType[];

export function isInferenceProviderType(value: unknown): value is InferenceProviderType {
  return (inferenceProviderTypes as readonly unknown[]).includes(value);
}

export interface InferenceProviderConfig {
  id: string;
  displayName: string;
  type: InferenceProviderType;
  executionTarget: InferenceExecutionTarget;
  enabled: boolean;
  /** Provider-level ceiling on model capabilities. */
  capabilities: Partial<ModelCapabilities>;
  source: "builtin" | "database";
}

/** Safe projection for API responses. */
export interface InferenceProviderView {
  id: string;
  displayName: string;
  type: InferenceProviderType;
  executionTarget: InferenceExecutionTarget;
  enabled: boolean;
}
