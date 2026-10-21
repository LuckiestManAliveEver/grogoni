import { useEffect, useRef, useState } from "react";
import { currentOfflineScope, getOfflineState } from "../offline-runtime";
import { handoffChatMessages } from "../runtime-handoff";

import type {
  ConnectedMailboxSummary,
  ConversationInboxItem,
  ConversationMessageContent,
  ConversationMessageSummary,
  ConversationSummary,
  ConversationView,
  MessageHandoffStatus,
  RecycleBinStatusSummary
} from "@grogoni/shared-types";

import { deleteJson, getJson, patchJson, postJson } from "../api-helpers";
import {
  createInitialChatMessages,
  type ChatMessage,
  type ShellView,
  type GrogoniMode
} from "../app-shell";
import { navigateToOwnerRoute } from "../browser-navigation";
import { chatMessagesEqual } from "../chat-messages-equal";
import {
  agentProcessingFailureMessage,
  base64UrlToBytes,
  chatAttachmentsToConversationAttachments,
  conversationMessageText,
  conversationTitle,
  createClientMessageId,
  getConversationEncryptionDevices,
  getErrorMessage,
  isHumanDirectConversation,
  mapConversationMessage,
  mergePersistedEncryptedMessage,
  showMessageNotification
} from "../chat-message-plumbing";
import { decryptDirectMessage, encryptDirectMessage, type E2eeIdentity } from "../e2ee";
import { isRetryableApiRequestError } from "../lib/api";
import { readMessagingOutbox, removeMessagingOutboxEntry } from "../messaging/outbox";
import { replaceActorReaction, replaceMessageReactions } from "../optimistic-message-reactions";
import type {
  ActiveBusiness,
  ProcessedConversationMessageResponse,
  SessionResponse
} from "../grogoni-application-shared";

