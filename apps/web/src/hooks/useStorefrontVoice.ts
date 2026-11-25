import { useMemo, useRef } from "react";
import { browserSpeechEnvironment, guestVoicePost } from "../messaging/voice-speech";

/**
 * Voice for a storefront guest (voicecom P2.4): the server's speech service through the guest's
 * storefront capability, once the guest session exists. Before that, voice typing uses the
 * browser's own recognition and Listen the browser's own speech.
 */
export function useStorefrontVoice(agentId: string, capabilityToken: string) {
  const token = useRef(capabilityToken);
  token.current = capabilityToken;
  const post = useMemo(() => guestVoicePost(agentId, () => token.current), [agentId]);
  const environment = useMemo(() => browserSpeechEnvironment(post), [post]);
  return { post, server: capabilityToken !== "", environment };
}
