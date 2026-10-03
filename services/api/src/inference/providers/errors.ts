import { ModelRuntimeError } from "../model-runtime.js";
import { redactSecrets } from "./redaction.js";

/**
 * Normalized provider-layer failure codes. Every adapter maps its vendor's HTTP status/body onto
 * one of these; the vendor's own error body is kept only as a redacted, internal `diagnostic`.
 * Each code is also registered in @grogoni/shared-types' normalizeInferenceErrorCode map so
 * telemetry/UI categorize it the same way as the pre-existing runtime codes.
 */
export type InferenceErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_MISCONFIGURED"
  | "MODEL_UNAVAILABLE"
  | "INVALID_CREDENTIAL"
  | "CREDENTIAL_MISSING"
  | "RATE_LIMITED"
  | "CONTEXT_TOO_LARGE"
  | "REQUEST_TIMEOUT"
  | "REQUEST_CANCELLED"
  | "CAPABILITY_UNSUPPORTED"
  | "BUDGET_EXCEEDED"
  | "CONTENT_REJECTED"
  | "INFERENCE_FAILED"
  | "ENDPOINT_FORBIDDEN"
  | "LOCAL_EXECUTION_REQUIRED"
  | "LOCAL_DEVICE_UNAVAILABLE"
  | "INVALID_PROVIDER_RESPONSE";

const retryableCodes: ReadonlySet<InferenceErrorCode> = new Set([
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "REQUEST_TIMEOUT",
  "INFERENCE_FAILED",
  "INVALID_PROVIDER_RESPONSE",
  // Retryable only in the sense that an *explicit* fallback policy may move on; the device-local
  // provider is never behind a circuit breaker (availability is per account, not per provider).
  "LOCAL_DEVICE_UNAVAILABLE"
]);

const safeMessages: Record<InferenceErrorCode, string> = {
  PROVIDER_UNAVAILABLE: "The model provider is temporarily unavailable.",
  PROVIDER_MISCONFIGURED: "This model provider is not configured correctly.",
  MODEL_UNAVAILABLE: "The selected model is not available.",
  INVALID_CREDENTIAL: "The provider rejected the configured API key.",
  CREDENTIAL_MISSING: "No API key is connected for this model provider.",
  RATE_LIMITED: "The model provider is rate limiting requests. Please retry shortly.",
  CONTEXT_TOO_LARGE: "This conversation is too long for the selected model.",
  REQUEST_TIMEOUT: "The model took too long to respond.",
  REQUEST_CANCELLED: "The request was cancelled.",
  CAPABILITY_UNSUPPORTED: "The selected model does not support this request.",
  BUDGET_EXCEEDED: "The inference budget for this period has been reached.",
  CONTENT_REJECTED: "The model provider declined this request.",
  INFERENCE_FAILED: "The model could not complete this request.",
  ENDPOINT_FORBIDDEN: "This provider endpoint is not allowed.",
  LOCAL_EXECUTION_REQUIRED: "This model runs on your device and cannot be run by the server.",
  LOCAL_DEVICE_UNAVAILABLE:
    "No device with this on-device model is online. Open Grogoni on a device where the model is installed.",
  INVALID_PROVIDER_RESPONSE: "The model provider returned an unexpected response."
};

export interface InferenceErrorDetails {
  providerId?: string;
  modelId?: string;
  status?: number;
  retryAfterMs?: number;
  /**
   * Internal diagnostics only (already redacted). Never serialized by toJSON() and never placed in
   * an HTTP error payload - Cp2Error/sendCp2Error only ever see `code` and the safe `message`.
   */
  diagnostic?: string;
  cause?: unknown;
}

/**
 * Extends ModelRuntimeError so the existing chat pipeline (asModelRuntimeError,
 * runtimeProviderFromAdapter, isRetryableInferenceCategory) already understands it without any
 * change - `code` and `retryable` flow through unchanged.
 */
export class InferenceError extends ModelRuntimeError {
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly diagnostic: string | undefined;

