import { useEffect, useState } from "react";
import type { ConversationExecutionSummary, ConversationSummary } from "@grogoni/shared-types";
import { apiCloudFetch } from "./lib/api";
import { daemonTaskUpdatedEvent } from "./daemon-chat";
import { daemonLaneWakeEvent } from "./hooks/useDaemonLane";

export function DaemonExecutionStatus({ execution }: { execution: ConversationExecutionSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await apiCloudFetch(`/v1/daemon/tasks/${encodeURIComponent(execution.taskId)}/retry`, {
        method: "POST",
        body: {}
      });
      window.dispatchEvent(new Event(daemonTaskUpdatedEvent));
      window.dispatchEvent(new Event("grogoni:conversation-updated"));
      window.dispatchEvent(new Event(daemonLaneWakeEvent));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="conversation-execution" role="status">
      <small>
        Daemon: {execution.status}
        {execution.errorCode ? ` · ${execution.errorCode}` : ""}
      </small>
      {execution.retryable ? (
        <button type="button" disabled={busy} onClick={() => void retry()}>
          {busy ? "Retrying…" : "Retry task"}
        </button>
      ) : null}
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}
export function BusinessAgentControls({
  conversationId,
  businessId,
  enabled
}: {
  conversationId: string;
  businessId: string;
  enabled: boolean;
}) {
  const [agentEnabled, setAgentEnabled] = useState(enabled);
  useEffect(() => setAgentEnabled(enabled), [enabled]);
  const [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  async function configure() {
    setBusy(true);
    try {
      await apiCloudFetch(`/v1/conversations/${conversationId}`, {
        method: "PATCH",
        body: { agentEnabled: !agentEnabled }
      });
      setAgentEnabled(!agentEnabled);
      setStatus(agentEnabled ? "Business agent disabled." : "Business agent enabled.");
      window.dispatchEvent(new Event(daemonTaskUpdatedEvent));
      window.dispatchEvent(new Event("grogoni:conversation-updated"));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Configuration failed.");
    } finally {
      setBusy(false);
    }
  }
  async function ask() {
    setBusy(true);
    setStatus("Business agent is working…");
    try {
      await apiCloudFetch("/v1/messages", {
        method: "POST",
        body: {
          conversationId,
          clientMessageId: `business-agent-${crypto.randomUUID()}`,
          content: { type: "text", text: question },
          agent: { businessId, message: question }
        }
      });
      setQuestion("");
      setStatus("Business agent replied.");
      window.dispatchEvent(new Event(daemonTaskUpdatedEvent));
      window.dispatchEvent(new Event("grogoni:conversation-updated"));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Business agent failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="business-agent-controls">
      <button type="button" onClick={() => void configure()} disabled={busy}>
        {agentEnabled ? "Disable business agent" : "Enable business agent"}
      </button>
      {agentEnabled ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <label>
            Ask business agent
            <input
              required
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !question.trim()}>
            Ask agent
          </button>
        </form>
      ) : null}
      {status ? <small role="status">{status}</small> : null}
    </div>
  );
}

export function ConversationExecutionControls({
  conversation,
  businessId
}: {
  conversation: ConversationSummary | undefined;
  businessId: string | null;
}) {
  if (conversation?.conversationType === "DAEMON") return null;
  if (
    conversation?.conversationType === "BUSINESS" &&
    businessId &&
    conversation.activeShopId === businessId
  )
    return (
      <BusinessAgentControls
        key={conversation.id}
        conversationId={conversation.id}
        businessId={businessId}
        enabled={conversation.businessAgentEnabled === true}
      />
    );
  return null;
}
