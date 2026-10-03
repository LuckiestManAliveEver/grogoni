import { randomUUID } from "node:crypto";

import type { RuntimeModelCompletionResult } from "@grogoni/shared-types";

import {
  asModelRuntimeError,
  buildInferencePrompt,
  normalizeModelText
} from "../inference/model-runtime.js";
import { isClientExecutedTarget, type ModelDefinition } from "../inference/providers/contract.js";
import { validateProviderEndpoint } from "../inference/providers/endpoint-policy.js";
import { InferenceError } from "../inference/providers/errors.js";
import type { InferenceRouter } from "../inference/providers/inference-router.js";
import type { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";

/**
 * ZeroClaw (https://github.com/zeroclaw-labs/zeroclaw, MIT OR Apache-2.0) as an agent runtime.
 *
 * ZeroClaw runs as its own service - never inside the API process - and is reached through its
 * gateway's documented `POST /webhook` endpoint:
 *
 *   request   Authorization: Bearer <paired token>   X-Webhook-Secret: <secret> (when configured)
 *             X-Session-Id: <one per turn>            X-Idempotency-Key: <request id>
 *             { "message": "...", "stream": false }
 *   response  200 { "response": "...", "model": "<model ZeroClaw used>" }
 *
 * ZeroClaw holds Grogoni's platform provider key and calls the model itself, so Grogoni pays. Everything
 * Grogoni owns still applies, through InferenceRouter.delegate: the bound model must be an enabled,
 * provider-routed catalog model; shop budgets, platform budgets and rate limits are admitted before
 * the call; and the run is recorded as platform-funded usage afterwards.
 *
 * Boundaries:
 * - Output is plain model text. Grogoni parses it exactly like any other model's output, so a Grogoni
 *   tool call is only ever a proposal that goes through Grogoni's validation, permission, confirmation
 *   and approval path. ZeroClaw is given no Grogoni credentials and cannot act on Grogoni data.
 * - Each turn uses a fresh ZeroClaw session: Grogoni already sends the conversation, and no shop's
 *   conversation is kept in ZeroClaw's memory for another turn (or another shop) to read.
 * - ZeroClaw must answer with the bound model. Any other model is rejected, never accepted
 *   silently (docs/adr/ADR-zeroclaw-default-agent-runtime.md).
 */
export interface ZeroClawGatewayConfig {
  /** Gateway base URL, validated by the provider endpoint policy. */
  url: URL;
  /** Bearer token obtained by pairing with the gateway (`zeroclaw pair`). */
  token: string;
  /** Optional `gateway.webhook_secret`, sent as X-Webhook-Secret. */
  webhookSecret: string;
  /** Optional configured ZeroClaw agent alias (`?agent=`); empty uses the gateway default. */
  agentAlias: string;
  timeoutMs: number;
}

export interface ZeroClawAgentRuntimeOptions {
  gateway: ZeroClawGatewayConfig | null;
  /** Late-bound: the inference platform is created after the adapter registry. */
  inference?: () => {
    router: InferenceRouter;
    resolveModelDefinition(modelId: string): ModelDefinition | null;
  } | null;
  fetchImpl?: typeof fetch;
}

export const zeroClawAgentRuntimeAdapterId = "zeroclaw";
const maxResponseBytes = 256_000;
/** ZeroClaw's gateway body limit is 64 KB; leave headroom for JSON escaping differences. */
const maxRequestBytes = 60_000;

export function createZeroClawAgentRuntimeAdapter(
  options: ZeroClawAgentRuntimeOptions
): AgentRuntimeAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  function servedModel(modelId: string): ModelDefinition | null {
    const model = options.inference?.()?.resolveModelDefinition(modelId) ?? null;
    return model === null || isClientExecutedTarget(model.executionTarget) ? null : model;
  }

  return {
    id: zeroClawAgentRuntimeAdapterId,
    async canRun(input) {
      if (input.agent.status !== "active") {
        return {
          available: false,
          errorCode: "AGENT_RUNTIME_UNAVAILABLE",
          message: "The selected agent is not active."
        };
      }
      if (options.gateway === null || options.inference?.() == null) {
        return {
          available: false,
          errorCode: "AGENT_RUNTIME_UNCONFIGURED",
          message: "The ZeroClaw agent runtime is not connected on this deployment."
        };
      }
      if (servedModel(input.modelId) === null) {
        return {
          available: false,
          errorCode: "MODEL_RUNTIME_INCOMPATIBLE",
          message: "ZeroClaw runs cloud provider models only. Choose a cloud model for this agent."
        };
      }
      return { available: true, errorCode: null, message: null };
    },

    async execute(input) {
      input.signal?.throwIfAborted();
      const startedAt = Date.now();
      const gateway = options.gateway;
      const inference = options.inference?.() ?? null;
      const model = servedModel(input.modelId);
      try {
        if (gateway === null || inference === null || model === null) {
          throw new InferenceError("PROVIDER_MISCONFIGURED", {
            modelId: input.modelId,
            diagnostic: "ZeroClaw gateway, inference platform or routed model missing."
          });
        }
        const requestId = randomUUID();
        const message = buildInferencePrompt(input.prompt);
        const response = await inference.router.delegate(
          {
            requestId,
            modelId: model.id,
            messages: [{ role: "user", content: message }]
          },
          {
            agentId: input.agent.id,
            tenantId: input.shopId,
            userId: null,
            conversationId: input.conversationId,
            runtimeBindingId: input.bindingId,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          },
          async ({ model: resolved }) => {
            const reply = await callZeroClaw({
              gateway,
              fetchImpl,
              requestId,
              message,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              model: resolved
            });
            return { output: { text: reply, toolCalls: [] }, finishReason: "stop" };
          }
        );
        const text = normalizeModelText(response.output.text);
        return {
          completion: {
            provider: response.providerId,
            status: "available",
            outputText: text,
            durationMs: Date.now() - startedAt,
            errorCode: null,
            metadata: {
              modelId: response.modelId,
              agentRuntime: zeroClawAgentRuntimeAdapterId,
              ...(response.usage?.inputTokens === undefined
                ? {}
                : { promptTokens: response.usage.inputTokens }),
              ...(response.usage?.outputTokens === undefined
                ? {}
                : { completionTokens: response.usage.outputTokens }),
              inferenceRequestId: response.requestId
            }
          },
          eventTypes: ["agent_start", "turn_start", "zeroclaw_webhook", "turn_end", "agent_end"]
        };
      } catch (error) {
        const normalized = asModelRuntimeError(error);
        const completion: RuntimeModelCompletionResult = {
          provider: model?.providerId ?? zeroClawAgentRuntimeAdapterId,
          status:
            normalized.code === "REQUEST_TIMEOUT" || normalized.code === "INFERENCE_TIMEOUT"
              ? "timeout"
              : "unavailable",
          outputText: null,
          durationMs: Date.now() - startedAt,
          errorCode: normalized.code,
          metadata: { modelId: input.modelId, agentRuntime: zeroClawAgentRuntimeAdapterId }
        };
        return { completion, eventTypes: ["agent_start", "agent_error"] };
      }
    }
  };
}