interface UseChatInboxStateDeps {
  business: ActiveBusiness | null;
  session: SessionResponse | null;
  e2eeIdentity: E2eeIdentity | null;
  mode: GrogoniMode;
  setStatusMessage: (message: string) => void;
  setView: (view: ShellView) => void;
  applySessionContextForConversation: (conversationId: string) => Promise<GrogoniMode | null>;
  requireMessagingSignIn: () => void;
  chatMessages: ChatMessage[];
  setChatMessages: (messages: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
  setChatDraft: (draft: string) => void;
  setReplyToMessageId: (messageId: string | null) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
}

export function useChatInboxState(deps: UseChatInboxStateDeps) {
  const [isMessagingInboxOpen, setIsMessagingInboxOpen] = useState(
    () => window.matchMedia("(min-width: 760px)").matches
  );
  useEffect(() => {
    const viewport = window.matchMedia("(min-width: 760px)");
    const change = (event: MediaQueryListEvent) => setIsMessagingInboxOpen(event.matches);
    viewport.addEventListener("change", change);
    return () => viewport.removeEventListener("change", change);
  }, []);
  const helpInitializedForAccount = useRef<string | null>(null);
  const [conversationInbox, setConversationInbox] = useState<ConversationInboxItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<ConversationView | null>(null);
  const [isContactTyping, setIsContactTyping] = useState(false);
  const [recycleBin, setRecycleBin] = useState<RecycleBinStatusSummary | null>(null);

  const {
    business,
    session,
    e2eeIdentity,
    mode,
    setStatusMessage,
    setView,
    applySessionContextForConversation,
    requireMessagingSignIn,
    chatMessages,
    setChatMessages,
    setChatDraft,
    setReplyToMessageId
  } = deps;

  // Deliberately never auto-selects or auto-creates a conversation when no valid preferred id is
  // given: the startup chat window stays blank (like a fresh ChatGPT tab) until the account picks
  // an existing chat from the sidebar or starts a new one via onCreateAgentSession/
  // onCreateConversation. See docs/frontend/frontend.md Phase 3 "New chat" affordance.
  async function loadMessagingInbox(preferredConversationId: string | null = activeConversationId) {
    if (session === null) return;
    const offlineScope = currentOfflineScope();
    if (offlineScope) {
      const local = (await getOfflineState(offlineScope)).runtimeHandoffSession;
      if (local) {
        setActiveConversationId(local.handoff.conversationId);
        setChatMessages(handoffChatMessages(local.messages));
      }
      return;
    }
    try {
      if (helpInitializedForAccount.current !== session.account.id) {
        try {
          await postJson("/v1/help", {});
          helpInitializedForAccount.current = session.account.id;
        } catch {
          setStatusMessage("Help is temporarily unavailable.");
        }
      }
      const response = await getJson<{ conversations: ConversationInboxItem[] }>(
        "/v1/conversations",
        (refreshed) =>
          setConversationInbox(
            refreshed.conversations.filter((item) => !item.taskParentConversationId)
          )
      );
      setConversationInbox(response.conversations.filter((item) => !item.taskParentConversationId));
      const selectedId =
        preferredConversationId !== null &&
        response.conversations.some((conversation) => conversation.id === preferredConversationId)
          ? preferredConversationId
          : null;
      if (selectedId !== null) {
        setActiveConversationId(selectedId);
        await loadConversationThread(selectedId);
      } else {
        if (activeConversationId !== null) setActiveConversationId(null);
        if (activeConversation !== null) setActiveConversation(null);
        // An unbound assistant thread is local until the user creates/selects a conversation.
        // Inbox polling must not erase that thread or its background replies.
        if (
          (preferredConversationId !== null || activeConversationId !== null) &&
          chatMessages.length > 0
        )
          setChatMessages([]);
      }
    } catch (error) {
      if (navigator.onLine) setStatusMessage(getErrorMessage(error));
    }
  }

  async function loadConversationThread(conversationId: string) {
    if (session === null) return;
    const offlineScope = currentOfflineScope();
    if (offlineScope) {
      const local = (await getOfflineState(offlineScope)).runtimeHandoffSession;
      if (local?.handoff.conversationId !== conversationId) {
        setStatusMessage("This conversation is unavailable on this device. Go online to open it.");
        return;
      }
      setChatMessages(handoffChatMessages(local.messages));
      return;
    }
    const view = await getJson<ConversationView>(`/v1/conversations/${conversationId}`);
    setActiveConversation(view);
    setIsContactTyping((view.typing ?? []).some((typing) => typing.actorId !== session.user.id));
    const mapped = await Promise.all(
      view.messages.map(async (message) => {
        if (message.content.type !== "encrypted") {
          return mapConversationMessage(message, view.participants, session);
        }
        if (e2eeIdentity === null) {
          return mapConversationMessage(message, view.participants, session, null);
        }
        try {
          const decrypted = await decryptDirectMessage({
            conversationId,
            content: message.content,
            identity: e2eeIdentity
          });
          return mapConversationMessage(message, view.participants, session, decrypted);
        } catch {
          return mapConversationMessage(message, view.participants, session, null);
        }
      })
    );
    const nextMessages =
      mapped.length > 0
        ? mapped
        : createInitialChatMessages(conversationTitle(view, session.account.id));
    setChatMessages((current) =>
      chatMessagesEqual(current, nextMessages) ? current : nextMessages
    );
    if (document.visibilityState === "visible") {
      await patchJson<ConversationView>(`/v1/conversations/${conversationId}`, { read: true });
    } else {
      const newest = view.messages.at(-1);
      if (
        newest !== undefined &&
        newest.authorId !== session.user.id &&
        Notification.permission === "granted"
      ) {
        void showMessageNotification({
          title: conversationTitle(view, session.account.id),
          body: conversationMessageText(newest),
          tag: `grogoni-message-${newest.id}`,
          conversationId
        });
      }
    }
  }

  async function selectConversation(conversationId: string) {
    const offlineScope = currentOfflineScope();
    if (offlineScope) {
      const local = (await getOfflineState(offlineScope)).runtimeHandoffSession;
      if (local?.handoff.conversationId !== conversationId) {
        setStatusMessage("Go online to open a conversation that has not moved to this device.");
        return;
      }
      setActiveConversationId(conversationId);
      setReplyToMessageId(null);
      setView("chat");
      setChatMessages(handoffChatMessages(local.messages));
      navigateToOwnerRoute({ mode, view: "chat", conversationId });
      return;
    }
    setActiveConversationId(conversationId);
    setReplyToMessageId(null);
    setView("chat");
    const restoredMode = await applySessionContextForConversation(conversationId);
    navigateToOwnerRoute({ mode: restoredMode ?? mode, view: "chat", conversationId });
    await loadConversationThread(conversationId);
  }

  // Creates a genuinely new personal agent session (not the ensurePersonalAccountConversation
  // singleton used at login) and switches to it, so the account can hold several independently
  // moded conversations with its own agent. See docs/frontend/frontend.md Phase 3.
  async function createAgentSession(title?: string) {
    if (session === null) {
      requireMessagingSignIn();
      return;
    }
    const created = await postJson<ConversationView>("/v1/conversations", {
      kind: "personal",
      activeShopId: null,
      ...(title?.trim() ? { title: title.trim() } : {})
    });
    await loadMessagingInbox(created.conversation.id);
    await selectConversation(created.conversation.id);
  }

  async function createDirectConversation(recipient: string, title: string) {
    if (session === null) {
      requireMessagingSignIn();
      return;
    }
    let created: ConversationView;
    if (business !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient.trim())) {
      const response = await getJson<{ mailboxes: ConnectedMailboxSummary[] }>(
        `/businesses/${business.id}/mailboxes`
      );
      const eligible = response.mailboxes.filter(
        (mailbox) => mailbox.status === "connected" && mailbox.canSend
      );
      const mailbox = eligible.find((candidate) => candidate.isDefault) ?? eligible[0];
      if (mailbox === undefined) {
        throw new Error(
          "Connect an authorized Gmail or Outlook mailbox in Agent settings before starting email."
        );
      }
      created = await postJson<ConversationView>(
        `/businesses/${business.id}/mailboxes/${encodeURIComponent(mailbox.id)}/conversations`,
        {
          recipientAddress: recipient.trim(),
          ...(title.trim().length === 0 ? {} : { displayName: title.trim() })
        }
      );
    } else {
      created = await postJson<ConversationView>("/v1/conversations", {
        kind: "personal",
        activeShopId: null,
        recipient,
        title
      });
    }
    await loadMessagingInbox(created.conversation.id);
    navigateToOwnerRoute({
      mode,
      view: "chat",
      conversationId: created.conversation.id
    });
    setStatusMessage(
      created.channels?.some((channel) => channel.provider === "email") === true
        ? "Email draft ready. Add a subject and message."
        : "Conversation created"
    );
  }

