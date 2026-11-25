import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ModelRuntimeError } from "../../inference/model-runtime.js";
import { Cp2Error } from "../cp2-error.js";
import { sendCp2Error } from "../route-helpers.js";
import { readSessionCookie, type Cp2Store } from "../store.js";
import {
  parseSpeechRequest,
  parseTranscriptionRequest,
  voiceDictationMaxBytes,
  VoiceRequestError,
  type VoiceServices
} from "./voice-speech.js";

/**
 * Per-account sliding window, in this process; the routes carry no per-IP rateLimit config, so
 * people sharing one shop Wi-Fi or carrier NAT are not limited together. Fastify's rateLimit only exists where
 * @fastify/rate-limit is registered (the Node API), and the Edge per-IP limiter allows 300/min,
 * so the handlers count calls per account themselves. Edge isolates each keep their own count;
 * a durable daily quota is voicecom P3.4.
 */
export function createVoiceRateLimiter(input: {
  max: number;
  windowMs: number;
  now?: () => number;
  maxAccounts?: number;
}) {
  const calls = new Map<string, number[]>();
  const now = input.now ?? Date.now;
  return (accountId: string): boolean => {
    const at = now();
    const recent = (calls.get(accountId) ?? []).filter((time) => at - time < input.windowMs);
    const allowed = recent.length < input.max;
    if (allowed) recent.push(at);
    // Re-insert on every call, limited or not: the most recently seen accounts are the last to be
    // evicted, so a flood of other accounts cannot reset a limited account's count.
    calls.delete(accountId);
    calls.set(accountId, recent);
    // Oldest-touched accounts go first, so a flood of accounts cannot grow memory without bound.
    while (calls.size > (input.maxAccounts ?? 10_000)) calls.delete(calls.keys().next().value!);
    return allowed;
  };
}

export const voiceTranscribePath = "/v1/voice/transcribe";
export const voiceSpeakPath = "/v1/voice/speak";
export const guestVoiceTranscribePath = "/public/storefronts/:agentId/voice/transcribe";
export const guestVoiceSpeakPath = "/public/storefronts/:agentId/voice/speak";
/** Matches the two guest voice paths with any storefront id. */
export const guestVoicePathPattern = /^\/public\/storefronts\/[^/]+\/voice\/(?:transcribe|speak)$/u;

type VoiceTrace = (
  request: FastifyRequest,
  level: "info" | "warn",
  line: Record<string, unknown>
) => void;
type VoiceLimits = { transcribe: (key: string) => boolean; speak: (key: string) => boolean };

/**
 * POST /v1/voice/transcribe -> { text, model } and POST /v1/voice/speak -> { audioBase64,
 * contentType, model, voice }. Signed-in accounts only. Both answer 503 voice_unavailable when this
 * host has no speech service, which the web client takes as "use the browser's own speech".
 * One trace line per call: route, model, sizes and duration; never audio, text or account.
 */
export function registerVoiceRoutes(
  app: FastifyInstance,
  options: {
    store?: Pick<Cp2Store, "getSession"> | null;
    authenticate?: (request: FastifyRequest) => Promise<{ accountId: string } | null>;
    services: () => VoiceServices;
    limits?: VoiceLimits;
    /**
     * Where the per-call trace line goes. Default: the request logger. The Edge app runs Fastify
     * with logging off, so it passes a JSON console line.
     */
    trace?: VoiceTrace;
  }
): void {
  registerVoicePair(app, {
    transcribePath: voiceTranscribePath,
    speakPath: voiceSpeakPath,
    audience: "account",
    identify: async (request) =>
      options.authenticate
        ? ((await options.authenticate(request))?.accountId ?? null)
        : (options.store?.getSession(readSessionCookie(request.headers.cookie))?.account.id ??
          null),
    unauthorized: () => new Cp2Error(401, "auth_required", "Authentication is required."),
    limits: options.limits ?? {
      transcribe: createVoiceRateLimiter({ max: 20, windowMs: 60_000 }),
      // A long reply is several speech calls (900 characters each).
      speak: createVoiceRateLimiter({ max: 40, windowMs: 60_000 })
    },
    services: options.services,
    ...(options.trace ? { trace: options.trace } : {})
  });
}

/**
 * The same two calls for signed-out storefront guests (voicecom P2.4):
 * POST /public/storefronts/:agentId/voice/transcribe and .../speak, each with the guest's
 * `capabilityToken` in the body. A guest needs a valid, unexpired, unrevoked storefront capability,
 * and each capability gets 5 transcriptions and 10 speech calls a minute (stricter than accounts).
 * The transcript or audio goes back only to the caller and touches no shop data, so the storefront
 * id in the path is not a trust boundary.
 */
