import type { AgentEvaluationSummary, AgentOwnerCorrection } from "@grogoni/shared-types";

import { formatDate } from "./formatters";
import type { AgentSettings } from "./grogoni-application-shared";

export interface AgentRetentionPanelProps {
  draftAgent: AgentSettings;
  isEditing: boolean;
  updateAgent: (patch: Partial<AgentSettings>) => void;
  evaluationSummary: AgentEvaluationSummary | null;
  correctionDraft: string;
  setCorrectionDraft: (value: string) => void;
  correctionCategory: AgentOwnerCorrection["category"];
  setCorrectionCategory: (value: AgentOwnerCorrection["category"]) => void;
  promoteCorrection: boolean;
  setPromoteCorrection: (value: boolean) => void;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  submitOwnerCorrection: () => Promise<void>;
  ownerCorrections: AgentOwnerCorrection[];
  disableOwnerCorrection: (correctionId: string) => Promise<void>;
}

export function AgentRetentionPanel({
  draftAgent,
  isEditing,
  updateAgent,
  evaluationSummary,
  correctionDraft,
  setCorrectionDraft,
  correctionCategory,
  setCorrectionCategory,
  promoteCorrection,
  setPromoteCorrection,
  pendingProfileAction,
  runProfileAction,
  submitOwnerCorrection,
  ownerCorrections,
  disableOwnerCorrection
}: AgentRetentionPanelProps) {
  return (
    <div className="record-form agent-runtime-panel">
      <div className="section-heading">
        <p className="eyebrow">Memory and evaluation</p>
        <h3>Retention, feedback, and corrections</h3>
        <p>
          Memory is bounded by shop and policy. Evaluation records outcomes, not hidden reasoning.
        </p>
      </div>
      <div className="runtime-policy-toggles">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draftAgent.memoryPolicy.ownerCorrectionsEnabled}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                memoryPolicy: {
                  ...draftAgent.memoryPolicy,
                  ownerCorrectionsEnabled: event.target.checked
                }
              })
            }
          />
          Remember active owner corrections
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draftAgent.memoryPolicy.customerConversationMemoryEnabled}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                memoryPolicy: {
                  ...draftAgent.memoryPolicy,
                  customerConversationMemoryEnabled: event.target.checked
                }
              })
            }
          />
          Customer conversation memory (consent required)
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draftAgent.evaluationPolicy.enabled}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                evaluationPolicy: {
                  ...draftAgent.evaluationPolicy,
                  enabled: event.target.checked
                }
              })
            }
          />
          Record privacy-safe evaluation events
        </label>
      </div>
      <div className="runtime-evaluation-summary">
        <strong>{evaluationSummary?.total ?? 0} evaluated events</strong>
        <span>{evaluationSummary?.success ?? 0} successful</span>
        <span>{evaluationSummary?.blocked ?? 0} policy-blocked</span>
        <span>{evaluationSummary?.failure ?? 0} failed</span>
        <span>{evaluationSummary?.clarifying ?? 0} needed clarification</span>
      </div>
      <div className="runtime-context-list" role="list" aria-label="Recent agent issues">
        {evaluationSummary?.recentEvents
          .filter((event) => event.outcome === "failure" || event.outcome === "blocked")
          .slice(0, 5)
          .map((event) => (
            <article key={event.id} role="listitem">
              <div>
                <strong>{event.eventType.replaceAll("_", " ")}</strong>
                <small>
                  Runtime {event.runtimeVersion} · {event.reason ?? "No reason recorded"} ·{" "}
                  {formatDate(event.createdAt)}
                </small>
              </div>
              <span className="model-badge">{event.outcome}</span>
            </article>
          ))}
      </div>
      <label>
        Owner correction
        <textarea
          value={correctionDraft}
          rows={3}
          placeholder="Example: Never offer free delivery outside Nairobi."
          onChange={(event) => setCorrectionDraft(event.target.value)}
        />
      </label>
      <div className="runtime-field-grid">
        <label>
          Correction type
          <select
            value={correctionCategory}
            onChange={(event) =>
              setCorrectionCategory(event.target.value as AgentOwnerCorrection["category"])
            }
          >
            <option value="instruction">Instruction</option>
            <option value="business_fact">Business fact</option>
            <option value="memory">Memory</option>
            <option value="response">Response</option>
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={promoteCorrection}
            onChange={(event) => setPromoteCorrection(event.target.checked)}
          />
          Promote to versioned instructions
        </label>
      </div>
      <button
        type="button"
        disabled={correctionDraft.trim().length === 0 || pendingProfileAction !== null}
        onClick={() => void runProfileAction("agent-owner-correction", submitOwnerCorrection)}
      >
        Save correction
      </button>
      <div className="runtime-correction-list">
        {ownerCorrections.slice(0, 5).map((correction) => (
          <article key={correction.id}>
            <div>
              <strong>{correction.category.replace("_", " ")}</strong>
              <p>{correction.correction}</p>
              <small>
                Runtime {correction.runtimeVersion}
                {correction.promotedToInstruction ? " · promoted" : " · memory only"}
              </small>
            </div>
            {correction.status === "active" ? (
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null}
                onClick={() =>
                  void runProfileAction(`disable-correction-${correction.id}`, () =>
                    disableOwnerCorrection(correction.id)
                  )
                }
              >
                Disable
              </button>
            ) : (
              <span className="model-badge">Disabled</span>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
