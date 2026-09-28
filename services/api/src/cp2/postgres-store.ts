import { randomUUID } from "node:crypto";
import type { Metrics } from "@soko/observability";
import {
  ACCOUNT_SYNC_COLLECTIONS,
  isAccountSyncCollection,
  type AccountSyncCollection,
  type SyncRealtimeChangesAvailableEvent
} from "@soko/shared-types";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { positiveIntegerFromEnv } from "@soko/resource-control";
import { buildPgPoolConfig } from "../db-pool-config.js";
import {
  createCp2Store,
  type Cp2Snapshot,
  type Cp2Store,
  type Cp2StoreOptions,
  type PasskeyCeremonyRecord
} from "./store.js";
import type { ConversationAttachmentBlobStore } from "./conversation-attachment-blob-store.js";
import {
  assertArtifactChunk,
  hydrateAccountAgentManifest,
  modelArtifactFromInstallation,
  type AccountAiAssetStore
} from "./account-ai-asset-store.js";
import type {
  CloudModelArtifactSummary,
  InstalledOssAgentManifestSummary
} from "@soko/shared-types";
import type { ConversationAttachmentRecord } from "./workspace-file-delivery.js";

type SnapshotCollectionKey = keyof Cp2Snapshot;
type SnapshotRecord = Record<string, unknown>;

interface NormalizedCollection {
  key: SnapshotCollectionKey;
  tableName: string;
}

export const normalizedCollections: NormalizedCollection[] = [
  { key: "accounts", tableName: "cp2_accounts" },
  { key: "users", tableName: "cp2_users" },
  { key: "deviceAccountBootstraps", tableName: "cp2_device_account_bootstraps" },
  { key: "deviceRecoveryCredentials", tableName: "cp2_device_recovery_credentials" },
  { key: "businesses", tableName: "cp2_businesses" },
  { key: "sokoIdHistory", tableName: "cp2_soko_id_history" },
  { key: "memberships", tableName: "cp2_memberships" },
  { key: "sessionContexts", tableName: "cp2_session_contexts" },
  // Native runtime tables must persist before cp2_conversations: its generated
  // runtime_binding_id column carries a foreign key into cp2_native_runtime_bindings, so a
  // conversation rebound to a binding created in this same flush (e.g. "Use with agent"
  // activation) would violate that constraint if bindings were written afterward.
  { key: "nativeRuntimeAgents", tableName: "cp2_native_runtime_agents" },
  { key: "nativeRuntimeModels", tableName: "cp2_native_runtime_models" },
  { key: "nativeExecutionHosts", tableName: "cp2_native_execution_hosts" },
  { key: "nativeModelInstallations", tableName: "cp2_native_model_installations" },
  { key: "nativeRuntimeBindings", tableName: "cp2_native_runtime_bindings" },
  { key: "nativeRuntimeBindingModels", tableName: "cp2_native_runtime_binding_models" },
  // Runtime Handoff Protocol tables (083_runtime_handoff_protocol.sql, docs/architecture/
  // runtime-handoff-protocol.md). Handoffs must persist before task heads/instances: both
  // generated `active_handoff_id` columns carry a foreign key into cp2_runtime_handoffs.
  { key: "runtimeHandoffs", tableName: "cp2_runtime_handoffs" },
  { key: "runtimeTransfers", tableName: "cp2_runtime_transfers" },
  { key: "runtimeTaskHeads", tableName: "cp2_runtime_task_heads" },
  { key: "runtimeTaskInstances", tableName: "cp2_runtime_task_instances" },
  { key: "runtimeOperationDedup", tableName: "cp2_runtime_operation_dedup" },
  // Durable execution event log (docs/architecture/durable-execution-plane.md). Purely additive
  // next to the checkpoint/transfer tables above; append-only, no FK ordering constraint on them.
  { key: "runtimeExecutionEvents", tableName: "cp2_runtime_execution_events" },
  { key: "computerSessions", tableName: "cp2_computer_sessions" },
  { key: "computerProfiles", tableName: "cp2_computer_profiles" },
  { key: "computerApprovals", tableName: "cp2_computer_approvals" },
  { key: "computerAudits", tableName: "cp2_computer_audits" },
  { key: "modelCatalog", tableName: "cp2_model_catalog" },
  { key: "agentCatalog", tableName: "cp2_agent_catalog" },
  { key: "platformOperators", tableName: "cp2_platform_operators" },
  { key: "conversations", tableName: "cp2_conversations" },
  { key: "conversationParticipants", tableName: "cp2_conversation_participants" },
  { key: "conversationMessages", tableName: "cp2_conversation_messages" },
  { key: "conversationAttachments", tableName: "cp2_conversation_attachments" },
  { key: "platformIdentities", tableName: "platform_identities" },
  { key: "conversationChannels", tableName: "conversation_channels" },
  { key: "providerUpdateReceipts", tableName: "provider_update_receipts" },
  { key: "channelIdentityLinkGrants", tableName: "channel_identity_link_grants" },
  { key: "nativeSmsDevices", tableName: "native_sms_devices" },
  { key: "nativeSmsDeviceCommands", tableName: "native_sms_device_commands" },
  { key: "connectedMailboxes", tableName: "connected_mailboxes" },
  {
    key: "connectedMailboxOAuthSessions",
    tableName: "connected_mailbox_oauth_sessions"
  },
  { key: "customerRuntimeCapabilities", tableName: "customer_runtime_capabilities" },
  { key: "messageDeliveryAttempts", tableName: "cp2_message_delivery_attempts" },
  {
    key: "messageNotificationDeliveries",
    tableName: "cp2_message_notification_deliveries"
  },
  { key: "e2eeDevices", tableName: "cp2_e2ee_devices" },
  { key: "pushSubscriptions", tableName: "cp2_push_subscriptions" },
  { key: "marketplaceIntroStates", tableName: "cp2_marketplace_intro_states" },
  { key: "activeAiModels", tableName: "cp2_active_ai_models" },
  { key: "agentProfiles", tableName: "cp2_agent_profiles" },
  { key: "agentRuntimeVersions", tableName: "cp2_agent_runtime_versions" },
  { key: "agentContextSources", tableName: "cp2_agent_context_sources" },
  { key: "agentEvaluationEvents", tableName: "cp2_agent_evaluation_events" },
  { key: "agentOwnerCorrections", tableName: "cp2_agent_owner_corrections" },
  { key: "runtimeExperiences", tableName: "cp2_runtime_experiences" },
  { key: "installedAgentModels", tableName: "cp2_installed_agent_models" },
  { key: "modelTemplates", tableName: "cp2_model_templates" },
  { key: "modelTemplateVersions", tableName: "cp2_model_template_versions" },
  { key: "expertiseArtifacts", tableName: "cp2_expertise_artifacts" },
  { key: "evaluationSuites", tableName: "cp2_template_evaluation_suites" },
  { key: "evaluationCases", tableName: "cp2_template_evaluation_cases" },
  { key: "evaluationRuns", tableName: "cp2_template_evaluation_runs" },
  { key: "evaluationResults", tableName: "cp2_template_evaluation_results" },
  { key: "productionObservations", tableName: "cp2_template_production_observations" },
  { key: "expertCorrections", tableName: "cp2_template_expert_corrections" },
  { key: "datasetVersions", tableName: "cp2_template_dataset_versions" },
  { key: "datasetExamples", tableName: "cp2_template_dataset_examples" },
  { key: "improvementRuns", tableName: "cp2_template_improvement_runs" },
  { key: "templatePromotions", tableName: "cp2_template_promotions" },
  { key: "templateRuntimeBindings", tableName: "cp2_template_runtime_bindings" },
  { key: "productFieldSchemas", tableName: "cp2_product_field_schemas" },
  { key: "products", tableName: "cp2_products" },
  { key: "productMedia", tableName: "product_media" },
  { key: "productCaptureJobs", tableName: "product_capture_jobs" },
  { key: "statusBroadcasts", tableName: "status_broadcasts" },
  { key: "buyOrders", tableName: "buy_orders" },
  { key: "statusOrders", tableName: "status_orders" },
  { key: "unifiedCheckouts", tableName: "unified_checkouts" },
  { key: "customers", tableName: "cp2_customers" },
  { key: "suppliers", tableName: "cp2_suppliers" },
  { key: "salesAgents", tableName: "cp2_sales_agents" },
  { key: "supplierContactLinks", tableName: "cp2_supplier_contact_links" },
  { key: "purchaseReceipts", tableName: "cp2_purchase_receipts" },
  { key: "receiptLineItems", tableName: "cp2_receipt_line_items" },
  { key: "receiptOCRJobs", tableName: "cp2_receipt_ocr_jobs" },
  { key: "invoices", tableName: "cp2_invoices" },
  { key: "payments", tableName: "cp2_payments" },
  { key: "logistics", tableName: "cp2_logistics" },
  { key: "contacts", tableName: "cp2_contacts" },
  { key: "supplierContactRelationships", tableName: "cp2_supplier_contact_relationships" },
  { key: "purchasePriceHistory", tableName: "cp2_purchase_price_history" },
  { key: "purchaseRecords", tableName: "cp2_purchase_records" },
  { key: "saleRecords", tableName: "cp2_sale_records" },
  { key: "locations", tableName: "cp2_locations" },
  { key: "deliveryRoutes", tableName: "cp2_delivery_routes" },
  { key: "deliveryRouteStops", tableName: "cp2_delivery_route_stops" },
  { key: "dataExports", tableName: "cp2_data_exports" },
  { key: "accountDeletionRequests", tableName: "cp2_account_deletion_requests" },
  { key: "accountDeletionProofs", tableName: "cp2_account_deletion_proofs" },
  { key: "shopPresences", tableName: "cp2_shop_presences" },
  { key: "networkInvites", tableName: "cp2_network_invites" },
  { key: "staffInvitations", tableName: "cp2_staff_invitations" },
  { key: "publicCustomerCareRequests", tableName: "cp2_public_customer_care_requests" },
  { key: "publicStorefrontMessages", tableName: "cp2_public_storefront_messages" },
  { key: "publicOrders", tableName: "cp2_public_orders" },
  { key: "verificationTiers", tableName: "cp2_verification_tiers" },
  { key: "taxConfigs", tableName: "cp2_tax_configs" },
  { key: "deviceTrust", tableName: "cp2_device_trust" },
  { key: "betaAccess", tableName: "cp2_beta_access" },
  { key: "betaFeatureFlags", tableName: "cp2_beta_feature_flags" },
  { key: "betaDeviceTests", tableName: "cp2_beta_device_tests" },
  { key: "betaSupportTickets", tableName: "cp2_beta_support_tickets" },
  { key: "betaTelemetryEvents", tableName: "cp2_beta_telemetry_events" },
  { key: "launchSettings", tableName: "cp2_launch_settings" },
  { key: "launchChecklist", tableName: "cp2_launch_checklist" },
  { key: "launchIncidents", tableName: "cp2_launch_incidents" },
  { key: "documentImports", tableName: "cp2_document_imports" },
  { key: "documentImportSources", tableName: "cp2_document_import_sources" },
  { key: "notifications", tableName: "cp2_notifications" },
  { key: "runtimeSessions", tableName: "cp2_runtime_sessions" },
  { key: "runtimeTurns", tableName: "cp2_runtime_turns" },
  { key: "inventoryMovements", tableName: "cp2_inventory_movements" },
  { key: "syncQueue", tableName: "cp2_sync_queue_items" },
  { key: "offlineReceipts", tableName: "cp2_offline_receipts" },
  { key: "offlineChanges", tableName: "cp2_offline_changes" },
  { key: "offlineMetadata", tableName: "cp2_offline_metadata" },
  { key: "otpChallenges", tableName: "cp2_otp_challenges" },
  { key: "smsDeliveryAttempts", tableName: "cp2_sms_delivery_attempts" },
  { key: "sessions", tableName: "cp2_sessions" },
  { key: "passkeys", tableName: "cp2_passkeys" },
  { key: "passkeyCeremonies", tableName: "cp2_passkey_ceremonies" },
  { key: "accountIdentities", tableName: "cp2_account_identities" },
  { key: "passwordCredentials", tableName: "cp2_password_credentials" },
  { key: "authTransactions", tableName: "cp2_auth_transactions" },
  { key: "mfaFactors", tableName: "cp2_mfa_factors" },
  { key: "recoveryCodes", tableName: "cp2_recovery_codes" },
  { key: "userIdentities", tableName: "cp2_user_identities" },
  { key: "oauthSessions", tableName: "cp2_oauth_sessions" },
  { key: "accountPinHashes", tableName: "cp2_account_pin_hashes" },
  { key: "networkNodes", tableName: "cp2_network_nodes" },
  { key: "networkEdges", tableName: "cp2_network_edges" },
  { key: "networkSources", tableName: "cp2_network_sources" },
  { key: "networkPermissions", tableName: "cp2_network_permissions" },
  { key: "networkRoutes", tableName: "cp2_network_routes" },
  { key: "contactHashes", tableName: "cp2_contact_hashes" },
  { key: "externalIdentities", tableName: "cp2_external_identities" },
  { key: "sokoIdentityLinks", tableName: "cp2_soko_identity_links" },
  { key: "identityCandidates", tableName: "cp2_identity_candidates" },
  { key: "networkConnections", tableName: "cp2_network_connections" },
  { key: "discoveryBudgets", tableName: "cp2_discovery_budgets" },
  { key: "auditEvents", tableName: "cp2_audit_events" }
];

// getRuntimeCapabilities/getRuntimeTransfer are deliberately absent: they can expire a stale
// transfer as an in-memory side effect, but that recompute is idempotent (re-derived from
// `now` on every call) and self-heals on the next real mutation's snapshot, so forcing a full
// persistence round trip - and blocking the response on it via app.ts's runtime GET flush wait -
// on every capability/status poll is not worth it.
const mutatingMethodNames = new Set([
  "heartbeatRuntimeHost",
  "beginRuntimeTransfer",
  "completeRuntimeTransfer",
  "failRuntimeTransfer",
  "resolveRuntimeHandoff",
  "createRuntimeCheckpoint",
  "performRuntimeSwap",
  "rollbackRuntimeHandoff",
  "resumeRuntimeHandoff",
  "syncOfflineRuntimeCheckpoints",
  "mergeRuntimeHandoffs",
  "resolveRuntimeHandoffForMcp",
  "createRuntimeCheckpointForMcp",
  "performRuntimeSwapForMcp",
  "resumeRuntimeHandoffForMcp",
  "rollbackRuntimeHandoffForMcp",
  "syncOfflineRuntimeCheckpointsForMcp",
  "mergeRuntimeHandoffsForMcp",
  "adjustProductStock",
  "approveAgentRoute",
  "authenticateSocialProfile",
  "beginOAuthSession",
  "beginEmailIdentityUpgrade",
  "beginEmailIdentityMerge",
  "completeOAuthCallback",
  "completePasskeyAuthentication",
  "completePasskeyRegistration",
  "beginPhoneSignup",
  "completePhoneSignup",
  "continueWithDevice",
  "recoverWithDeviceCredential",
  "continueWithChannelPin",
  "loginWithPassword",
  "mergeCurrentDeviceAccountWithPin",
  "verifyEmailIdentityMerge",
  "setupTotp",
  "confirmTotp",
  "verifyMfa",
  "beginRecovery",
  "verifyEmailRecovery",
  "resetRecoveredPassword",
  "changePassword",
  "regenerateMfaRecoveryCodes",
  "disableMfaFactor",
  "renamePasskey",
  "verifyPendingEmail",
  "completeMarketplaceIntro",
  "confirmProductImport",
  "confirmReceiptOCRJob",
  "confirmSupplierImport",
  "createAgentRoute",
  "createBetaSupportTicket",
  "createBusiness",
  "createConversation",
  "createAgentConversationMessage",
  "createConversationMessage",
  "deleteConversation",
  "restoreConversationFromRecycleBin",
  "emptyRecycleBin",
  "purgeExpiredRecycleBinConversations",
  "createDataExport",
  "createInvoice",
  "createLaunchIncident",
  "createLogistics",
  "importContacts",
  "linkContactAccount",
  "attachSupplierContact",
  "detachSupplierContact",
  "changePurchasePrice",
  "createPurchase",
  "createSale",
  "createDeliveryRoute",
  "updateDeliveryRoute",
  "createMcpAccessToken",
  "createProduct",
  "saveProductFieldSchema",
  "createNetworkInvites",
  "inviteStaff",
  "revokeStaffInvitation",
  "changeStaffRole",
  "removeStaffMember",
  "leaveBusiness",
  "acceptStaffInvitation",
  "declineStaffInvitation",
  "createPublicCustomerCareRequest",
  "createPublicOrder",
  "createPublicStorefrontMessage",
  "createProductCatalogueImport",
  "createReceiptOCRJob",
  "createRuntimeSession",
  "createRuntimeTurn",
  "createSalesAgent",
  "createSalesAgentFromPhoneContact",
  "createSupplier",
  "createSupplierCsvImport",
  "createSupplierFromPhoneContact",
  "createCustomer",
  "createProviderConversation",
  "createChannelIdentityLinkGrant",
  "deleteSalesAgent",
  "deleteNetworkSource",
  "deleteProduct",
  "deleteSupplier",
  "deliverNetworkInvites",
  "deliverPendingMessageNotifications",
  "disconnectLoginAccount",
  "enqueueSyncMutation",
  "getSokoSessionContext",
  "linkSalesAgentContact",
  "linkSupplierContact",
  "linkCustomerAccount",
  "listCustomerChannelEndpoints",
  "loginWithAccountPin",
  "loginWithSokoIdPin",
  "logout",
  "logoutAll",
  "recoverAccountPin",
  "recoverPhoneAccountPinWithPasskey",
  "recordBetaDeviceTest",
  "recordBetaTelemetry",
  "recordPayment",
  "prepareDeviceSession",
  "refreshSessionCredential",
  "revokeDeviceSession",
  "rejectAgentRoute",
  "proposeIdentityCandidate",
  "confirmIdentityCandidate",
  "rejectIdentityCandidate",
  "unlinkIdentity",
  "addManualIdentity",
  "pushOfflineOperation",
  "replaySyncQueue",
  "replaySyncQueueItem",
  "requestAccountDeletion",
  "requestShopDeletion",
  "requestOtp",
  "revokePasskey",
  "revokeMcpAccessToken",
  "setAccountPin",
  "signupWithPhonePin",
  "syncPhoneContacts",
  "requestNetworkConnection",
  "respondToNetworkConnection",
  "removeNetworkConnection",
  "syncSocialNetwork",
  "syncShopSystemCatalogue",
  "setConversationTyping",
  "updateBetaAccess",
  "updateSokoSessionContext",
  "updateBetaFeatureFlag",
  "updateBetaSupportTicketStatus",
  "updateCustomer",
  "updateDeviceTrust",
  "updateLaunchChecklist",
  "updateLaunchIncidentStatus",
  "updateLaunchSettings",
  "updateLogisticsStatus",
  "updateBusinessTimezone",
  "applyFulfillmentLogisticsStatus",
  "updateNotificationStatus",
  "updateOwnerPhone",
  "updateProduct",
  "updateProductImportRow",
  "updateSalesAgent",
  "updateSupplier",
  "updateSupplierImportRow",
  "updateShopSystemOrder",
  "updateConversationMessage",
  "updateConversationSettings",
  "updateTaxConfig",
  "updateVerificationTier",
  "verifyAccountPin",
  "verifyExternallyApprovedOtp",
  "verifyOtp",
  "finalizeShopDeletion",
  "activateAiModel",
  "activateAgentModel",
  "activateGlobalDefaultModel",
  "removeAgentModelBinding",
  "authenticateMcpAccessToken",
  "updateAgentProfile",
  "upsertModelCatalogEntry",
  "removeModelCatalogEntry",
  "upsertAgentCatalogEntry",
  "removeAgentCatalogEntry",
  "rollbackAgentRuntimeVersion",
  "upsertAgentContextSource",
  "submitAgentOwnerCorrection",
  "disableAgentOwnerCorrection",
  "submitAgentFeedback",
  "confirmInvoice",
  "disconnectSocialAccount",
  "restoreShopDeletion",
  "restoreAccountDeletion",
  "getBetaReadiness",
  "getBusinessKnowledge",
  "getDeviceTrust",
  "getDirectNetwork",
  "getExtendedNetwork",
  "getLaunchReadiness",
  "getNetworkGraph",
  "getSecurityReview",
  "getTaxConfig",
  "getVerificationTier",
  "listBetaFeatureFlags",
  "listLaunchChecklist",
  "listNotifications",
  "setShopPresence",
  "syncConnectedSocialProvider",
  "updateInvoice",
  "purgeExpiredShopDeletions",
  "purgeExpiredAccountDeletions",
  "registerE2eeDevice",
  "registerNativeSmsDevice",
  "revokeNativeSmsDevice",
  "fetchNativeSmsCommands",
  "acknowledgeNativeSmsCommand",
  "reportNativeSmsCommandResult",
  "ingestNativeSmsMessage",
  "ingestChannelWebhook",
  "ingestProviderMessage",
  "sendChannelMessage",
  "revokeE2eeDevice",
  "registerPushSubscription",
  "registerInstalledAgentModel",
  "validateInstalledAgentModel",
  "removePushSubscription",
  "createModelTemplate",
  "createModelTemplateEvaluationSuite",
  "addModelTemplateEvaluationCase",
  "runModelTemplateEvaluation",
  "recordModelTemplateObservation",
  "reviewModelTemplateObservation",
  "submitModelTemplateCorrection",
  "approveModelTemplateCorrection",
  "createModelTemplateDatasetVersion",
  "startModelTemplateImprovementRun",
  "promoteModelTemplate",
  "rollbackModelTemplate"
]);

