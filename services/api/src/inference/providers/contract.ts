/**
 * Canonical, provider-neutral inference contract (docs/architecture/multi-provider-inference-
 * implementation.md §2). Every provider adapter translates *into* these types at its boundary;
 * nothing vendor-specific (OpenAI `choices`, Anthropic `content` blocks, SSE frames, request-id
 * headers) crosses into the router, the routed model adapter, or the agent runtime.
 *
 * These names intentionally live in services/api rather than @grogoni/shared-types: the shared
 * package already exports a *client-side* InferenceRequest/InferenceChunk/InferenceProvider for the
 * offline/owner-node executor (apps/web/src/inference), and the server contract below is a
 * different shape with a different trust boundary (it carries resolved credentials).
 */
import type { SecretValue } from "./secret-value.js";
import type {
  InferenceExecutionTarget,
  InferenceModelCapabilities,
  InferenceModelPricing
} from "@grogoni/shared-types";

/**
 * Where inference physically runs, from the provider layer's point of view (declared in
 * @grogoni/shared-types so the catalog row and the client share it). Deliberately separate from the
 * native graph's ModelExecutionTarget: the two client-only targets were retired from the native
 * graph by ADR-device-independent-runtime-and-registry-discovery.md and must never materialize a
 * server-side host - see docs/architecture/multi-provider-inference-audit.md §3.1.
 */
export type { InferenceExecutionTarget };

export const inferenceExecutionTargets = [
  "browser-local",
  "installed-app",
  "remote-inference",
  "remote-shop-device"
] as const satisfies readonly InferenceExecutionTarget[];

export function isInferenceExecutionTarget(value: unknown): value is InferenceExecutionTarget {
  return (inferenceExecutionTargets as readonly unknown[]).includes(value);
}

/** True for targets the server must never execute or forward - the client runs them itself. */
export function isClientExecutedTarget(target: InferenceExecutionTarget): boolean {
  return target === "browser-local" || target === "installed-app";
}

export type ModelCapabilities = InferenceModelCapabilities;

export type ModelCapability = keyof ModelCapabilities;

export type ModelPricing = InferenceModelPricing;

/**
 * The router's view of one catalog model. Built from an `AiModelSummary` catalog row's `inference`
 * block (see modelDefinitionFromCatalog in model-definitions.ts) - never declared as a second,
 * competing catalog.
 */
export interface ModelDefinition {
  id: string;
  displayName: string;
  providerId: string;
  providerModelId: string;
  executionTarget: InferenceExecutionTarget;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled: boolean;
  pricing?: ModelPricing;
  metadata?: Record<string, unknown>;
}

export type InferenceMessageRole = "system" | "user" | "assistant" | "tool";

export type InferenceContentPart =
  { type: "text"; text: string } | { type: "image"; url: string; mediaType?: string };

export interface ToolCall {
  /** Provider-issued id, kept so a tool result can be correlated on the next turn. */
  id: string;
  /** Grogoni's canonical tool name (e.g. "products.list"), already decoded from any wire encoding. */
  name: string;
  arguments: Record<string, unknown>;
}

export interface InferenceMessage {
  role: InferenceMessageRole;
  content: string | InferenceContentPart[];
  /** role === "tool" only: which assistant tool call this result answers. */
  toolCallId?: string;
  /** role === "assistant" only: tool calls the assistant made in an earlier turn. */
  toolCalls?: ToolCall[];
}

/** Grogoni tool definition as handed to a provider. The provider never executes it. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Plain JSON Schema object (type: "object"). */
  inputSchema: Record<string, unknown>;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: Record<string, unknown> };

export interface GenerationParameters {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stop?: string[];
}

export interface InferenceRequest {
  requestId: string;
  modelId: string;
  messages: InferenceMessage[];
  generation?: GenerationParameters;
  tools?: ToolDefinition[];
  responseFormat?: ResponseFormat;
  /** Non-secret routing/telemetry metadata only. Never forwarded to a provider. */
  metadata?: Record<string, unknown>;
}

export interface InferenceUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface InferenceOutput {
  text: string;
  toolCalls: ToolCall[];
}

export type InferenceFinishReason =
  "stop" | "length" | "tool_calls" | "content_filter" | "error" | "unknown";

export interface InferenceResponse {
  requestId: string;
  providerId: string;
  modelId: string;
  output: InferenceOutput;
  finishReason?: InferenceFinishReason;
  usage?: InferenceUsage;
  cost?: { currency: string; estimatedAmount: number };
  latency?: { totalMs?: number; firstTokenMs?: number };
  providerRequestId?: string;
  /** Set by the router when an explicit fallback policy moved this request off its first choice. */
  fallbackFromProviderId?: string;
}

export type InferenceChunk =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "usage"; usage: InferenceUsage }
  | {
      type: "completed";
      response: InferenceResponse;
    }
  | { type: "error"; code: string; message: string; retryable: boolean };

export type ProviderHealthStatus =
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "MISCONFIGURED"
  | "RATE_LIMITED"
  | "CREDENTIAL_INVALID";

export interface ProviderHealth {
  providerId: string;
  status: ProviderHealthStatus;
  checkedAt: string;
  latencyMs?: number;
  errorCode?: string;
  /** Safe, user-presentable detail. Never a raw provider body. */
  message?: string;
}

/** Which credential source paid for a request. Recorded in telemetry; never the secret itself. */
export type CredentialScope = "explicit" | "tenant" | "user" | "platform";

export interface ResolvedCredential {
  scope: CredentialScope;
  /** null for env-managed platform credentials, which have no database row. */
  credentialId: string | null;
  secret: SecretValue;
  /** Only for providers that allow a per-credential endpoint (validated at connect time). */
  baseUrlOverride?: string;
}

export interface InferenceExecutionContext {
  model: ModelDefinition;
  credential: ResolvedCredential | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Who the request runs for. Only the device-local provider reads it (to hand generation to that
   * member's own device); hosted providers never forward it anywhere.
   */
  caller?: { tenantId: string | null; userId: string | null; turnId: string | null };
}

export interface ProviderHealthContext {
  credential: ResolvedCredential | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Provider model id to probe, for providers whose only verification is a minimal completion
   * (no free models endpoint). Ignored by providers that verify through GET /models.
   */
  probeModelId?: string;
}

export interface InferenceProvider {
  readonly id: string;
  health(context?: ProviderHealthContext): Promise<ProviderHealth>;
  supports(model: ModelDefinition, request?: InferenceRequest): Promise<boolean>;
  generate(
    request: InferenceRequest,
    context: InferenceExecutionContext
  ): Promise<InferenceResponse>;
  stream?(
    request: InferenceRequest,
    context: InferenceExecutionContext
  ): AsyncIterable<InferenceChunk>;
}

/**
 * Capabilities a request actually needs from its model, derived from the request itself so the
 * router can reject a mismatch before any network call (resolution step 7).
 */
export function requiredCapabilities(request: InferenceRequest): ModelCapability[] {
  const required = new Set<ModelCapability>(["text"]);
  if ((request.tools?.length ?? 0) > 0) required.add("tools");
  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") {
    required.add("structuredOutput");
  }
  const hasImage = request.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "image")
  );
  if (hasImage) required.add("vision");
  return [...required];
}

export function messageText(content: InferenceMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<InferenceContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
