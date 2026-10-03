import type { Dispatch, SetStateAction } from "react";

import type { ConversationInboxItem } from "@grogoni/shared-types";

import { conversationMessageText } from "./chat-message-plumbing";
import { formatMessageTime } from "./formatters";

export interface ConversationListPanelProps {
  // False inside the compact-viewport StackedModule drawer, which already renders the
  // "Chats"/"Messages" title in its own heading bar (see ChatSurface).
  showHeading: boolean;
  isSessionListView: boolean;
  isAuthenticated: boolean;
  inboxSearch: string;
  setInboxSearch: Dispatch<SetStateAction<string>>;
  isNewConversationOpen: boolean;
  setIsNewConversationOpen: Dispatch<SetStateAction<boolean>>;
  newRecipient: string;
  setNewRecipient: Dispatch<SetStateAction<string>>;
  newConversationTitle: string;
  setNewConversationTitle: Dispatch<SetStateAction<string>>;
  isNewSessionOpen: boolean;
  setIsNewSessionOpen: Dispatch<SetStateAction<boolean>>;
  newSessionTitle: string;
  setNewSessionTitle: Dispatch<SetStateAction<string>>;
  liveDraft: string;
  visibleConversations: ConversationInboxItem[];
  activeConversationId: string | null;
  onCreateConversation: (recipient: string, title: string) => void;
  onCreateAgentSession: (title?: string) => void;
  onRequireSignIn: () => void;
  onEnableNotifications: () => void;
  onSelectConversation: (conversationId: string) => void;
  onInboxOpenChange: (open: boolean) => void;
  onConversationPreference: (
    conversationId: string,
    preference: "archive" | "mute" | "pin"
  ) => void;
  openSmsHandoff: (recipient: string, label: string) => void;
  openPlatformHandoff: (label: string) => Promise<void>;
  onOpenRecycleBin: () => void;
  deletingConversationId: string | null;
  setDeletingConversationId: Dispatch<SetStateAction<string | null>>;
  onDeleteConversation: (conversationId: string) => void;
}

