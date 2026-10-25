import type {
  ReceiptStructuredExtractionSummary,
  ReceiptContactMatchingResultSummary
} from "@grogoni/shared-types";
import { restoreReceiptJobFields } from "./domains/suppliers/receipt-fields.js";
import { randomUUID } from "node:crypto";
import type { Metrics } from "@grogoni/observability";
import {
  ACCOUNT_SYNC_COLLECTIONS,
  isAccountSyncCollection,
  type AccountSyncCollection,
  type SyncRealtimeChangesAvailableEvent
} from "@grogoni/shared-types";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { positiveIntegerFromEnv } from "@grogoni/resource-control";
import { buildPgPoolConfig } from "../db-pool-config.js";
import { createPostgresRuntimeApprovalStore } from "./domains/agent-runtime/runtime-approval-store.js";
import { guardPgPoolErrors } from "../pg-pool-errors.js";
import { createPostgresInventoryProcurementStore } from "./domains/agent-runtime/inventory-procurement-store.js";
import { createBusinessTaskEvaluationReader } from "./domains/agent-runtime/business-task-evaluation-reader.js";
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
} from "@grogoni/shared-types";
import type { ConversationAttachmentRecord } from "./workspace-file-delivery.js";
import {
  retainedRuntimeCheckpointSql,
  runtimeCheckpointPruneBatch
} from "./domains/runtime-handoff/checkpoint-retention.js";
import {
  runtimeOperationDedupCutoffSql,
  runtimeOperationDedupPruneBatch
} from "./domains/runtime-handoff/operation-dedup-retention.js";

type SnapshotCollectionKey = keyof Cp2Snapshot;
type SnapshotRecord = Record<string, unknown>;

interface NormalizedCollection {
  key: SnapshotCollectionKey;
  tableName: string;
}

