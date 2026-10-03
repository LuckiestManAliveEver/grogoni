import type {
  InferenceChunk,
  InferenceProvider,
  InferenceRequest,
  InferenceRouteDecision
} from "@grogoni/shared-types";
import { mapInferenceError, type InferenceUserState } from "./error-mapping";

export interface InferenceExecutionResult {
  providerId: string;
  runtime: InferenceProvider["runtime"];
  text: string;
  fallbackCount: number;
}

export class InferenceExecutionError extends Error {
  readonly code = "INFERENCE_EXECUTION_FAILED";

  constructor(readonly failures: Array<{ providerId: string; state: InferenceUserState }>) {
    super("No permitted inference provider completed the request.");
    this.name = "InferenceExecutionError";
  }
}

export async function executeInferenceRoute(input: {
  decision: InferenceRouteDecision;
  providers: InferenceProvider[];
  request: InferenceRequest;
  onChunk?: (chunk: InferenceChunk) => void;
  onAttempt?: (provider: InferenceProvider, fallbackCount: number) => void;
  onFailure?: (provider: InferenceProvider, state: InferenceUserState) => void;
}): Promise<InferenceExecutionResult> {
  const providers = new Map(input.providers.map((provider) => [provider.id, provider]));
  const attempts = [input.decision.providerId, ...input.decision.fallbackProviderIds];
  const failures: Array<{ providerId: string; state: InferenceUserState }> = [];

  for (const [fallbackCount, providerId] of attempts.entries()) {
    const provider = providers.get(providerId);
    if (provider === undefined) {
      failures.push({ providerId, state: "inference-unavailable" });
      continue;
    }
    input.onAttempt?.(provider, fallbackCount);
    let text = "";
    let completed = false;
    try {
      for await (const chunk of provider.generate(input.request)) {
        validateChunk(chunk, input.request, provider);
        text += chunk.text;
        completed ||= chunk.done;
        input.onChunk?.(chunk);
      }
      const normalized = text.trim();
      if (!completed || normalized.length === 0) {
        throw new Error("The inference provider returned an incomplete response.");
      }
      return {
        providerId,
        runtime: provider.runtime,
        text: normalized,
        fallbackCount
      };
    } catch (error) {
      await provider.cancel?.(input.request.requestId).catch(() => undefined);
      const state = mapInferenceError(error);
      failures.push({ providerId, state });
      input.onFailure?.(provider, state);
    }
  }

  throw new InferenceExecutionError(failures);
}

function validateChunk(
  chunk: InferenceChunk,
  request: InferenceRequest,
  provider: InferenceProvider
): void {
  if (
    chunk.requestId !== request.requestId ||
    chunk.modelId !== request.modelId ||
    chunk.runtime !== provider.runtime ||
    typeof chunk.text !== "string" ||
    typeof chunk.done !== "boolean"
  ) {
    throw new Error("The inference provider returned an invalid response.");
  }
}
