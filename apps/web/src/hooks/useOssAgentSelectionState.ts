import { useEffect, useRef } from "react";

import { getJson } from "../api-helpers";
import { hydrateAccountOssAgentManifests } from "../account-ai-assets";
import { agentSettingsFromBusinessProfile } from "../owner-app-bootstrap";
import type {
  ActiveBusiness,
  AgentSettings,
  BusinessAgentProfileSummary,
  SessionResponse
} from "../grogoni-application-shared";

interface UseOssAgentSelectionStateDeps {
  agentSettings: AgentSettings;
  setAgentSettings: (settings: AgentSettings) => void;
  business: ActiveBusiness | null;
  session: SessionResponse | null;
  isOnline: boolean;
  setupComplete: boolean;
  setStatusMessage: (message: string) => void;
}

/**
 * Hydrates the persisted logical agent and account manifest cache on a new device. Agent identity
 * is never selected, installed, or linked based on this device's hardware; runtime/model
 * capability discovery happens independently in the inference path.
 */
export function useOssAgentSelectionState(deps: UseOssAgentSelectionStateDeps): void {
  const automaticAgentSelectionRef = useRef(new Set<string>());
  const { agentSettings, setAgentSettings, business, session, isOnline, setupComplete } = deps;

  useEffect(() => {
    if (!setupComplete || !isOnline || session === null || business === null) {
      return;
    }

    const selectionKey = `${session.account.id}:${business.id}`;
    if (automaticAgentSelectionRef.current.has(selectionKey)) return;
    automaticAgentSelectionRef.current.add(selectionKey);
    let cancelled = false;
    let completed = false;

    void (async () => {
      const profile = await getJson<BusinessAgentProfileSummary>(
        `/businesses/${business.id}/agent-profile`
      );
      await hydrateAccountOssAgentManifests().catch(() => []);
      completed = true;
      if (!cancelled) {
        setAgentSettings(agentSettingsFromBusinessProfile(profile, business));
      }
    })()
      .catch(() => {
        // Discovery, storage, or persistence failures leave the safe built-in fallback active.
      })
      .finally(() => {
        if (!completed) automaticAgentSelectionRef.current.delete(selectionKey);
      });

    return () => {
      cancelled = true;
    };
    // Mirrors the original OwnerApp effect, which intentionally keyed off business?.id and
    // session?.account.id only - listing the full business/session objects (or setAgentSettings/
    // setStatusMessage from a fresh deps object each render) would re-run this effect, and
    // re-trigger a network round trip and possible agent reassignment, on every unrelated
    // business/session field change instead of only on an actual account/business switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSettings.agentDefinitionId, business?.id, isOnline, session?.account.id, setupComplete]);
}
