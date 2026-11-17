import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelPrompt } from "../packages/shared-types/src/index.js";
import { repositoryDefaultRuntimePolicy } from "../packages/shared-types/src/index.js";
import {
  createOpenRouterModelAdapter,
  openRouterChatRequestBody
} from "../services/api/src/inference/openrouter-model-runtime.js";
import { createOpenRouterJsonCompletion } from "../services/api/src/inference/openrouter-json-completion.js";
import { receiptReaderEnvironment } from "../services/api/src/cp2/chat-image-reader.js";
import { runtimeProviderFromAdapter } from "../services/api/src/inference/model-runtime.js";
import { modelTraceFromCompletion } from "../services/api/src/cp2/domains/agent-runtime/shared.js";
import { createGrogoniAgentRuntimeAdapter } from "../services/api/src/agent-harness/grogoni-agent-runtime-adapter.js";
import { createOpenRouterRuntime } from "../services/api/src/inference/openrouter-runtime.js";
import { hostedJsonRequest } from "../services/api/src/inference/hosted-http.js";
import { buildApi } from "../services/api/src/app.js";
import { createCp2Store } from "../services/api/src/cp2/store.js";

const prompt: RuntimeModelPrompt = {
  message: "Hello",
  allowedTools: [],
  schemaVersion: "cp11-runtime-model-v1"
};
const context = { modelId: "gpt-6-luna", agentId: "agent", shopId: "shop" };
const output = JSON.stringify({ type: "response", message: "Hello from Luna." });
describe("OpenRouter hosted runtime", () => {
  it("defaults to Grogoni and Luna, with separate selections", () => {
    expect(repositoryDefaultRuntimePolicy).toMatchObject({
      agentRuntimeAdapterId: "grogoni",
      modelId: "gpt-6-luna",
      executionTarget: "backend"
    });
    const runtime = createOpenRouterRuntime({
      OPENROUTER_API_KEY: "test",
      OPENROUTER_MODELS: JSON.stringify({
        "gpt-6-luna": "openai/gpt-6-luna",
        alternate: "vendor/other"
      })
    });
    expect(runtime.resolve({ modelId: "alternate", executionTarget: "backend" })).toBeDefined();
    expect(runtime.resolve({ modelId: "alternate", executionTarget: "local" })).toBeUndefined();
    expect(runtime.resolve({ modelId: "unknown", executionTarget: "backend" })).toBeUndefined();
  });
  it("sends the selected model and server-held credential, falling back only between hosts of it", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "run",
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: output } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 }
      })
    );
    const adapter = createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "private-test",
      request
    });
    const result = await adapter.generate({ context, prompt });
    expect(result).toMatchObject({
      modelId: context.modelId,
      text: output,
      promptTokens: 20,
      completionTokens: 10
    });
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "openai/gpt-6-luna",
      provider: { allow_fallbacks: true },
      response_format: { type: "json_object" }
    });
    expect(init.headers).toMatchObject({ authorization: "Bearer private-test" });
  });
  it("refuses unexpected model substitutions and redacts provider errors", async () => {
    const adapter = createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "private-test",
      request: async () =>
        Response.json({ model: "other", choices: [{ message: { content: output } }] })
    });
    await expect(adapter.generate({ context, prompt })).rejects.toMatchObject({
      code: "MODEL_IDENTITY_MISMATCH"
    });
    await expect(
      hostedJsonRequest({
        url: new URL("https://example.com"),
        init: {},
        timeoutMs: 1000,
        request: async () => new Response("private-provider-error", { status: 402 })
      })
    ).rejects.toMatchObject({
      code: "PROVIDER_CREDITS_EXHAUSTED",
      message: "Hosted runtime returned HTTP 402."
    });
  });
  it("bounds hosted response size and honours cancellation", async () => {
    await expect(
      hostedJsonRequest({
        url: new URL("https://example.com"),
        init: {},
        timeoutMs: 1000,
        maxBytes: 2,
        request: async () => Response.json({ tooLarge: true })
      })
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    const request = vi.fn(async () => Response.json({}));
    await expect(
      hostedJsonRequest({
        url: new URL("https://example.com"),
        init: {},
        timeoutMs: 1000,
        signal: AbortSignal.abort(),
        request
      })
    ).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });
  it("completes a new shop's first chat through Grogoni with no extra process", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ message: { content: output } }], model: "openai/gpt-6-luna" })
    );
    const grogoni = createGrogoniAgentRuntimeAdapter();
    const direct = createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "test",
      request
    });
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === "gpt-6-luna" && executionTarget === "backend" ? direct : undefined,
      agentRuntimeAdapterResolver: (id) => (id === "grogoni" ? grogoni : undefined)
    });
    const app = buildApi({ cp2: { store } });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "+254700009399", pin: "3927" }
      });
      expect(signup.statusCode).toBe(200);
      const cookies = signup.headers["set-cookie"];
      const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(";")[0]!;
      const shop = await app.inject({
        method: "POST",
        url: "/businesses",
        headers: { cookie },
        payload: { name: "Luna test", language: "en" }
      });
      expect(shop.statusCode).toBe(200);
      const businessId = shop.json().business.id;
      const response = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/runtime/turns`,
        headers: { cookie },
        payload: { message: "Hello" }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        turn: { model: { agentAdapterId: "grogoni", modelId: "gpt-6-luna", status: "available" } }
      });
      expect(request).toHaveBeenCalledOnce();
      // The default profile follows the configured platform default, not a hardcoded model.
      const profile = await app.inject({
        method: "GET",
        url: `/businesses/${businessId}/agent-profile`,
        headers: { cookie }
      });
      expect(profile.json()).toMatchObject({ modelId: "gpt-6-luna" });
    } finally {
      await app.close();
    }
  });
});

describe("OpenRouter response speed settings", () => {
  const reply = (extra: Record<string, unknown> = {}) =>
    vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "run",
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: output } }],
        usage: { prompt_tokens: 2000, completion_tokens: 10, ...extra }
      })
    );
  const sentBody = (request: ReturnType<typeof reply>) =>
    JSON.parse((request.mock.calls[0]?.[1] as RequestInit).body as string);

  it("asks for low reasoning and the fastest host of the same model by default", async () => {
    const request = reply();
    const adapter = createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request
    });
    await adapter.generate({ context, prompt });
    const body = sentBody(request);
    expect(body.reasoning).toEqual({ effort: "low", exclude: true });
    expect(body.provider).toEqual({ allow_fallbacks: true, sort: "latency" });
    expect(body.model).toBe("openai/gpt-6-luna");
  });

  it("reads OPENROUTER_REASONING_EFFORT and OPENROUTER_PROVIDER_SORT, and omits 'default'/'none'", () => {
    expect(
      openRouterChatRequestBody({
        providerModelId: "m",
        messages: [],
        maxOutputTokens: 128,
        reasoningEffort: "default",
        providerSort: "none"
      })
    ).toEqual({
      model: "m",
      messages: [],
      max_tokens: 128,
      response_format: { type: "json_object" },
      provider: { allow_fallbacks: true }
    });
    expect(() =>
      createOpenRouterRuntime({ OPENROUTER_API_KEY: "k", OPENROUTER_REASONING_EFFORT: "turbo" })
    ).toThrow(/OPENROUTER_REASONING_EFFORT/u);
    expect(() =>
      createOpenRouterRuntime({ OPENROUTER_API_KEY: "k", OPENROUTER_PROVIDER_SORT: "fastest" })
    ).toThrow(/OPENROUTER_PROVIDER_SORT/u);
  });

  it("passes the configured settings from the environment to every Luna call", async () => {
    const request = reply();
    vi.stubGlobal("fetch", request);
    try {
      const adapter = createOpenRouterRuntime({
        OPENROUTER_API_KEY: "k",
        OPENROUTER_REASONING_EFFORT: "minimal",
        OPENROUTER_PROVIDER_SORT: "throughput"
      }).resolve({ modelId: "gpt-6-luna", executionTarget: "backend" })!;
      await adapter.generate({ context, prompt });
    } finally {
      vi.unstubAllGlobals();
    }
    const body = sentBody(request);
    expect(body.reasoning).toEqual({ effort: "minimal", exclude: true });
    expect(body.provider).toEqual({ allow_fallbacks: true, sort: "throughput" });
  });

  it("keeps the provider's default reasoning on every call that carries images", async () => {
    const send = async (environment: NodeJS.ProcessEnv) => {
      const request = reply();
      vi.stubGlobal("fetch", request);
      try {
        // A shared resolver, as the WhatsApp receipt path uses: not the receipt reader's own.
        const adapter = createOpenRouterRuntime({
          OPENROUTER_API_KEY: "k",
          ...environment
        }).resolve({ modelId: "gpt-6-luna", executionTarget: "backend" })!;
        await adapter.generate({
          context,
          prompt,
          images: [{ url: "data:image/png;base64,AA==" }]
        });
        await adapter.generate({ context, prompt });
      } finally {
        vi.unstubAllGlobals();
      }
      const bodies = request.mock.calls.map((call) =>
        JSON.parse((call[1] as RequestInit).body as string)
      );
      return { image: bodies[0].reasoning, text: bodies[1].reasoning };
    };
    expect(await send({ OPENROUTER_REASONING_EFFORT: "minimal" })).toEqual({
      image: undefined,
      text: { effort: "minimal", exclude: true }
    });
    expect(await send({ LUNA_RECEIPT_REASONING_EFFORT: "high" })).toEqual({
      image: { effort: "high", exclude: true },
      text: { effort: "low", exclude: true }
    });
    // A blank secret means the default, never the faster chat setting.
    expect(
      await send({ LUNA_RECEIPT_REASONING_EFFORT: "  ", OPENROUTER_REASONING_EFFORT: "" })
    ).toEqual({
      image: undefined,
      text: { effort: "low", exclude: true }
    });
    expect(await send({ OPENROUTER_REASONING_EFFORT: " LOW " })).toMatchObject({
      text: { effort: "low", exclude: true }
    });
    expect(receiptReaderEnvironment({}).OPENROUTER_MAX_OUTPUT_TOKENS).toBe("8192");
    // A bad receipt-only value fails image calls and nothing else.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = reply();
    vi.stubGlobal("fetch", request);
    try {
      const adapter = createOpenRouterRuntime({
        OPENROUTER_API_KEY: "k",
        LUNA_RECEIPT_REASONING_EFFORT: "maximum"
      }).resolve({ modelId: "gpt-6-luna", executionTarget: "backend" })!;
      await expect(
        adapter.generate({ context, prompt, images: [{ url: "data:image/png;base64,AA==" }] })
      ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_INVALID" });
      await expect(adapter.generate({ context, prompt })).resolves.toMatchObject({ text: output });
      expect(request).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("LUNA_RECEIPT_REASONING_EFFORT"));
    } finally {
      vi.unstubAllGlobals();
      error.mockRestore();
    }
    expect(
      receiptReaderEnvironment({ LUNA_RECEIPT_MAX_OUTPUT_TOKENS: "" }).OPENROUTER_MAX_OUTPUT_TOKENS
    ).toBe("8192");
  });

  it("reports prompt tokens served from the provider cache", async () => {
    const adapter = createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request: reply({ prompt_tokens_details: { cached_tokens: 1536 } })
    });
    expect(await adapter.generate({ context, prompt })).toMatchObject({
      promptTokens: 2000,
      cachedPromptTokens: 1536
    });
    const uncached = await createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request: reply()
    }).generate({ context, prompt });
    expect(uncached).not.toHaveProperty("cachedPromptTokens");
  });

  it("carries cached prompt tokens onto the turn's model trace", async () => {
    const adapter = createOpenRouterModelAdapter({
      ...context,
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request: reply({ prompt_tokens_details: { cached_tokens: 1536 } })
    });
    const completion = await runtimeProviderFromAdapter({ adapter, context }).complete(prompt);
    expect(completion.metadata).toMatchObject({ promptTokens: 2000, cachedPromptTokens: 1536 });
    expect(modelTraceFromCompletion(completion, "response")).toMatchObject({
      promptTokens: 2000,
      cachedPromptTokens: 1536
    });
  });

  it("routes the classifier's structured call to the fastest host too", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ model: "openai/gpt-6-luna", choices: [{ message: { content: "{}" } }] })
    );
    await createOpenRouterJsonCompletion({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request
    })({ system: "s", user: "u", maxOutputTokens: 64, timeoutMs: 1000 });
    expect(sentBody(request as never).provider).toEqual({ allow_fallbacks: true, sort: "latency" });
    expect(sentBody(request as never).reasoning).toEqual({ effort: "minimal", exclude: true });
  });
});
