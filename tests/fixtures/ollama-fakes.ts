import { vi } from "vitest";

/**
 * A fetch fake for the Ollama HTTP API (GET /api/tags, POST /api/chat with stream: true), shaped
 * like the real server: chat answers newline-delimited JSON chunks ending with a `done` chunk that
 * carries token counts. Every request is recorded on the returned mock.
 */
export function ollamaFetch(
  options: {
    /** Model names /api/tags reports as installed. */
    installed?: string[];
    /** Text pieces streamed by /api/chat, in order. */
    chunks?: string[];
    /** Non-2xx status for /api/chat, with an Ollama-style `{ error }` body. */
    chatStatus?: number;
    usage?: { promptTokens: number; completionTokens: number };
  } = {}
) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/api/tags") {
      return new Response(
        JSON.stringify({ models: (options.installed ?? []).map((name) => ({ name })) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.pathname === "/api/chat") {
      if (options.chatStatus !== undefined) {
        return new Response(JSON.stringify({ error: "model failed to load" }), {
          status: options.chatStatus
        });
      }
      const usage = options.usage ?? { promptTokens: 7, completionTokens: 3 };
      const lines = [
        ...(options.chunks ?? []).map((content) =>
          JSON.stringify({ message: { role: "assistant", content }, done: false })
        ),
        JSON.stringify({
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: usage.promptTokens,
          eval_count: usage.completionTokens
        })
      ];
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
            controller.close();
          }
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    }
    void init;
    return new Response("not found", { status: 404 });
  });
}
