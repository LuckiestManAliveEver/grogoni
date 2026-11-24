/**
 * Talking with agents: dictation (speech-to-text) and read-aloud (text-to-speech) through the
 * server's OpenRouter speech endpoints (services/api/src/cp2/voice/), with the browser's own speech
 * as the fallback when the server has no speech service. Kept free of React so the chunking,
 * fallback choice and playback queue can be tested directly.
 */

import { apiFetch, ApiRequestError } from "../lib/api";
import { dataUrlToBlob } from "./voice-note";

/** Dictation stops itself here; the server accepts up to two minutes. */
export const dictationMaxMs = 60_000;
/** Below the server's 1000-character limit, so trimming or a long word never pushes it over. */
export const speechChunkMaxCharacters = 900;
/** Browser speech parts stay short: Chrome drops onend on utterances over about 15 s. */
export const localSpeechMaxCharacters = 200;

const entities: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " "
};
/** A link target, with one level of balanced parentheses ("https://x/a_(b)"). */
const linkTarget = String.raw`\((?:[^()\s]|\([^()\s]*\))*\)`;

/**
 * Reply text as it should be spoken: no code blocks, markdown markers, link targets, bare URLs or
 * HTML entities. Underscores and asterisks inside words (stock_level, 2*3) stay. Deterministic so
 * a reply always sounds the same.
 */
export function speakableText(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/```[\s\S]*$/u, " ")
      .replace(/`([^`\n]*)`/gu, "$1")
      .replace(/`/gu, "")
      .replace(new RegExp(String.raw`!\[([^\]]*)\]${linkTarget}`, "gu"), "$1")
      .replace(new RegExp(String.raw`\[([^\]]+)\]${linkTarget}`, "gu"), "$1")
      .replace(/https?:\/\/\S+/gu, " ")
      // HTML tags before entities, so "&lt;5kg&gt;" still reads as "<5kg>".
      .replace(/<\/?[a-z][^<>]*>/giu, " ")
      .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gu, (entity) => entities[entity]!)
      .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});/giu, (entity, code: string) => {
        const point =
          code[0] === "x" || code[0] === "X" ? parseInt(code.slice(1), 16) : Number(code);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
      })
      // Table separator rows ("| --- | :---: |") say nothing.
      .replace(/^[\s|:-]*-{3,}[\s|:-]*$/gmu, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
      .replace(/^\s*[-*+]\s+/gmu, "")
      .replace(/^\s*>\s?/gmu, "")
      // ** and ~~ also work inside words ("**bold**text"); _, __ and * only at word edges, so
      // stock_level and 2*3 stay.
      .replace(/(\*\*|~~)(?=\S)([\s\S]*?\S)\1/gu, "$2")
      .replace(/(?<![\p{L}\p{N}])(__|\*|_)(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/gu, "$2")
      // Stray markers that never pair up are not read out ("**", "~~", a lone "*" between spaces).
      .replace(/\*{2,}|~~|(?<![\p{L}\p{N}])\*(?![\p{L}\p{N}])/gu, " ")
      .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
      .replace(/\|/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

const speakable = /[\p{L}\p{N}]/u;

/**
 * Splits speakable text into chunks of at most `max` characters, at sentence ends where it can,
 * then at commas or spaces, and as a last resort mid-word (never inside a surrogate pair). A
 * piece with nothing to say (only punctuation) joins its neighbour or is dropped, so no request
 * is spent on silence. Words are never dropped or repeated.
 */
export function splitForSpeech(text: string, max = speechChunkMaxCharacters): string[] {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean) return [];
  // A sentence ends at . ! ? … (and closing quotes or brackets) followed by a space, so
  // "KES 1,250.50", "2.5 kg" and "grogoni.com" stay whole.
  const sentences = clean.split(/(?<=[.!?…]["')\]]*)\s+/u);
  const pieces: string[] = [];
  for (const sentence of sentences.map((part) => part.trim()).filter(Boolean)) {
    if (sentence.length <= max) pieces.push(sentence);
    else pieces.push(...hardSplit(sentence, max));
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current = `${current} ${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => speakable.test(chunk));
}

function hardSplit(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
    cut = cut > max / 2 ? cut + 1 : window.lastIndexOf(" ");
    // A cut that leaves nothing speakable before it, or nothing at all, falls back to max.
    if (cut <= 0 || !speakable.test(rest.slice(0, cut))) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  // Punctuation left on its own (", " after a mid-word cut) rides on the piece before it.
  const merged: string[] = [];
  for (const piece of out) {
    const previous = merged.at(-1);
    if (!speakable.test(piece) && previous !== undefined && previous.length + piece.length <= max)
      merged[merged.length - 1] = previous + piece;
    else merged.push(piece);
  }
  return merged;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export type VoicePost = <T>(
  path: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs: number }
) => Promise<T>;

