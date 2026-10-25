import { lazy, Suspense, useState } from "react";

import type { ActiveBusiness, AgentSettings } from "./grogoni-application-shared";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { loadLazyModuleWithRecovery } from "./lazy-module-recovery";
const QuickRuntimeSwitcher = lazy(() =>
  loadLazyModuleWithRecovery(
    "composer-runtime-switcher",
    () => import("./QuickRuntimeSwitcher")
  ).then((module) => ({ default: module.QuickRuntimeSwitcher }))
);
import { StackedModule } from "./StackedModule";

export interface ComposerModelSwitcherProps {
  agent: AgentSettings | null;
  business: ActiveBusiness | null;
  onAgentChange: (agent: AgentSettings) => void;
  onOpenAgentProfile: () => void;
  onBeforeOpen: () => void;
}

// Pulled out of ChatComposer to keep it under the modularity budget (scripts/check-boundaries.mjs)
// - the quick model/runtime pills and their panel are self-contained enough to own their own
// open/close state.
export function ComposerModelSwitcher({
  agent,
  business,
  onAgentChange,
  onOpenAgentProfile,
  onBeforeOpen
}: ComposerModelSwitcherProps) {
  const [modelPanelOpen, setModelPanelOpen] = useState(false);

  function openModelPanel() {
    onBeforeOpen();
    setModelPanelOpen(true);
  }

  function openModelLibrary() {
    onBeforeOpen();
    onOpenAgentProfile();
  }

  if (business === null) {
    return null;
  }

  return (
    <>
      {agent !== null ? (
        <button
          className="composer-pill"
          type="button"
          aria-label="Switch model or runtime"
          aria-haspopup="dialog"
          aria-expanded={modelPanelOpen}
          onClick={openModelPanel}
        >
          <span className="composer-pill-icon" aria-hidden="true">
            ⚙
          </span>
          <span className="composer-pill-label">{agent.model || "Model"}</span>
        </button>
      ) : null}
      <button
        className="composer-pill"
        type="button"
        aria-label="Open model library"
        onClick={openModelLibrary}
      >
        <span className="composer-pill-icon" aria-hidden="true">
          ▤
        </span>
        <span className="composer-pill-label">Library</span>
      </button>
      {agent !== null && modelPanelOpen ? (
        <StackedModule
          className="composer-model-module"
          moduleId="composer-model-panel"
          open={modelPanelOpen}
          title="Model and runtime"
          onClose={() => setModelPanelOpen(false)}
        >
          <LazyModuleErrorBoundary label="Model and runtime" moduleKey="composer-runtime-switcher">
            <Suspense fallback={<p>Opening model choices…</p>}>
              <QuickRuntimeSwitcher
                business={business}
                agent={agent}
                updateAgent={(patch) => onAgentChange({ ...agent, ...patch })}
                onAgentChange={onAgentChange}
              />
            </Suspense>
          </LazyModuleErrorBoundary>
          <button type="button" className="secondary" onClick={openModelLibrary}>
            Open full model library
          </button>
        </StackedModule>
      ) : null}
    </>
  );
}
