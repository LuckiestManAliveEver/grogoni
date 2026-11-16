import { lazy, Suspense } from "react";

import { NativeLaunchScreen } from "./BuildIdentity";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { loadLazyModuleWithRecovery, workspaceModuleKeys } from "./lazy-module-recovery";
import type { OwnerWorkspaceBindings } from "./OwnerWorkspace";

/** Type only: importing it from here does not load the workspace module. */
export type { OwnerWorkspaceBindings };

/**
 * The business workspace, loaded only when a workspace view is opened so its code stays out of
 * the owner route's static payload (scripts/check-web-bundle-budgets.mjs). A failed chunk load is
 * recovered or reported by the shared lazy-module recovery and error boundary.
 */
const OwnerWorkspace = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.ownerWorkspace,
    () => import("./OwnerWorkspace")
  ).then((module) => ({ default: module.renderOwnerWorkspace }))
);

export function LazyOwnerWorkspace(bindings: OwnerWorkspaceBindings) {
  return (
    <LazyModuleErrorBoundary
      moduleKey={workspaceModuleKeys.ownerWorkspace}
      label="Business workspace"
    >
      <Suspense fallback={<NativeLaunchScreen message="Opening workspace…" />}>
        <OwnerWorkspace {...bindings} />
      </Suspense>
    </LazyModuleErrorBoundary>
  );
}
