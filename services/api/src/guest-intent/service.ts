import {
  guestIntentLimits,
  guestIntentPath,
  repositoryDefaultRuntimePolicy,
  type GuestIntentErrorCode,
  type GuestIntentResponse
} from "@grogoni/shared-types";
import { createOpenRouterRuntime } from "../inference/openrouter-runtime.js";
import {
  createGuestIntentClassifier,
  defaultGuestIntentModelTimeoutMs,
  maxGuestIntentModelTimeoutMs,
  type GuestIntentClassifier
} from "./classifier.js";
import {
  defaultGuestIntentRatePolicy,
  type GuestIntentLimiter,
  type GuestIntentRatePolicy
} from "./rate-limit.js";

/** Served outside the snapshot domain on the Edge (index.ts) and next to it on Node (app.ts). */
export const guestIntentRoutes: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: guestIntentPath }
];

/** Larger bodies are refused before parsing. A 500-character message is far below this. */
export const guestIntentMaxBodyBytes = 8_192;

export interface GuestIntentReply {
  status: number;
  body: GuestIntentResponse | { code: GuestIntentErrorCode; message: string };
  headers?: Record<string, string>;
}

/**
 * One line per call, counted in production logs: which intent, whether the model decided it
 * ("model") or the client will fall back to its rules ("rules"), and how long it took.
 */
export interface GuestIntentLogLine {
  event: "guest_intent_classified";
  source: "model" | "rules";
  intent: string | null;
  reason: string | null;
  latencyMs: number;
  modelId: string | null;
}

export interface GuestIntentService {
  handle(input: {
    session: { sessionId: string } | null;
    body: unknown;
  }): Promise<GuestIntentReply>;
}

export interface GuestIntentConfiguration {
  classifier: GuestIntentClassifier | null;
  /** Why there is no classifier; logged once at startup. */
  disabledReason: string | null;
  ratePolicy: GuestIntentRatePolicy;
}

function positive(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`Guest intent setting ${raw} must be a whole number from 1 to ${max}.`);
  return value;
}

/**
 * The classifier both APIs build from the environment: the platform default model
 * (PLATFORM_DEFAULT_MODEL_ID, else the repository default) through the OpenRouter runtime and its
 * server-held OPENROUTER_API_KEY. With no key, or GUEST_INTENT_ENABLED=false, there is no
 * classifier, the endpoint answers 503 at once, and guests are routed by rules.
 */
export function readGuestIntentConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): GuestIntentConfiguration {
  const ratePolicy = {
    max: positive(
      environment.GUEST_INTENT_RATE_LIMIT_PER_MINUTE,
      defaultGuestIntentRatePolicy.max,
      600
    ),
    windowMs: defaultGuestIntentRatePolicy.windowMs
  };
  // The client gives up at 5s; the model must answer before that, network included.
  const timeoutMs = positive(
    environment.GUEST_INTENT_MODEL_TIMEOUT_MS,
    defaultGuestIntentModelTimeoutMs,
    maxGuestIntentModelTimeoutMs
  );
  const disabled = (reason: string): GuestIntentConfiguration => ({
    classifier: null,
    disabledReason: reason,
    ratePolicy
  });
  if (environment.GUEST_INTENT_ENABLED?.trim() === "false")
    return disabled("GUEST_INTENT_ENABLED=false");
  if ((environment.OPENROUTER_API_KEY ?? "").trim() === "")
    return disabled("OPENROUTER_API_KEY is not set");
  const modelId =
    environment.PLATFORM_DEFAULT_MODEL_ID?.trim() || repositoryDefaultRuntimePolicy.modelId;
  const complete = createOpenRouterRuntime(environment).jsonCompletion(modelId);
  if (complete === undefined)
    return disabled(`PLATFORM_DEFAULT_MODEL_ID "${modelId}" is not mapped in OPENROUTER_MODELS`);
  return {
    classifier: createGuestIntentClassifier({ complete, modelId, timeoutMs }),
    disabledReason: null,
    ratePolicy
  };
}

const failure = (
  status: number,
  code: GuestIntentErrorCode,
  message: string
): GuestIntentReply => ({
  status,
  body: { code, message }
});

export function createGuestIntentService(input: {
  classifier: GuestIntentClassifier | null;
  limiter: GuestIntentLimiter;
  report?: (line: GuestIntentLogLine) => void;
}): GuestIntentService {
  const report = input.report ?? ((line) => console.log(JSON.stringify(line)));
  const log = (line: Omit<GuestIntentLogLine, "event">) =>
    report({ event: "guest_intent_classified", ...line });
  return {
    async handle({ session, body }) {
      if (session === null) return failure(401, "auth_required", "Authentication is required.");
      const message =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).message
          : undefined;
      if (typeof message !== "string" || message.trim() === "")
        return failure(400, "invalid_request", "Send the guest's message as { message }.");
      const rules = (reason: string, latencyMs = 0) =>
        log({
          source: "rules",
          intent: null,
          reason,
          latencyMs,
          modelId: input.classifier?.modelId ?? null
        });
      if (message.length > guestIntentLimits.maxMessageChars) {
        rules("message_too_long");
        return failure(
          413,
          "message_too_long",
          `Messages over ${guestIntentLimits.maxMessageChars} characters are not classified.`
        );
      }
      if (input.classifier === null) {
        rules("unavailable");
        return failure(503, "guest_intent_unavailable", "The classifier is not configured.");
      }
      const limit = await input.limiter.consume(session.sessionId);
      if (!limit.allowed) {
        rules("rate_limited");
        return {
          ...failure(429, "rate_limited", "Too many messages. Please slow down."),
          headers: { "retry-after": String(limit.retryAfterSeconds) }
        };
      }
      const outcome = await input.classifier.classify(message);
      if (!outcome.ok) {
        rules(outcome.reason, outcome.latencyMs);
        return failure(503, "guest_intent_failed", "The classifier could not decide.");
      }
      log({
        source: "model",
        intent: outcome.intent,
        reason: null,
        latencyMs: outcome.latencyMs,
        modelId: outcome.modelId
      });
      return {
        status: 200,
        body: {
          intent: outcome.intent,
          query: outcome.query,
          modelId: outcome.modelId,
          latencyMs: outcome.latencyMs
        }
      };
    }
  };
}

/**
 * The Edge route. Index.ts calls it before the snapshot domain routes: the session lookup is its
 * own short transaction that commits before the model call, and the call itself holds no
 * connection, no store lock and writes no snapshot.
 */
export function createEdgeGuestIntentRoutes(input: {
  service: GuestIntentService;
  findSession: (request: Request) => Promise<{ sessionId: string } | null>;
}) {
  return async (request: Request, path: string): Promise<Response | null> => {
    if (path !== guestIntentPath) return null;
    if (request.method !== "POST")
      return Response.json(
        { code: "method_not_allowed", message: "Use POST." },
        { status: 405, headers: { allow: "POST" } }
      );
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > guestIntentMaxBodyBytes)
      return Response.json(failure(413, "message_too_long", "Request too large.").body, {
        status: 413
      });
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > guestIntentMaxBodyBytes)
      return Response.json(failure(413, "message_too_long", "Request too large.").body, {
        status: 413
      });
    let body: unknown = null;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      body = null;
    }
    const session = await input.findSession(request);
    const reply = await input.service.handle({ session, body });
    return Response.json(reply.body, {
      status: reply.status,
      headers: { "cache-control": "no-store", ...reply.headers }
    });
  };
}
