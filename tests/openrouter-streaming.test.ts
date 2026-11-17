import { describe, expect, it, vi } from "vitest";
import type {
  AgentTurnStreamEvent,
  RuntimeModelPrompt
} from "../packages/shared-types/src/index.js";
import { hostedEventStreamRequest } from "../services/api/src/inference/hosted-http.js";
import { createOpenRouterModelAdapter } from "../services/api/src/inference/openrouter-model-runtime.js";
import { turnContext, turnStreamHub } from "../services/api/src/inference/turn-stream.js";
import {
  ModelCallDeferredError,
  ModelCallLedger
} from "../services/api/src/edge-model-deferral.js";

/**
 * Luna replies stream into the existing turn stream (turn-stream.ts -> GET /v1/ai/turn-stream ->
 * the chat's preview bubble) whenever the turn has a watcher. The validated reply still comes from
 * the full output; these pin the transport, the preview, and what happens when a stream goes bad.
 */

const encoder = new TextEncoder();
/** A response whose body arrives in the given raw pieces (split anywhere, like a real socket). */
function sse(pieces: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      }
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (content: string, extra: Record<string, unknown> = {}) =>
  frame({
    id: "gen-1",
    model: "openai/gpt-6-luna",
    provider: "Azure",
    choices: [{ delta: { content }, finish_reason: null }],
    ...extra
  });

const reply = JSON.stringify({ type: "response", message: "Sugar is KES 120 per kg." });
/** The reply JSON cut into small deltas, the way a model emits it. */
const deltas = reply.match(/.{1,6}/gsu)!;

const prompt: RuntimeModelPrompt = {
  message: "How much is sugar?",
  allowedTools: [],
  schemaVersion: "cp11-runtime-model-v1"
};
let accountSequence = 0;

function harness(body: () => Response) {
  const accountId = `stream-account-${(accountSequence += 1)}`;
  const turnId = `turn-${accountId}`;
  const request = vi.fn<typeof fetch>(async () => body());
  const adapter = createOpenRouterModelAdapter({
    modelId: "gpt-6-luna",
    providerModelId: "openai/gpt-6-luna",
    apiKey: "k",
    request
  });
  const events: AgentTurnStreamEvent[] = [];
  turnStreamHub.subscribe(accountId, turnId, (event) => events.push(event));
  const context = { modelId: "gpt-6-luna", agentId: "a", shopId: "s", accountId };
  const generate = (images?: { url: string }[]) =>
    turnContext.run({ turnId }, () =>
      adapter.generate({ context, prompt, ...(images ? { images } : {}) })
    );
  const preview = () =>
    events.reduce(
      (text, event) =>
        event.type === "text" ? text + event.text : event.type === "reset" ? "" : text,
      ""
    );
  const sent = () => JSON.parse((request.mock.calls[0]![1] as RequestInit).body as string);
  return { request, events, generate, preview, sent, adapter, context };
}

