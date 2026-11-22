import type { ConversationView } from "@grogoni/shared-types";
import { conversationGoesToPeople } from "../chat-message-plumbing";
import type { SessionResponse } from "../grogoni-application-shared";
import { ApiRequestError, apiFetch } from "../lib/api";

/**
 * Where a message sent before its conversation's view has loaded (sent as the chat opens) goes.
 * The view decides: a direct chat is end-to-end encrypted, a shop's chat goes to the shop, a help
 * thread to the help agent. Without a shop, a thread that is none of these keeps its model routing
 * (`view: null`), and so does one the server has no view of (404). Any other failure leaves the
 * route unknown (`error`): the send must stop, never guess and send to the model instead.
 */
export async function loadSendTarget(
  conversationId: string,
  hasShop: boolean,
  session: SessionResponse | null
): Promise<{ view: ConversationView | null } | { error: unknown }> {
  try {
    const view = await apiFetch<ConversationView>(
      `/v1/conversations/${conversationId}`,
      { priority: true, urgent: true } // Sending waits on it: never behind background reads.
    );
    const applies =
      hasShop || Boolean(view?.conversation?.helpTopic) || conversationGoesToPeople(view, session);
    return { view: applies ? view : null };
  } catch (error) {
    if (!hasShop && error instanceof ApiRequestError && error.status === 404) return { view: null };
    return { error };
  }
}
