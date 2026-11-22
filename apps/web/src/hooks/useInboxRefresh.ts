import { subscribeAccountHints } from "../messaging/account-hints";
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
  /** `reconnect` skips each message's wait but keeps its attempt cap; `automatic` keeps both. */
  retryQueuedMessages: (options?: {
    automatic?: boolean;
    reconnect?: boolean;
    leftByEarlierPage?: boolean;
  }) => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
}) {
  const latest = useRef({ loadMessagingInbox, retryQueuedMessages, selectConversation });
  latest.current = { loadMessagingInbox, retryQueuedMessages, selectConversation };
  // The account the waiting messages were resent for on this page load.
  const resentOnLoadFor = useRef<string | null>(null);
  useEffect(() => {
    // Assistant conversations and inbox metadata do not need a device encryption key.
    // Refresh again when the key arrives so encrypted messages can then be decrypted.
    if (accountId === null) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || cancelled || document.visibilityState === "hidden") return;
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
    // Messages left waiting by an earlier page (closed or reloaded mid-send) go once the inbox
    // has loaded, not only on the next online or visibility event.
    void refresh().then(() => {
      if (cancelled || resentOnLoadFor.current === accountId) return;
      resentOnLoadFor.current = accountId;
      void latest.current.retryQueuedMessages({ leftByEarlierPage: true });
    });
    let interval: ReturnType<typeof setInterval>;
    const unsubscribe = subscribeAccountHints(
      accountId,
      () => void refresh(),
      (healthy) => {
        clearInterval(interval);
        interval = setInterval(() => void refresh(), healthy ? 30_000 : 4_000);
      }
    );
    interval = setInterval(() => void refresh(), 4_000);
    const onVisible = () => {
      if (document.visibilityState !== "hidden") {
        // Only messages due under their own backoff: not one still being sent from this page.
        void latest.current.retryQueuedMessages({ automatic: true });
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const onOnline = () => {
      void latest.current.retryQueuedMessages({ reconnect: true });
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
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
    };
  }, [accountId, activeConversationId, encryptionDeviceId, mode]);
}
