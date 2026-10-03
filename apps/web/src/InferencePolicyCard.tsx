import { useEffect, useState } from "react";
import type {
  InferenceFallbackPolicyMode,
  InferencePolicySummary,
  InferenceProviderSummary
} from "@grogoni/shared-types";

import { fetchFreshJson, putJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";

export interface InferencePolicyCardProps {
  businessId: string;
  providers: InferenceProviderSummary[];
}

interface RoutedModelOption {
  id: string;
  displayName: string;
  providerId: string;
  enabled: boolean;
}

/**
 * Settings -> AI providers -> Spending and fallback, for owners and managers. Everything is
 * optional; empty means "no limit" and fallback defaults to Off, so a failed provider never moves a
 * conversation to another model unless the shop turns that on here, naming the models allowed.
 */
export function InferencePolicyCard({ businessId, providers }: InferencePolicyCardProps) {
  const [policy, setPolicy] = useState<InferencePolicySummary | null>(null);
  const [models, setModels] = useState<RoutedModelOption[]>([]);
  const [hidden, setHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchFreshJson<InferencePolicySummary>(
        `/v1/ai/policies/shop/${encodeURIComponent(businessId)}`
      ),
      fetchFreshJson<{ models: RoutedModelOption[] }>("/v1/ai/models")
    ])
      .then(([loaded, routed]) => {
        if (cancelled) return;
        setPolicy(loaded);
        setModels(routed.models.filter((model) => model.enabled));
      })
      .catch(() => {
        // Members without permission to manage the shop simply do not see this card.
        if (!cancelled) setHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (hidden || policy === null) return null;
  const current = policy;

  function update(patch: Partial<InferencePolicySummary>) {
    setPolicy({ ...current, ...patch });
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const saved = await putJson<InferencePolicySummary>(
        `/v1/ai/policies/shop/${encodeURIComponent(businessId)}`,
        {
          currency: current.currency,
          dailyBudget: current.dailyBudget,
          maxRequestsPerMinute: current.maxRequestsPerMinute,
          maxTokensPerRequest: current.maxTokensPerRequest,
          fallbackPolicy: current.fallbackPolicy,
          approvedProviderIds:
            current.fallbackPolicy === "APPROVED_PROVIDERS" ? current.approvedProviderIds : [],
          fallbackModelIds: current.fallbackPolicy === "NONE" ? [] : current.fallbackModelIds
        }
      );
      setPolicy(saved);
      setMessage("AI spending and fallback settings saved.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

  return (
    <div className="record-form inference-policy-card">
      <div className="section-heading">
        <p className="eyebrow">Spending and fallback</p>
        <h3>Limits for this shop's AI</h3>
        <p>
          Budgets count every provider this shop uses, including its own keys. Leave a field empty
          for no limit.
        </p>
      </div>
      {message.length > 0 ? (
        <p className="shell-note" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      <div className="runtime-field-grid">
        <label>
          Daily budget ({current.currency})
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={current.dailyBudget ?? ""}
            onChange={(event) => update({ dailyBudget: numberOrNull(event.target.value) })}
          />
        </label>
        <label>
          Messages per minute
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={current.maxRequestsPerMinute ?? ""}
            onChange={(event) => update({ maxRequestsPerMinute: numberOrNull(event.target.value) })}
          />
        </label>
        <label>
          If the chosen model fails
          <select
            value={current.fallbackPolicy}
            onChange={(event) =>
              update({ fallbackPolicy: event.target.value as InferenceFallbackPolicyMode })
            }
          >
            <option value="NONE">Stop and tell me (no fallback)</option>
            <option value="SAME_PROVIDER">Try another model from the same provider</option>
            <option value="APPROVED_PROVIDERS">Try models from providers I approve</option>
          </select>
        </label>
      </div>
      {current.fallbackPolicy === "APPROVED_PROVIDERS" ? (
        <fieldset className="inference-policy-choices">
          <legend>Providers allowed to receive this shop's conversations on fallback</legend>
          {providers
            .filter((provider) => provider.enabled && provider.type !== "local")
            .map((provider) => (
              <label key={provider.id}>
                <input
                  type="checkbox"
                  checked={current.approvedProviderIds.includes(provider.id)}
                  onChange={() =>
                    update({
                      approvedProviderIds: toggle(current.approvedProviderIds, provider.id)
                    })
                  }
                />
                {provider.displayName}
              </label>
            ))}
        </fieldset>
      ) : null}
      {current.fallbackPolicy !== "NONE" ? (
        <fieldset className="inference-policy-choices">
          <legend>Fallback models, tried in this order</legend>
          {models.map((model) => (
            <label key={model.id}>
              <input
                type="checkbox"
                checked={current.fallbackModelIds.includes(model.id)}
                onChange={() =>
                  update({ fallbackModelIds: toggle(current.fallbackModelIds, model.id) })
                }
              />
              {model.displayName}
            </label>
          ))}
        </fieldset>
      ) : null}
      <button type="button" disabled={saving} aria-busy={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save limits"}
      </button>
    </div>
  );
}
