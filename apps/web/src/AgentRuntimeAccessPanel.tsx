import type { AgentContextSource } from "@grogoni/shared-types";

import type { AgentSettings } from "./grogoni-application-shared";

const contextSourceTypeOptions: AgentContextSource["type"][] = [
  "policy",
  "document",
  "owner_note",
  "context_script",
  "catalogue",
  "inventory",
  "customer",
  "supplier",
  "receipt",
  "order",
  "conversation"
];

export interface AgentRuntimeAccessPanelProps {
  draftAgent: AgentSettings;
  isEditing: boolean;
  updateAgent: (patch: Partial<AgentSettings>) => void;
  runtimeContextSources: AgentContextSource[];
  runtimeDetailsLoading: boolean;
  contextSourceTitle: string;
  setContextSourceTitle: (value: string) => void;
  contextSourceType: AgentContextSource["type"];
  setContextSourceType: (value: AgentContextSource["type"]) => void;
  contextSourceContent: string;
  setContextSourceContent: (value: string) => void;
  contextSourceSensitivity: AgentContextSource["sensitivity"];
  setContextSourceSensitivity: (value: AgentContextSource["sensitivity"]) => void;
  contextSourceCustomerVisible: boolean;
  setContextSourceCustomerVisible: (value: boolean) => void;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  submitContextSource: () => Promise<void>;
}

export function AgentRuntimeAccessPanel({
  draftAgent,
  isEditing,
  updateAgent,
  runtimeContextSources,
  runtimeDetailsLoading,
  contextSourceTitle,
  setContextSourceTitle,
  contextSourceType,
  setContextSourceType,
  contextSourceContent,
  setContextSourceContent,
  contextSourceSensitivity,
  setContextSourceSensitivity,
  contextSourceCustomerVisible,
  setContextSourceCustomerVisible,
  pendingProfileAction,
  runProfileAction,
  submitContextSource
}: AgentRuntimeAccessPanelProps) {
  return (
    <div className="record-form agent-runtime-panel">
      <div className="section-heading">
        <p className="eyebrow">Context manifest and executable skills</p>
        <h3>Runtime access</h3>
        <p>
          Context is retrieved only when relevant and authorized. Skill availability is independent
          of the active model.
        </p>
      </div>
      <div className="runtime-context-list">
        {runtimeContextSources.map((source) => (
          <article key={source.id}>
            <div>
              <strong>{source.title}</strong>
              <small>
                {source.type} · {source.sensitivity} · version {source.version}
              </small>
            </div>
            <span className={`model-badge ${source.status === "active" ? "status-ready" : ""}`}>
              {source.status}
            </span>
          </article>
        ))}
        {!runtimeDetailsLoading && runtimeContextSources.length === 0 ? (
          <p className="shell-note">No authorized context sources are available yet.</p>
        ) : null}
      </div>
      <label>
        Context source title
        <input
          type="text"
          value={contextSourceTitle}
          maxLength={160}
          placeholder="Example: Delivery policy"
          onChange={(event) => setContextSourceTitle(event.target.value)}
        />
      </label>
      <label>
        Context content
        <textarea
          value={contextSourceContent}
          rows={4}
          maxLength={4000}
          placeholder="Example: Deliveries within Nairobi are free above KSh 2,000. Outside Nairobi, delivery is charged at cost."
          onChange={(event) => setContextSourceContent(event.target.value)}
        />
      </label>
      <div className="runtime-field-grid">
        <label>
          Type
          <select
            value={contextSourceType}
            onChange={(event) =>
              setContextSourceType(event.target.value as AgentContextSource["type"])
            }
          >
            {contextSourceTypeOptions.map((type) => (
              <option key={type} value={type}>
                {type.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sensitivity
          <select
            value={contextSourceSensitivity}
            onChange={(event) =>
              setContextSourceSensitivity(event.target.value as AgentContextSource["sensitivity"])
            }
          >
            <option value="public">Public</option>
            <option value="internal">Internal (owner and staff)</option>
            <option value="confidential">Confidential (owner and staff)</option>
            <option value="restricted">Restricted (owner and staff)</option>
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={contextSourceCustomerVisible}
            onChange={(event) => setContextSourceCustomerVisible(event.target.checked)}
          />
          Visible to customers
        </label>
      </div>
      <button
        type="button"
        disabled={
          contextSourceTitle.trim().length === 0 ||
          contextSourceContent.trim().length === 0 ||
          pendingProfileAction !== null
        }
        onClick={() => void runProfileAction("agent-context-source", submitContextSource)}
      >
        Save context source
      </button>
      <div className="runtime-skill-list">
        {draftAgent.skillBindings.map((binding) => (
          <label className="checkbox-row" key={binding.skillId}>
            <input
              type="checkbox"
              checked={binding.enabled}
              disabled={!isEditing}
              onChange={(event) =>
                updateAgent({
                  skillBindings: draftAgent.skillBindings.map((candidate) =>
                    candidate.skillId === binding.skillId
                      ? { ...candidate, enabled: event.target.checked }
                      : candidate
                  )
                })
              }
            />
            <span>
              <strong>{binding.skillId}</strong>
              <small>
                v{binding.version} · confirmation {binding.requiredConfirmationLevel}
              </small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