async function callZeroClaw(input: {
  gateway: ZeroClawGatewayConfig;
  fetchImpl: typeof fetch;
  requestId: string;
  message: string;
  model: ModelDefinition;
  signal?: AbortSignal;
}): Promise<string> {
  const { gateway, model } = input;
  const failure = (
    code: ConstructorParameters<typeof InferenceError>[0],
    diagnostic: string,
    status?: number
  ) =>
    new InferenceError(code, {
      providerId: model.providerId,
      modelId: model.id,
      diagnostic: `ZeroClaw: ${diagnostic}`,
      ...(status === undefined ? {} : { status })
    });
  // The gateway rejects bodies over 64 KB; say so clearly instead of sending a doomed request.
  const requestBody = JSON.stringify({ message: input.message, stream: false });
  if (Buffer.byteLength(requestBody) > maxRequestBytes) {
    throw failure("CONTEXT_TOO_LARGE", "prompt exceeds the gateway body limit");
  }
  const url = new URL("webhook", gateway.url.href.endsWith("/") ? gateway.url : `${gateway.url}/`);
  if (gateway.agentAlias !== "") url.searchParams.set("agent", gateway.agentAlias);
  const timeout = AbortSignal.timeout(gateway.timeoutMs);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(gateway.token === "" ? {} : { authorization: `Bearer ${gateway.token}` }),
        ...(gateway.webhookSecret === "" ? {} : { "x-webhook-secret": gateway.webhookSecret }),
        // A fresh session per turn: Grogoni supplies the conversation itself.
        "x-session-id": `grogoni-${input.requestId}`,
        "x-idempotency-key": input.requestId
      },
      body: requestBody
    });
  } catch {
    if (input.signal?.aborted === true) throw failure("REQUEST_CANCELLED", "cancelled");
    if (timeout.aborted) throw failure("REQUEST_TIMEOUT", "gateway timed out");
    throw failure("PROVIDER_UNAVAILABLE", "gateway unreachable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    if (status === 401 || status === 403 || status === 400) {
      throw failure("PROVIDER_MISCONFIGURED", `gateway refused the request (${status})`, status);
    }
    if (status === 429) throw failure("RATE_LIMITED", "gateway rate limited", status);
    if (status === 408 || status === 504) throw failure("REQUEST_TIMEOUT", "timed out", status);
    if (status === 503) throw failure("PROVIDER_UNAVAILABLE", "gateway has no model", status);
    throw failure("INFERENCE_FAILED", `gateway error (${status})`, status);
  }
  const raw = await readBounded(response, maxResponseBytes);
  if (raw === null) throw failure("INVALID_PROVIDER_RESPONSE", "response too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw failure("INVALID_PROVIDER_RESPONSE", "response is not JSON");
  }
  const reply = (body as { response?: unknown }).response;
  const served = (body as { model?: unknown }).model;
  if (typeof reply !== "string" || reply.trim() === "") {
    throw failure("INVALID_PROVIDER_RESPONSE", "empty response");
  }
  if (typeof served !== "string" || !sameModel(served, model.providerModelId)) {
    // Never accept a reply from a model other than the one this binding pays for.
    throw failure(
      "MODEL_UNAVAILABLE",
      `gateway answered with "${String(served).slice(0, 80)}", binding requires "${model.providerModelId}"`
    );
  }
  return reply;
}

