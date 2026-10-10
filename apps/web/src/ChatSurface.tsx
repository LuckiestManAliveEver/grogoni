import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";

import type { CountryCode } from "libphonenumber-js";
import type { Scope } from "@grogoni/offline-runtime";

import type {
  ConversationMessageContent,
  MessageDeliveryAttemptSummary
} from "@grogoni/shared-types";

import { readStableDeviceId } from "./lib/api";

import { detectCapabilitySettings } from "./capability-profile";
import { recordReadiness } from "./performance";

import { AuthenticationActionMessage } from "./AuthenticationActionMessage";
import { useOwnerCore } from "./hooks/OwnerCoreContext";
import { useChatComposerState } from "./hooks/useChatComposerState";
import { useCompactViewport } from "./hooks/useCompactViewport";
import { ChatComposer } from "./ChatComposer";
import { ConversationAttachmentCard } from "./ConversationAttachmentCard";
import { ConversationListPanel } from "./ConversationListPanel";

import { SmsHandoffDialog } from "./grogoni-application-shared";
import { renderGeneratedSurface } from "./generated-surface-registry";

import { getJson } from "./api-helpers";
import { formatFileSize, formatMessageTime } from "./formatters";

import { viewLabel } from "./agent-command-engine";
import {
  conversationMessageText,
  isRedundantAgentErrorMessage,
  getErrorMessage
} from "./chat-message-plumbing";

import { ShopPresenceButtons } from "./ShopPresenceButtons";

import { MarketplaceModeCard } from "./MarketplaceModeCard";
import { StorefrontPreviewCard } from "./StorefrontPreviewCard";
import { ShopHubEntryCard, ShopHubSkeleton } from "./ShopHubEntryCard";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { loadLazyModuleWithRecovery, workspaceModuleKeys } from "./lazy-module-recovery";
import { shopHubCopy } from "./shop-hub-copy";
import type { ShopHubSurface } from "./shop-hub-surfaces";
import { workspaceModuleClassName, workspacePanelTitle } from "./workspace-panel-title";
import { MerchantWorkspaceDashboard } from "./MerchantWorkspaceDashboard";
import { NetworkSyncNestedCard } from "./NetworkSyncNestedCard";
import { CatalogueNestedCard } from "./CatalogueNestedCard";
import { StackedModule } from "./StackedModule";
import type { ChatSurfaceProps } from "./chat-surface-contracts";
export type { ChatSurfaceProps } from "./chat-surface-contracts";

const ShopHub = lazy(() =>
  loadLazyModuleWithRecovery(workspaceModuleKeys.shopHub, () => import("./ShopHub")).then(
    (module) => ({ default: module.ShopHub })
  )
);

// Grogoni Home's "trace" affordance (hidden by default, toggled by the header's capability-trace
// button): names the real capability that produced a generated card, instead of the mockup's
// scripted stand-in text. Content types with no capability behind them (plain text, confirmation
// prompts, the owner-controls menu) intentionally return null and show no trace.
const capabilityTraceLabels: Partial<Record<ConversationMessageContent["type"], string>> = {
  "product-capture-progress": "product.capture",
  "status-broadcast": "messaging.broadcast",
  "unified-checkout": "commerce.checkout",
  "product-management": "product.update",
  "supplier-management": "supplier.update",
  "customer-management": "customer.update",
  "invoice-management": "invoice.draft",
  "payment-management": "payment.record",
  "import-management": "document_import.confirm",
  "logistics-management": "logistics.update_status"
};

function capabilityTraceLabel(content: ConversationMessageContent | undefined): string | null {
  if (content === undefined) return null;
  return capabilityTraceLabels[content.type] ?? null;
}

const homeSuggestionPrompts = ["Find me 50kg maize nearby", "Track my delivery", "Talk to a shop"];