const targetedPasskeyCeremonyMethodNames = new Set([
  "beginPasskeyAuthentication",
  "beginPasskeyRegistration"
]);

export interface PostgresCp2StoreOptions extends Cp2StoreOptions {
  databaseUrl: string;
  /** When set, both pg pools this store owns report query latency and connection-pool gauges. */
  metrics?: Metrics;
}

export class AccountSyncPersistenceError extends Error {
  readonly code = "ACCOUNT_SYNC_INITIALIZATION_FAILED";
  readonly persistenceStage = "account_sync_journal";
  readonly criticalAuthPersistenceCommitted = true;

  constructor(
    readonly accountId: string,
    readonly attemptedCollection: string,
    readonly constraintName: string | null,
    options?: ErrorOptions
  ) {
    super("Account sync initialization could not be completed.", options);
    this.name = "AccountSyncPersistenceError";
  }
}

export type PostgresCp2Store = Cp2Store & {
  close: () => Promise<void>;
  flush: () => Promise<void>;
  health: () => Promise<PostgresStoreHealth>;
};

export interface PostgresStoreHealth {
  database: "postgres";
  status: "ok" | "degraded";
  latencyMs: number;
  latestMigration: string | null;
  persistenceError: string | null;
  persistenceQueue: {
    status: "ok" | "degraded";
    pendingCount: number;
    queuedCount: number;
    active: boolean;
    activeOperation: "snapshot" | "passkey_ceremony" | null;
    activeDurationMs: number | null;
    oldestPendingAgeMs: number | null;
    lastWaitDurationMs: number | null;
    lastRunDurationMs: number | null;
    lastCompletedAt: string | null;
    warningThresholdMs: number;
  };
  syncJournal: {
    status: "ok" | "degraded";
    error: string | null;
  };
  realtimeFanout: {
    status: "ok" | "degraded";
    error: string | null;
  };
  syncChangeCount: number;
  phase1Parity: Array<{
    collection: string;
    relationalCount: number;
    compatibilityCount: number;
    relationalChecksum: string;
    compatibilityChecksum: string;
    ok: boolean;
  }>;
  pool: {
    idleCount: number;
    totalCount: number;
    waitingCount: number;
  };
}

const requiredMigrationFilename = "051_single_identity_single_store.sql";
const requiredAttachmentBlobMigrationFilename = "059_conversation_attachment_blob_storage.sql";
const requiredAccountAiAssetsMigrationFilename = "066_account_ai_assets.sql";
const realtimeChannel = "soko_sync_changes";
const defaultPersistenceQueueWarningThresholdMs = 10_000;
const defaultPersistenceRetryInitialDelayMs = 2_000;
const defaultPersistenceRetryMaxDelayMs = 60_000;
// health()'s Phase 1 relational/compatibility parity check does a count(*) + md5(string_agg(...))
// full-table scan across 6 table pairs (12 scans total). Render polls /health/ready repeatedly
// (it's the service's healthCheckPath), so running that on every call competes with live traffic
// for the same cp2_primary pool and gets strictly worse as these tables grow - see
// docs/architecture/resource-isolation-audit.md §2. Refreshed on this interval in the background
// and cached instead; every health() / /health/ready call reads the cache, never re-runs the scans.
const defaultParityCheckIntervalMs = 60_000;

type PersistenceOperationName = "snapshot" | "passkey_ceremony";

interface PasskeyCeremonyMutation {
  removedIds: string[];
  upsert: PasskeyCeremonyRecord | null;
}

export async function createPostgresCp2Store(
  options: PostgresCp2StoreOptions
): Promise<PostgresCp2Store> {
  const pool = new Pool(buildPgPoolConfig(options.databaseUrl));
  options.metrics?.instrumentPgPool(pool, { poolName: "cp2_primary" });
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error.", error);
  });
  let store: Cp2Store;
  let savedSnapshot: Cp2Snapshot;
  let initialSyncPersistenceError: AccountSyncPersistenceError | null = null;

  try {
    await assertDatabaseMigrated(pool);
    store = createCp2Store({
      ...(options.runtimeModelProvider === undefined
        ? {}
        : { runtimeModelProvider: options.runtimeModelProvider }),
      ...(options.runtimeModelProviderResolver === undefined
        ? {}
        : { runtimeModelProviderResolver: options.runtimeModelProviderResolver }),
      ...(options.modelRuntimeAdapterResolver === undefined
        ? {}
        : { modelRuntimeAdapterResolver: options.modelRuntimeAdapterResolver }),
      ...(options.inferencePlatform === undefined
        ? {}
        : { inferencePlatform: options.inferencePlatform }),
      ...(options.agentRuntimeAdapterResolver === undefined
        ? {}
        : { agentRuntimeAdapterResolver: options.agentRuntimeAdapterResolver }),
      ...(options.templateExecutor === undefined
        ? {}
        : { templateExecutor: options.templateExecutor }),
      ...(options.templateJudgeEvaluator === undefined
        ? {}
        : { templateJudgeEvaluator: options.templateJudgeEvaluator }),
      ...(options.templateTelemetrySink === undefined
        ? {}
        : { templateTelemetrySink: options.templateTelemetrySink }),
      ...(options.pushNotificationSender === undefined
        ? {}
        : { pushNotificationSender: options.pushNotificationSender }),
      ...(options.messageEmailNotificationSender === undefined
        ? {}
        : { messageEmailNotificationSender: options.messageEmailNotificationSender }),
      ...(options.networkInviteSender === undefined
        ? {}
        : { networkInviteSender: options.networkInviteSender }),
      ...(options.networkLimits === undefined ? {} : { networkLimits: options.networkLimits }),
      ...(options.messageWebBaseUrl === undefined
        ? {}
        : { messageWebBaseUrl: options.messageWebBaseUrl }),
      ...(options.accountDeletionProcessors === undefined
        ? {}
        : { accountDeletionProcessors: options.accountDeletionProcessors }),
      conversationAttachmentBlobStore:
        options.conversationAttachmentBlobStore ?? createPostgresAttachmentBlobStore(pool),
      accountAiAssetStore: options.accountAiAssetStore ?? createPostgresAccountAiAssetStore(pool)
    });
    savedSnapshot = await loadNormalizedSnapshot(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  try {
    if (snapshotHasData(savedSnapshot)) {
      store.hydrateSnapshot(savedSnapshot);
      if (savedSnapshot.syncChanges.length === 0 && store.snapshot().syncChanges.length > 0) {
        const result = await saveNormalizedSnapshot(pool, store.snapshot(), savedSnapshot);
        initialSyncPersistenceError = result.syncJournalError;
      }
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const realtimePool = new Pool(buildPgPoolConfig(options.databaseUrl, { max: 1 }));
  options.metrics?.instrumentPgPool(realtimePool, { poolName: "cp2_realtime" });
  realtimePool.on("error", (error) => {
    console.error("Unexpected PostgreSQL realtime pool error.", error);
  });

  let lastPersistedSnapshot = structuredClone(store.snapshot());
  let saveQueue: Promise<void> = Promise.resolve();
  let lastPersistenceError: unknown = null;
  let nextPersistenceOperationId = 1;
  const pendingPersistenceOperations = new Map<
    number,
    { enqueuedAt: number; name: PersistenceOperationName }
  >();
  let activePersistenceOperation: {
    id: number;
    name: PersistenceOperationName;
    startedAt: number;
  } | null = null;
  let lastPersistenceWaitDurationMs: number | null = null;
  let lastPersistenceRunDurationMs: number | null = null;
  let lastPersistenceCompletedAt: string | null = null;
  const persistenceQueueWarningThresholdMs = positiveIntegerFromEnv(
    "DB_PERSISTENCE_QUEUE_WARN_MS",
    defaultPersistenceQueueWarningThresholdMs
  );
  const persistenceRetryInitialDelayMs = positiveIntegerFromEnv(
    "DB_PERSISTENCE_RETRY_INITIAL_MS",
    defaultPersistenceRetryInitialDelayMs
  );
  const persistenceRetryMaxDelayMs = positiveIntegerFromEnv(
    "DB_PERSISTENCE_RETRY_MAX_MS",
    defaultPersistenceRetryMaxDelayMs
  );
  const parityCheckIntervalMs = positiveIntegerFromEnv(
    "DB_HEALTH_PARITY_CHECK_INTERVAL_MS",
    defaultParityCheckIntervalMs
  );
  let cachedParity: PostgresStoreHealth["phase1Parity"] = [];
  let parityCheckInFlight: Promise<void> | null = null;
  let persistenceRetryDelayMs = persistenceRetryInitialDelayMs;
  let persistenceRetryTimer: NodeJS.Timeout | null = null;
  let parityCheckTimer: NodeJS.Timeout | null = null;
  let snapshotSaveQueued = false;
  let snapshotSaveRunning = false;
  let snapshotSaveRequestedWhileRunning = false;
  let closing = false;

  /**
   * A failed save no longer reverts in-memory state to the last successfully persisted snapshot.
   * The in-memory data is still perfectly valid after an ordinary transient failure (a dropped
   * connection, a pool timeout) - discarding it there was strictly worse than leaving it in place:
   * it silently undid every mutation across every tenant made since the last successful save, not
   * just whatever triggered the failure, even though the client of that request had already
   * received a 200 OK. Instead, the failure is recorded (surfaced via health()/lastPersistenceError,
   * already monitored - see docs/single-instance-store-ceiling.md) and a retry is scheduled with
   * exponential backoff, capped at persistenceRetryMaxDelayMs. Because enqueueSave always takes a
   * fresh store.snapshot() at run time, a retry naturally catches up everything accumulated since
   * the failure, not just the operation that failed. Every mutating call already triggers its own
   * enqueueSave via the Proxy below, so this timer only matters for the case where mutations stop
   * happening after a failure - it guarantees eventual catch-up even during a quiet period, rather
   * than requiring some other write to happen to notice Postgres is reachable again.
   */
  function scheduleSaveRetry(): void {
    if (closing || persistenceRetryTimer !== null) return;
    const delay = persistenceRetryDelayMs;
    persistenceRetryTimer = setTimeout(() => {
      persistenceRetryTimer = null;
      enqueueSave();
    }, delay);
    persistenceRetryTimer.unref();
    persistenceRetryDelayMs = Math.min(delay * 2, persistenceRetryMaxDelayMs);
  }

  let lastSyncPersistenceError: AccountSyncPersistenceError | null = initialSyncPersistenceError;
  if (lastSyncPersistenceError !== null) {
    logAccountSyncDegradation(lastSyncPersistenceError);
  }
  let lastRealtimeListenerError: unknown = null;
  let lastRealtimePublishError: unknown = null;
  const instanceId = randomUUID();
  const publishedCursorByAccount = latestSyncCursorByAccount(savedSnapshot);
  let realtimeClient: PoolClient | null = null;
  let realtimeReconnectTimer: NodeJS.Timeout | null = null;
  let realtimeClosed = false;

  function scheduleRealtimeReconnect(): void {
    if (realtimeClosed || realtimeReconnectTimer !== null) return;
    realtimeReconnectTimer = setTimeout(() => {
      realtimeReconnectTimer = null;
      void connectRealtimeListener();
    }, 1_000);
    realtimeReconnectTimer.unref();
  }

  async function connectRealtimeListener(): Promise<void> {
    if (realtimeClosed || realtimeClient !== null) return;
    let client: PoolClient | null = null;
    try {
      client = await realtimePool.connect();
      const connectedClient = client;
      await connectedClient.query(`listen ${realtimeChannel}`);
      if (realtimeClosed) {
        connectedClient.release();
        return;
      }
      realtimeClient = connectedClient;
      lastRealtimeListenerError = null;
      connectedClient.on("notification", (notification) => {
        if (notification.channel !== realtimeChannel || notification.payload === undefined) return;
        try {
          const parsed = parseRealtimeNotification(notification.payload);
          if (parsed.sourceInstanceId === instanceId) return;
          store.publishExternalSyncChange(parsed.event);
          lastRealtimeListenerError = null;
        } catch (error) {
          lastRealtimeListenerError = error;
        }
      });
      connectedClient.once("error", (error) => {
        lastRealtimeListenerError = error;
        if (realtimeClient === connectedClient) realtimeClient = null;
        connectedClient.release(true);
        scheduleRealtimeReconnect();
      });
    } catch (error) {
      lastRealtimeListenerError = error;
      client?.release(true);
      scheduleRealtimeReconnect();
    }
  }

  await connectRealtimeListener();

  function enqueuePersistenceOperation(
    name: PersistenceOperationName,
    operation: () => Promise<void>
  ): void {
    const operationId = nextPersistenceOperationId;
    nextPersistenceOperationId += 1;
    const enqueuedAt = Date.now();
    pendingPersistenceOperations.set(operationId, { enqueuedAt, name });

    saveQueue = saveQueue
      .then(async () => {
        const startedAt = Date.now();
        activePersistenceOperation = { id: operationId, name, startedAt };
        lastPersistenceWaitDurationMs = startedAt - enqueuedAt;
        try {
          await operation();
        } finally {
          const completedAt = Date.now();
          lastPersistenceRunDurationMs = completedAt - startedAt;
          lastPersistenceCompletedAt = new Date(completedAt).toISOString();
          activePersistenceOperation = null;
          pendingPersistenceOperations.delete(operationId);
        }
      })
      .then(
        () => {
          lastPersistenceError = null;
          persistenceRetryDelayMs = persistenceRetryInitialDelayMs;
        },
        (error: unknown) => {
          lastPersistenceError = error;
          console.error(
            JSON.stringify({
              event: "cp2_persistence_failed",
              code:
                error instanceof AccountSyncPersistenceError
                  ? error.code
                  : "CP2_PERSISTENCE_FAILED",
              accountId:
                error instanceof AccountSyncPersistenceError ? error.accountId : "unavailable",
              attemptedCollection:
                error instanceof AccountSyncPersistenceError
                  ? error.attemptedCollection
                  : "unavailable",
              constraintName:
                error instanceof AccountSyncPersistenceError ? error.constraintName : null
            })
          );
          scheduleSaveRetry();
        }
      );
  }

  function enqueueSave(): void {
    // A queued snapshot is taken when its operation starts, so it already includes every mutation
    // that arrives while it waits behind another persistence operation. Adding another snapshot
    // for each of those mutations only creates identical full-store writes. If the snapshot is
    // already running, its in-memory copy has been captured; remember that one trailing save is
    // needed instead. This bounds a mutation burst to the active save plus one follow-up without
    // dropping anything that changed after the active snapshot was captured.
    if (snapshotSaveQueued) return;
    if (snapshotSaveRunning) {
      snapshotSaveRequestedWhileRunning = true;
      return;
    }

    snapshotSaveQueued = true;
    enqueuePersistenceOperation("snapshot", async () => {
      try {
        snapshotSaveQueued = false;
        snapshotSaveRunning = true;
        const snapshot = store.snapshot();
        const result = await saveNormalizedSnapshot(pool, snapshot, lastPersistedSnapshot);
        lastPersistedSnapshot = structuredClone(snapshot);
        lastSyncPersistenceError = result.syncJournalError;
        if (result.syncJournalError !== null) {
          logAccountSyncDegradation(result.syncJournalError);
          return;
        }
        try {
          await publishRealtimeNotifications(pool, snapshot, instanceId, publishedCursorByAccount);
          lastRealtimePublishError = null;
        } catch (error) {
          lastRealtimePublishError = error;
          console.error("Failed to publish PostgreSQL realtime hints.", error);
        }
      } finally {
        snapshotSaveRunning = false;
        if (snapshotSaveRequestedWhileRunning) {
          snapshotSaveRequestedWhileRunning = false;
          enqueueSave();
        }
      }
    });
  }

  function enqueuePasskeyCeremonyMutation(mutation: PasskeyCeremonyMutation): void {
    if (mutation.upsert === null && mutation.removedIds.length === 0) return;

    enqueuePersistenceOperation("passkey_ceremony", async () => {
      await savePasskeyCeremonyMutation(pool, mutation);
      applyPersistedPasskeyCeremonyMutation(lastPersistedSnapshot, mutation);
    });
  }

  async function flush(): Promise<void> {
    // A mutation that lands after an active snapshot captured its state requests a trailing save.
    // That save is appended from the active operation's finally block, so keep following the queue
    // until no operation was appended while we waited.
    while (true) {
      const observedQueue = saveQueue;
      await observedQueue;
      if (observedQueue === saveQueue && !snapshotSaveRequestedWhileRunning) break;
    }
    if (lastPersistenceError !== null) {
      throw lastPersistenceError;
    }
  }

  async function close(): Promise<void> {
    closing = true;
    if (persistenceRetryTimer !== null) {
      clearTimeout(persistenceRetryTimer);
      persistenceRetryTimer = null;
    }
    if (parityCheckTimer !== null) {
      clearInterval(parityCheckTimer);
      parityCheckTimer = null;
    }
    try {
      await flush();
    } finally {
      realtimeClosed = true;
      if (realtimeReconnectTimer !== null) {
        clearTimeout(realtimeReconnectTimer);
        realtimeReconnectTimer = null;
      }
      const client = realtimeClient;
      realtimeClient = null;
      try {
        if (client !== null) await client.query(`unlisten ${realtimeChannel}`);
      } finally {
        client?.release();
        await Promise.all([pool.end(), realtimePool.end()]);
      }
    }
  }

  /**
   * The expensive half of what used to be health()'s single query - 6 table pairs, each a
   * count(*) plus a md5(string_agg(...)) full-table scan. Runs on `parityCheckIntervalMs`
   * (default 60s), never inline with a caller's health() / /health/ready request. A failure here
   * leaves `cachedParity` at its last-known-good value rather than throwing - a transient parity
   * refresh failure must not flip readiness, the same principle already applied to persistence
   * save failures above.
   */
  async function refreshParityCache(): Promise<void> {
    if (parityCheckInFlight !== null) return parityCheckInFlight;
    parityCheckInFlight = (async () => {
      try {
        const result = await pool.query<{
          otp_relational_count: string;
          otp_compatibility_count: string;
          otp_relational_checksum: string;
          otp_compatibility_checksum: string;
          sessions_relational_count: string;
          sessions_compatibility_count: string;
          sessions_relational_checksum: string;
          sessions_compatibility_checksum: string;
          user_identities_relational_count: string;
          user_identities_compatibility_count: string;
          user_identities_relational_checksum: string;
          user_identities_compatibility_checksum: string;
          oauth_sessions_relational_count: string;
          oauth_sessions_compatibility_count: string;
          oauth_sessions_relational_checksum: string;
          oauth_sessions_compatibility_checksum: string;
          account_pin_hashes_relational_count: string;
          account_pin_hashes_compatibility_count: string;
          account_pin_hashes_relational_checksum: string;
          account_pin_hashes_compatibility_checksum: string;
          device_trust_relational_count: string;
          device_trust_compatibility_count: string;
          device_trust_relational_checksum: string;
          device_trust_compatibility_checksum: string;
        }>(
          `
            select
              (select count(*) from otp_challenges)::text as otp_relational_count,
              (select count(*) from cp2_otp_challenges)::text as otp_compatibility_count,
              (select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) from otp_challenges) as otp_relational_checksum,
              (select md5(coalesce(string_agg(entity_id, ',' order by entity_id), '')) from cp2_otp_challenges) as otp_compatibility_checksum,
              (select count(*) from sessions)::text as sessions_relational_count,
              (select count(*) from cp2_sessions)::text as sessions_compatibility_count,
              (select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) from sessions) as sessions_relational_checksum,
              (select md5(coalesce(string_agg(entity_id, ',' order by entity_id), '')) from cp2_sessions) as sessions_compatibility_checksum,
              (select count(*) from user_identities)::text as user_identities_relational_count,
              (select count(*) from cp2_user_identities)::text as user_identities_compatibility_count,
              (select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) from user_identities) as user_identities_relational_checksum,
              (select md5(coalesce(string_agg(entity_id, ',' order by entity_id), '')) from cp2_user_identities) as user_identities_compatibility_checksum,
              (select count(*) from oauth_sessions)::text as oauth_sessions_relational_count,
              (select count(*) from cp2_oauth_sessions)::text as oauth_sessions_compatibility_count,
              (select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) from oauth_sessions) as oauth_sessions_relational_checksum,
              (select md5(coalesce(string_agg(entity_id, ',' order by entity_id), '')) from cp2_oauth_sessions) as oauth_sessions_compatibility_checksum,
              (select count(*) from account_pin_hashes)::text as account_pin_hashes_relational_count,
              (select count(*) from cp2_account_pin_hashes)::text as account_pin_hashes_compatibility_count,
              (select md5(coalesce(string_agg(account_id::text, ',' order by account_id::text), '')) from account_pin_hashes) as account_pin_hashes_relational_checksum,
              (select md5(coalesce(string_agg(entity_id, ',' order by entity_id), '')) from cp2_account_pin_hashes) as account_pin_hashes_compatibility_checksum,
              (select count(*) from device_trust)::text as device_trust_relational_count,
              (select count(*) from cp2_device_trust)::text as device_trust_compatibility_count,
              (
                select md5(coalesce(string_agg(
                  business_id::text || ':' || user_id::text || ':' || device_id,
                  ','
                  order by business_id::text, user_id::text, device_id
                ), ''))
                from device_trust
              ) as device_trust_relational_checksum,
              (select md5(coalesce(string_agg(entity_id, ',' order by entity_id), '')) from cp2_device_trust) as device_trust_compatibility_checksum
          `
        );
        const row = result.rows[0];
        if (row === undefined) return;
        cachedParity = [
          phase1Parity(
            "otp_challenges",
            row.otp_relational_count,
            row.otp_compatibility_count,
            row.otp_relational_checksum,
            row.otp_compatibility_checksum
          ),
          phase1Parity(
            "sessions",
            row.sessions_relational_count,
            row.sessions_compatibility_count,
            row.sessions_relational_checksum,
            row.sessions_compatibility_checksum
          ),
          phase1Parity(
            "user_identities",
            row.user_identities_relational_count,
            row.user_identities_compatibility_count,
            row.user_identities_relational_checksum,
            row.user_identities_compatibility_checksum
          ),
          phase1Parity(
            "oauth_sessions",
            row.oauth_sessions_relational_count,
            row.oauth_sessions_compatibility_count,
            row.oauth_sessions_relational_checksum,
            row.oauth_sessions_compatibility_checksum
          ),
          phase1Parity(
            "account_pin_hashes",
            row.account_pin_hashes_relational_count,
            row.account_pin_hashes_compatibility_count,
            row.account_pin_hashes_relational_checksum,
            row.account_pin_hashes_compatibility_checksum
          ),
          phase1Parity(
            "device_trust",
            row.device_trust_relational_count,
            row.device_trust_compatibility_count,
            row.device_trust_relational_checksum,
            row.device_trust_compatibility_checksum
          )
        ];
      } catch (error) {
        console.error(
          "Phase 1 parity check refresh failed; keeping last-known-good result.",
          error
        );
      }
    })().finally(() => {
      parityCheckInFlight = null;
    });
    return parityCheckInFlight;
  }

  async function health(): Promise<PostgresStoreHealth> {
    const startedAt = Date.now();
    const lastRealtimeError = lastRealtimeListenerError ?? lastRealtimePublishError;
    const result = await pool.query<{
      latest_migration: string | null;
      sync_change_count: string;
    }>(
      `
        select
          (
            select filename
            from soko_schema_migrations
            order by filename desc
            limit 1
          ) as latest_migration,
          (select count(*) from account_sync_changes)::text as sync_change_count
      `
    );
    const row = result.rows[0];
    const healthCheckedAt = Date.now();
    const oldestPendingAt = [...pendingPersistenceOperations.values()].reduce<number | null>(
      (oldest, operation) =>
        oldest === null || operation.enqueuedAt < oldest ? operation.enqueuedAt : oldest,
      null
    );
    const oldestPendingAgeMs =
      oldestPendingAt === null ? null : Math.max(0, healthCheckedAt - oldestPendingAt);
    const activeDurationMs =
      activePersistenceOperation === null
        ? null
        : Math.max(0, healthCheckedAt - activePersistenceOperation.startedAt);
    const persistenceQueueDegraded =
      (oldestPendingAgeMs ?? 0) >= persistenceQueueWarningThresholdMs;

    return {
      database: "postgres",
      status:
        lastPersistenceError === null &&
        lastSyncPersistenceError === null &&
        lastRealtimeError === null &&
        !persistenceQueueDegraded
          ? "ok"
          : "degraded",
      latencyMs: healthCheckedAt - startedAt,
      latestMigration: row?.latest_migration ?? null,
      persistenceError:
        lastPersistenceError instanceof Error
          ? lastPersistenceError.message
          : lastPersistenceError === null
            ? null
            : "PostgreSQL persistence failed.",
      persistenceQueue: {
        status: persistenceQueueDegraded ? "degraded" : "ok",
        pendingCount: pendingPersistenceOperations.size,
        queuedCount:
          pendingPersistenceOperations.size - (activePersistenceOperation === null ? 0 : 1),
        active: activePersistenceOperation !== null,
        activeOperation: activePersistenceOperation?.name ?? null,
        activeDurationMs,
        oldestPendingAgeMs,
        lastWaitDurationMs: lastPersistenceWaitDurationMs,
        lastRunDurationMs: lastPersistenceRunDurationMs,
        lastCompletedAt: lastPersistenceCompletedAt,
        warningThresholdMs: persistenceQueueWarningThresholdMs
      },
      syncJournal:
        lastSyncPersistenceError === null
          ? { status: "ok", error: null }
          : {
              status: "degraded",
              error: "Account sync journal persistence is temporarily unavailable."
            },
      realtimeFanout:
        lastRealtimeError === null
          ? { status: "ok", error: null }
          : {
              status: "degraded",
              error:
                lastRealtimeError instanceof Error
                  ? lastRealtimeError.message
                  : "PostgreSQL realtime fan-out failed."
            },
      syncChangeCount: Number(row?.sync_change_count ?? 0),
      // Sourced from the background-refreshed cache (see refreshParityCache above), never
      // computed inline - this call never runs the 12-table-scan parity query itself.
      phase1Parity: cachedParity,
      pool: {
        idleCount: pool.idleCount,
        totalCount: pool.totalCount,
        waitingCount: pool.waitingCount
      }
    };
  }

  // Deliberately not awaited: this is the same expensive parity query this cache exists to keep
  // off every caller's hot path (see the constant's doc comment above and
  // docs/architecture/resource-isolation-audit.md §2) - blocking store *creation* on it would
  // just move the cost from "every /health/ready poll" to "every process boot / every test that
  // creates a store," which is exactly as bad. `cachedParity` starts empty and is filled in by
  // this first background run, same as any other cache with a cold-start gap.
  void refreshParityCache();
  parityCheckTimer = setInterval(() => void refreshParityCache(), parityCheckIntervalMs);
  parityCheckTimer.unref();

  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "close") {
        return close;
      }

      if (property === "flush") {
        return flush;
      }

      if (property === "health") {
        return health;
      }

      const value = Reflect.get(target, property, receiver);

      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => {
        const previousPasskeyCeremonyIds = targetedPasskeyCeremonyMethodNames.has(property)
          ? new Set((store.snapshot().passkeyCeremonies ?? []).map((ceremony) => ceremony.id))
          : null;
        let result: unknown;
        try {
          result = value.apply(target, args);
        } catch (error) {
          if (mutatingMethodNames.has(property)) enqueueSave();
          throw error;
        }

        if (previousPasskeyCeremonyIds !== null) {
          if (!isPromiseLike(result)) {
            throw new Error(`${property} must return a promise.`);
          }

          return result.then(
            (resolved: unknown) => {
              enqueuePasskeyCeremonyMutation(
                passkeyCeremonyMutation(store.snapshot(), previousPasskeyCeremonyIds, resolved)
              );
              return resolved;
            },
            (error: unknown) => {
              enqueuePasskeyCeremonyMutation(
                passkeyCeremonyMutation(store.snapshot(), previousPasskeyCeremonyIds, null)
              );
              throw error;
            }
          );
        }

        if (!mutatingMethodNames.has(property)) {
          return result;
        }

        if (isPromiseLike(result)) {
          return result.then(
            (resolved: unknown) => {
              enqueueSave();
              return resolved;
            },
            (error: unknown) => {
              enqueueSave();
              throw error;
            }
          );
        }

        enqueueSave();
        return result;
      };
    }
  }) as PostgresCp2Store;
}

