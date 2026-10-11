import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelPrompt } from "../packages/shared-types/src/index.js";
import { repositoryDefaultRuntimePolicy } from "../packages/shared-types/src/index.js";
import { createOpenRouterModelAdapter } from "../services/api/src/inference/openrouter-model-runtime.js";
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
  it("sends the selected model and server-held credential without provider fallback", async () => {
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
      provider: { allow_fallbacks: false },
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
        payload: { method: "phone", contact: "+254700009399", pin: "1234" }
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