  async function updateConversationPreference(
    conversationId: string,
    preference: "archive" | "mute" | "pin"
  ) {
    const item = conversationInbox.find((conversation) => conversation.id === conversationId);
    if (!item) return;
    const body =
      preference === "archive"
        ? { archived: true }
        : preference === "pin"
          ? { pinned: !item.participant.pinnedAt }
          : {
              mutedUntil: item.participant.mutedUntil
                ? null
                : new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString()
            };
    await patchJson<ConversationView>(`/v1/conversations/${conversationId}`, body);
    // Archiving the conversation you're currently viewing goes back to the blank chat window
    // (loadMessagingInbox no longer auto-jumps to another chat); archiving a different one leaves
    // your current view untouched.
    await loadMessagingInbox(
      preference === "archive"
        ? activeConversationId === conversationId
          ? null
          : activeConversationId
        : conversationId
    );
  }

  // Deleting requires admin privileges server-side (the shop owner, or - for a personal chat with
  // no shop - an account that owns no business yet or owns one); a non-admin sees the server's
  // "ask an admin" message as a status banner. A full recycle bin (RECYCLE_BIN_CAPACITY_BYTES on
  // the API) surfaces the same way, pointing the user at emptying it.
  async function deleteConversation(conversationId: string) {
    try {
      await deleteJson<ConversationSummary>(`/v1/conversations/${conversationId}`);
      setStatusMessage("Chat moved to the recycle bin. It will be deleted for good in 14 days.");
      await loadMessagingInbox(
        activeConversationId === conversationId ? null : activeConversationId
      );
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function restoreConversation(conversationId: string) {
    try {
      await postJson<ConversationSummary>(`/v1/conversations/${conversationId}/restore`, {});
      setStatusMessage("Chat restored.");
      await loadRecycleBin();
      await loadMessagingInbox(activeConversationId);
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function loadRecycleBin() {
    try {
      setRecycleBin(await getJson<RecycleBinStatusSummary>("/v1/conversations/recycle-bin"));
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function emptyRecycleBin(conversationIds?: string[]) {
    try {
      const result = await postJson<{ purged: number }>("/v1/conversations/recycle-bin/empty", {
        ...(conversationIds === undefined ? {} : { conversationIds })
      });
      setStatusMessage(
        result.purged === 1
          ? "Deleted 1 chat for good."
          : `Deleted ${result.purged} chats for good.`
      );
      await loadRecycleBin();
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function renameConversation(conversationId: string, title: string) {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    await patchJson<ConversationView>(`/v1/conversations/${conversationId}`, { title: trimmed });
    await loadMessagingInbox(conversationId);
  }

  async function updateMessageAction(
    messageId: string,
    action: { text?: string; deleted?: boolean; reaction?: string | null }
  ) {
    if (activeConversationId === null) return;
    if (action.reaction !== undefined && session !== null) {
      const previousReactions =
        chatMessages.find((message) => message.id === messageId)?.reactions ?? [];
      setChatMessages((messages) =>
        replaceActorReaction(messages, messageId, session.user.id, action.reaction ?? null)
      );
      try {
        const updated = await patchJson<ConversationMessageSummary>(
          `/v1/conversations/${activeConversationId}/messages/${messageId}`,
          action
        );
        const confirmedReactions = (updated.reactions ?? []).map(({ actorId, emoji }) => ({
          actorId,
          emoji
        }));
        setChatMessages((messages) =>
          replaceMessageReactions(messages, messageId, confirmedReactions)
        );
        setActiveConversation((conversation) =>
          conversation === null
            ? conversation
            : {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === updated.id ? updated : message
                )
              }
        );
      } catch (error) {
        setChatMessages((messages) =>
          replaceMessageReactions(messages, messageId, previousReactions)
        );
        throw error;
      }
      return;
    }
    let request: typeof action | { content: ConversationMessageContent } = action;
    if (action.text !== undefined && isHumanDirectConversation(activeConversation, session)) {
      const current = chatMessages.find((message) => message.id === messageId);
      const devices = await getConversationEncryptionDevices(activeConversationId);
      request = {
        content: await encryptDirectMessage({
          conversationId: activeConversationId,
          devices,
          message: {
            text: action.text,
            attachments: chatAttachmentsToConversationAttachments(current?.attachments ?? [])
          }
        })
      };
    }
    await patchJson<ConversationMessageSummary>(
      `/v1/conversations/${activeConversationId}/messages/${messageId}`,
      request
    );
    await loadConversationThread(activeConversationId);
  }

  async function forwardMessage(messageId: string, targetConversationId: string) {
    if (activeConversation === null || session === null) return;
    const source = activeConversation.messages.find((message) => message.id === messageId);
    const rendered = chatMessages.find((message) => message.id === messageId);
    if (!source || !rendered) return;
    const target = await getJson<ConversationView>(`/v1/conversations/${targetConversationId}`);
    let content: ConversationMessageContent = {
      type: "text",
      text: rendered.body,
      attachments: chatAttachmentsToConversationAttachments(rendered.attachments ?? [])
    };
    if (isHumanDirectConversation(target, session)) {
      const devices = await getConversationEncryptionDevices(targetConversationId);
      content = await encryptDirectMessage({
        conversationId: targetConversationId,
        devices,
        message: {
          text: rendered.body,
          attachments: chatAttachmentsToConversationAttachments(rendered.attachments ?? [])
        }
      });
    }
    await postJson<ConversationMessageSummary>("/v1/messages", {
      conversationId: targetConversationId,
      clientMessageId: createClientMessageId("forward"),
      content,
      forwardedFromMessageId: source.id,
      clientTimestamp: new Date().toISOString()
    });
    setStatusMessage("Message forwarded");
  }

  async function requestMessagingNotifications() {
    if (!("Notification" in window)) {
      setStatusMessage("This browser does not support message notifications");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatusMessage("This browser does not support background push notifications");
      return;
    }
    const config = await getJson<{ enabled: boolean; publicKey: string | null }>("/v1/push/config");
    if (!config.enabled || !config.publicKey) {
      setStatusMessage("Background notifications are not configured on this deployment");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setStatusMessage("Notifications were not enabled");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(config.publicKey)
      }));
    const subscriptionJson = subscription.toJSON();
    await postJson("/v1/push/subscriptions", {
      endpoint: subscriptionJson.endpoint,
      expirationTime: subscriptionJson.expirationTime,
      keys: subscriptionJson.keys
    });
    setStatusMessage("Background message notifications enabled");
  }

  async function disableMessagingNotifications() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatusMessage("This browser does not support background push notifications");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription === null) {
      setStatusMessage("Background message notifications are already disabled");
      return;
    }
    await deleteJson("/v1/push/subscriptions", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    setStatusMessage("Background message notifications disabled on this device");
  }

  async function signalTyping(draft: string) {
    setChatDraft(draft);
    if (activeConversationId === null || session === null) return;
    await postJson<{ typing: unknown[] }>(`/v1/conversations/${activeConversationId}/typing`, {
      typing: draft.trim().length > 0
    }).catch(() => undefined);
  }

  function recordMessageHandoff(
    channel: "sms_external_app" | "platform_share_sheet",
    status: MessageHandoffStatus,
    normalizedErrorCode: string | null
  ) {
    if (session === null) return;
    void postJson("/v1/message-handoffs", {
      businessId: business?.id ?? null,
      conversationId: activeConversationId,
      channel,
      status,
      normalizedErrorCode
    }).catch(() => {
      // External handoffs must not be blocked by optional telemetry.
    });
  }

  function recordSmsHandoff(status: MessageHandoffStatus, normalizedErrorCode: string | null) {
    recordMessageHandoff("sms_external_app", status, normalizedErrorCode);
  }

  function recordPlatformHandoff(status: MessageHandoffStatus, normalizedErrorCode: string | null) {
    recordMessageHandoff("platform_share_sheet", status, normalizedErrorCode);
  }

  async function retryQueuedMessages() {
    if (!navigator.onLine || session === null) return;
    const accountId = session.account.id;
    const queued = readMessagingOutbox(accountId);
    for (const entry of queued) {
      try {
        const sent = await postJson<ProcessedConversationMessageResponse>(
          "/v1/messages",
          entry.payload
        );
        setChatMessages((messages) => {
          const reconciled = messages.map((message) =>
            (message.id === entry.clientMessageId || message.id === sent.id) &&
            session !== null &&
            activeConversation !== null
              ? sent.content.type === "encrypted"
                ? mergePersistedEncryptedMessage(message, sent)
                : mapConversationMessage(sent, activeConversation.participants, session)
              : message
          );
          if (
            sent.agentMessage === undefined ||
            session === null ||
            activeConversation === null ||
            reconciled.some((message) => message.id === sent.agentMessage?.id)
          ) {
            return reconciled;
          }
          return [
            ...reconciled,
            mapConversationMessage(sent.agentMessage, activeConversation.participants, session)
          ];
        });
        if (sent.processing?.status === "failed") {
          setStatusMessage(agentProcessingFailureMessage(sent.processing.errorCode));
          break;
        }
        removeMessagingOutboxEntry(accountId, entry.clientMessageId);
      } catch (error) {
        if (isRetryableApiRequestError(error)) break;
        removeMessagingOutboxEntry(accountId, entry.clientMessageId);
        setStatusMessage(getErrorMessage(error));
      }
    }
  }

  async function submitAgentResponseFeedback(messageId: string, correct: boolean) {
    if (business === null) return;
    await postJson(`/businesses/${business.id}/agent-runtime/feedback`, {
      messageId,
      correct
    });
    setStatusMessage(
      correct ? "Agent response marked correct." : "Agent response flagged for review."
    );
  }

  deps.registerReset("chat-inbox", () => {
    setConversationInbox([]);
    setActiveConversationId(null);
    setActiveConversation(null);
    setIsContactTyping(false);
    setRecycleBin(null);
    setIsMessagingInboxOpen(window.matchMedia("(min-width: 760px)").matches);
  });

  return {
    isMessagingInboxOpen,
    setIsMessagingInboxOpen,
    conversationInbox,
    setConversationInbox,
    activeConversationId,
    setActiveConversationId,
    activeConversation,
    setActiveConversation,
    isContactTyping,
    recycleBin,
    loadMessagingInbox,
    loadConversationThread,
    selectConversation,
    createAgentSession,
    createDirectConversation,
    updateConversationPreference,
    renameConversation,
    deleteConversation,
    restoreConversation,
    loadRecycleBin,
    emptyRecycleBin,
    updateMessageAction,
    forwardMessage,
    requestMessagingNotifications,
    disableMessagingNotifications,
    signalTyping,
    recordSmsHandoff,
    recordPlatformHandoff,
    retryQueuedMessages,
    submitAgentResponseFeedback
  };
}
