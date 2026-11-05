import { useEffect, useState } from "react";
import {
  assistantActions,
  type AssistantAction,
  type AssistantPermissionsView
} from "@grogoni/shared-types";
import { fetchFreshJson, putJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";

export function AssistantPermissionsChecklist({ conversationId }: { conversationId: string }) {
  const path = `/v1/conversations/${encodeURIComponent(conversationId)}/permissions`;
  const [view, setView] = useState<AssistantPermissionsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchFreshJson<AssistantPermissionsView>(path)
      .then((value) => {
        if (active && value.permissions) {
          setView(value);
          setError("");
        }
      })
      .catch((cause) => {
        if (active) setError(getErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [path, attempt]);
  async function change(action: AssistantAction, allowed: boolean) {
    if (saving || !view) return;
    setSaving(true);
    setError("");
    try {
      setView(await putJson<AssistantPermissionsView>(path, { [action]: allowed }));
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="assistant-permissions" aria-label="Assistant and model permissions">
      <h3>Agent and model permissions</h3>
      <p>
        These permissions apply to both your assistant and its selected model. Only Read and Edit
        start enabled. Your own app actions stay available.
      </p>
      <p>Store actions also require a signed-in account and the store’s access permissions.</p>
      {!view && !error ? <p role="status">Loading permissions…</p> : null}
      {view ? (
        <fieldset disabled={saving}>
          <legend>Allowed actions</legend>
          {assistantActions.map((action) => (
            <div key={action.id}>
              <label className="auth-option-row">
                <input
                  type="checkbox"
                  checked={view.permissions[action.id]}
                  onChange={(event) => void change(action.id, event.target.checked)}
                />
                <span>
                  <strong>{action.label}</strong> — {action.description}
                </span>
              </label>
              <details>
                <summary>Functions covered by {action.label.toLowerCase()}</summary>
                <ul>
                  {view.functions
                    .filter((fn) => fn.action === action.id)
                    .map((fn) => (
                      <li key={fn.id}>
                        {fn.label}
                        {fn.storeRelated ? " (store account required)" : ""}
                      </li>
                    ))}
                </ul>
                {action.id === "store" ? <p>Store setup, settings, staff and ownership.</p> : null}
              </details>
            </div>
          ))}
        </fieldset>
      ) : null}
      {error ? (
        <>
          <p role="alert">{error}</p>
          {!view ? (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Reload permissions
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
