import { useEffect, useRef, useState } from "react";
import { startVoiceInput, type BrowserSpeechRecognition } from "../chat-message-plumbing";

export function useVoiceInput(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<BrowserSpeechRecognition | null>(null);
  useEffect(
    () => () => {
      if (recognition.current) {
        recognition.current.onend = null;
        recognition.current.onerror = null;
        recognition.current.onresult = null;
        recognition.current.stop();
      }
    },
    []
  );
  function toggle() {
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    setError(null);
    const instance = startVoiceInput(
      onTranscript,
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
  return { listening, error, toggle };
}

/** The composer's voice input: each transcript is appended to the draft as it stands then. */
export function useComposerVoiceInput(draft: string, updateDraft: (next: string) => void) {
  const current = useRef(draft);
  current.current = draft;
  return useVoiceInput((text) => {
    if (text.trim()) updateDraft([current.current.trim(), text.trim()].filter(Boolean).join(" "));
  });
}
