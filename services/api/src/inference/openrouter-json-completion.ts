import { hostedJsonRequest } from "./hosted-http.js";
import { ModelRuntimeError } from "./model-runtime.js";

/**
 * One short structured call to an operator-configured OpenRouter model: a system prompt, one user
 * turn, a JSON object back. The agent adapter (openrouter-model-runtime.ts) wraps every prompt in
 * the shop-assistant runtime instructions and tool shapes; a classifier needs none of that, only
 * the same key, the same model mapping, the same HTTP client and the same model identity check.
 * Reached through createOpenRouterRuntime(environment).jsonCompletion(modelId).
 */
export interface JsonCompletionInput {
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface JsonCompletionResult {
  text: string;
  modelId: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type JsonCompletion = (input: JsonCompletionInput) => Promise<JsonCompletionResult>;

export function createOpenRouterJsonCompletion(input: {
  modelId: string;
  providerModelId: string;
  apiKey: string;
  request?: typeof fetch;
}): JsonCompletion {
  return async (call) => {
    if (input.apiKey.trim() === "")
      throw new ModelRuntimeError("CREDENTIAL_MISSING", "OpenRouter is not configured.", false);
    const started = Date.now();
    const body = (await hostedJsonRequest({
      url: new URL("https://openrouter.ai/api/v1/chat/completions"),
      timeoutMs: call.timeoutMs,
      maxBytes: 64_000,
      ...(call.signal ? { signal: call.signal } : {}),
      ...(input.request ? { request: input.request } : {}),
      init: {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: input.providerModelId,
          messages: [
            { role: "system", content: call.system },
            { role: "user", content: call.user }
          ],
          max_tokens: call.maxOutputTokens,
          response_format: { type: "json_object" },
          // A routing decision, not an essay: keep reasoning short so the answer fits the
          // caller's latency budget. Same model, no fallback to another one.
          reasoning: { effort: "low", exclude: true },
          provider: { allow_fallbacks: false }
        })
      }
    })) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    if (!body || typeof body !== "object")
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "OpenRouter returned an invalid response.",
        false
      );
    if (body.model !== input.providerModelId)
      throw new ModelRuntimeError(
        "MODEL_IDENTITY_MISMATCH",
        "OpenRouter answered with a different model.",
        false
      );
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "")
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "OpenRouter returned no model output.",
        true
      );
    return {
      text: content,
      modelId: input.modelId,
      latencyMs: Date.now() - started,
      ...(body.usage?.prompt_tokens === undefined
        ? {}
        : { promptTokens: body.usage.prompt_tokens }),
      ...(body.usage?.completion_tokens === undefined
        ? {}
        : { completionTokens: body.usage.completion_tokens })
    };
  };
}
