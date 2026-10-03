import { useEffect, useState } from "react";
import type { ExternalRegistryConnection, ExternalRegistryProvider } from "@grogoni/shared-types";

import { deleteJson, getJson, postJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";

interface ExternalConnectionsResponse {
  connections: ExternalRegistryConnection[];
}

interface ProviderCopy {
  label: string;
  description: string;
  tokenHint: string;
}

const PROVIDER_COPY: Record<ExternalRegistryProvider, ProviderCopy> = {
  github: {
    label: "GitHub",
    description: "Search public repositories",
    tokenHint: "Create a token at github.com/settings/tokens"
  },
  huggingface: {
    label: "Hugging Face",
    description: "Search public models",
    tokenHint: "Create a token at huggingface.co/settings/tokens"
  }
};

const PROVIDERS: readonly ExternalRegistryProvider[] = ["github", "huggingface"];

/**
 * Self-contained "connect your GitHub / Hugging Face account" panel. Connection status always
 * comes from GET /v1/external-connections (backend) - never inferred from any browser-local
 * token storage, since the token itself is never sent to the browser after it is saved. Owns its
 * own fetch/loading/message state so it can be dropped in anywhere (see IdentitySecurityPanel.tsx
 * for where it is mounted) without threading account/session props through a parent.
 */
export function ConnectedSourcesPanel() {
  const [connections, setConnections] = useState<ExternalRegistryConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [openProvider, setOpenProvider] = useState<ExternalRegistryProvider | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [busyProvider, setBusyProvider] = useState<ExternalRegistryProvider | null>(null);

  async function load() {
    try {
      const response = await getJson<ExternalConnectionsResponse>("/v1/external-connections");
      setConnections(response.connections);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function connectionFor(
    provider: ExternalRegistryProvider
  ): ExternalRegistryConnection | undefined {
    return connections.find(
      (connection) => connection.provider === provider && connection.status === "connected"
    );
  }

  async function connect(provider: ExternalRegistryProvider) {
    const token = tokenDraft.trim();
    if (token.length === 0) return;
    setBusyProvider(provider);
    setMessage("");
    try {
      await postJson<ExternalRegistryConnection>(`/v1/external-connections/${provider}`, {
        token
      });
      setTokenDraft("");
      setOpenProvider(null);
      await load();
      setMessage(`${PROVIDER_COPY[provider].label} connected.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusyProvider(null);
    }
  }

  async function disconnect(provider: ExternalRegistryProvider) {
    const connection = connectionFor(provider);
    if (connection === undefined) return;
    setBusyProvider(provider);
    setMessage("");
    try {
      await deleteJson<{ disconnected: true; id: string }>(
        `/v1/external-connections/${encodeURIComponent(connection.id)}`
      );
      await load();
      setMessage(`${PROVIDER_COPY[provider].label} disconnected.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <div className="record-form connected-sources-panel">
      <div className="section-heading">
        <p className="eyebrow">External registries</p>
        <h3>Connected sources</h3>
        <p>
          Connect a personal access token to raise API rate limits and reach private or gated
          resources when searching GitHub and Hugging Face from Grogoni. Tokens are encrypted at rest
          and never shown again once saved.
        </p>
      </div>
      {loading ? (
        <p className="shell-note" role="status">
          Loading connections…
        </p>
      ) : (
        <div className="connected-social-list" role="list" aria-label="Connected sources">
          {PROVIDERS.map((provider) => {
            const copy = PROVIDER_COPY[provider];
            const connection = connectionFor(provider);
            const busy = busyProvider === provider;
            const formOpen = openProvider === provider;

            return (
              <article className="connected-social-card" role="listitem" key={provider}>
                <div>
                  <span>{copy.label}</span>
                  <strong>
                    {connection === undefined
                      ? "Not connected"
                      : `Connected as ${connection.externalUsername ?? connection.externalAccountId ?? "unknown"}`}
                  </strong>
                  <p>{copy.description}</p>
                </div>
                <div className="row-actions">
                  {connection !== undefined ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => void disconnect(provider)}
                    >
                      {busy ? "Disconnecting…" : "Disconnect"}
                    </button>
                  ) : formOpen ? (
                    <>
                      <label>
                        Personal access token
                        <input
                          type="password"
                          autoComplete="off"
                          value={tokenDraft}
                          onChange={(event) => setTokenDraft(event.target.value)}
                        />
                      </label>
                      <p className="form-hint">{copy.tokenHint}</p>
                      <button
                        type="button"
                        disabled={busy || tokenDraft.trim().length === 0}
                        aria-busy={busy}
                        onClick={() => void connect(provider)}
                      >
                        {busy ? "Connecting…" : `Save ${copy.label} token`}
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setOpenProvider(null);
                          setTokenDraft("");
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busyProvider !== null}
                      onClick={() => {
                        setOpenProvider(provider);
                        setTokenDraft("");
                        setMessage("");
                      }}
                    >
                      Connect {copy.label}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {message.length > 0 ? (
        <p className="shell-note" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
