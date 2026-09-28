import { Suspense, lazy, type ReactNode } from "react";

import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";

import { loadLazyModuleWithRecovery, workspaceModuleKeys } from "./lazy-module-recovery";

// Screens most owners open rarely load with their screen, not with the owner app (see
// scripts/check-web-bundle-budgets.mjs). The ones used on every visit stay in the owner chunk.
const SupplierSurface = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.supplierSurface,
    () => import("./SupplierSurface")
  ).then((module) => ({
    default: module.SupplierSurface
  }))
);
const PosTerminal = lazy(() =>
  loadLazyModuleWithRecovery(workspaceModuleKeys.posTerminal, () => import("./PosTerminal")).then(
    (module) => ({
      default: module.PosTerminal
    })
  )
);
const ImportSurface = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.importSurface,
    () => import("./ImportSurface")
  ).then((module) => ({
    default: module.ImportSurface
  }))
);
const LogisticsSurface = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.logisticsSurface,
    () => import("./LogisticsSurface")
  ).then((module) => ({
    default: module.LogisticsSurface
  }))
);
const ComplianceSurface = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.complianceSurface,
    () => import("./ComplianceSurface")
  ).then((module) => ({
    default: module.ComplianceSurface
  }))
);
const BetaSurface = lazy(() =>
  loadLazyModuleWithRecovery(workspaceModuleKeys.betaSurface, () => import("./BetaSurface")).then(
    (module) => ({
      default: module.BetaSurface
    })
  )
);
const LaunchSurface = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.launchSurface,
    () => import("./LaunchSurface")
  ).then((module) => ({
    default: module.LaunchSurface
  }))
);

export {
  SupplierSurface,
  PosTerminal,
  ImportSurface,
  LogisticsSurface,
  ComplianceSurface,
  BetaSurface,
  LaunchSurface
};

/**
 * The views whose screen loads lazily, and the recovery key each one loads under. The boundary
 * below keys itself workspaceScreenModuleKey(view), so these must match (tests/lazy-module-recovery-coverage).
 */
export const lazyWorkspaceScreens = {
  suppliers: workspaceModuleKeys.supplierSurface,
  pos: workspaceModuleKeys.posTerminal,
  imports: workspaceModuleKeys.importSurface,
  logistics: workspaceModuleKeys.logisticsSurface,
  compliance: workspaceModuleKeys.complianceSurface,
  beta: workspaceModuleKeys.betaSurface,
  launch: workspaceModuleKeys.launchSurface
} as const;

/** The recovery key a workspace view's boundary uses. */
export function workspaceScreenModuleKey(view: string): string {
  return `workspace-${view}`;
}

/** The open workspace screen, inside one recovery boundary so a lazily loaded screen can load. */
export function WorkspaceScreenBoundary(props: { view: string; children: ReactNode }) {
  return (
    <LazyModuleErrorBoundary
      key={props.view}
      moduleKey={workspaceScreenModuleKey(props.view)}
      label="This screen"
    >
      <Suspense fallback={<div className="inline-loading-card">Opening…</div>}>
        {props.children}
      </Suspense>
    </LazyModuleErrorBoundary>
  );
}
