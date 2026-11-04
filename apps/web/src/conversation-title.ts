import { permanentDaemonDisplayName, type ConversationSummary } from "@grogoni/shared-types";

type TitledConversation = Pick<ConversationSummary, "isPermanentDaemon" | "title">;

/**
 * The account's permanent daemon conversation, shown to people as "My Assistant". Only
 * isPermanentDaemon identifies it: conversationType "DAEMON" also covers every help topic and
 * every agent session the owner started, which keep their own titles.
 */
export function isAssistantConversation(
  conversation: Pick<ConversationSummary, "isPermanentDaemon"> | undefined
): boolean {
  return conversation?.isPermanentDaemon === true;
}

/**
 * A conversation's own title, except the permanent daemon conversation, which is always named
 * "My Assistant" whatever its stored title (rows created before the rename say "Your daemon").
 */
export function conversationTitle(conversation: TitledConversation | undefined): string | null {
  if (conversation === undefined) return null;
  return isAssistantConversation(conversation)
    ? permanentDaemonDisplayName
    : (conversation.title ?? null);
}

/** Inbox badge text for a conversation type. The internal DAEMON type (any agent chat) reads as
 *  ASSISTANT; that is a kind of chat, unlike the "My Assistant" title of the permanent one. */
export function conversationTypeBadge(
  type: ConversationSummary["conversationType"]
): string | null {
  if (type === undefined) return null;
  return type === "DAEMON" ? "ASSISTANT" : type;
}
