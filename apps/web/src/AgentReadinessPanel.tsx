import type { AgentRuntimeReadiness, AgentRuntimeVersion } from "@grogoni/shared-types";

import { formatDate } from "./formatters";
import type { ActiveBusiness, AgentSettings } from "./grogoni-application-shared";

export interface AgentReadinessPanelProps {
  business: ActiveBusiness;
  draftAgent: AgentSettings;
  isEditing: boolean;
  hasUnsavedRuntimeChanges: boolean;
  runtimeReadiness: AgentRuntimeReadiness | null;
  runtimeVersions: AgentRuntimeVersion[];
  runtimeDetailsLoading: boolean;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  rollbackAgentRuntime: (version: number) => Promise<void>;
}

export function AgentReadinessPanel({
  business,
  draftAgent,
  isEditing,
  hasUnsavedRuntimeChanges,
  runtimeReadiness,
  runtimeVersions,
  runtimeDetailsLoading,
  pendingProfileAction,
  runProfileAction,
  rollbackAgentRuntime
}: AgentReadinessPanelProps) {
  return (
    <div className="record-form agent-runtime-panel">
      <div className="section-heading">
        <p className="eyebrow">Business runtime</p>
        <h3>Readiness and versions</h3>
        <p>
          The server binds this agent to {business.name}, compiles policy, retrieves permitted
          context, and records the exact runtime version used for every turn.
        </p>
      </div>
      <div className="runtime-status-grid" aria-live="polite">
        <span
          className={`model-badge ${runtimeReadiness?.ready ? "status-ready" : "status-loading"}`}
        >
          {runtimeDetailsLoading
            ? "Checking…"
            : runtimeReadiness?.ready
              ? "Ready"
              : "Needs attention"}
        </span>
        <strong>
          Active version {runtimeReadiness?.runtimeVersion ?? draftAgent.runtimeVersion}
        </strong>
        {hasUnsavedRuntimeChanges ? (
          <span className="runtime-unsaved">Unsaved draft changes</span>
        ) : null}
      </div>
      {(runtimeReadiness?.issues ?? []).map((issue) => (
        <p className="security-warning" key={issue.code}>
          {issue.message}
        </p>
      ))}
      <div className="runtime-version-list" aria-label="Agent runtime version history">
        {runtimeVersions.slice(0, 5).map((version) => (
          <article key={version.id}>
            <div>
              <strong>Version {version.version}</strong>
              <small>
                {version.changeSummary} · {formatDate(version.createdAt)}
              </small>
            </div>
            {version.version !== runtimeReadiness?.runtimeVersion ? (
              <button
                className="secondary"
                type="button"
                disabled={isEditing || pendingProfileAction !== null}
                onClick={() =>
                  void runProfileAction(`runtime-rollback-${version.version}`, () =>
                    rollbackAgentRuntime(version.version)
                  )
                }
              >
                Restore as new version
              </button>
            ) : (
              <span className="model-badge status-ready">Active</span>
            )}
          </article>
        ))}
        {!runtimeDetailsLoading && runtimeVersions.length === 0 ? (
          <p className="shell-note">Save the profile to create its first version.</p>
        ) : null}
      </div>
    </div>
  );
}
