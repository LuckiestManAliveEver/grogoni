import { useEffect, useState } from "react";
import type { ConversationExecutionSummary } from "@grogoni/shared-types";
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
interface Selection {
  selectedModelId: string | null;
  available: boolean;
  errorCode: string | null;
  models: { id: string; label: string }[];
}
export function DaemonModelSelector({ conversationId }: { conversationId: string }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    setSelection(null);
    setError("");
    void apiCloudFetch<Selection>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/model`
    ).then(
      (value) => {
        if (!stopped) setSelection(value);
      },
      () => {
        if (!stopped) setError("Daemon availability is temporarily unavailable.");
      }
    );
    return () => {
      stopped = true;
    };
  }, [conversationId]);
  async function select(modelId: string) {
    setBusy(true);
    setError("");
    try {
      setSelection(
        await apiCloudFetch<Selection>(
          `/v1/conversations/${encodeURIComponent(conversationId)}/model`,
          { method: "PUT", body: { modelId } }
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch model.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="daemon-model-selector">
      <label>
        Daemon model{" "}
        <select
          aria-label="Daemon model"
          value={selection?.selectedModelId ?? ""}
          disabled={busy || !selection}
          onChange={(event) => void select(event.target.value)}
        >
          <option value="" disabled>
            {selection?.available === false ? "Unavailable" : "Choose model"}
          </option>
          {selection?.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      {busy ? <small role="status">Checking model…</small> : null}
      {error || selection?.available === false ? (
        <small role="status">{error || "Daemon unavailable. Your history is saved."}</small>
      ) : null}
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
