import type { Dispatch, SetStateAction } from "react";

import type { ChatMessage } from "../app-shell";
import type { AgentTurnCompanion } from "./agent-turn-companion";

/**
 * Wraps one agent turn request with a live preview bubble. The bubble appears only once reply text
 * actually arrives (deterministic turns never flash an empty bubble) and is always removed when the
 * request settles - the validated reply from the turn response takes its place.
 */
export async function withAgentTurnPreview<T>(input: {
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onStatus?: (status: string) => void;
  run: (headers: Record<string, string>) => Promise<T>;
}): Promise<T> {
  const previewId = `agent-preview-${crypto.randomUUID()}`;
  const turnId = crypto.randomUUID();
  let shown = false;
  let settled = false;
  let companion: AgentTurnCompanion | null = null;
  // Loaded on demand so the companion (and the on-device engine behind it) stays out of the owner
  // route chunk. Anything published before it connects is buffered server-side for this turn.
  void import("./agent-turn-companion").then(({ startAgentTurnCompanion }) => {
    if (settled) return;
    companion = startAgentTurnCompanion({
      turnId,
      onPreview(text) {
        if (settled) return;
        const body = text.trimStart();
        if (body === "") {
          if (shown) {
            input.setChatMessages((messages) => messages.filter((item) => item.id !== previewId));
            shown = false;
          }
          return;
        }
        if (!shown) {
          shown = true;
          input.setChatMessages((messages) => [
            ...messages,
            {
              id: previewId,
              author: "grogoniclaw",
              body,
              createdAt: new Date().toISOString(),
              status: "delivered"
            }
          ]);
          return;
        }
        input.setChatMessages((messages) =>
          messages.map((item) => (item.id === previewId ? { ...item, body } : item))
        );
      },
      onDeviceActivity(activity) {
        if (activity === "generating") input.onStatus?.("On-device model · Generating");
        if (activity === "failed") {
          input.onStatus?.("On-device model could not answer on this device.");
        }
      }
    });
  });
  try {
    return await input.run({ "x-grogoni-turn-id": turnId });
  } finally {
    settled = true;
    (companion as AgentTurnCompanion | null)?.stop();
    input.setChatMessages((messages) => messages.filter((item) => item.id !== previewId));
  }
}
