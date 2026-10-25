import type { ChatComposerActions as ComposerActions } from "./ChatComposerActions";
import type { ChatChannelPicker as ChannelPicker } from "./ChatChannelPicker";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";
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

const LazyChannelPicker = lazy(() =>
  loadLazyModuleWithRecovery("composer-channels", () => import("./ChatChannelPicker")).then(
    (module) => ({ default: module.ChatChannelPicker })
  )
);
export function DeferredChatChannelPicker(props: ComponentProps<typeof ChannelPicker>) {
  return props.open ? (
    <ChatComposerLazyPanel label="Send via" moduleKey="composer-channels">
      <LazyChannelPicker {...props} />
    </ChatComposerLazyPanel>
  ) : null;
}

const LazyComposerActions = lazy(() =>
  loadLazyModuleWithRecovery("composer-actions", () => import("./ChatComposerActions")).then(
    (module) => ({ default: module.ChatComposerActions })
  )
);
export function DeferredChatComposerActions(props: ComponentProps<typeof ComposerActions>) {
  return props.open ? (
    <ChatComposerLazyPanel label="Message actions" moduleKey="composer-actions">
      <LazyComposerActions {...props} />
    </ChatComposerLazyPanel>
  ) : null;
}
