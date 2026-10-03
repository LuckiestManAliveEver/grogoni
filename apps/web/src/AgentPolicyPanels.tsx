import type { AgentInstructions, AgentPersonality } from "@grogoni/shared-types";
import type { AgentSettings } from "./grogoni-application-shared";

export interface AgentPolicyPanelProps {
  draftAgent: AgentSettings;
  isEditing: boolean;
  updateAgent: (patch: Partial<AgentSettings>) => void;
}

export function splitMultilineInput(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function VoiceAndCarePanel({ draftAgent, isEditing, updateAgent }: AgentPolicyPanelProps) {
  return (
    <div className="record-form agent-runtime-panel">
      <div className="section-heading">
        <p className="eyebrow">Structured personality</p>
        <h3>Voice and customer care</h3>
        <p>Style can shape wording, but it cannot override business or security policy.</p>
      </div>
      <div className="runtime-field-grid">
        <label>
          Tone
          <select
            value={draftAgent.personalityConfig.tone}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                personalityConfig: {
                  ...draftAgent.personalityConfig,
                  tone: event.target.value as AgentPersonality["tone"]
                }
              })
            }
          >
            <option value="warm">Warm</option>
            <option value="neutral">Neutral</option>
            <option value="direct">Direct</option>
            <option value="formal">Formal</option>
          </select>
        </label>
        <label>
          Formality
          <select
            value={draftAgent.personalityConfig.formality}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                personalityConfig: {
                  ...draftAgent.personalityConfig,
                  formality: event.target.value as AgentPersonality["formality"]
                }
              })
            }
          >
            <option value="casual">Casual</option>
            <option value="balanced">Balanced</option>
            <option value="formal">Formal</option>
          </select>
        </label>
        <label>
          Response length
          <select
            value={draftAgent.personalityConfig.responseLength}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                personalityConfig: {
                  ...draftAgent.personalityConfig,
                  responseLength: event.target.value as AgentPersonality["responseLength"]
                }
              })
            }
          >
            <option value="brief">Brief</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label>
          Selling style
          <select
            value={draftAgent.personalityConfig.sellingStyle}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                personalityConfig: {
                  ...draftAgent.personalityConfig,
                  sellingStyle: event.target.value as AgentPersonality["sellingStyle"]
                }
              })
            }
          >
            <option value="consultative">Consultative</option>
            <option value="informative">Informative</option>
            <option value="proactive">Proactive</option>
          </select>
        </label>
      </div>
      <label>
        Public introduction
        <textarea
          value={draftAgent.publicIntroduction}
          disabled={!isEditing}
          rows={2}
          onChange={(event) => updateAgent({ publicIntroduction: event.target.value })}
        />
      </label>
      <label>
        Additional style guidance
        <textarea
          value={draftAgent.personalityConfig.additionalGuidance}
          disabled={!isEditing}
          rows={3}
          onChange={(event) =>
            updateAgent({
              personality: event.target.value,
              personalityConfig: {
                ...draftAgent.personalityConfig,
                additionalGuidance: event.target.value
              }
            })
          }
        />
      </label>
    </div>
  );
}

export function SalesPricingEscalationPanel({
  draftAgent,
  isEditing,
  updateAgent
}: AgentPolicyPanelProps) {
  return (
    <div className="record-form agent-runtime-panel">
      <div className="section-heading">
        <p className="eyebrow">Structured business policy</p>
        <h3>Sales, pricing, and escalation</h3>
        <p>These rules are enforced server-side before a tool proposal can run.</p>
      </div>
      <div className="runtime-field-grid">
        <label>
          Maximum discount (%)
          <input
            type="number"
            min={0}
            max={100}
            value={draftAgent.instructionPolicy.maximumDiscountPercent}
            disabled={!isEditing}
            onChange={(event) =>
              updateAgent({
                instructionPolicy: {
                  ...draftAgent.instructionPolicy,
                  maximumDiscountPercent: Number(event.target.value)
                }
              })
            }
          />
        </label>
        <label>
          Maximum credit days
          <input
            type="number"
            min={0}
            max={3650}
            value={draftAgent.instructionPolicy.maximumCreditDays}
            disabled={!isEditing || !draftAgent.instructionPolicy.creditSalesAllowed}
            onChange={(event) =>
              updateAgent({
                instructionPolicy: {
                  ...draftAgent.instructionPolicy,
                  maximumCreditDays: Number(event.target.value)
                }
              })
            }
          />
        </label>
      </div>
      <div className="runtime-policy-toggles">
        {(
          [
            { key: "negotiationAllowed", label: "Allow negotiation" },
            { key: "creditSalesAllowed", label: "Allow credit sales" },
            { key: "substituteOutOfStockAllowed", label: "Allow stock substitutions" },
            { key: "catalogueModificationAllowed", label: "Allow catalogue changes" },
            { key: "externalMessagingAllowed", label: "Allow external messaging" }
          ] as const
        ).map(({ key, label }) => (
          <label className="checkbox-row" key={key}>
            <input
              type="checkbox"
              disabled={!isEditing}
              checked={Boolean(draftAgent.instructionPolicy[key as keyof AgentInstructions])}
              onChange={(event) =>
                updateAgent({
                  instructionPolicy: {
                    ...draftAgent.instructionPolicy,
                    [key]: event.target.checked
                  }
                })
              }
            />
            {label}
          </label>
        ))}
      </div>
      <label>
        General operating rules (one per line)
        <textarea
          value={draftAgent.instructionPolicy.generalOperatingRules.join("\n")}
          disabled={!isEditing}
          rows={4}
          onChange={(event) =>
            updateAgent({
              instructions: event.target.value,
              instructionPolicy: {
                ...draftAgent.instructionPolicy,
                generalOperatingRules: splitMultilineInput(event.target.value)
              }
            })
          }
        />
      </label>
      <label>
        Pricing rules (one per line)
        <textarea
          value={draftAgent.instructionPolicy.pricingRules.join("\n")}
          disabled={!isEditing}
          rows={3}
          onChange={(event) =>
            updateAgent({
              instructionPolicy: {
                ...draftAgent.instructionPolicy,
                pricingRules: splitMultilineInput(event.target.value)
              }
            })
          }
        />
      </label>
      <label>
        Escalation rules (one per line)
        <textarea
          value={draftAgent.instructionPolicy.escalationRules.join("\n")}
          disabled={!isEditing}
          rows={3}
          onChange={(event) =>
            updateAgent({
              instructionPolicy: {
                ...draftAgent.instructionPolicy,
                escalationRules: splitMultilineInput(event.target.value)
              }
            })
          }
        />
      </label>
    </div>
  );
}
