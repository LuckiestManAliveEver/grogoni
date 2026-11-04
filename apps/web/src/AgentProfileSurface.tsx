import { OfflineRuntimeSettings } from "./OfflineRuntimeSettings";
import { useRuntimeHandoff } from "./hooks/useRuntimeHandoff";
import type { ChatMessage } from "./app-shell";
import { Suspense, lazy, useEffect, useState } from "react";

import type {
  AccountShopSummary,
  AgentContextSource,
  AgentEvaluationSummary,
  AgentOwnerCorrection,
  AgentRuntimeReadiness,
  AgentRuntimeVersion
} from "@grogoni/shared-types";

import { copyTextToClipboard } from "./misc-browser-utils";
import { SettingsGroup } from "./SettingsGroup";
import { SalesPricingEscalationPanel, VoiceAndCarePanel } from "./AgentPolicyPanels";
import { AgentIdentityPanel } from "./AgentIdentityPanel";
import { AgentReadinessPanel } from "./AgentReadinessPanel";
import { AgentRetentionPanel } from "./AgentRetentionPanel";
import { AgentRuntimeAccessPanel } from "./AgentRuntimeAccessPanel";
import { DeleteAccountPanel } from "./DeleteAccountPanel";
import { NotificationsSessionsPanel } from "./NotificationsSessionsPanel";
import { ProtectedContextFilesPanel } from "./ProtectedContextFilesPanel";
import { PublicStorefrontPanel } from "./PublicStorefrontPanel";
import { ModelTemplateReportCardPanel } from "./ModelTemplateReportCardPanel";
import { ModelTemplateWorkbenchPanel } from "./ModelTemplateWorkbenchPanel";
import { ModelTemplateGovernancePanel } from "./ModelTemplateGovernancePanel";
import { YourShopsPanel } from "./YourShopsPanel";
import StaffCard from "./StaffCard";
import { agentProfileModuleKeys, loadLazyModuleWithRecovery } from "./lazy-module-recovery";
import { shopAfterLeaving } from "./stored-shop";

// Loaded only when the owner opens Settings -> AI providers, keeping it out of the owner route chunk.
const AiProvidersPanel = lazy(() =>
  loadLazyModuleWithRecovery(
    agentProfileModuleKeys.aiProvidersPanel,
    () => import("./AiProvidersPanel")
  ).then((module) => ({ default: module.AiProvidersPanel }))
);

import {
  IdentitySecurityPanel,
  activeBusinessStorageKey,
  type ActiveBusiness,
  type AgentSettings,
  type BusinessAgentProfileSummary,
  type OAuthProviderSummary,
  type SessionResponse
} from "./grogoni-application-shared";

import { postJson, putJson, getJson } from "./api-helpers";
import { createStorefrontUrl, normalizeGrogoniId } from "./grogoniid-and-storefront";
import { agentSettingsFromBusinessProfile } from "./owner-app-bootstrap";
import { getErrorMessage } from "./chat-message-plumbing";
import { buildAgentProfileUpdate } from "./agent-profile-payload";

export interface AgentProfileSurfaceProps {
  conversationId?: string | null;
  chatMessages?: ChatMessage[];
  accountId: string;
  identityLevel: SessionResponse["account"]["identityLevel"];
  agent: AgentSettings;
  business: ActiveBusiness;
  oauthProviders: OAuthProviderSummary[];
  ownerLabel: string;
  ownerUser: SessionResponse["user"] | null;
  registeredEmail: string | null;
  storefrontUrl: string;
  shops: AccountShopSummary[];
  onSwitchBusiness: (shop: AccountShopSummary) => void;
  onAgentChange: (agent: AgentSettings) => void;
  onIdentityLevelChange: (identityLevel: SessionResponse["account"]["identityLevel"]) => void;
  onAccountMerged: (session: SessionResponse) => void;
  onOwnerUserChange: (user: SessionResponse["user"]) => void;
  onBack: () => void;
  onDisableNotifications: () => Promise<void>;
  onEnableNotifications: () => Promise<void>;
  onLogout: () => void;
  onLogoutAll: () => void;
  onScheduleAccountDeletion: (input: {
    pin: string;
    confirmation: string;
    reason: string;
  }) => Promise<boolean>;
  isLoggingOut: boolean;
  /** Grogoni Home's menu drawer deep-links here from "Shop settings"/"Agent settings"/"Account
   *  settings" - which of this page's own SettingsGroups to open and scroll to on arrival. */
  initialOpenSection?: "business" | "agent" | "security" | null;
}

