import { describe, expect, it, vi } from "vitest";
import { createOpenRouterJsonCompletion } from "./openrouter-json-completion.js";
import { createOpenRouterRuntime } from "./openrouter-runtime.js";

const call = { system: "sys", user: "msg", maxOutputTokens: 512, timeoutMs: 2_500 };

function respond(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe("OpenRouter JSON completion", () => {
  it("asks the mapped model for JSON with no provider fallback, using the server key", async () => {
    const request = respond({
      model: "openai/gpt-6-luna",
      choices: [{ message: { content: '{"intent":"greeting","query":null}' } }],
      usage: { prompt_tokens: 300, completion_tokens: 12 }
    });
    const complete = createOpenRouterJsonCompletion({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "server-key",
      request
    });
    const result = await complete(call);
    expect(result).toMatchObject({
      text: '{"intent":"greeting","query":null}',
      modelId: "gpt-6-luna",
      promptTokens: 300,
      completionTokens: 12
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer server-key");
    const sent = JSON.parse(String(init!.body));
    expect(sent).toMatchObject({
      model: "openai/gpt-6-luna",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "msg" }
      ],
      max_tokens: 512,
      response_format: { type: "json_object" },
      provider: { allow_fallbacks: false }
    });
  });

  it("refuses an answer from another model", async () => {
    const complete = createOpenRouterJsonCompletion({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request: respond({ model: "openai/cheaper", choices: [{ message: { content: "{}" } }] })
    });
    await expect(complete(call)).rejects.toMatchObject({ code: "MODEL_IDENTITY_MISMATCH" });
  });

  it("maps HTTP failures, empty output and missing keys to model runtime errors", async () => {
    const make = (request: typeof fetch, apiKey = "k") =>
      createOpenRouterJsonCompletion({
        modelId: "m",
        providerModelId: "vendor/m",
        apiKey,
        request
      });
    await expect(make(respond({}, 503))(call)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    await expect(
      make(respond({ model: "vendor/m", choices: [{ message: { content: " " } }] }))(call)
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    const unused = respond({});
    await expect(make(unused, " ")(call)).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
    expect(unused).not.toHaveBeenCalled();
  });

  it("times out at the caller's budget", async () => {
    const hang = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))
        )
    );
    const complete = createOpenRouterJsonCompletion({
      modelId: "m",
      providerModelId: "vendor/m",
      apiKey: "k",
      request: hang
    });
    await expect(complete({ ...call, timeoutMs: 20 })).rejects.toMatchObject({
      code: "INFERENCE_TIMEOUT"
    });
  });

  it("is reached through the runtime only for mapped models", () => {
    const runtime = createOpenRouterRuntime({ OPENROUTER_API_KEY: "k" });
    expect(runtime.jsonCompletion("gpt-6-luna")).toBeTypeOf("function");
    expect(runtime.jsonCompletion("not-configured")).toBeUndefined();
  });
});
