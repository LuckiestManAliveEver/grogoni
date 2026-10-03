import { useEffect, useState } from "react";
import type {
  InferenceProviderConnectionScope,
  InferenceProviderConnectionSummary,
  InferenceProviderConnectionTestResult,
  InferenceProviderSummary
} from "@grogoni/shared-types";

import { deleteJson, fetchFreshJson, postJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { InferencePolicyCard } from "./InferencePolicyCard";
import { OnDeviceModelsCard } from "./OnDeviceModelsCard";
import { isDeviceLocalInferenceAvailable, maskedKey, providerCardState } from "./ai-providers-view";

export interface AiProvidersPanelProps {
  businessId: string;
}

/**
 * Settings → AI providers. Lists the providers the backend has configured (GET /v1/ai/providers)
 * and this person's / this shop's own keys (GET /v1/ai/provider-connections). A key is sent once,
 * in the connect request, and is never shown again: after saving, only the server-provided
 * last-four hint is displayed. Connect / Replace / Test / Disconnect all go through the backend,
 * which verifies keys with the provider's cheapest safe check before storing them encrypted.
 */
export function AiProvidersPanel({ businessId }: AiProvidersPanelProps) {
  const [providers, setProviders] = useState<InferenceProviderSummary[]>([]);
  const [connections, setConnections] = useState<InferenceProviderConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [openProviderId, setOpenProviderId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [scopeDraft, setScopeDraft] = useState<InferenceProviderConnectionScope>("tenant");
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const deviceLocalAvailable = isDeviceLocalInferenceAvailable();

  async function load() {
    try {
      const [providerResponse, connectionResponse] = await Promise.all([
        fetchFreshJson<{ providers: InferenceProviderSummary[] }>("/v1/ai/providers"),
        fetchFreshJson<{ connections: InferenceProviderConnectionSummary[] }>(
          `/v1/ai/provider-connections?businessId=${encodeURIComponent(businessId)}`
        )
      ]);
      setProviders(providerResponse.providers);
      setConnections(connectionResponse.connections);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [businessId]);

  function openForm(providerId: string) {
    setOpenProviderId(providerId);
    setKeyDraft("");
    setScopeDraft("tenant");
    setMessage("");
  }

  function closeForm() {
    setOpenProviderId(null);
    setKeyDraft("");
  }

  async function connect(provider: InferenceProviderSummary) {
    const apiKey = keyDraft.trim();
    if (apiKey.length === 0) return;
    setBusyProviderId(provider.id);
    setMessage("");
    try {
      await postJson<InferenceProviderConnectionSummary>("/v1/ai/provider-connections", {
        providerId: provider.id,
        apiKey,
        scope: scopeDraft,
        ...(scopeDraft === "tenant" ? { businessId } : {})
      });
      closeForm();
      await load();
      setMessage(`${provider.displayName} connected.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      // The draft is cleared on success and on failure: a key never lingers in component state.
      setKeyDraft("");
      setBusyProviderId(null);
    }
  }

  async function test(
    provider: InferenceProviderSummary,
    connection: InferenceProviderConnectionSummary
  ) {
    setBusyProviderId(provider.id);
    setMessage("");
    try {
      const result = await postJson<InferenceProviderConnectionTestResult>(
        `/v1/ai/provider-connections/${encodeURIComponent(connection.id)}/test`,
        {}
      );
      await load();
      setMessage(
        result.health.status === "AVAILABLE"
          ? `${provider.displayName} key works.`
          : `${provider.displayName}: ${result.health.message ?? "the key could not be verified."}`
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusyProviderId(null);
    }
  }

  async function disconnect(
    provider: InferenceProviderSummary,
    connection: InferenceProviderConnectionSummary
  ) {
    setBusyProviderId(provider.id);
    setMessage("");
    try {
      await deleteJson<{ disconnected: true; id: string }>(
        `/v1/ai/provider-connections/${encodeURIComponent(connection.id)}`
      );
      await load();
      setMessage(`${provider.displayName} disconnected. Its key was deleted.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusyProviderId(null);
    }
  }

  return (
    <div className="record-form ai-providers-panel">
      <div className="section-heading">
        <p className="eyebrow">AI providers</p>
        <h3>Where your agent's models run</h3>
        <p>
          Your agent stays the same whichever provider runs its model. Connect your own API key to
          bill usage to your own account; keys are encrypted and never shown again.
        </p>
      </div>
      {message.length > 0 ? (
        <p className="shell-note" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {loading ? (
        <p className="shell-note" role="status">
          Loading providers…
        </p>
      ) : (
        <div className="connected-social-list" role="list" aria-label="AI providers">
          {providers.map((provider) => {
            const card = providerCardState({
              provider,
              connections,
              businessId,
              deviceLocalAvailable
            });
            const busy = busyProviderId === provider.id;
            const formOpen = openProviderId === provider.id;
            const connection = card.connection;
            return (
              <article
                className="connected-social-card ai-provider-card"
                role="listitem"
                key={provider.id}
              >
                <div>
                  <span>{provider.displayName}</span>
                  <strong>{card.status}</strong>
                  <p>{card.detail}</p>
                  {connection !== null ? (
                    <p className="form-hint">
                      API key{" "}
                      <span aria-label="hidden key">{maskedKey(connection.secretHint)}</span>
                    </p>
                  ) : null}
                </div>
                <div className="row-actions">
                  {formOpen ? (
                    <>
                      <label>
                        API key
                        <input
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={keyDraft}
                          onChange={(event) => setKeyDraft(event.target.value)}
                        />
                      </label>
                      <label>
                        Use for
                        <select
                          value={scopeDraft}
                          onChange={(event) =>
                            setScopeDraft(event.target.value as InferenceProviderConnectionScope)
                          }
                        >
                          <option value="tenant">This shop</option>
                          <option value="user">Just me</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={busy || keyDraft.trim().length === 0}
                        aria-busy={busy}
                        onClick={() => void connect(provider)}
                      >
                        {busy ? "Checking key…" : "Save key"}
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        disabled={busy}
                        onClick={closeForm}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {card.canConnect ? (
                        <button
                          type="button"
                          className={connection === null ? undefined : "secondary"}
                          disabled={busyProviderId !== null}
                          onClick={() => openForm(provider.id)}
                        >
                          {connection === null ? "Connect" : "Replace"}
                        </button>
                      ) : null}
                      {connection !== null ? (
                        <>
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            aria-busy={busy}
                            onClick={() => void test(provider, connection)}
                          >
                            Test
                          </button>
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void disconnect(provider, connection)}
                          >
                            Disconnect
                          </button>
                        </>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <OnDeviceModelsCard />
      {loading ? null : <InferencePolicyCard businessId={businessId} providers={providers} />}
    </div>
  );
}
