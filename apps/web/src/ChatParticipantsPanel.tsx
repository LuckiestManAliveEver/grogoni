import { useEffect, useState } from "react";
import type { ConversationView } from "@grogoni/shared-types";
import { fetchFreshJson, postJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { StackedModule } from "./StackedModule";
import type { DevicePhonebookContact } from "./phonebook-device-cache";

export function ChatParticipantsPanel({
  conversationId,
  contacts,
  onClose,
  onUpdated
}: {
  conversationId: string | null;
  contacts: readonly DevicePhonebookContact[];
  onClose: () => void;
  onUpdated: (conversationId: string) => void;
}) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void fetchFreshJson<ConversationView>(`/v1/conversations/${encodeURIComponent(conversationId)}`)
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(getErrorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  async function add(agent: boolean) {
    if (!conversationId || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let targetId = view?.conversation.id ?? conversationId;
      if (view?.conversation.isPermanentDaemon && !agent) {
        const discussion = await postJson<ConversationView>("/v1/conversations", {
          kind: "personal",
          activeShopId: null,
          title: "Group discussion"
        });
        targetId = discussion.conversation.id;
        setView(discussion);
      }
      const result = await postJson<ConversationView>(
        `/v1/conversations/${encodeURIComponent(targetId)}/participants`,
        agent ? { agent: true } : { recipient: recipient.trim() }
      );
      setView(result);
      setRecipient("");
      setNotice(
        agent
          ? "Agent added to the discussion."
          : "Contact added. A discussion alert has been queued for the receiver."
      );
      onUpdated(result.conversation.id);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const hasAgent = view?.participants.some((participant) => participant.role === "agent") ?? false;
  return (
    <StackedModule
      moduleId="chat-participants"
      open
      title="Discussion participants"
      onClose={onClose}
    >
      {view ? (
        <ul aria-label="Participants">
          {view.participants.map((participant) => (
            <li key={participant.id}>
              {participant.displayName ?? participant.role}
              {participant.role === "agent" ? " · Agent" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {!conversationId ? (
        <p>Start or open a chat before adding participants.</p>
      ) : (
        <>
          <p>
            Added contacts can open this discussion. Earlier encrypted messages stay readable only
            by their original recipients. Shared agent chat history may be visible to added
            contacts.
          </p>
          {view?.conversation.isPermanentDaemon ? (
            <p>
              Adding a contact starts a new group discussion with your agent. Your permanent agent
              chat stays private.
            </p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void add(false);
            }}
          >
            <label>
              Contact’s phone number or email
              <input
                required
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                list="discussion-contacts"
              />
            </label>
            <datalist id="discussion-contacts">
              {contacts.map((contact, index) => {
                const value = contact.nodeId
                  ? `network-node:${contact.nodeId}`
                  : (contact.phone ?? contact.email);
                return value ? (
                  <option key={index} value={value}>
                    {contact.name}
                  </option>
                ) : null;
              })}
            </datalist>
            <button type="submit" disabled={busy || !view || !recipient.trim()}>
              Add contact and alert
            </button>
          </form>
          <button
            type="button"
            disabled={busy || !view || hasAgent}
            onClick={() => void add(true)}
          >
            Add my agent
          </button>
          <p>
            Messages between contacts remain encrypted. Adding an agent does not give it access to
            encrypted messages.
          </p>
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </StackedModule>
  );
}
