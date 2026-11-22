import { useVoiceNoteRecorder } from "./hooks/useVoiceNoteRecorder";
import { formatRecordingTime } from "./messaging/voice-note";

/**
 * The composer's voice-note recorder. A recording becomes a pending attachment through
 * onAddAttachmentFiles; without it (or without browser support) no Voice note action is offered.
 */
export function useComposerVoiceNote(onAddAttachmentFiles?: (files: File[]) => void) {
  const recorder = useVoiceNoteRecorder((file) => onAddAttachmentFiles?.([file]));
  const available = onAddAttachmentFiles !== undefined && recorder.supported;
  return {
    ...recorder,
    /** Props for ChatComposerActions: the Voice note action, when it can be used. */
    actionProps: (run: (action: () => void) => void) =>
      available ? { onRecordVoiceNote: () => run(() => void recorder.start()) } : {}
  };
}

/** The composer's recording bar (timer, Cancel, Stop and attach) and why a recording failed. */
export function VoiceNoteBar({
  voiceNote
}: {
  voiceNote: ReturnType<typeof useVoiceNoteRecorder>;
}) {
  return (
    <>
      {voiceNote.state !== "idle" ? (
        <div className="composer-voice-note" role="group" aria-label="Voice note">
          <span className="composer-voice-note-dot" aria-hidden="true" />
          <span role="timer" aria-live="off">
            {voiceNote.state === "starting"
              ? "Starting…"
              : voiceNote.state === "finishing"
                ? "Saving…"
                : `Recording ${formatRecordingTime(voiceNote.elapsedMs)}`}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={voiceNote.state !== "recording"}
            onClick={voiceNote.cancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={voiceNote.state !== "recording"}
            onClick={() => void voiceNote.stop()}
          >
            Stop and attach
          </button>
        </div>
      ) : null}
      {voiceNote.error !== null ? (
        <small className="external-share-notice" role="status">
          {voiceNote.error}
        </small>
      ) : null}
    </>
  );
}
