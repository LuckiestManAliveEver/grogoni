import {
  HostedConnectionError,
  hostedBytesRequest,
  hostedJsonRequest
} from "../../inference/hosted-http.js";
import { ModelRuntimeError } from "../../inference/model-runtime.js";
import { voiceAudioDurationSeconds } from "./audio-duration.js";

/**
 * Speech for talking with agents: speech-to-text for dictation and text-to-speech for agent
 * replies, both through the sanctioned OpenRouter provider (OPENROUTER_API_KEY, server side only)
 * and its dedicated audio endpoints. A transcript lands in the speaker's own draft for review; it
 * is never sent or executed on its own. Every failure is a redacted ModelRuntimeError.
 */

export type VoiceAudioFormat = "webm" | "ogg" | "m4a" | "mp3" | "wav";

// 0 word errors on browser WebM/Opus in the same eval; kept from a different vendor than the
// speech model so the round-trip eval never grades a vendor's speech with its own ears.
export const defaultVoiceTranscriptionModel = "openai/gpt-4o-transcribe";
// Chosen by `pnpm eval:voice` on 2026-11-24 (docs/integrations/voice.md has the table):
// ElevenLabs v4 Turbo spoke every phrase word for word, Swahili included (90+ languages);
// Voxtral TTS 3 dropped words. OpenAI's TTS is not offered by OpenRouter.
export const defaultVoiceSpeechModel = "elevenlabs/eleven-v4-turbo";
export const defaultVoiceSpeechVoice = "sarah";
export const defaultVoiceTimeoutMs = 30_000;
/** Dictation stops itself at 60 s in the browser; the server allows some slack. */
export const voiceDictationMaxSeconds = 120;
/** About 2 minutes of 256 kbps audio; browser Opus at 60 s is about 250 KB. */
export const voiceDictationMaxBytes = 4 * 1024 * 1024;
export const voiceTranscriptMaxLength = 8000;
/** One spoken chunk; the client splits longer replies at sentence boundaries. */
export const voiceSpeechMaxCharacters = 1000;
/** 1000 characters is about 70 s of speech, about 1.1 MB of 128 kbps MP3. */
export const voiceSpeechMaxBytes = 3 * 1024 * 1024;

const audioFormats: Readonly<Record<string, VoiceAudioFormat>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav"
};

export function voiceAudioFormat(mimeType: string): VoiceAudioFormat | undefined {
  const normalized = mimeType.split(";")[0]!.trim().toLowerCase();
  return Object.hasOwn(audioFormats, normalized) ? audioFormats[normalized] : undefined;
}

export type VoiceTranscriber = (input: {
  bytes: Buffer;
  format: VoiceAudioFormat;
  language?: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; model: string }>;

export type VoiceSpeaker = (input: {
  text: string;
  signal?: AbortSignal;
}) => Promise<{ audio: Buffer; contentType: string; model: string; voice: string }>;

export interface VoiceServices {
  transcriber?: VoiceTranscriber;
  speaker?: VoiceSpeaker;
  transcriptionModel?: string;
  speechModel?: string;
}

const openRouter = "https://openrouter.ai/api/v1";
// Same-model host fallback, as chosen for chat on 2026-11-17: the request names one model, so a
// fallback only changes which host of that model answers, never the model.
const provider = { allow_fallbacks: true, sort: "latency" } as const;

/**
 * One retry when the request provably never reached OpenRouter (HostedConnectionError with
 * requestNotSent: DNS failure, refused or unreachable, connect timeout). The eval saw connects to
 * openrouter.ai stall for undici's 10 s connect timeout on 2026-11-24. Nothing was billed for that
 * attempt, so the retry cannot charge twice. Anything else (an HTTP error, a reset that may come
 * after the request was sent, a body that breaks off, a timeout or a cancellation) is not retried.
 */
async function withConnectionRetry<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof HostedConnectionError) || !error.requestNotSent || signal?.aborted)
      throw error;
    return call();
  }
}