export function ChatSurface({
  activeConversationId,
  chatDraft,
  initialEmailSubject,
  channelEndpoints,
  children,
  conversations,
  invoices,
  messages,
  isInboxOpen,
  isContactTyping,
  isConfirming,
  isSending,
  isBrowserGenerating,
  securityLabel,
  replyToMessageId,
  marketplaceIntroComplete,
  marketplaceShortcutOpen,
  networkGraph,
  networkDevicePhonebook,
  networkInvites,
  oauthProviders,
  oauthProvidersLoaded,
  pendingAttachments,
  productForm,
  productFields,
  productCount,
  products,
  publicStorefronts,
  publicStorefrontsLoading,
  shopPresenceStatus,
  workspaceOpen,
  buyFeed,
  isSearchingBuyFeed,
  buyCart,
  isCheckingOut,
  onAttachmentChange,
  onSellerPhotoCapture,
  onStatusBroadcastPosted,
  onSearchBuyFeed,
  onAddToCart,
  onRemoveFromCart,
  onCheckout,
  onRefreshInvoices,
  onBackToChat,
  onCloseMarketplace,
  onCloseWorkspace,
  onDraftChange,
  onSelectConversation,
  onCreateConversation,
  onCreateAgentSession,
  onRequireSignIn,
  onSignUp,
  onLogIn,
  recognizedDeviceLabel,
  onRefreshPublicStorefronts,
  onConversationPreference,
  onRenameConversation,
  recycleBin,
  onDeleteConversation,
  onRestoreConversation,
  onLoadRecycleBin,
  onEmptyRecycleBin,
  onEnableNotifications,
  onInboxOpenChange,
  onReply,
  onCancelReply,
  onEditMessage,
  onDeleteMessage,
  onReactMessage,
  onAgentFeedback,
  onForwardMessage,
  onRetryMessages,
  onNavigate,
  onOpenWorkspace,
  onModeChange,
  onOpenAgentProfile,
  onCompleteMarketplaceIntro,
  onProductEdit,
  onProductFieldsSave,
  onProductFormChange,
  onProductRemove,
  onProductReset,
  onProductSave,
  onProductsDuplicated,
  onNetworkDisconnectSource,
  onNetworkPhoneContactsSync,
  onNetworkInviteContacts,
  onNetworkConnectionAction,
  onNetworkProviderOAuth,
  onNetworkRefresh,
  onRemoveAttachment,
  onStatusChange,
  onConfirm,
  onSend,
  onCancelGeneration,
  onSmsHandoff,
  onPlatformHandoff
}: ChatSurfaceProps) {
  // Identity/business/agent/nav state ChatSurface doesn't own itself but forwards to the domain
  // surfaces it wraps (renderOwnerWorkspace()'s switch result renders inside ChatSurface's
  // children) - read directly from OwnerCoreContext instead of threading through OwnerApp's JSX
  // call site as props, since ChatSurface is the parent of those surfaces, not a peer of them.
  // Kept under the same local names the rest of this component already uses throughout.
  const { session, business, agentSettings, setAgentSettings, view, mode } = useOwnerCore();
  const activeView = view;
  const agent = agentSettings;
  const businessId = business?.id ?? null;
  const businessName = business?.name ?? "Your shop";
  const hasBusiness = business !== null;
  const isAuthenticated = session !== null;
  const grogoniId = business?.grogoniId ?? "Not set up yet";
  const smsDefaultCountry = (session?.user.phoneCountryCode as CountryCode | undefined) ?? "KE";
  // Bluetooth "Send via" only makes sense for a business's own device pairing (see
  // peer-messaging.ts) - a signed-out or business-less session never surfaces the option.
  const nearbyScope: Scope | null =
    session !== null && business !== null
      ? { accountId: session.account.id, storeId: business.id, deviceId: readStableDeviceId() }
      : null;

  const isCompactViewport = useCompactViewport();
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const defaultMessageWindow = useRef(detectCapabilitySettings().messageWindowSize).current;
  const [messageWindowSize, setMessageWindowSize] = useState(defaultMessageWindow);
  const [inboxSearch, setInboxSearch] = useState("");
  const [editingTopic, setEditingTopic] = useState<string | null>(null);
  const [isNewConversationOpen, setIsNewConversationOpen] = useState(false);
  const [newRecipient, setNewRecipient] = useState("");
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
  const [activeMessageMenuId, setActiveMessageMenuId] = useState<string | null>(null);
  const [openDeliveryAttemptsMessageId, setOpenDeliveryAttemptsMessageId] = useState<string | null>(
    null
  );
  const [deliveryAttemptsByMessage, setDeliveryAttemptsByMessage] = useState<
    Record<string, MessageDeliveryAttemptSummary[]>
  >({});
  const [deliveryAttemptsLoading, setDeliveryAttemptsLoading] = useState<string | null>(null);
  const [deliveryAttemptsError, setDeliveryAttemptsError] = useState<string | null>(null);

  async function toggleDeliveryAttempts(messageId: string) {
    if (openDeliveryAttemptsMessageId === messageId) {
      setOpenDeliveryAttemptsMessageId(null);
      return;
    }
    setOpenDeliveryAttemptsMessageId(messageId);
    if (activeConversationId === null || deliveryAttemptsByMessage[messageId] !== undefined) return;
    setDeliveryAttemptsLoading(messageId);
    setDeliveryAttemptsError(null);
    try {
      const response = await getJson<{ attempts: MessageDeliveryAttemptSummary[] }>(
        `/v1/conversations/${encodeURIComponent(activeConversationId)}/messages/${encodeURIComponent(
          messageId
        )}/delivery-attempts`
      );
      setDeliveryAttemptsByMessage((current) => ({ ...current, [messageId]: response.attempts }));
    } catch (error) {
      setDeliveryAttemptsError(getErrorMessage(error));
    } finally {
      setDeliveryAttemptsLoading(null);
    }
  }
  const [forwardingMessageId, setForwardingMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [workspaceCardView, setWorkspaceCardView] = useState<
    | "cards"
    | "catalogue"
    | "addProduct"
    | "editProduct"
    | "deleteProduct"
    | "manageFields"
    | "networkSync"
    | "storefrontPreview"
    | "businessDashboard"
  >("cards");
  function openBusinessDashboard() {
    setWorkspaceCardView("businessDashboard");
    onRefreshInvoices();
  }
  function openShopHubSurface(surface: ShopHubSurface) {
    if (surface.kind === "view") {
      // Close first: leaving /sell/shop restores the plain seller route, and the view change must
      // land after that restore rather than be reset by it.
      onCloseWorkspace();
      onNavigate(surface.view);
    } else if (surface.view === "businessDashboard") {
      openBusinessDashboard();
    } else {
      setWorkspaceCardView(surface.view);
    }
  }
  const showMessageThread = true;
  const activeModuleView = activeView === "chat" || activeView === "home" ? null : activeView;
  const isSessionListView = activeView === "home";
  // The session list starts blank (no chat auto-selected/auto-created - see
  // useChatInboxState.loadMessagingInbox) until the account opens an existing chat or starts a
  // new one, matching a fresh ChatGPT tab rather than always dropping back into old history.
  const showBlankSessionState = isSessionListView && activeConversationId === null;
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId
  );
  const selectedEmailCustomerId = channelEndpoints.find(
    (endpoint) => endpoint.provider === "email"
  )?.customerId;
  const composer = useChatComposerState({
    activeConversationId,
    channelEndpoints,
    chatDraft,
    initialEmailSubject,
    nearbyScope,
    smsDefaultCountry,
    onDraftChange,
    onPlatformHandoff,
    onSend
  });
  const {
    commitDraft,
    liveDraft,
    openPlatformHandoff,
    openSmsHandoff,
    setSmsHandoffRequest,
    smsHandoffRequest
  } = composer;
  const visibleConversations = showMessageThread
    ? conversations
        // Home is the account's own agent-session list (Phase 3), not the general messaging
        // inbox - a DM or storefront/order conversation never appears there. Selecting "chat"
        // keeps today's full inbox unchanged.
        .filter((conversation) =>
          isSessionListView
            ? conversation.kind === "personal" && !conversation.hasHumanRecipient
            : true
        )
        .filter((conversation) => {
          const query = inboxSearch.trim().toLowerCase();
          if (!query) return true;
          return (
            (conversation.title ?? "Grogoni agent").toLowerCase().includes(query) ||
            (conversation.lastMessage === null
              ? false
              : conversationMessageText(conversation.lastMessage).toLowerCase().includes(query))
          );
        })
    : [];
  const visibleMessages = showMessageThread
    ? messages.filter((message) => !isRedundantAgentErrorMessage(message.body))
    : [];
  const hiddenMessageCount = Math.max(0, visibleMessages.length - messageWindowSize);
  const windowedMessages = visibleMessages.slice(hiddenMessageCount);

  useEffect(() => {
    if (!workspaceOpen) {
      setWorkspaceCardView("cards");
    }
  }, [workspaceOpen]);

  useEffect(() => {
    setWorkspaceCardView("cards");
  }, [mode]);

  useEffect(() => {
    setMessageWindowSize(defaultMessageWindow);
  }, [activeConversationId, defaultMessageWindow]);

  useEffect(() => {
    setEditingTopic(null);
  }, [activeConversationId]);

  useEffect(() => {
    recordReadiness("composer");
  }, []);

  useEffect(() => {
    if (messages.length > 0) recordReadiness("chat-first-message");
  }, [messages.length]);

  useEffect(() => {
    function closeMessageMenu(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActiveMessageMenuId(null);
        setForwardingMessageId(null);
        setEditingMessageId(null);
        setDeletingMessageId(null);
        setDeletingConversationId(null);
      }
    }
    document.addEventListener("keydown", closeMessageMenu);
    return () => document.removeEventListener("keydown", closeMessageMenu);
  }, []);

  useEffect(() => {
    if (!showMessageThread) return;
    const frameId = window.requestAnimationFrame(() => {
      messageListRef.current?.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: "auto"
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeConversationId, messages.length, showMessageThread, workspaceCardView]);

  const conversationListPanelProps = {
    isSessionListView,
    isAuthenticated,
    inboxSearch,
    setInboxSearch,
    isNewConversationOpen,
    setIsNewConversationOpen,
    newRecipient,
    setNewRecipient,
    newConversationTitle,
    setNewConversationTitle,
    isNewSessionOpen,
    setIsNewSessionOpen,
    newSessionTitle,
    setNewSessionTitle,
    liveDraft,
    visibleConversations,
    activeConversationId,
    onCreateConversation,
    onCreateAgentSession,
    onRequireSignIn,
    onEnableNotifications,
    onSelectConversation,
    onInboxOpenChange,
    onConversationPreference,
    openSmsHandoff,
    openPlatformHandoff,
    onOpenRecycleBin: () => {
      setIsRecycleBinOpen(true);
      onLoadRecycleBin();
    },
    deletingConversationId,
    setDeletingConversationId,
    onDeleteConversation
  };

  const isHomeConversation = mode === "marketplace" && activeModuleView === null;
  const isHomeEmpty =
    isHomeConversation && visibleMessages.every((message) => message.id === "welcome");

  const homeMessages = windowedMessages.filter(
    (message) => !isHomeConversation || message.id !== "welcome"
  );

  return (
    <div className={`chat-surface ${showMessageThread && isInboxOpen ? "inbox-open" : ""}`}>
      {showMessageThread ? (
        isCompactViewport ? (
          <StackedModule
            moduleId="messenger-inbox"
            className={`messenger-inbox-module ${isSessionListView ? "sessions-view" : ""}`}
            open={isInboxOpen}
            title={isSessionListView ? "Chats" : "Messages"}
            onClose={() => onInboxOpenChange(false)}
          >
            <ConversationListPanel showHeading={false} {...conversationListPanelProps} />
          </StackedModule>
        ) : (
          <aside
            className={`messenger-inbox ${isInboxOpen ? "open" : ""} ${
              isSessionListView ? "sessions-view" : ""
            }`}
            aria-label="Conversations"
          >
            <ConversationListPanel showHeading={true} {...conversationListPanelProps} />
          </aside>
        )
      ) : null}
      <section
        className="messenger-thread"
        aria-label={showBlankSessionState ? "New chat" : (selectedConversation?.title ?? "Chat")}
      >
        {showMessageThread && !isHomeEmpty ? (
          <header className="messenger-thread-header">
            <span
              className={`thread-avatar ${mode === "seller" ? "sell" : "buy"}`}
              aria-hidden="true"
            >
              {(showBlankSessionState ? "New chat" : (selectedConversation?.title ?? agent.name))
                .trim()
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <div>
              {editingTopic !== null ? (
                <form
                  className="thread-topic-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (activeConversationId !== null) {
                      onRenameConversation(activeConversationId, editingTopic);
                    }
                    setEditingTopic(null);
                  }}
                >
                  <label>
                    <span className="visually-hidden">Conversation topic</span>
                    <input
                      autoFocus
                      value={editingTopic}
                      onChange={(event) => setEditingTopic(event.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={editingTopic.trim().length === 0}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingTopic(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="thread-topic-button"
                  disabled={selectedConversation === undefined}
                  aria-label="Edit conversation topic"
                  onClick={() => setEditingTopic(selectedConversation?.title ?? agent.name)}
                >
                  <strong>{selectedConversation?.title ?? agent.name}</strong>
                </button>
              )}
              <small>
                {showBlankSessionState
                  ? "Not started yet"
                  : `${mode === "seller" ? "Sell session" : "Buy session"} · ${
                      isContactTyping ? "typing…" : securityLabel
                    }`}
              </small>
            </div>
            {!showBlankSessionState ? (
              <button className="secondary" type="button" onClick={onRetryMessages}>
                Retry failed
              </button>
            ) : null}
          </header>
        ) : null}
        <div
          className={`message-list${isHomeEmpty ? " home-empty-messages" : ""}`}
          aria-live="polite"
          ref={messageListRef}
        >
          {isHomeEmpty ? (
            <div className="home-welcome" data-testid="home-welcome">
              <h1>Karibu. What do you need?</h1>
              <p>Find products, shops, services, deliveries — or just ask.</p>
            </div>
          ) : null}
          {mode === "marketplace" &&
          activeModuleView === null &&
          recognizedDeviceLabel !== null &&
          visibleMessages.filter((message) => message.id !== "welcome").length === 0 ? (
            <button className="recognized-device-pill" type="button" onClick={onLogIn}>
              <span className="recognized-device-dot" aria-hidden="true" />
              <span>{recognizedDeviceLabel}</span>
            </button>
          ) : null}
          {showBlankSessionState && !isHomeEmpty ? (
            <div className="blank-session-state" role="status">
              <h3>Start a new chat</h3>
              <p>Ask your Grogoni agent anything, or pick a chat from the list.</p>
              <button
                type="button"
                onClick={() => (isAuthenticated ? onCreateAgentSession() : onRequireSignIn())}
              >
                New chat
              </button>
            </div>
          ) : null}
          {hiddenMessageCount > 0 ? (
            <button
              className="load-older-messages"
              type="button"
              onClick={() => setMessageWindowSize((size) => size + defaultMessageWindow)}
            >
              Load {Math.min(hiddenMessageCount, defaultMessageWindow)} older messages
            </button>
          ) : null}
          {homeMessages.map((message) => (
            <Fragment key={message.id}>
              <article
                className={`message ${message.author}`}
                data-testid={message.id === "welcome" ? "welcome-message" : undefined}
              >
                <span className="message-author">
                  {message.author === "merchant" ? (
                    "You"
                  ) : message.author === "contact" ? (
                    (message.authorLabel ?? "Contact")
                  ) : (
                    <>
                      <button
                        className="message-author-link"
                        type="button"
                        onClick={onOpenAgentProfile}
                        disabled={!hasBusiness}
                        aria-label={hasBusiness ? `Open ${agent.name} profile` : undefined}
                      >
                        {agent.name}
                      </button>
                      {mode === "seller" && hasBusiness ? (
                        <ShopPresenceButtons
                          activeStatus={shopPresenceStatus}
                          onStatusChange={onStatusChange}
                        />
                      ) : null}
                    </>
                  )}
                </span>
                {message.replyToMessageId ? <small className="message-context">Reply</small> : null}
                {message.forwardedFromMessageId ? (
                  <small className="message-context">Forwarded</small>
                ) : null}
                <p className={message.deletedAt ? "deleted-message" : undefined}>
                  {message.author === "grogoniclaw" ? (
                    <AuthenticationActionMessage message={message.body} />
                  ) : (
                    message.body
                  )}
                </p>
                {message.author === "grogoniclaw" &&
                capabilityTraceLabel(message.content) !== null ? (
                  <span className="capability-trace" aria-hidden="true">
                    {capabilityTraceLabel(message.content)}
                  </span>
                ) : null}
                {message.content?.type === "owner-controls" &&
                message.content.shopId === businessId ? (
                  <ShopHubEntryCard onOpen={onOpenWorkspace} />
                ) : null}
                {renderGeneratedSurface(message.content, {
                  businessId,
                  onStatusBroadcastPosted
                })}
                {message.attachments !== undefined && message.attachments.length > 0 ? (
                  <div className="message-attachments" aria-label="Message attachments">
                    {message.attachments.map((attachment) => (
                      <ConversationAttachmentCard attachment={attachment} key={attachment.id} />
                    ))}
                  </div>
                ) : null}
                <div className="message-meta">
                  {message.createdAt ? (
                    <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
                  ) : null}
                  {message.editedAt ? <span>edited</span> : null}
                  {message.author === "merchant" && message.status ? (
                    <span>{message.status}</span>
                  ) : null}
                  {message.author === "merchant" && !message.id.startsWith("welcome") ? (
                    <button type="button" onClick={() => void toggleDeliveryAttempts(message.id)}>
                      {openDeliveryAttemptsMessageId === message.id
                        ? "Hide delivery attempts"
                        : "Delivery attempts"}
                    </button>
                  ) : null}
                </div>
                {openDeliveryAttemptsMessageId === message.id ? (
                  <div className="message-context" aria-label="Delivery attempts">
                    {deliveryAttemptsLoading === message.id ? (
                      <small>Loading delivery attempts…</small>
                    ) : deliveryAttemptsError !== null &&
                      deliveryAttemptsByMessage[message.id] === undefined ? (
                      <small>{deliveryAttemptsError}</small>
                    ) : (deliveryAttemptsByMessage[message.id] ?? []).length === 0 ? (
                      <small>No delivery attempts recorded for this message.</small>
                    ) : (
                      (deliveryAttemptsByMessage[message.id] ?? []).map((attempt) => (
                        <small key={attempt.id}>
                          #{attempt.attemptNumber} · {attempt.channel} via {attempt.provider} ·{" "}
                          {attempt.result.replace(/_/gu, " ")}
                          {attempt.normalizedFailureCode
                            ? ` (${attempt.normalizedFailureCode})`
                            : ""}{" "}
                          · {formatMessageTime(attempt.requestedAt)}
                        </small>
                      ))
                    )}
                  </div>
                ) : null}
                {message.reactions?.length ? (
                  <div className="message-reactions" aria-label="Reactions">
                    {message.reactions.map((reaction) => (
                      <span key={`${reaction.actorId}-${reaction.emoji}`}>{reaction.emoji}</span>
                    ))}
                  </div>
                ) : null}
                {!message.deletedAt && !message.id.startsWith("welcome") ? (
                  <div className="message-actions">
                    <button type="button" onClick={() => onReply(message.id)}>
                      Reply
                    </button>
                    <button
                      type="button"
                      aria-expanded={activeMessageMenuId === message.id}
                      aria-haspopup="menu"
                      onClick={() =>
                        setActiveMessageMenuId(
                          activeMessageMenuId === message.id ? null : message.id
                        )
                      }
                    >
                      More
                    </button>
                    {activeMessageMenuId === message.id ? (
                      <div className="message-action-menu" role="menu">
                        {message.author === "grogoniclaw" ? (
                          <>
                            <button
                              type="button"
                              aria-label="Mark agent response correct"
                              onClick={() => {
                                setActiveMessageMenuId(null);
                                onAgentFeedback(message.id, true);
                              }}
                            >
                              Correct
                            </button>
                            <button
                              type="button"
                              aria-label="Flag agent response as incorrect"
                              onClick={() => {
                                setActiveMessageMenuId(null);
                                onAgentFeedback(message.id, false);
                              }}
                            >
                              Incorrect
                            </button>
                          </>
                        ) : null}
                        {["👍", "❤️", "😂", "😮", "🙏"].map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            aria-label={`React ${emoji}`}
                            onClick={() => {
                              setActiveMessageMenuId(null);
                              onReactMessage(message.id, emoji);
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                        {message.author === "merchant" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMessageId(message.id);
                              setEditingMessageText(message.body);
                              setActiveMessageMenuId(null);
                            }}
                          >
                            Edit
                          </button>
                        ) : null}
                        {message.author === "merchant" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setDeletingMessageId(message.id);
                              setActiveMessageMenuId(null);
                            }}
                          >
                            Delete
                          </button>
                        ) : null}
                        <button type="button" onClick={() => setForwardingMessageId(message.id)}>
                          Forward
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {editingMessageId === message.id ? (
                  <form
                    className="message-inline-action"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const text = editingMessageText.trim();
                      if (text.length === 0) return;
                      onEditMessage(message.id, text);
                      setEditingMessageId(null);
                    }}
                  >
                    <label>
                      Edit message
                      <input
                        autoFocus
                        value={editingMessageText}
                        onChange={(event) => setEditingMessageText(event.target.value)}
                      />
                    </label>
                    <button type="submit" disabled={editingMessageText.trim().length === 0}>
                      Save edit
                    </button>
                    <button type="button" onClick={() => setEditingMessageId(null)}>
                      Cancel
                    </button>
                  </form>
                ) : null}
                {deletingMessageId === message.id ? (
                  <div
                    className="message-inline-action"
                    role="alertdialog"
                    aria-label="Delete message?"
                  >
                    <span>Delete this message?</span>
                    <button
                      className="danger"
                      type="button"
                      onClick={() => {
                        onDeleteMessage(message.id);
                        setDeletingMessageId(null);
                      }}
                    >
                      Delete message
                    </button>
                    <button type="button" onClick={() => setDeletingMessageId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : null}
                {forwardingMessageId === message.id ? (
                  <div className="forward-picker">
                    <span>Forward to:</span>
                    {conversations
                      .filter((conversation) => conversation.id !== activeConversationId)
                      .map((conversation) => (
                        <button
                          type="button"
                          key={conversation.id}
                          onClick={() => {
                            onForwardMessage(message.id, conversation.id);
                            setForwardingMessageId(null);
                          }}
                        >
                          {conversation.title ?? "Grogoni agent"}
                        </button>
                      ))}
                    <button type="button" onClick={() => setForwardingMessageId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : null}
                {message.confirmationToken !== undefined ? (
                  <button
                    type="button"
                    onClick={() => onConfirm(message.confirmationToken ?? "")}
                    disabled={isConfirming}
                    aria-busy={isConfirming}
                  >
                    {isConfirming ? "Confirming…" : "Confirm"}
                  </button>
                ) : null}
              </article>
            </Fragment>
          ))}
        </div>
        <StackedModule
          moduleId="owner-management"
          className={mode === "seller" ? "sell-module" : "buy-module"}
          open={activeModuleView !== null}
          title={activeModuleView === null ? "Grogoni" : viewLabel(activeModuleView)}
          onClose={onBackToChat}
        >
          {children}
        </StackedModule>
        <StackedModule
          moduleId="marketplace"
          className="buy-module"
          open={activeModuleView === null && mode === "marketplace" && marketplaceShortcutOpen}
          title="Marketplace"
          onClose={onCloseMarketplace}
        >
          {workspaceCardView === "storefrontPreview" ? (
            <StorefrontPreviewCard
              businessName={businessName}
              products={products}
              grogoniId={grogoniId}
              onBack={() => setWorkspaceCardView("cards")}
              onOpenProfile={onOpenAgentProfile}
              onAddToOrder={(product) =>
                commitDraft(`I'd like to request 1 ${product.unit} of ${product.name}.`)
              }
              onSell={() => onModeChange("seller")}
              onMessage={() => commitDraft(`Hello ${businessName}, `)}
            />
          ) : (
            <MarketplaceModeCard
              businessName={businessName}
              hasBusiness={hasBusiness}
              isAuthenticated={isAuthenticated}
              isIntro={!marketplaceIntroComplete}
              isLoadingStorefronts={publicStorefrontsLoading}
              productCount={productCount}
              publicStorefronts={publicStorefronts}
              grogoniId={grogoniId}
              buyFeed={buyFeed}
              isSearchingBuyFeed={isSearchingBuyFeed}
              buyCart={buyCart}
              isCheckingOut={isCheckingOut}
              onCompleteIntro={onCompleteMarketplaceIntro}
              onOpenStore={() => setWorkspaceCardView("storefrontPreview")}
              onPrompt={commitDraft}
              onRefreshStorefronts={onRefreshPublicStorefronts}
              onSell={() => onModeChange("seller")}
              onSearchBuyFeed={onSearchBuyFeed}
              onAddToCart={onAddToCart}
              onRemoveFromCart={onRemoveFromCart}
              onCheckout={onCheckout}
              onSignUp={onSignUp}
            />
          )}
        </StackedModule>
        <StackedModule
          moduleId="workspace"
          className={workspaceModuleClassName(workspaceCardView, mode)}
          open={workspaceOpen}
          title={workspacePanelTitle(workspaceCardView)}
          onClose={onCloseWorkspace}
        >
          {workspaceCardView === "cards" ? (
            businessId !== null ? (
              <LazyModuleErrorBoundary
                moduleKey={workspaceModuleKeys.shopHub}
                label={shopHubCopy().title}
              >
                <Suspense fallback={<ShopHubSkeleton label={shopHubCopy().loading} />}>
                  <ShopHub
                    businessId={businessId}
                    businessName={businessName}
                    grogoniId={grogoniId}
                    onOpenSurface={openShopHubSurface}
                    onAskAgent={(draft) => {
                      commitDraft(draft);
                      onCloseWorkspace();
                    }}
                  />
                </Suspense>
              </LazyModuleErrorBoundary>
            ) : (
              <div className="record-form">
                <p>No shop yet.</p>
                <button type="button" onClick={() => onModeChange("seller")}>
                  Set up your shop
                </button>
              </div>
            )
          ) : workspaceCardView === "businessDashboard" ? (
            <MerchantWorkspaceDashboard
              businessName={businessName}
              invoices={invoices}
              products={products}
              onBack={() => setWorkspaceCardView("cards")}
              onOpenInvoices={() => {
                onNavigate("invoices");
                onCloseWorkspace();
              }}
              onOpenCatalogue={() => setWorkspaceCardView("catalogue")}
            />
          ) : workspaceCardView === "networkSync" ? (
            <NetworkSyncNestedCard
              graph={networkGraph}
              devicePhonebook={networkDevicePhonebook}
              networkInvites={networkInvites}
              onConnectionAction={onNetworkConnectionAction}
              oauthProviders={oauthProviders}
              oauthProvidersLoaded={oauthProvidersLoaded}
              onBack={() => setWorkspaceCardView("cards")}
              onDisconnectSource={onNetworkDisconnectSource}
              onOAuthProvider={onNetworkProviderOAuth}
              onPhoneContactsSync={onNetworkPhoneContactsSync}
              onInviteContacts={onNetworkInviteContacts}
              onRefresh={onNetworkRefresh}
            />
          ) : workspaceCardView === "storefrontPreview" ? (
            <StorefrontPreviewCard
              businessName={businessName}
              products={products}
              grogoniId={grogoniId}
              onBack={() => setWorkspaceCardView("cards")}
              onOpenProfile={onOpenAgentProfile}
              onAddToOrder={(product) =>
                commitDraft(`I'd like to request 1 ${product.unit} of ${product.name}.`)
              }
              onSell={() => onModeChange("marketplace")}
              onMessage={() => commitDraft(`Hello ${businessName}, `)}
            />
          ) : (
            <CatalogueNestedCard
              businessId={businessId}
              form={productForm}
              fields={productFields}
              products={products}
              view={workspaceCardView}
              onBack={() =>
                setWorkspaceCardView(workspaceCardView === "catalogue" ? "cards" : "catalogue")
              }
              onChangeForm={onProductFormChange}
              onDeleteProduct={onProductRemove}
              onEditProduct={onProductEdit}
              onProductsDuplicated={onProductsDuplicated}
              onOpenAdd={() => {
                onProductReset();
                setWorkspaceCardView("addProduct");
              }}
              onOpenDelete={() => setWorkspaceCardView("deleteProduct")}
              onOpenEdit={() => {
                if (products[0] !== undefined) onProductEdit(products[0]);
                setWorkspaceCardView("editProduct");
              }}
              onOpenFields={() => setWorkspaceCardView("manageFields")}
              onOpenProduct={(product) => {
                onProductEdit(product);
                setWorkspaceCardView("editProduct");
              }}
              onSaveFields={onProductFieldsSave}
              onSaveProduct={async () => {
                if (await onProductSave()) setWorkspaceCardView("catalogue");
              }}
            />
          )}
        </StackedModule>
        <StackedModule
          moduleId="recycle-bin"
          className={mode === "seller" ? "sell-module" : "buy-module"}
          open={isRecycleBinOpen}
          title="Recycle bin"
          onClose={() => setIsRecycleBinOpen(false)}
        >
          <p>
            Deleted chats stay here for 14 days before they're permanently removed. Restoring or
            emptying the bin requires admin privileges.
          </p>
          {recycleBin !== null ? (
            <>
              <p>
                {formatFileSize(recycleBin.usedBytes)} of {formatFileSize(recycleBin.capacityBytes)}{" "}
                used
                {recycleBin.isFull ? " — full. Ask an admin to empty it." : ""}
              </p>
              {recycleBin.items.length === 0 ? (
                <p>The recycle bin is empty.</p>
              ) : (
                <>
                  <div className="conversation-list">
                    {recycleBin.items.map((item) => (
                      <article className="conversation-item" key={item.conversation.id}>
                        <span className="conversation-copy">
                          <span className="conversation-title-line">
                            <strong>{item.title ?? "Grogoni agent"}</strong>
                          </span>
                          <small>
                            Deleted {formatMessageTime(item.deletedAt)} · Permanently deleted{" "}
                            {formatMessageTime(item.purgeAt)} · {formatFileSize(item.sizeBytes)}
                          </small>
                        </span>
                        <div className="conversation-actions" aria-label="Recycle bin item actions">
                          <button
                            type="button"
                            onClick={() => onRestoreConversation(item.conversation.id)}
                          >
                            Restore
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <button className="danger" type="button" onClick={() => onEmptyRecycleBin()}>
                    Empty recycle bin
                  </button>
                </>
              )}
            </>
          ) : (
            <p>Loading…</p>
          )}
        </StackedModule>
        {mode === "marketplace" &&
        activeModuleView === null &&
        visibleMessages.filter((message) => message.id !== "welcome").length === 0 ? (
          <div className="home-suggestion-chips" role="group" aria-label="Suggested requests">
            {homeSuggestionPrompts.map((prompt) => (
              <button key={prompt} type="button" onClick={() => commitDraft(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
        <ChatComposer
          activeAgentName={agent.name}
          agent={agentSettings}
          business={business}
          channelEndpoints={channelEndpoints}
          composer={composer}
          invoices={invoices}
          isAuthenticated={isAuthenticated}
          isBrowserGenerating={isBrowserGenerating}
          isSending={isSending}
          mode={mode}
          pendingAttachments={pendingAttachments}
          replyToMessageId={replyToMessageId}
          selectedConversationTitle={selectedConversation?.title ?? ""}
          selectedEmailCustomerId={selectedEmailCustomerId}
          onAgentChange={setAgentSettings}
          onAttachmentChange={onAttachmentChange}
          onCancelGeneration={onCancelGeneration}
          onCancelReply={onCancelReply}
          onOpenAgentProfile={onOpenAgentProfile}
          onRemoveAttachment={onRemoveAttachment}
          onRequireSignIn={onRequireSignIn}
          onSellerPhotoCapture={onSellerPhotoCapture}
        />
        {smsHandoffRequest !== null ? (
          <Suspense fallback={null}>
            <SmsHandoffDialog
              key={`${smsHandoffRequest.recipient}:${smsHandoffRequest.body}`}
              {...smsHandoffRequest}
              defaultCountry={smsDefaultCountry}
              hasAttachments={pendingAttachments.length > 0}
              onClose={() => setSmsHandoffRequest(null)}
              onRecord={onSmsHandoff}
            />
          </Suspense>
        ) : null}
      </section>
    </div>
  );
}
