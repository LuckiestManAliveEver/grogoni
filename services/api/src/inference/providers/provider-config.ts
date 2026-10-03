import type { InferenceExecutionTarget, ModelCapabilities } from "./contract.js";

/**
 * Provider *types* are adapter implementations; provider *ids* are configured instances. Many ids
 * can share one type (every llama.cpp / vLLM / LocalAI / gateway is an "openai-compatible" id), so
 * adding a compatible host is a configuration row, not code.
 */
export type InferenceProviderType = "openai" | "anthropic" | "zai" | "openai-compatible" | "local";

export const inferenceProviderTypes = [
  "openai",
  "anthropic",
  "zai",
  "openai-compatible",
  "local"
] as const satisfies readonly InferenceProviderType[];

export function isInferenceProviderType(value: unknown): value is InferenceProviderType {
  return (inferenceProviderTypes as readonly unknown[]).includes(value);
}

/**
 * How connection testing verifies a credential. "models-endpoint" (GET /models) costs nothing and
 * is preferred; "minimal-completion" sends a 1-token completion and is used only where a provider
 * has no free verification endpoint.
 */
export type CredentialVerificationMethod = "models-endpoint" | "minimal-completion" | "none";

export interface InferenceProviderConfig {
  id: string;
  displayName: string;
  type: InferenceProviderType;
  /** API root, e.g. https://api.openai.com/v1. Null only for the client-executed "local" type. */
  baseUrl: string | null;
  executionTarget: InferenceExecutionTarget;
  enabled: boolean;
  /** Provider-level ceiling on model capabilities (e.g. a gateway that strips tool calling). */
  capabilities: Partial<ModelCapabilities>;
  /**
   * Grogoni-managed credential reference. "env:NAME" reads a server environment variable;
   * "secret://<credential-id>" reads a platform-scoped row from inference_provider_credentials.
   * Never a secret value.
   */
  credentialRef: string | null;
  /** Whether tenants/users may connect their own key for this provider. */
  byokAllowed: boolean;
  /**
   * Whether a BYOK credential may carry its own endpoint (a user's own vLLM/LocalAI server). Such
   * endpoints are always validated with the strict SSRF policy, never allowPrivateNetwork.
   */
  allowCredentialEndpoint: boolean;
  /** Operator-only escape hatch for a self-hosted server on a private network. See endpoint-policy.ts. */
  allowPrivateNetwork: boolean;
  allowHttp: boolean;
  /**
   * The billing product this configuration draws from. Two configurations of one vendor with
   * different products (Z.ai general API vs. a coding subscription) are always distinct provider
   * ids and are never interchangeable fallbacks for each other.
   */
  billingProduct: string | null;
  verification: CredentialVerificationMethod;
  /** Adapter options. Only the keys each adapter documents are read. */
  options: {
    maxTokensParameter?: "max_tokens" | "max_completion_tokens";
    anthropicVersion?: string;
  };
  source: "builtin" | "environment" | "database";
}

/** Safe projection for API responses: no credential reference internals beyond "is it managed". */
export interface InferenceProviderView {
  id: string;
  displayName: string;
  type: InferenceProviderType;
  executionTarget: InferenceExecutionTarget;
  enabled: boolean;
  managedCredentialConfigured: boolean;
  byokAllowed: boolean;
  allowCredentialEndpoint: boolean;
  billingProduct: string | null;
}
