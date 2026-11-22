import { useEffect, useRef, useState } from "react";

import {
  browserVoiceNoteEnvironment,
  startVoiceNoteRecording,
  VoiceNoteUnavailableError,
  voiceNoteMaxMs,
  type VoiceNoteEnvironment,
  type VoiceNoteRecording
} from "../messaging/voice-note";

export type VoiceNoteState = "idle" | "starting" | "recording" | "finishing";

/**
 * The composer's voice-note recorder: start asks for the microphone, stop hands the file to
 * onRecorded (it becomes a pending attachment), cancel throws it away. It stops by itself at
 * voiceNoteMaxMs, and leaving the composer cancels a recording in progress.
 */
export function useVoiceNoteRecorder(
  onRecorded: (file: File) => void,
  environment: VoiceNoteEnvironment | null = browserVoiceNoteEnvironment()
) {
  const [state, setState] = useState<VoiceNoteState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recording = useRef<VoiceNoteRecording | null>(null);
  // Unmounted (the person left the chat) while the microphone prompt was still up.
  const disposed = useRef(false);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  async function stop() {
    const current = recording.current;
    if (current === null) return;
    recording.current = null;
    setState("finishing");
    const file = await current.stop();
    setState("idle");
    setElapsedMs(0);
    if (file === null) setError("Nothing was recorded. Try again.");
    else onRecordedRef.current(file);
  }

  async function start() {
    if (state !== "idle") return;
    setError(null);
    setState("starting");
    try {
      const started = await startVoiceNoteRecording(environment);
      if (disposed.current) {
        // Nobody is left to stop it: release the microphone now, or its indicator stays on.
        started.cancel();
        return;
      }
      recording.current = started;
      setElapsedMs(0);
      setState("recording");
    } catch (caught) {
      if (disposed.current) return;
      setState("idle");
      setError(
        caught instanceof VoiceNoteUnavailableError
          ? caught.message
          : "The voice note could not be recorded."
      );
    }
  }

  function cancel() {
    recording.current?.cancel();
    recording.current = null;
    setState("idle");
    setElapsedMs(0);
  }

  useEffect(() => {
    if (state !== "recording") return;
    const startedAt = recording.current?.startedAt.getTime() ?? Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= voiceNoteMaxMs) void stop();
    }, 250);
    return () => clearInterval(tick);
  }, [state]);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      recording.current?.cancel();
      recording.current = null;
    };
  }, []);

  return {
    supported: environment !== null,
    state,
    elapsedMs,
    error,
    start,
    stop,
    cancel,
    dismissError: () => setError(null)
  };
}
