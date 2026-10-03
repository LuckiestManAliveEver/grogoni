import type {
  InferenceChunk,
  InferenceProvider,
  InferenceRequest,
  InferenceRuntime
} from "@grogoni/shared-types";
import { isExplicitOfflineMode } from "../offline-runtime";

export function createRemoteInferenceProvider(input: {
  id: string;
  runtime: Extract<InferenceRuntime, "owner-node" | "cloud-fallback">;
  endpoint: string;
  enabled: boolean;
  modelIds: string[];
  credentials?: RequestCredentials;
}): InferenceProvider {
  const activeControllers = new Map<string, AbortController>();
  return {
    id: input.id,
    runtime: input.runtime,
    async isAvailable() {
      return input.enabled && navigator.onLine && !isExplicitOfflineMode();
    },
    async supports(modelId) {
      return input.modelIds.includes(modelId);
    },
    async *generate(request) {
      if (isExplicitOfflineMode())
        throw new Error("Remote inference is unavailable in explicit offline mode.");
      const controller = new AbortController();
      activeControllers.set(request.requestId, controller);
      const cancelFromCaller = () => controller.abort();
      request.signal?.addEventListener("abort", cancelFromCaller, { once: true });
      try {
        const response = await fetch(input.endpoint, {
          method: "POST",
          credentials: input.credentials ?? "include",
          headers: {
            "content-type": "application/json",
            accept: "application/x-ndjson"
          },
          body: JSON.stringify({
            ...request,
            signal: undefined
          }),
          signal: controller.signal
        });
        if (!response.ok || response.body === null) {
          throw new Error(`${input.runtime} inference is unavailable.`);
        }
        yield* readNdjsonChunks(response.body, request);
      } finally {
        request.signal?.removeEventListener("abort", cancelFromCaller);
        activeControllers.delete(request.requestId);
      }
    },
    async cancel(requestId) {
      activeControllers.get(requestId)?.abort();
    }
  };
}

async function* readNdjsonChunks(
  body: ReadableStream<Uint8Array>,
  request: InferenceRequest
): AsyncIterable<InferenceChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const chunk = JSON.parse(line) as InferenceChunk;
        validateChunk(chunk, request);
        yield chunk;
      }
      if (done) break;
    }
    if (buffer.trim().length > 0) {
      const chunk = JSON.parse(buffer) as InferenceChunk;
      validateChunk(chunk, request);
      yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

function validateChunk(chunk: InferenceChunk, request: InferenceRequest): void {
  if (
    chunk.requestId !== request.requestId ||
    chunk.modelId !== request.modelId ||
    typeof chunk.text !== "string" ||
    typeof chunk.done !== "boolean"
  ) {
    throw new Error("The inference stream returned an invalid chunk.");
  }
}
