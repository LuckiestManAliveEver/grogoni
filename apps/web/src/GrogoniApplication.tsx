import { OfflineRuntimeNotice } from "./OfflineRuntimeNotice";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { Surface } from "@grogoni/ui";
import { commerceAddressFromGrogoniId } from "@grogoni/shared-types";
import type { E2eeDeviceSummary, GrogoniSessionContext } from "@grogoni/shared-types";
import {
  createInitialChatMessages,
  type ChatMessage,
  type ShellView,
  type GrogoniMode
} from "./app-shell";

import { ensureE2eeIdentity, type E2eeIdentity } from "./e2ee";
import {
  authenticationRoute,
  readAuthenticationRouteHash,
  readAuthenticationRoutePath,
  readOwnerRoute
} from "./routes";
import {
  initializeOwnerHistory,
  navigateToOwnerRoute,
  readCurrentOwnerRoute,
  readGrogoniHistoryState,
  subscribeToBrowserNavigation
} from "./browser-navigation";
import {
  clearOwnerNavigationSession,
  readOwnerNavigationSession,
  scheduleOwnerNavigationSessionWrite,
  writeOwnerNavigationSession
} from "./owner-navigation-session";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useAuthState } from "./hooks/useAuthState";
import { useDomainResetRegistry } from "./hooks/useDomainReset";
import { useCustomersState } from "./hooks/useCustomersState";
import { useImportsState } from "./hooks/useImportsState";
import { useInvoicesState } from "./hooks/useInvoicesState";
import { useBusinessSetupState } from "./hooks/useBusinessSetupState";
import { useBuyCartState } from "./hooks/useBuyCartState";
import { useChatAttachmentsState } from "./hooks/useChatAttachmentsState";
import { useChatInboxState } from "./hooks/useChatInboxState";
import { useChatRuntimeState } from "./hooks/useChatRuntimeState";
import { useChatThreadState } from "./hooks/useChatThreadState";
import { useLogisticsState } from "./hooks/useLogisticsState";
import { useMarketplaceState } from "./hooks/useMarketplaceState";
import { useNavigationState } from "./hooks/useNavigationState";
import { useReadinessState } from "./hooks/useReadinessState";
import { useReportsState } from "./hooks/useReportsState";
import { useRuntimeHistoryState } from "./hooks/useRuntimeHistoryState";
import { useStorefrontCareState } from "./hooks/useStorefrontCareState";
import { useNetworkState } from "./hooks/useNetworkState";
import { useProductsState } from "./hooks/useProductsState";
import { useSyncState } from "./hooks/useSyncState";
import { usePaymentsState } from "./hooks/usePaymentsState";
import { useSuppliersState } from "./hooks/useSuppliersState";
import { useNotificationsState } from "./hooks/useNotificationsState";
import { useOssAgentSelectionState } from "./hooks/useOssAgentSelectionState";
import { useViewRefreshRegistry } from "./hooks/useViewRefresh";
import { surfaceForShellView } from "./cross-device-session-context";
import { clearPersistentApiRequestCache, subscribeToApiMutations } from "./api-request-cache";
import { detectCapabilitySettings } from "./capability-profile";
import { markNavigationCommitted, startNavigationMeasurement } from "./performance";
import { likelyNextOwnerViews, prefetchOwnerView, scheduleIdleOwnerPrefetch } from "./prefetch";
import { setConnectivityAuthentication } from "./connectivity";

import { clearMessagingOutbox } from "./messaging/outbox";

import { AppIcon } from "./AppIcon";
import { IdentityNetworkOnboardingCard } from "./IdentityNetworkOnboardingCard";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { clearDeviceRecoveryCredential } from "./device-recovery";
import type { RememberedAccount } from "./PhoneFirstAuthentication";

import {
  bootstrapProgressMessage,
  clearCachedAuthSession,
  hasServerAuthenticatedSession,
  isAuthBootstrapPending,
  readCachedAuthSession
} from "./auth-bootstrap";

import {
  AccountRestorationPanel,
  type ActiveBusiness,
  type AgentSettings,
  type CountryDialCode,
  PhoneFirstAuthentication,
  PhoneSignup,
  type SessionResponse,
  type SetupDraft,
  activeAgentStorageKey,
  activeBusinessStorageKey,
  activeModeStorageKey,
  emptyProductForm,
  guestBrowsingStorageKey,
  legacyActiveBusinessStorageKey,
  ownerAuthStorageKey,
  pendingOAuthStorageKey,
  setupDraftStorageKey,
  uiBackgroundRefreshIntervalMs
} from "./grogoni-application-shared";

import { postJson } from "./api-helpers";

import { createPublicStorefrontUrl } from "./grogoniid-and-storefront";
import { inferCountryCode } from "./country-dial-codes";
import {
  readStoredBusiness,
  readStoredGrogoniMode,
  readStoredAgent,
  readStoredOwnerAuth,
  readSetupDraft,
  createDefaultAgent
} from "./owner-app-bootstrap";

import {
  isHumanDirectConversation,
  getErrorMessage,
  logClientEvent
} from "./chat-message-plumbing";

import { useInstallPrompt } from "./misc-browser-utils";

import { BusinessSetupPanel } from "./BusinessSetupPanel";
import { MenuDrawer } from "./MenuDrawer";

import { ChatSurface } from "./ChatSurface";
import { renderOwnerWorkspace, type OwnerWorkspaceBindings } from "./OwnerWorkspace";

import { BuildIdentity, NativeLaunchScreen } from "./BuildIdentity";
import { OwnerCoreProvider, type OwnerCoreState } from "./hooks/OwnerCoreContext";
import {
  agentProfileModuleKeys,
  hasPendingLazyModuleRecovery,
  loadLazyModuleWithRecovery,
  registerPreReloadFlush
} from "./lazy-module-recovery";
export { PublicStorefrontChat } from "./PublicStorefrontChat";

import ShellNotices from "./ShellNotices";
import { permissionsForOpenShop } from "./active-shop-permissions";
const AgentProfileSurface = lazy(() =>
  loadLazyModuleWithRecovery(
    agentProfileModuleKeys.surface,
    () => import("./AgentProfileSurface")
  ).then((module) => ({ default: module.AgentProfileSurface }))
);

function shouldRefreshBusinessDomains(path: string, businessId: string): boolean {
  const businessMutation = path.match(/^\/businesses\/([^/]+)\/([^/]+)/);
  if (businessMutation !== null) {
    const [, mutatedBusinessId, resource] = businessMutation;
    return mutatedBusinessId === businessId && resource !== "runtime";
  }

  return (
    path === "/network" ||
    path.startsWith("/v1/oss-agents/installed") ||
    path.startsWith("/v1/model-artifacts")
  );
}