const goodStream = () =>
  sse([
    ": OPENROUTER PROCESSING\n\n",
    ...deltas.map((delta) => chunk(delta)),
    frame({
      id: "gen-1",
      model: "openai/gpt-6-luna",
      choices: [{ delta: { content: "" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 512 }
      }
    }),
    "data: [DONE]\n\n"
  ]);

describe("Luna reply streaming", () => {
  it("streams a watched turn's reply text as it arrives and returns the same full output", async () => {
    const t = harness(goodStream);
    const result = await t.generate();
    expect(t.sent()).toMatchObject({ stream: true, model: "openai/gpt-6-luna" });
    expect((t.request.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      accept: "text/event-stream"
    });
    // The preview is the reply's message text, delivered in many pieces, never the raw JSON.
    expect(t.preview()).toBe("Sugar is KES 120 per kg.");
    expect(t.events.filter((event) => event.type === "text").length).toBeGreaterThan(3);
    expect(result).toMatchObject({
      text: reply,
      inferenceRequestId: "gen-1",
      promptTokens: 900,
      completionTokens: 40,
      cachedPromptTokens: 512,
      finishReason: "stop",
      // The host that answered (a fallback host when the first failed) is on the record.
      providerHost: "Azure"
    });
    expect(t.sent().provider).toEqual({ allow_fallbacks: true, sort: "latency" });
    expect(typeof result.firstTokenMs).toBe("number");
  });

  it("keeps the single-response path when nobody watches the turn", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "r",
        model: "openai/gpt-6-luna",
        provider: "OpenAI",
        choices: [{ message: { content: reply } }]
      })
    );
    const adapter = createOpenRouterModelAdapter({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      request
    });
    // No turn context: no reply stream, so no `stream: true`.
    const result = await adapter.generate({
      context: { modelId: "gpt-6-luna", agentId: "a", shopId: "s", accountId: "nobody-watching" },
      prompt
    });
    expect(result.text).toBe(reply);
    expect(result.providerHost).toBe("OpenAI");
    expect(result).not.toHaveProperty("firstTokenMs");
    expect(
      JSON.parse((request.mock.calls[0]![1] as RequestInit).body as string)
    ).not.toHaveProperty("stream");
  });

  it("never streams image transcription, even inside a watched turn", async () => {
    const t = harness(() =>
      Response.json({
        id: "r",
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: reply } }]
      })
    );
    await t.generate([{ url: "data:image/png;base64,AA==" }]);
    expect(t.sent()).not.toHaveProperty("stream");
    expect(t.events).toEqual([]);
  });

  it("previews nothing for a tool proposal", async () => {
    const tool = JSON.stringify({
      type: "tool",
      toolName: "product.create",
      input: { name: "Sugar" }
    });
    const t = harness(() =>
      sse([...(tool.match(/.{1,5}/gsu) ?? []).map((d) => chunk(d)), "data: [DONE]\n\n"])
    );
    const result = await t.generate();
    expect(result.text).toBe(tool);
    expect(t.preview()).toBe("");
  });

  it("clears the preview and fails retryably when the provider errors mid-stream", async () => {
    const t = harness(() =>
      sse([
        ...deltas.slice(0, 8).map((delta) => chunk(delta)),
        frame({
          error: { code: 502, message: "upstream reset" },
          choices: [{ delta: {}, finish_reason: "error" }]
        })
      ])
    );
    await expect(t.generate()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true
    });
    expect(t.events.at(-1)).toEqual({ type: "reset" });
    expect(t.preview()).toBe("");
  });

  it("stops at the first chunk from another model, before any of its text is previewed", async () => {
    const t = harness(() =>
      sse([
        frame({
          id: "x",
          model: "vendor/other",
          choices: [{ delta: { content: '{"type":"response","message":"Hi' } }]
        }),
        "data: [DONE]\n\n"
      ])
    );
    await expect(t.generate()).rejects.toMatchObject({ code: "MODEL_IDENTITY_MISMATCH" });
    // Stopped before its text: nothing was ever previewed, not merely cleared afterwards.
    expect(t.events.some((event) => event.type === "text")).toBe(false);
  });

  it("clears the preview when the finished stream fails validation", async () => {
    // A stream that never names its model cannot pass the identity check.
    const t = harness(() =>
      sse([
        ...deltas.map((delta) => frame({ id: "gen-1", choices: [{ delta: { content: delta } }] })),
        "data: [DONE]\n\n"
      ])
    );
    await expect(t.generate()).rejects.toMatchObject({ code: "MODEL_IDENTITY_MISMATCH" });
    expect(t.events.some((event) => event.type === "text")).toBe(true);
    expect(t.events.at(-1)).toEqual({ type: "reset" });
  });

  it("keeps streaming when a preview watcher throws", async () => {
    const t = harness(goodStream);
    turnStreamHub.subscribe(t.context.accountId, `turn-${t.context.accountId}`, () => {
      throw new Error("a broken watcher");
    });
    await expect(t.generate()).resolves.toMatchObject({ text: reply });
  });

  it("fails retryably, without a misleading identity error, when a stream request answers plain JSON", async () => {
    const t = harness(() =>
      Response.json({
        id: "r",
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: reply } }]
      })
    );
    await expect(t.generate()).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
      retryable: true
    });
  });

  it("bounds a stream that stalls after its headers by the call timeout", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = (init as RequestInit).signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(chunk(deltas[0]!)));
            signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    const adapter = createOpenRouterModelAdapter({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "k",
      timeoutMs: 80,
      request
    });
    const accountId = "stall-account";
    turnStreamHub.subscribe(accountId, "turn-stall", () => {});
    await expect(
      turnContext.run({ turnId: "turn-stall" }, () =>
        adapter.generate({
          context: { modelId: "gpt-6-luna", agentId: "a", shopId: "s", accountId },
          prompt
        })
      )
    ).rejects.toMatchObject({ code: "INFERENCE_TIMEOUT", retryable: true });
  });

  it("sizes the stream limit from the output token limit", async () => {
    // About 2.4 MB of framing: over the old fixed 2 MB, inside 4096 tokens x 1 KB.
    const filler = Array.from({ length: 6000 }, () => chunk("", { padding: "p".repeat(380) }));
    const body = () => sse([...filler, ...deltas.map((delta) => chunk(delta)), "data: [DONE]\n\n"]);
    const make = (maxOutputTokens: number) => {
      const accountId = `limit-${maxOutputTokens}`;
      turnStreamHub.subscribe(accountId, `turn-${accountId}`, () => {});
      const adapter = createOpenRouterModelAdapter({
        modelId: "gpt-6-luna",
        providerModelId: "openai/gpt-6-luna",
        apiKey: "k",
        maxOutputTokens,
        request: async () => body()
      });
      return turnContext.run({ turnId: `turn-${accountId}` }, () =>
        adapter.generate({
          context: { modelId: "gpt-6-luna", agentId: "a", shopId: "s", accountId },
          prompt
        })
      );
    };
    await expect(make(4096)).resolves.toMatchObject({ text: reply });
    await expect(make(2048)).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("maps HTTP failures and cancellation like the single-response path", async () => {
    const limited = harness(() => new Response("{}", { status: 429 }));
    await expect(limited.generate()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
    // Like real fetch, the fake errors the body when the call's signal aborts.
    const controller = new AbortController();
    const slow = harness(() => new Response(null));
    slow.request.mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit).signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(chunk(deltas[0]!)));
            signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    setTimeout(() => controller.abort(), 30);
    await expect(
      turnContext.run({ turnId: `turn-${slow.context.accountId}` }, () =>
        slow.adapter.generate({ context: { ...slow.context, signal: controller.signal }, prompt })
      )
    ).rejects.toMatchObject({ code: "INFERENCE_CANCELLED" });
    expect(slow.events.at(-1)).toEqual({ type: "reset" });
  });
});

