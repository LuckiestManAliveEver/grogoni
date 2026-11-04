import { submitChatDaemonTask } from "./daemon-chat";
import { postJson } from "./api-helpers";

/** Queue a guest reply with the bubble's ID so persisted messages replace the local bubble. */
export async function askGuestModel(
  input: Parameters<typeof submitChatDaemonTask>[0]
): Promise<{ note: string } | null> {
  try {
    if (input.conversationId) {
      await postJson("/v1/messages", {
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        content: { type: "text", text: input.message }
      });
    }
    await submitChatDaemonTask(input);
    return { note: "Assistant is thinking…" };
  } catch {
    return null;
  }
}
