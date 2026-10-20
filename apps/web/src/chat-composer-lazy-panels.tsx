import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { lazy, Suspense, type ReactNode } from "react";
import { loadLazyModuleWithRecovery } from "./lazy-module-recovery";

export const ExternalMessagingAppPicker = lazy(() =>
  loadLazyModuleWithRecovery(
    "external-messaging-apps",
    () => import("./ExternalMessagingAppPicker")
  ).then((module) => ({ default: module.ExternalMessagingAppPicker }))
);

export const ComposerAttachmentWorkbench = lazy(() =>
  loadLazyModuleWithRecovery(
    "composer-attachments",
    () => import("./ComposerAttachmentWorkbench")
  ).then((module) => ({ default: module.ComposerAttachmentWorkbench }))
);

export const ChatHashtagCapabilityPicker = lazy(() =>
  loadLazyModuleWithRecovery(
    "composer-capabilities",
    () => import("./ChatHashtagCapabilityPicker")
  ).then((module) => ({ default: module.ChatHashtagCapabilityPicker }))
);
export function ChatComposerLazyPanel({
  children,
  label,
  moduleKey
}: {
  children: ReactNode;
  label: string;
  moduleKey: string;
}) {
  return (
    <LazyModuleErrorBoundary label={label} moduleKey={moduleKey}>
      <Suspense fallback={<p>Opening {label.toLowerCase()}…</p>}>{children}</Suspense>
    </LazyModuleErrorBoundary>
  );
}