  constructor(
    readonly inferenceCode: InferenceErrorCode,
    details: InferenceErrorDetails = {},
    message: string = safeMessages[inferenceCode]
  ) {
    super(
      inferenceCode,
      message,
      retryableCodes.has(inferenceCode),
      details.cause === undefined ? undefined : { cause: details.cause }
    );
    this.name = "InferenceError";
    this.providerId = details.providerId;
    this.modelId = details.modelId;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.diagnostic = details.diagnostic;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.providerId === undefined ? {} : { providerId: this.providerId }),
      ...(this.modelId === undefined ? {} : { modelId: this.modelId }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs })
    };
  }
}

export function isInferenceError(error: unknown): error is InferenceError {
  return error instanceof InferenceError;
}

/**
 * Maps an HTTP failure from any provider onto a normalized error. `bodyText` is the raw response
 * body; it is redacted against `secrets` and truncated before it is kept as a diagnostic, and it
 * never becomes the user-facing message.
 */
export function inferenceErrorFromHttp(input: {
  providerId: string;
  modelId?: string;
  status: number;
  bodyText: string;
  retryAfterHeader?: string | null;
  secrets: readonly string[];
}): InferenceError {
  const body = input.bodyText.toLowerCase();
  const code: InferenceErrorCode =
    input.status === 401 || input.status === 403
      ? "INVALID_CREDENTIAL"
      : input.status === 429
        ? body.includes("quota") || body.includes("billing") || body.includes("insufficient")
          ? "BUDGET_EXCEEDED"
          : "RATE_LIMITED"
        : input.status === 404
          ? "MODEL_UNAVAILABLE"
          : input.status === 408 || input.status === 504
            ? "REQUEST_TIMEOUT"
            : input.status === 413 ||
                body.includes("context_length") ||
                body.includes("context length") ||
                body.includes("maximum context") ||
                body.includes("too many tokens") ||
                body.includes("prompt is too long")
              ? "CONTEXT_TOO_LARGE"
              : body.includes("content_filter") ||
                  body.includes("content policy") ||
                  body.includes("safety")
                ? "CONTENT_REJECTED"
                : input.status >= 500
                  ? "PROVIDER_UNAVAILABLE"
                  : "INFERENCE_FAILED";
  return new InferenceError(code, {
    providerId: input.providerId,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    status: input.status,
    ...(parseRetryAfter(input.retryAfterHeader) === undefined
      ? {}
      : { retryAfterMs: parseRetryAfter(input.retryAfterHeader) as number }),
    diagnostic: redactSecrets(input.bodyText, input.secrets).slice(0, 2_000)
  });
}

/** Normalizes anything thrown during a provider call (network errors, aborts, bugs). */
export function toInferenceError(
  error: unknown,
  context: { providerId: string; modelId?: string; secrets: readonly string[]; timedOut?: boolean }
): InferenceError {
  if (error instanceof InferenceError) return error;
  const base = {
    providerId: context.providerId,
    ...(context.modelId === undefined ? {} : { modelId: context.modelId })
  };
  const rawMessage = error instanceof Error ? error.message : String(error);
  const diagnostic = redactSecrets(rawMessage, context.secrets).slice(0, 500);
  if (context.timedOut === true) {
    return new InferenceError("REQUEST_TIMEOUT", { ...base, diagnostic });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new InferenceError("REQUEST_CANCELLED", { ...base, diagnostic });
  }
  if (error instanceof ModelRuntimeError) {
    // A pre-existing runtime error (e.g. bulkhead/circuit breaker). Keep its code; it already
    // carries a safe message.
    return new InferenceError(
      error.retryable ? "PROVIDER_UNAVAILABLE" : "INFERENCE_FAILED",
      { ...base, diagnostic: `${error.code}: ${diagnostic}` },
      error.message
    );
  }
  return new InferenceError("PROVIDER_UNAVAILABLE", { ...base, diagnostic });
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), 600_000));
}

export function healthStatusForError(
  error: InferenceError
): "UNAVAILABLE" | "MISCONFIGURED" | "RATE_LIMITED" | "CREDENTIAL_INVALID" {
  switch (error.inferenceCode) {
    case "INVALID_CREDENTIAL":
    case "CREDENTIAL_MISSING":
      return "CREDENTIAL_INVALID";
    case "RATE_LIMITED":
    case "BUDGET_EXCEEDED":
      return "RATE_LIMITED";
    case "PROVIDER_MISCONFIGURED":
    case "ENDPOINT_FORBIDDEN":
      return "MISCONFIGURED";
    default:
      return "UNAVAILABLE";
  }
}