describe("Luna reply streaming on the Edge API's deferred model call", () => {
  it("streams the live call to the turn's watcher, then replays the recorded reply without a second call", async () => {
    const t = harness(goodStream);
    const turnId = `turn-${t.context.accountId}`;
    // The Edge pipeline: the attempt defers the call, callLive makes it outside the transaction
    // under the stream turn id the client sent (x-grogoni-turn-id), the next attempt replays it.
    const ledger = new ModelCallLedger(() => t.adapter, { streamTurnId: turnId });
    const deferred = ledger.resolver()({
      modelId: "gpt-6-luna",
      executionTarget: "backend"
    } as never)!;
    ledger.beginAttempt();
    await expect(deferred.generate({ context: t.context, prompt })).rejects.toBeInstanceOf(
      ModelCallDeferredError
    );
    expect(t.events).toEqual([]);
    await ledger.callLive();
    expect(t.preview()).toBe("Sugar is KES 120 per kg.");
    expect(t.sent()).toMatchObject({ stream: true });
    ledger.beginAttempt();
    const replayed = await deferred.generate({ context: t.context, prompt });
    expect(replayed.text).toBe(reply);
    expect(t.request).toHaveBeenCalledTimes(1);
  });
});

describe("server-sent events parsing", () => {
  const read = async (pieces: string[], maxBytes?: number) => {
    const events: unknown[] = [];
    await hostedEventStreamRequest({
      url: new URL("https://example.com/stream"),
      init: {},
      timeoutMs: 1000,
      request: async () => sse(pieces),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      onEvent: (event) => events.push(event)
    });
    return events;
  };

  it("reassembles frames split anywhere, with CRLF, comments and multi-line data", async () => {
    const whole = 'data: {"a":1}\r\n\r\n: keep-alive\n\ndata: {"b":\ndata: 2}\n\n';
    const pieces = whole.split(""); // one byte at a time
    expect(await read(pieces)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("accepts CR-only line endings, including a CR split from its LF across chunks", async () => {
    expect(await read(['data: {"a":1}\r\rdata: {"b":2}\r', "\n\r\n"])).toEqual([
      { a: 1 },
      { b: 2 }
    ]);
  });

  it("skips an empty data event instead of failing the call", async () => {
    expect(await read(["data:\n\n", frame({ a: 1 })])).toEqual([{ a: 1 }]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = encoder.encode(frame({ text: "KES 120 · bei nafuu ✓" }));
    const cut = bytes.indexOf(0xc2) + 1; // inside the two-byte "·"
    const events: unknown[] = [];
    await hostedEventStreamRequest({
      url: new URL("https://example.com/stream"),
      init: {},
      timeoutMs: 1000,
      request: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              controller.enqueue(bytes.slice(cut));
              controller.close();
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
      onEvent: (event) => events.push(event)
    });
    expect(events).toEqual([{ text: "KES 120 · bei nafuu ✓" }]);
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    expect(await read([frame({ a: 1 }), "data: [DONE]\n\n", frame({ b: 2 })])).toEqual([{ a: 1 }]);
  });

  it("delivers a last frame that has no trailing blank line", async () => {
    expect(await read(['data: {"a":1}'])).toEqual([{ a: 1 }]);
  });

  it("rejects malformed data and oversized streams", async () => {
    await expect(read(["data: {not json\n\n"])).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE"
    });
    await expect(read([frame({ text: "x".repeat(200) })], 100)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE"
    });
  });
});