function requireKey(apiKey: string): void {
  if (apiKey.trim() === "")
    throw new ModelRuntimeError("CREDENTIAL_MISSING", "OpenRouter is not configured.", false);
}

export function createOpenRouterVoiceTranscriber(input: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  request?: typeof fetch;
}): VoiceTranscriber {
  return async (call) => {
    requireKey(input.apiKey);
    const body = (await withConnectionRetry(
      () =>
        hostedJsonRequest({
          url: new URL(`${openRouter}/audio/transcriptions`),
          timeoutMs: input.timeoutMs ?? defaultVoiceTimeoutMs,
          maxBytes: 128_000,
          ...(call.signal ? { signal: call.signal } : {}),
          ...(input.request ? { request: input.request } : {}),
          init: {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: input.model,
              input_audio: { data: call.bytes.toString("base64"), format: call.format },
              ...(call.language ? { language: call.language } : {}),
              temperature: 0,
              provider
            })
          }
        }),
      call.signal
    )) as { text?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.text !== "string")
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "OpenRouter returned no transcript.",
        false
      );
    return { text: body.text.trim().slice(0, voiceTranscriptMaxLength), model: input.model };
  };
}

export function createOpenRouterVoiceSpeaker(input: {
  apiKey: string;
  model: string;
  voice: string;
  timeoutMs?: number;
  request?: typeof fetch;
}): VoiceSpeaker {
  return async (call) => {
    requireKey(input.apiKey);
    const { bytes, contentType } = await withConnectionRetry(
      () =>
        hostedBytesRequest({
          url: new URL(`${openRouter}/audio/speech`),
          timeoutMs: input.timeoutMs ?? defaultVoiceTimeoutMs,
          maxBytes: voiceSpeechMaxBytes,
          ...(call.signal ? { signal: call.signal } : {}),
          ...(input.request ? { request: input.request } : {}),
          init: {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: input.model,
              input: call.text,
              voice: input.voice,
              response_format: "mp3",
              provider
            })
          }
        }),
      call.signal
    );
    if (bytes.length === 0)
      throw new ModelRuntimeError(
        "INVALID_PROVIDER_RESPONSE",
        "OpenRouter returned no audio.",
        false
      );
    return {
      audio: bytes,
      contentType: contentType.startsWith("audio/") ? contentType : "audio/mpeg",
      model: input.model,
      voice: input.voice
    };
  };
}

const modelPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu;

function readTimeout(environment: NodeJS.ProcessEnv): number {
  const raw = environment.VOICE_TIMEOUT_MS?.trim();
  const timeoutMs = raw ? Number(raw) : defaultVoiceTimeoutMs;
  // At most 35 s: the web client gives up at 45 s, and a connect-failure retry adds up to 10 s.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 35_000)
    throw new Error("VOICE_TIMEOUT_MS must be an integer between 1000 and 35000.");
  return timeoutMs;
}

/**
 * The voice services this host may offer. Without OPENROUTER_API_KEY there are none; a model set
 * to `off` turns that direction off. Invalid configuration throws so the Node API stops at startup
 * (the Edge API logs it and answers voice_unavailable).
 */
