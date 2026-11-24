import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserSpeechEnvironment,
  postVoice,
  speakReply,
  type SpeechEnvironment,
  type SpeechPlayback
} from "../messaging/voice-speech";

/**
 * Read-aloud for agent replies: one reply speaks at a time; starting another, pressing Stop or
 * leaving the chat stops the current one.
 */
export function useReadAloud(environment?: SpeechEnvironment) {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState<{ messageId: string; message: string } | null>(null);
  // Which reply is playing, as a ref: two taps before a re-render must see the first one.
  const playing = useRef<{ messageId: string; playback: SpeechPlayback } | null>(null);
  const env = useRef(environment);
  env.current = environment;

  useEffect(
    () => () => {
      playing.current?.playback.stop();
      playing.current = null;
    },
    []
  );

  // Must run inside the tap's handler: speakReply unlocks audio while the gesture is live.
  const toggle = useCallback((messageId: string, text: string) => {
    const current = playing.current;
    playing.current = null;
    current?.playback.stop();
    setError(null);
    if (current?.messageId === messageId) {
      setSpeakingId(null);
      return;
    }
    const playback = speakReply(env.current ?? browserSpeechEnvironment(postVoice), text);
    const entry = { messageId, playback };
    playing.current = entry;
    setSpeakingId(messageId);
    void playback.done.then((outcome) => {
      if (playing.current !== entry) return;
      playing.current = null;
      setSpeakingId(null);
      if (outcome === "failed")
        setError({ messageId, message: "This reply could not be read aloud. Please try again." });
    });
  }, []);

  return { speakingId, error, toggle };
}