/** ZeroClaw may report the model with its provider prefix ("openai/gpt-6-luna"). */
export function sameModel(served: string, expected: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase();
  const actual = normalize(served);
  const wanted = normalize(expected);
  return actual === wanted || actual.endsWith(`/${wanted}`) || actual.endsWith(`:${wanted}`);
}

async function readBounded(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads ZEROCLAW_* settings. Returns null when no gateway is configured; throws on a configured
 * but invalid one so a typo fails the boot instead of every turn.
 */
export function readZeroClawGatewayConfig(env: NodeJS.ProcessEnv): ZeroClawGatewayConfig | null {
  const rawUrl = env.ZEROCLAW_GATEWAY_URL?.trim() ?? "";
  if (rawUrl === "") return null;
  // A private-network sidecar (e.g. a Render private service on http://zeroclaw:42617) is the
  // expected deployment, so the operator may opt in to http and private addresses explicitly.
  const allowPrivate = ["1", "true", "yes", "on"].includes(
    (env.ZEROCLAW_ALLOW_PRIVATE_NETWORK ?? "").trim().toLowerCase()
  );
  // Render's private-network `hostport` has no scheme; it is only ever plain http on the private
  // network, so a bare host:port is accepted only together with the private-network opt-in.
  const withScheme =
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(rawUrl) || !allowPrivate ? rawUrl : `http://${rawUrl}`;
  let url: URL;
  try {
    url = validateProviderEndpoint(withScheme, {
      allowPrivateNetwork: allowPrivate,
      allowHttp: allowPrivate
    });
  } catch (error) {
    throw new Error(
      `ZEROCLAW_GATEWAY_URL is not allowed: ${error instanceof Error ? error.message : "invalid"}`
    );
  }
  const token = env.ZEROCLAW_GATEWAY_TOKEN?.trim() ?? "";
  const webhookSecret = env.ZEROCLAW_WEBHOOK_SECRET?.trim() ?? "";
  if (token === "" && webhookSecret === "") {
    throw new Error(
      "ZEROCLAW_GATEWAY_TOKEN or ZEROCLAW_WEBHOOK_SECRET is required when ZEROCLAW_GATEWAY_URL is set."
    );
  }
  const agentAlias = env.ZEROCLAW_AGENT_ALIAS?.trim() ?? "";
  if (agentAlias !== "" && !/^[A-Za-z0-9_.-]{1,64}$/u.test(agentAlias)) {
    throw new Error("ZEROCLAW_AGENT_ALIAS must be a plain agent alias.");
  }
  const rawTimeout = env.ZEROCLAW_TIMEOUT_MS?.trim() ?? "";
  const timeoutMs = rawTimeout === "" ? 120_000 : Number(rawTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("ZEROCLAW_TIMEOUT_MS must be between 1000 and 600000.");
  }
  return { url, token, webhookSecret, agentAlias, timeoutMs };
}

/** Engine used where an agent names ZeroClaw but this deployment has no ZeroClaw gateway. */
export const zeroClawUnconnectedFallbackAdapterId = "grogoni";

/**
 * ZeroClaw is the first-choice engine. A deployment without a ZeroClaw gateway resolves it to
 * Grogoni's built-in engine once, at configuration time - never per turn - and the effective runtime
 * reports the engine actually used, so the choice is always visible.
 */
export function connectedAgentRuntimeAdapterId(
  adapterId: string,
  zeroClawConnected: boolean
): string {
  return adapterId === zeroClawAgentRuntimeAdapterId && !zeroClawConnected
    ? zeroClawUnconnectedFallbackAdapterId
    : adapterId;
}
