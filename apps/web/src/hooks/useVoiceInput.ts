import { useEffect, useRef, useState } from "react";
import { startVoiceInput, type BrowserSpeechRecognition } from "../chat-message-plumbing";
import { isExplicitOfflineMode } from "../offline-runtime";
import {
  browserVoiceNoteEnvironment,
  startVoiceNoteRecording,
  VoiceNoteUnavailableError,
  type VoiceNoteRecording
} from "../messaging/voice-note";
import {
  DictationError,
  dictationMaxMs,
  serverTranscriptionAvailable,
  postVoice,
  transcribeRecording,
  type VoicePost
} from "../messaging/voice-speech";

/**
 * Voice typing. With the server's speech service (the default) the microphone records until the
 * second tap or 60 seconds, the recording is transcribed by the server, and the text is handed to
 * onTranscript for the person to review: nothing is sent by itself. When the server says it has
 * no speech service, or the browser cannot record, it uses the browser's own speech recognition.
 */
export function useVoiceInput(
  onTranscript: (text: string) => void,
  options: {
    /** false: browser speech only (for example a guest before the storefront session exists). */
    server?: boolean;
    /** The speech call to use; default the signed-in API (guests pass guestVoicePost). */
    post?: VoicePost;
  } = {}
) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const recognition = useRef<BrowserSpeechRecognition | null>(null);
  const recording = useRef<VoiceNoteRecording | null>(null);
  // "starting": the microphone prompt or getUserMedia is pending; "finishing": stopping or
  // transcribing. Refs, not state: two taps in one render must see each other.
  const phase = useRef<"idle" | "starting" | "recording" | "finishing">("idle");
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The last recording that could not be transcribed, kept so the person can try again.
  const failed = useRef<Blob | null>(null);
  const post = useRef<VoicePost>(options.post ?? postVoice);
  post.current = options.post ?? postVoice;
  const deliver = useRef(onTranscript);
  deliver.current = onTranscript;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      recording.current?.cancel();
      recording.current = null;
      abort.current?.abort();
      failed.current = null;
      if (recognition.current) {
        recognition.current.onend = null;
        recognition.current.onerror = null;
        recognition.current.onresult = null;
        recognition.current.stop();
      }
    };
  }, []);

  async function transcribe(file: Blob) {
    phase.current = "finishing";
    setTranscribing(true);
    setCanRetry(false);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const text = await transcribeRecording(post.current, file, {
        signal: controller.signal,
        online: globalThis.navigator?.onLine !== false
      });
      failed.current = null;
      if (!controller.signal.aborted) deliver.current(text);
    } catch (caught) {
      if (controller.signal.aborted || !mounted.current) return;
      const reason = caught instanceof DictationError ? caught.reason : "failed";
      // Keep the words for another try unless retrying cannot help.
      failed.current = reason === "failed" || reason === "offline" ? file : null;
      setCanRetry(failed.current !== null);
      setError(
        caught instanceof DictationError
          ? caught.message
          : "Your recording could not be turned into text. Please try again."
      );
    } finally {
      if (abort.current === controller) abort.current = null;
      phase.current = "idle";
      if (mounted.current) setTranscribing(false);
    }
  }

  async function finishRecording() {
    const active = recording.current;
    if (!active || phase.current !== "recording") return;
    recording.current = null;
    phase.current = "finishing";
    if (timer.current) clearTimeout(timer.current);
    setListening(false);
    setTranscribing(true);
    const file = await active.stop();
    if (!mounted.current) return;
    if (!file) {
      phase.current = "idle";
      setTranscribing(false);
      setError("No speech was heard. Please try again.");
      return;
    }
    await transcribe(file);
  }

  function startBrowserRecognition() {
    const instance = startVoiceInput(
      (text) => deliver.current(text),
      () => {
        setError(
          "Voice input is unavailable. Check microphone permission or use a supported browser."
        );
        setListening(false);
        recognition.current = null;
      },
      () => {
        setListening(false);
        recognition.current = null;
      }
    );
    if (instance) {
      recognition.current = instance;
      setListening(true);
    }
  }

  async function startServerDictation() {
    phase.current = "starting";
    try {
      const started = await startVoiceNoteRecording();
      // Unmounted while the microphone was opening: release it, upload nothing.
      if (!mounted.current) {
        started.cancel();
        return;
      }
      recording.current = started;
      phase.current = "recording";
      setListening(true);
      timer.current = setTimeout(() => void finishRecording(), dictationMaxMs);
    } catch (caught) {
      phase.current = "idle";
      if (!mounted.current) return;
      // The browser cannot record after all: its own recognition may still work.
      if (caught instanceof VoiceNoteUnavailableError && caught.reason === "unsupported") {
        startBrowserRecognition();
        return;
      }
      setError(
        caught instanceof VoiceNoteUnavailableError
          ? caught.reason === "denied"
            ? "Allow microphone access to use voice typing."
            : "This device cannot record for voice typing."
          : "Voice typing could not start. Please try again."
      );
    }
  }

  function toggle() {
    if (phase.current === "starting" || phase.current === "finishing") return;
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    if (phase.current === "recording") {
      void finishRecording();
      return;
    }
    setError(null);
    setCanRetry(false);
    failed.current = null;
    if (
      options.server !== false &&
      serverTranscriptionAvailable() &&
      !isExplicitOfflineMode() &&
      globalThis.navigator?.onLine !== false &&
      browserVoiceNoteEnvironment() !== null
    )
      void startServerDictation();
    else startBrowserRecognition();
  }

  /** Sends the last recording that failed again, without asking the person to repeat it. */
  function retry() {
    const file = failed.current;
    if (!file || phase.current !== "idle") return;
    setError(null);
    void transcribe(file);
  }

  return { listening, transcribing, error, canRetry, toggle, retry };
}

/** The composer's voice input: each transcript is appended to the draft as it stands then. */
export function useComposerVoiceInput(draft: string, updateDraft: (next: string) => void) {
  const current = useRef(draft);
  current.current = draft;
  return useVoiceInput((text) => {
    if (text.trim()) updateDraft([current.current.trim(), text.trim()].filter(Boolean).join(" "));
  });
}