export const normalizedCollections: NormalizedCollection[] = [
  { key: "agentSkills", tableName: "cp2_agent_skills" },
  { key: "accounts", tableName: "cp2_accounts" },
  { key: "users", tableName: "cp2_users" },
  { key: "deviceAccountBootstraps", tableName: "cp2_device_account_bootstraps" },
  { key: "deviceRecoveryCredentials", tableName: "cp2_device_recovery_credentials" },
  { key: "businesses", tableName: "cp2_businesses" },
  { key: "grogoniIdHistory", tableName: "cp2_grogoni_id_history" },
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
  { key: "buyerShoppingSessions", tableName: "buyer_shopping_sessions" },
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
  { key: "grogoniIdentityLinks", tableName: "cp2_grogoni_identity_links" },
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
  "draftAgentSkill",
  "generateAgentSkill",
  "updateAgentSkill",
  "transitionAgentSkill",
  "publishAgentSkill",
  "installPublicAgentSkill",
  "createBuyerShoppingTurn",
  "createUnifiedCheckout",
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
  "beginEmailMfa",
  "challengePinLoginMfa",
  "recoverPasswordWithPasskey",
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
  "addConversationParticipant",
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
  "recordVerifiedBusinessTaskExperience",
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
  "getGrogoniSessionContext",
  "linkSalesAgentContact",
  "linkSupplierContact",
  "linkCustomerAccount",
  "listCustomerChannelEndpoints",
  "loginWithAccountPin",
  "loginWithGrogoniIdPin",
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
  "updateNetworkPrivacy",
  "blockNetworkContact",
  "requestNetworkConnection",
  "respondToNetworkConnection",
  "removeNetworkConnection",
  "syncSocialNetwork",
  "syncShopSystemCatalogue",
  "setConversationTyping",
  "updateBetaAccess",
  "updateGrogoniSessionContext",
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
// Without 106 the session retention trigger revokes refreshable sessions, signing users out on
// every restart, so the API refuses to boot until it is applied.
const requiredSessionRetentionMigrationFilename = "106_session_retention_uses_refresh_lifetime.sql";
const realtimeChannel = "grogoni_sync_changes";
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
  const poolConfig = buildPgPoolConfig(options.databaseUrl);
  const pool = new Pool(poolConfig);
  options.metrics?.instrumentPgPool(pool, { poolName: "cp2_primary" });
  guardPgPoolErrors(pool, (error) => {
    console.error("Unexpected PostgreSQL pool error.", error);
  });
  const realtimePool = new Pool(buildPgPoolConfig(options.databaseUrl, { max: 1 }));
  options.metrics?.instrumentPgPool(realtimePool, { poolName: "cp2_realtime" });
  guardPgPoolErrors(realtimePool, (error) => {
    console.error("Unexpected PostgreSQL realtime pool error.", error);
  });
  // Boot reads run on their own short-lived pool, warmed up front and closed right after the
  // snapshot loads, so concurrent loading never leaves extra idle connections behind on the
  // long-lived pool (several stores booting together would otherwise exhaust max_connections).
  const bootPool = new Pool(poolConfig);
  guardPgPoolErrors(bootPool, (error) => {
    console.error("Unexpected PostgreSQL boot pool error.", error);
  });
  warmPool(bootPool, poolConfig.max ?? 1);
  warmPool(realtimePool, 1);
  const endBootPool = () => bootPool.end().catch(() => undefined);
  const endPools = () =>
    Promise.all([pool.end(), realtimePool.end(), endBootPool()]).catch(() => undefined);
  let store: Cp2Store;
  let savedSnapshot: Cp2Snapshot;
  let initialSyncPersistenceError: AccountSyncPersistenceError | null = null;

  try {
    await assertDatabaseMigrated(bootPool);
    // Every store option the caller injects is forwarded. This used to be a hand-maintained
    // whitelist that silently dropped options added later (the messaging channel gateway,
    // connected-mailbox client, workspace settings, the configured platform default runtime and
    // the local Ollama model catalog), so a Postgres-backed API ran without them.
    const { databaseUrl: _databaseUrl, metrics: _metrics, ...storeOptions } = options;
    void _databaseUrl;
    void _metrics;
    store = createCp2Store({
      ...storeOptions,
      businessTaskEvaluations:
        options.businessTaskEvaluations ??
        createBusinessTaskEvaluationReader(pool, (input) =>
          store.authorizeBusinessPermission(input)
        ),
      inventoryProcurement:
        options.inventoryProcurement ??
        createPostgresInventoryProcurementStore(
          pool,
          (input) => store.authorizeBusinessPermission(input),
          {
            check: (actor, input) => store.purchaseOrderDelivery().check(actor, input),
            send: (actor, input, order) => store.purchaseOrderDelivery().send(actor, input, order)
          }
        ),
      runtimeApprovalStore:
        options.runtimeApprovalStore ?? createPostgresRuntimeApprovalStore(pool),
      conversationAttachmentBlobStore:
        options.conversationAttachmentBlobStore ?? createPostgresAttachmentBlobStore(pool),
      accountAiAssetStore: options.accountAiAssetStore ?? createPostgresAccountAiAssetStore(pool)
    });
    savedSnapshot = await loadNormalizedSnapshot(bootPool);
  } catch (error) {
    await endPools();
    throw error;
  }
  await endBootPool();

  // Saves write only records that differ from lastPersistedSnapshot, so the baseline must be what
  // the database holds: the snapshot as loaded, cloned before hydrateSnapshot can repair or share
  // its records. Anything hydration changes is then written by the first save (2 of ~25k records
  // against the Neon data), instead of silently staying out of the database.
  let lastPersistedSnapshot = structuredClone(savedSnapshot);
  const initialForcedRemovalChecks = new Set<string>();
  try {
    if (snapshotHasData(savedSnapshot)) {
      store.hydrateSnapshot(savedSnapshot);
      if (savedSnapshot.syncChanges.length === 0 && store.snapshot().syncChanges.length > 0) {
        const bootSnapshot = structuredClone(store.snapshot());
        const result = await saveNormalizedSnapshot(pool, bootSnapshot, lastPersistedSnapshot);
        initialSyncPersistenceError = result.syncJournalError;
        const previousBaseline = lastPersistedSnapshot;
        lastPersistedSnapshot = bootSnapshot;
        // A failed journal backfill keeps the (empty) journal baseline so the next save retries it.
        if (result.syncJournalError !== null) {
          const shrunk = baselineAfterFailedSave(previousBaseline, bootSnapshot, ["syncChanges"]);
          lastPersistedSnapshot.syncChanges = shrunk.baseline.syncChanges;
          for (const key of shrunk.forcedRemovalChecks) initialForcedRemovalChecks.add(key);
        }
      }
    }
  } catch (error) {
    await endPools();
    throw error;
  }

  let saveQueue: Promise<void> = Promise.resolve();
  // Collections whose delete pass must run on the next save even if they look unchanged (see
  // baselineAfterFailedSave).
  let forcedRemovalChecks = new Set<string>(initialForcedRemovalChecks);
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
    scheduleSaveRetry();
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
    let released = false;
    const releaseClient = (destroy = false) => {
      if (client === null || released) return;
      released = true;
      client.release(destroy);
    };
    try {
      client = await realtimePool.connect();
      const connectedClient = client;
      // A fatal server error can be followed by a socket error. Keep a listener for both,
      // including during LISTEN setup, but discard the checked-out client only once.
      connectedClient.on("error", (error) => {
        lastRealtimeListenerError = error;
        if (realtimeClient === connectedClient) realtimeClient = null;
        releaseClient(true);
        scheduleRealtimeReconnect();
      });
      await connectedClient.query(`listen ${realtimeChannel}`);
      if (released) return;
      if (realtimeClosed) {
        releaseClient();
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
    } catch (error) {
      lastRealtimeListenerError = error;
      releaseClient(true);
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
          // Only a snapshot save writes everything (passkey ceremonies included), so only its
          // success proves an earlier failure is repaired. A passkey ceremony write that succeeds
          // after a failed snapshot must not clear that failure: flush() and close() rely on it.
          if (name !== "snapshot") return;
          lastPersistenceError = null;
          // A journal failure resolves the operation but schedules its own retry; keep backing off.
          if (lastSyncPersistenceError === null) {
            persistenceRetryDelayMs = persistenceRetryInitialDelayMs;
          }
        },
        (error: unknown) => {
          lastPersistenceError = error;
          if ((error as { code?: unknown } | null)?.code === "55P03")
            void logStoreLockHolders(pool);
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
                error instanceof AccountSyncPersistenceError ? error.constraintName : null,
              operation: name,
              error: error instanceof Error ? error.message : String(error),
              errorCode: (error as { code?: unknown } | null)?.code ?? null,
              stack: error instanceof Error ? error.stack : undefined
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
        // store.snapshot() copies the arrays but shares record objects the store mutates in place
        // (session revocation, OTP attempts, token lastUsedAt). Clone before writing: a baseline
        // cloned after the awaited save could include an in-place change made mid-save that was
        // never written, and the diff would then skip that record (e.g. a logout lost on restart).
        const snapshot = structuredClone(store.snapshot());
        const journalDeleteCheckPending = forcedRemovalChecks.has("syncChanges");
        let result: Awaited<ReturnType<typeof saveNormalizedSnapshot>>;
        try {
          result = await saveNormalizedSnapshot(
            pool,
            snapshot,
            lastPersistedSnapshot,
            forcedRemovalChecks
          );
        } catch (error) {
          // The commit may have landed even though this failed (lost acknowledgement): stop
          // trusting the baseline for anything the attempt touched.
          const shrunk = baselineAfterFailedSave(lastPersistedSnapshot, snapshot);
          lastPersistedSnapshot = shrunk.baseline;
          for (const key of shrunk.forcedRemovalChecks) forcedRemovalChecks.add(key);
          throw error;
        }
        const previousBaseline = lastPersistedSnapshot;
        lastPersistedSnapshot = snapshot;
        lastSyncPersistenceError = result.syncJournalError;
        forcedRemovalChecks = new Set();
        if (result.syncJournalError !== null) {
          // The relational transaction committed but the journal did not: keep the journal's last
          // saved baseline, shrunk like a failed save, so the next save re-sends every entry this
          // one failed (or may have failed) to write.
          const shrunk = baselineAfterFailedSave(previousBaseline, snapshot, ["syncChanges"]);
          lastPersistedSnapshot.syncChanges = shrunk.baseline.syncChanges;
          forcedRemovalChecks = shrunk.forcedRemovalChecks;
          // A journal delete check this save was carrying is still owed: its transaction rolled back.
          if (journalDeleteCheckPending) forcedRemovalChecks.add("syncChanges");
          logAccountSyncDegradation(result.syncJournalError);
          // Through the pooler the relational transaction can run on a backend holding a leaked
          // lock (re-entrant) while the journal transaction lands elsewhere and times out.
          if ((result.syncJournalError.cause as { code?: unknown } | undefined)?.code === "55P03") {
            void logStoreLockHolders(pool);
          }
          // Without a retry the missed entries would wait for an unrelated mutation, and a restart
          // before then loses them (boot only backfills an empty journal).
          scheduleSaveRetry();
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

  let closePromise: Promise<void> | null = null;
  const finalSaveAttempts = 2;
  const saveFailed = () => lastPersistenceError !== null || lastSyncPersistenceError !== null;

  function close(): Promise<void> {
    closePromise ??= closeOnce();
    return closePromise;
  }

  async function closeOnce(): Promise<void> {
    closing = true;
    const retryWasPending = persistenceRetryTimer !== null;
    if (persistenceRetryTimer !== null) {
      clearTimeout(persistenceRetryTimer);
      persistenceRetryTimer = null;
    }
    if (parityCheckTimer !== null) {
      clearInterval(parityCheckTimer);
      parityCheckTimer = null;
    }
    try {
      // Once closing, failed saves no longer schedule retries, and changed-only writes re-send
      // missed records only from the in-memory baseline that a restart loses (boot backfills only
      // an empty journal). So after the queue drains (including a save in flight at shutdown),
      // anything recorded as unsaved gets up to two final attempts; if it is still unsaved, close()
      // rejects so the process does not exit cleanly over lost data. A cancelled retry timer also
      // earns one attempt, as a backstop in case a failure was not recorded.
      if (retryWasPending) enqueueSave();
      await flush().catch(() => undefined);
      for (let attempt = 0; attempt < finalSaveAttempts && saveFailed(); attempt += 1) {
        enqueueSave();
        await flush().catch(() => undefined);
      }
      if (lastPersistenceError !== null) throw lastPersistenceError;
      if (lastSyncPersistenceError !== null) throw lastSyncPersistenceError;
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
            from grogoni_schema_migrations
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
        where table_schema = 'public' and table_name = 'grogoni_schema_migrations'
      ) as exists
    `
  );

  if (tableResult.rows[0]?.exists !== true) {
    throw new Error(
      `Database migrations are not initialized. Run "pnpm db:migrate" before starting the API. Missing ${requiredMigrationFilename}.`
    );
  }

  const result = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from grogoni_schema_migrations where filename = $1) as applied",
    [requiredMigrationFilename]
  );

  if (result.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredMigrationFilename}.`
    );
  }

  const attachmentBlobMigration = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from grogoni_schema_migrations where filename = $1) as applied",
    [requiredAttachmentBlobMigrationFilename]
  );
  if (attachmentBlobMigration.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredAttachmentBlobMigrationFilename}.`
    );
  }

  const accountAiAssetsMigration = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from grogoni_schema_migrations where filename = $1) as applied",
    [requiredAccountAiAssetsMigrationFilename]
  );
  if (accountAiAssetsMigration.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredAccountAiAssetsMigrationFilename}.`
    );
  }

  const sessionRetentionMigration = await pool.query<{ applied: boolean }>(
    "select exists(select 1 from grogoni_schema_migrations where filename = $1) as applied",
    [requiredSessionRetentionMigrationFilename]
  );
  if (sessionRetentionMigration.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${requiredSessionRetentionMigrationFilename}.`
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

/**
 * Opens `connections` connections at once and returns them to the pool idle. Each new connection
 * to a remote database costs several round trips (TCP, TLS, auth), ~2s against Neon from far
 * away, so warming them concurrently at boot overlaps that cost with the migration check instead
 * of paying it serially as the snapshot loaders first need connections. Never rejects: a failed
 * warm-up only means the real query connects, and reports any error, itself.
 */
function warmPool(pool: Pool, connections: number): void {
  for (let index = 0; index < connections; index += 1) {
    void pool.connect().then(
      (client) => client.release(),
      () => undefined
    );
  }
}

const edgeNormalizedBaselines = new WeakMap<
  Cp2Snapshot,
  Map<SnapshotCollectionKey, SnapshotRecord[]>
>();

async function loadNormalizedSnapshot(
  pool: Pool,
  predicate?: (key: SnapshotCollectionKey) => string
): Promise<Cp2Snapshot> {
  const snapshot = emptySnapshot();
  const result = await timedQuery<{ collection_index: number; records: SnapshotRecord[] }>(
    pool,
    "load normalized collections",
    buildNormalizedSnapshotSql(normalizedCollections, predicate)
  );
  for (const row of result.rows) {
    const collection = normalizedCollections[row.collection_index];
    if (collection === undefined) {
      throw new Error(
        `Normalized snapshot returned unknown collection index ${row.collection_index}.`
      );
    }
    setSnapshotCollection(snapshot, collection.key, row.records);
  }

  if (predicate)
    edgeNormalizedBaselines.set(
      snapshot,
      new Map(
        normalizedCollections.map(({ key }) => [
          key,
          structuredClone(getSnapshotCollection(snapshot, key))
        ])
      )
    );
  await loadRelationalCoreSnapshot(pool, snapshot);

  return snapshot;
}

/** The caller owns BEGIN/COMMIT and the appropriate store or tenant locks. */
export async function loadTransactionalCp2Snapshot(
  client: PoolClient,
  scope?: {
    withClause: string;
    predicate: (key: SnapshotCollectionKey) => string;
  }
): Promise<Cp2Snapshot> {
  // Concurrent loaders share one transaction connection. Batch their parameter-free
  // SELECTs so a remote database does not serialize dozens of network round trips.
  let queued: {
    sql: string;
    resolve: (result: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const reader = {
    query(sql: string, values?: unknown[]) {
      if (values?.length) return client.query(sql, values);
      return new Promise((resolve, reject) => {
        queued.push({ sql: scope ? `${scope.withClause} ${sql}` : sql, resolve, reject });
        if (queued.length !== 1) return;
        queueMicrotask(async () => {
          const batch = queued;
          queued = [];
          try {
            const result = await client.query(
              batch.map((entry) => entry.sql.trim().replace(/;$/, "")).join(";\n")
            );
            const results = Array.isArray(result) ? result : [result];
            if (results.length !== batch.length)
              throw new Error("Snapshot query result count mismatch.");
            batch.forEach((entry, index) => entry.resolve(results[index]));
          } catch (error) {
            batch.forEach((entry) => entry.reject(error));
          }
        });
      });
    }
  };
  return loadNormalizedSnapshot(reader as unknown as Pool, scope?.predicate);
}

const edgeRemovalBaselines = new WeakMap<PoolClient, Cp2Snapshot>();

/**
 * A baseline for change detection in which `keys` hold the records as the store sees them right
 * after hydration, for rows that were loaded. Restoring fills defaults a stored row may lack (a
 * message's provider, direction and channel ids); without this, every request rewrote every
 * loaded message of the conversation, and a concurrent write to one of them (marking it read)
 * failed the request with 40001. The optimistic check still compares against the stored rows.
 * Only rows present in `loaded` are rebased, so a row the store creates while hydrating is still
 * saved as new.
 */
export function rebaseLoadNormalizedCollections(
  loaded: Cp2Snapshot,
  hydrated: Cp2Snapshot,
  keys: readonly SnapshotCollectionKey[]
): Cp2Snapshot {
  const rebased = { ...loaded } as Cp2Snapshot;
  for (const key of keys) {
    const loadedIds = new Set(
      getSnapshotCollection(loaded, key).map((record) => recordEntityId(key, record))
    );
    setSnapshotCollection(
      rebased,
      key,
      getSnapshotCollection(hydrated, key).filter((record) =>
        loadedIds.has(recordEntityId(key, record))
      )
    );
  }
  const stored = edgeNormalizedBaselines.get(loaded);
  if (stored !== undefined) edgeNormalizedBaselines.set(rebased, stored);
  return rebased;
}

/**
 * A scoped (Edge) request loads only the checkpoints still kept, so its in-memory store cannot
 * drop older ones it never loaded. On a write that adds a checkpoint, this deletes the task's
 * stored checkpoints that the retention rule (checkpoint-retention.ts) no longer keeps and that
 * this request did not load, at most `runtimeCheckpointPruneBatch` per write, oldest first: a
 * backlog from before pruning drains over later writes. It runs before this save writes anything,
 * so it judges the stored rows as they were loaded: a row this request loaded is left to the
 * in-memory rule (which the writer then applies), and a row it did not load cannot be one this
 * request points at, because a request can only point at checkpoints it loaded.
 */
async function pruneStoredRuntimeCheckpoints(
  client: PoolClient,
  snapshot: Cp2Snapshot,
  previous: Cp2Snapshot
): Promise<void> {
  const loaded = (previous.runtimeHandoffs ?? []).map((handoff) => handoff.id);
  const known = new Set(loaded);
  const taskIds = [
    ...new Set(
      (snapshot.runtimeHandoffs ?? [])
        .filter((handoff) => !known.has(handoff.id))
        .map((handoff) => handoff.taskId)
    )
  ];
  if (taskIds.length === 0) return;
  await client.query(
    `delete from cp2_runtime_handoffs where entity_id in (
      select stored.entity_id from cp2_runtime_handoffs stored
      where stored.task_id = any($1::text[]) and not (stored.entity_id = any($3::text[]))
        and not ${retainedRuntimeCheckpointSql("stored")}
      order by stored.checkpoint_version limit $2)`,
    [taskIds, runtimeCheckpointPruneBatch, loaded]
  );
}

/**
 * The same for idempotency records: an Edge request loads only unexpired records of its account
 * (operation-dedup-retention.ts). On a write that records an operation, this deletes that
 * account's expired records the request did not load, at most one batch, oldest first, and a
 * stored record with the id of one this request writes (an expired record of the same key, which
 * the request did not load and now replaces).
 */
async function pruneStoredOperationDedup(
  client: PoolClient,
  snapshot: Cp2Snapshot,
  previous: Cp2Snapshot
): Promise<void> {
  const loaded = (previous.runtimeOperationDedup ?? []).map((record) => record.id);
  const known = new Set(loaded);
  const written = (snapshot.runtimeOperationDedup ?? []).filter(
    (record) => !known.has(record.id) && record.accountId !== undefined
  );
  if (written.length === 0) return;
  await client.query(
    `delete from cp2_runtime_operation_dedup where entity_id in (
      select stored.entity_id from cp2_runtime_operation_dedup stored
      where not (stored.entity_id = any($3::text[]))
        and ((stored.account_id = any($1::text[]) and stored.record->>'createdAt' < ${runtimeOperationDedupCutoffSql})
          or stored.entity_id = any($4::text[]))
      order by stored.record->>'createdAt' limit $2)`,
    [
      [...new Set(written.map((record) => record.accountId))],
      runtimeOperationDedupPruneBatch,
      loaded,
      written.map((record) => record.id)
    ]
  );
}

export async function saveTransactionalCp2Snapshot(
  client: PoolClient,
  snapshot: Cp2Snapshot,
  previous: Cp2Snapshot
): Promise<void> {
  await pruneStoredRuntimeCheckpoints(client, snapshot, previous);
  await pruneStoredOperationDedup(client, snapshot, previous);
  for (const collection of normalizedCollections) {
    const records = getSnapshotCollection(snapshot, collection.key);
    if (!collectionUnchanged(records, getSnapshotCollection(previous, collection.key)))
      await saveCollectionRecords(
        client,
        collection,
        records,
        getSnapshotCollection(previous, collection.key),
        edgeNormalizedBaselines.get(previous)?.get(collection.key)
      );
  }
  if (
    !collectionUnchanged(
      snapshotRecords(snapshot.conversationAttachments ?? []),
      snapshotRecords(previous.conversationAttachments ?? [])
    )
  )
    for (const attachment of previous.conversationAttachments ?? []) {
      if (!(snapshot.conversationAttachments ?? []).some((entry) => entry.id === attachment.id)) {
        await client.query("delete from cp2_conversation_attachment_blobs where storage_key = $1", [
          attachment.storageKey
        ]);
      }
    }
  edgeRemovalBaselines.set(client, previous);
  try {
    await saveRelationalCoreRecords(client, snapshot, previous);
    for (const change of snapshot.syncChanges)
      requireAccountSyncCollection(change.accountId, change.collection);
    await replaceAccountSyncChanges(client, snapshot, previous);
  } finally {
    edgeRemovalBaselines.delete(client);
  }
}

/**
 * Loads every normalized collection in one round trip. Boot used to issue one query per table
 * (~150 tables), so against a remote database the API spent most of its startup waiting on
 * network latency. jsonb_agg(... order by entity_id) keeps each collection's row order identical
 * to the previous per-table `order by entity_id` query, and aggregating per table means the
 * union only ever combines jsonb values, so differing entity_id types never matter.
 */
export function buildNormalizedSnapshotSql(
  collections: readonly NormalizedCollection[],
  predicate?: (key: SnapshotCollectionKey) => string
): string {
  return collections
    .map(
      (collection, index) =>
        `select ${index}::int as collection_index, coalesce(jsonb_agg(record order by entity_id), '[]'::jsonb) as records from ${collection.tableName}${predicate ? ` where ${predicate(collection.key)}` : ""}`
    )
    .join("\nunion all\n");
}

async function loadRelationalCoreSnapshot(pool: Pool, snapshot: Cp2Snapshot): Promise<void> {
  // Core SQL remains authoritative for identity fields; private preferences live in cp2_users.
  const privateUserPreferences = new Map(
    snapshot.users.map((user) => [
      user.id,
      {
        ...(user.contactDiscoveryEnabled === undefined
          ? {}
          : { contactDiscoveryEnabled: user.contactDiscoveryEnabled }),
        ...(user.blockedContactUserIds === undefined
          ? {}
          : { blockedContactUserIds: user.blockedContactUserIds })
      }
    ])
  );
  // Each loader fills its own snapshot key, so they run concurrently: boot against a remote
  // database was dominated by ~25 sequential round trips here (~7s at ~350ms per round trip).
  await Promise.all(
    [
      async () => {
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
      },
      async () => {
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
          ...privateUserPreferences.get(row.id),
          id: row.id,
          accountId: row.account_id,
          displayName: row.display_name,
          language: row.language,
          phoneNumberE164: row.phone_number_e164,
          phoneCountryCode: row.phone_country_code,
          phoneNationalNumber: row.phone_national_number,
          phoneVerificationStatus: row.phone_verification_status,
          phoneAddedAt: row.phone_added_at === null ? null : timestampToIso(row.phone_added_at),
          phoneUpdatedAt:
            row.phone_updated_at === null ? null : timestampToIso(row.phone_updated_at),
          phoneSource: row.phone_source,
          publicPhoneEnabled: row.public_phone_enabled,
          createdAt: timestampToIso(row.created_at)
        })) as Cp2Snapshot["users"];
      },
      async () => {
        const businessesResult = await timedQuery<{
          id: string;
          name: string;
          language: string;
          grogoni_id: string | null;
          timezone: string | null;
          created_at: Date;
        }>(
          pool,
          "load businesses",
          "select id, name, language, grogoni_id, timezone, created_at from businesses order by id"
        );
        snapshot.businesses = businessesResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          language: row.language,
          grogoniId: row.grogoni_id,
          timezone: row.timezone,
          createdAt: timestampToIso(row.created_at)
        })) as Cp2Snapshot["businesses"];
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
          ...restoreReceiptJobFields(
            row.structured_extraction as ReceiptStructuredExtractionSummary,
            row.contact_matching_result as ReceiptContactMatchingResultSummary,
            row.full_text
          ),
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
          itemsByInvoiceId.set(row.invoice_id, [
            ...(itemsByInvoiceId.get(row.invoice_id) ?? []),
            item
          ]);
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
          tokenExpiresAt:
            row.token_expires_at === null ? null : timestampToIso(row.token_expires_at),
          scope: row.scope,
          linkedAt: timestampToIso(row.linked_at),
          updatedAt: timestampToIso(row.updated_at)
        })) as unknown as Cp2Snapshot["userIdentities"];
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
      },
      async () => {
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
        snapshot.externalRegistryConnections = externalRegistryConnectionsResult.rows.map(
          (row) => ({
            id: row.id,
            accountId: row.account_id,
            provider: row.provider,
            externalAccountId: row.external_account_id,
            externalUsername: row.external_username,
            status: row.status,
            scopes: row.scopes,
            encryptedToken: row.encrypted_token,
            createdAt: timestampToIso(row.created_at),
            updatedAt: timestampToIso(row.updated_at)
          })
        );
      }
    ].map((load) => load())
  );
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
 * saveRelationalCoreRecords and the account sync journal apply the same gate per record (see
 * recordsChangedSince): only records that differ from `previousSnapshot` are upserted, while
 * deletions still compare against the full snapshot.
 */
function collectionUnchanged(current: SnapshotRecord[], previous: SnapshotRecord[]): boolean {
  if (current === previous) return true;
  if (current.length !== previous.length) return false;
  return JSON.stringify(current) === JSON.stringify(previous);
}

/**
 * Serializes CP2 persistence across API instances. This must be the transaction-scoped
 * pg_advisory_xact_lock, taken inside the transaction: DATABASE_URL is Neon's PgBouncer pooler in
 * transaction mode, where statements outside a transaction can run on different server backends.
 * The previous session-level pg_advisory_lock/pg_advisory_unlock pair ran outside the transaction,
 * so an unlock that landed on another backend (or never ran after a dropped connection) leaked the
 * lock on a pooled backend that never closes, and every later save blocked on it until "Query read
 * timeout". A transaction pins one backend and the lock is released at commit or rollback.
 * Each transaction (relational, then journal) takes it separately, so another instance could
 * interleave between the two; with one in-memory store per instance that was never coherent.
 */
async function lockNormalizedStore(client: PoolClient): Promise<void> {
  // Bounded wait: a lock leaked by an older build (or held by a stuck writer) fails this save with
  // lock_not_available (55P03) and a scheduled retry, instead of hanging until the query timeout.
  // `set local` scopes it to this transaction, so it also bounds the row locks the upserts take.
  // One simple-protocol round trip for both statements (no bind parameters): each round trip to
  // Neon costs up to ~450ms and this runs in both transactions of every save.
  await client.query(
    `set local lock_timeout = '${normalizedStoreLockTimeoutMs}ms'; select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))`
  );
}

const normalizedStoreLockTimeoutMs = 10_000;

/**
 * Matches only the store lock in the current database (pg_locks is server-wide; a bigint advisory
 * key is classid = high 32 bits, objid = low 32 bits, objsubid 1). Kept identical to
 * services/api/scripts/store-lock-lib.mjs; tests/relational-change-diff.test.ts enforces it.
 */
export const storeLockPredicate = `
  l.locktype = 'advisory'
  and l.database = (select oid from pg_database where datname = current_database())
  and l.classid = ((hashtext('grogoni.cp2.normalized_store')::bigint >> 32) & 4294967295)::oid
  and l.objid = (hashtext('grogoni.cp2.normalized_store')::bigint & 4294967295)::oid
  and l.objsubid = 1`;

/**
 * On lock_not_available, names who holds the store lock. A holder that stays "idle" across
 * retries is a lock leaked by an older build through the pooler; see docs/runbooks/
 * cp2-store-lock-leak.md for how to confirm and release it. This query also goes through the
 * pooler and can land on the leaked backend itself, which then reports "active": `self: true`
 * marks that case, and such a holder is the leak too.
 */
async function logStoreLockHolders(pool: Pool): Promise<void> {
  try {
    const holders = await pool.query<{
      pid: number;
      state: string | null;
      application_name: string | null;
      backend_start: Date | null;
      state_change: Date | null;
      self: boolean;
    }>(
      `select a.pid, a.state, a.application_name, a.backend_start, a.state_change,
              a.pid = pg_backend_pid() as self
         from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where ${storeLockPredicate} and l.granted`
    );
    console.error(
      JSON.stringify({
        event: "cp2_persistence_lock_unavailable",
        holders: holders.rows,
        runbook: "docs/runbooks/cp2-store-lock-leak.md"
      })
    );
  } catch (error) {
    console.error("Failed to inspect CP2 persistence lock holders.", error);
  }
}

/**
 * The baseline to keep after a save that failed (or whose commit acknowledgement was lost, so it
 * may in fact have committed). Records the attempt left unchanged stay in the baseline; records it
 * wrote, changed or deleted are dropped, so the next save re-sends whatever the database might now
 * hold differently, even if the in-memory value meanwhile went back to its old content. Dropping a
 * record would also hide a deletion from the content-equality delete gates (as would a record the
 * attempt added and memory deleted since), so every collection the attempt changed in any way is
 * returned in `forcedRemovalChecks`: the next save rewrites that
 * `cp2_*` collection (whose save deletes rows missing from memory) and runs its relational and
 * journal delete passes, until a save succeeds. Only the given keys are shrunk (all array-valued keys by default).
 */
export function baselineAfterFailedSave(
  previous: Cp2Snapshot,
  attempted: Cp2Snapshot,
  keys: readonly (keyof Cp2Snapshot)[] = Object.keys(previous) as (keyof Cp2Snapshot)[]
): { baseline: Cp2Snapshot; forcedRemovalChecks: Set<string> } {
  const baseline = { ...previous };
  const forcedRemovalChecks = new Set<string>();
  for (const key of keys) {
    const previousRecords = previous[key];
    if (!Array.isArray(previousRecords)) continue;
    const attemptedRecords = Array.isArray(attempted[key]) ? (attempted[key] as unknown[]) : [];
    const previousContent = new Set(
      (previousRecords as unknown[]).map((record) => JSON.stringify(record))
    );
    const attemptedContent = new Set(attemptedRecords.map((record) => JSON.stringify(record)));
    const kept = (previousRecords as unknown[]).filter((record) =>
      attemptedContent.has(JSON.stringify(record))
    );
    const attemptAddedOrChanged = [...attemptedContent].some(
      (content) => !previousContent.has(content)
    );
    if (kept.length === previousRecords.length && !attemptAddedOrChanged) continue;
    (baseline as Record<string, unknown>)[key] = kept;
    // A record the attempt added may now exist in the database even though the baseline does not
    // list it; if memory deletes it before the next successful save, the collection would look
    // unchanged again. So any difference at all forces the delete pass, not only dropped records.
    forcedRemovalChecks.add(key);
  }
  return { baseline, forcedRemovalChecks };
}

async function saveNormalizedSnapshot(
  pool: Pool,
  snapshot: Cp2Snapshot,
  previousSnapshot?: Cp2Snapshot,
  forcedRemovalChecks: ReadonlySet<string> = new Set()
): Promise<{ syncJournalError: AccountSyncPersistenceError | null }> {
  const client = await pool.connect();
  const startedAt = Date.now();
  const stats: PersistenceWriteStats = { relationalRecords: 0, journalEntries: 0 };

  try {
    try {
      await client.query("begin");
      await lockNormalizedStore(client);

      for (const collection of normalizedCollections) {
        const records = getSnapshotCollection(snapshot, collection.key);
        if (
          previousSnapshot !== undefined &&
          !forcedRemovalChecks.has(collection.key) &&
          collectionUnchanged(records, getSnapshotCollection(previousSnapshot, collection.key))
        ) {
          continue;
        }
        await saveCollectionRecords(client, collection, records);
      }

      await reconcileConversationAttachmentBlobs(client, snapshot.conversationAttachments ?? []);

      await saveRelationalCoreRecords(
        client,
        snapshot,
        previousSnapshot,
        stats,
        forcedRemovalChecks
      );
      await client.query("commit");
      logSlowQuery("persist CP2 relational store", startedAt);
    } catch (error) {
      await client.query("rollback").catch((rollbackError: unknown) => {
        console.error("Failed to roll back CP2 normalized persistence transaction.", rollbackError);
      });
      throw error;
    }

    // Logged once the relational transaction has committed, whether or not the journal then
    // succeeds, so the trace also covers saves whose journal write failed (journal: "failed").
    const logSaved = (journal: "ok" | "failed") =>
      console.info(
        JSON.stringify({
          event: "cp2_persistence_saved",
          durationMs: Date.now() - startedAt,
          relationalRecordsChanged: stats.relationalRecords,
          journalEntriesWritten: journal === "ok" ? stats.journalEntries : 0,
          journal
        })
      );
    try {
      await saveAccountSyncChanges(client, snapshot, previousSnapshot, stats, forcedRemovalChecks);
      logSaved("ok");
      return { syncJournalError: null };
    } catch (error) {
      logSaved("failed");
      return {
        syncJournalError: normalizeAccountSyncPersistenceError(error, snapshot)
      };
    }
  } finally {
    client.release();
  }
}

export function createPostgresAttachmentBlobStore(pool: Pool): ConversationAttachmentBlobStore {
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

export function createPostgresAccountAiAssetStore(pool: Pool): AccountAiAssetStore {
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
    try {
      await client.query("begin");
      await lockNormalizedStore(client);
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
    client.release();
  }
}

async function saveAccountSyncChanges(
  client: PoolClient,
  snapshot: Cp2Snapshot,
  previous?: Cp2Snapshot,
  stats?: PersistenceWriteStats,
  forcedRemovalChecks: ReadonlySet<string> = new Set()
): Promise<void> {
  const startedAt = Date.now();

  try {
    await client.query("begin");
    await lockNormalizedStore(client);
    for (const change of snapshot.syncChanges) {
      requireAccountSyncCollection(change.accountId, change.collection);
    }
    await replaceAccountSyncChanges(client, snapshot, previous, stats, forcedRemovalChecks);
    await client.query("commit");
    logSlowQuery("persist account sync journal", startedAt);
    console.info(
      JSON.stringify({
        event: "account_sync_changes_transaction_committed",
        changeCount: snapshot.syncChanges.length,
        changesWritten: stats?.journalEntries ?? snapshot.syncChanges.length,
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

/**
 * Every hot-path upsert skips rows whose values are unchanged (`where ... is distinct from
 * excluded`): persistence re-sends whole collections, and rewriting identical rows bloated tables
 * (account_sync_changes reached ~26k rewrites per row). Session retention triggers fire
 * `before insert or update`, so they already stamp an expired session on the proposed (excluded)
 * row and the guard lets that write through. Once a session is stored as expired, though, each
 * save would get a fresh trigger timestamp and rewrite it forever, so the revocation timestamp is
 * ignored when both the stored and the proposed rows carry the trigger's "expired" revocation.
 */
function comparableRecord(tableName: string, side: string): string {
  if (tableName !== "cp2_sessions") return `${side}.record`;
  return `case when cp2_sessions.record->>'revocationReason' = 'expired' and excluded.record->>'revocationReason' = 'expired' then ${side}.record - 'revokedAt' else ${side}.record end`;
}

/** 6 parameters per row keeps each statement far below Postgres's 65,535 bind-parameter limit. */
const collectionUpsertChunkSize = 1_000;

/** Exported for tests/cp2-postgres-store.test.ts, which counts its round trips directly. */
export async function saveCollectionRecords(
  client: PoolClient,
  collection: NormalizedCollection,
  records: SnapshotRecord[],
  previous?: SnapshotRecord[],
  expected?: SnapshotRecord[]
): Promise<void> {
  const desiredIds = records.map((record) => recordEntityId(collection.key, record));
  const existingResult = previous
    ? { rows: previous.map((record) => ({ entity_id: recordEntityId(collection.key, record) })) }
    : await client.query<{ entity_id: string }>(`select entity_id from ${collection.tableName}`);
  const desiredIdSet = new Set(desiredIds);
  const removedIds = existingResult.rows
    .map((row) => row.entity_id)
    .filter((entityId) => !desiredIdSet.has(entityId));

  if (removedIds.length > 0) {
    if (expected) {
      const removed = expected.filter((record) =>
        removedIds.includes(recordEntityId(collection.key, record))
      );
      const result = await client.query(
        `delete from ${collection.tableName} persisted using jsonb_to_recordset($1::jsonb) as baseline(entity_id text, record jsonb)
        where persisted.entity_id = baseline.entity_id and persisted.record = baseline.record`,
        [
          JSON.stringify(
            removed.map((record) => ({ entity_id: recordEntityId(collection.key, record), record }))
          )
        ]
      );
      if (
        result.rowCount !== undefined &&
        result.rowCount !== null &&
        result.rowCount !== removed.length
      )
        throw Object.assign(new Error("Concurrent snapshot update"), {
          code: "40001",
          table: collection.tableName
        });
    } else {
      await client.query(`delete from ${collection.tableName} where entity_id = any($1::text[])`, [
        removedIds
      ]);
    }
  }

  // One multi-row upsert per chunk instead of one round trip per record: against a remote
  // database the per-row loop made saving a large collection (cp2_audit_events, ~1,400 rows)
  // take minutes. A plain VALUES list lets Postgres type each parameter from its target column,
  // which differs across the normalized tables. The old loop let a repeated entity_id's last
  // record win; a multi-row upsert rejects repeats, so they are collapsed the same way first.
  const rowsByEntityId = new Map<string, unknown[]>();
  for (const record of previous ? recordsChangedSince(records, previous) : records) {
    const entityId = recordEntityId(collection.key, record);
    rowsByEntityId.delete(entityId);
    rowsByEntityId.set(entityId, [
      entityId,
      firstText(record, ["businessId", "shopId", "tenantId"]),
      firstText(record, ["accountId", "buyerAccountId"]),
      firstText(record, ["userId", "ownerUserId", "actorId", "postedBy"]),
      recordParentId(collection.key, record),
      JSON.stringify(record)
    ]);
  }
  const rows = [...rowsByEntityId.values()];
  const expectedById = new Map(
    expected?.map((record) => [recordEntityId(collection.key, record), record])
  );
  for (let offset = 0; offset < rows.length; offset += collectionUpsertChunkSize) {
    const chunk = rows.slice(offset, offset + collectionUpsertChunkSize);
    if (expected) {
      const placeholders = chunk
        .map((_row, index) => {
          const base = index * 7;
          return `($${base + 1}::text,$${base + 2}::text,$${base + 3}::text,$${base + 4}::text,$${base + 5}::text,$${base + 6}::jsonb,$${base + 7}::jsonb)`;
        })
        .join(",");
      const result = await client.query(
        `with input(entity_id,business_id,account_id,user_id,parent_id,record,expected) as (values ${placeholders})
        insert into ${collection.tableName} (entity_id,business_id,account_id,user_id,parent_id,record,updated_at)
        select entity_id,business_id,account_id,user_id,parent_id,record,now() from input
        on conflict (entity_id) do update set business_id=excluded.business_id, account_id=excluded.account_id,
          user_id=excluded.user_id,parent_id=excluded.parent_id,record=excluded.record,updated_at=now()
        where ${collection.tableName}.record = (select expected from input where input.entity_id = excluded.entity_id)
           or ${collection.tableName}.record = excluded.record
        returning entity_id`,
        chunk.flatMap((row) => [...row, JSON.stringify(expectedById.get(String(row[0])) ?? null)])
      );
      if (
        result.rowCount !== undefined &&
        result.rowCount !== null &&
        result.rowCount !== chunk.length
      )
        throw Object.assign(new Error("Concurrent snapshot update"), {
          code: "40001",
          table: collection.tableName
        });
      continue;
    }
    const placeholders = chunk
      .map((_row, index) => {
        const base = index * 6;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, now())`;
      })
      .join(",\n          ");
    await client.query(
      `
        insert into ${collection.tableName}
          (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
        values
          ${placeholders}
        on conflict (entity_id) do update set
          business_id = excluded.business_id,
          account_id = excluded.account_id,
          user_id = excluded.user_id,
          parent_id = excluded.parent_id,
          record = excluded.record,
          updated_at = now()
          where (${collection.tableName}.business_id, ${collection.tableName}.account_id, ${collection.tableName}.user_id, ${collection.tableName}.parent_id, ${comparableRecord(collection.tableName, collection.tableName)}) is distinct from (excluded.business_id, excluded.account_id, excluded.user_id, excluded.parent_id, ${comparableRecord(collection.tableName, "excluded")})
      `,
      chunk.flat()
    );
  }
}

