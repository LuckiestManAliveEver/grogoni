import { useEffect, useRef } from "react";
import type { GrogoniMode } from "../app-shell";
import { navigateToOwnerRoute, readCurrentOwnerRoute } from "../browser-navigation";

export function useInboxRefresh({
  accountId,
  encryptionDeviceId,
  mode,
  activeConversationId,
  loadMessagingInbox,
  retryQueuedMessages,
  selectConversation
}: {
  accountId: string | null;
  encryptionDeviceId: string | null;
  mode: GrogoniMode;
  activeConversationId: string | null;
  loadMessagingInbox: (preferred: string | null) => Promise<void>;
  retryQueuedMessages: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
}) {
  const latest = useRef({ loadMessagingInbox, retryQueuedMessages, selectConversation });
  latest.current = { loadMessagingInbox, retryQueuedMessages, selectConversation };
  useEffect(() => {
    // Assistant conversations and inbox metadata do not need a device encryption key.
    // Refresh again when the key arrives so encrypted messages can then be decrypted.
    if (accountId === null) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || cancelled) return;
      refreshing = true;
      try {
        const notificationConversationId = new URLSearchParams(window.location.search).get(
          "conversation"
        );
        const routeConversationId = readCurrentOwnerRoute()?.conversationId ?? null;
        if (!cancelled) {
          await latest.current.loadMessagingInbox(
            notificationConversationId ?? routeConversationId ?? activeConversationId
          );
        }
        if (notificationConversationId) {
          navigateToOwnerRoute(
            {
              mode,
              view: "chat",
              conversationId: notificationConversationId
            },
            { replace: true }
          );
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 4_000);
    const onOnline = () => {
      void latest.current.retryQueuedMessages();
      void refresh();
    };
    const onServiceWorkerMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; conversationId?: string };
      if (data.type === "message.notification.open" && data.conversationId) {
        void latest.current.selectConversation(data.conversationId);
      }
    };
    window.addEventListener("online", onOnline);
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
    };
  }, [accountId, activeConversationId, encryptionDeviceId, mode]);
}
