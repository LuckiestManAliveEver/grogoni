import { type FormEvent, useEffect, useState } from "react";
import type { OssAgentSummary } from "@grogoni/shared-types";

import { applyOssAgent, rankPortableOssAgents } from "./agent-catalog";
import { listInstalledOssAgentManifests } from "./oss-agent-installation";
import { hydrateAccountOssAgentManifests, installOssAgentForAccount } from "./account-ai-assets";
import type { AgentSettings, AiModelSummary } from "./grogoni-application-shared";

export interface AgentIdentityPanelProps {
  draftAgent: AgentSettings;
  isEditing: boolean;
  updateAgent: (patch: Partial<AgentSettings>) => void;
  activeAiModelId: string;
  activeAiModel: AiModelSummary | undefined;
  backendAvailable: boolean;
}

export function AgentIdentityPanel({
  draftAgent,
  isEditing,
  updateAgent,
  activeAiModelId,
  activeAiModel,
  backendAvailable
}: AgentIdentityPanelProps) {
  const [agentSearch, setAgentSearch] = useState("");
  const [agents, setAgents] = useState<OssAgentSummary[]>([]);
  const [catalogueMessage, setCatalogueMessage] = useState("Loading open-source agents…");
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [installedAgentIds, setInstalledAgentIds] = useState(
    () => new Set(listInstalledOssAgentManifests().map((manifest) => manifest.agent.id))
  );

  useEffect(() => {
    void loadOssAgents();
  }, []);

  async function loadOssAgents(search?: string) {
    setCatalogueLoading(true);
    const query = normalizeSearchText(search ?? "");
    try {
      const accountManifests = await hydrateAccountOssAgentManifests().catch(() => []);
      const merged = new Map<string, OssAgentSummary>();
      for (const manifest of accountManifests) {
        const item = manifest.agent;
        const haystack = normalizeSearchText(
          `${item.label} ${item.description} ${item.runtime} ${item.capabilities.join(" ")}`
        );
        if (query.length === 0 || haystack.includes(query)) {
          merged.set(item.id, item);
        }
      }
      setAgents([...merged.values()]);
      setInstalledAgentIds(
        new Set([
          ...listInstalledOssAgentManifests().map((manifest) => manifest.agent.id),
          ...accountManifests.map((manifest) => manifest.agent.id)
        ])
      );
      setCatalogueMessage("Showing locally installed agent definitions.");
    } catch {
      setAgents([]);
      setCatalogueMessage("Local agent catalogue is temporarily unavailable.");
    } finally {
      setCatalogueLoading(false);
    }
  }

  function searchAgents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadOssAgents(agentSearch);
  }

  async function downloadAndSelectAgent(definition: OssAgentSummary) {
    try {
      await installOssAgentForAccount(definition);
      setInstalledAgentIds(
        new Set(listInstalledOssAgentManifests().map((manifest) => manifest.agent.id))
      );
      updateAgent(applyOssAgent(draftAgent, definition));
      setCatalogueMessage(
        `${definition.label}'s portable manifest is saved to your account. Save to use the same logical agent on every signed-in device.`
      );
    } catch (error) {
      setCatalogueMessage(error instanceof Error ? error.message : "The manifest was not saved.");
    }
  }

  // Agent definitions are ranked by whether Grogoni can host/adapt them, never by the hardware of
  // the phone or browser currently rendering this screen. A saved definition stays visible if a
  // deployment adapter later becomes unavailable so the owner can still manage the profile.
  const agentOptions = rankPortableOssAgents({ agents, backendAvailable }).filter(
    (option) => option.status !== "unavailable" || installedAgentIds.has(option.agent.id)
  );

  return (
    <div className="record-form">
      <div className="section-heading">
        <p className="eyebrow">Identity</p>
        <h3>Agent profile</h3>
      </div>
      <div className="agent-catalog-heading">
        <div>
          <strong>Choose an open-source agent</strong>
          <small>
            Local agent definitions saved to this account. Grogoni uses them through the bounded
            runtime; the model and execution host remain separate.
          </small>
        </div>
        <span className="model-badge">Device independent</span>
      </div>
      <form className="agent-catalog-search" onSubmit={searchAgents}>
        <input
          aria-label="Search open-source agents"
          placeholder="Search agents, e.g. Shopkeeper"
          value={agentSearch}
          onChange={(event) => setAgentSearch(event.target.value)}
        />
        <button type="submit" className="secondary" disabled={catalogueLoading}>
          {catalogueLoading ? "Searching…" : "Search local agents"}
        </button>
      </form>
      <small className="agent-catalog-message" role="status">
        {catalogueMessage}
      </small>
      <div className="agent-catalog-list" aria-label="Open-source agent catalogue">
        {agentOptions.map(({ agent: definition, status, reason }) => {
          const selected = draftAgent.agentDefinitionId === definition.id;
          const installed = installedAgentIds.has(definition.id);
          return (
            <article
              className={`agent-catalog-card ${selected ? "selected" : ""}`}
              key={definition.id}
            >
              <div className="agent-catalog-card-heading">
                <div>
                  <strong>{definition.label}</strong>
                  <small>{definition.sourceId}</small>
                </div>
                <span className={`model-badge agent-fit-${status}`}>
                  {status === "hosted-ready"
                    ? "Hosted API"
                    : status === "backend-assisted"
                      ? "Backend assisted"
                      : "Unavailable"}
                </span>
              </div>
              <p>{definition.description}</p>
              <small>{reason}</small>
              <small>
                {definition.runtime} · {definition.minimumMemoryGb} GB minimum ·{" "}
                {definition.license} · {definition.popularity.toLocaleString()}{" "}
                {definition.source === "github" ? "stars" : "likes"}
              </small>
              {installed ? <small className="agent-installed-label">Saved to account</small> : null}
              <a href={definition.sourceUrl} target="_blank" rel="noreferrer">
                View on {definition.source === "github" ? "GitHub" : "Hugging Face"}
              </a>
              <button
                className={selected ? "secondary" : ""}
                type="button"
                disabled={!isEditing || status === "unavailable" || (selected && installed)}
                aria-pressed={selected}
                onClick={() => void downloadAndSelectAgent(definition)}
              >
                {selected && installed
                  ? "Selected"
                  : selected
                    ? "Save manifest"
                    : installed
                      ? "Use saved agent"
                      : "Save & use"}
              </button>
            </article>
          );
        })}
      </div>
      <label>
        Agent name
        <input
          value={draftAgent.name}
          disabled={!isEditing}
          onChange={(event) => updateAgent({ name: event.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          value={draftAgent.description}
          disabled={!isEditing}
          onChange={(event) => updateAgent({ description: event.target.value })}
          rows={3}
        />
      </label>
      <label>
        Current conversational model
        <input
          value={activeAiModel?.label ?? activeAiModelId}
          disabled
          aria-label="Current conversational model"
        />
        <small className="model-select-hint">
          The selected model runs through the local Ollama runtime. It becomes active only after a
          real local activation test succeeds.
        </small>
      </label>
      <label>
        Agent role
        <input
          value={draftAgent.role}
          disabled={!isEditing}
          onChange={(event) => updateAgent({ role: event.target.value })}
        />
      </label>
    </div>
  );
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}
