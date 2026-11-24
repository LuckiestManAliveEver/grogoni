import type { useReadAloud } from "./hooks/useReadAloud";
import { agentPreviewIdPrefix } from "./inference/agent-turn-preview";

/** Listen / Stop for one agent reply, and why it could not be read aloud. */
export function ReadAloudButton({
  readAloud,
  messageId,
  text
}: {
  readAloud: ReturnType<typeof useReadAloud>;
  messageId: string;
  text: string;
}) {
  // Not while the reply is still streaming: it would read half an answer.
  if (!text.trim() || messageId.startsWith(agentPreviewIdPrefix)) return null;
  const speaking = readAloud.speakingId === messageId;
  return (
    <>
      <button
        type="button"
        aria-pressed={speaking}
        aria-label={speaking ? "Stop reading this reply aloud" : "Read this reply aloud"}
        onClick={() => readAloud.toggle(messageId, text)}
      >
        {speaking ? "Stop" : "Listen"}
      </button>
      {readAloud.error?.messageId === messageId ? (
        <small role="status">{readAloud.error.message}</small>
      ) : null}
    </>
  );
}