export function createVoiceServices(
  environment: NodeJS.ProcessEnv = process.env,
  request?: typeof fetch
): VoiceServices {
  const apiKey = environment.OPENROUTER_API_KEY?.trim() ?? "";
  if (!apiKey) return {};
  const timeoutMs = readTimeout(environment);
  const transcriptionModel =
    environment.VOICE_TRANSCRIPTION_MODEL?.trim() || defaultVoiceTranscriptionModel;
  const speechModel = environment.VOICE_SPEECH_MODEL?.trim() || defaultVoiceSpeechModel;
  const voice = environment.VOICE_SPEECH_VOICE?.trim() || defaultVoiceSpeechVoice;
  if (transcriptionModel !== "off" && !modelPattern.test(transcriptionModel))
    throw new Error("VOICE_TRANSCRIPTION_MODEL must be an OpenRouter model id or off.");
  if (speechModel !== "off" && !modelPattern.test(speechModel))
    throw new Error("VOICE_SPEECH_MODEL must be an OpenRouter model id or off.");
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(voice))
    throw new Error("VOICE_SPEECH_VOICE must be a provider voice id.");
  const shared = { apiKey, timeoutMs, ...(request ? { request } : {}) };
  return {
    ...(transcriptionModel === "off"
      ? {}
      : {
          transcriber: createOpenRouterVoiceTranscriber({ ...shared, model: transcriptionModel }),
          transcriptionModel
        }),
    ...(speechModel === "off"
      ? {}
      : {
          speaker: createOpenRouterVoiceSpeaker({ ...shared, model: speechModel, voice }),
          speechModel
        })
  };
}

export class VoiceRequestError extends Error {
  constructor(
    readonly code:
      | "voice_audio_invalid"
      | "voice_audio_unsupported"
      | "voice_audio_too_large"
      | "voice_audio_too_long"
      | "voice_text_invalid"
      | "voice_text_too_long",
    message: string
  ) {
    super(message);
    this.name = "VoiceRequestError";
  }
}

const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Validates a dictation upload: `{ audioBase64, contentType, language? }`. */
export function parseTranscriptionRequest(body: unknown): {
  bytes: Buffer;
  format: VoiceAudioFormat;
  language?: string;
} {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const audio = record.audioBase64;
  const contentType = record.contentType;
  if (typeof audio !== "string" || audio.length === 0 || typeof contentType !== "string")
    throw new VoiceRequestError("voice_audio_invalid", "Send the recording as base64 audio.");
  const format = voiceAudioFormat(contentType);
  if (!format)
    throw new VoiceRequestError(
      "voice_audio_unsupported",
      "This recording format is not supported. Use WebM, Ogg, MP4, MP3 or WAV audio."
    );
  if (audio.length > Math.ceil((voiceDictationMaxBytes * 4) / 3) + 4)
    throw new VoiceRequestError("voice_audio_too_large", "The recording is too large.");
  if (audio.length % 4 !== 0 || !base64Pattern.test(audio))
    throw new VoiceRequestError("voice_audio_invalid", "The recording is not valid base64.");
  const bytes = Buffer.from(audio, "base64");
  if (bytes.length === 0)
    throw new VoiceRequestError("voice_audio_invalid", "The recording is empty.");
  if (bytes.length > voiceDictationMaxBytes)
    throw new VoiceRequestError("voice_audio_too_large", "The recording is too large.");
  {
    const seconds = voiceAudioDurationSeconds(bytes, format);
    if (seconds !== null && seconds > voiceDictationMaxSeconds)
      throw new VoiceRequestError(
        "voice_audio_too_long",
        `Recordings over ${voiceDictationMaxSeconds / 60} minutes cannot be transcribed.`
      );
  }
  const language = record.language;
  if (language !== undefined && language !== null && language !== "") {
    if (typeof language !== "string" || !/^[a-z]{2}$/u.test(language.trim().toLowerCase()))
      throw new VoiceRequestError(
        "voice_audio_invalid",
        "language must be a two-letter code such as en or sw."
      );
    return { bytes, format, language: language.trim().toLowerCase() };
  }
  return { bytes, format };
}

/** Validates a read-aloud request: `{ text }`, 1 to voiceSpeechMaxCharacters characters. */
export function parseSpeechRequest(body: unknown): { text: string } {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new VoiceRequestError("voice_text_invalid", "There is no text to read aloud.");
  if (text.length > voiceSpeechMaxCharacters)
    throw new VoiceRequestError(
      "voice_text_too_long",
      `Read aloud at most ${voiceSpeechMaxCharacters} characters at a time.`
    );
  return { text };
}