/**
 * Records in `current` that are not content-identical to a record in `previous`, the snapshot of
 * the last successful save. Without a `previous` (the first save, or callers that want a full
 * write) every record counts as changed. Like collectionUnchanged above, a false "changed" only
 * costs a no-op upsert; a false "unchanged" is impossible because any difference in a record's
 * serialized content marks it changed.
 */
export function recordsChangedSince<T>(
  current: readonly T[] | undefined,
  previous: readonly T[] | undefined
): T[] {
  const records = current ?? [];
  if (previous === undefined) return [...records];
  const persisted = new Set(previous.map((record) => JSON.stringify(record)));
  return records.filter((record) => !persisted.has(JSON.stringify(record)));
}

/**
 * The relational upsert loops below used to rewrite every row of every table on every save: one
 * round trip per row, ~600 for a small store, which against a remote database made each save take
 * ~5 minutes (measured 319s for "persist CP2 relational store" against Neon). Any network blip in
 * that window failed the whole transaction, so nothing persisted and every mutating request waited
 * out the response deadline. Each loop's row is derived only from its own record, so writing only
 * changed records is equivalent; deletions still compare against the full snapshot.
 */
function relationalChangeSelector(
  snapshot: Cp2Snapshot,
  previous: Cp2Snapshot | undefined,
  stats?: PersistenceWriteStats
) {
  return (key: keyof Cp2Snapshot): SnapshotRecord[] => {
    const changed = recordsChangedSince(
      snapshotRecords(snapshot[key]),
      previous === undefined ? undefined : snapshotRecords(previous[key])
    );
    if (stats !== undefined) stats.relationalRecords += changed.length;
    return changed;
  };
}