function latestSyncCursorByAccount(snapshot: Cp2Snapshot): Map<string, string> {
  const cursors = new Map<string, { cursor: string; sequence: number }>();
  for (const change of snapshot.syncChanges) {
    const current = cursors.get(change.accountId);
    if (current === undefined || change.sequence > current.sequence) {
      cursors.set(change.accountId, {
        cursor: change.cursor,
        sequence: change.sequence
      });
    }
  }
  return new Map([...cursors].map(([accountId, value]) => [accountId, value.cursor]));
}

async function publishRealtimeNotifications(
  pool: Pool,
  snapshot: Cp2Snapshot,
  sourceInstanceId: string,
  publishedCursorByAccount: Map<string, string>
): Promise<void> {
  const latestByAccount = new Map<string, Cp2Snapshot["syncChanges"][number]>();
  for (const change of snapshot.syncChanges) {
    const current = latestByAccount.get(change.accountId);
    if (current === undefined || change.sequence > current.sequence) {
      latestByAccount.set(change.accountId, change);
    }
  }

  for (const change of latestByAccount.values()) {
    if (publishedCursorByAccount.get(change.accountId) === change.cursor) continue;
    const event: SyncRealtimeChangesAvailableEvent = {
      type: "sync.changes_available",
      protocolVersion: 1,
      accountId: change.accountId,
      cursor: change.cursor,
      sequence: change.sequence,
      collection: change.collection,
      emittedAt: change.changedAt
    };
    await pool.query("select pg_notify($1, $2)", [
      realtimeChannel,
      JSON.stringify({ sourceInstanceId, event })
    ]);
    publishedCursorByAccount.set(change.accountId, change.cursor);
  }
}

function parseRealtimeNotification(payload: string): {
  sourceInstanceId: string;
  event: SyncRealtimeChangesAvailableEvent;
} {
  const parsed = JSON.parse(payload) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("PostgreSQL realtime notification is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const event = record.event;
  if (typeof record.sourceInstanceId !== "string" || typeof event !== "object" || event === null) {
    throw new Error("PostgreSQL realtime notification is malformed.");
  }
  const value = event as Record<string, unknown>;
  if (
    value.type !== "sync.changes_available" ||
    value.protocolVersion !== 1 ||
    typeof value.accountId !== "string" ||
    typeof value.cursor !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.collection !== "string" ||
    typeof value.emittedAt !== "string"
  ) {
    throw new Error("PostgreSQL realtime notification is malformed.");
  }
  return {
    sourceInstanceId: record.sourceInstanceId,
    event: event as SyncRealtimeChangesAvailableEvent
  };
}

function requireAccountSyncCollection(accountId: string, value: unknown): AccountSyncCollection {
  if (isAccountSyncCollection(value)) {
    return value;
  }

  throw new AccountSyncPersistenceError(
    accountId,
    typeof value === "string" ? value : typeof value,
    null
  );
}

function normalizeAccountSyncPersistenceError(
  error: unknown,
  snapshot: Cp2Snapshot
): AccountSyncPersistenceError {
  if (error instanceof AccountSyncPersistenceError) {
    return error;
  }

  const attemptedChange = snapshot.syncChanges.at(-1);
  return new AccountSyncPersistenceError(
    attemptedChange?.accountId ?? "unavailable",
    attemptedChange?.collection ?? "unavailable",
    readConstraintName(error),
    { cause: error }
  );
}

function logAccountSyncDegradation(error: AccountSyncPersistenceError): void {
  console.error(
    JSON.stringify({
      event: "account_sync_changes_insert_failed",
      code: error.code,
      accountId: error.accountId,
      attemptedCollection: error.attemptedCollection,
      constraintName: error.constraintName,
      criticalPersistenceCommitted: true,
      authenticationBlocked: false
    })
  );
}

function readConstraintName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("constraint" in error)) {
    return null;
  }

  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === "string" ? constraint : null;
}

