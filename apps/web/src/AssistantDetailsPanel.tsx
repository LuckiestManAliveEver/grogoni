import { useEffect, useState } from "react";
import {
  permanentDaemonDisplayName,
  type ConversationRuntimeSelection
} from "@grogoni/shared-types";
import { fetchFreshJson, putJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { StackedModule } from "./StackedModule";
import { AssistantPermissionsChecklist } from "./AssistantPermissionsChecklist";

/**
 * Details for the permanent daemon conversation ("My Assistant"): its ID, plus the agent engine
 * and model it runs on, each switchable from a list of choices the server can actually execute.
 */
export function AssistantDetailsPanel({
  conversationId,
  onClose
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const path = `/v1/conversations/${encodeURIComponent(conversationId)}/model`;
  const [selection, setSelection] = useState<ConversationRuntimeSelection | null>(null);
  // The choice being saved: shown in its drop-down until the server answers, so it does not
  // snap back to the old value while the model is checked (a failure restores the old one).
  const [pending, setPending] = useState<{ field: "agent" | "model"; id: string } | null>(null);
  const saving = pending?.field ?? null;
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchFreshJson<ConversationRuntimeSelection>(path)
      .then((result) => {
        if (!cancelled) {
          setSelection(result);
          setError("");
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(getErrorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [path, loadAttempt]);
  async function change(field: "agent" | "model", id: string) {
    if (saving !== null || selection === null) return;
    setPending({ field, id });
    setError("");
    setNotice("");
    try {
      const result = await putJson<ConversationRuntimeSelection>(
        path,
        field === "agent" ? { agentId: id } : { modelId: id }
      );
      setSelection(result);
      const label =
        field === "agent"
          ? result.agents.find((agent) => agent.id === result.selectedAgentId)?.label
          : result.models.find((model) => model.id === result.selectedModelId)?.label;
      // A model switch can also move off an engine this server no longer runs: say so.
      const agentLabel = result.agents.find((agent) => agent.id === result.selectedAgentId)?.label;
      const agentChanged =
        field === "model" && result.selectedAgentId !== selection.selectedAgentId && agentLabel;
      setNotice(
        agentChanged
          ? `${permanentDaemonDisplayName} now runs on ${label ?? id} with the ${agentLabel}.`
          : `${permanentDaemonDisplayName} now runs on ${label ?? id}.`
      );
      window.dispatchEvent(new Event("grogoni:conversation-updated"));
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }
  const agentMissing =
    selection !== null &&
    selection.selectedAgentId !== null &&
    !selection.agents.some((agent) => agent.id === selection.selectedAgentId);
  const modelMissing =
    selection !== null &&
    selection.selectedModelId !== null &&
    !selection.models.some((model) => model.id === selection.selectedModelId);
  return (
    <StackedModule
      moduleId="assistant-details"
      className="assistant-details"
      open
      title={`${permanentDaemonDisplayName} details`}
      onClose={onClose}
    >
      <dl className="assistant-details-list">
        <div>
          <dt>ID</dt>
          <dd>
            <code>{conversationId}</code>
          </dd>
        </div>
        <div>
          <dt>
            <label htmlFor="assistant-agent">Agent</label>
          </dt>
          <dd>
            <select
              id="assistant-agent"
              value={pending?.field === "agent" ? pending.id : (selection?.selectedAgentId ?? "")}
              disabled={selection === null || !selection.available}
              aria-busy={saving === "agent"}
              aria-describedby={
                selection !== null && !selection.available ? "assistant-agent-hint" : undefined
              }
              onChange={(event) => void change("agent", event.target.value)}
            >
              {selection?.selectedAgentId == null ? (
                <option value="" disabled hidden>
                  Not set
                </option>
              ) : null}
              {agentMissing ? (
                <option value={selection.selectedAgentId!}>{selection.selectedAgentId}</option>
              ) : null}
              {selection?.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div>
          <dt>
            <label htmlFor="assistant-model">Model</label>
          </dt>
          <dd>
            <select
              id="assistant-model"
              value={pending?.field === "model" ? pending.id : (selection?.selectedModelId ?? "")}
              disabled={selection === null || selection.models.length === 0}
              aria-busy={saving === "model"}
              onChange={(event) => void change("model", event.target.value)}
            >
              {selection?.selectedModelId == null ? (
                <option value="" disabled hidden>
                  Not set
                </option>
              ) : null}
              {modelMissing ? (
                <option value={selection.selectedModelId!}>{selection.selectedModelId}</option>
              ) : null}
              {selection?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </dd>
        </div>
      </dl>
      <AssistantPermissionsChecklist conversationId={conversationId} />
      {/* One live region that stays mounted, so screen readers announce each change. */}
      <p role="status" className="assistant-details-status">
        {selection === null && !error
          ? "Loading details…"
          : saving !== null
            ? `Checking the ${saving}…`
            : notice}
      </p>
      {selection !== null && !selection.available ? (
        <p role="alert">
          {selection.models.length > 0
            ? "The current model is unavailable. Pick another model."
            : "The current model is unavailable."}{" "}
          <small>({selection.errorCode ?? "unknown"})</small>
        </p>
      ) : null}
      {selection !== null && !selection.available ? (
        <p id="assistant-agent-hint">
          {selection.models.length > 0
            ? "Choose a model first. The agent can be switched once a model is running."
            : "No models are configured on this server yet."}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {error && selection === null ? (
        <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
          Try again
        </button>
      ) : null}
    </StackedModule>
  );
}