/**
 * Records a save actually sent, logged per save (cp2_persistence_saved) as the trace for the
 * changed-only writes. A record can map to more than one row (e.g. user identities).
 */
interface PersistenceWriteStats {
  relationalRecords: number;
  journalEntries: number;
}

/**
 * replaceReceiptLineItems deletes every line item of each receipt it is given and re-inserts the
 * records passed in, so it must receive all current items of any receipt whose items changed -
 * passing only the changed items would drop their unchanged siblings.
 */
export function receiptLineItemsToRewrite(
  snapshot: Cp2Snapshot,
  previous: Cp2Snapshot | undefined
): SnapshotRecord[] {
  const items = snapshotRecords(snapshot.receiptLineItems);
  if (previous === undefined) return items;
  const touchedReceiptIds = new Set(
    recordsChangedSince(items, snapshotRecords(previous.receiptLineItems)).map((item) =>
      requiredText(item, "receiptId")
    )
  );
  return items.filter((item) => touchedReceiptIds.has(requiredText(item, "receiptId")));
}

/** Exported for tests/cp2-postgres-store.test.ts, which drives receipt line-item rewrites directly. */
export async function saveRelationalCoreRecords(
  client: PoolClient,
  snapshot: Cp2Snapshot,
  previous?: Cp2Snapshot,
  stats?: PersistenceWriteStats,
  forcedRemovalChecks: ReadonlySet<string> = new Set()
): Promise<void> {
  const now = new Date().toISOString();
  const changed = relationalChangeSelector(snapshot, previous, stats);
  // A collection identical to the last save cannot have lost a row, so its delete query (which
  // ships every current id to the database) is skipped; any change still runs it.
  const mayHaveRemovals = (key: keyof Cp2Snapshot) =>
    previous?.[key] === undefined ||
    forcedRemovalChecks.has(key) ||
    !collectionUnchanged(snapshotRecords(snapshot[key] ?? []), snapshotRecords(previous[key]));

  await saveShopDeletionArchives(client, changed("accountDeletionRequests"));

  if (mayHaveRemovals("mcpAccessTokens")) {
    await deleteMissingRows(client, "mcp_access_tokens", snapshotRecords(snapshot.mcpAccessTokens));
  }
  if (mayHaveRemovals("externalRegistryConnections")) {
    await deleteMissingRows(
      client,
      "cp2_external_registry_connections",
      snapshotRecords(snapshot.externalRegistryConnections)
    );
  }
  if (mayHaveRemovals("receiptLineItems")) {
    await deleteMissingRows(
      client,
      "receipt_line_items",
      snapshotRecords(snapshot.receiptLineItems)
    );
  }
  if (mayHaveRemovals("payments")) {
    await deleteMissingRows(client, "payments", snapshotRecords(snapshot.payments));
  }
  if (mayHaveRemovals("invoices")) {
    await deleteMissingInvoiceRows(client, snapshotRecords(snapshot.invoices));
  }
  if (mayHaveRemovals("purchaseReceipts")) {
    await deleteMissingRows(
      client,
      "purchase_receipts",
      snapshotRecords(snapshot.purchaseReceipts)
    );
  }
  if (mayHaveRemovals("receiptOCRJobs")) {
    await deleteMissingRows(client, "receipt_ocr_jobs", snapshotRecords(snapshot.receiptOCRJobs));
  }
  if (mayHaveRemovals("supplierContactLinks")) {
    await deleteMissingRows(
      client,
      "supplier_contact_links",
      snapshotRecords(snapshot.supplierContactLinks)
    );
  }
  if (mayHaveRemovals("deviceTrust")) {
    await deleteMissingDeviceTrustRows(client, snapshotRecords(snapshot.deviceTrust));
  }
  if (mayHaveRemovals("oauthSessions")) {
    await deleteMissingRows(client, "oauth_sessions", snapshotRecords(snapshot.oauthSessions));
  }
  if (mayHaveRemovals("userIdentities")) {
    await deleteMissingRows(client, "auth_accounts", snapshotRecords(snapshot.userIdentities));
  }
  if (mayHaveRemovals("otpChallenges")) {
    await deleteMissingRows(
      client,
      "verification_challenges",
      snapshotRecords(snapshot.otpChallenges)
    );
  }
  if (mayHaveRemovals("smsDeliveryAttempts")) {
    await deleteMissingRows(
      client,
      "sms_delivery_attempts",
      snapshotRecords(snapshot.smsDeliveryAttempts)
    );
  }
  if (mayHaveRemovals("userIdentities")) {
    await deleteMissingRows(client, "user_identities", snapshotRecords(snapshot.userIdentities));
  }
  if (mayHaveRemovals("otpChallenges")) {
    await deleteMissingRows(client, "otp_challenges", snapshotRecords(snapshot.otpChallenges));
  }
  if (mayHaveRemovals("accountPinHashes")) {
    await deleteMissingAccountPinHashes(client, snapshotRecords(snapshot.accountPinHashes));
  }
  if (mayHaveRemovals("salesAgents")) {
    await deleteMissingRows(client, "sales_agents", snapshotRecords(snapshot.salesAgents));
  }
  if (mayHaveRemovals("suppliers")) {
    await deleteMissingRows(client, "suppliers", snapshotRecords(snapshot.suppliers));
  }
  if (mayHaveRemovals("sessions")) {
    await deleteMissingRows(client, "sessions", snapshotRecords(snapshot.sessions));
  }
  if (mayHaveRemovals("memberships")) {
    await deleteMissingRows(client, "business_memberships", snapshotRecords(snapshot.memberships));
  }
  if (mayHaveRemovals("accounts") || mayHaveRemovals("users") || mayHaveRemovals("businesses")) {
    await deleteRemovedAccountRelationalGraph(client, snapshot);
  }

  for (const record of changed("accounts")) {
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
          where (accounts.primary_auth_channel, accounts.primary_auth_destination, accounts.identity_level, accounts.status, accounts.deleted_at) is distinct from (excluded.primary_auth_channel, excluded.primary_auth_destination, excluded.identity_level, excluded.status, excluded.deleted_at)
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

  for (const record of changed("users")) {
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
          where (users.account_id, users.display_name, users.language, users.phone_number_e164, users.phone_country_code, users.phone_national_number, users.phone_verification_status, users.phone_added_at, users.phone_updated_at, users.phone_source, users.public_phone_enabled) is distinct from (excluded.account_id, excluded.display_name, excluded.language, excluded.phone_number_e164, excluded.phone_country_code, excluded.phone_national_number, excluded.phone_verification_status, excluded.phone_added_at, excluded.phone_updated_at, excluded.phone_source, excluded.public_phone_enabled)
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

  for (const record of changed("businesses")) {
    await client.query(
      `
        insert into businesses (id, name, language, grogoni_id, timezone, created_at)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (id) do update set
          name = excluded.name,
          language = excluded.language,
          grogoni_id = excluded.grogoni_id,
          timezone = excluded.timezone
          where (businesses.name, businesses.language, businesses.grogoni_id, businesses.timezone) is distinct from (excluded.name, excluded.language, excluded.grogoni_id, excluded.timezone)
      `,
      [
        requiredText(record, "id"),
        requiredText(record, "name"),
        requiredText(record, "language"),
        firstText(record, ["grogoniId"]),
        firstText(record, ["timezone"]),
        now
      ]
    );
  }

  for (const record of changed("memberships")) {
    await client.query(
      `
        insert into business_memberships (id, business_id, user_id, role, created_at)
        values ($1, $2, $3, $4, $5)
        on conflict (id) do update set
          business_id = excluded.business_id,
          user_id = excluded.user_id,
          role = excluded.role
          where (business_memberships.business_id, business_memberships.user_id, business_memberships.role) is distinct from (excluded.business_id, excluded.user_id, excluded.role)
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

  for (const record of changed("products")) {
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
          where (products.business_id, products.name, products.sku, products.aliases, products.unit, products.quantity, products.buying_price, products.selling_price, products.unit_weight_grams, products.primary_media_id, products.updated_at) is distinct from (excluded.business_id, excluded.name, excluded.sku, excluded.aliases, excluded.unit, excluded.quantity, excluded.buying_price, excluded.selling_price, excluded.unit_weight_grams, excluded.primary_media_id, excluded.updated_at)
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

  for (const record of changed("customers")) {
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
          where (customers.business_id, customers.name, customers.phone, customers.email, customers.linked_account_id, customers.notes, customers.updated_at) is distinct from (excluded.business_id, excluded.name, excluded.phone, excluded.email, excluded.linked_account_id, excluded.notes, excluded.updated_at)
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

  for (const record of changed("suppliers")) {
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
          where (suppliers.business_id, suppliers.name, suppliers.phone, suppliers.linked_phonebook_contact_id, suppliers.linked_phonebook_contact_name, suppliers.email, suppliers.notes, suppliers.sales_agent_count, suppliers.purchase_receipt_count, suppliers.last_purchase_date, suppliers.updated_at) is distinct from (excluded.business_id, excluded.name, excluded.phone, excluded.linked_phonebook_contact_id, excluded.linked_phonebook_contact_name, excluded.email, excluded.notes, excluded.sales_agent_count, excluded.purchase_receipt_count, excluded.last_purchase_date, excluded.updated_at)
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

  for (const record of changed("salesAgents")) {
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
          where (sales_agents.supplier_name, sales_agents.name, sales_agents.phone, sales_agents.linked_phonebook_contact_id, sales_agents.linked_phonebook_contact_name, sales_agents.notes, sales_agents.receipts_handled, sales_agents.last_transaction_date, sales_agents.updated_at) is distinct from (excluded.supplier_name, excluded.name, excluded.phone, excluded.linked_phonebook_contact_id, excluded.linked_phonebook_contact_name, excluded.notes, excluded.receipts_handled, excluded.last_transaction_date, excluded.updated_at)
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

  await savePhase1AuthSecurityRecords(client, snapshot, previous, stats);

  for (const record of changed("supplierContactLinks")) {
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
          where (supplier_contact_links.business_id, supplier_contact_links.link_type, supplier_contact_links.supplier_id, supplier_contact_links.sales_agent_id, supplier_contact_links.network_node_id, supplier_contact_links.contact_name, supplier_contact_links.linked_at) is distinct from (excluded.business_id, excluded.link_type, excluded.supplier_id, excluded.sales_agent_id, excluded.network_node_id, excluded.contact_name, excluded.linked_at)
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

  for (const record of changed("receiptOCRJobs")) {
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

  for (const record of changed("purchaseReceipts")) {
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
          where (purchase_receipts.supplier_id, purchase_receipts.supplier_name, purchase_receipts.sales_agent_id, purchase_receipts.sales_agent_name, purchase_receipts.receipt_date, purchase_receipts.total, purchase_receipts.source_file_name, purchase_receipts.ocr_job_id, purchase_receipts.image_stored) is distinct from (excluded.supplier_id, excluded.supplier_name, excluded.sales_agent_id, excluded.sales_agent_name, excluded.receipt_date, excluded.total, excluded.source_file_name, excluded.ocr_job_id, excluded.image_stored)
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

  const receiptLineItems = receiptLineItemsToRewrite(snapshot, previous);
  if (stats !== undefined) stats.relationalRecords += receiptLineItems.length;
  await replaceReceiptLineItems(client, receiptLineItems);
  await saveInvoicesAndItems(client, changed("invoices"));

  for (const record of changed("payments")) {
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
          where (payments.method, payments.amount, payments.reference, payments.note) is distinct from (excluded.method, excluded.amount, excluded.reference, excluded.note)
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

  for (const record of changed("sessions")) {
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
          where (sessions.device_id, sessions.device_name, sessions.platform, sessions.browser_or_app, sessions.user_agent_hash, sessions.refresh_token_hash, sessions.session_family_id, sessions.refresh_expires_at, sessions.inactivity_expires_at, sessions.absolute_expires_at, sessions.rotated_from_session_id, sessions.authenticated_at, sessions.last_used_at, sessions.rotated_at, sessions.revocation_reason, sessions.expires_at, sessions.pin_verified_at, case when sessions.revocation_reason = 'expired' and excluded.revocation_reason = 'expired' then null else sessions.revoked_at end) is distinct from (excluded.device_id, excluded.device_name, excluded.platform, excluded.browser_or_app, excluded.user_agent_hash, excluded.refresh_token_hash, excluded.session_family_id, excluded.refresh_expires_at, excluded.inactivity_expires_at, excluded.absolute_expires_at, excluded.rotated_from_session_id, excluded.authenticated_at, excluded.last_used_at, excluded.rotated_at, excluded.revocation_reason, excluded.expires_at, excluded.pin_verified_at, case when sessions.revocation_reason = 'expired' and excluded.revocation_reason = 'expired' then null else excluded.revoked_at end)
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

  const changedMcpAccessTokens = recordsChangedSince(
    snapshot.mcpAccessTokens,
    previous?.mcpAccessTokens
  );
  if (stats !== undefined) stats.relationalRecords += changedMcpAccessTokens.length;
  for (const token of changedMcpAccessTokens) {
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
          where (mcp_access_tokens.token_hash, mcp_access_tokens.name, mcp_access_tokens.scopes, mcp_access_tokens.shop_id, mcp_access_tokens.expires_at, mcp_access_tokens.last_used_at, mcp_access_tokens.revoked_at) is distinct from (excluded.token_hash, excluded.name, excluded.scopes, excluded.shop_id, excluded.expires_at, excluded.last_used_at, excluded.revoked_at)
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

  const changedExternalRegistryConnections = recordsChangedSince(
    snapshot.externalRegistryConnections,
    previous?.externalRegistryConnections
  );
  if (stats !== undefined) stats.relationalRecords += changedExternalRegistryConnections.length;
  for (const connection of changedExternalRegistryConnections) {
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
          where (cp2_external_registry_connections.external_account_id, cp2_external_registry_connections.external_username, cp2_external_registry_connections.status, cp2_external_registry_connections.scopes, cp2_external_registry_connections.encrypted_token, cp2_external_registry_connections.inference_authorized, cp2_external_registry_connections.updated_at) is distinct from (excluded.external_account_id, excluded.external_username, excluded.status, excluded.scopes, excluded.encrypted_token, excluded.inference_authorized, excluded.updated_at)
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
        // inference_authorized: the retired BYO inference billing flag; never set any more.
        false,
        connection.createdAt,
        connection.updatedAt
      ]
    );
  }
}

/** True when an entry saved last time is gone from the journal (pruned): only then can the delete remove a row. */
function syncChangesMayHaveRemovals(
  current: Cp2Snapshot["syncChanges"],
  previous: Cp2Snapshot["syncChanges"] | undefined
): boolean {
  if (previous === undefined) return true;
  const currentKeys = new Set(current.map((change) => `${change.accountId}:${change.sequence}`));
  return previous.some((change) => !currentKeys.has(`${change.accountId}:${change.sequence}`));
}

async function deleteRemovedAccountSyncChanges(
  client: PoolClient,
  snapshot: Cp2Snapshot
): Promise<void> {
  const baseline = edgeRemovalBaselines.get(client);
  if (baseline) {
    const retained = new Set(
      snapshot.syncChanges.map((change) => `${change.accountId}:${change.sequence}`)
    );
    for (const change of baseline.syncChanges) {
      if (!retained.has(`${change.accountId}:${change.sequence}`)) {
        await client.query(
          "delete from account_sync_changes where account_id = $1 and sequence = $2",
          [change.accountId, change.sequence]
        );
      }
    }
    return;
  }
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
}

async function replaceAccountSyncChanges(
  client: PoolClient,
  snapshot: Cp2Snapshot,
  previous?: Cp2Snapshot,
  stats?: PersistenceWriteStats,
  forcedRemovalChecks: ReadonlySet<string> = new Set()
): Promise<void> {
  if (
    forcedRemovalChecks.has("syncChanges") ||
    syncChangesMayHaveRemovals(snapshot.syncChanges, previous?.syncChanges)
  ) {
    await deleteRemovedAccountSyncChanges(client, snapshot);
  }

  // Re-sending the whole journal (~22k rows, ~15 MB) on every save took ~14s against Neon even
  // with the bulk upsert; only entries added or changed since the last saved journal need writing.
  const changedSyncChanges = recordsChangedSince(snapshot.syncChanges, previous?.syncChanges);
  if (stats !== undefined) stats.journalEntries = changedSyncChanges.length;
  if (changedSyncChanges.length === 0) return;

  try {
    // The common case (no constraint violation) is a single bulk upsert instead of one round
    // trip per row - with a large backlog (e.g. after the API wakes from a cold start with
    // hundreds of queued changes), the previous per-row loop's sequential network round trips
    // were the dominant cost of "persist account sync journal", observed taking 40s+ in
    // production. See docs note at upsertAccountSyncChangesOneByOne for why the fallback below
    // still exists.
    await upsertAccountSyncChangesBulk(client, changedSyncChanges);
  } catch {
    // The bulk statement can't identify which row violated a constraint - fall back to the
    // slower row-by-row path only when something actually went wrong, so
    // AccountSyncPersistenceError still names the exact offending account/collection.
    await upsertAccountSyncChangesOneByOne(client, changedSyncChanges);
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
        where (account_sync_changes.cursor, account_sync_changes.collection, account_sync_changes.entity_id, account_sync_changes.operation, account_sync_changes.shop_id, account_sync_changes.entity, account_sync_changes.changed_at, account_sync_changes.tombstone_expires_at) is distinct from (excluded.cursor, excluded.collection, excluded.entity_id, excluded.operation, excluded.shop_id, excluded.entity, excluded.changed_at, excluded.tombstone_expires_at)
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
            where (account_sync_changes.cursor, account_sync_changes.collection, account_sync_changes.entity_id, account_sync_changes.operation, account_sync_changes.shop_id, account_sync_changes.entity, account_sync_changes.changed_at, account_sync_changes.tombstone_expires_at) is distinct from (excluded.cursor, excluded.collection, excluded.entity_id, excluded.operation, excluded.shop_id, excluded.entity, excluded.changed_at, excluded.tombstone_expires_at)
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
  const baseline = edgeRemovalBaselines.get(client);
  const removedAccounts = baseline
    ? { rows: baseline.accounts.filter((item) => !desiredAccountIds.includes(item.id)) }
    : await client.query<{ id: string }>(
        "select id from accounts where not (id = any($1::uuid[]))",
        [desiredAccountIds]
      );
  const removedUsers = baseline
    ? { rows: baseline.users.filter((item) => !desiredUserIds.includes(item.id)) }
    : await client.query<{ id: string }>("select id from users where not (id = any($1::uuid[]))", [
        desiredUserIds
      ]);
  const removedBusinesses = baseline
    ? { rows: baseline.businesses.filter((item) => !desiredBusinessIds.includes(item.id)) }
    : await client.query<{ id: string }>(
        "select id from businesses where not (id = any($1::uuid[]))",
        [desiredBusinessIds]
      );
  const accountIds = removedAccounts.rows.map((row) => row.id);
  const userIds = removedUsers.rows.map((row) => row.id);
  const businessIds = removedBusinesses.rows.map((row) => row.id);

  if (accountIds.length === 0 && userIds.length === 0 && businessIds.length === 0) return;

  await client.query(
    `
      delete from grogoni_session_contexts
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
          where (shop_deletion_archives.status, shop_deletion_archives.restore_until, shop_deletion_archives.updated_at) is distinct from (excluded.status, excluded.restore_until, excluded.updated_at)
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
  snapshot: Cp2Snapshot,
  previous?: Cp2Snapshot,
  stats?: PersistenceWriteStats
): Promise<void> {
  const changed = relationalChangeSelector(snapshot, previous, stats);
  await saveIdentityProviders(client, snapshot);

  for (const record of changed("otpChallenges")) {
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
          where (otp_challenges.channel, otp_challenges.destination, otp_challenges.purpose, otp_challenges.code_hash, otp_challenges.attempts, otp_challenges.max_attempts, otp_challenges.expires_at, otp_challenges.verified_at, otp_challenges.consumed_at, otp_challenges.resend_count, otp_challenges.next_resend_at, otp_challenges.provider, otp_challenges.provider_message_id) is distinct from (excluded.channel, excluded.destination, excluded.purpose, excluded.code_hash, excluded.attempts, excluded.max_attempts, excluded.expires_at, excluded.verified_at, excluded.consumed_at, excluded.resend_count, excluded.next_resend_at, excluded.provider, excluded.provider_message_id)
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
          where (verification_challenges.channel, verification_challenges.destination, verification_challenges.purpose, verification_challenges.code_hash, verification_challenges.attempts, verification_challenges.max_attempts, verification_challenges.status, verification_challenges.expires_at, verification_challenges.verified_at, verification_challenges.consumed_at, verification_challenges.resend_count, verification_challenges.next_resend_at, verification_challenges.provider, verification_challenges.provider_message_id, verification_challenges.updated_at) is distinct from (excluded.channel, excluded.destination, excluded.purpose, excluded.code_hash, excluded.attempts, excluded.max_attempts, excluded.status, excluded.expires_at, excluded.verified_at, excluded.consumed_at, excluded.resend_count, excluded.next_resend_at, excluded.provider, excluded.provider_message_id, excluded.updated_at)
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

  for (const record of changed("smsDeliveryAttempts")) {
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
          where (sms_delivery_attempts.provider_message_id, sms_delivery_attempts.status, sms_delivery_attempts.error_code, sms_delivery_attempts.updated_at) is distinct from (excluded.provider_message_id, excluded.status, excluded.error_code, excluded.updated_at)
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

  for (const record of changed("userIdentities")) {
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
          where (user_identities.account_id, user_identities.user_id, user_identities.provider_id, user_identities.provider_subject, user_identities.email, user_identities.display_name, user_identities.encrypted_access_token, user_identities.encrypted_refresh_token, user_identities.encrypted_id_token, user_identities.token_type, user_identities.token_expires_at, user_identities.scope, user_identities.updated_at) is distinct from (excluded.account_id, excluded.user_id, excluded.provider_id, excluded.provider_subject, excluded.email, excluded.display_name, excluded.encrypted_access_token, excluded.encrypted_refresh_token, excluded.encrypted_id_token, excluded.token_type, excluded.token_expires_at, excluded.scope, excluded.updated_at)
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
          where (auth_accounts.account_id, auth_accounts.user_id, auth_accounts.provider_id, auth_accounts.provider_subject, auth_accounts.email, auth_accounts.display_name, auth_accounts.updated_at) is distinct from (excluded.account_id, excluded.user_id, excluded.provider_id, excluded.provider_subject, excluded.email, excluded.display_name, excluded.updated_at)
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

  for (const record of changed("oauthSessions")) {
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
          where (oauth_sessions.provider_id, oauth_sessions.account_id, oauth_sessions.state_hash, oauth_sessions.csrf_hash, oauth_sessions.code_challenge, oauth_sessions.encrypted_code_verifier, oauth_sessions.redirect_uri, oauth_sessions.expires_at, oauth_sessions.completed_at) is distinct from (excluded.provider_id, excluded.account_id, excluded.state_hash, excluded.csrf_hash, excluded.code_challenge, excluded.encrypted_code_verifier, excluded.redirect_uri, excluded.expires_at, excluded.completed_at)
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

  for (const record of changed("accountPinHashes")) {
    await client.query(
      `
        insert into account_pin_hashes (account_id, pin_hash, updated_at)
        values ($1, $2, now())
        on conflict (account_id) do update set
          pin_hash = excluded.pin_hash,
          updated_at = now()
          where account_pin_hashes.pin_hash is distinct from excluded.pin_hash
      `,
      [requiredText(record, "accountId"), requiredText(record, "pinHash")]
    );
  }

  for (const record of changed("deviceTrust")) {
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
          where (device_trust.level, device_trust.reason, device_trust.updated_by, device_trust.updated_by_type, device_trust.updated_at) is distinct from (excluded.level, excluded.reason, excluded.updated_by, excluded.updated_by_type, excluded.updated_at)
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
          where (receipt_line_items.receipt_id, receipt_line_items.name, receipt_line_items.quantity, receipt_line_items.unit_price, receipt_line_items.total) is distinct from (excluded.receipt_id, excluded.name, excluded.quantity, excluded.unit_price, excluded.total)
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
  const baseline = edgeRemovalBaselines.get(client);
  if (baseline) {
    const keys: Record<string, keyof Cp2Snapshot> = {
      mcp_access_tokens: "mcpAccessTokens",
      cp2_external_registry_connections: "externalRegistryConnections",
      receipt_line_items: "receiptLineItems",
      payments: "payments",
      purchase_receipts: "purchaseReceipts",
      receipt_ocr_jobs: "receiptOCRJobs",
      supplier_contact_links: "supplierContactLinks",
      oauth_sessions: "oauthSessions",
      auth_accounts: "userIdentities",
      verification_challenges: "otpChallenges",
      sms_delivery_attempts: "smsDeliveryAttempts",
      user_identities: "userIdentities",
      otp_challenges: "otpChallenges",
      sales_agents: "salesAgents",
      suppliers: "suppliers",
      sessions: "sessions",
      business_memberships: "memberships"
    };
    const key = keys[tableName];
    if (!key) throw new Error(`Unsupported scoped deletion table: ${tableName}`);
    const removed = snapshotRecords(baseline[key] ?? [])
      .map((record) => requiredText(record, "id"))
      .filter((id) => !ids.includes(id));
    if (removed.length)
      await client.query(`delete from ${tableName} where id = any($1::uuid[])`, [removed]);
    return;
  }
  await client.query(`delete from ${tableName} where not (id = any($1::uuid[]))`, [ids]);
}

async function deleteMissingAccountPinHashes(
  client: PoolClient,
  records: SnapshotRecord[]
): Promise<void> {
  const accountIds = records.map((record) => requiredText(record, "accountId"));
  const baseline = edgeRemovalBaselines.get(client);
  if (baseline) {
    const removed = baseline.accountPinHashes
      .map((record) => record.accountId)
      .filter((id) => !accountIds.includes(id));
    if (removed.length)
      await client.query("delete from account_pin_hashes where account_id = any($1::uuid[])", [
        removed
      ]);
    return;
  }
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
  const baseline = edgeRemovalBaselines.get(client);
  if (baseline) {
    for (const record of baseline.deviceTrust) {
      if (!keys.includes([record.businessId, record.userId, record.deviceId].join(":"))) {
        await client.query(
          "delete from device_trust where business_id = $1 and user_id = $2 and device_id = $3",
          [record.businessId, record.userId, record.deviceId]
        );
      }
    }
    return;
  }
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
  const baseline = edgeRemovalBaselines.get(client);
  if (baseline) {
    const removed = baseline.invoices
      .map((record) => record.id)
      .filter((id) => !invoiceIds.includes(id));
    if (removed.length) {
      await client.query("delete from invoice_items where invoice_id = any($1::uuid[])", [removed]);
      await client.query("delete from invoices where id = any($1::uuid[])", [removed]);
    }
    return;
  }
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
          where (invoices.source, invoices.source_message_channel, invoices.created_by_user_id, invoices.status, invoices.customer_id, invoices.customer_name, invoices.subtotal, invoices.tax_rate, invoices.tax_total, invoices.total, invoices.confirmed_at, invoices.updated_at) is distinct from (excluded.source, excluded.source_message_channel, excluded.created_by_user_id, excluded.status, excluded.customer_id, excluded.customer_name, excluded.subtotal, excluded.tax_rate, excluded.tax_total, excluded.total, excluded.confirmed_at, excluded.updated_at)
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
            where (invoice_items.invoice_id, invoice_items.product_id, invoice_items.product_name, invoice_items.quantity, invoice_items.unit_price, invoice_items.line_total, invoice_items.unit_weight_grams_snapshot, invoice_items.total_weight_grams, invoice_items.weight_status, invoice_items.weight_unresolved_reason) is distinct from (excluded.invoice_id, excluded.product_id, excluded.product_name, excluded.quantity, excluded.unit_price, excluded.line_total, excluded.unit_weight_grams_snapshot, excluded.total_weight_grams, excluded.weight_status, excluded.weight_unresolved_reason)
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
    grogoniIdHistory: [],
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
    agentSkills: [],
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
    buyerShoppingSessions: [],
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
    grogoniIdentityLinks: [],
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