async function assertDatabaseMigrated(pool: Pool): Promise<void> {
  const tableResult = await pool.query<{ exists: boolean }>(
    `
      select exists(
        select 1
        from information_schema.tables
        where table_schema = 'public' and table_name = 'soko_schema_migrations'
      ) as exists
    `
  );

  if (tableResult.rows[0]?.exists !== true) {
    throw new Error(
      `Database migrations are not initialized. Run "pnpm db:migrate" before starting the API. Missing ${requiredMigrationFilename}.`
    );
  }

  const result = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from soko_schema_migrations where filename = $1) as applied",
    [requiredMigrationFilename]
  );

  if (result.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredMigrationFilename}.`
    );
  }

  const attachmentBlobMigration = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from soko_schema_migrations where filename = $1) as applied",
    [requiredAttachmentBlobMigrationFilename]
  );
  if (attachmentBlobMigration.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredAttachmentBlobMigrationFilename}.`
    );
  }

  const accountAiAssetsMigration = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from soko_schema_migrations where filename = $1) as applied",
    [requiredAccountAiAssetsMigrationFilename]
  );
  if (accountAiAssetsMigration.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredAccountAiAssetsMigrationFilename}.`
    );
  }

  const constraint = await pool.query<{ definition: string }>(
    `
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'account_sync_changes'::regclass
        and conname = 'account_sync_changes_collection_check'
    `
  );
  const definition = constraint.rows[0]?.definition;
  const allowedCollections = new Set(
    definition === undefined
      ? []
      : [...definition.matchAll(/'([^']+)'(?:::text)?/g)].map((match) => match[1])
  );
  if (
    definition === undefined ||
    ACCOUNT_SYNC_COLLECTIONS.some((collection) => !allowedCollections.has(collection)) ||
    [...allowedCollections].some(
      (collection) => !ACCOUNT_SYNC_COLLECTIONS.includes(collection as AccountSyncCollection)
    )
  ) {
    throw new Error(
      'Database account_sync_changes collection constraint is stale. Run "pnpm db:migrate" before starting the API.'
    );
  }
}

async function loadNormalizedSnapshot(pool: Pool): Promise<Cp2Snapshot> {
  const snapshot = emptySnapshot();

  for (const collection of normalizedCollections) {
    const result = await pool.query<{ record: SnapshotRecord }>(
      `select record from ${collection.tableName} order by entity_id`
    );
    setSnapshotCollection(
      snapshot,
      collection.key,
      result.rows.map((row) => row.record)
    );
  }

  await loadRelationalCoreSnapshot(pool, snapshot);

  return snapshot;
}

async function loadRelationalCoreSnapshot(pool: Pool, snapshot: Cp2Snapshot): Promise<void> {
  const accountsResult = await timedQuery<{
    id: string;
    primary_auth_channel: string;
    primary_auth_destination: string;
    identity_level: "device" | "verified_contact" | "strong";
    status: "active" | "locked" | "suspended" | "pending_deletion" | "deleted";
    deleted_at: Date | null;
    created_at: Date;
  }>(
    pool,
    "load accounts",
    "select id, primary_auth_channel, primary_auth_destination, identity_level, status, deleted_at, created_at from accounts order by id"
  );
  snapshot.accounts = accountsResult.rows.map((row) => ({
    id: row.id,
    primaryAuthChannel: row.primary_auth_channel,
    primaryAuthDestination: row.primary_auth_destination,
    identityLevel: row.identity_level,
    status: row.status,
    deletedAt: row.deleted_at === null ? null : timestampToIso(row.deleted_at),
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["accounts"];

  const usersResult = await timedQuery<{
    id: string;
    account_id: string;
    display_name: string;
    language: string;
    phone_number_e164: string | null;
    phone_country_code: string | null;
    phone_national_number: string | null;
    phone_verification_status: "unverified" | "verified" | null;
    phone_added_at: Date | null;
    phone_updated_at: Date | null;
    phone_source: "phone_login" | "shop_registration" | null;
    public_phone_enabled: boolean;
    created_at: Date;
  }>(
    pool,
    "load users",
    `
      select
        id,
        account_id,
        display_name,
        language,
        phone_number_e164,
        phone_country_code,
        phone_national_number,
        phone_verification_status,
        phone_added_at,
        phone_updated_at,
        phone_source,
        public_phone_enabled,
        created_at
      from users
      order by id
    `
  );
  snapshot.users = usersResult.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    language: row.language,
    phoneNumberE164: row.phone_number_e164,
    phoneCountryCode: row.phone_country_code,
    phoneNationalNumber: row.phone_national_number,
    phoneVerificationStatus: row.phone_verification_status,
    phoneAddedAt: row.phone_added_at === null ? null : timestampToIso(row.phone_added_at),
    phoneUpdatedAt: row.phone_updated_at === null ? null : timestampToIso(row.phone_updated_at),
    phoneSource: row.phone_source,
    publicPhoneEnabled: row.public_phone_enabled,
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["users"];

  const businessesResult = await timedQuery<{
    id: string;
    name: string;
    language: string;
    soko_id: string | null;
    timezone: string | null;
    created_at: Date;
  }>(
    pool,
    "load businesses",
    "select id, name, language, soko_id, timezone, created_at from businesses order by id"
  );
  snapshot.businesses = businessesResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language,
    sokoId: row.soko_id,
    timezone: row.timezone,
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["businesses"];

  const membershipsResult = await timedQuery<{
    id: string;
    business_id: string;
    user_id: string;
    role: string;
    created_at: Date;
  }>(
    pool,
    "load memberships",
    "select id, business_id, user_id, role, created_at from business_memberships order by id"
  );
  snapshot.memberships = membershipsResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    role: row.role,
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["memberships"];

  const productsResult = await timedQuery<{
    id: string;
    business_id: string;
    name: string;
    sku: string | null;
    aliases: string[];
    unit: string;
    quantity: string;
    buying_price: string | null;
    selling_price: string | null;
    unit_weight_grams: string | null;
    primary_media_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load products",
    `
      select id, business_id, name, sku, aliases, unit, quantity, buying_price, selling_price,
             unit_weight_grams, primary_media_id, created_at, updated_at
      from products
      order by business_id, name, id
    `
  );
  // The relational row is authoritative for every column it has, but it does not carry every
  // ProductSummary field (for example business-defined `fieldValues`). Start from the
  // compatibility record loaded above so those fields survive a restart instead of being dropped.
  const compatibilityProductsById = new Map(
    snapshotRecords(snapshot.products).map((record) => [String(record.id), record])
  );
  snapshot.products = productsResult.rows.map((row) => ({
    ...compatibilityProductsById.get(row.id),
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    sku: row.sku,
    aliases: row.aliases,
    unit: row.unit,
    quantity: numberFromDatabase(row.quantity),
    buyingPrice: nullableNumberFromDatabase(row.buying_price),
    sellingPrice: nullableNumberFromDatabase(row.selling_price),
    // pg returns BIGINT as a decimal string, which is exactly the A22 record format.
    unitWeightGrams: row.unit_weight_grams,
    primaryMediaId: row.primary_media_id,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at)
  })) as Cp2Snapshot["products"];

  const customersResult = await timedQuery<{
    id: string;
    business_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    linked_account_id: string | null;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load customers",
    `
      select id, business_id, name, phone, email, linked_account_id, notes, created_at, updated_at
      from customers
      order by business_id, name, id
    `
  );
  snapshot.customers = customersResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    linkedAccountId: row.linked_account_id,
    notes: row.notes,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at)
  })) as Cp2Snapshot["customers"];

  const suppliersResult = await timedQuery<{
    id: string;
    business_id: string;
    name: string;
    phone: string | null;
    linked_phonebook_contact_id: string | null;
    linked_phonebook_contact_name: string | null;
    email: string | null;
    notes: string | null;
    sales_agent_count: number;
    purchase_receipt_count: number;
    last_purchase_date: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load suppliers",
    `
      select id, business_id, name, phone, linked_phonebook_contact_id, linked_phonebook_contact_name,
             email, notes, sales_agent_count, purchase_receipt_count, last_purchase_date, created_at, updated_at
      from suppliers
      order by business_id, name, id
    `
  );
  snapshot.suppliers = suppliersResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    phone: row.phone,
    linkedPhonebookContactId: row.linked_phonebook_contact_id,
    linkedPhonebookContactName: row.linked_phonebook_contact_name,
    email: row.email,
    notes: row.notes,
    salesAgentCount: row.sales_agent_count,
    purchaseReceiptCount: row.purchase_receipt_count,
    lastPurchaseDate:
      row.last_purchase_date === null ? null : timestampToIso(row.last_purchase_date),
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at)
  })) as Cp2Snapshot["suppliers"];

  const salesAgentsResult = await timedQuery<{
    id: string;
    business_id: string;
    supplier_id: string;
    supplier_name: string;
    name: string;
    phone: string | null;
    linked_phonebook_contact_id: string | null;
    linked_phonebook_contact_name: string | null;
    notes: string | null;
    receipts_handled: number;
    last_transaction_date: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load sales agents",
    `
      select id, business_id, supplier_id, supplier_name, name, phone, linked_phonebook_contact_id,
             linked_phonebook_contact_name, notes, receipts_handled, last_transaction_date, created_at, updated_at
      from sales_agents
      order by business_id, supplier_id, name, id
    `
  );
  snapshot.salesAgents = salesAgentsResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    name: row.name,
    phone: row.phone,
    linkedPhonebookContactId: row.linked_phonebook_contact_id,
    linkedPhonebookContactName: row.linked_phonebook_contact_name,
    notes: row.notes,
    receiptsHandled: row.receipts_handled,
    lastTransactionDate:
      row.last_transaction_date === null ? null : timestampToIso(row.last_transaction_date),
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at)
  })) as Cp2Snapshot["salesAgents"];

  const supplierContactLinksResult = await timedQuery<{
    id: string;
    business_id: string;
    link_type: string;
    supplier_id: string | null;
    sales_agent_id: string | null;
    network_node_id: string;
    contact_name: string;
    linked_at: Date;
  }>(
    pool,
    "load supplier contact links",
    `
      select id, business_id, link_type, supplier_id, sales_agent_id, network_node_id, contact_name, linked_at
      from supplier_contact_links
      order by business_id, linked_at, id
    `
  );
  snapshot.supplierContactLinks = supplierContactLinksResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    linkType: row.link_type,
    supplierId: row.supplier_id,
    salesAgentId: row.sales_agent_id,
    networkNodeId: row.network_node_id,
    contactName: row.contact_name,
    linkedAt: timestampToIso(row.linked_at)
  })) as Cp2Snapshot["supplierContactLinks"];

  const ocrJobsResult = await timedQuery<{
    id: string;
    business_id: string;
    tenant_id: string;
    shop_id: string;
    uploaded_by: string;
    status: string;
    source_file_name: string;
    content_type: string;
    engine: string;
    engine_version: string;
    model_version: string;
    profile: string;
    fallback_used: boolean;
    language_hints: unknown;
    full_text: string;
    average_confidence: string;
    warnings: unknown;
    field_evidence: unknown;
    structured_extraction: unknown;
    contact_matching_result: unknown;
    supplier_candidates: unknown;
    sales_agent_candidates: unknown;
    supplier_name: string | null;
    sales_agent_name: string | null;
    phone: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load receipt OCR jobs",
    `
      select id, business_id, tenant_id, shop_id, uploaded_by, status, source_file_name, content_type,
             engine, engine_version, model_version, profile, fallback_used, language_hints, full_text,
             average_confidence, warnings, field_evidence, structured_extraction, contact_matching_result,
             supplier_candidates, sales_agent_candidates, supplier_name, sales_agent_name, phone, created_at, updated_at
      from receipt_ocr_jobs
      order by business_id, updated_at, id
    `
  );
  snapshot.receiptOCRJobs = ocrJobsResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    uploadedBy: row.uploaded_by,
    status: row.status,
    sourceFileName: row.source_file_name,
    contentType: row.content_type,
    engine: row.engine,
    engineVersion: row.engine_version,
    modelVersion: row.model_version,
    profile: row.profile,
    fallbackUsed: row.fallback_used,
    languageHints: row.language_hints,
    fullText: row.full_text,
    averageConfidence: numberFromDatabase(row.average_confidence),
    warnings: row.warnings,
    fieldEvidence: row.field_evidence,
    structuredExtraction: row.structured_extraction,
    contactMatchingResult: row.contact_matching_result,
    supplierCandidates: row.supplier_candidates,
    salesAgentCandidates: row.sales_agent_candidates,
    supplierName: row.supplier_name,
    salesAgentName: row.sales_agent_name,
    phone: row.phone,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at)
  })) as Cp2Snapshot["receiptOCRJobs"];

  const purchaseReceiptsResult = await timedQuery<{
    id: string;
    business_id: string;
    supplier_id: string;
    supplier_name: string;
    sales_agent_id: string | null;
    sales_agent_name: string | null;
    receipt_date: Date;
    total: string;
    source_file_name: string | null;
    ocr_job_id: string | null;
    image_stored: boolean;
    created_at: Date;
  }>(
    pool,
    "load purchase receipts",
    `
      select id, business_id, supplier_id, supplier_name, sales_agent_id, sales_agent_name,
             receipt_date, total, source_file_name, ocr_job_id, image_stored, created_at
      from purchase_receipts
      order by business_id, receipt_date, id
    `
  );
  snapshot.purchaseReceipts = purchaseReceiptsResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    salesAgentId: row.sales_agent_id,
    salesAgentName: row.sales_agent_name,
    receiptDate: timestampToIso(row.receipt_date),
    total: numberFromDatabase(row.total),
    sourceFileName: row.source_file_name,
    ocrJobId: row.ocr_job_id,
    imageStored: row.image_stored,
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["purchaseReceipts"];

  const receiptLineItemsResult = await timedQuery<{
    id: string;
    receipt_id: string;
    name: string;
    quantity: string;
    unit_price: string;
    total: string;
  }>(
    pool,
    "load receipt line items",
    "select id, receipt_id, name, quantity, unit_price, total from receipt_line_items order by receipt_id, id"
  );
  snapshot.receiptLineItems = receiptLineItemsResult.rows.map((row) => ({
    id: row.id,
    receiptId: row.receipt_id,
    name: row.name,
    quantity: numberFromDatabase(row.quantity),
    unitPrice: numberFromDatabase(row.unit_price),
    total: numberFromDatabase(row.total)
  })) as Cp2Snapshot["receiptLineItems"];

  const invoicesResult = await timedQuery<{
    id: string;
    business_id: string;
    invoice_number: string;
    status: string;
    customer_id: string | null;
    customer_name: string | null;
    subtotal: string;
    tax_rate: string;
    tax_total: string;
    total: string;
    confirmed_at: Date | null;
    created_at: Date;
    updated_at: Date;
    source: string | null;
    source_message_channel: string | null;
    created_by_user_id: string | null;
  }>(
    pool,
    "load invoices",
    `
      select id, business_id, invoice_number, status, customer_id, customer_name,
             subtotal, tax_rate, tax_total, total, confirmed_at, created_at, updated_at,
             source, source_message_channel, created_by_user_id
      from invoices
      order by business_id, created_at, id
    `
  );
  const invoiceItemsResult = await timedQuery<{
    id: string;
    invoice_id: string;
    product_id: string;
    product_name: string;
    quantity: string;
    unit_price: string;
    line_total: string;
    unit_weight_grams_snapshot: string | null;
    total_weight_grams: string | null;
    weight_status: string | null;
    weight_unresolved_reason: string | null;
  }>(
    pool,
    "load invoice items",
    `
      select id, invoice_id, product_id, product_name, quantity, unit_price, line_total,
             unit_weight_grams_snapshot, total_weight_grams, weight_status, weight_unresolved_reason
      from invoice_items
      order by invoice_id, id
    `
  );
  const itemsByInvoiceId = new Map<string, SnapshotRecord[]>();

  for (const row of invoiceItemsResult.rows) {
    const item = {
      id: row.id,
      invoiceId: row.invoice_id,
      productId: row.product_id,
      productName: row.product_name,
      quantity: numberFromDatabase(row.quantity),
      unitPrice: numberFromDatabase(row.unit_price),
      lineTotal: numberFromDatabase(row.line_total),
      // Only snapshotted (post-089 confirmed) lines carry weight fields; older lines stay as they
      // were so their weight reads as NOT_SNAPSHOTTED rather than as a fabricated value.
      ...(row.weight_status === null
        ? {}
        : {
            unitWeightGramsSnapshot: row.unit_weight_grams_snapshot,
            totalWeightGrams: row.total_weight_grams,
            weightStatus: row.weight_status,
            weightUnresolvedReason: row.weight_unresolved_reason
          })
    };
    itemsByInvoiceId.set(row.invoice_id, [...(itemsByInvoiceId.get(row.invoice_id) ?? []), item]);
  }

  snapshot.invoices = invoicesResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    items: itemsByInvoiceId.get(row.id) ?? [],
    subtotal: numberFromDatabase(row.subtotal),
    taxRate: numberFromDatabase(row.tax_rate),
    taxTotal: numberFromDatabase(row.tax_total),
    total: numberFromDatabase(row.total),
    confirmedAt: row.confirmed_at === null ? null : timestampToIso(row.confirmed_at),
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
    source: row.source,
    sourceMessageChannel: row.source_message_channel,
    createdByUserId: row.created_by_user_id
  })) as unknown as Cp2Snapshot["invoices"];

  const paymentsResult = await timedQuery<{
    id: string;
    business_id: string;
    invoice_id: string;
    customer_id: string | null;
    method: string;
    amount: string;
    reference: string | null;
    note: string | null;
    actor_id: string;
    created_at: Date;
  }>(
    pool,
    "load payments",
    `
      select id, business_id, invoice_id, customer_id, method, amount, reference, note, actor_id, created_at
      from payments
      order by business_id, created_at, id
    `
  );
  snapshot.payments = paymentsResult.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    method: row.method,
    amount: numberFromDatabase(row.amount),
    reference: row.reference,
    note: row.note,
    actorId: row.actor_id,
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["payments"];

  const sessionsResult = await timedQuery<{
    id: string;
    account_id: string;
    user_id: string;
    device_id: string;
    device_name: string;
    platform: string;
    browser_or_app: string;
    user_agent_hash: string;
    refresh_token_hash: string;
    session_family_id: string;
    refresh_expires_at: Date;
    inactivity_expires_at: Date;
    absolute_expires_at: Date;
    rotated_from_session_id: string | null;
    authenticated_at: Date;
    last_used_at: Date;
    rotated_at: Date | null;
    revocation_reason: string | null;
    expires_at: Date;
    pin_verified_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    pool,
    "load sessions",
    `select id, account_id, user_id, device_id, device_name, platform, browser_or_app,
            user_agent_hash, refresh_token_hash, session_family_id, refresh_expires_at,
            inactivity_expires_at, absolute_expires_at, rotated_from_session_id, authenticated_at,
            last_used_at, rotated_at, revocation_reason, expires_at, pin_verified_at,
            revoked_at, created_at
       from sessions order by created_at, id`
  );
  snapshot.sessions = sessionsResult.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    browserOrApp: row.browser_or_app,
    userAgentHash: row.user_agent_hash,
    refreshTokenHash: row.refresh_token_hash,
    sessionFamilyId: row.session_family_id,
    refreshExpiresAt: timestampToIso(row.refresh_expires_at),
    inactivityExpiresAt: timestampToIso(row.inactivity_expires_at),
    absoluteExpiresAt: timestampToIso(row.absolute_expires_at),
    rotatedFromSessionId: row.rotated_from_session_id,
    authenticatedAt: timestampToIso(row.authenticated_at),
    lastUsedAt: timestampToIso(row.last_used_at),
    rotatedAt: row.rotated_at === null ? null : timestampToIso(row.rotated_at),
    revocationReason: row.revocation_reason,
    expiresAt: timestampToIso(row.expires_at),
    pinVerifiedAt: row.pin_verified_at === null ? null : timestampToIso(row.pin_verified_at),
    revokedAt: row.revoked_at === null ? null : timestampToIso(row.revoked_at),
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["sessions"];

  const otpChallengesResult = await timedQuery<{
    id: string;
    channel: string;
    destination: string;
    purpose: string;
    code_hash: string;
    attempts: number;
    max_attempts: number;
    expires_at: Date;
    verified_at: Date | null;
    consumed_at: Date | null;
    resend_count: number;
    next_resend_at: Date | null;
    provider: string | null;
    provider_message_id: string | null;
    created_at: Date;
  }>(
    pool,
    "load OTP challenges",
    `
      select id, channel, destination, purpose, code_hash, attempts, max_attempts, expires_at,
             verified_at, consumed_at, resend_count, next_resend_at, provider, provider_message_id,
             created_at
      from otp_challenges
      order by created_at, id
    `
  );
  snapshot.otpChallenges = otpChallengesResult.rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    destination: row.destination,
    purpose: row.purpose,
    codeHash: row.code_hash,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    expiresAt: timestampToIso(row.expires_at),
    verifiedAt: row.verified_at === null ? null : timestampToIso(row.verified_at),
    consumedAt: row.consumed_at === null ? null : timestampToIso(row.consumed_at),
    resendCount: row.resend_count,
    nextResendAt: row.next_resend_at === null ? null : timestampToIso(row.next_resend_at),
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    createdAt: timestampToIso(row.created_at)
  })) as Cp2Snapshot["otpChallenges"];

  const userIdentitiesResult = await timedQuery<{
    id: string;
    account_id: string;
    user_id: string;
    provider_id: string;
    provider_subject: string;
    email: string | null;
    display_name: string | null;
    encrypted_access_token: string | null;
    encrypted_refresh_token: string | null;
    encrypted_id_token: string | null;
    token_type: string | null;
    token_expires_at: Date | null;
    scope: string | null;
    linked_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load user identities",
    `
      select id, account_id, user_id, provider_id, provider_subject, email, display_name,
             encrypted_access_token, encrypted_refresh_token, encrypted_id_token, token_type,
             token_expires_at, scope, linked_at, updated_at
      from user_identities
      order by linked_at, id
    `
  );
  snapshot.userIdentities = userIdentitiesResult.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    provider: row.provider_id,
    providerSubject: row.provider_subject,
    email: row.email,
    displayName: row.display_name,
    encryptedAccessToken: row.encrypted_access_token,
    encryptedRefreshToken: row.encrypted_refresh_token,
    encryptedIdToken: row.encrypted_id_token,
    tokenType: row.token_type,
    tokenExpiresAt: row.token_expires_at === null ? null : timestampToIso(row.token_expires_at),
    scope: row.scope,
    linkedAt: timestampToIso(row.linked_at),
    updatedAt: timestampToIso(row.updated_at)
  })) as unknown as Cp2Snapshot["userIdentities"];

  const oauthSessionsResult = await timedQuery<{
    id: string;
    provider_id: string;
    account_id: string | null;
    state_hash: string;
    csrf_hash: string;
    code_challenge: string;
    encrypted_code_verifier: string;
    redirect_uri: string;
    expires_at: Date;
    completed_at: Date | null;
    created_at: Date;
  }>(
    pool,
    "load OAuth sessions",
    `
      select id, provider_id, account_id, state_hash, csrf_hash, code_challenge,
             encrypted_code_verifier, redirect_uri, expires_at, completed_at, created_at
      from oauth_sessions
      order by created_at, id
    `
  );
  snapshot.oauthSessions = oauthSessionsResult.rows.map((row) => ({
    id: row.id,
    provider: row.provider_id,
    accountId: row.account_id,
    stateHash: row.state_hash,
    csrfHash: row.csrf_hash,
    codeChallenge: row.code_challenge,
    codeVerifier: row.encrypted_code_verifier,
    redirectUri: row.redirect_uri,
    expiresAt: timestampToIso(row.expires_at),
    completedAt: row.completed_at === null ? null : timestampToIso(row.completed_at),
    createdAt: timestampToIso(row.created_at)
  })) as unknown as Cp2Snapshot["oauthSessions"];

  const accountPinHashesResult = await timedQuery<{
    account_id: string;
    pin_hash: string;
  }>(
    pool,
    "load account PIN hashes",
    "select account_id, pin_hash from account_pin_hashes order by account_id"
  );
  snapshot.accountPinHashes = accountPinHashesResult.rows.map((row) => ({
    accountId: row.account_id,
    pinHash: row.pin_hash
  }));

  const deviceTrustResult = await timedQuery<{
    business_id: string;
    user_id: string;
    device_id: string;
    level: string;
    reason: string | null;
    updated_by: string | null;
    updated_by_type: "user" | "system" | "service";
    updated_at: Date;
  }>(
    pool,
    "load device trust",
    `
      select business_id, user_id, device_id, level, reason,
             updated_by, updated_by_type, updated_at
      from device_trust
      order by business_id, user_id, device_id
    `
  );
  snapshot.deviceTrust = deviceTrustResult.rows.map((row) => ({
    businessId: row.business_id,
    userId: row.user_id,
    deviceId: row.device_id,
    level: row.level,
    reason: row.reason,
    updatedBy: row.updated_by ?? row.updated_by_type,
    updatedAt: timestampToIso(row.updated_at)
  })) as Cp2Snapshot["deviceTrust"];

  const syncChangesResult = await timedQuery<{
    account_id: string;
    sequence: string;
    cursor: string;
    collection: string;
    entity_id: string;
    operation: Cp2Snapshot["syncChanges"][number]["operation"];
    shop_id: string | null;
    entity: unknown | null;
    changed_at: Date;
    tombstone_expires_at: Date | null;
  }>(
    pool,
    "load account sync changes",
    `
      select account_id, sequence, cursor, collection, entity_id, operation,
             shop_id, entity, changed_at, tombstone_expires_at
      from account_sync_changes
      order by account_id, sequence
    `
  );
  snapshot.syncChanges = syncChangesResult.rows.map((row) => {
    const collection = requireAccountSyncCollection(row.account_id, row.collection);
    return {
      accountId: row.account_id,
      sequence: Number(row.sequence),
      cursor: row.cursor,
      collection,
      entityId: row.entity_id,
      operation: row.operation,
      shopId: row.shop_id,
      entity: row.entity,
      changedAt: timestampToIso(row.changed_at),
      tombstoneExpiresAt:
        row.tombstone_expires_at === null ? null : timestampToIso(row.tombstone_expires_at)
    };
  });

  const mcpAccessTokensResult = await timedQuery<{
    id: string;
    account_id: string;
    user_id: string;
    created_by_session_id: string | null;
    token_hash: string;
    name: string;
    scopes: Array<"mcp:read" | "mcp:act">;
    shop_id: string | null;
    created_at: Date;
    expires_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    pool,
    "load MCP access tokens",
    `
      select id, account_id, user_id, created_by_session_id, token_hash, name, scopes, shop_id,
             created_at, expires_at, last_used_at, revoked_at
      from mcp_access_tokens
      order by account_id, created_at, id
    `
  );
  snapshot.mcpAccessTokens = mcpAccessTokensResult.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    createdBySessionId: row.created_by_session_id,
    tokenHash: row.token_hash,
    name: row.name,
    scopes: row.scopes,
    shopId: row.shop_id,
    createdAt: timestampToIso(row.created_at),
    expiresAt: timestampToIso(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : timestampToIso(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : timestampToIso(row.revoked_at)
  }));

  const externalRegistryConnectionsResult = await timedQuery<{
    id: string;
    account_id: string;
    provider: "github" | "huggingface";
    external_account_id: string | null;
    external_username: string | null;
    status: "connected" | "expired" | "revoked" | "error";
    scopes: string[];
    encrypted_token: string | null;
    inference_authorized: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    "load external registry connections",
    `
      select id, account_id, provider, external_account_id, external_username, status, scopes,
             encrypted_token, inference_authorized, created_at, updated_at
      from cp2_external_registry_connections
      order by account_id, created_at, id
    `
  );
  snapshot.externalRegistryConnections = externalRegistryConnectionsResult.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    externalAccountId: row.external_account_id,
    externalUsername: row.external_username,
    status: row.status,
    scopes: row.scopes,
    inferenceAuthorized: row.inference_authorized,
    encryptedToken: row.encrypted_token,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at)
  }));
}

/**
 * `previousSnapshot`, when given, is compared against `snapshot` per collection so that a
 * collection nobody touched since the last successful save is skipped entirely - no
 * `select entity_id`, no upserts, no round trip for it. Every mutating call on the store triggers
 * a full-snapshot save (see the Proxy at the bottom of this file), so without this gate a single
 * product edit re-scans and re-upserts every row in every one of the ~60 collections below, not
 * just the one that changed. The comparison is a plain content equality check - it can only ever
 * produce a false "changed" (falls back to today's existing behavior for that collection, safe by
 * definition), never a false "unchanged", so it cannot skip work that was actually needed.
 *
 * This intentionally does not touch saveRelationalCoreRecords below: that function's ~20
 * individually-hand-written table blocks (accounts, users, sessions, business_memberships, etc.)
 * are exactly the kind of large, correctness-sensitive surface the single-instance-store-ceiling
 * doc already warns against rewriting in one sitting. Applying the same "skip if unchanged"
 * technique there is a legitimate, bounded follow-up, not something to fold into this change.
 */
function collectionUnchanged(current: SnapshotRecord[], previous: SnapshotRecord[]): boolean {
  if (current === previous) return true;
  if (current.length !== previous.length) return false;
  return JSON.stringify(current) === JSON.stringify(previous);
}

async function saveNormalizedSnapshot(
  pool: Pool,
  snapshot: Cp2Snapshot,
  previousSnapshot?: Cp2Snapshot
): Promise<{ syncJournalError: AccountSyncPersistenceError | null }> {
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query("select pg_advisory_lock(hashtext('soko.cp2.normalized_store'))");
    try {
      await client.query("begin");

      for (const collection of normalizedCollections) {
        const records = getSnapshotCollection(snapshot, collection.key);
        if (
          previousSnapshot !== undefined &&
          collectionUnchanged(records, getSnapshotCollection(previousSnapshot, collection.key))
        ) {
          continue;
        }
        await saveCollectionRecords(client, collection, records);
      }

      await reconcileConversationAttachmentBlobs(client, snapshot.conversationAttachments ?? []);

      await saveRelationalCoreRecords(client, snapshot);
      await client.query("commit");
      logSlowQuery("persist CP2 relational store", startedAt);
    } catch (error) {
      await client.query("rollback").catch((rollbackError: unknown) => {
        console.error("Failed to roll back CP2 normalized persistence transaction.", rollbackError);
      });
      throw error;
    }

    try {
      await saveAccountSyncChanges(client, snapshot);
      return { syncJournalError: null };
    } catch (error) {
      return {
        syncJournalError: normalizeAccountSyncPersistenceError(error, snapshot)
      };
    }
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('soko.cp2.normalized_store'))")
      .catch((error: unknown) => {
        console.error("Failed to release CP2 normalized persistence lock.", error);
      });
    client.release();
  }
}

function createPostgresAttachmentBlobStore(pool: Pool): ConversationAttachmentBlobStore {
  return {
    async put(blob) {
      await pool.query(
        `
          insert into cp2_conversation_attachment_blobs
            (storage_key, content, checksum, mime_type, updated_at)
          values ($1, $2, $3, $4, now())
          on conflict (storage_key) do update set
            content = excluded.content,
            checksum = excluded.checksum,
            mime_type = excluded.mime_type,
            updated_at = now()
        `,
        [blob.storageKey, blob.bytes, blob.checksum, blob.mimeType]
      );
    },
    async get(storageKey) {
      const result = await pool.query<{ content: Buffer }>(
        "select content from cp2_conversation_attachment_blobs where storage_key = $1",
        [storageKey]
      );
      const content = result.rows[0]?.content;
      return content === undefined ? null : Buffer.from(content);
    },
    async delete(storageKey) {
      await pool.query("delete from cp2_conversation_attachment_blobs where storage_key = $1", [
        storageKey
      ]);
    }
  };
}

function createPostgresAccountAiAssetStore(pool: Pool): AccountAiAssetStore {
  const readArtifact = async (
    artifactId: string,
    accountId: string,
    userId: string
  ): Promise<CloudModelArtifactSummary | null> => {
    const result = await pool.query<{
      metadata: CloudModelArtifactSummary;
      status: CloudModelArtifactSummary["status"];
      completed_at: Date | string | null;
    }>(
      `select metadata, status, completed_at
       from cp2_model_artifacts
       where artifact_id = $1 and account_id = $2 and user_id = $3`,
      [artifactId, accountId, userId]
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...row.metadata,
      status: row.status,
      completedAt: row.completed_at === null ? null : timestampToIso(row.completed_at)
    };
  };

  return {
    async putAgentManifest(input) {
      await pool.query(
        `insert into cp2_installed_oss_agent_manifests
           (account_id, user_id, agent_definition_id, manifest, installed_at, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, now())
         on conflict (account_id, user_id, agent_definition_id) do update set
           manifest = excluded.manifest,
           installed_at = excluded.installed_at,
           updated_at = now()`,
        [input.accountId, input.userId, input.agent.id, JSON.stringify(input), input.installedAt]
      );
    },
    async listAgentManifests(accountId, userId) {
      const result = await pool.query<{ manifest: InstalledOssAgentManifestSummary }>(
        `select manifest
         from cp2_installed_oss_agent_manifests
         where account_id = $1 and user_id = $2
         order by installed_at desc`,
        [accountId, userId]
      );
      return result.rows.map((row) => hydrateAccountAgentManifest(row.manifest));
    },
    async beginModelArtifact({ accountId, userId, model, now }) {
      const artifact = modelArtifactFromInstallation(accountId, userId, model, now);
      await pool.query(
        `delete from cp2_model_artifacts
         where account_id = $1 and user_id = $2 and model_id = $3 and status = 'UPLOADING'`,
        [accountId, userId, model.modelId]
      );
      await pool.query(
        `insert into cp2_model_artifacts
           (artifact_id, account_id, user_id, model_id, metadata, file_size_bytes,
            chunk_size_bytes, chunk_count, status, created_at, completed_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'UPLOADING', $9, null, now())`,
        [
          artifact.id,
          accountId,
          userId,
          artifact.modelId,
          JSON.stringify(artifact),
          artifact.fileSizeBytes,
          artifact.chunkSizeBytes,
          artifact.chunkCount,
          now
        ]
      );
      return artifact;
    },
    async putModelArtifactChunk(input) {
      const artifact = await readArtifact(input.artifactId, input.accountId, input.userId);
      if (artifact === null) throw new Error("Cloud model artifact was not found.");
      if (artifact.status !== "UPLOADING") throw new Error("Cloud model upload is not active.");
      assertArtifactChunk(artifact, input.chunkIndex, input.bytes);
      await pool.query(
        `insert into cp2_model_artifact_chunks (artifact_id, chunk_index, content, updated_at)
         values ($1, $2, $3, now())
         on conflict (artifact_id, chunk_index) do update set
           content = excluded.content,
           updated_at = now()`,
        [input.artifactId, input.chunkIndex, input.bytes]
      );
    },
    async completeModelArtifact(input) {
      const artifact = await readArtifact(input.artifactId, input.accountId, input.userId);
      if (artifact === null) throw new Error("Cloud model artifact was not found.");
      const result = await pool.query<{ chunk_count: string; stored_bytes: string }>(
        `select count(*)::text as chunk_count,
                coalesce(sum(octet_length(content)), 0)::text as stored_bytes
         from cp2_model_artifact_chunks
         where artifact_id = $1`,
        [artifact.id]
      );
      const row = result.rows[0];
      if (
        Number(row?.chunk_count ?? 0) !== artifact.chunkCount ||
        Number(row?.stored_bytes ?? 0) !== artifact.fileSizeBytes
      ) {
        throw new Error("The cloud model upload is incomplete.");
      }
      await pool.query(
        `update cp2_model_artifacts
         set status = 'READY', completed_at = $4, updated_at = now()
         where artifact_id = $1 and account_id = $2 and user_id = $3`,
        [artifact.id, input.accountId, input.userId, input.now]
      );
      await pool.query(
        `delete from cp2_model_artifacts
         where account_id = $1 and user_id = $2 and model_id = $3
           and status = 'READY' and artifact_id <> $4`,
        [input.accountId, input.userId, artifact.modelId, artifact.id]
      );
      return { ...artifact, status: "READY", completedAt: input.now };
    },
    async listModelArtifacts(accountId, userId) {
      const result = await pool.query<{
        metadata: CloudModelArtifactSummary;
        completed_at: Date | string;
      }>(
        `select metadata, completed_at
         from cp2_model_artifacts
         where account_id = $1 and user_id = $2 and status = 'READY'
         order by completed_at desc`,
        [accountId, userId]
      );
      return result.rows.map((row) => ({
        ...row.metadata,
        status: "READY",
        completedAt: timestampToIso(row.completed_at)
      }));
    },
    async getModelArtifactChunk(input) {
      const result = await pool.query<{ content: Buffer }>(
        `select chunk.content
         from cp2_model_artifact_chunks chunk
         join cp2_model_artifacts artifact on artifact.artifact_id = chunk.artifact_id
         where chunk.artifact_id = $1 and chunk.chunk_index = $2
           and artifact.account_id = $3 and artifact.user_id = $4 and artifact.status = 'READY'`,
        [input.artifactId, input.chunkIndex, input.accountId, input.userId]
      );
      const content = result.rows[0]?.content;
      return content === undefined ? null : Buffer.from(content);
    }
  };
}

async function reconcileConversationAttachmentBlobs(
  client: PoolClient,
  attachments: ConversationAttachmentRecord[]
): Promise<void> {
  const storageKeys = attachments.map((attachment) => attachment.storageKey);
  if (storageKeys.length === 0) {
    await client.query("delete from cp2_conversation_attachment_blobs");
    return;
  }
  await client.query(
    "delete from cp2_conversation_attachment_blobs where not (storage_key = any($1::text[]))",
    [storageKeys]
  );
}

function passkeyCeremonyMutation(
  snapshot: Cp2Snapshot,
  previousIds: Set<string>,
  result: unknown
): PasskeyCeremonyMutation {
  const ceremonies = snapshot.passkeyCeremonies ?? [];
  const currentIds = new Set(ceremonies.map((ceremony) => ceremony.id));
  const removedIds = [...previousIds].filter((ceremonyId) => !currentIds.has(ceremonyId));

  if (result === null) {
    return { removedIds, upsert: null };
  }

  if (typeof result !== "object" || !("ceremonyId" in result)) {
    throw new Error("Passkey ceremony creation did not return a ceremony ID.");
  }
  const ceremonyId = (result as { ceremonyId?: unknown }).ceremonyId;
  if (typeof ceremonyId !== "string") {
    throw new Error("Passkey ceremony creation returned an invalid ceremony ID.");
  }
  const ceremony = ceremonies.find((candidate) => candidate.id === ceremonyId);
  if (ceremony === undefined) {
    throw new Error("Created passkey ceremony is missing from the persistence snapshot.");
  }

  return { removedIds, upsert: structuredClone(ceremony) };
}

function applyPersistedPasskeyCeremonyMutation(
  snapshot: Cp2Snapshot,
  mutation: PasskeyCeremonyMutation
): void {
  const ceremonies = new Map(
    (snapshot.passkeyCeremonies ?? []).map((ceremony) => [ceremony.id, ceremony])
  );
  for (const ceremonyId of mutation.removedIds) {
    ceremonies.delete(ceremonyId);
  }
  if (mutation.upsert !== null) {
    ceremonies.set(mutation.upsert.id, structuredClone(mutation.upsert));
  }
  snapshot.passkeyCeremonies = [...ceremonies.values()];
}

async function savePasskeyCeremonyMutation(
  pool: Pool,
  mutation: PasskeyCeremonyMutation
): Promise<void> {
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query("select pg_advisory_lock(hashtext('soko.cp2.normalized_store'))");
    try {
      await client.query("begin");
      if (mutation.removedIds.length > 0) {
        await client.query("delete from cp2_passkey_ceremonies where entity_id = any($1::text[])", [
          mutation.removedIds
        ]);
      }
      if (mutation.upsert !== null) {
        await client.query(
          `
            insert into cp2_passkey_ceremonies
              (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
            values ($1, null, $2, null, null, $3::jsonb, now())
            on conflict (entity_id) do update set
              business_id = excluded.business_id,
              account_id = excluded.account_id,
              user_id = excluded.user_id,
              parent_id = excluded.parent_id,
              record = excluded.record,
              updated_at = now()
          `,
          [mutation.upsert.id, mutation.upsert.accountId, JSON.stringify(mutation.upsert)]
        );
      }
      await client.query("commit");
      logSlowQuery("persist passkey ceremony", startedAt);
    } catch (error) {
      await client.query("rollback").catch((rollbackError: unknown) => {
        console.error(
          "Failed to roll back passkey ceremony persistence transaction.",
          rollbackError
        );
      });
      throw error;
    }
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('soko.cp2.normalized_store'))")
      .catch((error: unknown) => {
        console.error("Failed to release passkey ceremony persistence lock.", error);
      });
    client.release();
  }
}

async function saveAccountSyncChanges(client: PoolClient, snapshot: Cp2Snapshot): Promise<void> {
  const startedAt = Date.now();

  try {
    await client.query("begin");
    for (const change of snapshot.syncChanges) {
      requireAccountSyncCollection(change.accountId, change.collection);
    }
    await replaceAccountSyncChanges(client, snapshot);
    await client.query("commit");
    logSlowQuery("persist account sync journal", startedAt);
    console.info(
      JSON.stringify({
        event: "account_sync_changes_transaction_committed",
        changeCount: snapshot.syncChanges.length,
        accountCount: new Set(snapshot.syncChanges.map((change) => change.accountId)).size
      })
    );
  } catch (error) {
    await client.query("rollback").catch((rollbackError: unknown) => {
      console.error("Failed to roll back account sync journal transaction.", rollbackError);
    });
    throw error;
  }
}

async function saveCollectionRecords(
  client: PoolClient,
  collection: NormalizedCollection,
  records: SnapshotRecord[]
): Promise<void> {
  const desiredIds = records.map((record) => recordEntityId(collection.key, record));
  const existingResult = await client.query<{ entity_id: string }>(
    `select entity_id from ${collection.tableName}`
  );
  const desiredIdSet = new Set(desiredIds);
  const removedIds = existingResult.rows
    .map((row) => row.entity_id)
    .filter((entityId) => !desiredIdSet.has(entityId));

  if (removedIds.length > 0) {
    await client.query(`delete from ${collection.tableName} where entity_id = any($1::text[])`, [
      removedIds
    ]);
  }

  for (const record of records) {
    await client.query(
      `
        insert into ${collection.tableName}
          (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
        values ($1, $2, $3, $4, $5, $6::jsonb, now())
        on conflict (entity_id) do update set
          business_id = excluded.business_id,
          account_id = excluded.account_id,
          user_id = excluded.user_id,
          parent_id = excluded.parent_id,
          record = excluded.record,
          updated_at = now()
      `,
      [
        recordEntityId(collection.key, record),
        firstText(record, ["businessId", "shopId", "tenantId"]),
        firstText(record, ["accountId", "buyerAccountId"]),
        firstText(record, ["userId", "ownerUserId", "actorId", "postedBy"]),
        recordParentId(collection.key, record),
        JSON.stringify(record)
      ]
    );
  }
}

async function saveRelationalCoreRecords(client: PoolClient, snapshot: Cp2Snapshot): Promise<void> {
  const now = new Date().toISOString();

  await saveShopDeletionArchives(client, snapshotRecords(snapshot.accountDeletionRequests));

  await deleteMissingRows(client, "mcp_access_tokens", snapshotRecords(snapshot.mcpAccessTokens));
  await deleteMissingRows(
    client,
    "cp2_external_registry_connections",
    snapshotRecords(snapshot.externalRegistryConnections)
  );
  await deleteMissingRows(client, "receipt_line_items", snapshotRecords(snapshot.receiptLineItems));
  await deleteMissingRows(client, "payments", snapshotRecords(snapshot.payments));
  await deleteMissingInvoiceRows(client, snapshotRecords(snapshot.invoices));
  await deleteMissingRows(client, "purchase_receipts", snapshotRecords(snapshot.purchaseReceipts));
  await deleteMissingRows(client, "receipt_ocr_jobs", snapshotRecords(snapshot.receiptOCRJobs));
  await deleteMissingRows(
    client,
    "supplier_contact_links",
    snapshotRecords(snapshot.supplierContactLinks)
  );
  await deleteMissingDeviceTrustRows(client, snapshotRecords(snapshot.deviceTrust));
  await deleteMissingRows(client, "oauth_sessions", snapshotRecords(snapshot.oauthSessions));
  await deleteMissingRows(client, "auth_accounts", snapshotRecords(snapshot.userIdentities));
  await deleteMissingRows(
    client,
    "verification_challenges",
    snapshotRecords(snapshot.otpChallenges)
  );
  await deleteMissingRows(
    client,
    "sms_delivery_attempts",
    snapshotRecords(snapshot.smsDeliveryAttempts)
  );
  await deleteMissingRows(client, "user_identities", snapshotRecords(snapshot.userIdentities));
  await deleteMissingRows(client, "otp_challenges", snapshotRecords(snapshot.otpChallenges));
  await deleteMissingAccountPinHashes(client, snapshotRecords(snapshot.accountPinHashes));
  await deleteMissingRows(client, "sales_agents", snapshotRecords(snapshot.salesAgents));
  await deleteMissingRows(client, "suppliers", snapshotRecords(snapshot.suppliers));
  await deleteMissingRows(client, "sessions", snapshotRecords(snapshot.sessions));
  await deleteMissingRows(client, "business_memberships", snapshotRecords(snapshot.memberships));
  await deleteRemovedAccountRelationalGraph(client, snapshot);

  for (const record of snapshotRecords(snapshot.accounts)) {
    await client.query(
      `
        insert into accounts (
          id, primary_auth_channel, primary_auth_destination, identity_level,
          status, deleted_at, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (id) do update set
          primary_auth_channel = excluded.primary_auth_channel,
          primary_auth_destination = excluded.primary_auth_destination,
          identity_level = excluded.identity_level,
          status = excluded.status,
          deleted_at = excluded.deleted_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "primaryAuthChannel"),
        requiredText(record, "primaryAuthDestination"),
        firstText(record, ["identityLevel"]) ?? "strong",
        firstText(record, ["status"]) ?? "active",
        firstText(record, ["deletedAt"]),
        now
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.users)) {
    await client.query(
      `
        insert into users (
          id,
          account_id,
          display_name,
          language,
          phone_number_e164,
          phone_country_code,
          phone_national_number,
          phone_verification_status,
          phone_added_at,
          phone_updated_at,
          phone_source,
          public_phone_enabled,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (id) do update set
          account_id = excluded.account_id,
          display_name = excluded.display_name,
          language = excluded.language,
          phone_number_e164 = excluded.phone_number_e164,
          phone_country_code = excluded.phone_country_code,
          phone_national_number = excluded.phone_national_number,
          phone_verification_status = excluded.phone_verification_status,
          phone_added_at = excluded.phone_added_at,
          phone_updated_at = excluded.phone_updated_at,
          phone_source = excluded.phone_source,
          public_phone_enabled = excluded.public_phone_enabled
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "accountId"),
        requiredText(record, "displayName"),
        requiredText(record, "language"),
        firstText(record, ["phoneNumberE164"]),
        firstText(record, ["phoneCountryCode"]),
        firstText(record, ["phoneNationalNumber"]),
        firstText(record, ["phoneVerificationStatus"]),
        firstText(record, ["phoneAddedAt"]),
        firstText(record, ["phoneUpdatedAt"]),
        firstText(record, ["phoneSource"]),
        record.publicPhoneEnabled === true,
        now
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.businesses)) {
    await client.query(
      `
        insert into businesses (id, name, language, soko_id, timezone, created_at)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (id) do update set
          name = excluded.name,
          language = excluded.language,
          soko_id = excluded.soko_id,
          timezone = excluded.timezone
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "name"),
        requiredText(record, "language"),
        firstText(record, ["sokoId"]),
        firstText(record, ["timezone"]),
        now
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.memberships)) {
    await client.query(
      `
        insert into business_memberships (id, business_id, user_id, role, created_at)
        values ($1, $2, $3, $4, $5)
        on conflict (id) do update set
          business_id = excluded.business_id,
          user_id = excluded.user_id,
          role = excluded.role
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "userId"),
        requiredText(record, "role"),
        now
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.products)) {
    await client.query(
      `
        insert into products
          (id, business_id, name, sku, aliases, unit, quantity, buying_price, selling_price,
           unit_weight_grams, primary_media_id, created_at, updated_at)
        values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10::bigint, $11, $12, $13)
        on conflict (id) do update set
          business_id = excluded.business_id,
          name = excluded.name,
          sku = excluded.sku,
          aliases = excluded.aliases,
          unit = excluded.unit,
          quantity = excluded.quantity,
          buying_price = excluded.buying_price,
          selling_price = excluded.selling_price,
          unit_weight_grams = excluded.unit_weight_grams,
          primary_media_id = excluded.primary_media_id,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "name"),
        firstText(record, ["sku"]),
        Array.isArray(record.aliases) ? record.aliases : [],
        requiredText(record, "unit"),
        record.quantity,
        record.buyingPrice ?? null,
        record.sellingPrice ?? null,
        firstText(record, ["unitWeightGrams"]),
        firstText(record, ["primaryMediaId"]),
        requiredText(record, "createdAt"),
        requiredText(record, "updatedAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.customers)) {
    await client.query(
      `
        insert into customers (id, business_id, name, phone, email, linked_account_id, notes, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (id) do update set
          business_id = excluded.business_id,
          name = excluded.name,
          phone = excluded.phone,
          email = excluded.email,
          linked_account_id = excluded.linked_account_id,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "name"),
        firstText(record, ["phone"]),
        firstText(record, ["email"]),
        firstText(record, ["linkedAccountId"]),
        firstText(record, ["notes"]),
        requiredText(record, "createdAt"),
        requiredText(record, "updatedAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.suppliers)) {
    await client.query(
      `
        insert into suppliers (
          id, business_id, name, phone, linked_phonebook_contact_id, linked_phonebook_contact_name,
          email, notes, sales_agent_count, purchase_receipt_count, last_purchase_date, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (id) do update set
          business_id = excluded.business_id,
          name = excluded.name,
          phone = excluded.phone,
          linked_phonebook_contact_id = excluded.linked_phonebook_contact_id,
          linked_phonebook_contact_name = excluded.linked_phonebook_contact_name,
          email = excluded.email,
          notes = excluded.notes,
          sales_agent_count = excluded.sales_agent_count,
          purchase_receipt_count = excluded.purchase_receipt_count,
          last_purchase_date = excluded.last_purchase_date,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "name"),
        firstText(record, ["phone"]),
        firstText(record, ["linkedPhonebookContactId"]),
        firstText(record, ["linkedPhonebookContactName"]),
        firstText(record, ["email"]),
        firstText(record, ["notes"]),
        record.salesAgentCount ?? 0,
        record.purchaseReceiptCount ?? 0,
        firstText(record, ["lastPurchaseDate"]),
        requiredText(record, "createdAt"),
        requiredText(record, "updatedAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.salesAgents)) {
    await client.query(
      `
        insert into sales_agents (
          id, business_id, supplier_id, supplier_name, name, phone, linked_phonebook_contact_id,
          linked_phonebook_contact_name, notes, receipts_handled, last_transaction_date, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (id) do update set
          supplier_name = excluded.supplier_name,
          name = excluded.name,
          phone = excluded.phone,
          linked_phonebook_contact_id = excluded.linked_phonebook_contact_id,
          linked_phonebook_contact_name = excluded.linked_phonebook_contact_name,
          notes = excluded.notes,
          receipts_handled = excluded.receipts_handled,
          last_transaction_date = excluded.last_transaction_date,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "supplierId"),
        requiredText(record, "supplierName"),
        requiredText(record, "name"),
        firstText(record, ["phone"]),
        firstText(record, ["linkedPhonebookContactId"]),
        firstText(record, ["linkedPhonebookContactName"]),
        firstText(record, ["notes"]),
        record.receiptsHandled ?? 0,
        firstText(record, ["lastTransactionDate"]),
        requiredText(record, "createdAt"),
        requiredText(record, "updatedAt")
      ]
    );
  }

  await savePhase1AuthSecurityRecords(client, snapshot);

  for (const record of snapshotRecords(snapshot.supplierContactLinks)) {
    await client.query(
      `
        insert into supplier_contact_links (
          id, business_id, link_type, supplier_id, sales_agent_id, network_node_id, contact_name, linked_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (id) do update set
          business_id = excluded.business_id,
          link_type = excluded.link_type,
          supplier_id = excluded.supplier_id,
          sales_agent_id = excluded.sales_agent_id,
          network_node_id = excluded.network_node_id,
          contact_name = excluded.contact_name,
          linked_at = excluded.linked_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "linkType"),
        firstText(record, ["supplierId"]),
        firstText(record, ["salesAgentId"]),
        requiredText(record, "networkNodeId"),
        requiredText(record, "contactName"),
        requiredText(record, "linkedAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.receiptOCRJobs)) {
    await client.query(
      `
        insert into receipt_ocr_jobs (
          id, business_id, tenant_id, shop_id, uploaded_by, status, source_file_name, content_type,
          engine, engine_version, model_version, profile, fallback_used, language_hints, full_text,
          average_confidence, warnings, field_evidence, structured_extraction, contact_matching_result,
          supplier_candidates, sales_agent_candidates, supplier_name, sales_agent_name, phone, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23, $24, $25, now())
        on conflict (id) do update set
          status = excluded.status,
          full_text = excluded.full_text,
          average_confidence = excluded.average_confidence,
          warnings = excluded.warnings,
          field_evidence = excluded.field_evidence,
          structured_extraction = excluded.structured_extraction,
          contact_matching_result = excluded.contact_matching_result,
          supplier_candidates = excluded.supplier_candidates,
          sales_agent_candidates = excluded.sales_agent_candidates,
          supplier_name = excluded.supplier_name,
          sales_agent_name = excluded.sales_agent_name,
          phone = excluded.phone,
          updated_at = now()
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "tenantId"),
        requiredText(record, "shopId"),
        requiredText(record, "uploadedBy"),
        requiredText(record, "status"),
        requiredText(record, "sourceFileName"),
        requiredText(record, "contentType"),
        requiredText(record, "engine"),
        requiredText(record, "engineVersion"),
        requiredText(record, "modelVersion"),
        requiredText(record, "profile"),
        record.fallbackUsed === true,
        JSON.stringify(record.languageHints ?? []),
        firstText(record, ["fullText"]) ?? "",
        record.averageConfidence ?? 0,
        JSON.stringify(record.warnings ?? []),
        JSON.stringify(record.fieldEvidence ?? []),
        JSON.stringify(record.structuredExtraction ?? {}),
        JSON.stringify(record.contactMatchingResult ?? {}),
        JSON.stringify(record.supplierCandidates ?? []),
        JSON.stringify(record.salesAgentCandidates ?? []),
        firstText(record, ["supplierName"]),
        firstText(record, ["salesAgentName"]),
        firstText(record, ["phone"])
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.purchaseReceipts)) {
    await client.query(
      `
        insert into purchase_receipts (
          id, business_id, supplier_id, supplier_name, sales_agent_id, sales_agent_name,
          receipt_date, total, source_file_name, ocr_job_id, image_stored, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict (id) do update set
          supplier_id = excluded.supplier_id,
          supplier_name = excluded.supplier_name,
          sales_agent_id = excluded.sales_agent_id,
          sales_agent_name = excluded.sales_agent_name,
          receipt_date = excluded.receipt_date,
          total = excluded.total,
          source_file_name = excluded.source_file_name,
          ocr_job_id = excluded.ocr_job_id,
          image_stored = excluded.image_stored
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "supplierId"),
        requiredText(record, "supplierName"),
        firstText(record, ["salesAgentId"]),
        firstText(record, ["salesAgentName"]),
        requiredText(record, "receiptDate"),
        record.total,
        firstText(record, ["sourceFileName"]),
        firstText(record, ["ocrJobId"]),
        record.imageStored === true,
        requiredText(record, "createdAt")
      ]
    );
  }

  await replaceReceiptLineItems(client, snapshotRecords(snapshot.receiptLineItems));
  await saveInvoicesAndItems(client, snapshotRecords(snapshot.invoices));

  for (const record of snapshotRecords(snapshot.payments)) {
    await client.query(
      `
        insert into payments (
          id, business_id, invoice_id, customer_id, method, amount, reference, note, actor_id, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (id) do update set
          method = excluded.method,
          amount = excluded.amount,
          reference = excluded.reference,
          note = excluded.note
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "invoiceId"),
        firstText(record, ["customerId"]),
        requiredText(record, "method"),
        record.amount,
        firstText(record, ["reference"]),
        firstText(record, ["note"]),
        requiredText(record, "actorId"),
        requiredText(record, "createdAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.sessions)) {
    await client.query(
      `
        insert into sessions (
          id, account_id, user_id, device_id, device_name, platform, browser_or_app,
          user_agent_hash, refresh_token_hash, session_family_id, refresh_expires_at,
          inactivity_expires_at, absolute_expires_at, rotated_from_session_id, authenticated_at,
          last_used_at, rotated_at, revocation_reason, expires_at, pin_verified_at,
          revoked_at, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        on conflict (id) do update set
          device_id = excluded.device_id,
          device_name = excluded.device_name,
          platform = excluded.platform,
          browser_or_app = excluded.browser_or_app,
          user_agent_hash = excluded.user_agent_hash,
          refresh_token_hash = excluded.refresh_token_hash,
          session_family_id = excluded.session_family_id,
          refresh_expires_at = excluded.refresh_expires_at,
          inactivity_expires_at = excluded.inactivity_expires_at,
          absolute_expires_at = excluded.absolute_expires_at,
          rotated_from_session_id = excluded.rotated_from_session_id,
          authenticated_at = excluded.authenticated_at,
          last_used_at = excluded.last_used_at,
          rotated_at = excluded.rotated_at,
          revocation_reason = excluded.revocation_reason,
          expires_at = excluded.expires_at,
          pin_verified_at = excluded.pin_verified_at,
          revoked_at = excluded.revoked_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "accountId"),
        requiredText(record, "userId"),
        requiredText(record, "deviceId"),
        requiredText(record, "deviceName"),
        requiredText(record, "platform"),
        requiredText(record, "browserOrApp"),
        requiredText(record, "userAgentHash"),
        requiredText(record, "refreshTokenHash"),
        requiredText(record, "sessionFamilyId"),
        requiredText(record, "refreshExpiresAt"),
        requiredText(record, "inactivityExpiresAt"),
        requiredText(record, "absoluteExpiresAt"),
        firstText(record, ["rotatedFromSessionId"]),
        requiredText(record, "authenticatedAt"),
        requiredText(record, "lastUsedAt"),
        firstText(record, ["rotatedAt"]),
        firstText(record, ["revocationReason"]),
        requiredText(record, "expiresAt"),
        firstText(record, ["pinVerifiedAt"]),
        firstText(record, ["revokedAt"]),
        requiredText(record, "createdAt")
      ]
    );
  }

  for (const token of snapshot.mcpAccessTokens) {
    await client.query(
      `
        insert into mcp_access_tokens (
          id, account_id, user_id, created_by_session_id, token_hash, name, scopes, shop_id,
          created_at, expires_at, last_used_at, revoked_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12)
        on conflict (id) do update set
          token_hash = excluded.token_hash,
          name = excluded.name,
          scopes = excluded.scopes,
          shop_id = excluded.shop_id,
          expires_at = excluded.expires_at,
          last_used_at = excluded.last_used_at,
          revoked_at = excluded.revoked_at
      `,
      [
        token.id,
        token.accountId,
        token.userId,
        token.createdBySessionId,
        token.tokenHash,
        token.name,
        token.scopes,
        token.shopId,
        token.createdAt,
        token.expiresAt,
        token.lastUsedAt,
        token.revokedAt
      ]
    );
  }

  for (const connection of snapshot.externalRegistryConnections) {
    await client.query(
      `
        insert into cp2_external_registry_connections (
          id, account_id, provider, external_account_id, external_username, status, scopes,
          encrypted_token, inference_authorized, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11)
        on conflict (id) do update set
          external_account_id = excluded.external_account_id,
          external_username = excluded.external_username,
          status = excluded.status,
          scopes = excluded.scopes,
          encrypted_token = excluded.encrypted_token,
          inference_authorized = excluded.inference_authorized,
          updated_at = excluded.updated_at
      `,
      [
        connection.id,
        connection.accountId,
        connection.provider,
        connection.externalAccountId,
        connection.externalUsername,
        connection.status,
        connection.scopes,
        connection.encryptedToken,
        connection.inferenceAuthorized,
        connection.createdAt,
        connection.updatedAt
      ]
    );
  }
}

async function replaceAccountSyncChanges(client: PoolClient, snapshot: Cp2Snapshot): Promise<void> {
  await client.query(
    `
      delete from account_sync_changes as persisted
      where not exists (
        select 1
        from jsonb_to_recordset($1::jsonb) as desired(account_id uuid, sequence bigint)
        where desired.account_id = persisted.account_id
          and desired.sequence = persisted.sequence
      )
    `,
    [
      JSON.stringify(
        snapshot.syncChanges.map((change) => ({
          account_id: change.accountId,
          sequence: change.sequence
        }))
      )
    ]
  );

  if (snapshot.syncChanges.length === 0) return;

  try {
    // The common case (no constraint violation) is a single bulk upsert instead of one round
    // trip per row - with a large backlog (e.g. after the API wakes from a cold start with
    // hundreds of queued changes), the previous per-row loop's sequential network round trips
    // were the dominant cost of "persist account sync journal", observed taking 40s+ in
    // production. See docs note at upsertAccountSyncChangesOneByOne for why the fallback below
    // still exists.
    await upsertAccountSyncChangesBulk(client, snapshot.syncChanges);
  } catch {
    // The bulk statement can't identify which row violated a constraint - fall back to the
    // slower row-by-row path only when something actually went wrong, so
    // AccountSyncPersistenceError still names the exact offending account/collection.
    await upsertAccountSyncChangesOneByOne(client, snapshot.syncChanges);
  }
}

/** Exported only so tests/cp2-postgres-store.test.ts can benchmark and correctness-check the bulk
 * upsert directly, without routing hundreds of rows through the full HTTP + business-logic +
 * saveRelationalCoreRecords pipeline (which has its own, unrelated per-mutation cost that would
 * otherwise swamp a timing assertion aimed specifically at this function). */
export async function upsertAccountSyncChangesBulk(
  client: PoolClient,
  changes: Cp2Snapshot["syncChanges"]
): Promise<void> {
  await client.query(
    `
      insert into account_sync_changes (
        account_id, sequence, cursor, collection, entity_id, operation,
        shop_id, entity, changed_at, tombstone_expires_at
      )
      select
        account_id, sequence, cursor, collection, entity_id, operation,
        shop_id, entity, changed_at, tombstone_expires_at
      from jsonb_to_recordset($1::jsonb) as desired(
        account_id uuid, sequence bigint, cursor uuid, collection text, entity_id text,
        operation text, shop_id uuid, entity jsonb, changed_at timestamptz,
        tombstone_expires_at timestamptz
      )
      on conflict (account_id, sequence) do update set
        cursor = excluded.cursor,
        collection = excluded.collection,
        entity_id = excluded.entity_id,
        operation = excluded.operation,
        shop_id = excluded.shop_id,
        entity = excluded.entity,
        changed_at = excluded.changed_at,
        tombstone_expires_at = excluded.tombstone_expires_at
    `,
    [JSON.stringify(changes.map(accountSyncChangeToRecordsetRow))]
  );
}

/**
 * Row-by-row fallback for upsertAccountSyncChangesBulk, kept only so a real constraint violation
 * (e.g. account_sync_changes_collection_check, exercised by tests/api-persistence-ack.test.ts) can
 * still be attributed to the exact account/collection that caused it - jsonb_to_recordset's bulk
 * insert fails as one statement with no per-row detail. Only reached when the bulk path throws,
 * which should be rare in practice.
 */
async function upsertAccountSyncChangesOneByOne(
  client: PoolClient,
  changes: Cp2Snapshot["syncChanges"]
): Promise<void> {
  for (const change of changes) {
    try {
      await client.query(
        `
          insert into account_sync_changes (
            account_id, sequence, cursor, collection, entity_id, operation,
            shop_id, entity, changed_at, tombstone_expires_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
          on conflict (account_id, sequence) do update set
            cursor = excluded.cursor,
            collection = excluded.collection,
            entity_id = excluded.entity_id,
            operation = excluded.operation,
            shop_id = excluded.shop_id,
            entity = excluded.entity,
            changed_at = excluded.changed_at,
            tombstone_expires_at = excluded.tombstone_expires_at
        `,
        [
          change.accountId,
          change.sequence,
          change.cursor,
          change.collection,
          change.entityId,
          change.operation,
          change.shopId,
          change.entity === null ? null : JSON.stringify(change.entity),
          change.changedAt,
          change.tombstoneExpiresAt
        ]
      );
    } catch (cause) {
      throw new AccountSyncPersistenceError(
        change.accountId,
        change.collection,
        readConstraintName(cause),
        { cause }
      );
    }
  }
}

function accountSyncChangeToRecordsetRow(
  change: Cp2Snapshot["syncChanges"][number]
): Record<string, unknown> {
  return {
    account_id: change.accountId,
    sequence: change.sequence,
    cursor: change.cursor,
    collection: change.collection,
    entity_id: change.entityId,
    operation: change.operation,
    shop_id: change.shopId,
    entity: change.entity,
    changed_at: change.changedAt,
    tombstone_expires_at: change.tombstoneExpiresAt
  };
}

/**
 * Fulfillment tables (090_fulfillment_foundation.sql) are Postgres-authoritative and never written
 * by this snapshot writer - except here: when a business is purged from the store, its
 * fulfillment rows (vehicles, policies, shop locations with their history, idempotency records)
 * go with it. Nothing else can be touching them: a purged business fails authorization before any
 * fulfillment transaction starts, and fulfillment transactions never take this writer's advisory
 * lock, so no lock cycle is possible. Guarded so a database that predates 090 still saves.
 */
async function deletePurgedBusinessFulfillmentRows(
  client: PoolClient,
  businessIds: string[]
): Promise<void> {
  if (businessIds.length === 0) return;
  const exists = await client.query<{ present: boolean; corridors: boolean; manifests: boolean }>(
    `select to_regclass('public.fulfillment_vehicles') is not null as present,
            to_regclass('public.fulfillment_corridor_resolutions') is not null as corridors,
            to_regclass('public.fulfillment_manifests') is not null as manifests`
  );
  if (exists.rows[0]?.present !== true) return;
  const corridorTables = new Set([
    "fulfillment_corridor_resolutions",
    "fulfillment_orders",
    "fulfillment_corridor_geometry_versions",
    "fulfillment_corridors"
  ]);
  const manifestTables = new Set(["fulfillment_manifest_stops", "fulfillment_manifests"]);
  // Children before parents: stops reference manifests, orders, resolutions and shop locations;
  // manifests reference corridors, geometry versions and vehicles; resolutions reference orders,
  // corridors, geometry versions and shop locations; corridors may reference a policy lineage by
  // value only.
  for (const tableName of [
    "fulfillment_manifest_stops",
    "fulfillment_manifests",
    "fulfillment_corridor_resolutions",
    "fulfillment_orders",
    "fulfillment_corridor_geometry_versions",
    "fulfillment_corridors",
    "fulfillment_idempotency_records",
    "fulfillment_shop_locations",
    "fulfillment_business_settings",
    "fulfillment_dispatch_policies",
    "fulfillment_vehicles"
  ]) {
    // Databases migrated to 090 but not yet 091/092 have no corridor tables.
    if (corridorTables.has(tableName) && exists.rows[0]?.corridors !== true) continue;
    // Databases migrated to 092 but not yet 094 have no manifest tables.
    if (manifestTables.has(tableName) && exists.rows[0]?.manifests !== true) continue;
    await client.query(`delete from ${tableName} where business_id = any($1::uuid[])`, [
      businessIds
    ]);
  }
}

async function deleteRemovedAccountRelationalGraph(
  client: PoolClient,
  snapshot: Cp2Snapshot
): Promise<void> {
  const desiredAccountIds = snapshot.accounts.map((item) => item.id);
  const desiredUserIds = snapshot.users.map((item) => item.id);
  const desiredBusinessIds = snapshot.businesses.map((item) => item.id);
  const removedAccounts = await client.query<{ id: string }>(
    "select id from accounts where not (id = any($1::uuid[]))",
    [desiredAccountIds]
  );
  const removedUsers = await client.query<{ id: string }>(
    "select id from users where not (id = any($1::uuid[]))",
    [desiredUserIds]
  );
  const removedBusinesses = await client.query<{ id: string }>(
    "select id from businesses where not (id = any($1::uuid[]))",
    [desiredBusinessIds]
  );
  const accountIds = removedAccounts.rows.map((row) => row.id);
  const userIds = removedUsers.rows.map((row) => row.id);
  const businessIds = removedBusinesses.rows.map((row) => row.id);

  if (accountIds.length === 0 && userIds.length === 0 && businessIds.length === 0) return;

  await client.query(
    `
      delete from soko_session_contexts
      where conversation_id in (
        select id from conversations
        where account_id = any($1::uuid[]) or active_shop_id = any($2::uuid[])
      )
    `,
    [accountIds, businessIds]
  );
  await client.query(
    "delete from conversations where account_id = any($1::uuid[]) or active_shop_id = any($2::uuid[])",
    [accountIds, businessIds]
  );
  await client.query(
    "delete from conversation_participants where account_id = any($1::uuid[]) or business_id = any($2::uuid[])",
    [accountIds, businessIds]
  );
  await client.query(
    "delete from connected_channels where account_id = any($1::uuid[]) or business_id = any($2::uuid[])",
    [accountIds, businessIds]
  );
  await client.query(
    "delete from auth_audit_events where account_id = any($1::uuid[]) or user_id = any($2::uuid[])",
    [accountIds, userIds]
  );
  await client.query("delete from shop_deletion_archives where account_id = any($1::uuid[])", [
    accountIds
  ]);

  await client.query(
    `
      delete from document_import_rows
      where import_job_id in (select id from document_import_jobs where business_id = any($1::uuid[]))
    `,
    [businessIds]
  );
  for (const tableName of [
    "document_import_jobs",
    "document_import_sources",
    "offline_sync_queue",
    "offline_cache_snapshots",
    "invoice_number_counters"
  ]) {
    await client.query(`delete from ${tableName} where business_id = any($1::uuid[])`, [
      businessIds
    ]);
  }
  await client.query("delete from offline_sync_queue where actor_id = any($1::uuid[])", [userIds]);

  await client.query(
    `
      delete from sync_queue
      where event_id in (
        select id from business_events
        where actor_id = any($1::text[])
          or aggregate_id = any($2::text[])
          or payload->>'businessId' = any($3::text[])
          or payload->>'accountId' = any($4::text[])
          or payload->>'userId' = any($1::text[])
      )
    `,
    [userIds, [...userIds, ...businessIds, ...accountIds], businessIds, accountIds]
  );
  await client.query(
    `
      delete from business_events
      where actor_id = any($1::text[])
        or aggregate_id = any($2::text[])
        or payload->>'businessId' = any($3::text[])
        or payload->>'accountId' = any($4::text[])
        or payload->>'userId' = any($1::text[])
    `,
    [userIds, [...userIds, ...businessIds, ...accountIds], businessIds, accountIds]
  );

  await deletePurgedBusinessFulfillmentRows(client, businessIds);
  await client.query("delete from payments where business_id = any($1::uuid[])", [businessIds]);
  await client.query(
    "delete from invoice_items where invoice_id in (select id from invoices where business_id = any($1::uuid[]))",
    [businessIds]
  );
  await client.query("delete from invoices where business_id = any($1::uuid[])", [businessIds]);
  await client.query(
    "delete from receipt_line_items where receipt_id in (select id from purchase_receipts where business_id = any($1::uuid[]))",
    [businessIds]
  );
  for (const tableName of [
    "purchase_receipts",
    "receipt_ocr_jobs",
    "supplier_contact_links",
    "sales_agents",
    "suppliers",
    "inventory_movements",
    "products",
    "customers",
    "device_trust",
    "business_memberships"
  ]) {
    await client.query(`delete from ${tableName} where business_id = any($1::uuid[])`, [
      businessIds
    ]);
  }
  await client.query("delete from inventory_movements where actor_id = any($1::uuid[])", [userIds]);

  await client.query("delete from users where id = any($1::uuid[])", [userIds]);
  await client.query("delete from businesses where id = any($1::uuid[])", [businessIds]);
  await client.query("delete from accounts where id = any($1::uuid[])", [accountIds]);
  await client.query("delete from cp2_store_snapshots");
}

async function saveShopDeletionArchives(
  client: PoolClient,
  records: SnapshotRecord[]
): Promise<void> {
  const archived = records.filter((record) =>
    ["QUARANTINED", "RESTORED", "PURGED", "FAILED", "PARTIALLY_FAILED"].includes(
      requiredText(record, "status")
    )
  );

  for (const record of archived) {
    const status = requiredText(record, "status");
    await client.query(
      `
        insert into shop_deletion_archives (
          request_id, business_id, account_id, status, restore_until,
          archive_key, checksum, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, null, null, $6, $7)
        on conflict (request_id) do update set
          status = excluded.status,
          restore_until = excluded.restore_until,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "accountId"),
        status === "PARTIALLY_FAILED" ? "FAILED" : status,
        requiredText(record, "anonymizeAfter"),
        requiredText(record, "requestedAt"),
        firstText(record, ["completedAt"]) ?? requiredText(record, "requestedAt")
      ]
    );
  }
}

async function savePhase1AuthSecurityRecords(
  client: PoolClient,
  snapshot: Cp2Snapshot
): Promise<void> {
  await saveIdentityProviders(client, snapshot);

  for (const record of snapshotRecords(snapshot.otpChallenges)) {
    await client.query(
      `
        insert into otp_challenges (
          id, channel, destination, purpose, code_hash, attempts, max_attempts, expires_at,
          verified_at, consumed_at, resend_count, next_resend_at, provider, provider_message_id,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        on conflict (id) do update set
          channel = excluded.channel,
          destination = excluded.destination,
          purpose = excluded.purpose,
          code_hash = excluded.code_hash,
          attempts = excluded.attempts,
          max_attempts = excluded.max_attempts,
          expires_at = excluded.expires_at,
          verified_at = excluded.verified_at,
          consumed_at = excluded.consumed_at,
          resend_count = excluded.resend_count,
          next_resend_at = excluded.next_resend_at,
          provider = excluded.provider,
          provider_message_id = excluded.provider_message_id
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "channel"),
        requiredText(record, "destination"),
        firstText(record, ["purpose"]) ?? "signup",
        requiredText(record, "codeHash"),
        record.attempts ?? 0,
        record.maxAttempts ?? 5,
        requiredText(record, "expiresAt"),
        firstText(record, ["verifiedAt"]),
        firstText(record, ["consumedAt"]),
        record.resendCount ?? 0,
        firstText(record, ["nextResendAt"]),
        firstText(record, ["provider"]),
        firstText(record, ["providerMessageId"]),
        requiredText(record, "createdAt")
      ]
    );

    await client.query(
      `
        insert into verification_challenges (
          id, channel, destination, purpose, code_hash, attempts, max_attempts,
          status, expires_at, verified_at, consumed_at, resend_count, next_resend_at,
          provider, provider_message_id, created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          case
            when $9::timestamptz is not null then 'verified'
            when $10::timestamptz is not null then 'invalidated'
            when $8::timestamptz <= now() then 'expired'
            when $6::integer >= $7::integer then 'locked'
            else 'pending'
          end,
          $8, $9, $10, $11, $12, $13, $14, $15,
          coalesce($9::timestamptz, $10::timestamptz, $15::timestamptz)
        )
        on conflict (id) do update set
          channel = excluded.channel,
          destination = excluded.destination,
          purpose = excluded.purpose,
          code_hash = excluded.code_hash,
          attempts = excluded.attempts,
          max_attempts = excluded.max_attempts,
          status = excluded.status,
          expires_at = excluded.expires_at,
          verified_at = excluded.verified_at,
          consumed_at = excluded.consumed_at,
          resend_count = excluded.resend_count,
          next_resend_at = excluded.next_resend_at,
          provider = excluded.provider,
          provider_message_id = excluded.provider_message_id,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "channel"),
        requiredText(record, "destination"),
        firstText(record, ["purpose"]) ?? "signup",
        requiredText(record, "codeHash"),
        record.attempts ?? 0,
        record.maxAttempts ?? 5,
        requiredText(record, "expiresAt"),
        firstText(record, ["verifiedAt"]),
        firstText(record, ["consumedAt"]),
        record.resendCount ?? 0,
        firstText(record, ["nextResendAt"]),
        firstText(record, ["provider"]),
        firstText(record, ["providerMessageId"]),
        requiredText(record, "createdAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.smsDeliveryAttempts)) {
    await client.query(
      `
        insert into sms_delivery_attempts (
          id, challenge_id, provider, provider_message_id, status, error_code,
          attempt_number, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (id) do update set
          provider_message_id = excluded.provider_message_id,
          status = excluded.status,
          error_code = excluded.error_code,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "challengeId"),
        requiredText(record, "provider"),
        firstText(record, ["providerMessageId"]),
        requiredText(record, "status"),
        firstText(record, ["errorCode"]),
        record.attemptNumber ?? 1,
        requiredText(record, "createdAt"),
        requiredText(record, "updatedAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.userIdentities)) {
    await client.query(
      `
        insert into user_identities (
          id, account_id, user_id, provider_id, provider_subject, email, display_name,
          encrypted_access_token, encrypted_refresh_token, encrypted_id_token, token_type,
          token_expires_at, scope, linked_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        on conflict (id) do update set
          account_id = excluded.account_id,
          user_id = excluded.user_id,
          provider_id = excluded.provider_id,
          provider_subject = excluded.provider_subject,
          email = excluded.email,
          display_name = excluded.display_name,
          encrypted_access_token = excluded.encrypted_access_token,
          encrypted_refresh_token = excluded.encrypted_refresh_token,
          encrypted_id_token = excluded.encrypted_id_token,
          token_type = excluded.token_type,
          token_expires_at = excluded.token_expires_at,
          scope = excluded.scope,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "accountId"),
        requiredText(record, "userId"),
        requiredText(record, "provider"),
        requiredText(record, "providerSubject"),
        firstText(record, ["email"]),
        firstText(record, ["displayName"]),
        firstText(record, ["encryptedAccessToken"]),
        firstText(record, ["encryptedRefreshToken"]),
        firstText(record, ["encryptedIdToken"]),
        firstText(record, ["tokenType"]),
        firstText(record, ["tokenExpiresAt"]),
        firstText(record, ["scope"]),
        requiredText(record, "linkedAt"),
        firstText(record, ["updatedAt"]) ?? requiredText(record, "linkedAt")
      ]
    );

    await client.query(
      `
        insert into auth_accounts (
          id, account_id, user_id, provider_id, provider_subject, email, display_name,
          linked_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (id) do update set
          account_id = excluded.account_id,
          user_id = excluded.user_id,
          provider_id = excluded.provider_id,
          provider_subject = excluded.provider_subject,
          email = excluded.email,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "accountId"),
        requiredText(record, "userId"),
        requiredText(record, "provider"),
        requiredText(record, "providerSubject"),
        firstText(record, ["email"]),
        firstText(record, ["displayName"]),
        requiredText(record, "linkedAt"),
        firstText(record, ["updatedAt"]) ?? requiredText(record, "linkedAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.oauthSessions)) {
    await client.query(
      `
        insert into oauth_sessions (
          id, provider_id, account_id, state_hash, csrf_hash, code_challenge,
          encrypted_code_verifier, redirect_uri, expires_at, completed_at, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (id) do update set
          provider_id = excluded.provider_id,
          account_id = excluded.account_id,
          state_hash = excluded.state_hash,
          csrf_hash = excluded.csrf_hash,
          code_challenge = excluded.code_challenge,
          encrypted_code_verifier = excluded.encrypted_code_verifier,
          redirect_uri = excluded.redirect_uri,
          expires_at = excluded.expires_at,
          completed_at = excluded.completed_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "provider"),
        firstText(record, ["accountId"]),
        firstText(record, ["stateHash"]) ?? "",
        firstText(record, ["csrfHash"]) ?? "",
        firstText(record, ["codeChallenge"]) ?? "",
        firstText(record, ["codeVerifier", "encryptedCodeVerifier"]) ?? "",
        firstText(record, ["redirectUri"]) ?? "",
        requiredText(record, "expiresAt"),
        firstText(record, ["completedAt"]),
        requiredText(record, "createdAt")
      ]
    );
  }

  for (const record of snapshotRecords(snapshot.accountPinHashes)) {
    await client.query(
      `
        insert into account_pin_hashes (account_id, pin_hash, updated_at)
        values ($1, $2, now())
        on conflict (account_id) do update set
          pin_hash = excluded.pin_hash,
          updated_at = now()
      `,
      [requiredText(record, "accountId"), requiredText(record, "pinHash")]
    );
  }

  for (const record of snapshotRecords(snapshot.deviceTrust)) {
    const updatedBy = requiredText(record, "updatedBy");
    const updatedByType = updatedBy === "system" || updatedBy === "service" ? updatedBy : "user";

    await client.query(
      `
        insert into device_trust (
          business_id, user_id, device_id, level, reason,
          updated_by, updated_by_type, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (business_id, user_id, device_id) do update set
          level = excluded.level,
          reason = excluded.reason,
          updated_by = excluded.updated_by,
          updated_by_type = excluded.updated_by_type,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "businessId"),
        requiredText(record, "userId"),
        requiredText(record, "deviceId"),
        requiredText(record, "level"),
        firstText(record, ["reason"]),
        updatedByType === "user" ? updatedBy : null,
        updatedByType,
        requiredText(record, "updatedAt")
      ]
    );
  }
}

async function saveIdentityProviders(client: PoolClient, snapshot: Cp2Snapshot): Promise<void> {
  const providerIds = new Set<string>();

  for (const record of snapshotRecords(snapshot.userIdentities)) {
    const provider = firstText(record, ["provider"]);

    if (provider !== null) {
      providerIds.add(provider);
    }
  }

  for (const record of snapshotRecords(snapshot.oauthSessions)) {
    const provider = firstText(record, ["provider"]);

    if (provider !== null) {
      providerIds.add(provider);
    }
  }

  for (const providerId of providerIds) {
    await client.query(
      `
        insert into identity_providers (
          id, display_name, authorization_url, token_url, user_info_url, scopes, pkce, created_at
        )
        values ($1, $1, '', '', null, '[]'::jsonb, true, now())
        on conflict (id) do nothing
      `,
      [providerId]
    );
  }
}

async function replaceReceiptLineItems(
  client: PoolClient,
  records: SnapshotRecord[]
): Promise<void> {
  const receiptIds = [...new Set(records.map((record) => requiredText(record, "receiptId")))];

  if (receiptIds.length > 0) {
    await client.query("delete from receipt_line_items where receipt_id = any($1::uuid[])", [
      receiptIds
    ]);
  }

  for (const record of records) {
    await client.query(
      `
        insert into receipt_line_items (id, receipt_id, name, quantity, unit_price, total)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (id) do update set
          receipt_id = excluded.receipt_id,
          name = excluded.name,
          quantity = excluded.quantity,
          unit_price = excluded.unit_price,
          total = excluded.total
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "receiptId"),
        requiredText(record, "name"),
        record.quantity,
        record.unitPrice,
        record.total
      ]
    );
  }
}

async function deleteMissingRows(
  client: PoolClient,
  tableName: string,
  records: SnapshotRecord[]
): Promise<void> {
  const ids = records.map((record) => requiredText(record, "id"));

  await client.query(`delete from ${tableName} where not (id = any($1::uuid[]))`, [ids]);
}

async function deleteMissingAccountPinHashes(
  client: PoolClient,
  records: SnapshotRecord[]
): Promise<void> {
  const accountIds = records.map((record) => requiredText(record, "accountId"));

  await client.query("delete from account_pin_hashes where not (account_id = any($1::uuid[]))", [
    accountIds
  ]);
}

async function deleteMissingDeviceTrustRows(
  client: PoolClient,
  records: SnapshotRecord[]
): Promise<void> {
  const keys = records.map((record) =>
    [
      requiredText(record, "businessId"),
      requiredText(record, "userId"),
      requiredText(record, "deviceId")
    ].join(":")
  );

  await client.query(
    `
      delete from device_trust
      where not ((business_id::text || ':' || user_id::text || ':' || device_id) = any($1::text[]))
    `,
    [keys]
  );
}

async function deleteMissingInvoiceRows(
  client: PoolClient,
  records: SnapshotRecord[]
): Promise<void> {
  const invoiceIds = records.map((record) => requiredText(record, "id"));

  await client.query("delete from invoice_items where not (invoice_id = any($1::uuid[]))", [
    invoiceIds
  ]);
  await client.query("delete from invoices where not (id = any($1::uuid[]))", [invoiceIds]);
}

async function saveInvoicesAndItems(client: PoolClient, records: SnapshotRecord[]): Promise<void> {
  const invoiceIds = records.map((record) => requiredText(record, "id"));

  for (const record of records) {
    await client.query(
      `
        insert into invoices (
          id, business_id, invoice_number, status, customer_id, customer_name,
          subtotal, tax_rate, tax_total, total, confirmed_at, created_at, updated_at,
          source, source_message_channel, created_by_user_id
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        on conflict (id) do update set
          source = excluded.source,
          source_message_channel = excluded.source_message_channel,
          created_by_user_id = excluded.created_by_user_id,
          status = excluded.status,
          customer_id = excluded.customer_id,
          customer_name = excluded.customer_name,
          subtotal = excluded.subtotal,
          tax_rate = excluded.tax_rate,
          tax_total = excluded.tax_total,
          total = excluded.total,
          confirmed_at = excluded.confirmed_at,
          updated_at = excluded.updated_at
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "businessId"),
        requiredText(record, "invoiceNumber"),
        requiredText(record, "status"),
        firstText(record, ["customerId"]),
        firstText(record, ["customerName"]),
        record.subtotal,
        record.taxRate,
        record.taxTotal,
        record.total,
        firstText(record, ["confirmedAt"]),
        requiredText(record, "createdAt"),
        requiredText(record, "updatedAt"),
        firstText(record, ["source"]),
        firstText(record, ["sourceMessageChannel"]),
        firstText(record, ["createdByUserId"])
      ]
    );
  }

  if (invoiceIds.length > 0) {
    await client.query("delete from invoice_items where invoice_id = any($1::uuid[])", [
      invoiceIds
    ]);
  }

  for (const invoice of records) {
    const items = Array.isArray(invoice.items) ? (invoice.items as SnapshotRecord[]) : [];

    for (const item of items) {
      await client.query(
        `
          insert into invoice_items
            (id, invoice_id, product_id, product_name, quantity, unit_price, line_total,
             unit_weight_grams_snapshot, total_weight_grams, weight_status, weight_unresolved_reason)
          values ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10, $11)
          on conflict (id) do update set
            invoice_id = excluded.invoice_id,
            product_id = excluded.product_id,
            product_name = excluded.product_name,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            line_total = excluded.line_total,
            unit_weight_grams_snapshot = excluded.unit_weight_grams_snapshot,
            total_weight_grams = excluded.total_weight_grams,
            weight_status = excluded.weight_status,
            weight_unresolved_reason = excluded.weight_unresolved_reason
        `,
        [
          requiredText(item, "id"),
          requiredText(item, "invoiceId"),
          requiredText(item, "productId"),
          requiredText(item, "productName"),
          item.quantity,
          item.unitPrice,
          item.lineTotal,
          firstText(item, ["unitWeightGramsSnapshot"]),
          firstText(item, ["totalWeightGrams"]),
          firstText(item, ["weightStatus"]),
          firstText(item, ["weightUnresolvedReason"])
        ]
      );
    }
  }
}

function emptySnapshot(): Cp2Snapshot {
  return {
    accounts: [],
    users: [],
    businesses: [],
    sokoIdHistory: [],
    memberships: [],
    sessionContexts: [],
    conversations: [],
    conversationParticipants: [],
    conversationMessages: [],
    conversationAttachments: [],
    platformIdentities: [],
    conversationChannels: [],
    providerUpdateReceipts: [],
    channelIdentityLinkGrants: [],
    nativeSmsDevices: [],
    nativeSmsDeviceCommands: [],
    connectedMailboxes: [],
    connectedMailboxOAuthSessions: [],
    customerRuntimeCapabilities: [],
    messageDeliveryAttempts: [],
    messageNotificationDeliveries: [],
    e2eeDevices: [],
    pushSubscriptions: [],
    marketplaceIntroStates: [],
    activeAiModels: [],
    agentProfiles: [],
    agentRuntimeVersions: [],
    agentContextSources: [],
    agentEvaluationEvents: [],
    agentOwnerCorrections: [],
    runtimeExperiences: [],
    installedAgentModels: [],
    modelTemplates: [],
    modelTemplateVersions: [],
    expertiseArtifacts: [],
    evaluationSuites: [],
    evaluationCases: [],
    evaluationRuns: [],
    evaluationResults: [],
    productionObservations: [],
    expertCorrections: [],
    datasetVersions: [],
    datasetExamples: [],
    improvementRuns: [],
    templatePromotions: [],
    templateRuntimeBindings: [],
    nativeRuntimeAgents: [],
    nativeRuntimeModels: [],
    nativeExecutionHosts: [],
    nativeModelInstallations: [],
    nativeRuntimeBindings: [],
    nativeRuntimeBindingModels: [],
    modelCatalog: [],
    agentCatalog: [],
    platformOperators: [],
    syncChanges: [],
    mcpAccessTokens: [],
    productFieldSchemas: [],
    products: [],
    productMedia: [],
    productCaptureJobs: [],
    statusBroadcasts: [],
    buyOrders: [],
    statusOrders: [],
    unifiedCheckouts: [],
    customers: [],
    suppliers: [],
    salesAgents: [],
    supplierContactLinks: [],
    purchaseReceipts: [],
    receiptLineItems: [],
    receiptOCRJobs: [],
    invoices: [],
    payments: [],
    logistics: [],
    contacts: [],
    supplierContactRelationships: [],
    purchasePriceHistory: [],
    purchaseRecords: [],
    saleRecords: [],
    locations: [],
    deliveryRoutes: [],
    deliveryRouteStops: [],
    dataExports: [],
    accountDeletionRequests: [],
    accountDeletionProofs: [],
    shopPresences: [],
    networkInvites: [],
    staffInvitations: [],
    publicCustomerCareRequests: [],
    publicStorefrontMessages: [],
    publicOrders: [],
    verificationTiers: [],
    taxConfigs: [],
    deviceTrust: [],
    betaAccess: [],
    betaFeatureFlags: [],
    betaDeviceTests: [],
    betaSupportTickets: [],
    betaTelemetryEvents: [],
    launchSettings: [],
    launchChecklist: [],
    launchIncidents: [],
    documentImports: [],
    documentImportSources: [],
    notifications: [],
    runtimeSessions: [],
    runtimeTurns: [],
    inventoryMovements: [],
    syncQueue: [],
    otpChallenges: [],
    smsDeliveryAttempts: [],
    sessions: [],
    passkeys: [],
    passkeyCeremonies: [],
    accountIdentities: [],
    passwordCredentials: [],
    authTransactions: [],
    mfaFactors: [],
    recoveryCodes: [],
    userIdentities: [],
    oauthSessions: [],
    accountPinHashes: [],
    networkNodes: [],
    networkEdges: [],
    networkSources: [],
    networkPermissions: [],
    networkRoutes: [],
    contactHashes: [],
    externalIdentities: [],
    sokoIdentityLinks: [],
    identityCandidates: [],
    networkConnections: [],
    discoveryBudgets: [],
    externalRegistryConnections: [],
    auditEvents: []
  };
}

function snapshotHasData(snapshot: Cp2Snapshot): boolean {
  return normalizedCollections.some(
    (collection) => getSnapshotCollection(snapshot, collection.key).length > 0
  );
}

function getSnapshotCollection(
  snapshot: Cp2Snapshot,
  key: SnapshotCollectionKey
): SnapshotRecord[] {
  return snapshot[key] as unknown as SnapshotRecord[];
}

function setSnapshotCollection(
  snapshot: Cp2Snapshot,
  key: SnapshotCollectionKey,
  records: SnapshotRecord[]
): void {
  const target = snapshot as unknown as Record<string, SnapshotRecord[]>;
  target[key] = records;
}

function snapshotRecords(value: unknown): SnapshotRecord[] {
  return value as SnapshotRecord[];
}

function recordEntityId(key: SnapshotCollectionKey, record: SnapshotRecord): string {
  if (key === "sessionContexts") {
    const accountId = firstText(record, ["accountId"]) ?? requiredText(record, "sessionId");
    const conversationId = firstText(record, ["conversationId"]);
    // Composite so each conversation's context persists as its own row instead of overwriting
    // its account's other conversations' rows on upsert. See docs/frontend/frontend.md Phase 2.
    return conversationId === null ? accountId : `${accountId}:${conversationId}`;
  }

  if (key === "runtimeTaskHeads" || key === "runtimeTaskInstances") {
    return requiredText(record, "taskId");
  }

  if (key === "computerSessions") {
    const session = record.session as Record<string, unknown> | undefined;
    return requiredText(session ?? {}, "id");
  }

  if (key === "accountPinHashes") {
    return requiredText(record, "accountId");
  }

  if (key === "passwordCredentials") {
    return requiredText(record, "accountId");
  }

  if (key === "accountDeletionProofs") {
    return requiredText(record, "requestId");
  }

  if (key === "marketplaceIntroStates") {
    return [
      requiredText(record, "accountId"),
      firstText(record, ["businessId"]) ?? "marketplace"
    ].join(":");
  }

  if (key === "activeAiModels" || key === "agentProfiles" || key === "productFieldSchemas") {
    return requiredText(record, "businessId");
  }

  if (
    key === "agentRuntimeVersions" ||
    key === "agentContextSources" ||
    key === "agentEvaluationEvents" ||
    key === "agentOwnerCorrections" ||
    key === "runtimeExperiences"
  ) {
    return requiredText(record, "id");
  }

  if (
    key === "verificationTiers" ||
    key === "taxConfigs" ||
    key === "betaAccess" ||
    key === "shopPresences"
  ) {
    return requiredText(record, "businessId");
  }

  if (key === "launchSettings") {
    return requiredText(record, "businessId");
  }

  if (key === "betaFeatureFlags" || key === "launchChecklist") {
    return [requiredText(record, "businessId"), requiredText(record, "key")].join(":");
  }

  if (key === "deviceTrust") {
    return [
      requiredText(record, "businessId"),
      requiredText(record, "userId"),
      requiredText(record, "deviceId")
    ].join(":");
  }

  return requiredText(record, "id");
}

function recordParentId(key: SnapshotCollectionKey, record: SnapshotRecord): string | null {
  const modelTemplateParents: Partial<Record<SnapshotCollectionKey, string>> = {
    modelTemplateVersions: "templateId",
    expertiseArtifacts: "templateVersionId",
    evaluationSuites: "templateId",
    evaluationCases: "suiteId",
    evaluationRuns: "suiteId",
    evaluationResults: "evaluationRunId",
    productionObservations: "templateVersionId",
    expertCorrections: "observationId",
    datasetVersions: "templateId",
    datasetExamples: "datasetVersionId",
    improvementRuns: "templateVersionId",
    templatePromotions: "candidateVersionId",
    templateRuntimeBindings: "templateVersionId"
  };
  const modelTemplateParent = modelTemplateParents[key];
  if (modelTemplateParent !== undefined) return firstText(record, [modelTemplateParent]);
  return firstText(record, [
    "invoiceId",
    "importJobId",
    "sourceId",
    "eventId",
    "permissionId",
    // runtimeBindingId must win over executionHostId: a native runtime binding-model role
    // carries both fields, but its parent_id foreign key points at the binding.
    "runtimeBindingId",
    "executionHostId",
    "agentId"
  ]);
}

function requiredText(record: SnapshotRecord, field: string): string {
  const value = record[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`CP2 normalized record is missing required text field ${field}.`);
  }

  return value;
}

function firstText(record: SnapshotRecord, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];

    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return null;
}