export function registerGuestVoiceRoutes(
  app: FastifyInstance,
  options: {
    /** The capability's id for a valid token, else null. Must hold no lock after it returns. */
    verifyGuest: (capabilityToken: string) => Promise<string | null>;
    services: () => VoiceServices;
    limits?: VoiceLimits;
    trace?: VoiceTrace;
  }
): void {
  registerVoicePair(app, {
    transcribePath: guestVoiceTranscribePath,
    speakPath: guestVoiceSpeakPath,
    audience: "guest",
    identify: async (request) => {
      const token = (request.body as { capabilityToken?: unknown } | null)?.capabilityToken;
      if (typeof token !== "string" || token.length === 0 || token.length > 200) return null;
      return options.verifyGuest(token);
    },
    unauthorized: () =>
      new Cp2Error(401, "customer_capability_invalid", "Customer session is invalid."),
    limits: options.limits ?? {
      transcribe: createVoiceRateLimiter({ max: 5, windowMs: 60_000 }),
      speak: createVoiceRateLimiter({ max: 10, windowMs: 60_000 })
    },
    services: options.services,
    ...(options.trace ? { trace: options.trace } : {})
  });
}

function registerVoicePair(
  app: FastifyInstance,
  options: {
    transcribePath: string;
    speakPath: string;
    audience: "account" | "guest";
    identify: (request: FastifyRequest) => Promise<string | null>;
    unauthorized: () => Cp2Error;
    limits: VoiceLimits;
    services: () => VoiceServices;
    trace?: VoiceTrace;
  }
): void {
  const trace: VoiceTrace =
    options.trace ?? ((request, level, line) => request.log[level](line, String(line.event)));
  /** Aborts the provider call when the client goes away before the answer is sent. */
  const disconnectSignal = (reply: FastifyReply): AbortSignal => {
    const controller = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return controller.signal;
  };
  const admit = async (request: FastifyRequest, allow: (key: string) => boolean): Promise<void> => {
    const key = await options.identify(request);
    if (!key) throw options.unauthorized();
    if (!allow(key))
      throw new Cp2Error(
        429,
        "voice_rate_limited",
        "Too many voice requests. Wait a minute and try again.",
        true
      );
  };
  const unavailable = () =>
    new Cp2Error(503, "voice_unavailable", "Voice is not available on this server.", false);
  const fail = (reply: FastifyReply, error: unknown, action: string) => {
    if (error instanceof VoiceRequestError)
      return sendCp2Error(reply, new Cp2Error(400, error.code, error.message, false));
    if (error instanceof ModelRuntimeError)
      return sendCp2Error(
        reply,
        new Cp2Error(
          error.code === "CREDENTIAL_MISSING" ? 503 : 502,
          error.code === "CREDENTIAL_MISSING" ? "voice_unavailable" : "voice_provider_failed",
          `Voice could not ${action} right now. Please try again.`,
          error.retryable
        )
      );
    return sendCp2Error(reply, error);
  };
  const audience = options.audience;

  app.post(
    options.transcribePath,
    {
      // base64 of the largest recording plus the JSON envelope.
      bodyLimit: Math.ceil((voiceDictationMaxBytes * 4) / 3) + 16_384
    },
    async (request, reply) => {
      const started = Date.now();
      try {
        await admit(request, options.limits.transcribe);
        const { transcriber, transcriptionModel } = options.services();
        if (!transcriber) throw unavailable();
        const audio = parseTranscriptionRequest(request.body);
        const result = await transcriber({ ...audio, signal: disconnectSignal(reply) });
        trace(request, "info", {
          event: "voice.transcribed",
          audience,
          model: transcriptionModel,
          format: audio.format,
          audioBytes: audio.bytes.length,
          transcriptChars: result.text.length,
          ms: Date.now() - started
        });
        reply.header("cache-control", "no-store");
        return { text: result.text, model: result.model };
      } catch (error) {
        trace(request, "warn", {
          event: "voice.transcribe_failed",
          audience,
          code: errorCode(error),
          ms: Date.now() - started
        });
        return fail(reply, error, "transcribe this recording");
      }
    }
  );

  app.post(options.speakPath, { bodyLimit: 16_384 }, async (request, reply) => {
    const started = Date.now();
    try {
      await admit(request, options.limits.speak);
      const { speaker, speechModel } = options.services();
      if (!speaker) throw unavailable();
      const { text } = parseSpeechRequest(request.body);
      const result = await speaker({ text, signal: disconnectSignal(reply) });
      trace(request, "info", {
        event: "voice.spoken",
        audience,
        model: speechModel,
        textChars: text.length,
        audioBytes: result.audio.length,
        ms: Date.now() - started
      });
      reply.header("cache-control", "no-store");
      return {
        audioBase64: result.audio.toString("base64"),
        contentType: result.contentType,
        model: result.model,
        voice: result.voice
      };
    } catch (error) {
      trace(request, "warn", {
        event: "voice.speak_failed",
        audience,
        code: errorCode(error),
        ms: Date.now() - started
      });
      return fail(reply, error, "read this aloud");
    }
  });
}

function errorCode(error: unknown): string {
  if (error instanceof VoiceRequestError || error instanceof ModelRuntimeError) return error.code;
  if (error instanceof Cp2Error) return error.code;
  return "unexpected";
}
