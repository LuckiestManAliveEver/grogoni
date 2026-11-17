import { ModelRuntimeError } from "./model-runtime.js";

interface HostedRequestInput {
  url: URL;
  init: RequestInit;
  timeoutMs: number;
  signal?: AbortSignal;
  request?: typeof fetch;
  maxBytes?: number;
}

/**
 * One hosted call: the caller's signal plus a timeout, no redirects or credentials, HTTP failures
 * mapped to redacted ModelRuntimeErrors, and every other failure (network, abort, timeout)
 * classified the same way for the JSON and the streaming variant.
 */
async function hostedRequest<T>(
  input: HostedRequestInput,
  consume: (reader: ReadableStreamDefaultReader<Uint8Array>, response: Response) => Promise<T>
): Promise<T> {
  input.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const response = await (input.request ?? fetch)(input.url, {
      ...input.init,
      redirect: "error",
      credentials: "omit",
      signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code =
        response.status === 429
          ? "RATE_LIMITED"
          : response.status === 402
            ? "PROVIDER_CREDITS_EXHAUSTED"
            : response.status === 401 || response.status === 403
              ? "PROVIDER_AUTH_FAILED"
              : response.status >= 500
                ? "PROVIDER_UNAVAILABLE"
                : "PROVIDER_REQUEST_REJECTED";
      throw new ModelRuntimeError(
        code,
        `Hosted runtime returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "Hosted runtime returned no body.",
        false
      );
    try {
      return await consume(reader, response);
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (input.signal?.aborted)
      throw new ModelRuntimeError("INFERENCE_CANCELLED", "Inference was cancelled.", false);
    if (timeout.aborted)
      throw new ModelRuntimeError("INFERENCE_TIMEOUT", "Hosted inference timed out.", true);
    if (error instanceof ModelRuntimeError) throw error;
    throw new ModelRuntimeError(
      "PROVIDER_UNAVAILABLE",
      "Hosted runtime could not be reached.",
      true
    );
  }
}

const tooLarge = () =>
  new ModelRuntimeError(
    "INVALID_PROVIDER_RESPONSE",
    "Hosted response exceeds the size limit.",
    false
  );

export async function hostedJsonRequest(input: HostedRequestInput): Promise<unknown> {
  return hostedRequest(input, async (reader) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > (input.maxBytes ?? 256_000)) throw tooLarge();
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "Hosted runtime returned invalid JSON.",
        false
      );
    }
  });
}

/**
 * A server-sent-events call (OpenAI-style `stream: true`): hands every `data:` payload to `onEvent`
 * as parsed JSON, in order, and resolves when the stream ends or sends `[DONE]`. Lines end in LF,
 * CRLF or CR; comment lines (OpenRouter's `: OPENROUTER PROCESSING` keep-alives), other fields
 * and empty events are skipped. A response that is not `text/event-stream`, a payload that is not
 * JSON, or a stream past maxBytes fails the call like a malformed JSON response would. Per-token
 * framing is far larger than the text, so callers size maxBytes from their output token limit.
 */
export async function hostedEventStreamRequest(
  input: HostedRequestInput & { onEvent: (event: unknown) => void }
): Promise<void> {
  return hostedRequest(input, async (reader, response) => {
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream"))
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "Hosted runtime did not stream its response.",
        true
      );
    const decoder = new TextDecoder();
    const limit = input.maxBytes ?? 2_000_000;
    let bytes = 0;
    let buffer = "";
    let data: string[] = [];
    // Returns true at [DONE].
    const dispatch = (): boolean => {
      if (data.length === 0) return false;
      const payload = data.join("\n");
      data = [];
      if (payload.trim() === "") return false;
      if (payload.trim() === "[DONE]") return true;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        throw new ModelRuntimeError(
          "INVALID_PROVIDER_RESPONSE",
          "Hosted runtime returned malformed stream data.",
          false
        );
      }
      input.onEvent(event);
      return false;
    };
    const line = (text: string): boolean => {
      if (text === "") return dispatch();
      if (text.startsWith(":")) return false;
      if (text.startsWith("data:")) data.push(text.slice(text.startsWith("data: ") ? 6 : 5));
      return false;
    };
    // Splits complete lines off the buffer; a trailing CR waits for the next chunk, which may
    // start with its LF. Each character is scanned once.
    const drain = (final: boolean): boolean => {
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character !== "\n" && character !== "\r") continue;
        if (character === "\r" && index + 1 === buffer.length && !final) break;
        const done = line(buffer.slice(start, index));
        if (character === "\r" && buffer[index + 1] === "\n") index += 1;
        start = index + 1;
        if (done) return true;
      }
      buffer = buffer.slice(start);
      return false;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw tooLarge();
      buffer += decoder.decode(value, { stream: true });
      if (drain(false)) return;
    }
    buffer += decoder.decode();
    if (drain(true)) return;
    if (buffer !== "" && line(buffer)) return;
    dispatch();
  });
}

export function hostedEndpoint(raw: string, allowPrivate = false): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Hosted endpoint cannot contain credentials, query parameters or fragments.");
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    throw new Error(
      "Hosted endpoints require HTTPS unless private-network access is explicitly enabled."
    );
  return url;
}