export function AgentProfileSurface({
  conversationId = null,
  chatMessages = [],
  accountId,
  identityLevel,
  agent,
  business,
  oauthProviders,
  ownerLabel,
  ownerUser,
  registeredEmail,
  storefrontUrl,
  shops,
  onSwitchBusiness,
  onAgentChange,
  onIdentityLevelChange,
  onAccountMerged,
  onOwnerUserChange,
  onBack,
  onDisableNotifications,
  onEnableNotifications,
  onLogout,
  onLogoutAll,
  onScheduleAccountDeletion,
  isLoggingOut,
  initialOpenSection = null
}: AgentProfileSurfaceProps) {
  const runtimeHandoff = useRuntimeHandoff(
    accountId,
    business.id,
    conversationId,
    JSON.stringify([agent.agentDefinitionId, agent.model, agent.runtimeVersion])
  );
  const [draftAgent, setDraftAgent] = useState(agent);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [contextPassword, setContextPassword] = useState("");
  const [contextUnlocked, setContextUnlocked] = useState(false);
  const [contextUnlockError, setContextUnlockError] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [runtimeReadiness, setRuntimeReadiness] = useState<AgentRuntimeReadiness | null>(null);
  const [runtimeVersions, setRuntimeVersions] = useState<AgentRuntimeVersion[]>([]);
  const [runtimeContextSources, setRuntimeContextSources] = useState<AgentContextSource[]>([]);
  const [evaluationSummary, setEvaluationSummary] = useState<AgentEvaluationSummary | null>(null);
  const [ownerCorrections, setOwnerCorrections] = useState<AgentOwnerCorrection[]>([]);
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [correctionCategory, setCorrectionCategory] =
    useState<AgentOwnerCorrection["category"]>("instruction");
  const [promoteCorrection, setPromoteCorrection] = useState(true);
  const [contextSourceTitle, setContextSourceTitle] = useState("");
  const [contextSourceType, setContextSourceType] =
    useState<AgentContextSource["type"]>("owner_note");
  const [contextSourceContent, setContextSourceContent] = useState("");
  const [contextSourceSensitivity, setContextSourceSensitivity] =
    useState<AgentContextSource["sensitivity"]>("internal");
  const [contextSourceCustomerVisible, setContextSourceCustomerVisible] = useState(false);
  const [runtimeDetailsLoading, setRuntimeDetailsLoading] = useState(false);
  const [pendingProfileAction, setPendingProfileAction] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) {
      setDraftAgent(agent);
    }
  }, [agent, isEditing]);

  useEffect(() => {
    void loadAgentProfile();
    void loadAgentRuntimeDetails();
  }, [accountId, business.id]);

  useEffect(() => {
    if (initialOpenSection === null) return;
    const sectionId =
      initialOpenSection === "business"
        ? "settings-group-business"
        : initialOpenSection === "agent"
          ? "settings-group-agent-behavior"
          : "settings-group-login-security";
    const target = document.getElementById(sectionId);
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [initialOpenSection]);

  async function runProfileAction(key: string, action: () => Promise<void>) {
    if (pendingProfileAction !== null) return;
    setPendingProfileAction(key);
    try {
      await action();
    } finally {
      setPendingProfileAction(null);
    }
  }

  async function loadAgentProfile() {
    try {
      const profile = await getJson<BusinessAgentProfileSummary>(
        `/businesses/${business.id}/agent-profile`
      );
      const nextAgent = agentSettingsFromBusinessProfile(profile, business);
      setDraftAgent(nextAgent);
      onAgentChange(nextAgent);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function loadAgentRuntimeDetails() {
    setRuntimeDetailsLoading(true);
    try {
      const [readiness, versions, contextSources, evaluations, corrections] = await Promise.all([
        getJson<AgentRuntimeReadiness>(`/businesses/${business.id}/agent-runtime/readiness`),
        getJson<AgentRuntimeVersion[]>(`/businesses/${business.id}/agent-runtime/versions`),
        getJson<AgentContextSource[]>(`/businesses/${business.id}/agent-runtime/context-sources`),
        getJson<AgentEvaluationSummary>(`/businesses/${business.id}/agent-runtime/evaluations`),
        getJson<AgentOwnerCorrection[]>(`/businesses/${business.id}/agent-runtime/corrections`)
      ]);
      setRuntimeReadiness(readiness);
      setRuntimeVersions(versions);
      setRuntimeContextSources(contextSources);
      setEvaluationSummary(evaluations);
      setOwnerCorrections(corrections);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    } finally {
      setRuntimeDetailsLoading(false);
    }
  }

  async function rollbackAgentRuntime(version: number) {
    try {
      await postJson(`/businesses/${business.id}/agent-runtime/versions/${version}/rollback`, {});
      await Promise.all([loadAgentProfile(), loadAgentRuntimeDetails()]);
      setIsEditing(false);
      setProfileMessage(`Runtime version ${version} restored as a new active version.`);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function submitOwnerCorrection() {
    const correction = correctionDraft.trim();
    if (correction.length === 0) return;
    try {
      await postJson<AgentOwnerCorrection>(`/businesses/${business.id}/agent-runtime/corrections`, {
        correction,
        category: correctionCategory,
        promoteToInstruction: promoteCorrection
      });
      setCorrectionDraft("");
      await Promise.all([loadAgentProfile(), loadAgentRuntimeDetails()]);
      setProfileMessage(
        promoteCorrection
          ? "Correction saved and promoted into a new runtime version."
          : "Correction saved as bounded agent memory."
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function submitContextSource() {
    const title = contextSourceTitle.trim();
    const content = contextSourceContent.trim();
    if (title.length === 0 || content.length === 0) return;
    try {
      await postJson<AgentContextSource>(
        `/businesses/${business.id}/agent-runtime/context-sources`,
        {
          type: contextSourceType,
          title,
          content,
          sensitivity: contextSourceSensitivity,
          customerVisible: contextSourceCustomerVisible,
          status: "active"
        }
      );
      setContextSourceTitle("");
      setContextSourceContent("");
      await loadAgentRuntimeDetails();
      setProfileMessage(`Context source "${title}" saved and authorized for retrieval.`);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function disableOwnerCorrection(correctionId: string) {
    try {
      await postJson(
        `/businesses/${business.id}/agent-runtime/corrections/${encodeURIComponent(
          correctionId
        )}/disable`,
        {}
      );
      await loadAgentRuntimeDetails();
      setProfileMessage("Correction disabled.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  function updateAgent(patch: Partial<AgentSettings>) {
    setDraftAgent((currentAgent) => ({ ...currentAgent, ...patch }));
  }

  function startEditing() {
    setDraftAgent(agent);
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraftAgent(agent);
    setIsEditing(false);
    setContextUnlocked(false);
    setContextPassword("");
    setContextUnlockError("");
  }

  async function saveAgent() {
    if (isSaving) return;
    const publicAgentId = normalizeGrogoniId(business.grogoniId);
    setIsSaving(true);
    try {
      const saved = await putJson<BusinessAgentProfileSummary>(
        `/businesses/${business.id}/agent-profile`,
        buildAgentProfileUpdate(draftAgent)
      );
      onAgentChange({
        ...agentSettingsFromBusinessProfile(saved, business),
        globalAgentId: publicAgentId,
        storefrontUrl: createStorefrontUrl(publicAgentId)
      });
      setIsEditing(false);
      setContextUnlocked(false);
      setContextPassword("");
      setContextUnlockError("");
      setProfileMessage(`Business runtime version ${saved.runtimeVersion} saved.`);
      void loadAgentRuntimeDetails();
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function copyStorefrontValue(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      setProfileMessage(`${label} copied.`);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  const hasUnsavedRuntimeChanges = JSON.stringify(draftAgent) !== JSON.stringify(agent);

  return (
    <main className="agent-profile-surface">
      <section className="agent-profile-header">
        <button className="secondary" type="button" onClick={onBack}>
          Back
        </button>
        <div className="agent-avatar" aria-hidden="true">
          {draftAgent.name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <p className="eyebrow">{business.name}</p>
          <h2>{draftAgent.name}</h2>
          <p aria-live="polite">AI business attendant · {runtimeHandoff.status}</p>
          <p className="shell-note">{runtimeHandoff.reason}</p>
        </div>
        <div className="agent-profile-actions">
          <button
            className="secondary"
            type="button"
            disabled={runtimeHandoff.disabled || isSaving || isLoggingOut}
            aria-busy={runtimeHandoff.busy}
            aria-describedby="runtime-handoff-guidance"
            title={runtimeHandoff.reason}
            onClick={() => void runtimeHandoff.toggle(chatMessages)}
          >
            {runtimeHandoff.label}
          </button>
          {runtimeHandoff.needsRecovery && (
            <button
              className="secondary"
              type="button"
              disabled={runtimeHandoff.busy}
              onClick={() => void runtimeHandoff.recover()}
            >
              Resume handoff
            </button>
          )}
          <button
            className="secondary"
            type="button"
            disabled={runtimeHandoff.busy}
            onClick={runtimeHandoff.refresh}
          >
            Refresh runtime
          </button>
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={() => void saveAgent()}
                disabled={isSaving || runtimeHandoff.busy}
                aria-busy={isSaving}
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
              <button className="secondary" type="button" onClick={cancelEditing}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={startEditing} disabled={runtimeHandoff.busy}>
                Edit
              </button>
              <button
                className="secondary"
                type="button"
                onClick={onLogout}
                disabled={isLoggingOut}
                aria-busy={isLoggingOut}
              >
                {isLoggingOut ? "Signing out…" : "Sign out"}
              </button>
            </>
          )}
        </div>
      </section>
      <p
        id="runtime-handoff-guidance"
        className="shell-note"
        role={runtimeHandoff.error ? "alert" : "status"}
      >
        {runtimeHandoff.error ||
          (runtimeHandoff.disabled && !runtimeHandoff.busy ? runtimeHandoff.reason : "")}
      </p>

      <section className="agent-settings-grid">
        <OfflineRuntimeSettings accountId={accountId} businessId={business.id} />
        <SettingsGroup
          id="settings-group-business"
          title="Business"
          description="Shops, storefront link, and runtime readiness"
          defaultOpen
        >
          <YourShopsPanel shops={shops} business={business} onSwitchBusiness={onSwitchBusiness} />
          <StaffCard
            businessId={business.id}
            businessName={business.name}
            viewerRole={business.role}
            onLeft={() => {
              const remaining = shopAfterLeaving(shops, business.id);
              if (remaining !== null) onSwitchBusiness(remaining);
              else {
                // No shop left: forget this one on the device, then start from the marketplace.
                localStorage.removeItem(activeBusinessStorageKey);
                window.location.assign("/");
              }
            }}
          />

          <PublicStorefrontPanel
            business={business}
            storefrontUrl={storefrontUrl}
            ownerLabel={ownerLabel}
            draftAgent={draftAgent}
            isEditing={isEditing}
            updateAgent={updateAgent}
            copyStorefrontValue={copyStorefrontValue}
          />

          <AgentReadinessPanel
            business={business}
            draftAgent={draftAgent}
            isEditing={isEditing}
            hasUnsavedRuntimeChanges={hasUnsavedRuntimeChanges}
            runtimeReadiness={runtimeReadiness}
            runtimeVersions={runtimeVersions}
            runtimeDetailsLoading={runtimeDetailsLoading}
            pendingProfileAction={pendingProfileAction}
            runProfileAction={runProfileAction}
            rollbackAgentRuntime={rollbackAgentRuntime}
          />
        </SettingsGroup>

        <SettingsGroup
          id="settings-group-agent-behavior"
          title="Agent behavior"
          description="Identity, voice, sales policy, context, and memory"
        >
          <AgentIdentityPanel
            draftAgent={draftAgent}
            isEditing={isEditing}
            updateAgent={updateAgent}
            activeAiModelId={agent.model}
            activeAiModel={undefined}
            // Agent-runtime readiness describes Grogoni's bounded prompt/tool runtime. It does not
            // prove that arbitrary repository source has a configured isolated backend adapter.
            backendAvailable={false}
          />

          <VoiceAndCarePanel
            draftAgent={draftAgent}
            isEditing={isEditing}
            updateAgent={updateAgent}
          />

          <SalesPricingEscalationPanel
            draftAgent={draftAgent}
            isEditing={isEditing}
            updateAgent={updateAgent}
          />

          <AgentRuntimeAccessPanel
            draftAgent={draftAgent}
            isEditing={isEditing}
            updateAgent={updateAgent}
            runtimeContextSources={runtimeContextSources}
            runtimeDetailsLoading={runtimeDetailsLoading}
            contextSourceTitle={contextSourceTitle}
            setContextSourceTitle={setContextSourceTitle}
            contextSourceType={contextSourceType}
            setContextSourceType={setContextSourceType}
            contextSourceContent={contextSourceContent}
            setContextSourceContent={setContextSourceContent}
            contextSourceSensitivity={contextSourceSensitivity}
            setContextSourceSensitivity={setContextSourceSensitivity}
            contextSourceCustomerVisible={contextSourceCustomerVisible}
            setContextSourceCustomerVisible={setContextSourceCustomerVisible}
            pendingProfileAction={pendingProfileAction}
            runProfileAction={runProfileAction}
            submitContextSource={submitContextSource}
          />

          <AgentRetentionPanel
            draftAgent={draftAgent}
            isEditing={isEditing}
            updateAgent={updateAgent}
            evaluationSummary={evaluationSummary}
            correctionDraft={correctionDraft}
            setCorrectionDraft={setCorrectionDraft}
            correctionCategory={correctionCategory}
            setCorrectionCategory={setCorrectionCategory}
            promoteCorrection={promoteCorrection}
            setPromoteCorrection={setPromoteCorrection}
            pendingProfileAction={pendingProfileAction}
            runProfileAction={runProfileAction}
            submitOwnerCorrection={submitOwnerCorrection}
            ownerCorrections={ownerCorrections}
            disableOwnerCorrection={disableOwnerCorrection}
          />
        </SettingsGroup>

        <SettingsGroup title="Model templates" description="Reports, workbench, and governance">
          <ModelTemplateReportCardPanel businessId={business.id} />
          <ModelTemplateWorkbenchPanel businessId={business.id} />
          <ModelTemplateGovernancePanel businessId={business.id} />
        </SettingsGroup>

        <SettingsGroup
          id="settings-group-ai-providers"
          title="AI providers"
          description="Ollama on the Grogoni machine and on-device models"
        >
          <Suspense fallback={<div className="inline-loading-card">Opening AI providers…</div>}>
            <AiProvidersPanel businessId={business.id} />
          </Suspense>
        </SettingsGroup>

        <SettingsGroup
          id="settings-group-login-security"
          title="Login & security"
          description="Passkeys, recovery, devices, and notifications"
        >
          <Suspense fallback={<div className="inline-loading-card">Opening account security…</div>}>
            <IdentitySecurityPanel
              accountId={accountId}
              identityLevel={identityLevel}
              business={business}
              oauthProviders={oauthProviders}
              ownerUser={ownerUser}
              registeredEmail={registeredEmail}
              onAccountMerged={onAccountMerged}
              onOwnerUserChange={onOwnerUserChange}
              onIdentityLevelChange={onIdentityLevelChange}
              pendingProfileAction={pendingProfileAction}
              runProfileAction={runProfileAction}
              profileMessage={profileMessage}
              setProfileMessage={setProfileMessage}
            />
          </Suspense>

          <NotificationsSessionsPanel
            accountId={accountId}
            businessId={business.id}
            pendingProfileAction={pendingProfileAction}
            runProfileAction={runProfileAction}
            setProfileMessage={setProfileMessage}
            onEnableNotifications={onEnableNotifications}
            onDisableNotifications={onDisableNotifications}
            onLogout={onLogout}
            onLogoutAll={onLogoutAll}
            isLoggingOut={isLoggingOut}
          />
        </SettingsGroup>

        <SettingsGroup title="Advanced" description="Protected context files and account deletion">
          <ProtectedContextFilesPanel
            draftAgent={draftAgent}
            isEditing={isEditing}
            isSaving={isSaving}
            updateAgent={updateAgent}
            saveAgent={saveAgent}
            contextPassword={contextPassword}
            setContextPassword={setContextPassword}
            contextUnlocked={contextUnlocked}
            setContextUnlocked={setContextUnlocked}
            contextUnlockError={contextUnlockError}
            setContextUnlockError={setContextUnlockError}
          />

          <DeleteAccountPanel
            business={business}
            pendingProfileAction={pendingProfileAction}
            runProfileAction={runProfileAction}
            setProfileMessage={setProfileMessage}
            onScheduleAccountDeletion={onScheduleAccountDeletion}
          />
        </SettingsGroup>
      </section>
    </main>
  );
}
