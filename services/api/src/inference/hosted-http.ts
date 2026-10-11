import { ModelRuntimeError } from "./model-runtime.js";

export async function hostedJsonRequest(input: {
  url: URL;
  init: RequestInit;
  timeoutMs: number;
  signal?: AbortSignal;
  request?: typeof fetch;
  maxBytes?: number;
}): Promise<unknown> {
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
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > (input.maxBytes ?? 256_000)) {
        await reader.cancel();
        throw new ModelRuntimeError(
          "INVALID_PROVIDER_RESPONSE",
          "Hosted response exceeds the size limit.",
          false
        );
      }
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
