/**
 * Voice notes: a recording made in the composer becomes an ordinary audio attachment (its own
 * pending attachment, sent with the next send, end-to-end encrypted in a person-to-person chat
 * like any other file). Kept free of React so the recording lifecycle can be tested directly.
 */

/**
 * A voice note stops by itself at five minutes: about 4.8 MB at Chrome's default 128 kbps, under
 * the 10 MB attachment limit (about 6.4 MB as the base64 data URL it is sent as).
 */
export const voiceNoteMaxMs = 5 * 60_000;

/** Opus first (Chrome, Firefox, Android WebView); MP4/AAC for Safari. */
export const voiceNoteMimePreference = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm"
] as const;

export function voiceNoteMimeType(isTypeSupported: (type: string) => boolean): string | null {
  return voiceNoteMimePreference.find((type) => isTypeSupported(type)) ?? null;
}

function extensionFor(mimeType: string): string {
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  return "webm";
}

/** "Voice note 2026-11-22 14.03.09.webm", in the device's local time. */
export function voiceNoteFileName(mimeType: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `Voice note ${date} ${time}.${extensionFor(mimeType)}`;
}

/** "0:07", "4:59". */
export function formatRecordingTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface VoiceNoteEnvironment {
  getUserMedia: (constraints: { audio: boolean }) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, mimeType: string) => RecorderLike;
  isTypeSupported: (type: string) => boolean;
  now: () => Date;
}

export function browserVoiceNoteEnvironment(): VoiceNoteEnvironment | null {
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const media = globalThis.navigator?.mediaDevices;
  if (Recorder === undefined || typeof media?.getUserMedia !== "function") return null;
  return {
    getUserMedia: (constraints) => media.getUserMedia(constraints),
    createRecorder: (stream, mimeType) =>
      new Recorder(stream, { mimeType }) as unknown as RecorderLike,
    isTypeSupported: (type) =>
      typeof Recorder.isTypeSupported === "function" ? Recorder.isTypeSupported(type) : false,
    now: () => new Date()
  };
}

export interface VoiceNoteRecording {
  startedAt: Date;
  /** Stops and resolves the recorded file; null when nothing was captured. */
  stop(): Promise<File | null>;
  /** Stops and throws the recording away. */
  cancel(): void;
}

export class VoiceNoteUnavailableError extends Error {
  constructor(readonly reason: "unsupported" | "denied" | "failed") {
    super(
      reason === "denied"
        ? "Allow microphone access to record a voice note."
        : reason === "unsupported"
          ? "This browser cannot record voice notes."
          : "The voice note could not be recorded."
    );
    this.name = "VoiceNoteUnavailableError";
  }
}

/**
 * Asks for the microphone and starts recording. The microphone is released (every track
 * stopped) as soon as the recording stops or is cancelled, so the browser's recording indicator
 * never stays on.
 */
export async function startVoiceNoteRecording(
  environment: VoiceNoteEnvironment | null = browserVoiceNoteEnvironment()
): Promise<VoiceNoteRecording> {
  if (environment === null) throw new VoiceNoteUnavailableError("unsupported");
  const mimeType = voiceNoteMimeType(environment.isTypeSupported);
  if (mimeType === null) throw new VoiceNoteUnavailableError("unsupported");
  let stream: MediaStream;
  try {
    stream = await environment.getUserMedia({ audio: true });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new VoiceNoteUnavailableError(
      name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed"
    );
  }
  const release = () => stream.getTracks().forEach((track) => track.stop());
  let recorder: RecorderLike;
  try {
    recorder = environment.createRecorder(stream, mimeType);
  } catch {
    release();
    throw new VoiceNoteUnavailableError("failed");
  }
  const chunks: Blob[] = [];
  const startedAt = environment.now();
  let cancelled = false;
  const stopped = new Promise<File | null>((resolve) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      release();
      resolve(null);
    };
    recorder.onstop = () => {
      release();
      if (cancelled || chunks.length === 0) return resolve(null);
      const type = (recorder.mimeType || mimeType).split(";")[0]!;
      resolve(new File(chunks, voiceNoteFileName(type, startedAt), { type }));
    };
  });
  recorder.start(1_000);
  const finish = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  return {
    startedAt,
    stop: () => {
      finish();
      return stopped;
    },
    cancel: () => {
      cancelled = true;
      finish();
    }
  };
}

/**
 * The page's Content-Security-Policy plays media from https: and blob: only, so an attachment
 * held as a data URL (a received or just-recorded file) is played through a blob URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/su.exec(dataUrl);
  if (match === null) return null;
  const [, type, base64, data] = match;
  try {
    if (!base64) return new Blob([decodeURIComponent(data!)], type ? { type } : {});
    const binary = atob(data!);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], type ? { type } : {});
  } catch {
    return null;
  }
}
