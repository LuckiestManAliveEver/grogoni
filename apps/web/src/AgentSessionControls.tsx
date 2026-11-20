import type { ConversationInboxItem } from "@grogoni/shared-types";
import { conversationMessageText } from "./chat-message-plumbing";
import { conversationTitle } from "./conversation-title";

type SessionConversation = Pick<
  ConversationInboxItem,
  | "id"
  | "kind"
  | "hasHumanRecipient"
  | "helpTopic"
  | "activeShopId"
  | "runtimeBindingId"
  | "createdAt"
  | "lastMessage"
  | "title"
> &
  Partial<ConversationInboxItem>;

/** A conversation with an agent (not a person, not a help topic): it has sessions. */
export function isAgentSessionConversation(conversation: SessionConversation | undefined): boolean {
  return (
    conversation !== undefined &&
    !conversation.hasHumanRecipient &&
    !conversation.helpTopic &&
    conversation.kind === "personal"
  );
}

/** The sessions of the selected conversation's agent: same shop and same runtime binding. */
export function agentSessionsFor<T extends SessionConversation>(
  conversations: readonly T[],
  selected: SessionConversation | undefined
): T[] {
  if (!isAgentSessionConversation(selected)) return [];
  return conversations.filter(
    (item) =>
      isAgentSessionConversation(item) &&
      item.activeShopId === selected!.activeShopId &&
      item.runtimeBindingId === selected!.runtimeBindingId
  );
}

/** Agent name | Session history | + New Session, for the thread header. */
export function AgentSessionHeaderControls({
  historyOpen,
  onToggleHistory,
  onNewSession
}: {
  historyOpen: boolean;
  onToggleHistory: () => void;
  onNewSession: () => void;
}) {
  return (
    <div className="agent-session-controls">
      <button type="button" onClick={onToggleHistory} aria-expanded={historyOpen}>
        Session history
      </button>
      <button type="button" onClick={onNewSession}>
        + New Session
      </button>
    </div>
  );
}

/** The agent's sessions; choosing one continues it. */
export function AgentSessionHistory({
  sessions,
  onOpen
}: {
  sessions: readonly SessionConversation[];
  onOpen: (conversationId: string) => void;
}) {
  return (
    <section className="agent-session-history" aria-label="Session history">
      {sessions.map((item) => (
        <button type="button" key={item.id} onClick={() => onOpen(item.id)}>
          <strong>{conversationTitle(item as ConversationInboxItem) ?? "New session"}</strong>
          {item.lastMessage ? (
            <span>{conversationMessageText(item.lastMessage).slice(0, 120)}</span>
          ) : null}
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
        </button>
      ))}
    </section>
  );
}