/** The app's API client for speech calls: skips the one-at-a-time queue (the person is waiting). */
export const postVoice: VoicePost = (path, body, options) =>
  apiFetch(path, { method: "POST", body, urgent: true, ...options });

/** Whether the server's speech service answered voice_unavailable during this page's life. */
const serverVoice = { transcribe: true, speak: true };

/** Test hook: forget which server speech services were found unavailable. */
export function resetServerVoiceAvailability(): void {
  serverVoice.transcribe = true;
  serverVoice.speak = true;
}

export function serverTranscriptionAvailable(): boolean {
  return serverVoice.transcribe;
}

export class DictationError extends Error {
  constructor(
    readonly reason: "unavailable" | "offline" | "too_long" | "failed" | "empty",
    message: string
  ) {
    super(message);
    this.name = "DictationError";
  }
}

/** Sends one recording to the server; resolves the transcript or throws a DictationError. */
export async function transcribeRecording(
  post: VoicePost,
  file: Blob,
  options: { language?: string; signal?: AbortSignal; online?: boolean } = {}
): Promise<string> {
  if (options.online === false)
    throw new DictationError("offline", "You are offline. Voice typing needs a connection.");
  let result: { text?: unknown };
  try {
    result = await post<{ text?: unknown }>(
      "/v1/voice/transcribe",
      {
        audioBase64: await blobToBase64(file),
        contentType: file.type || "audio/webm",
        ...(options.language ? { language: options.language } : {})
      },
      { timeoutMs: 45_000, ...(options.signal ? { signal: options.signal } : {}) }
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "voice_unavailable") {
      serverVoice.transcribe = false;
      throw new DictationError(
        "unavailable",
        "Voice typing is not available on this server. Tap the microphone again to use this browser's speech recognition."
      );
    }
    if (error instanceof ApiRequestError && error.code === "voice_audio_too_long")
      throw new DictationError("too_long", error.message);
    throw new DictationError(
      "failed",
      "Your recording could not be turned into text. Please try again."
    );
  }
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text) throw new DictationError("empty", "No speech was heard. Please try again.");
  return text;
}

export interface AudioLike {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface SpeechEnvironment {
  post: VoicePost;
  createAudio: () => AudioLike;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  /** The browser's own speech synthesis, when it has one. */
  synthesis: {
    /** onEnd(true) when spoken, onEnd(false) on any error, including a cancel. */
    speak: (text: string, onEnd: (ok: boolean) => void) => void;
    cancel: () => void;
    /** Called inside the tap: iOS only speaks later if speech first started in a gesture. */
    prime: () => void;
  } | null;
}

export function browserSpeechEnvironment(post: VoicePost): SpeechEnvironment {
  const synth = globalThis.speechSynthesis;
  const Utterance = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
    .SpeechSynthesisUtterance;
  return {
    post,
    createAudio: () => new Audio() as unknown as AudioLike,
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    // Presence, not getVoices(): Chrome lists no voices until voiceschanged, yet speaks with
    // its default voice.
    synthesis:
      synth && Utterance
        ? {
            speak: (text, onEnd) => {
              const utterance = new Utterance(text);
              utterance.lang = globalThis.navigator?.language || "en";
              utterance.onend = () => onEnd(true);
              // Every error, "interrupted" included (an incoming call on iOS), is a failure; our
              // own Stop is told apart by the caller, which checks whether it stopped first.
              utterance.onerror = () => onEnd(false);
              synth.speak(utterance);
            },
            cancel: () => synth.cancel(),
            prime: () => synth.speak(new Utterance(""))
          }
        : null
  };
}

export interface SpeechPlayback {
  /** Resolves when every chunk has played, playback was stopped, or it failed. */
  done: Promise<"finished" | "stopped" | "failed">;
  stop(): void;
}

/** 50 ms of 8 kHz silence as WAV: played inside the tap to unlock the audio element. */
export function silentWav(): Blob {
  const samples = 400;
  const view = new DataView(new ArrayBuffer(44 + samples));
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  for (let index = 0; index < samples; index += 1) view.setUint8(44 + index, 128);
  return new Blob([view.buffer], { type: "audio/wav" });
}

/**
 * Speaks a reply. Call it from the tap itself: it creates one audio element and starts it on a
 * moment of silence right away, while the tap still counts as a user gesture (iOS Safari only lets
 * an element play later if it first played inside a gesture), then reuses that element for every
 * chunk. Chunk 1 is fetched, then each next chunk while the previous one plays, so long replies
 * do not pause between parts. Uses server speech until it answers voice_unavailable, and the
 * browser's speech synthesis from the chunk where server speech stopped or playback was refused.
 * When it ends, for any reason, the pending fetch is aborted and every blob URL is revoked.
 */
export function speakReply(environment: SpeechEnvironment, text: string): SpeechPlayback {
  const chunks = splitForSpeech(speakableText(text));
  const controller = new AbortController();
  let stopped = false;
  let finished = false;
  const urls: string[] = [];
  const keep = (url: string) => {
    if (finished) environment.revokeObjectUrl(url);
    else urls.push(url);
    return url;
  };
  const release = () => urls.splice(0).forEach((url) => environment.revokeObjectUrl(url));
  let audio: AudioLike | null = null;
  if (chunks.length > 0) environment.synthesis?.prime();
  if (chunks.length > 0 && serverVoice.speak) {
    audio = environment.createAudio();
    audio.src = keep(environment.createObjectUrl(silentWav()));
    audio.play().catch(() => {});
  }

  const fetchChunk = async (chunk: string): Promise<string | null> => {
    try {
      const result = await environment.post<{ audioBase64?: unknown; contentType?: unknown }>(
        "/v1/voice/speak",
        { text: chunk },
        { timeoutMs: 45_000, signal: controller.signal }
      );
      const type = typeof result.contentType === "string" ? result.contentType : "audio/mpeg";
      const blob =
        typeof result.audioBase64 === "string"
          ? dataUrlToBlob(`data:${type};base64,${result.audioBase64}`)
          : null;
      if (!blob || finished) return null;
      return keep(environment.createObjectUrl(blob));
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "voice_unavailable")
        serverVoice.speak = false;
      return null;
    }
  };

