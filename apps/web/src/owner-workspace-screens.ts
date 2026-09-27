import { lazy } from "react";

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