async function timedQuery<T extends QueryResultRow>(
  pool: Pool,
  operation: string,
  sql: string,
  values?: unknown[]
): Promise<{ rows: T[] }> {
  const startedAt = Date.now();

  try {
    return await pool.query<T>(sql, values);
  } finally {
    logSlowQuery(operation, startedAt);
  }
}

function logSlowQuery(operation: string, startedAt: number): void {
  const elapsedMs = Date.now() - startedAt;
  const thresholdMs = positiveIntegerFromEnv("DB_SLOW_QUERY_MS", 500);

  if (elapsedMs >= thresholdMs) {
    console.warn(`[db] slow operation "${operation}" took ${elapsedMs}ms`);
  }
}

function timestampToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberFromDatabase(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function nullableNumberFromDatabase(value: string | number | null): number | null {
  return value === null ? null : numberFromDatabase(value);
}

function phase1Parity(
  collection: string,
  relationalCountValue: string,
  compatibilityCountValue: string,
  relationalChecksum: string,
  compatibilityChecksum: string
): PostgresStoreHealth["phase1Parity"][number] {
  const relationalCount = Number(relationalCountValue);
  const compatibilityCount = Number(compatibilityCountValue);

  return {
    collection,
    relationalCount,
    compatibilityCount,
    relationalChecksum,
    compatibilityChecksum,
    ok: relationalCount === compatibilityCount && relationalChecksum === compatibilityChecksum
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