  const playUrl = (player: AudioLike, url: string) =>
    new Promise<"ended" | "error" | "refused">((resolve) => {
      player.onended = () => resolve("ended");
      player.onerror = () => resolve("error");
      player.src = url;
      player.play().catch(() => resolve("refused"));
    });

  // Browser speech from server chunk `from` on, in short parts: Chrome stops firing onend on
  // utterances over about 15 s, and a watchdog ends a part that never reports back (iOS outside a
  // gesture), so `done` always settles.
  const speakLocally = (from: number) =>
    new Promise<"finished" | "stopped" | "failed">((resolve) => {
      const synthesis = environment.synthesis;
      if (!synthesis) return resolve("failed");
      const parts = splitForSpeech(chunks.slice(from).join(" "), localSpeechMaxCharacters);
      const next = (index: number) => {
        if (stopped) return resolve("stopped");
        if (index >= parts.length) return resolve("finished");
        let settled = false;
        const watchdog = setTimeout(
          () => settle(false),
          Math.max(8_000, parts[index]!.length * 150)
        );
        function settle(ok: boolean) {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          if (stopped) return resolve("stopped");
          if (!ok) {
            synthesis!.cancel();
            return resolve("failed");
          }
          next(index + 1);
        }
        synthesis.speak(parts[index]!, settle);
      };
      next(0);
    });

  const run = async (): Promise<"finished" | "stopped" | "failed"> => {
    if (chunks.length === 0) return "finished";
    if (!audio) return speakLocally(0);
    const player = audio;
    let pending = fetchChunk(chunks[0]!);
    for (let index = 0; index < chunks.length; index += 1) {
      const url = await pending;
      if (stopped) return "stopped";
      if (url === null) return serverVoice.speak ? "failed" : speakLocally(index);
      if (index + 1 < chunks.length) pending = fetchChunk(chunks[index + 1]!);
      const played = await playUrl(player, url);
      // Played parts are let go at once: a long reply never holds every part in memory.
      const at = urls.indexOf(url);
      if (at >= 0 && played !== "refused") {
        urls.splice(at, 1);
        environment.revokeObjectUrl(url);
      }
      if (stopped) return "stopped";
      // The browser would not play (autoplay policy): its own speech still can.
      if (played === "refused") return speakLocally(index);
      if (played === "error") return "failed";
    }
    return "finished";
  };

  const done = run().finally(() => {
    finished = true;
    controller.abort();
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
    }
    release();
  });
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      const player = audio;
      player?.pause();
      player?.onended?.();
      environment.synthesis?.cancel();
    }
  };
}