export function OwnerApp() {
  const installPrompt = useInstallPrompt();
  const capabilitySettingsRef = useRef(detectCapabilitySettings());
  const shellInstanceIdRef = useRef(
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `shell-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const accountDeletionIntent =
    new URLSearchParams(window.location.search).get("intent") === "account-deletion";
  const accountRestorationIntent =
    new URLSearchParams(window.location.search).get("intent") === "account-restoration";
  const initialAuthenticationTarget =
    readAuthenticationRoutePath(window.location.pathname) ??
    readAuthenticationRouteHash(window.location.hash);
  const initialSetupDraft = readSetupDraft();
  const initialBusiness = readStoredBusiness();
  const initialOwnerAuth = readStoredOwnerAuth();
  // A PIN-based account remembered from a prior successful login on this browser. Excludes
  // social/OAuth logins (no PIN to enter) so the login screen only skips identifier entry when
  // a PIN attempt actually makes sense.
  const rememberedAccount: RememberedAccount | null =
    initialOwnerAuth !== null && initialOwnerAuth.provider === undefined
      ? {
          type: initialOwnerAuth.contact.includes("@") ? "email" : "phone",
          identifier: initialOwnerAuth.contact,
          label: initialOwnerAuth.contact
        }
      : null;
  const initialCachedSession = readCachedAuthSession();
  const initialOwnerRoute = readOwnerRoute(window.location.pathname);
  const initialNavigationSession = readOwnerNavigationSession(
    initialCachedSession?.account.id ?? null
  );
  const initialCountryCode: CountryDialCode =
    initialOwnerAuth?.countryCode ?? initialSetupDraft?.countryCode ?? "+254";
  const [session, setSession] = useState<SessionResponse | null>(initialCachedSession);
  const [grogoniSessionContext, setGrogoniSessionContext] = useState<GrogoniSessionContext | null>(
    null
  );
  const [business, setBusiness] = useState<ActiveBusiness | null>(initialBusiness);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(
    () => readStoredAgent() ?? createDefaultAgent(initialBusiness)
  );
  const [statusMessage, setStatusMessage] = useState("Checking session");
  const [view, setView] = useState<ShellView>(
    accountDeletionIntent
      ? "agent"
      : Object.values(agentProfileModuleKeys).some((moduleKey) =>
            hasPendingLazyModuleRecovery(moduleKey)
          )
        ? "agent"
        : (initialOwnerRoute?.view ?? "chat")
  );
  const [mode, setMode] = useState<GrogoniMode>(initialOwnerRoute?.mode ?? readStoredGrogoniMode());
  // Memoized so OwnerCoreContext consumers only re-render when one of these four pieces of state
  // actually changes, not on every OwnerApp render (i.e. every keystroke in any unrelated domain
  // form) - see docs/architecture/frontend-modularization-roadmap.md's OwnerApp decomposition notes.
  const ownerCoreValue: OwnerCoreState = useMemo(
    () => ({
      session,
      setSession,
      grogoniSessionContext,
      setGrogoniSessionContext,
      business,
      setBusiness,
      agentSettings,
      setAgentSettings,
      view,
      setView,
      mode,
      setMode
    }),
    [session, grogoniSessionContext, business, agentSettings, view, mode]
  );
  const { hasPending, isPending, runAction } = useAsyncActions();
  const domainResetRegistry = useDomainResetRegistry();
  const { allRefreshers, registerRefresh, refreshersFor } = useViewRefreshRegistry();
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [isWorkspacePanelOpen, setIsWorkspacePanelOpen] = useState(
    initialOwnerRoute?.panel === "shop-hub"
  );
  const [e2eeIdentity, setE2eeIdentity] = useState<E2eeIdentity | null>(null);
  // Purely local, ephemeral display state: which capability a card in this session's own thread
  // came from (Grogoni Home's "trace" affordance). Never sent to the server and not worth surviving
  // navigation, unlike the hook-owned state above.
  const [isCapabilityTraceOpen, setIsCapabilityTraceOpen] = useState(false);
  // Grogoni Home's hamburger menu drawer and which of AgentProfileSurface's own settings groups it
  // should open+scroll to on arrival - both purely local UI state, reset once consumed.
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState(false);
  const [agentProfileInitialSection, setAgentProfileInitialSection] = useState<
    "business" | "agent" | "security" | null
  >(null);

  const publicStorefrontUrl = business === null ? "" : createPublicStorefrontUrl(business);
  const userLabel = session?.user.displayName ?? "Guest";
  // Grogoni Home's "recognized device" pill: this device remembers a stronger identity
  // (initialOwnerAuth/initialBusiness, read once at cold boot) than the one the current session
  // actually holds (a fresh device-only account, per progressive-identity.md). Once the account
  // this session belongs to is itself upgraded past "device", the pill has nothing left to invite
  // and disappears on its own - no separate dismiss state to track.
  const recognizedDeviceLabel =
    session?.account.identityLevel === "device" && initialOwnerAuth !== null
      ? initialBusiness !== null
        ? `This device — continue to ${initialBusiness.name}?`
        : "This device — log in to pick up where you left off?"
      : null;

  // Domain hooks extracted from OwnerApp's state (see docs/architecture/frontend-modularization-
  // roadmap.md's OwnerApp decomposition). Grouped together and placed after every raw useState/
  // useRef declaration above (not interspersed among them) since several of these hooks take
  // still-inline OwnerApp state as a dependency (e.g. `invoices`) - a `const` declared earlier in
  // this function via useState, which would throw a temporal-dead-zone error if referenced by a
  // hook call positioned before that declaration.
  //
  // useSyncState is called first, ahead of every other domain hook, because its
  // queueMutationAfterNetworkFailure is itself an injected dependency several other domain hooks'
  // deps objects need (Logistics/Customers/Payments) - those hooks reference it by name in their
  // own deps, which is only TDZ-safe if the const it resolves to already exists by then.
  const {
    syncQueue,
    syncSummary,
    offlineCache,
    syncRepositoryRef,
    loadSyncQueue,
    loadOfflineCache,
    replaySyncQueue,
    replaySyncQueueItem,
    queueMutationAfterNetworkFailure
  } = useSyncState({
    businessId: business?.id ?? null,
    session,
    setStatusMessage,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const { notificationInbox, loadNotifications, updateNotification } = useNotificationsState({
    businessId: business?.id ?? null,
    setStatusMessage,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  // useReportsState is called early, before any hook whose deps object references loadReports
  // (Logistics, Suppliers, Imports), for the same reason Sync is called first: those hooks
  // reference loadReports by name at hook-call time, which requires the const it resolves to
  // already exist.
  const { reportSummary, knowledgeSummary, loadReports } = useReportsState({
    setStatusMessage,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const {
    logistics,
    logisticsForm,
    setLogisticsForm,
    loadLogistics,
    createLogistics,
    updateLogisticsStatus
  } = useLogisticsState({
    businessId: business?.id ?? null,
    getInvoices: () => invoices,
    setStatusMessage,
    loadReports,
    queueMutationAfterNetworkFailure,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const { customers, customerForm, setCustomerForm, loadCustomers, saveCustomer } =
    useCustomersState({
      businessId: business?.id ?? null,
      setStatusMessage,
      queueMutationAfterNetworkFailure,
      registerReset: domainResetRegistry.registerReset,
      registerRefresh
    });
  const {
    suppliers,
    purchaseReceipts,
    receiptOcrJobs,
    supplierForm,
    setSupplierForm,
    loadSuppliers,
    saveSupplier,
    deleteSupplierCard,
    saveSalesAgent,
    deleteSalesAgentCard,
    searchSupplierContacts,
    linkSupplierPhoneContact,
    createSupplierFromPhoneContact,
    linkSalesAgentPhoneContact,
    createSalesAgentFromPhoneContact,
    uploadSupplierReceipt,
    confirmSupplierReceipt
  } = useSuppliersState({
    businessId: business?.id ?? null,
    setStatusMessage,
    loadReports,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const {
    payments,
    invoicePayments,
    customerDebts,
    paymentForm,
    setPaymentForm,
    loadPaymentData,
    recordPayment
  } = usePaymentsState({
    businessId: business?.id ?? null,
    setStatusMessage,
    queueMutationAfterNetworkFailure,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const {
    products,
    productFields,
    productForm,
    setProductForm,
    stockProductId,
    setStockProductId,
    stockQuantityAfter,
    setStockQuantityAfter,
    stockReason,
    setStockReason,
    populateProductForm,
    loadProducts,
    loadProductFields,
    saveProduct,
    deleteProduct,
    adjustStock,
    saveProductFieldStructure
  } = useProductsState({
    businessId: business?.id ?? null,
    setStatusMessage,
    queueMutationAfterNetworkFailure,
    getNavigationHelpers: () => ({ routedProductId, setRoutedProductId, navigateToView }),
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  // useNavigationState is called right after useProductsState (needs its populateProductForm as an
  // eager dep) and before the chat hook group/useAuthState (whose deps objects reference
  // navigateToView/requireMessagingSignIn by name at hook-call time). Its own dependencies on Auth/BusinessSetup/
  // Chat setters - all called later - are deferred behind getters (see useNavigationState.ts) to
  // avoid the reverse TDZ problem; useProductsState's dependency on this hook's routedProductId/
  // setRoutedProductId/navigateToView is deferred the same way, via getNavigationHelpers above.
  const {
    isMarketplaceShortcutOpen,
    setIsMarketplaceShortcutOpen,
    shopPresenceStatus,
    setShopPresenceStatus,
    routedProductId,
    setRoutedProductId,
    navigateToView,
    openProduct,
    openAgentProfile,
    returnToChat,
    requireMessagingSignIn,
    openAuth,
    browseAsGuest,
    switchMode,
    openShopHub,
    closeShopHub,
    updateShopPresenceStatus
  } = useNavigationState({
    business,
    session,
    mode,
    setMode,
    view,
    setView,
    getIsMarketplaceIntroComplete: () => isMarketplaceIntroComplete,
    preservedScreenLimit: capabilitySettingsRef.current.preservedScreenLimit,
    // Previously true whenever the URL was exactly "/marketplace" (a leftover from before that
    // path, "/" and "/chat" all became the same unified-chat route): the "Marketplace" panel it
    // opens is a modal (StackedModule) that makes the rest of the shell inert, including the
    // header's shop icon, blocking it on the very first load of the customer's canonical URL.
    initialMarketplaceShortcutOpen: false,
    initialRoutedProductId: initialOwnerRoute?.productId ?? null,
    populateProductForm,
    setStatusMessage,
    setIsWorkspacePanelOpen,
    runAction,
    getAuthSetters: () => ({ setIsAuthOpen, setAuthenticationView, setIsAccountRestorationOpen }),
    getBusinessSetupSetters: () => ({ setIsBusinessSetupOpen, setBusinessSetupStep }),
    getChatSetters: () => ({ setIsMessagingInboxOpen, setChatMessages }),
    getContinueToGrogoni: () => continueToGrogoni,
    registerReset: domainResetRegistry.registerReset
  });
  // useMarketplaceState is called after useNavigationState (completeMarketplaceIntro/
  // validateStoredBusiness need its setIsMarketplaceShortcutOpen/setShopPresenceStatus, deferred
  // behind a getter since they're only read inside those two functions, not at Marketplace's own
  // hook-call time) and before the chat hook group/useAuthState (whose deps objects reference
  // buyFeed/setBuyCart/setBuyFeed and loadMarketplaceIntroState/validateStoredBusiness by name, eagerly).
  const {
    isMarketplaceIntroComplete,
    publicStorefronts,
    publicStorefrontsLoading,
    buyFeed,
    setBuyFeed,
    buyCart,
    setBuyCart,
    loadMarketplaceIntroState,
    loadPublicStorefronts,
    completeMarketplaceIntro,
    validateStoredBusiness
  } = useMarketplaceState({
    session,
    setBusiness,
    setAgentSettings,
    setStatusMessage,
    getNavigationSetters: () => ({ setIsMarketplaceShortcutOpen, setShopPresenceStatus }),
    registerReset: domainResetRegistry.registerReset
  });
  const {
    importJobs,
    selectedImportJobId,
    setSelectedImportJobId,
    importForm,
    setImportForm,
    activeImportJob,
    loadDocumentImports,
    createDocumentImport,
    updateImportRowLocal,
    saveImportRow,
    confirmImport
  } = useImportsState({
    businessId: business?.id ?? null,
    setStatusMessage,
    loadProducts,
    loadSuppliers,
    loadReports,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const {
    invoices,
    invoiceForm,
    setInvoiceForm,
    invoicePreview,
    setInvoicePreview,
    loadInvoices,
    previewInvoice,
    saveInvoice,
    confirmInvoice,
    printInvoice
  } = useInvoicesState({
    businessId: business?.id ?? null,
    setStatusMessage,
    loadProducts,
    queueMutationAfterNetworkFailure,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const {
    networkGraph,
    setNetworkGraph,
    networkInvites,
    devicePhonebook,
    runNetworkConnectionAction,
    loadNetworkGraph,
    loadNetworkInvites,
    syncPhoneNetwork,
    syncSelectedNetworkPhoneContacts,
    inviteNetworkContacts,
    syncSocialNetwork,
    requestNetworkRoute,
    approveNetworkRoute,
    rejectNetworkRoute,
    disconnectNetworkSource,
    shareOwnerStorefrontInvite,
    syncOwnerPhoneContacts,
    importContactsFile,
    exportOwnerContacts
  } = useNetworkState({
    business,
    getCustomers: () => customers,
    loadCustomers,
    setStatusMessage,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const {
    runtimeSessions,
    selectedRuntimeHistorySessionId,
    setSelectedRuntimeHistorySessionId,
    runtimeTurns,
    loadRuntimeSessions,
    loadRuntimeTurns,
    createRuntimeHistorySession,
    createManagedRuntimeSession,
    ensureRuntimeSession,
    restoreOrCreateRuntimeSession
  } = useRuntimeHistoryState({
    business,
    session,
    setStatusMessage,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  const { storefrontCareRequests, storefrontMessages, storefrontOrders, loadStorefrontInbox } =
    useStorefrontCareState({
      setStatusMessage,
      registerReset: domainResetRegistry.registerReset,
      registerRefresh
    });
  const {
    securityReview,
    dataExport,
    verificationTier,
    taxConfig,
    deviceTrust,
    complianceForm,
    setComplianceForm,
    loadCompliance,
    createDataExport,
    saveVerificationTier,
    saveTaxConfig,
    saveDeviceTrust,
    scheduleAccountDeletion,
    betaReadiness,
    betaSupportTickets,
    betaForm,
    setBetaForm,
    loadBetaReadiness,
    updateBetaAccess,
    enableBetaFlags,
    recordBetaDeviceTest,
    createBetaSupportTicket,
    updateBetaSupportTicketStatus,
    recordBetaTelemetry,
    launchReadiness,
    launchIncidents,
    launchForm,
    setLaunchForm,
    loadLaunchReadiness,
    updateLaunchSettings,
    updateLaunchChecklist,
    createLaunchIncident,
    updateLaunchIncidentStatus
  } = useReadinessState({
    business,
    session,
    isOnline,
    setStatusMessage,
    loadReports,
    resetClientToStartup,
    registerReset: domainResetRegistry.registerReset,
    registerRefresh
  });
  // Chat/messaging was originally one useChatState hook (Phase 16); later split into five smaller
  // hooks (Thread/Inbox/Attachments/BuyCart/Runtime) once it was the only remaining hook mixing
  // several loosely-related sub-concerns. Thread is the state hub (chatMessages/chatDraft/
  // pendingAttachments/replyToMessageId/runtimeSessionId) and is called first so every sibling can
  // take its setters as plain deps - same "core-context values never relocate" shape as
  // OwnerCoreContext, just scoped to chat. Called before useBusinessSetupState because BusinessSetup's
  // own deps object references setConversationInbox/setActiveConversationId/loadConversationThread,
  // all three returned by useChatInboxState - same TDZ-avoidance reasoning as every other domain
  // hook ordering decision in this effort.
  const {
    chatDraft,
    setChatDraft,
    pendingAttachments,
    setPendingAttachments,
    runtimeSessionId,
    setRuntimeSessionId,
    chatMessages,
    setChatMessages,
    replyToMessageId,
    setReplyToMessageId
  } = useChatThreadState({
    initialNavigationSession,
    initialBusiness,
    registerReset: domainResetRegistry.registerReset
  });
  const {
    authBootstrapState,
    setAuthBootstrapState,
    oauthProviders,
    oauthProvidersLoaded,
    isAuthOpen,
    setIsAuthOpen,
    authenticationView,
    setAuthenticationView,
    isAccountRestorationOpen,
    setIsAccountRestorationOpen,
    forgetRememberedOwnerAuth,
    handleOAuthCallback,
    loadOAuthProviders,
    acceptAuthenticatedSession,
    completePhoneFirstAuthentication,
    continueToGrogoni,
    refreshSession,
    ensureAuthenticatedSession,
    rejectDefinitiveAuthenticationFailure,
    authenticateSocialProfile,
    completeAccountRestoration,
    loadGrogoniSessionContext,
    patchGrogoniSessionContext,
    applySessionContextForConversation,
    switchActiveBusiness,
    joinStaffShop
  } = useAuthState({
    business,
    setBusiness,
    setSession,
    grogoniSessionContext,
    setGrogoniSessionContext,
    setAgentSettings,
    setMode,
    setView,
    setStatusMessage,
    setNetworkGraph,
    navigateToView,
    loadMarketplaceIntroState,
    validateStoredBusiness,
    accountDeletionIntent,
    accountRestorationIntent,
    initialAuthenticationTarget,
    initialCountryCode,
    initialOwnerAuth,
    registerReset: domainResetRegistry.registerReset
  });
  const {
    isMessagingInboxOpen,
    setIsMessagingInboxOpen,
    conversationInbox,
    setConversationInbox,
    activeConversationId,
    setActiveConversationId,
    activeConversation,
    isContactTyping,
    recycleBin,
    loadMessagingInbox,
    loadConversationThread,
    selectConversation,
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
    submitAgentResponseFeedback,
    createAgentSession
  } = useChatInboxState({
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
    setReplyToMessageId,
    registerReset: domainResetRegistry.registerReset
  });
  const { handleChatAttachmentChange, removePendingAttachment, handleSellerPhotoCapture } =
    useChatAttachmentsState({
      business,
      setStatusMessage,
      setPendingAttachments,
      setChatMessages
    });
  const {
    handleSearchBuyFeed,
    handleAddToCart,
    handleRemoveFromCart,
    handleCheckout,
    handleStatusBroadcastPosted
  } = useBuyCartState({
    runAction,
    setStatusMessage,
    buyCart,
    setBuyCart,
    setBuyFeed,
    setChatMessages
  });
  const { isBrowserGenerating, sendChatDraft, confirmRuntimeAction, cancelGeneration } =
    useChatRuntimeState({
      business,
      mode,
      session,
      authBootstrapState,
      ensureAuthenticatedSession,
      rejectDefinitiveAuthenticationFailure,
      agentSettings,
      setStatusMessage,
      navigateToView,
      requireMessagingSignIn,
      searchBuyFeed: handleSearchBuyFeed,
      loadProducts,
      loadSuppliers,
      loadCustomers,
      loadInvoices,
      loadReports,
      loadNotifications,
      loadRuntimeSessions,
      createManagedRuntimeSession,
      ensureRuntimeSession,
      loadDocumentImports,
      chatMessages,
      setChatMessages,
      chatDraft,
      setChatDraft,
      pendingAttachments,
      setPendingAttachments,
      runtimeSessionId,
      setRuntimeSessionId,
      replyToMessageId,
      setReplyToMessageId,
      activeConversationId,
      activeConversation,
      loadMessagingInbox,
      registerReset: domainResetRegistry.registerReset
    });
  // useAuthState is called after useNetworkState/the chat hook group (whose setNetworkGraph escape
  // hatch and requireMessagingSignIn/setConversationInbox/setActiveConversationId/
  // loadConversationThread it depends on) and before useBusinessSetupState (whose deps object
  // references refreshSession by name at hook-call time) - same TDZ-avoidance reasoning as every
  // other domain hook ordering decision in this effort.
  const authBootstrapPending = isAuthBootstrapPending(authBootstrapState);
  // A device-only session (progressive-identity.md) is a real, cookie-backed session, but it is
  // not yet the identity someone deliberately asking to log in or sign up wants - show the auth
  // screen for it the same as no session at all. completePhoneFirstAuthentication's new session
  // response simply replaces this temporary one, exactly like a fresh signup/login would.
  const shouldShowAuth =
    !authBootstrapPending &&
    isAuthOpen &&
    (session === null || session.account.identityLevel === "device");
  const setupComplete = business !== null && !shouldShowAuth && !authBootstrapPending;
  const isAuthScreen = authBootstrapPending || shouldShowAuth || isAccountRestorationOpen;
  const {
    businessName,
    setBusinessName,
    language,
    setLanguage,
    businessSetupStep,
    setBusinessSetupStep,
    shopPhoneCountryCode,
    setShopPhoneCountryCode,
    shopPhoneNumber,
    setShopPhoneNumber,
    isBusinessSetupOpen,
    setIsBusinessSetupOpen,
    saveOwnerPhoneForShop,
    createBusiness
  } = useBusinessSetupState({
    business,
    setBusiness,
    session,
    setSession,
    setAgentSettings,
    setMode,
    setView,
    refreshSession,
    setConversationInbox,
    setActiveConversationId,
    loadConversationThread,
    setStatusMessage,
    initialSetupDraft,
    initialCountryCode,
    registerReset: domainResetRegistry.registerReset
  });

  useEffect(() => {
    function openAuthenticationFromHash() {
      const target = readAuthenticationRouteHash(window.location.hash);
      if (target === null) return;

      openAuth(target);

      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`
      );
    }

    openAuthenticationFromHash();
    window.addEventListener("hashchange", openAuthenticationFromHash);
    return () => window.removeEventListener("hashchange", openAuthenticationFromHash);
  }, []);

  useEffect(() => {
    if (isOnline && authBootstrapState === "offline-authenticated") {
      void refreshSession();
    }
  }, [isOnline, authBootstrapState]);

  useEffect(() => {
    setConnectivityAuthentication(session !== null);
  }, [session]);

  useEffect(() => {
    if (session === null) {
      setGrogoniSessionContext(null);
      return;
    }
    void loadGrogoniSessionContext(setActiveConversationId);
  }, [session?.account.id]);

  useEffect(() => {
    if (session === null || grogoniSessionContext === null) return;
    if (mode === "seller" && business === null) return;

    const activeSurface = surfaceForShellView(view, mode);
    const activeShopId = business?.id ?? null;
    const conversationId = activeConversationId ?? grogoniSessionContext.conversationId;
    if (
      grogoniSessionContext.mode === mode &&
      grogoniSessionContext.activeShopId === activeShopId &&
      grogoniSessionContext.activeSurface === activeSurface &&
      grogoniSessionContext.conversationId === conversationId
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void patchGrogoniSessionContext({ mode, activeShopId, activeSurface, conversationId });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeConversationId,
    business?.id,
    mode,
    session?.account.id,
    grogoniSessionContext?.sessionVersion,
    view
  ]);

  useEffect(() => {
    if (authBootstrapPending) return;
    void loadPublicStorefronts();
  }, [authBootstrapPending]);

  useEffect(() => {
    void loadOAuthProviders();
    void handleOAuthCallback().then((handled) => {
      if (!handled) {
        void refreshSession();
      }
    });
  }, []);

  useEffect(() => {
    if (session === null) return;

    const savedPhone =
      session.user.phoneNumberE164 ??
      (session.account.primaryAuthChannel === "phone"
        ? session.account.primaryAuthDestination
        : null);
    if (savedPhone === null) return;

    const savedCountryCode = inferCountryCode(savedPhone);
    if (savedCountryCode !== null) {
      setShopPhoneCountryCode(savedCountryCode);
    }
    setShopPhoneNumber(savedPhone);
  }, [
    session?.account.primaryAuthChannel,
    session?.account.primaryAuthDestination,
    session?.user.phoneNumberE164
  ]);

  useEffect(() => {
    const initialRoute = readCurrentOwnerRoute();
    if (initialRoute === null) return;
    initializeOwnerHistory(initialRoute);
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";

    function restoreRoute() {
      const route = readCurrentOwnerRoute();
      if (route === null) return;
      const measurement = startNavigationMeasurement(window.location.pathname);
      setMode(route.mode);
      setView(route.view);
      setRoutedProductId(route.productId ?? null);
      setActiveConversationId(route.conversationId ?? null);
      setReplyToMessageId(null);
      setIsWorkspacePanelOpen(route.panel === "shop-hub");
      setIsMarketplaceShortcutOpen(false);
      markNavigationCommitted(measurement);
      const historyState = readGrogoniHistoryState(window.history.state);
      if (historyState !== null) {
        window.requestAnimationFrame(() => {
          window.scrollTo(historyState.scrollX, historyState.scrollY);
        });
      }
    }

    const unsubscribe = subscribeToBrowserNavigation(restoreRoute);
    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
      unsubscribe();
    };
  }, []);

  const navigationSessionSnapshotRef = useRef({
    activeConversationId,
    runtimeSessionId,
    chatDraft,
    chatMessages
  });
  useEffect(() => {
    navigationSessionSnapshotRef.current = {
      activeConversationId,
      runtimeSessionId,
      chatDraft,
      chatMessages
    };
    scheduleOwnerNavigationSessionWrite(
      session?.account.id ?? null,
      navigationSessionSnapshotRef.current
    );
  }, [activeConversationId, chatDraft, chatMessages, runtimeSessionId, session?.account.id]);

  // Deployment recovery (apps/web/src/lazy-module-recovery.ts) reloads the page on a confirmed
  // stale chunk before the debounced navigation-session write above may have flushed - register a
  // synchronous flush so the active conversation and any unsent composer draft never lose the
  // latest keystroke to that reload.
  useEffect(
    () =>
      registerPreReloadFlush(() => {
        writeOwnerNavigationSession(
          session?.account.id ?? null,
          navigationSessionSnapshotRef.current
        );
      }),
    [session?.account.id]
  );

  useEffect(() => {
    if (routedProductId === null || products.length === 0) return;
    const product = products.find((candidate) => candidate.id === routedProductId);
    if (product === undefined) {
      setRoutedProductId(null);
      navigateToView("products", { replace: true, mode: "seller" });
      setStatusMessage("That product is no longer available.");
      return;
    }
    populateProductForm(product);
  }, [products, routedProductId]);

  useEffect(() => {
    function updateOnlineStatus() {
      setIsOnline(navigator.onLine);
    }

    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    if (session === null && business === null) {
      localStorage.removeItem(activeAgentStorageKey);
      return;
    }
    localStorage.setItem(activeAgentStorageKey, JSON.stringify(agentSettings));
  }, [agentSettings, business, session]);

  useOssAgentSelectionState({
    agentSettings,
    setAgentSettings,
    business,
    session,
    isOnline,
    setupComplete,
    setStatusMessage
  });

  useEffect(() => {
    localStorage.setItem(activeModeStorageKey, mode);
  }, [mode]);

  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    void ensureE2eeIdentity(session.account.id)
      .then(async (identity) => {
        await postJson<E2eeDeviceSummary>("/v1/e2ee/devices", {
          deviceId: identity.deviceId,
          label:
            (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
              ?.platform ||
            navigator.platform ||
            "This browser",
          publicKey: identity.publicKey
        });
        if (!cancelled) setE2eeIdentity(identity);
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [session?.account.id]);

  useEffect(() => {
    if (session === null || e2eeIdentity === null) return;
    let cancelled = false;
    const refresh = async () => {
      const notificationConversationId = new URLSearchParams(window.location.search).get(
        "conversation"
      );
      const routeConversationId = readCurrentOwnerRoute()?.conversationId ?? null;
      if (!cancelled) {
        await loadMessagingInbox(
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
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 4_000);
    const onOnline = () => {
      void retryQueuedMessages();
      void refresh();
    };
    const onServiceWorkerMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; conversationId?: string };
      if (data.type === "message.notification.open" && data.conversationId) {
        void selectConversation(data.conversationId);
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
  }, [session?.account.id, activeConversationId, e2eeIdentity?.deviceId, mode]);

  useEffect(() => {
    if (business !== null) {
      localStorage.removeItem(setupDraftStorageKey);
      return;
    }
    if (!isBusinessSetupOpen && businessName.trim().length === 0) {
      localStorage.removeItem(setupDraftStorageKey);
      return;
    }

    const draft: SetupDraft = {
      countryCode: shopPhoneCountryCode,
      businessName,
      language,
      completedStep: businessSetupStep === "phone" ? 1 : 2
    };
    localStorage.setItem(setupDraftStorageKey, JSON.stringify(draft));
  }, [
    business,
    businessName,
    businessSetupStep,
    isBusinessSetupOpen,
    language,
    shopPhoneCountryCode
  ]);

  useEffect(() => {
    if (business !== null) {
      setAgentSettings((agent) => {
        const defaultAgent = createDefaultAgent(business);

        if (agent.globalAgentId.length === 0) {
          return defaultAgent;
        }

        if (
          agent.globalAgentId === defaultAgent.globalAgentId &&
          agent.storefrontUrl === defaultAgent.storefrontUrl
        ) {
          return agent;
        }

        return {
          ...agent,
          globalAgentId: defaultAgent.globalAgentId,
          storefrontUrl: defaultAgent.storefrontUrl
        };
      });
      setChatMessages((messages) =>
        messages[0]?.id === "welcome"
          ? createInitialChatMessages(business.name)
          : [
              createInitialChatMessages(business.name)[0] as ChatMessage,
              ...messages.filter((message) => message.id !== "welcome")
            ]
      );
    }
  }, [business]);

  useEffect(() => {
    if (!setupComplete || business === null || session === null) return;

    let cancelled = false;
    const accountId = session.account.id;
    const businessId = business.id;

    if (navigator.onLine && hasServerAuthenticatedSession(authBootstrapState)) {
      logClientEvent("agent.runtime_restore_started", { accountId, businessId });
      void restoreOrCreateRuntimeSession(setRuntimeSessionId)
        .then((restoredRuntimeSessionId) => {
          if (cancelled) return;
          logClientEvent("agent.runtime_restore_completed", {
            accountId,
            businessId,
            runtimeSessionId: restoredRuntimeSessionId
          });
        })
        .catch((error) => {
          if (cancelled) return;
          logClientEvent("agent.runtime_restore_failed", {
            accountId,
            businessId,
            errorCode: getErrorMessage(error)
          });
          if (!rejectDefinitiveAuthenticationFailure(error)) {
            setStatusMessage(
              `Your shop is open, but its agent session could not start. ${getErrorMessage(error)}`
            );
          }
        });
    }
    // The agent's model is always resolved server-side (see ensureDefaultRuntimeForTurn in
    // services/api/src/cp2/domains/agent-runtime/store.ts) - there is no private per-device model
    // installation to restore or re-activate on launch.

    return () => {
      cancelled = true;
    };
  }, [business?.id, session?.account.id, setupComplete, isOnline, authBootstrapState]);

  useEffect(() => {
    if (!setupComplete || business === null) {
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    const businessId = business.id;

    async function refreshActiveView(force = false) {
      if (
        cancelled ||
        refreshInFlight ||
        (!force &&
          (session === null || !navigator.onLine || document.visibilityState !== "visible"))
      ) {
        return;
      }

      refreshInFlight = true;
      // Domain hooks extracted from OwnerApp register their own `load*` here (keyed by which
      // views should trigger them) instead of adding another inline `if (view === ...)` branch
      // below - see apps/web/src/hooks/useViewRefresh.ts. Empty until the first hook registers.
      const refreshes: Promise<void>[] = refreshersFor(view).map((refresh) => refresh(businessId));

      if (view === "invoices") {
        refreshes.push(loadCustomers(businessId));
      }

      if (view === "runtime") {
        refreshes.push(loadRuntimeSessions(businessId));
      }

      await Promise.allSettled(refreshes);
      refreshInFlight = false;
    }

    void refreshActiveView(true);
    const interval = window.setInterval(
      () => void refreshActiveView(),
      uiBackgroundRefreshIntervalMs
    );
    const refreshWhenForegrounded = () => {
      if (document.visibilityState === "visible") {
        void refreshActiveView();
      }
    };
    const refreshWhenOnline = () => void refreshActiveView();

    document.addEventListener("visibilitychange", refreshWhenForegrounded);
    window.addEventListener("focus", refreshWhenForegrounded);
    window.addEventListener("online", refreshWhenOnline);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenForegrounded);
      window.removeEventListener("focus", refreshWhenForegrounded);
      window.removeEventListener("online", refreshWhenOnline);
    };
  }, [business?.id, session?.account.id, setupComplete, view]);

  useEffect(() => {
    if (!setupComplete || business === null) return;
    const businessId = business.id;
    let refreshTimer: number | null = null;

    const unsubscribe = subscribeToApiMutations((path) => {
      if (!shouldRefreshBusinessDomains(path, businessId) || refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void Promise.allSettled(allRefreshers().map((refresh) => refresh(businessId)));
      }, 50);
    });

    return () => {
      unsubscribe();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [business?.id, setupComplete]);

  useEffect(() => {
    if (!setupComplete || business === null) return;
    const likelyViews = likelyNextOwnerViews(view);
    if (likelyViews.length === 0) return;
    return scheduleIdleOwnerPrefetch(likelyViews, business.id);
  }, [business?.id, setupComplete, view]);

  useEffect(() => {
    if (!setupComplete || view !== "chat" || business === null) return;
    let cancelled = false;
    const hydrate = () => {
      if (cancelled) return;
      void Promise.allSettled([
        loadProducts(business.id),
        loadProductFields(business.id),
        loadSuppliers(business.id),
        loadCustomers(business.id),
        loadInvoices(business.id),
        loadReports(business.id),
        loadNetworkGraph(),
        loadNetworkInvites(business.id)
      ]);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(hydrate, { timeout: 1_200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }
    const timeoutId = window.setTimeout(hydrate, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [business?.id, setupComplete, view]);

  async function resetClientToStartup(accountId: string | null, message: string) {
    if (accountId !== null) {
      await syncRepositoryRef.current?.clearAllAccountData(accountId).catch(() => undefined);
      clearMessagingOutbox(accountId);
    }
    await clearPersistentApiRequestCache();
    await clearDeviceRecoveryCredential().catch(() => undefined);
    clearCachedAuthSession();
    clearOwnerNavigationSession(accountId);
    clearOwnerNavigationSession(null);
    localStorage.removeItem(activeBusinessStorageKey);
    localStorage.removeItem(legacyActiveBusinessStorageKey);
    localStorage.removeItem(activeAgentStorageKey);
    localStorage.removeItem(activeModeStorageKey);
    localStorage.removeItem(ownerAuthStorageKey);
    localStorage.removeItem(setupDraftStorageKey);
    sessionStorage.removeItem(pendingOAuthStorageKey);
    sessionStorage.removeItem(guestBrowsingStorageKey);
    setSession(null);
    setBusiness(null);
    // Fires every domain hook's registered reset (empty until each phase of the OwnerApp state
    // decomposition lands its hook - see docs/architecture/frontend-modularization-roadmap.md).
    // Ordered after session/business so any in-flight request's `business === null` guard already
    // sees the logged-out state before a domain's own reset could race a just-completed response.
    domainResetRegistry.resetAll();
    setAgentSettings(createDefaultAgent(null));
    setAuthBootstrapState("unauthenticated");
    setE2eeIdentity(null);
    setView("chat");
    setMode("marketplace");
    navigateToOwnerRoute({ mode: "marketplace", view: "chat" }, { replace: true });
    setIsWorkspacePanelOpen(false);
    // isBusinessSetupOpen/isAccountRestorationOpen/routedProductId are already closed/cleared by
    // domainResetRegistry.resetAll() above (BusinessSetup/Auth/Navigation's own registered resets) -
    // setIsAuthOpen(true)/setAuthenticationView("signup") are the one deliberate override Auth's own
    // reset doesn't make (its reset closes the auth screen; post-logout wants it open on signup).
    setIsAuthOpen(true);
    setAuthenticationView("signup");
    window.history.replaceState(window.history.state, "", authenticationRoute("signup"));
    setStatusMessage(message);
  }

  async function logout(allSessions = false) {
    const accountId = session?.account.id ?? null;
    try {
      await postJson(allSessions ? "/auth/logout-all" : "/auth/logout", {});
    } catch {
      // Local state still needs to return to startup if the API is unavailable.
    }

    await resetClientToStartup(
      accountId,
      allSessions ? "Signed out on every device." : "Signed out."
    );
  }

  const ownerWorkspaceBindings: OwnerWorkspaceBindings = {
    businessId: business?.id ?? null,
    businessPermissions: permissionsForOpenShop(grogoniSessionContext, business?.id ?? null),
    view,
    publicStorefrontUrl,
    asyncActions: { runAction },
    productsState: {
      products,
      productForm,
      stockProductId,
      stockQuantityAfter,
      stockReason,
      setProductForm,
      setStockProductId,
      setStockQuantityAfter,
      setStockReason,
      loadProducts,
      saveProduct,
      deleteProduct,
      adjustStock
    },
    suppliersState: {
      suppliers,
      purchaseReceipts,
      receiptOcrJobs,
      supplierForm,
      setSupplierForm,
      saveSupplier,
      deleteSupplierCard,
      saveSalesAgent,
      deleteSalesAgentCard,
      searchSupplierContacts,
      linkSupplierPhoneContact,
      createSupplierFromPhoneContact,
      linkSalesAgentPhoneContact,
      createSalesAgentFromPhoneContact,
      uploadSupplierReceipt,
      confirmSupplierReceipt
    },
    customersState: { customers, customerForm, setCustomerForm, saveCustomer, loadCustomers },
    invoicesState: {
      invoices,
      invoiceForm,
      invoicePreview,
      setInvoiceForm,
      setInvoicePreview,
      previewInvoice,
      saveInvoice,
      confirmInvoice,
      printInvoice,
      loadInvoices
    },
    networkState: {
      networkGraph,
      networkInvites,
      loadNetworkGraph,
      loadNetworkInvites,
      syncPhoneNetwork,
      syncSocialNetwork,
      requestNetworkRoute,
      approveNetworkRoute,
      rejectNetworkRoute,
      disconnectNetworkSource,
      shareOwnerStorefrontInvite,
      syncOwnerPhoneContacts,
      importContactsFile,
      exportOwnerContacts
    },
    syncState: {
      syncSummary,
      syncQueue,
      offlineCache,
      loadSyncQueue,
      loadOfflineCache,
      replaySyncQueue,
      replaySyncQueueItem
    },
    runtimeHistoryState: {
      runtimeSessions,
      selectedRuntimeHistorySessionId,
      setSelectedRuntimeHistorySessionId,
      runtimeTurns,
      loadRuntimeSessions,
      loadRuntimeTurns,
      createRuntimeHistorySession
    },
    paymentsState: {
      payments,
      invoicePayments,
      customerDebts,
      paymentForm,
      setPaymentForm,
      loadPaymentData,
      recordPayment
    },
    importsState: {
      importForm,
      importJobs,
      activeImportJob,
      selectedImportJobId,
      setImportForm,
      setSelectedImportJobId,
      createDocumentImport,
      updateImportRowLocal,
      saveImportRow,
      confirmImport,
      loadDocumentImports
    },
    logisticsState: {
      logistics,
      logisticsForm,
      setLogisticsForm,
      loadLogistics,
      createLogistics,
      updateLogisticsStatus
    },
    readinessState: {
      securityReview,
      dataExport,
      verificationTier,
      taxConfig,
      deviceTrust,
      complianceForm,
      setComplianceForm,
      loadCompliance,
      createDataExport,
      saveVerificationTier,
      saveTaxConfig,
      saveDeviceTrust,
      betaReadiness,
      betaSupportTickets,
      betaForm,
      setBetaForm,
      loadBetaReadiness,
      updateBetaAccess,
      enableBetaFlags,
      recordBetaDeviceTest,
      createBetaSupportTicket,
      updateBetaSupportTicketStatus,
      recordBetaTelemetry,
      launchReadiness,
      launchIncidents,
      launchForm,
      setLaunchForm,
      loadLaunchReadiness,
      updateLaunchSettings,
      updateLaunchChecklist,
      createLaunchIncident,
      updateLaunchIncidentStatus
    },
    reportsState: { reportSummary, knowledgeSummary, loadReports },
    notificationState: { notificationInbox, loadNotifications, updateNotification },
    storefrontCareState: {
      storefrontCareRequests,
      storefrontMessages,
      storefrontOrders,
      loadStorefrontInbox
    },
    navigationState: { navigateToView, setRoutedProductId, openProduct },
    authState: { authenticateSocialProfile, oauthProviders },
    chatThreadState: { setChatMessages, setRuntimeSessionId }
  };

  return (
    <OwnerCoreProvider value={ownerCoreValue}>
      <Surface title="Grogoni">
        <div
          className={
            isAuthScreen
              ? "app-frame auth-frame"
              : `app-frame${isCapabilityTraceOpen ? " capability-trace-visible" : ""}`
          }
          data-shell-instance={shellInstanceIdRef.current}
          data-capability-profile={capabilitySettingsRef.current.profile}
          data-commerce-mode={mode === "seller" ? "sell" : "buy"}
          data-shell-view={view}
        >
          <header className={isAuthScreen ? "top-bar auth-top-bar" : "top-bar"}>
            {!isAuthScreen ? (
              <button
                className="shell-menu-button"
                type="button"
                aria-label="Open menu"
                aria-expanded={isMenuDrawerOpen}
                onClick={() => setIsMenuDrawerOpen(true)}
              >
                <span aria-hidden="true" />
              </button>
            ) : null}
            {business === null ? (
              <div className="auth-brand-title">
                {isAuthScreen ? (
                  <AppIcon className="auth-header-icon" />
                ) : (
                  <span className="home-brand-mark" aria-hidden="true">
                    S
                  </span>
                )}
                <span>Grogoni</span>
              </div>
            ) : (
              <button
                className="brand-lockup"
                type="button"
                onClick={() => {
                  if (!setupComplete) return;
                  setAgentProfileInitialSection(null);
                  openAgentProfile();
                }}
                onPointerEnter={() => prefetchOwnerView("agent", business.id)}
                onFocus={() => prefetchOwnerView("agent", business.id)}
              >
                <span className="home-brand-mark" aria-hidden="true">
                  S
                </span>
                <span>
                  <strong>Grogoni</strong>
                  <span>{business.name}</span>
                  <small>{shouldShowAuth ? "Saved workspace loaded" : agentSettings.name}</small>
                  <small>{commerceAddressFromGrogoniId(business.grogoniId)}</small>
                </span>
              </button>
            )}
            {isAuthScreen && installPrompt.canInstall ? (
              <button
                className="header-action-button workspace"
                type="button"
                data-testid="install-app-button"
                onClick={() => void installPrompt.installApp()}
              >
                Install app
              </button>
            ) : null}
            {!isAuthScreen ? (
              <>
                <button
                  className={`header-action-button shell-capability-trace-button${
                    isCapabilityTraceOpen ? " on" : ""
                  }`}
                  type="button"
                  aria-pressed={isCapabilityTraceOpen}
                  aria-label={
                    isCapabilityTraceOpen ? "Hide capability calls" : "Show capability calls"
                  }
                  onClick={() => setIsCapabilityTraceOpen((open) => !open)}
                >
                  <span className="capability-trace-icon" aria-hidden="true" />
                </button>
                <button
                  className={
                    business === null
                      ? "icon-button shell-agent-button shop-entry-button"
                      : "icon-button shell-agent-button"
                  }
                  type="button"
                  data-testid={business === null ? "shop-entry-button" : "agent-profile-link"}
                  onClick={() => {
                    if (business === null) {
                      switchMode("seller");
                    } else {
                      setAgentProfileInitialSection(null);
                      openAgentProfile();
                    }
                  }}
                  aria-label={business === null ? "Open your shop" : "Account and agent settings"}
                  onPointerEnter={() => prefetchOwnerView("agent", business?.id ?? null)}
                  onFocus={() => prefetchOwnerView("agent", business?.id ?? null)}
                >
                  {business === null ? (
                    <span className="shop-entry-icon" aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true">{userLabel.slice(0, 1).toUpperCase()}</span>
                  )}
                </button>
              </>
            ) : null}
          </header>
          {!isAuthScreen ? (
            <MenuDrawer
              open={isMenuDrawerOpen}
              hasBusiness={business !== null}
              onClose={() => setIsMenuDrawerOpen(false)}
              onBrowse={() => {
                setIsMenuDrawerOpen(false);
                if (mode !== "marketplace") switchMode("marketplace");
                if (view !== "chat" && view !== "home") returnToChat();
                setIsMarketplaceShortcutOpen(true);
              }}
              onMessageHistory={() => {
                setIsMenuDrawerOpen(false);
                if (view !== "chat" && view !== "home") returnToChat();
                setIsMessagingInboxOpen(true);
              }}
              onGoToShop={() => {
                setIsMenuDrawerOpen(false);
                openShopHub();
              }}
              onShopSettings={() => {
                setIsMenuDrawerOpen(false);
                setAgentProfileInitialSection("business");
                openAgentProfile();
              }}
              onAgentSettings={() => {
                setIsMenuDrawerOpen(false);
                setAgentProfileInitialSection("agent");
                openAgentProfile();
              }}
              onAccountSettings={() => {
                setIsMenuDrawerOpen(false);
                setAgentProfileInitialSection("security");
                openAgentProfile();
              }}
              onSetUpShop={() => {
                setIsMenuDrawerOpen(false);
                switchMode("seller");
              }}
            />
          ) : null}
          {!isAuthScreen && (
            <OfflineRuntimeNotice
              onReview={() => {
                setAgentProfileInitialSection(null);
                openAgentProfile();
              }}
            />
          )}

          {!isAuthScreen ? (
            <nav
              className="shell-mode-bar"
              aria-label={mode === "seller" ? "Commerce mode and messages" : "Shell actions"}
            >
              <button
                className={`header-action-button marketplace commerce-mode-toggle ${
                  mode === "marketplace" && isMarketplaceShortcutOpen ? "mode-active" : ""
                }`}
                type="button"
                data-testid="marketplace-button"
                aria-label="Marketplace"
                aria-expanded={mode === "marketplace" && isMarketplaceShortcutOpen}
                onClick={() => {
                  if (mode === "marketplace") {
                    if (view !== "chat" && view !== "home") returnToChat();
                    setIsMarketplaceShortcutOpen((open) =>
                      view === "chat" || view === "home" ? !open : true
                    );
                    return;
                  }
                  switchMode("marketplace");
                }}
              >
                {/* A seller previewing the buyer side reads this as "switch to Buy"; a customer
                    reads it as "browse shops/cart", since they're already shopping. Neither is the
                    removed Buy/Sell mode-switch pill - it never renders a "Sell" counterpart and,
                    for a customer, never changes mode at all. */}
                {mode === "seller" ? "Buy" : "Browse"}
              </button>
              {mode === "seller" ? (
                <button
                  className="header-action-button messages"
                  type="button"
                  data-testid="messages-button"
                  aria-expanded={isMessagingInboxOpen}
                  onClick={() => {
                    if (view !== "chat" && view !== "home") returnToChat();
                    setIsMessagingInboxOpen((open) => !open);
                  }}
                >
                  Messages
                </button>
              ) : null}
              <div className="shell-secondary-actions">
                {installPrompt.canInstall ? (
                  <button
                    className="header-action-button workspace"
                    type="button"
                    data-testid="install-app-button"
                    onClick={() => void installPrompt.installApp()}
                  >
                    Install app
                  </button>
                ) : null}
                {mode === "seller" && session === null ? (
                  <>
                    <button
                      className="header-auth-button secondary"
                      type="button"
                      data-testid="header-signup-button"
                      onClick={() => openAuth("signup")}
                    >
                      Sign up
                    </button>
                    <button
                      className="header-auth-button"
                      type="button"
                      data-testid="header-login-button"
                      onClick={() => openAuth("login")}
                    >
                      Log in
                    </button>
                  </>
                ) : null}
                {business !== null && mode === "seller" ? (
                  <button
                    className="header-action-button workspace"
                    type="button"
                    onClick={openShopHub}
                    aria-haspopup="dialog"
                  >
                    Workspace
                  </button>
                ) : null}
              </div>
            </nav>
          ) : null}

          <ShellNotices
            statusMessage={isAuthScreen ? "" : statusMessage}
            working={hasPending}
            accountId={isAuthScreen || authBootstrapPending ? null : (session?.account.id ?? null)}
            signedOut={!isAuthScreen && !authBootstrapPending && session === null}
            onJoinedShop={(shop) => joinStaffShop(shop, setActiveConversationId)}
          />
          {authBootstrapPending ? (
            <NativeLaunchScreen
              message={bootstrapProgressMessage(
                authBootstrapState,
                business !== null,
                agentSettings.name.trim().length > 0
              )}
            />
          ) : shouldShowAuth && authenticationView === "signup" ? (
            <PhoneSignup
              onAuthenticated={(response) => void completePhoneFirstAuthentication(response)}
              onLogIn={() => openAuth("login")}
              onCancel={browseAsGuest}
            />
          ) : shouldShowAuth ? (
            <PhoneFirstAuthentication
              key={authenticationView}
              remembered={rememberedAccount}
              onAuthenticated={(response) => void completePhoneFirstAuthentication(response)}
              onSignUp={() => openAuth("signup")}
              onForgetRemembered={forgetRememberedOwnerAuth}
              onCancel={browseAsGuest}
            />
          ) : isAccountRestorationOpen && session !== null ? (
            <Suspense fallback={<NativeLaunchScreen message="Opening account restoration…" />}>
              <AccountRestorationPanel
                onRestored={completeAccountRestoration}
                onCancel={() => {
                  setIsAccountRestorationOpen(false);
                  navigateToOwnerRoute({ mode: "marketplace", view: "chat" }, { replace: true });
                  setStatusMessage("Account restoration cancelled.");
                }}
              />
            </Suspense>
          ) : isBusinessSetupOpen && business === null ? (
            <BusinessSetupPanel
              step={businessSetupStep}
              businessName={businessName}
              language={language}
              phoneCountryCode={shopPhoneCountryCode}
              phoneNumber={shopPhoneNumber}
              statusMessage={statusMessage}
              isPending={isPending("business-create") || isPending("owner-phone-save")}
              onBusinessNameChange={setBusinessName}
              onLanguageChange={setLanguage}
              onPhoneCountryCodeChange={setShopPhoneCountryCode}
              onPhoneNumberChange={setShopPhoneNumber}
              onContinuePhone={(phoneNumber, country) =>
                void runAction("owner-phone-save", () =>
                  saveOwnerPhoneForShop(phoneNumber, country)
                )
              }
              onEditPhone={() => setBusinessSetupStep("phone")}
              onBackToLoginOptions={() => {
                setIsBusinessSetupOpen(false);
                openAuth();
              }}
              onCancel={() => {
                setIsBusinessSetupOpen(false);
                setStatusMessage(
                  "Business setup cancelled. You can keep browsing the marketplace."
                );
              }}
              onCreateBusiness={() => void runAction("business-create", createBusiness)}
            />
          ) : (
            <main className="chat-workspace-shell">
              {session !== null ? (
                <IdentityNetworkOnboardingCard
                  session={session}
                  graph={networkGraph}
                  oauthProviders={oauthProviders}
                  oauthProvidersLoaded={oauthProvidersLoaded}
                  onGoogleContacts={authenticateSocialProfile}
                  onPhoneContactsSync={syncSelectedNetworkPhoneContacts}
                />
              ) : null}
              <ChatSurface
                chatDraft={chatDraft}
                initialEmailSubject={
                  activeConversation?.messages
                    .slice()
                    .reverse()
                    .find((message) => message.provider === "email" && message.subject)?.subject ??
                  ""
                }
                invoices={invoices}
                messages={chatMessages}
                conversations={conversationInbox}
                activeConversationId={activeConversationId}
                isInboxOpen={isMessagingInboxOpen}
                isContactTyping={isContactTyping}
                isConfirming={isPending("runtime-confirm")}
                isSending={isPending("chat-send")}
                isBrowserGenerating={isBrowserGenerating}
                securityLabel={
                  isBrowserGenerating
                    ? "On-device · generating"
                    : session === null
                      ? "Sign in for end-to-end encrypted messaging"
                      : isHumanDirectConversation(activeConversation, session)
                        ? "End-to-end encrypted"
                        : "Messages are processed by the Grogoni agent"
                }
                replyToMessageId={replyToMessageId}
                networkGraph={networkGraph}
                networkDevicePhonebook={devicePhonebook}
                networkInvites={networkInvites}
                onNetworkConnectionAction={runNetworkConnectionAction}
                oauthProviders={oauthProviders}
                oauthProvidersLoaded={oauthProvidersLoaded}
                pendingAttachments={pendingAttachments}
                productForm={productForm}
                productFields={productFields}
                productCount={products.length}
                products={products}
                publicStorefronts={publicStorefronts}
                publicStorefrontsLoading={publicStorefrontsLoading}
                shopPresenceStatus={shopPresenceStatus}
                workspaceOpen={isWorkspacePanelOpen}
                buyFeed={buyFeed}
                isSearchingBuyFeed={isPending("buy-search")}
                buyCart={buyCart}
                isCheckingOut={isPending("buy-checkout")}
                onAttachmentChange={handleChatAttachmentChange}
                onSellerPhotoCapture={(file) => void handleSellerPhotoCapture(file)}
                onStatusBroadcastPosted={handleStatusBroadcastPosted}
                onSearchBuyFeed={(query) => void handleSearchBuyFeed(query)}
                onAddToCart={handleAddToCart}
                onRemoveFromCart={handleRemoveFromCart}
                onCheckout={() => void handleCheckout()}
                onRefreshInvoices={() => {
                  if (business !== null) void loadInvoices(business.id);
                }}
                onBackToChat={returnToChat}
                onConfirm={(token) =>
                  void runAction("runtime-confirm", () => confirmRuntimeAction(token))
                }
                onDraftChange={(draft) => void signalTyping(draft)}
                onSelectConversation={(conversationId) => void selectConversation(conversationId)}
                onCreateConversation={(recipient, title) =>
                  void runAction("conversation-create", () =>
                    createDirectConversation(recipient, title)
                  )
                }
                onCreateAgentSession={(title) =>
                  void runAction("agent-session-create", () => createAgentSession(title))
                }
                onRequireSignIn={requireMessagingSignIn}
                onBrowseAsGuest={browseAsGuest}
                onSignUp={() => openAuth("signup")}
                onLogIn={() => openAuth("login")}
                recognizedDeviceLabel={recognizedDeviceLabel}
                onRefreshPublicStorefronts={() => void loadPublicStorefronts()}
                onConversationPreference={(conversationId, preference) =>
                  void runAction("conversation-preference", () =>
                    updateConversationPreference(conversationId, preference)
                  )
                }
                onRenameConversation={(conversationId, title) =>
                  void runAction("conversation-rename", () =>
                    renameConversation(conversationId, title)
                  )
                }
                recycleBin={recycleBin}
                onDeleteConversation={(conversationId) =>
                  void runAction("conversation-delete", () => deleteConversation(conversationId))
                }
                onRestoreConversation={(conversationId) =>
                  void runAction("conversation-restore", () => restoreConversation(conversationId))
                }
                onLoadRecycleBin={() => void runAction("recycle-bin-load", loadRecycleBin)}
                onEmptyRecycleBin={(conversationIds) =>
                  void runAction("recycle-bin-empty", () => emptyRecycleBin(conversationIds))
                }
                onEnableNotifications={() =>
                  void runAction("push-notifications", requestMessagingNotifications)
                }
                onInboxOpenChange={setIsMessagingInboxOpen}
                onReply={setReplyToMessageId}
                onCancelReply={() => setReplyToMessageId(null)}
                onEditMessage={(messageId, text) =>
                  void runAction("message-edit", () => updateMessageAction(messageId, { text }))
                }
                onDeleteMessage={(messageId) =>
                  void runAction("message-delete", () =>
                    updateMessageAction(messageId, { deleted: true })
                  )
                }
                onReactMessage={(messageId, reaction) =>
                  void runAction(`message-reaction-${messageId}`, () =>
                    updateMessageAction(messageId, { reaction })
                  )
                }
                onAgentFeedback={(messageId, correct) =>
                  void runAction(`agent-feedback-${messageId}`, () =>
                    submitAgentResponseFeedback(messageId, correct)
                  )
                }
                onForwardMessage={(messageId, conversationId) =>
                  void runAction("message-forward", () => forwardMessage(messageId, conversationId))
                }
                onRetryMessages={() => void runAction("message-retry", retryQueuedMessages)}
                onCloseWorkspace={closeShopHub}
                onOpenWorkspace={openShopHub}
                onNavigate={navigateToView}
                onModeChange={switchMode}
                onProductEdit={(product) => {
                  setProductForm({
                    id: product.id,
                    name: product.name,
                    sku: product.sku ?? "",
                    unit: product.unit,
                    quantity: String(product.quantity),
                    buyingPrice: product.buyingPrice === null ? "" : String(product.buyingPrice),
                    sellingPrice: product.sellingPrice === null ? "" : String(product.sellingPrice),
                    fieldValues: product.fieldValues ?? {}
                  });
                  setStockProductId(product.id);
                  setStockQuantityAfter(String(product.quantity));
                }}
                onProductFieldsSave={(fields) =>
                  void runAction("product-fields-save", () => saveProductFieldStructure(fields))
                }
                onProductFormChange={setProductForm}
                onProductRemove={(productId) =>
                  void runAction("product-delete", () => deleteProduct(productId))
                }
                onProductReset={() => setProductForm(emptyProductForm)}
                onProductSave={async () => (await runAction("product-save", saveProduct)) ?? false}
                onProductsDuplicated={() => {
                  if (business !== null) void loadProducts(business.id);
                }}
                onNetworkDisconnectSource={(sourceId) =>
                  void runAction("network-disconnect", () => disconnectNetworkSource(sourceId))
                }
                onNetworkPhoneContactsSync={syncSelectedNetworkPhoneContacts}
                onNetworkInviteContacts={inviteNetworkContacts}
                onNetworkProviderOAuth={authenticateSocialProfile}
                onNetworkRefresh={() => void loadNetworkGraph({ fresh: true })}
                onRemoveAttachment={removePendingAttachment}
                onStatusChange={updateShopPresenceStatus}
                onOpenAgentProfile={() => openAgentProfile()}
                onCompleteMarketplaceIntro={() => void completeMarketplaceIntro()}
                marketplaceIntroComplete={isMarketplaceIntroComplete}
                marketplaceShortcutOpen={isMarketplaceShortcutOpen}
                onCloseMarketplace={() => setIsMarketplaceShortcutOpen(false)}
                onSend={(draft, provider, subject, invoiceId) =>
                  void runAction("chat-send", () =>
                    sendChatDraft(draft, provider, subject, invoiceId)
                  )
                }
                channelEndpoints={activeConversation?.channels ?? []}
                onCancelGeneration={() => cancelGeneration()}
                onSmsHandoff={recordSmsHandoff}
                onPlatformHandoff={recordPlatformHandoff}
              >
                {view === "agent" && business !== null ? (
                  <LazyModuleErrorBoundary
                    moduleKey={agentProfileModuleKeys.surface}
                    label="Account and agent settings"
                  >
                    <Suspense fallback={<NativeLaunchScreen message="Opening agent settings…" />}>
                      <AgentProfileSurface
                        initialOpenSection={agentProfileInitialSection}
                        conversationId={activeConversationId}
                        chatMessages={chatMessages}
                        agent={agentSettings}
                        accountId={session?.account.id ?? ""}
                        identityLevel={session?.account.identityLevel ?? "device"}
                        business={business}
                        oauthProviders={oauthProviders}
                        ownerLabel={userLabel}
                        ownerUser={session?.user ?? null}
                        registeredEmail={
                          session?.user.emailAddress ??
                          (session?.account.primaryAuthChannel === "email"
                            ? session.account.primaryAuthDestination
                            : null)
                        }
                        storefrontUrl={publicStorefrontUrl}
                        shops={grogoniSessionContext?.shops ?? []}
                        onSwitchBusiness={switchActiveBusiness}
                        onAgentChange={setAgentSettings}
                        onIdentityLevelChange={(identityLevel) =>
                          setSession((current) =>
                            current === null
                              ? current
                              : { ...current, account: { ...current.account, identityLevel } }
                          )
                        }
                        onAccountMerged={(response) => {
                          acceptAuthenticatedSession(response);
                          setStatusMessage("Accounts joined after identity verification.");
                        }}
                        onOwnerUserChange={(user) =>
                          setSession((current) =>
                            current === null ? current : { ...current, user }
                          )
                        }
                        onBack={returnToChat}
                        onEnableNotifications={requestMessagingNotifications}
                        onDisableNotifications={disableMessagingNotifications}
                        onLogout={() => void runAction("logout", logout)}
                        onLogoutAll={() => void runAction("logout-all", () => logout(true))}
                        onScheduleAccountDeletion={scheduleAccountDeletion}
                        isLoggingOut={isPending("logout") || isPending("logout-all")}
                      />
                    </Suspense>
                  </LazyModuleErrorBoundary>
                ) : (
                  renderOwnerWorkspace(ownerWorkspaceBindings)
                )}
              </ChatSurface>
            </main>
          )}
          <footer className="app-credits">
            <span>Karibu Grogoni</span>
            <BuildIdentity />
          </footer>
        </div>
      </Surface>
    </OwnerCoreProvider>
  );
}
