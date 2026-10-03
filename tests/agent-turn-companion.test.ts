// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { startAgentTurnCompanion } from "../apps/web/src/inference/agent-turn-companion";

function sse(events: unknown[]): Response {
  return new Response(
    [": connected\n\n", ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`)].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("agent turn companion", () => {
  it("previews streamed reply text and honours resets", async () => {
    const previews: string[] = [];
    const companion = startAgentTurnCompanion({
      baseUrl: "https://api.test",
      installedModels: () => [],
      fetchImpl: (async () =>
        sse([
          { type: "text", text: "Hel" },
          { type: "reset" },
          { type: "text", text: "Hello" },
          { type: "text", text: " there" }
        ])) as typeof fetch,
      onPreview: (text) => previews.push(text)
    });
    await settle();
    companion.stop();
    expect(companion.headers["x-grogoni-turn-id"]).toBe(companion.turnId);
    expect(previews.at(-1)).toBe("Hello there");
    expect(previews).toContain("");
  });

  it("claims this turn's on-device job, previews its tokens, and returns only the model output", async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    let claims = 0;
    const previews: string[] = [];
    const companion = startAgentTurnCompanion({
      baseUrl: "https://api.test",
      installedModels: () => ["Qwen2.5-0.5B-Instruct-q4f16_1-MLC"],
      deviceSupported: () => true,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/turn-stream/")) return sse([]);
        if (url.includes("/jobs/next")) {
          claims += 1;
          expect(url).toContain("models=Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
          expect(url).toContain(`turnId=`);
          if (claims > 1) return new Response(null, { status: 204 });
          return new Response(
            JSON.stringify({
              job: {
                id: "job-1",
                token: "one-time-token",
                turnId: "t",
                modelId: "qwen2.5-0.5b-device",
                providerModelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
                executionTarget: "browser-local",
                messages: [{ role: "user", content: "hi" }],
                generation: { maxOutputTokens: 64, temperature: 0.2, jsonOutput: true },
                expiresAt: new Date().toISOString()
              }
            }),
            { status: 200 }
          );
        }
        posted.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }) as typeof fetch,
      generate: async (_job, onDelta) => {
        for (const piece of ['{"type":"response",', '"message":"Karibu', '!"}']) onDelta(piece);
        return {
          text: '{"type":"response","message":"Karibu!"}',
          usage: { inputTokens: 5, outputTokens: 3 },
          latencyMs: 40
        };
      },
      onPreview: (text) => previews.push(text)
    });
    await settle();
    companion.stop();
    expect(previews.at(-1)).toBe("Karibu!");
    expect(posted).toEqual([
      {
        url: "https://api.test/v1/ai/device-inference/jobs/job-1/result",
        body: {
          token: "one-time-token",
          text: '{"type":"response","message":"Karibu!"}',
          usage: { inputTokens: 5, outputTokens: 3 },
          latencyMs: 40
        }
      }
    ]);
  });

  it("reports a device failure instead of returning partial output", async () => {
    const posted: string[] = [];
    let claimed = false;
    const companion = startAgentTurnCompanion({
      baseUrl: "https://api.test",
      installedModels: () => ["m"],
      deviceSupported: () => true,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/turn-stream/")) return sse([]);
        if (url.includes("/jobs/next")) {
          if (claimed) return new Response(null, { status: 204 });
          claimed = true;
          return new Response(
            JSON.stringify({
              job: {
                id: "job-2",
                token: "tok",
                providerModelId: "m",
                messages: [],
                generation: { maxOutputTokens: 1, temperature: 0, jsonOutput: false }
              }
            }),
            { status: 200 }
          );
        }
        posted.push(url);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      generate: async () => {
        throw new Error("GPU lost");
      },
      onPreview: () => undefined
    });
    await settle();
    companion.stop();
    expect(posted).toEqual(["https://api.test/v1/ai/device-inference/jobs/job-2/failure"]);
  });

  it("never claims device jobs on a device without on-device models", async () => {
    const urls: string[] = [];
    const companion = startAgentTurnCompanion({
      baseUrl: "https://api.test",
      installedModels: () => [],
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return sse([]);
      }) as typeof fetch,
      onPreview: () => undefined
    });
    await settle();
    companion.stop();
    expect(urls.every((url) => url.includes("/turn-stream/"))).toBe(true);
  });
});
