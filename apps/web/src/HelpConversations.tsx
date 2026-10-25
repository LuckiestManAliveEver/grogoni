import type { ConversationInboxItem } from "@grogoni/shared-types";

export function HelpConversations({
  root,
  topics,
  activeId,
  onSelect
}: {
  root: ConversationInboxItem;
  topics: ConversationInboxItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="help-conversations" aria-label="Help chats">
      <button
        type="button"
        className={`conversation-select ${activeId === root.id ? "active" : ""}`}
        onClick={() => onSelect(root.id)}
      >
        <strong>Help</strong>
        <small>Ask your agent for assistance</small>
      </button>
      <details open>
        <summary>User journeys and tools</summary>
        <nav aria-label="Help topics">
          {topics.map((topic) => (
            <button
              key={topic.id}
              type="button"
              className="conversation-select"
              aria-current={topic.id === activeId ? "page" : undefined}
              onClick={() => onSelect(topic.id)}
            >
              {topic.title}
            </button>
          ))}
        </nav>
      </details>
    </section>
  );
}
