import { useEffect, useState } from "react";
import type { InferenceProviderSummary } from "@grogoni/shared-types";

import { fetchFreshJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { InferencePolicyCard } from "./InferencePolicyCard";
import { OnDeviceModelsCard } from "./OnDeviceModelsCard";
import { isDeviceLocalInferenceAvailable, providerCardState } from "./ai-providers-view";

export interface AiProvidersPanelProps {
  businessId: string;
}

/**
 * Settings → AI providers. Lists the providers the backend has configured (GET /v1/ai/providers).
 * Inference is local-only (docs/local-first-cloud-audit.md): server-side models run through Ollama
 * and on-device models on a member's own device, so there are no API keys to connect here.
 */
export function AiProvidersPanel({ businessId }: AiProvidersPanelProps) {
  const [providers, setProviders] = useState<InferenceProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const deviceLocalAvailable = isDeviceLocalInferenceAvailable();

  useEffect(() => {
    let active = true;
    fetchFreshJson<{ providers: InferenceProviderSummary[] }>("/v1/ai/providers")
      .then((response) => {
        if (active) setProviders(response.providers);
      })
      .catch((error: unknown) => {
        if (active) setMessage(getErrorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessId]);

  return (
    <div className="record-form ai-providers-panel">
      <div className="section-heading">
        <p className="eyebrow">AI providers</p>
        <h3>Where your agent's models run</h3>
        <p>
          Your agent stays the same whichever runtime runs its model. Models run through Ollama on
          the machine that runs Grogoni, or on a member's own device; nothing is sent to a cloud AI
          provider.
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
            const card = providerCardState({ provider, deviceLocalAvailable });
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