export function ConversationListPanel({
  showHeading,
  isSessionListView,
  isAuthenticated,
  inboxSearch,
  setInboxSearch,
  isNewConversationOpen,
  setIsNewConversationOpen,
  newRecipient,
  setNewRecipient,
  newConversationTitle,
  setNewConversationTitle,
  isNewSessionOpen,
  setIsNewSessionOpen,
  newSessionTitle,
  setNewSessionTitle,
  liveDraft,
  visibleConversations,
  activeConversationId,
  onCreateConversation,
  onCreateAgentSession,
  onRequireSignIn,
  onEnableNotifications,
  onSelectConversation,
  onInboxOpenChange,
  onConversationPreference,
  openSmsHandoff,
  openPlatformHandoff,
  onOpenRecycleBin,
  deletingConversationId,
  setDeletingConversationId,
  onDeleteConversation
}: ConversationListPanelProps) {
  return (
    <>
      <div className="messenger-inbox-heading">
        {showHeading ? <h2>{isSessionListView ? "Chats" : "Messages"}</h2> : null}
        <button
          type="button"
          className="secondary"
          aria-label="Recycle bin"
          onClick={onOpenRecycleBin}
        >
          Recycle bin
        </button>
        <button
          type="button"
          className="inbox-icon-button"
          aria-label="Notifications"
          onClick={isAuthenticated ? onEnableNotifications : onRequireSignIn}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="messenger-inbox-tools">
        <label className="inbox-search-field">
          <span className="visually-hidden">Search conversations</span>
          <span className="inbox-search-icon" aria-hidden="true" />
          <input
            type="search"
            value={inboxSearch}
            onChange={(event) => setInboxSearch(event.target.value)}
            placeholder={isSessionListView ? "Search chats" : "Search messages"}
          />
        </label>
        {isSessionListView ? null : (
          <button
            type="button"
            className="new-direct-message-link"
            onClick={() =>
              isAuthenticated ? setIsNewConversationOpen((open) => !open) : onRequireSignIn()
            }
          >
            Message a phone number or email
          </button>
        )}
      </div>
      {isNewConversationOpen && !isSessionListView ? (
        <form
          className="new-conversation-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCreateConversation(newRecipient, newConversationTitle);
            setNewRecipient("");
            setNewConversationTitle("");
            setIsNewConversationOpen(false);
          }}
        >
          <label>
            Phone number or email
            <input
              required
              value={newRecipient}
              onChange={(event) => setNewRecipient(event.target.value)}
              placeholder="+254 700 000 000 or name@example.com"
            />
          </label>
          <label>
            Name
            <input
              value={newConversationTitle}
              onChange={(event) => setNewConversationTitle(event.target.value)}
              placeholder="Conversation name"
            />
          </label>
          <small>
            Grogoni chats require a registered user and are end-to-end encrypted. SMS and external apps
            use their own privacy and delivery rules.
          </small>
          <div className="new-conversation-actions">
            <button type="submit">Start encrypted chat</button>
            <button
              className="secondary"
              type="button"
              disabled={newRecipient.trim().length === 0 || liveDraft.trim().length === 0}
              onClick={() => openSmsHandoff(newRecipient, newConversationTitle)}
            >
              Send as SMS
            </button>
            <button
              className="secondary"
              type="button"
              disabled={liveDraft.trim().length === 0}
              onClick={() => void openPlatformHandoff(newConversationTitle)}
            >
              Share to apps
            </button>
          </div>
        </form>
      ) : null}
      {isNewSessionOpen && isSessionListView ? (
        <form
          className="new-session-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCreateAgentSession(newSessionTitle.trim() || undefined);
            setNewSessionTitle("");
            setIsNewSessionOpen(false);
          }}
        >
          <label>
            Name
            <input
              value={newSessionTitle}
              onChange={(event) => setNewSessionTitle(event.target.value)}
              placeholder="e.g. Restock maize"
            />
          </label>
          <div className="new-conversation-actions">
            <button type="submit">Start session</button>
          </div>
        </form>
      ) : null}
      <div className="conversation-list">
        {visibleConversations.map((conversation) => (
          <article
            className={`conversation-item ${conversation.id === activeConversationId ? "active" : ""}`}
            key={conversation.id}
          >
            <button
              className="conversation-select"
              type="button"
              onClick={() => {
                onSelectConversation(conversation.id);
                onInboxOpenChange(false);
              }}
            >
              <span
                className={`conversation-avatar ${
                  conversation.kind === "personal"
                    ? conversation.activeShopId === null
                      ? "buy"
                      : "sell"
                    : "chat"
                }`}
                aria-hidden="true"
              >
                {(conversation.title ?? "Grogoni").trim().slice(0, 1).toUpperCase()}
              </span>
              <span className="conversation-copy">
                <span className="conversation-title-line">
                  <strong>{conversation.title ?? "Grogoni agent"}</strong>
                  <time dateTime={conversation.updatedAt}>
                    {formatMessageTime(conversation.updatedAt)}
                  </time>
                </span>
                <small>
                  {conversation.lastMessage === null
                    ? "No messages yet"
                    : conversationMessageText(conversation.lastMessage)}
                </small>
              </span>
              <span
                className={`session-badge ${
                  conversation.kind === "personal"
                    ? conversation.activeShopId === null
                      ? "buy"
                      : "sell"
                    : "chat"
                }`}
              >
                {conversation.kind === "personal"
                  ? conversation.activeShopId === null
                    ? "Buy"
                    : "Sell"
                  : "Chat"}
              </span>
              {conversation.unreadCount > 0 ? (
                <b aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount}</b>
              ) : null}
            </button>
            <div className="conversation-actions" aria-label="Conversation actions">
              <button
                type="button"
                onClick={() => onConversationPreference(conversation.id, "pin")}
              >
                {conversation.participant.pinnedAt ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                onClick={() => onConversationPreference(conversation.id, "mute")}
              >
                {conversation.participant.mutedUntil ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                onClick={() => onConversationPreference(conversation.id, "archive")}
              >
                Archive
              </button>
              <button type="button" onClick={() => setDeletingConversationId(conversation.id)}>
                Delete
              </button>
            </div>
            {deletingConversationId === conversation.id ? (
              <div className="message-inline-action" role="alertdialog" aria-label="Delete chat?">
                <span>
                  Move this chat to the recycle bin? Deleting requires admin privileges and keeps it
                  recoverable for 14 days.
                </span>
                <button
                  className="danger"
                  type="button"
                  onClick={() => {
                    onDeleteConversation(conversation.id);
                    setDeletingConversationId(null);
                  }}
                >
                  Delete chat
                </button>
                <button type="button" onClick={() => setDeletingConversationId(null)}>
                  Cancel
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {visibleConversations.length === 0 ? (
          <p>
            {isSessionListView
              ? "No sessions yet. Start one to talk with your agent."
              : "No matching conversations."}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="new-chat-fab"
        onClick={() => {
          if (!isAuthenticated) {
            onRequireSignIn();
            return;
          }
          if (isSessionListView) {
            setIsNewSessionOpen((open) => !open);
            return;
          }
          // A blank session with the shop agent, ready to type into immediately - matches
          // "New chat" in the session-list view instead of requiring a recipient up front.
          // Starting a chat with a specific phone/email contact is still available via
          // "Message a phone number or email" below the search field.
          onCreateAgentSession();
          onInboxOpenChange(false);
        }}
      >
        <span aria-hidden="true">+</span>
        {isSessionListView ? "New chat" : "New message"}
      </button>
    </>
  );
}
