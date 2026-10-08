import type { AiModelSummary, AiModelInferenceRouting } from "../../packages/shared-types/src";
import type {
  InferenceChunk,
  InferenceExecutionContext,
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
  InferenceUsage
} from "../../services/api/src/inference/providers/contract";
import { readInferenceEnvironment } from "../../services/api/src/inference/providers/environment";
import { InferenceError } from "../../services/api/src/inference/providers/errors";
import {
  createInferencePlatform,
  type CreateInferencePlatformOptions,
  type InferencePlatform
} from "../../services/api/src/inference/providers/platform";
import type { InferenceProviderConfig } from "../../services/api/src/inference/providers/provider-config";
import {
  createMemoryInferenceRepositories,
  type InferencePolicyRecord
} from "../../services/api/src/inference/providers/repositories";

/**
 * Test doubles for the device-local inference router. Hosted providers were removed with the
 * local-first runtime, so every provider here is a "local" one; a scripted fake stands in for the
 * member's device where a test needs to control what the device answers.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  rawBody: string | null;
}

/** A fetch fake that records every request (headers included) and answers from a handler. */
export function scriptedFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: rawBody === null ? null : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetch: fake, requests };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function catalogModel(input: {
  id: string;
  providerId?: string;
  providerModelId?: string;
  executionTarget?: AiModelInferenceRouting["executionTarget"];
  capabilities?: Partial<AiModelInferenceRouting["capabilities"]>;
  pricing?: AiModelInferenceRouting["pricing"];
  maxOutputTokens?: number | null;
  enabled?: boolean;
}): AiModelSummary {
  const providerId = input.providerId ?? "local";
  return {
    id: input.id,
    label: input.id,
    provider: providerId,
    description: `${input.id} served through ${providerId}.`,
    capabilities: ["chat"],
    available: true,
    source: "hosted",
    format: "remote",
    license: null,
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: null,
    minimumMemoryGb: null,
    recommended: false,
    contextWindow: 32_768,
    inference: {
      providerId,
      providerModelId: input.providerModelId ?? `${input.id}-engine`,
      executionTarget: input.executionTarget ?? "browser-local",
      capabilities: { text: true, ...input.capabilities },
      maxOutputTokens: input.maxOutputTokens ?? null,
      enabled: input.enabled ?? true,
      pricing: input.pricing ?? null
    }
  };
}

/** An operator-managed device-local provider row (inference_providers). */
export function localProviderConfig(
  id: string,
  overrides: Partial<InferenceProviderConfig> = {}
): InferenceProviderConfig {
  return {
    id,
    displayName: id,
    type: "local",
    executionTarget: "browser-local",
    enabled: true,
    capabilities: {},
    source: "database",
    ...overrides
  };
}

export interface FakeDeviceCall {
  request: InferenceRequest;
  context: InferenceExecutionContext;
}

/**
 * A device-local provider whose "device" answers from a script. `reply` returns the text (or
 * throws to simulate a device failure); every call is recorded with the context the router built.
 */
export function fakeDeviceProvider(
  id: string,
  reply: (request: InferenceRequest) => string = () => `reply from ${id}`,
  options: { usage?: InferenceUsage; stream?: boolean } = {}
): InferenceProvider & { calls: FakeDeviceCall[] } {
  const calls: FakeDeviceCall[] = [];
  const respond = (
    request: InferenceRequest,
    context: InferenceExecutionContext
  ): InferenceResponse => {
    calls.push({ request, context });
    return {
      requestId: request.requestId,
      providerId: id,
      modelId: request.modelId,
      output: { text: reply(request), toolCalls: [] },
      finishReason: "stop",
      ...(options.usage === undefined ? {} : { usage: options.usage })
    };
  };
  return {
    id,
    calls,
    async supports(model) {
      return model.providerId === id;
    },
    async health() {
      return { providerId: id, status: "AVAILABLE", checkedAt: new Date(0).toISOString() };
    },
    async generate(request, context) {
      return respond(request, context);
    },
    ...(options.stream === true
      ? {
          async *stream(request, context): AsyncIterable<InferenceChunk> {
            const response = respond(request, context);
            for (const word of response.output.text.split(/(?<= )/u)) {
              yield { type: "text-delta", text: word };
            }
            if (response.usage !== undefined) yield { type: "usage", usage: response.usage };
            yield { type: "completed", response };
          }
        }
      : {})
  };
}

/** A device that is reachable but whose generation fails with a retryable provider fault. */
export function failingDeviceProvider(
  id: string,
  code: ConstructorParameters<typeof InferenceError>[0] = "PROVIDER_UNAVAILABLE"
): InferenceProvider & { calls: FakeDeviceCall[] } {
  const provider = fakeDeviceProvider(id);
  return {
    ...provider,
    async generate(request, context) {
      provider.calls.push({ request, context });
      throw new InferenceError(code, { providerId: id, modelId: request.modelId });
    }
  };
}

export function createTestPlatform(input: {
  catalog: AiModelSummary[];
  env?: Record<string, string>;
  policies?: InferencePolicyRecord[];
  /** Extra operator-managed local provider rows, loaded by refresh(). */
  providers?: InferenceProviderConfig[];
  /** Scripted stand-ins for providers' devices, keyed by provider id. */
  devices?: Record<string, InferenceProvider>;
  options?: Omit<CreateInferencePlatformOptions, "environment" | "repositories">;
}): {
  platform: InferencePlatform;
  repositories: ReturnType<typeof createMemoryInferenceRepositories>;
} {
  const repositories = createMemoryInferenceRepositories({
    ...(input.policies === undefined ? {} : { policies: input.policies }),
    ...(input.providers === undefined ? {} : { providers: input.providers })
  });
  const platform = createInferencePlatform({
    environment: readInferenceEnvironment({ INFERENCE_REQUEST_TIMEOUT_MS: "2000", ...input.env }),
    repositories,
    ...(input.devices === undefined
      ? {}
      : { providerOverrides: new Map(Object.entries(input.devices)) }),
    ...input.options
  });
  platform.setModelCatalog(() => input.catalog);
  return { platform, repositories };
}
