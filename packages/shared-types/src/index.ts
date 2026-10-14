export type RuntimeName = "api" | "sync" | "ai-runtime" | "web";

export * from "./commerce-address.js";
export * from "./computer-runtime.js";
export * from "./fulfillment.js";
export * from "./grams.js";
export * from "./phone-number.js";
export * from "./portable-agent.js";
export * from "./runtime-handoff.js";
export * from "./runtime-registry.js";
export * from "./staff.js";
export * from "./store-links.js";
export * from "./workload.js";

import type { OrderSource, WeightStatus, WeightUnresolvedReason } from "./fulfillment.js";
import type { GramsString } from "./grams.js";
import type { PortableAgentManifest } from "./portable-agent.js";

export interface HealthResponse {
  service: RuntimeName;
  status: "ok";
  timestamp: string;
}

export interface EnvironmentConfig {
  runtimeMode: "local" | "production" | "test";
  apiHost: string;
  apiPort: number;
  allowedCorsOrigins: string[];
  databaseUrl: string;
  inferenceRequired: boolean;
  inferenceTimeoutMs: number;
  inferenceOwnerNodeEnabled: boolean;
  inferenceMaxFallbacks: number;
  inferenceJobTimeoutMs: number;
  workspaceDeliveryMaxFileBytes: number;
  workspaceRoot: string;
  redisUrl: string;
  localCacheMode: "memory";
  localInferenceProvider: "ollama";
  ollamaBaseUrl: string;
  ollamaModel: string;
  platformDefaultRuntime: PlatformDefaultRuntimePolicy;
  /** Shared-secret gate for GET /metrics; empty string means the endpoint is unauthenticated. */
  metricsAuthToken: string;
}

/** Deployment policy selects defaults; runtime records and adapters remain independently swappable. */
export interface PlatformDefaultRuntimePolicy {
  agentId: string;
  agentName: string;
  agentRuntimeAdapterId: string;
  modelId: string;
  executionTarget: ModelExecutionTarget;
}

/**
 * Before a shop swaps anything it runs Shopkeeper on Grogoni with GPT-6 Luna through OpenRouter.
 * Local execution remains available through an explicit deployment or shop binding.
 */
export const repositoryDefaultRuntimePolicy: PlatformDefaultRuntimePolicy = {
  agentId: "builtin:shopkeeper:v1",
  agentName: "Shopkeeper",
  agentRuntimeAdapterId: "grogoni",
  modelId: "gpt-6-luna",
  executionTarget: "backend"
};

export type InferenceRuntime =
  "browser-webgpu" | "browser-wasm" | "native-llama-cpp" | "owner-node";

export interface InferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceRequest {
  requestId: string;
  runtimeSessionId?: string;
  tenantId: string;
  conversationId: string;
  agentId: string;
  modelId: string;
  modelVersion?: string;
  messages: InferenceMessage[];
  systemPrompt?: string;
  availableTools?: string[];
  generationParameters?: {
    maxTokens?: number;
    temperature?: number;
  };
  maxTokens?: number;
  temperature?: number;
  taskType?: "conversation" | "reasoning" | "coding" | "verification";
  signal?: AbortSignal;
}

/** Bytes supplied by an authenticated local runtime for a server-validated workspace.deliver. */
export interface ClientWorkspaceFileTransfer {
  path: string;
  contentBase64: string;
  checksum: string;
}

export interface InferenceChunk {
  requestId: string;
  text: string;
  done: boolean;
  runtime: InferenceRuntime;
  modelId: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface InferenceProvider {
  id: string;
  runtime: InferenceRuntime;
  isAvailable(): Promise<boolean>;
  supports(modelId: string): Promise<boolean>;
  generate(request: InferenceRequest): AsyncIterable<InferenceChunk>;
  cancel?(requestId: string): Promise<void>;
}

export type InferenceMemoryClass = "low" | "medium" | "high" | "unknown";

export interface DeviceInferenceCapabilities {
  webgpu: boolean;
  wasm: boolean;
  nativeBridge: boolean;
  ownerNodeReachable: boolean;
  online: boolean;
  estimatedMemoryClass: InferenceMemoryClass;
  hardwareConcurrency?: number;
  cachedModelIds: string[];
}

export interface InferenceRouteDecision {
  providerId: string;
  runtime: InferenceRuntime;
  modelId: string;
  reason: string;
  fallbackProviderIds: string[];
}

export interface InferenceRoutingPolicy {
  priority: InferenceRuntime[];
  maximumFallbacks: number;
  allowNativeBridge: boolean;
  allowOwnerNode: boolean;
  requireCachedBrowserModelWhenOffline: boolean;
  privacyMode: "local-only" | "tenant-devices";
}

export interface InferenceNodePresence {
  nodeId: string;
  tenantId: string;
  userId: string;
  agentIds: string[];
  supportedModelIds: string[];
  runtimes: InferenceRuntime[];
  connectedAt: string;
  lastHeartbeatAt: string;
  maxConcurrentJobs: number;
}

export interface OwnerInferenceJob {
  jobId: string;
  jobToken: string;
  expiresAt: string;
  request: InferenceRequest;
}

export type OwnerInferenceNodeMessage =
  | {
      type: "inference.node.register";
      presence: Omit<InferenceNodePresence, "connectedAt" | "lastHeartbeatAt">;
    }
  | { type: "inference.node.heartbeat"; nodeId: string }
  | {
      type: "inference.job.chunk";
      nodeId: string;
      jobToken: string;
      sequence: number;
      chunk: InferenceChunk;
    };

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  reason: string;
}

export type AuthChannel = "email" | "phone";
export type AccountPrimaryAuthChannel = AuthChannel | "device";
export type AccountIdentityLevel = "device" | "verified_contact" | "strong";

export type OAuthProvider =
  "google" | "facebook" | "apple" | "github" | "microsoft" | "linkedin" | "x" | "tiktok";

export type BusinessRole = "owner" | "manager" | "sales_agent" | "cashier" | "view_only" | "driver";

export type SupportedLanguage = "en" | "sw";

export interface AccountSummary {
  id: string;
  primaryAuthChannel: AccountPrimaryAuthChannel;
  primaryAuthDestination: string;
  identityLevel: AccountIdentityLevel;
  status?: "active" | "locked" | "suspended" | "pending_deletion" | "deleted";
  deletedAt?: string | null;
}

export interface UserSummary {
  id: string;
  accountId: string;
  displayName: string;
  language: SupportedLanguage;
  phoneNumberE164?: string | null;
  phoneCountryCode?: string | null;
  phoneNationalNumber?: string | null;
  phoneVerificationStatus?: "unverified" | "verified" | null;
  phoneAddedAt?: string | null;
  phoneUpdatedAt?: string | null;
  phoneSource?: "phone_login" | "shop_registration" | null;
  publicPhoneEnabled?: boolean;
  emailAddress?: string | null;
  emailVerificationStatus?: "unverified" | "verified" | null;
}

export interface BusinessSummary {
  id: string;
  name: string;
  language: SupportedLanguage;
  grogoniId: string;
  /** IANA timezone (for example `Africa/Nairobi`) for cutoff and "next day" rules. Business data,
   *  never a code default; absent/null until the owner configures it. */
  timezone?: string | null;
}

/**
 * One retired `grogoniId` (docs/architecture/grogoni-id-slug-system.md). `releasedAt` is null while the
 * handle is in its post-rename cooldown (unavailable to any store, resolvable to the business
 * that used to hold it) and gets set once the cooldown job clears it, at which point the handle
 * becomes available for anyone to claim again.
 */
export interface GrogoniIdHistorySummary {
  id: string;
  businessId: string;
  grogoniId: string;
  releasedAt: string | null;
  createdAt: string;
}

/**
 * The one shared result shape every channel (web storefront route, Telegram `/start`, any future
 * channel adapter) resolves a `grogoniId` to - never a second, channel-specific lookup. `null` means
 * the id never existed and never will (not even in history).
 */
export type GrogoniIdResolution =
  | { status: "active"; business: BusinessSummary }
  | { status: "stale"; business: BusinessSummary; redirectTo: string };

export interface PublicCommerceIdentitySummary {
  canonicalBusinessId: string;
  displayName: string;
  commerceAddress: string;
  grogoniId: string;
  storefront: {
    grogoniId: string;
    publicUrlPath: string;
  };
  catalogue: {
    productCount: number;
    searchable: boolean;
  };
  supportedInteractionTypes: Array<"conversation" | "catalogue" | "order">;
  availability: "online" | "private" | "offline";
  entryPoints: Array<{
    type: "storefront" | "conversation";
    href: string;
  }>;
}

export type CommerceIdentityAvailability =
  | { available: true; normalizedAddress: string }
  | { available: false; normalizedAddress: string; reason: "invalid" | "reserved" | "taken" };

export type CommerceIdentityResolution =
  | { status: "active"; identity: PublicCommerceIdentitySummary }
  | { status: "stale"; identity: PublicCommerceIdentitySummary; redirectTo: string };

export interface MembershipSummary {
  id: string;
  businessId: string;
  userId: string;
  role: BusinessRole;
}

export interface SessionSummary {
  id: string;
  expiresAt: string;
  inactivityExpiresAt?: string;
  absoluteExpiresAt?: string;
}

export type AuthBootstrapState =
  | "initializing"
  | "restoring-session"
  | "refreshing-session"
  | "authenticated"
  | "offline-authenticated"
  | "unauthenticated"
  | "reauthentication-required"
  | "failed";

export type DeviceSessionStatus = "active" | "expired" | "revoked";

export interface DeviceSessionSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  browserOrApp: string;
  sessionFamilyId: string;
  status: DeviceSessionStatus;
  createdAt: string;
  lastUsedAt: string;
  rotatedAt: string | null;
  expiresAt: string;
  absoluteExpiresAt?: string;
  revokedAt: string | null;
  revocationReason: string | null;
  current: boolean;
}

export interface AuthBootstrapResponse extends AuthSessionView {
  authenticated: true;
  deviceSession: DeviceSessionSummary;
}

export interface AuthSessionView {
  account: AccountSummary;
  user: UserSummary;
  session: SessionSummary;
  isNewAccount?: boolean;
  deviceRecoveryCredentialId?: string;
}

/** An authenticated account actor whose authority is not tied to a browser session. */
export interface AuthenticatedActorView {
  account: AccountSummary;
  user: UserSummary;
}

export interface PasskeySummary {
  id: string;
  label: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export type GrogoniMode = "marketplace" | "seller";

export type GrogoniChatSurface =
  "conversation" | "storefront" | "catalogue" | "product" | "order" | "receipt" | "owner-controls";

export type ConversationKind = "personal" | "storefront" | "order";

export type ConversationParticipantRole = "account" | "shop" | "agent" | "external";

export type ChannelProvider =
  | "grogoni"
  | "telegram"
  | "whatsapp"
  | "messenger"
  | "instagram"
  | "tiktok"
  | "x"
  | "sms"
  | "native_sms"
  | "email";

export type ConversationProvider = ChannelProvider;

export type ChannelCapability =
  | "CAN_SEND"
  | "CAN_RECEIVE"
  | "CAN_REPLY"
  | "CAN_INITIATE"
  | "REQUIRES_OPT_IN"
  | "REQUIRES_TEMPLATE"
  | "REQUIRES_EXISTING_THREAD"
  | "SUPPORTS_OFFLINE"
  | "REQUIRES_ANDROID_DEVICE"
  | "REQUIRES_SIM"
  | "REQUIRES_SMS_PERMISSION"
  | "REQUIRES_DEFAULT_SMS_ROLE"
  | "SUPPORTS_SUBJECT"
  | "SUPPORTS_THREADS"
  | "SUPPORTS_ATTACHMENTS"
  | "SUPPORTS_MEDIA"
  | "SUPPORTS_PRODUCT_CARD";

export type ChannelEndpointStatus =
  | "available"
  | "unavailable"
  | "authorization_required"
  | "expired"
  | "blocked"
  | "setup_required"
  | "offline"
  | "waiting_for_device"
  | "error";

export type ConversationMessageAuthor = "user" | "agent" | "system";

export type MessageChannel =
  | "grogoni"
  | "sms"
  | "mms"
  | "rcs_business"
  | "whatsapp_business"
  | "telegram"
  | "facebook_messenger"
  | "instagram_messaging"
  | "tiktok_business"
  | "x_dm"
  | "native_sms"
  | "email";

export type MessageComposerChannel =
  "grogoni" | "sms_external_app" | "platform_share_sheet" | "sms_native" | "unsupported";

export type MessageHandoffChannel = "sms_external_app" | "platform_share_sheet";

export type MessageHandoffStatus =
  | "preparing"
  | "composer_opened"
  | "no_sms_app"
  | "invalid_recipient"
  | "cancelled_before_handoff"
  | "native_bridge_unavailable"
  | "share_completed"
  | "share_cancelled"
  | "copied_to_clipboard"
  | "share_unavailable"
  | "unsupported";

export interface MessageHandoffSummary {
  id: string;
  accountId: string;
  businessId: string | null;
  conversationId: string | null;
  channel: MessageHandoffChannel;
  status: MessageHandoffStatus;
  normalizedErrorCode: string | null;
  createdAt: string;
}

export type ConversationMessageDeliveryStatus =
  | "draft"
  | "queued"
  | "sending"
  | "retrying"
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type MessageDeliveryAttemptResult = "succeeded" | "transient_failure" | "permanent_failure";

export type ConversationAttachmentKind = "image" | "pdf" | "text" | "document" | "archive" | "file";

export interface ConversationAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  category: "document" | "image" | "video" | "audio" | "other";
  /** Present only for durable, server-authorized conversation attachments. */
  source?: "managed";
  kind?: ConversationAttachmentKind;
  previewable?: boolean;
  caption?: string;
  /** Historical client attachments use a data URL or HTTPS URL. Managed attachments omit it. */
  url?: string;
}

export interface WorkspaceDeliverResult {
  ok: true;
  delivered: true;
  attachment: ConversationAttachment & {
    source: "managed";
    kind: ConversationAttachmentKind;
    previewable: boolean;
  };
  attachments: Array<
    ConversationAttachment & {
      source: "managed";
      kind: ConversationAttachmentKind;
      previewable: boolean;
    }
  >;
}

export interface ConversationReaction {
  emoji: string;
  actorId: string;
  createdAt: string;
}

export interface E2eePublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext?: boolean;
  key_ops?: string[];
}

export interface E2eeDeviceSummary {
  id: string;
  accountId: string;
  label: string;
  publicKey: E2eePublicKey;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface EncryptedMessageEnvelope {
  version: 1;
  algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM";
  recipientDeviceId: string;
  ephemeralPublicKey: E2eePublicKey;
  salt: string;
  iv: string;
  ciphertext: string;
}

export type ConversationMessageContent =
  | {
      type: "text";
      text: string;
      attachments?: ConversationAttachment[];
      businessTask?: { businessId: string; taskId: string };
    }
  | { type: "product-card"; product: CatalogueProductSummary }
  | {
      type: "encrypted";
      envelopes: EncryptedMessageEnvelope[];
      attachmentCount: number;
      iv: string;
      ciphertext: string;
    }
  | { type: "storefront"; shopId: string }
  | { type: "owner-controls"; shopId: string }
  | {
      type: "confirmation";
      confirmationToken: string;
      prompt: string;
      approvalScope?: {
        businessId: string;
        runtimeSessionId: string;
        conversationId: string | null;
      };
    }
  | { type: "product-capture-progress"; captureJobId: string }
  | { type: "status-broadcast"; statusBroadcastId: string }
  | { type: "unified-checkout"; unifiedCheckoutId: string }
  | { type: "product-management"; businessId: string; productId?: string }
  | { type: "supplier-management"; businessId: string; supplierId?: string }
  | { type: "customer-management"; businessId: string; customerId?: string }
  | { type: "invoice-management"; businessId: string; customerName?: string }
  | { type: "payment-management"; businessId: string; customerName?: string }
  | { type: "import-management"; businessId: string; importJobId?: string }
  | { type: "logistics-management"; businessId: string; customerName?: string };

export interface SupplierOfferReview {
  id: string;
  productId: string;
  productName: string;
  supplierId: string;
  supplierName: string;
  currency: string;
  unit: string;
  unitPriceMinor: number;
  priceIncludesCharges: true;
  minQuantityMilli: number;
  incrementMilli: number;
  availableQuantityMilli: number;
  leadTimeDays: number;
  expiresAt: string;
}

export interface BusinessExecutionTaskView {
  taskId: string;
  businessId: string;
  environmentName: string;
  objective: string;
  status:
    | "CREATED"
    | "READY"
    | "RUNNING"
    | "AWAITING_APPROVAL"
    | "VERIFYING"
    | "COMPLETED"
    | "FAILED"
    | "SUSPENDED"
    | "CANCELLED"
    | "EXPIRED"
    | "INCOMPLETE";
  revision: number;
  verificationStatus: "PASSED" | "FAILED" | "INCONCLUSIVE" | "NOT_VERIFIED";
  budgetMinor: number | null;
  currency: string | null;
  horizonDays: number | null;
  reason: string | null;
  issues: { productName: string | null; message: string }[];
  steps: { id: string; label: string; status: string }[];
  orders: {
    id: string;
    supplierName: string;
    totalMinor: number;
    currency: string;
    submissionStatus: "NOT_SUBMITTED";
    requiresSubmissionApproval: true;
    items: { productName: string; quantityMilli: number; unit: string; totalMinor: number }[];
  }[];
  evaluation: EnvironmentEvaluation | null;
  experienceRetained: boolean | null;
}

export interface AccountShopSummary {
  business: BusinessSummary;
  membership: MembershipSummary;
}

export interface ConversationParticipantSummary {
  id: string;
  conversationId: string;
  role: ConversationParticipantRole;
  accountId: string | null;
  businessId: string | null;
  agentId: string | null;
  externalIdentityId?: string | null;
  displayName?: string | null;
  lastReadAt?: string | null;
  archivedAt?: string | null;
  mutedUntil?: string | null;
  pinnedAt?: string | null;
  createdAt: string;
}

export interface PlatformIdentitySummary {
  id: string;
  provider: ConversationProvider;
  externalUserId: string;
  accountId: string | null;
  customerId: string | null;
  verifiedAt: string | null;
  optInStatus: "unknown" | "granted" | "revoked";
  optInSource: string | null;
  optInAt: string | null;
  optOutAt: string | null;
  businessId: string;
  displayName: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationChannelSummary {
  id: string;
  conversationId: string;
  businessId: string;
  provider: ConversationProvider;
  externalConversationId: string;
  platformIdentityId: string;
  capabilities: ChannelCapability[];
  status: ChannelEndpointStatus;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelEndpointSummary {
  channelId: string;
  conversationId: string;
  businessId: string;
  customerId: string | null;
  channelIdentityId: string;
  provider: ChannelProvider;
  externalUserId: string;
  externalConversationId: string;
  capabilities: ChannelCapability[];
  status: ChannelEndpointStatus;
  configured: boolean;
  authorized: boolean;
  readinessErrorCode?: string | null;
  executionEnvironment?: "server" | "android-device";
  executionDeviceId?: string | null;
  executionMailboxId?: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}

export interface ChannelProviderReadiness {
  provider: ChannelProvider;
  configured: boolean;
  authorized: boolean;
  capabilities: ChannelCapability[];
  status: ChannelEndpointStatus;
  configurationRequirement: string | null;
  readinessErrorCode?: string | null;
}

export interface ChannelSelectionResult {
  endpoint: ChannelEndpointSummary;
  reason:
    | "preferred_channel"
    | "current_conversation_channel"
    | "most_recent_reachable_channel"
    | "grogoni_identity"
    | "eligible_linked_channel";
}

export interface ChannelMessageSendResult {
  message: ConversationMessageSummary;
  selection: ChannelSelectionResult;
}

export type ConnectedMailboxProvider = "gmail" | "outlook";

export type ConnectedMailboxStatus =
  "connected" | "reauthorization_required" | "disconnected" | "error";

export type ConnectedMailboxReadiness =
  "READY" | "REAUTHORIZATION_REQUIRED" | "NOT_CONFIGURED" | "ERROR";

export interface ConnectedMailboxSummary {
  id: string;
  businessId: string;
  address: string;
  provider: ConnectedMailboxProvider;
  providerAccountId: string;
  status: ConnectedMailboxStatus;
  readiness: ConnectedMailboxReadiness;
  canSend: boolean;
  canReceive: boolean;
  isDefault: boolean;
  ingestUnknownSenders: boolean;
  automaticReplyEnabled: boolean;
  automaticReplyText: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  disconnectedAt: string | null;
  updatedAt: string;
}

export interface ConnectedMailboxProviderSummary {
  provider: ConnectedMailboxProvider;
  displayName: string;
  configured: boolean;
  canSend: boolean;
  canReceive: boolean;
}

export interface ConnectedMailboxOAuthStartSummary {
  provider: ConnectedMailboxProvider;
  authorizationUrl: string;
  expiresAt: string;
}

export interface ConnectedMailboxSyncSummary {
  mailbox: ConnectedMailboxSummary;
  fetched: number;
  ingested: number;
  deduplicated: number;
  filtered: number;
}

export interface TrustedMessageAttachmentReference {
  resourceType: "invoice";
  resourceId: string;
}

export type NativeSmsDeviceReadiness =
  "unavailable" | "setup_required" | "ready" | "offline" | "error";

export type NativeSmsDeviceCapability = "native_sms_send" | "native_sms_receive";

export interface NativeSmsDeviceSummary {
  id: string;
  accountId: string;
  sessionFamilyId: string;
  deviceId: string;
  deviceName: string;
  platform: "android";
  executionEnvironment: "android-device";
  capabilities: NativeSmsDeviceCapability[];
  readiness: NativeSmsDeviceReadiness;
  roleAvailable: boolean;
  roleGranted: boolean;
  sendPermissionGranted: boolean;
  receivePermissionGranted: boolean;
  simReady: boolean;
  subscriptionId: number | null;
  preferred: boolean;
  lastSeenAt: string;
  lastErrorCode: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NativeSmsCommandStatus =
  | "queued"
  | "waiting_for_device"
  | "dispatched"
  | "acknowledged"
  | "sending"
  | "completed"
  | "failed"
  | "cancelled";

export type NativeSmsResultCode =
  | "SMS_SENT"
  | "SMS_DELIVERED"
  | "SMS_DEVICE_UNAVAILABLE"
  | "SMS_NO_SERVICE"
  | "SMS_RADIO_OFF"
  | "SMS_SIM_UNAVAILABLE"
  | "SMS_SIM_SELECTION_REQUIRED"
  | "SMS_PERMISSION_REQUIRED"
  | "SMS_ROLE_REQUIRED"
  | "SMS_SEND_FAILED"
  | "SMS_DELIVERY_UNKNOWN";

export interface NativeSmsDeviceCommandSummary {
  id: string;
  accountId: string;
  businessId: string;
  deviceId: string;
  messageId: string;
  type: "native_sms.send";
  recipient: string;
  status: NativeSmsCommandStatus;
  resultCode: NativeSmsResultCode | null;
  carrierReference: string | null;
  createdAt: string;
  expiresAt: string;
  dispatchedAt: string | null;
  acknowledgedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface NativeSmsExecutableCommand extends NativeSmsDeviceCommandSummary {
  text: string;
}

export interface NativeSmsInboundResult {
  device: NativeSmsDeviceSummary;
  customer: CustomerSummary;
  receipt: ProviderUpdateReceiptSummary;
  message: ConversationMessageSummary | null;
  /** Set when this SMS text looked like an order and was reconciled immediately (the merchant's
   *  device is, by definition, online at the moment this ingestion call happens). Null when the
   *  text wasn't order-shaped, or when it was ambiguous and a clarification reply was sent
   *  instead - see services/api/src/cp2/domains/agent-runtime/offline-order-planning.ts. */
  orderIntentOutcome: OfflineOrderIntentOutcome | null;
}

export interface ProviderUpdateReceiptSummary {
  id: string;
  provider: ConversationProvider;
  externalUpdateId: string;
  businessId: string;
  conversationChannelId: string;
  messageId: string | null;
  status: "received" | "processed" | "failed";
  createdAt: string;
  processedAt: string | null;
}

export interface ConversationSummary {
  /** Internal task thread linked to its ordinary owner chat. */
  taskParentConversationId?: string;
  id: string;
  accountId: string;
  kind: ConversationKind;
  activeShopId: string | null;
  /** Durable server-owned runtime selection. Never inferred from frontend state. */
  runtimeBindingId: string | null;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when an admin has moved this conversation to the recycle bin. The conversation is hidden
   * from every normal listing/read but its data is kept until `recycleBinPurgeAt` so it can be
   * restored; a background sweep hard-deletes it once that time passes.
   */
  deletedAt?: string | null;
  deletedByUserId?: string | null;
}

/** A conversation currently sitting in the recycle bin, as shown to an admin. */
export interface RecycleBinItemSummary {
  conversation: ConversationSummary;
  title: string | null;
  deletedAt: string;
  deletedByUserId: string;
  purgeAt: string;
  sizeBytes: number;
}

/**
 * Recycle-bin capacity for one scope (a business, or an account with no business). Capacity is
 * enforced per scope so one busy shop's deletions can't starve another account's recycle bin.
 */
export interface RecycleBinStatusSummary {
  scope: "business" | "account";
  scopeId: string;
  items: RecycleBinItemSummary[];
  usedBytes: number;
  capacityBytes: number;
  isFull: boolean;
}

export interface ConversationMessageSummary {
  id: string;
  conversationId: string;
  clientMessageId: string;
  idempotencyKey: string;
  author: ConversationMessageAuthor;
  authorId: string;
  content: ConversationMessageContent;
  status?: ConversationMessageDeliveryStatus;
  queuedAt?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  failureCode?: string | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  selectedChannel?: MessageChannel;
  actualChannel?: MessageChannel | null;
  providerMessageId?: string | null;
  subject?: string | null;
  externalThreadId?: string | null;
  senderAddress?: string | null;
  recipientAddresses?: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  provider?: ChannelProvider;
  direction?: "inbound" | "outbound";
  externalConversationId?: string | null;
  channelIdentityId?: string | null;
  importedSource?: string | null;
  importedExternalId?: string | null;
  consentRecordId?: string | null;
  editedAt?: string | null;
  deletedAt?: string | null;
  replyToMessageId?: string | null;
  forwardedFromMessageId?: string | null;
  reactions?: ConversationReaction[];
  clientTimestamp: string | null;
  createdAt: string;
}

export interface MessageDeliveryAttemptSummary {
  id: string;
  accountId: string;
  conversationId: string;
  messageId: string;
  channel: MessageChannel;
  provider: string;
  attemptNumber: number;
  requestedAt: string;
  respondedAt: string | null;
  result: MessageDeliveryAttemptResult;
  normalizedFailureCode: string | null;
  providerResponseReference: string | null;
}

export interface ConversationInboxItem extends ConversationSummary {
  lastMessage: ConversationMessageSummary | null;
  unreadCount: number;
  participant: ConversationParticipantSummary;
  /**
   * True when another account participates in this conversation (a person-to-person direct
   * message). False for a "personal" conversation that is the caller's own agent session - the
   * distinction a session-list home screen uses to show agent sessions without DMs mixed in.
   */
  hasHumanRecipient: boolean;
}

export interface ConversationTypingSummary {
  actorId: string;
  displayName: string;
  expiresAt: string;
}

export interface ConversationView {
  conversation: ConversationSummary;
  participants: ConversationParticipantSummary[];
  messages: ConversationMessageSummary[];
  channels?: ChannelEndpointSummary[];
  typing?: ConversationTypingSummary[];
}

export interface PushSubscriptionSummary {
  id: string;
  accountId: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { auth: string; p256dh: string };
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceIntroStateSummary {
  accountId: string;
  userId: string;
  businessId: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/** Stable provider-registry key. Providers are runtime extensions, not a closed platform enum. */
export type ModelProviderId = string;
/** The platform funds Luna within its configured limits. */
export const platformSharedModelId = "gpt-6-luna" as const;
export type ModelCostResponsibility = "platform-included" | "merchant";

/**
 * Whether activating a model costs the merchant nothing: the platform default, and every model
 * served by local Ollama (it runs on the machine running Grogoni; there is no usage bill). Only
 * other models need the merchant to accept costs before activation.
 */
export function isPlatformIncludedModel(model: Pick<AiModelSummary, "id" | "provider">): boolean {
  return (
    model.id === platformSharedModelId || model.id === "smollm2-360m" || model.provider === "ollama"
  );
}

export interface AiModelSummary {
  id: string;
  label: string;
  provider: ModelProviderId;
  description: string;
  capabilities: string[];
  available: boolean;
  source: "huggingface" | "github" | "builtin" | "hosted";
  format: "GGUF" | "remote";
  license: string | null;
  licenseUrl: string | null;
  modelCardUrl: string | null;
  downloadUrl: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  minimumMemoryGb: number | null;
  recommended: boolean;
  /** The shared starter is included; all merchant-selected replacements are merchant-funded. */
  costResponsibility?: ModelCostResponsibility;
  /**
   * Deployment-specific execution targets backed by a configured runtime adapter. Catalogue
   * availability alone does not imply that a model can run on every target.
   */
  runtimeAvailability?: Partial<Record<ModelExecutionTarget, "configured" | "unconfigured">>;
  /**
   * Declared context window in tokens, used to budget retrieved agent context for this model.
   * `null` for models with no fixed, centrally-knowable window: a deterministic non-LLM fallback,
   * or a native bridge model chosen by an installed app that the server cannot introspect.
   */
  contextWindow: number | null;
  /**
   * The provider's own model identifier (e.g. a Hugging Face Hub repo id), kept separate from
   * `id` (Grogoni's internal registry id used for relationships/bindings). `null` when the model has
   * no external provider-specific id (the deterministic fallback, a device-bridge model).
   */
  canonicalModelId?: string | null;
  /**
   * Verified, not assumed: only true when this exact model+provider combination has been confirmed
   * to accept an OpenAI-style `tools` parameter. Never inferred from the base model architecture
   * alone, since a hosted hosting backend can support a model without exposing tool calling for it.
   */
  supportsToolCalling?: boolean;
  /** Verified support for a constrained/structured (e.g. `response_format: json_object`) response. */
  supportsStructuredOutput?: boolean;
  /**
   * Provider routing for models served by the multi-provider inference router
   * (docs/architecture/multi-provider-inference-implementation.md). Absent on every catalog entry
   * that predates the router, which keep their existing Vercel/owner-node execution unchanged. An
   * operator registers a provider-backed model by adding this block through the existing catalog
   * API - there is no second model registry.
   */
  inference?: AiModelInferenceRouting;
  /**
   * The native execution target a configured adapter actually serves this model on, computed per
   * request by GET /v1/ai-models. Clients activate with this value instead of assuming one.
   */
  hostedExecutionTarget?: ModelExecutionTarget;
}

/**
 * Where inference runs from the provider layer's point of view. Separate from
 * ModelExecutionTarget on purpose: "browser-local"/"installed-app" are client-executed and never
 * materialize a native execution host (ADR-device-independent-runtime-and-registry-discovery.md).
 * "remote-inference" is served by the native "backend" target.
 */
export type InferenceExecutionTarget =
  "browser-local" | "installed-app" | "remote-inference" | "remote-shop-device";

export interface InferenceModelCapabilities {
  text: boolean;
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
}

export interface InferenceModelPricing {
  inputPerMillionTokens?: number;
  cachedInputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  currency?: string;
}

export interface AiModelInferenceRouting {
  /** Configured provider instance id (e.g. "local"). Rows naming retired hosted ids never route. */
  providerId: string;
  /** The id sent to the provider API; distinct from the catalog id so hosting can move. */
  providerModelId: string;
  executionTarget: InferenceExecutionTarget;
  capabilities: InferenceModelCapabilities;
  maxOutputTokens?: number | null;
  enabled: boolean;
  pricing?: InferenceModelPricing | null;
}

export type InferenceProviderHealthStatus =
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "MISCONFIGURED"
  | "RATE_LIMITED"
  | "CREDENTIAL_INVALID";

/**
 * Public projection of a configured inference provider. Only the device-local provider remains;
 * hosted providers and BYOK keys were removed with the local-first runtime.
 */
export interface InferenceProviderSummary {
  id: string;
  displayName: string;
  type: "local";
  executionTarget: InferenceExecutionTarget;
  enabled: boolean;
}

/** Which on-device runtime a claiming device offers (see DeviceInferenceJob). */
export type DeviceInferenceRuntime = "browser-local" | "installed-app";

/**
 * One generation the server delegates to the requesting member's own device. The prompt was built
 * by the server exactly as for a hosted model; the device only generates. Returned only to
 * authenticated sessions of the account the turn belongs to.
 */
export interface DeviceInferenceJob {
  id: string;
  /** One-time token required to submit this job's result. */
  token: string;
  turnId: string | null;
  modelId: string;
  /** The on-device engine's model id (a WebLLM prebuilt model id). */
  providerModelId: string;
  executionTarget: DeviceInferenceRuntime;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  generation: { maxOutputTokens: number; temperature: number; jsonOutput: boolean };
  expiresAt: string;
}

export interface DeviceInferenceResultInput {
  token: string;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs?: number;
  firstTokenMs?: number;
}

/** Events on the per-turn reply stream (GET /v1/ai/turn-stream/:turnId). */
export type AgentTurnStreamEvent =
  | { type: "text"; text: string }
  | { type: "reset" }
  | { type: "device"; modelId: string }
  | { type: "done" };

export type InferenceFallbackPolicyMode = "NONE" | "SAME_PROVIDER" | "APPROVED_PROVIDERS";

/** A shop's (or a person's, or the platform's) inference usage policy. */
export interface InferencePolicySummary {
  scope: "global" | "tenant" | "user";
  businessId: string | null;
  currency: string;
  dailyBudget: number | null;
  providerMonthlyCeilings: Record<string, number>;
  maxRequestsPerMinute: number | null;
  maxTokensPerRequest: number | null;
  fallbackPolicy: InferenceFallbackPolicyMode;
  approvedProviderIds: string[];
  fallbackModelIds: string[];
  updatedAt: string | null;
}

export interface ActiveAiModelSummary {
  businessId: string;
  modelId: string;
  activatedAt: string;
  activatedBy: string;
}

export type ModelInstallationStatus =
  "DOWNLOADING" | "INSTALLED" | "CORRUPT" | "REMOVED" | "FAILED";

/**
 * Device-facing projection of artifact, runtime, and binding state. Durable installation and
 * binding records remain separate; this is the single vocabulary shown by model-management UI.
 */
export type ModelLifecycleState =
  | "available"
  | "downloading"
  | "verifying"
  | "installed"
  | "loading_runtime"
  | "activating"
  | "active"
  | "activation_failed"
  | "incompatible"
  | "removing";

export type ModelCompatibilityStatus =
  | "UNKNOWN"
  | "COMPATIBLE"
  | "INCOMPATIBLE"
  | "INSUFFICIENT_MEMORY"
  | "UNSUPPORTED_ARCHITECTURE"
  | "UNSUPPORTED_QUANTIZATION";

export type AgentModelRuntimeBackend =
  "LLAMA_CPP_ANDROID" | "LLAMA_CPP_BROWSER" | "OLLAMA" | "CLOUD";

export type PreferredExecutionMode = "LOCAL_ONLY" | "LOCAL_FIRST" | "CLOUD_ONLY";

export type AgentModelBindingStatus =
  "inactive" | "verifying" | "active" | "failed" | "unavailable";

/**
 * "vercel": Grogoni's hosted inference deployment (the platform default).
 * "backend": Grogoni-operated server-side execution; the multi-provider inference router (OpenAI,
 *   Anthropic, Z.ai, Grogoni-hosted llama.cpp, other OpenAI-compatible servers) runs here.
 * "remote-shop-device": a shop-owned machine registered as an execution host (e.g. a merchant's
 *   laptop running Ollama), brokered by the owner-node protocol.
 * "browser-local" / "installed-app": the model runs on the chatting member's own device (WebLLM in
 *   the browser, or the installed app). Reinstated by ADR-explicit-device-local-models.md as an
 *   explicit, labeled per-shop choice - never a silent fallback. The server still builds the
 *   prompt and owns tools and approvals; only generation is delegated to the device
 *   (services/api/src/inference/device-inference-broker.ts).
 */
export type ModelExecutionTarget =
  "local" | "vercel" | "backend" | "remote-shop-device" | "browser-local" | "installed-app";

export const modelExecutionTargets = [
  "local",
  "vercel",
  "backend",
  "remote-shop-device",
  "browser-local",
  "installed-app"
] as const satisfies readonly ModelExecutionTarget[];

/** Targets whose generation runs on the member's own device rather than a server-reachable host. */
export function isDeviceExecutionTarget(
  target: ModelExecutionTarget
): target is "browser-local" | "installed-app" {
  return target === "browser-local" || target === "installed-app";
}

export function isModelExecutionTarget(value: unknown): value is ModelExecutionTarget {
  return (modelExecutionTargets as readonly unknown[]).includes(value);
}

/** Minimum hardware tier an agent profile requires, independent of execution target. */
export type BrowserDeviceTier = "low" | "medium" | "high";

export interface RuntimeModelDefinition {
  id: string;
  displayName: string;
  provider: string;
  providerModelId: string;
  contextWindow: number;
  enabled: boolean;
}

export const runtimeModels = {
  "qwen2.5-0.5b-android": {
    id: "qwen2.5-0.5b-android",
    displayName: "Qwen2.5 0.5B",
    provider: "ollama",
    providerModelId: "qwen2.5:0.5b",
    contextWindow: 32_768,
    enabled: true
  },
  "qwen2.5-1.5b-android": {
    id: "qwen2.5-1.5b-android",
    displayName: "Qwen2.5 1.5B",
    provider: "ollama",
    providerModelId: "qwen2.5:1.5b",
    contextWindow: 32_768,
    enabled: false
  },
  "smollm2-360m": {
    id: "smollm2-360m",
    displayName: "SmolLM2 360M",
    provider: "ollama",
    providerModelId: "smollm2:360m-instruct-q4_0",
    contextWindow: 8_192,
    enabled: true
  },
  /** Compatibility ID retained for installed clients; new bindings use smollm2-360m. */
  "smollm2-360m-android": {
    id: "smollm2-360m-android",
    displayName: "SmolLM2 360M (legacy ID)",
    provider: "ollama",
    providerModelId: "smollm2:360m-instruct-q4_0",
    contextWindow: 8_192,
    enabled: false
  }
} as const satisfies Record<string, RuntimeModelDefinition>;

export type RuntimeModelId = keyof typeof runtimeModels;

export function resolveRuntimeModel(modelId: string): RuntimeModelDefinition | null {
  return Object.prototype.hasOwnProperty.call(runtimeModels, modelId)
    ? runtimeModels[modelId as RuntimeModelId]
    : null;
}

export interface AgentModelBindingPermissions {
  allowRemoteShopDevice: boolean;
}

export interface AgentModelBindingSummary {
  id: string;
  agentId: string;
  shopId: string;
  accountId: string;
  modelId: string;
  status: AgentModelBindingStatus;
  executionMode: PreferredExecutionMode;
  executionTarget: ModelExecutionTarget;
  permissions: AgentModelBindingPermissions;
  activatedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationStatus: "passed" | "failed" | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ModelRuntimeHealthSummary {
  ok: boolean;
  modelId: string;
  provider: string;
  executionTarget: ModelExecutionTarget;
  latencyMs: number;
  responsePreview: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  checkedAt: string;
}

export interface AgentModelActivationResult {
  binding: AgentModelBindingSummary;
  healthCheck: ModelRuntimeHealthSummary;
}

export interface AgentModelBindingRemovalResult {
  agentId: string;
  shopId: string;
  binding: null;
  removedBindingId: string | null;
}

export interface InstalledAgentModelSummary {
  id: string;
  accountId: string;
  userId: string;
  deviceId: string;
  modelId: string;
  displayName: string;
  provider: "huggingface" | "github" | "custom";
  repositoryId: string | null;
  filename: string;
  format: "GGUF";
  quantization: string | null;
  architecture: string | null;
  parameterCount: number | null;
  contextLength: number | null;
  fileSizeBytes: number;
  checksum: string | null;
  packageManifestVersion?: string | null;
  packageSignature?: string | null;
  packageSigningKeyId?: string | null;
  license: string;
  commercialUseAllowed: boolean;
  storageKey: string;
  runtimeBackend: AgentModelRuntimeBackend;
  installationStatus: ModelInstallationStatus;
  compatibilityStatus: ModelCompatibilityStatus;
  installedAt: string;
  lastVerifiedAt: string | null;
  validationError: string | null;
}

/** A verified OSS-agent manifest saved to an account rather than one browser's localStorage. */
export interface InstalledOssAgentManifestSummary {
  manifestVersion: 1;
  accountId: string;
  userId: string;
  agent: OssAgentSummary;
  portableManifest: PortableAgentManifest;
  installedAt: string;
}

export type CloudModelArtifactStatus = "UPLOADING" | "READY" | "FAILED";

/**
 * Account-scoped GGUF metadata. The artifact bytes are stored in bounded Postgres chunks and are
 * copied into a device's private model directory before local inference.
 */
export interface CloudModelArtifactSummary {
  id: string;
  accountId: string;
  userId: string;
  sourceInstallationId: string;
  modelId: string;
  displayName: string;
  provider: InstalledAgentModelSummary["provider"];
  repositoryId: string | null;
  filename: string;
  format: "GGUF";
  quantization: string | null;
  architecture: string | null;
  parameterCount: number | null;
  contextLength: number | null;
  fileSizeBytes: number;
  checksum: string | null;
  license: string;
  commercialUseAllowed: boolean;
  chunkSizeBytes: number;
  chunkCount: number;
  status: CloudModelArtifactStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentModelReadinessResult {
  success: boolean;
  modelId: string;
  installationId: string;
  backend: AgentModelRuntimeBackend;
  loadDurationMs: number;
  inferenceDurationMs: number;
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  memoryWarning: string | null;
  errorCode: string | null;
  message: string;
  checkedAt: string;
}

export interface GrogoniSessionContext {
  accountId: string;
  userId: string;
  sessionId: string;
  conversationId: string;
  activeShopId: string | null;
  agentId: string;
  activeModelId: string;
  mode: GrogoniMode;
  activeSurface: GrogoniChatSurface;
  permissions: string[];
  sessionVersion: number;
  shops: AccountShopSummary[];
}

export interface StoredGrogoniSessionContext {
  accountId: string;
  sessionId?: string;
  conversationId: string;
  activeShopId: string | null;
  activeModelId: string;
  mode: GrogoniMode;
  activeSurface: GrogoniChatSurface;
  sessionVersion: number;
  updatedAt: string;
}

export interface IdentityProviderSummary {
  id: OAuthProvider;
  displayName: string;
  icon?: string;
  authorizationUrl: string;
  callbackPath?: string;
  tokenUrl: string;
  userInfoUrl: string | null;
  scopes: string[];
  enabled?: boolean;
  pkce: boolean;
}

export interface UserIdentitySummary {
  id: string;
  accountId: string;
  userId: string;
  provider: OAuthProvider;
  providerSubject: string;
  email: string | null;
  displayName: string | null;
  linkedAt: string;
}

export interface OAuthSessionSummary {
  id: string;
  provider: OAuthProvider;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface ProductSummary {
  id: string;
  businessId: string;
  name: string;
  sku: string | null;
  /** Explicit seller-managed lexical aliases (for example, "nyanya" for tomatoes). */
  aliases?: string[];
  primaryMediaId?: string | null;
  unit: string;
  quantity: number;
  buyingPrice: number | null;
  sellingPrice: number | null;
  /** Authoritative mass of ONE sellable unit (a sack, a carton...) in whole grams, as a decimal
   *  string (A22). Absent/null means unknown - never zero. */
  unitWeightGrams?: GramsString | null;
  /** Values for business-defined catalogue fields, keyed by ProductFieldDefinition.id. */
  fieldValues?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type CatalogueAvailability = "available" | "unavailable";

/**
 * Public-safe projection of one canonical product for chat and provider renderers. Buying cost and
 * raw stock quantity are intentionally excluded.
 */
export interface CatalogueProductSummary {
  productId: string;
  businessId: string;
  name: string;
  unit: string;
  sellingPrice: number | null;
  availability: CatalogueAvailability;
  image: string | null;
}

export interface ProductMediaSummary {
  id: string;
  businessId: string;
  productId: string | null;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  fileName: string;
  checksum: string;
  byteLength: number;
  publicUrl: string;
  createdBy: string;
  createdAt: string;
}

/**
 * The only image types camera product capture accepts, online or offline - one constant so the
 * online route (services/api/src/cp2/domains/commerce/routes.ts) and the offline local provider
 * (packages/offline-runtime/providers/local-provider.ts) can never silently drift apart on which
 * types they accept.
 */
export const productCaptureImageContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type ProductCaptureImageContentType = (typeof productCaptureImageContentTypes)[number];

export type ProductCaptureStatus =
  | "CAPTURED"
  | "QUEUED"
  | "VALIDATING"
  | "PREPROCESSING"
  | "EXTRACTION_RUNNING"
  | "FIELDS_EXTRACTED"
  | "DUPLICATE_CHECK"
  | "REVIEW_REQUIRED"
  | "EXTRACTION_FAILED"
  | "CONFIRMED"
  | "PUBLISHED"
  | "CANCELLED";

export interface ProductCaptureField<T> {
  value: T | null;
  source: "vision_extraction" | "seller" | "not_detected";
  confidence: number | null;
}

export type ProductCaptureItemStatus = "pending_review" | "confirmed" | "rejected";

export interface ProductCaptureBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One item on a capture job's photo. Today every job produces exactly one item, mirroring the
 * job-level `fields` below, because no real vision/detection model is wired in yet
 * (`detectionAvailable` on the job is always false) - `boundingBox` stays null and this array
 * exists so the UI and API shape are already multi-item-ready once real detection lands.
 */
export interface ProductCaptureItemSummary {
  id: string;
  fields: {
    title: ProductCaptureField<string>;
    category: ProductCaptureField<string>;
    description: ProductCaptureField<string>;
    visiblePrice: ProductCaptureField<number>;
  };
  boundingBox: ProductCaptureBoundingBox | null;
  status: ProductCaptureItemStatus;
  confirmedProductId: string | null;
}

export interface ProductCaptureJobSummary {
  id: string;
  businessId: string;
  uploadedBy: string;
  status: ProductCaptureStatus;
  statusHistory: Array<{ status: ProductCaptureStatus; at: string }>;
  sourceFileName: string;
  contentType: string;
  sourceChecksum: string;
  temporaryMediaId: string | null;
  fields: {
    title: ProductCaptureField<string>;
    category: ProductCaptureField<string>;
    description: ProductCaptureField<string>;
    visiblePrice: ProductCaptureField<number>;
  };
  /**
   * Whether a real vision/detection model produced these items. Always false today - see the
   * ProductCaptureItemSummary doc comment. The frontend must render this honestly ("detection
   * isn't available - review manually"), never fabricate pins when this is false.
   */
  detectionAvailable: boolean;
  items: ProductCaptureItemSummary[];
  possibleDuplicateProductIds: string[];
  failureCode: string | null;
  failureMessage: string | null;
  retryCount: number;
  publishedProductId: string | null;
  keepImageAsProductMedia: boolean;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  publishedAt: string | null;
  cancelledAt: string | null;
}

export interface CatalogueQueryResult {
  query: string;
  products: CatalogueProductSummary[];
  total: number;
}

export type ProductFieldInputType = "text" | "number" | "select" | "textarea" | "yes_no";

export interface ProductFieldDefinition {
  id: string;
  label: string;
  inputType: ProductFieldInputType;
  required: boolean;
}

export interface ProductFieldSchemaSummary {
  businessId: string;
  fields: ProductFieldDefinition[];
  updatedAt: string;
}

export interface CustomerSummary {
  id: string;
  businessId: string;
  name: string;
  phone: string | null;
  email: string | null;
  linkedAccountId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NetworkSyncSourceType = "phone_contact" | "social";

export type NetworkEdgeSourceType =
  "phone_contact" | "social_follow" | "social_interaction" | "imported_contact" | "agent_route";

export type NetworkVisibilityStatus = "direct" | "agent_mediated" | "private";

export type NetworkConsentStatus =
  "granted" | "pending" | "agent_required" | "rejected" | "revoked";

export type NetworkNodeKind =
  "grogoni_user" | "grogoni_shop" | "external_contact" | "external_social";

export type SocialNetworkProvider =
  | "facebook"
  | "instagram"
  | "whatsapp"
  | "tiktok"
  | "x"
  | "linkedin"
  | "google"
  | "microsoft"
  | "github"
  | "apple";

export interface ContactHashSummary {
  id: string;
  ownerUserId: string;
  hashType: "phone" | "email" | "social";
  hashValue: string;
  displayHint: string | null;
  createdAt: string;
}

/**
 * Distinguishes how an identity fact (an external identity, or a Grogoni-account link) entered the
 * phonebook, per docs/architecture/phonebook-identity-resolution.md - "user_entered" (the owner
 * typed it themselves), "imported" (came in through a phone/social contact sync), "observed" (a
 * ComputerRuntime browsing session saw it while completing some other task - never trusted enough
 * to auto-attach, always starts life as a pending IdentityCandidateSummary), or "verified" (came
 * through an OAuth-authenticated provider connection, i.e. syncConnectedSocialProvider).
 */
export type IdentityProvenance = "user_entered" | "imported" | "observed" | "verified";

export interface ExternalIdentitySummary {
  id: string;
  ownerUserId: string;
  provider: string;
  providerSubjectHash: string;
  displayName: string;
  handle: string | null;
  provenance: IdentityProvenance;
  createdAt: string;
}

export interface GrogoniIdentityLinkSummary {
  id: string;
  ownerUserId: string;
  nodeId: string;
  linkedUserId: string | null;
  linkedBusinessId: string | null;
  linkedAgentId: string | null;
  confidence: number;
  provenance: IdentityProvenance;
  createdAt: string;
}

/**
 * A connection between two Grogoni users, discovered through one side's phonebook. One record per
 * pair: whoever asked first is the requester. See docs/architecture/phonebook-identity-resolution.md.
 */
export type NetworkConnectionStatus = "pending" | "accepted" | "declined";

/**
 * One user's discovery spending in the last 24 hours (NetworkDomain's daily budget of numbers
 * asked about). Persisted so a restart does not reset it. `id` is the user id: one record each.
 */
export interface DiscoveryBudgetRecord {
  id: string;
  userId: string;
  entries: Array<{ at: string; count: number }>;
}

export interface NetworkConnectionRecord {
  id: string;
  requesterUserId: string;
  recipientUserId: string;
  status: NetworkConnectionStatus;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  /** Set when the requester cancels a request that was already declined; hides it from them. */
  requesterWithdrawnAt?: string | null;
}

/**
 * Viewer-relative projection of a NetworkConnectionRecord. A declined request is reported to its
 * requester as "pending" (the recipient's decision is private), and is never listed for the
 * recipient, so the recipient can still connect later.
 */
export interface NetworkConnectionSummary {
  id: string;
  status: NetworkConnectionStatus;
  direction: "outgoing" | "incoming";
  counterpartUserId: string;
  counterpartDisplayName: string;
  counterpartBusinessName: string | null;
  counterpartGrogoniId: string | null;
  /** The viewer's own phonebook node for the counterpart, when they have one. */
  nodeId: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}

export type IdentityCandidateStatus = "pending" | "confirmed" | "rejected";

/**
 * A proposed-but-unconfirmed identity fact, produced by an external observation (today: a
 * ComputerRuntime browsing session reading untrusted web content) rather than an imported sync or
 * a verified OAuth connection. Never mutates the canonical phonebook by itself - `nodeId` is only
 * a best-effort guess at which existing contact this might be (null when no confident guess
 * exists), and the identity is only attached to a node once the owner calls
 * NetworkDomain.confirmIdentityCandidate, which is the one place "observed" data is allowed to
 * become a real ExternalIdentitySummary. See docs/architecture/phonebook-identity-resolution.md.
 */
export interface IdentityCandidateSummary {
  id: string;
  ownerUserId: string;
  nodeId: string | null;
  provider: string;
  providerSubject: string;
  providerSubjectHash: string;
  displayName: string;
  handle: string | null;
  evidence: string;
  confidence: number;
  status: IdentityCandidateStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export type ContactResolutionMatchType = "phone" | "email" | "handle" | "name";

export interface ContactResolutionMatchSummary {
  node: NetworkNodeSummary;
  matchType: ContactResolutionMatchType;
  confidence: number;
}

export interface ContactResolutionSummary {
  query: string;
  matches: ContactResolutionMatchSummary[];
}

export interface NetworkNodeSummary {
  id: string;
  ownerUserId: string;
  kind: NetworkNodeKind;
  displayName: string;
  degree: 0 | 1 | 2;
  sourceId: string | null;
  sourceType: NetworkSyncSourceType | "owner" | "manual";
  sourcePlatform: string | null;
  grogoniUserId: string | null;
  grogoniBusinessId: string | null;
  grogoniAgentId: string | null;
  contactHashIds: string[];
  externalIdentityIds: string[];
  visibilityStatus: NetworkVisibilityStatus;
  consentStatus: NetworkConsentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkEdgeSummary {
  id: string;
  ownerUserId: string;
  sourceType: NetworkEdgeSourceType;
  sourcePlatform: string | null;
  fromNodeId: string;
  toNodeId: string;
  degree: 1 | 2;
  trustWeight: number;
  interactionWeight: number;
  visibilityStatus: NetworkVisibilityStatus;
  consentStatus: NetworkConsentStatus;
  createdAt: string;
  updatedAt: string;
}

export type StatusBroadcastLifecycleState = "active" | "expired" | "cancelled";

export type StatusBroadcastDeliveryChannel = "in_app" | "share_sheet_pending";

export interface StatusBroadcastItemSummary {
  productCaptureItemId: string;
  title: string;
  visiblePrice: number | null;
  image: string | null;
}

export interface StatusBroadcastRecipientSummary {
  networkNodeId: string;
  displayName: string;
  deliveryChannel: StatusBroadcastDeliveryChannel;
  viewedAt: string | null;
  repliedAt: string | null;
}

/**
 * A distinct, trackable commerce object posted from a confirmed product capture to a chosen set
 * of contacts - not a plain chat message (direct conversations between two human accounts must be
 * end-to-end encrypted, which a server-composed status card cannot honestly satisfy). Recipients
 * matched to an existing Grogoni account (`deliveryChannel: "in_app"`) can discover it by querying
 * their own received statuses; unmatched phone contacts (`"share_sheet_pending"`) are handed off
 * through the OS share sheet client-side, so their delivery is never claimed as guaranteed the way
 * in-app discovery is.
 */
export interface StatusBroadcastSummary {
  id: string;
  businessId: string;
  postedBy: string;
  sourceCaptureJobId: string;
  items: StatusBroadcastItemSummary[];
  recipients: StatusBroadcastRecipientSummary[];
  state: StatusBroadcastLifecycleState;
  createdAt: string;
  expiresAt: string;
  viewCount: number;
  replyCount: number;
  resultingOrderIds: string[];
}

/**
 * A phone contact eligible to receive a status broadcast. `defaultSelected` is true only for
 * contacts who are both a matched Grogoni account and an existing customer of this business - the
 * picker must never default to selecting every candidate.
 */
export interface StatusBroadcastCandidateSummary {
  networkNodeId: string;
  displayName: string;
  isGrogoniUser: boolean;
  isExistingCustomer: boolean;
  defaultSelected: boolean;
}

export type BuyResultSourceKind = "contact" | "catalogue" | "marketplace_connector";

/**
 * One flattened, rankable buy result regardless of where it came from - a contact's active
 * status or a business's public catalogue. `marketplace_connector` results never appear today
 * (no connector is integrated); see BuyFeedSummary.marketplaceConnectorAvailable.
 */
export interface BuyResultSummary {
  id: string;
  title: string;
  price: number | null;
  image: string | null;
  sourceKind: BuyResultSourceKind;
  sourceLabel: string;
  sourceId: string;
  agentId: string | null;
  productId: string | null;
  statusBroadcastId: string | null;
  productCaptureItemId: string | null;
}

/**
 * `marketplace_connector` results are never fabricated - `marketplaceConnectorAvailable` is
 * always false today since no marketplace connector is integrated, matching
 * ProductCaptureJobSummary.detectionAvailable's honesty convention from the sell flow.
 */
export interface BuyFeedSummary {
  query: string;
  results: BuyResultSummary[];
  marketplaceConnectorAvailable: boolean;
}

export type HandoffOrderStatus = "requested" | "accepted" | "rejected" | "completed" | "cancelled";

export interface BuyOrderItemSummary {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
}

/**
 * The authenticated-buyer equivalent of PublicOrderSummary, for catalogue-sourced checkout items.
 * PublicOrderSummary is guest-shaped (capabilityToken, visitorId) for the existing single-shop
 * storefront-visit flow; this is deliberately separate, not a variant of it.
 */
export interface BuyOrderSummary {
  id: string;
  businessId: string;
  buyerAccountId: string;
  invoiceId: string;
  items: BuyOrderItemSummary[];
  status: HandoffOrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StatusOrderItemSummary {
  productCaptureItemId: string;
  title: string;
  price: number | null;
  quantity: number;
}

/**
 * A pickup request against a contact's status broadcast. Contacts are not businesses and have no
 * invoice/payment machinery, so unlike BuyOrderSummary this carries no invoiceId - payment is
 * handled directly between buyer and seller-contact, out of band, the same way a real-world
 * peer sale would be. Its id is pushed into the source StatusBroadcastSummary's
 * `resultingOrderIds`.
 */
export interface StatusOrderSummary {
  id: string;
  statusBroadcastId: string;
  buyerAccountId: string;
  items: StatusOrderItemSummary[];
  status: HandoffOrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedCheckoutHandoffSummary {
  kind: "catalogue" | "contact";
  sourceLabel: string;
  orderId: string;
  status: HandoffOrderStatus;
}

/** An item that could not be ordered at checkout - surfaced to the buyer, never silently dropped. */
export interface UnifiedCheckoutFailureSummary {
  sourceLabel: string;
  title: string;
  reason: string;
}

/**
 * Correlates every order a single checkout action fanned out into - one per distinct source, not
 * one per item, and one real payment rail (none - see BuyOrderSummary/StatusOrderSummary docs).
 */
export interface UnifiedCheckoutSummary {
  id: string;
  buyerAccountId: string;
  handoffs: UnifiedCheckoutHandoffSummary[];
  failures: UnifiedCheckoutFailureSummary[];
  createdAt: string;
  /** Durable idempotency key (durable-execution-plane.md "Idempotency"), scoped to `buyerAccountId`
   *  by `CommerceDomain.createUnifiedCheckout`. Null for a checkout created without one (e.g. the
   *  direct storefront "Buy" UI, which has its own client-side double-submit guard). A confirmed
   *  runtime action's stable `action.id` is used as this key when checkout is reached through the
   *  `commerce.checkout` capability, so a resumed/retried task never creates a second order for the
   *  same confirmed action. */
  idempotencyKey?: string | null;
}

export interface BuyCheckoutItemInput {
  sourceKind: BuyResultSourceKind;
  sourceId: string;
  sourceLabel: string;
  title: string;
  quantity: number;
  agentId: string | null;
  productId: string | null;
  statusBroadcastId: string | null;
  productCaptureItemId: string | null;
}

export interface ContactSyncSourceSummary {
  id: string;
  ownerUserId: string;
  sourceType: "phone_contact";
  sourcePlatform: "phone";
  displayName: string;
  importedCount: number;
  directCount: number;
  extendedCount: number;
  status: "active" | "disconnected";
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export interface SocialSyncSourceSummary {
  id: string;
  ownerUserId: string;
  sourceType: "social";
  sourcePlatform: SocialNetworkProvider;
  displayName: string;
  importedCount: number;
  directCount: number;
  extendedCount: number;
  status: "active" | "disconnected";
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export type NetworkSyncSourceSummary = ContactSyncSourceSummary | SocialSyncSourceSummary;

export interface NetworkPermissionSummary {
  id: string;
  ownerUserId: string;
  routeId: string;
  fromNodeId: string;
  toNodeId: string;
  status: NetworkConsentStatus;
  createdAt: string;
  updatedAt: string;
}

export type AgentRouteStatus =
  "pending_permission" | "forwarded" | "suggested" | "blocked" | "approved" | "rejected";

export interface AgentRouteSummary {
  id: string;
  ownerUserId: string;
  requestText: string;
  status: AgentRouteStatus;
  directNodeId: string;
  targetNodeId: string;
  viaAgentLabel: string;
  path: string[];
  permissionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkGraphSummary {
  ownerUserId: string;
  generatedAt: string;
  nodes: NetworkNodeSummary[];
  edges: NetworkEdgeSummary[];
  sources: NetworkSyncSourceSummary[];
  routes: AgentRouteSummary[];
  permissions: NetworkPermissionSummary[];
  identityLinks: GrogoniIdentityLinkSummary[];
  identityCandidates: IdentityCandidateSummary[];
  connections?: NetworkConnectionSummary[];
  /**
   * Only on a phonebook sync response: the phonebook node each submitted contact landed on, in
   * submission order (null when a contact was not stored). Lets the device pair its raw contacts,
   * which never leave the device beyond this sync, with server-side discovery results.
   */
  syncedContactNodeIds?: Array<string | null>;
}

export interface SupplierSummary {
  id: string;
  businessId: string;
  name: string;
  phone: string | null;
  linkedPhonebookContactId: string | null;
  linkedPhonebookContactName: string | null;
  email: string | null;
  notes: string | null;
  salesAgentCount: number;
  purchaseReceiptCount: number;
  lastPurchaseDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesAgentSummary {
  id: string;
  businessId: string;
  supplierId: string;
  supplierName: string;
  name: string;
  phone: string | null;
  linkedPhonebookContactId: string | null;
  linkedPhonebookContactName: string | null;
  notes: string | null;
  receiptsHandled: number;
  lastTransactionDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SupplierContactLinkType = "supplier" | "sales_agent";

export interface SupplierContactLinkSummary {
  id: string;
  businessId: string;
  linkType: SupplierContactLinkType;
  supplierId: string | null;
  salesAgentId: string | null;
  networkNodeId: string;
  contactName: string;
  linkedAt: string;
}

export interface ReceiptLineItemSummary {
  id: string;
  receiptId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface PurchaseReceiptSummary {
  id: string;
  businessId: string;
  supplierId: string;
  supplierName: string;
  salesAgentId: string | null;
  salesAgentName: string | null;
  receiptDate: string;
  total: number;
  sourceFileName: string | null;
  ocrJobId: string | null;
  imageStored: boolean;
  createdAt: string;
  lineItems: ReceiptLineItemSummary[];
}

/**
 * Generic OCR capability shared by receipt parsing, chat document extraction, and camera product
 * capture - not receipt-specific. See services/api/src/cp2/ocr-provider.ts.
 */
export type OcrEngine = "paddleocr" | "tesseract";
export type OcrProfile = "mobile" | "balanced" | "accurate";

export type ReceiptOCRJobStatus =
  | "UPLOADED"
  | "QUEUED"
  | "VALIDATING"
  | "PREPROCESSING"
  | "OCR_RUNNING"
  | "FIELDS_EXTRACTED"
  | "CONTACT_MATCHING"
  | "PARSING"
  | "MATCHING"
  | "REVIEW_REQUIRED"
  | "CONFIRMED"
  | "PURCHASE_RECORDED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "CLEANUP_PENDING"
  | "IMAGE_DELETED"
  | "pending"
  | "matched"
  | "needs_review"
  | "failed"
  | "confirmed";

export interface OcrBlockSummary {
  id: string;
  page: number;
  text: string;
  confidence: number;
  boundingBox: Array<{ x: number; y: number }> | null;
}

export interface ReceiptFieldEvidenceSummary {
  field: string;
  value: string | number | null;
  confidence: number;
  sourceText: string | null;
}

export interface ReceiptMatchCandidateSummary {
  id: string;
  entityType: "supplier" | "sales_agent" | "contact";
  recordId: string | null;
  contactId: string | null;
  displayName: string;
  name: string;
  confidence: number;
  matchedBy: string[];
  sources: string[];
  requiresConfirmation: boolean;
  reason: string;
  sourceProvider: string | null;
}

export interface ReceiptStructuredExtractionSummary {
  supplier: {
    supplierName: string | null;
    tradingName: string | null;
    legalName: string | null;
    phoneNumber: string | null;
    alternatePhoneNumber: string | null;
    email: string | null;
    physicalAddress: string | null;
    taxPin: string | null;
    registrationNumber: string | null;
    branch: string | null;
    accountNumber: string | null;
  };
  salesAgent: {
    name: string | null;
    phoneNumber: string | null;
    email: string | null;
    agentNumber: string | null;
    supplierRepresented: string | null;
    branch: string | null;
    notes: string | null;
  };
  receipt: {
    receiptNumber: string | null;
    invoiceNumber: string | null;
    orderNumber: string | null;
    purchaseDate: string | null;
    purchaseTime: string | null;
    currency: string | null;
    subtotal: number | null;
    discount: number | null;
    tax: number | null;
    total: number | null;
    amountPaid: number | null;
    balance: number | null;
    paymentMethod: string | null;
    tillNumber: string | null;
    paybillNumber: string | null;
    transactionReference: string | null;
  };
  products: Array<{
    itemName: string;
    itemCode: string | null;
    sku: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number;
    lineTotal: number;
    batchNumber: string | null;
    expiryDate: string | null;
  }>;
}

export interface ReceiptContactEntityMatchSummary {
  extractedName: string | null;
  extractedPhone: string | null;
  extractedEmail: string | null;
  selectedRecordId: string | null;
  selectedContactId: string | null;
  confidence: number;
  matchedBy: string[];
  sources: string[];
  requiresConfirmation: boolean;
  candidates: ReceiptMatchCandidateSummary[];
}

export interface ReceiptContactMatchingResultSummary {
  matched: boolean;
  scriptId: "receipt_contact_matching";
  intent: "RECEIPT_CONTACT_MATCH";
  source: "context_script";
  ocrJobId: string;
  supplier: ReceiptContactEntityMatchSummary;
  salesAgent: ReceiptContactEntityMatchSummary;
  unmatchedFields: string[];
  warnings: string[];
  thresholds: {
    autoSelect: number;
    confirmationRequired: number;
    rejectBelow: number;
  };
}

export interface ReceiptOCRJobSummary {
  id: string;
  businessId: string;
  tenantId: string;
  shopId: string;
  uploadedBy: string;
  status: ReceiptOCRJobStatus;
  sourceFileName: string;
  contentType: string;
  engine: OcrEngine;
  engineVersion: string;
  modelVersion: string;
  profile: OcrProfile;
  fallbackUsed: boolean;
  languageHints: string[];
  blocks: OcrBlockSummary[];
  fullText: string;
  averageConfidence: number;
  warnings: string[];
  fieldEvidence: ReceiptFieldEvidenceSummary[];
  structuredExtraction: ReceiptStructuredExtractionSummary;
  contactMatchingResult: ReceiptContactMatchingResultSummary;
  supplierCandidates: ReceiptMatchCandidateSummary[];
  salesAgentCandidates: ReceiptMatchCandidateSummary[];
  supplierName: string | null;
  salesAgentName: string | null;
  phone: string | null;
  receiptDate: string | null;
  total: number | null;
  items: Array<{
    name: string;
    quantity: number;
    unit?: string | null;
    itemCode?: string | null;
    sku?: string | null;
    unitPrice: number;
    total: number;
    batchNumber?: string | null;
    expiryDate?: string | null;
  }>;
  matchedSupplierId: string | null;
  matchedSalesAgentId: string | null;
  errorMessage: string | null;
  failureCode: string | null;
  imageStorageKey: string | null;
  imageHash: string | null;
  imageRetained: boolean;
  imageDeletedAt: string | null;
  cleanupPending: boolean;
  retryCount: number;
  processingStartedAt: string | null;
  completedAt: string | null;
  temporaryImageExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface SupplierBusinessCardSummary extends SupplierSummary {
  salesAgents: SalesAgentSummary[];
  purchaseReceipts: PurchaseReceiptSummary[];
}

export type InvoiceStatus = "draft" | "confirmed";

export interface InvoiceItemSummary {
  id: string;
  invoiceId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** Weight snapshot taken when the invoice is confirmed; later catalogue edits never change it.
   *  All absent on drafts and on lines confirmed before snapshots existed. */
  unitWeightGramsSnapshot?: GramsString | null;
  totalWeightGrams?: GramsString | null;
  weightStatus?: WeightStatus | null;
  weightUnresolvedReason?: WeightUnresolvedReason | null;
}

export interface InvoiceTotals {
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  total: number;
}

export interface InvoiceSummary extends InvoiceTotals {
  id: string;
  businessId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  customerId: string | null;
  customerName: string | null;
  items: InvoiceItemSummary[];
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Phase 1c order provenance. Absent/null on invoices created before it existed. */
  source?: OrderSource | null;
  sourceMessageChannel?: MessageChannel | null;
  /** The business member who created the order; null for buyer- or guest-created orders. */
  createdByUserId?: string | null;
}

export interface InvoicePreview extends InvoiceTotals {
  businessId: string;
  customerId: string | null;
  customerName: string | null;
  items: Omit<
    InvoiceItemSummary,
    "id" | "invoiceId" | "unitWeightGramsSnapshot" | "totalWeightGrams" | "weightStatus"
  >[];
}

export type PaymentMethod =
  "cash" | "bank_transfer" | "mobile_money_manual" | "card_manual" | "other_manual";

export type InvoicePaymentStatus = "unpaid" | "partially_paid" | "paid";

export interface PaymentSummary {
  id: string;
  businessId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string | null;
  method: PaymentMethod;
  amount: number;
  reference: string | null;
  note: string | null;
  actorId: string;
  createdAt: string;
}

export interface InvoicePaymentSummary {
  invoiceId: string;
  businessId: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string | null;
  invoiceTotal: number;
  paidTotal: number;
  balanceDue: number;
  status: InvoicePaymentStatus;
}

export type FulfillmentMethod = "delivery" | "pickup";

export type FulfillmentStatus =
  "pending" | "ready" | "out_for_delivery" | "completed" | "cancelled";

export interface LogisticsSummary {
  id: string;
  businessId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string | null;
  method: FulfillmentMethod;
  status: FulfillmentStatus;
  destination: string | null;
  note: string | null;
  actorId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export type ContactSource = "PHONEBOOK" | "EMAIL" | "SOCIAL" | "MANUAL" | "GROGONI_ACCOUNT";

export interface CanonicalContactSummary {
  id: string;
  businessId: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  phones: string[];
  emails: string[];
  externalIdentities: Array<{ provider: string; externalId: string }>;
  source: ContactSource;
  sourceExternalId: string | null;
  avatarRef: string | null;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  linkedAccountId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
}

export type SupplierContactRole =
  "OWNER" | "SALES_AGENT" | "DELIVERY_AGENT" | "DRIVER" | "ACCOUNT_MANAGER" | "OTHER";

export interface SupplierContactRelationshipSummary {
  id: string;
  businessId: string;
  supplierId: string;
  // Null only for a SALES_AGENT relationship backed by a supplier sales agent that predates
  // (or was created outside) contact-sync import and therefore has no canonical contact yet.
  contactId: string | null;
  role: SupplierContactRole;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationSummary {
  id: string;
  businessId: string;
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  region: string | null;
  country: string | null;
  providerPlaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryRouteStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface DeliveryRouteStopSummary {
  id: string;
  routeId: string;
  sequence: number;
  locationId: string;
  contactId: string | null;
  arrivalAt: string | null;
  departureAt: string | null;
  deliveredAt: string | null;
}

export interface DeliveryRouteSummary {
  id: string;
  businessId: string;
  originLocationId: string;
  destinationLocationId: string;
  status: DeliveryRouteStatus;
  provider: string;
  externalRouteId: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  geometry: string | null;
  externalSourceId: string | null;
  createdAt: string;
  updatedAt: string;
  stops: DeliveryRouteStopSummary[];
}

export interface ProductPurchasePriceSummary {
  id: string;
  businessId: string;
  productId: string;
  productNameSnapshot: string;
  supplierId: string | null;
  supplierNameSnapshot: string | null;
  supplierContactId: string | null;
  contactNameSnapshot: string | null;
  price: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  deliveredAt: string | null;
  purchaseRecordId: string | null;
  createdBy: string;
  source: "MANUAL" | "PURCHASE" | "LEGACY_BACKFILL";
  createdAt: string;
  supersedesId: string | null;
}

export interface PurchaseRecordSummary {
  id: string;
  businessId: string;
  supplierId: string;
  supplierNameSnapshot: string;
  supplierContactId: string | null;
  contactNameSnapshot: string | null;
  productId: string;
  productNameSnapshot: string;
  quantity: number;
  unit: string;
  buyingPrice: number;
  currency: string;
  totalCost: number;
  deliveredAt: string | null;
  effectiveAt: string;
  recordedBy: string;
  source: string;
  notes: string | null;
  routeId: string | null;
  locationId: string | null;
  externalSourceId: string | null;
  createdAt: string;
}

export interface SaleRecordSummary {
  id: string;
  businessId: string;
  invoiceId: string;
  customerId: string | null;
  customerNameSnapshot: string | null;
  customerContactId: string | null;
  contactNameSnapshot: string | null;
  items: InvoiceItemSummary[];
  total: number;
  currency: string;
  soldAt: string;
  routeId: string | null;
  recordedBy: string;
  externalSourceId: string | null;
  createdAt: string;
}

export interface LogisticsReportSummary {
  fulfillmentCount: number;
  pendingCount: number;
  readyCount: number;
  outForDeliveryCount: number;
  completedCount: number;
  cancelledCount: number;
  activeCount: number;
}

export type DataExportStatus = "ready";

export interface DataExportBundleSummary {
  id: string;
  businessId: string;
  accountId: string;
  actorId: string;
  status: DataExportStatus;
  recordCounts: Record<string, number>;
  checksum: string;
  createdAt: string;
}

export interface DataExportBundle extends DataExportBundleSummary {
  data: {
    account: AccountSummary;
    user: UserSummary;
    business: BusinessSummary;
    memberships: MembershipSummary[];
    products: ProductSummary[];
    customers: CustomerSummary[];
    suppliers: SupplierSummary[];
    invoices: InvoiceSummary[];
    payments: PaymentSummary[];
    logistics: LogisticsSummary[];
    documentImports: DocumentImportJobSummary[];
    notifications: BusinessNotificationSummary[];
    inventoryMovements: InventoryMovementSummary[];
    auditEvents: Array<{
      id: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      actorId: string;
      occurredAt: string;
      risk: string;
    }>;
  };
}

export type AccountDeletionStatus =
  | "scheduled"
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "QUEUED"
  | "RUNNING"
  | "QUARANTINED"
  | "RESTORED"
  | "PURGED"
  | "COMPLETED"
  | "PARTIALLY_FAILED"
  | "FAILED"
  | "CANCELLED";

export interface ComplianceRetentionSummary {
  businessId: string;
  retainedInvoiceCount: number;
  retainedPaymentCount: number;
  retainedLogisticsCount: number;
  retainedImportCount: number;
  retainedAuditEventCount: number;
  directIdentifierFieldsRemoved: number;
}

export interface AccountDeletionRequestSummary {
  id: string;
  accountId: string;
  userId: string;
  businessId: string;
  actorId: string;
  status: AccountDeletionStatus;
  reason: string | null;
  requestedAt: string;
  requestedByUserId?: string;
  reauthenticatedAt?: string | null;
  otpVerifiedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failureReason?: string | null;
  auditReference?: string | null;
  idempotencyKey?: string | null;
  deactivatedAt: string;
  anonymizeAfter: string;
  retention: ComplianceRetentionSummary;
}

export type ShopPresenceStatus = "online" | "private" | "offline";

export interface ShopPresenceSummary {
  businessId: string;
  status: ShopPresenceStatus;
  /** Owner opt-in: when true, other shops can browse and duplicate this shop's catalogue. */
  catalogueShareable: boolean;
  updatedBy: string;
  updatedAt: string;
}

export type PublicShopPresenceSummary = Pick<ShopPresenceSummary, "status" | "updatedAt">;

/** A shop whose owner opted its catalogue in to being browsed and duplicated by other shops. */
export interface ShareableCatalogueSummary {
  businessId: string;
  grogoniId: string;
  businessName: string;
  productCount: number;
  updatedAt: string;
}

/**
 * A product's shareable projection for catalogue duplication - deliberately as narrow as
 * PublicStorefrontProductSummary (no sku, buyingPrice, aliases, or fieldValues) since it is
 * another shop's private inventory data, not this shop's own.
 */
export interface ShareableCatalogueProductSummary {
  id: string;
  name: string;
  unit: string;
  sellingPrice: number | null;
  image: string | null;
}

export type NetworkInviteChannel = "phone" | "email";
export type NetworkInviteStatus = "queued" | "sent" | "failed";

export interface NetworkInviteSummary {
  id: string;
  businessId: string;
  invitedByUserId: string;
  contactName: string;
  channel: NetworkInviteChannel;
  destination: string;
  status: NetworkInviteStatus;
  createdAt: string;
  deliveredAt: string | null;
  failureReason: string | null;
}

export type PublicCustomerCareRequestType = "callback" | "quote" | "support" | "registration";

export interface PublicCustomerCareRequestSummary {
  id: string;
  businessId: string;
  type: PublicCustomerCareRequestType;
  customerName: string | null;
  phone: string | null;
  message: string | null;
  status: "new" | "acknowledged" | "closed";
  createdAt: string;
}

export interface PublicStorefrontMessageSummary {
  id: string;
  conversationId: string;
  businessId: string;
  visitorId: string;
  author: "customer" | "agent";
  body: string;
  attachmentNames: string[];
  createdAt: string;
}

export interface PublicOrderItemSummary {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
}

export interface PublicOrderSummary {
  id: string;
  businessId: string;
  visitorId: string;
  customerName: string;
  phone: string;
  note: string | null;
  items: PublicOrderItemSummary[];
  status: "requested" | "accepted" | "rejected" | "completed" | "cancelled";
  conversationId: string;
  invoiceId: string;
  payment: InvoicePaymentSummary;
  createdAt: string;
  updatedAt: string;
}

export type VerificationTier = "unverified" | "owner_verified" | "business_verified";

export interface VerificationTierSummary {
  businessId: string;
  tier: VerificationTier;
  evidenceType: "none" | "owner_attestation" | "business_document";
  note: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type TaxCountryCode = "KE";

export interface CountryTaxConfigSummary {
  businessId: string;
  countryCode: TaxCountryCode;
  defaultTaxRate: number;
  taxIdLabel: string;
  taxId: string | null;
  pricesIncludeTax: boolean;
  updatedBy: string;
  updatedAt: string;
}

export type DeviceTrustLevel = "unknown" | "trusted" | "restricted";

export interface DeviceTrustSummary {
  businessId: string;
  userId: string;
  deviceId: string;
  level: DeviceTrustLevel;
  reason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type BetaAccessStatus = "not_invited" | "active" | "paused";

export interface BetaAccessSummary {
  businessId: string;
  status: BetaAccessStatus;
  targetMerchantCount: number;
  invitedMerchantCount: number;
  pauseReason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type BetaFeatureFlagKey =
  | "closed_beta"
  | "offline_hardening"
  | "controlled_payments"
  | "support_intake"
  | "crash_telemetry";

export type BetaFeatureFlagRisk = "low" | "medium" | "high";

export interface BetaFeatureFlagSummary {
  businessId: string;
  key: BetaFeatureFlagKey;
  enabled: boolean;
  risk: BetaFeatureFlagRisk;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

export type BetaDeviceClass = "android_1gb" | "android_2gb";

export type BetaDeviceTestStatus = "passed" | "failed";

export interface BetaDeviceTestSummary {
  id: string;
  businessId: string;
  deviceClass: BetaDeviceClass;
  workflow: string;
  status: BetaDeviceTestStatus;
  durationMs: number;
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
}

export type BetaSupportSeverity = "low" | "medium" | "high" | "critical";

export type BetaSupportTicketStatus = "open" | "triaged" | "resolved";

export interface BetaSupportTicketSummary {
  id: string;
  businessId: string;
  severity: BetaSupportSeverity;
  status: BetaSupportTicketStatus;
  title: string;
  bodySummary: string;
  source: "merchant" | "operator";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type BetaTelemetryKind = "session" | "crash" | "error";

export interface BetaTelemetryEventSummary {
  id: string;
  businessId: string;
  kind: BetaTelemetryKind;
  severity: "info" | "warning" | "critical";
  fingerprint: string;
  messageHash: string;
  boundedMetadata: Record<string, string | number | boolean | null>;
  occurredAt: string;
  recordedAt: string;
}

export type BetaReadinessStatus = "blocked" | "needs_review" | "ready";

export interface BetaReadinessReportSummary {
  businessId: string;
  generatedAt: string;
  status: BetaReadinessStatus;
  access: BetaAccessSummary;
  featureFlags: BetaFeatureFlagSummary[];
  deviceTesting: {
    requiredDeviceClasses: BetaDeviceClass[];
    passedDeviceClasses: BetaDeviceClass[];
    failedTestCount: number;
  };
  offline: {
    cachedRecordCount: number;
    betaCriticalSurfaceCount: number;
    testedSurfaceCount: number;
  };
  syncStress: {
    queuedMutationCount: number;
    syncedMutationCount: number;
    conflictCount: number;
    failedCount: number;
    ready: boolean;
  };
  payments: {
    paymentCount: number;
    partiallyPaidInvoiceCount: number;
    unpaidInvoiceCount: number;
    reconciliationMismatchCount: number;
    controlledProductionReady: boolean;
  };
  support: {
    openTicketCount: number;
    criticalOpenTicketCount: number;
    documentedSeverityCount: number;
  };
  telemetry: {
    sessionEventCount: number;
    crashEventCount: number;
    errorEventCount: number;
    crashFreeSessionRate: number;
    rawSensitivePayloadCount: number;
  };
  gates: Array<{
    key: string;
    passed: boolean;
    detail: string;
  }>;
}

export type LaunchAccessStatus = "closed" | "open" | "paused";

export interface LaunchSettingsSummary {
  businessId: string;
  status: LaunchAccessStatus;
  publicOnboardingEnabled: boolean;
  rollbackArmed: boolean;
  freezeActive: boolean;
  allowedSignupCount: number;
  pauseReason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type LaunchChecklistKey =
  | "environment_config"
  | "secrets_ready"
  | "backup_verified"
  | "monitoring_ready"
  | "deploy_verified"
  | "rollback_runbook"
  | "support_coverage";

export type LaunchChecklistStatus = "pending" | "passed" | "failed";

export interface LaunchChecklistItemSummary {
  businessId: string;
  key: LaunchChecklistKey;
  status: LaunchChecklistStatus;
  evidence: string;
  updatedBy: string;
  updatedAt: string;
}

export type LaunchIncidentSeverity = "low" | "medium" | "high" | "critical";

export type LaunchIncidentStatus = "open" | "mitigating" | "resolved";

export type LaunchIncidentCategory =
  "onboarding" | "payments" | "sync" | "support" | "telemetry" | "rollback";

export interface LaunchIncidentSummary {
  id: string;
  businessId: string;
  severity: LaunchIncidentSeverity;
  status: LaunchIncidentStatus;
  category: LaunchIncidentCategory;
  title: string;
  bodySummary: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type LaunchReadinessStatus = "blocked" | "needs_review" | "ready";

export interface LaunchReadinessReportSummary {
  businessId: string;
  generatedAt: string;
  status: LaunchReadinessStatus;
  settings: LaunchSettingsSummary;
  betaStatus: BetaReadinessStatus;
  checklist: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    items: LaunchChecklistItemSummary[];
  };
  onboarding: {
    publicOnboardingEnabled: boolean;
    allowedSignupCount: number;
    firstRunComplete: boolean;
    productCount: number;
    customerCount: number;
    invoiceCount: number;
    paymentCount: number;
  };
  support: {
    openIncidentCount: number;
    criticalOpenIncidentCount: number;
    resolvedIncidentCount: number;
    betaOpenTicketCount: number;
  };
  telemetry: {
    sessionEventCount: number;
    crashEventCount: number;
    errorEventCount: number;
    crashFreeSessionRate: number;
    launchSafePayloadCount: number;
  };
  sync: {
    activeQueueCount: number;
    conflictCount: number;
    failedCount: number;
  };
  payments: {
    paymentCount: number;
    reconciliationMismatchCount: number;
  };
  rollback: {
    rollbackArmed: boolean;
    freezeActive: boolean;
    canPauseOnboarding: boolean;
  };
  gates: Array<{
    key: string;
    passed: boolean;
    detail: string;
  }>;
}

export interface SecurityReviewSummary {
  businessId: string;
  generatedAt: string;
  rbac: {
    reviewedPermissionCount: number;
    highRiskPermissionCount: number;
    ownerOnlyPermissionCount: number;
    gaps: string[];
  };
  audit: {
    highRiskActionCount: number;
    missingHighRiskAuditCount: number;
    coveredActionTypes: string[];
  };
  sensitiveData: {
    scannedSurfaceCount: number;
    rawSensitiveLogFindings: number;
    promptExposure: "bounded";
    redactionRules: string[];
  };
  tielReadiness: {
    verificationTier: VerificationTier;
    deviceTrustLevel: DeviceTrustLevel;
    fullTielDeferred: true;
  };
}

export interface ComplianceReportSummary {
  exportCount: number;
  deletionRequestCount: number;
  scheduledAnonymizationCount: number;
  retainedRecordCount: number;
  verificationTier: VerificationTier;
  taxCountryCode: TaxCountryCode;
  deviceTrustLevel: DeviceTrustLevel;
  highRiskAuditEventCount: number;
}

export interface CustomerDebtSummary {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balanceDue: number;
}

export type DocumentImportTarget = "supplier" | "product";

export type DocumentImportStatus = "previewed" | "confirmed" | "failed";

export interface DocumentImportSourceSummary {
  id: string;
  businessId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  sourceType?: "upload" | "paste" | "database";
  sourceLocator?: string | null;
  originalStorageKey?: string | null;
  createdAt: string;
}

export interface SupplierImportDraft {
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export interface ProductImportDraft {
  name: string;
  sku: string | null;
  unit: string;
  quantity: number;
  buyingPrice: number | null;
  sellingPrice: number | null;
}

export type DocumentImportDraft = SupplierImportDraft | ProductImportDraft;

export interface DocumentImportPreviewRow {
  rowNumber: number;
  raw: Record<string, string>;
  mapped: DocumentImportDraft;
  errors: string[];
  warnings: string[];
  selected: boolean;
}

export interface DocumentImportJobSummary {
  id: string;
  businessId: string;
  source: DocumentImportSourceSummary;
  target: DocumentImportTarget;
  status: DocumentImportStatus;
  fieldMapping: Record<string, keyof SupplierImportDraft | keyof ProductImportDraft>;
  rows: DocumentImportPreviewRow[];
  confirmedCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface DocumentImportConfirmResult {
  job: DocumentImportJobSummary;
  suppliers?: SupplierSummary[];
  products?: ProductSummary[];
}

export type InventoryMovementType = "manual_adjustment" | "sale";

export interface InventoryMovementSummary {
  id: string;
  businessId: string;
  productId: string;
  type: InventoryMovementType;
  quantityBefore: number;
  quantityAfter: number;
  delta: number;
  reason: string;
  actorId: string;
  createdAt: string;
}

/** Where an order intent was captured. Kept narrow on purpose: every new transport this list
 *  gains needs its own identity-claim rules reviewed, the same way
 *  packages/offline-runtime/providers/peer-provider.ts's BLE transport does today. */
export type OfflineOrderTransport = "ble" | "sms";
export type OfflineOrderIntentStatus = "pending_sync" | "confirmed" | "rejected" | "partial";

/** How the buyer's identity was asserted when the intent was captured. Never a BLE device name
 *  or address - peer-provider.ts's transport never trusts one as identity. */
export type OfflineOrderCustomerClaim =
  | { type: "account"; accountId: string; displayName: string | null }
  | { type: "phone"; phone: string; displayName: string | null };

export interface OfflineOrderItemIntent {
  /** Cloud product id, when the capturing device's catalogue mirror already knows it. */
  productCloudId: string | null;
  /** The name as quoted/typed at capture time - used for display and, for SMS, for server-side
   *  matching when no productCloudId is available yet. */
  name: string;
  quantity: number;
  /** Price as quoted to the buyer at capture time. Tentative: the server is the only thing that
   *  turns this into a real invoice line, and may reprice against the current catalogue. */
  quotedUnitPrice: number | null;
}

/** One order a merchant's device received while offline, over BLE or SMS. Client- or
 *  server-authored (SMS is parsed server-side), idempotency-keyed by `id`. This never represents
 *  a confirmed sale on its own - see docs/offline/offline-commerce.md. */
export interface OfflineOrderIntent {
  id: string;
  accountId: string;
  storeId: string;
  transport: OfflineOrderTransport;
  customerClaim: OfflineOrderCustomerClaim;
  items: OfflineOrderItemIntent[];
  paymentMethod: string | null;
  paymentReference: string | null;
  note: string | null;
  receivedAtLocal: string;
  rawText: string | null;
}

export interface OfflineOrderItemOutcome {
  name: string;
  quantity: number;
  productId: string | null;
  reason: string | null;
}

/** What the offline-order reconciliation endpoint returns for one intent. `confirmed`/`partial`
 *  carry the real invoice id the intent became; `rejected` never does. */
export interface OfflineOrderIntentOutcome {
  id: string;
  status: OfflineOrderIntentStatus;
  invoiceId: string | null;
  confirmedItems: OfflineOrderItemOutcome[];
  rejectedItems: OfflineOrderItemOutcome[];
  message: string;
}

/** A small, broadcastable BLE beacon of a merchant device's catalogue state - never the
 *  catalogue itself. A peer that sees a stale digest should `connect()` for a direct pull of the
 *  delta rather than wait for or request a full broadcast. */
export interface CatalogueDigest {
  storeId: string;
  productListHash: string;
  lastSyncSequence: number;
  issuedAt: string;
}

export interface OfflineCacheSnapshot {
  businessId: string;
  capturedAt: string;
  source: "server_cache";
  products: ProductSummary[];
  customers: CustomerSummary[];
  suppliers: SupplierSummary[];
  invoices: InvoiceSummary[];
  payments: PaymentSummary[];
  logistics: LogisticsSummary[];
  invoicePaymentSummaries: InvoicePaymentSummary[];
  customerDebts: CustomerDebtSummary[];
  inventoryMovements: InventoryMovementSummary[];
}

export const ACCOUNT_SYNC_COLLECTIONS = [
  "session_context",
  "shops",
  "conversations",
  "conversation_messages",
  "conversation_participants",
  "conversation_typing"
] as const;

export type AccountSyncCollection = (typeof ACCOUNT_SYNC_COLLECTIONS)[number];
export type SyncCollection = AccountSyncCollection;

const accountSyncCollectionSet = new Set<string>(ACCOUNT_SYNC_COLLECTIONS);

export function isAccountSyncCollection(value: unknown): value is AccountSyncCollection {
  return typeof value === "string" && accountSyncCollectionSet.has(value);
}

export type SyncChangeOperation = "upsert" | "delete";

export interface SyncChange<T = unknown> {
  accountId: string;
  collection: SyncCollection;
  entityId: string;
  operation: SyncChangeOperation;
  sequence: number;
  cursor: string;
  shopId: string | null;
  entity: T | null;
  changedAt: string;
  tombstoneExpiresAt: string | null;
}

export interface SyncPullRequest {
  cursor: string | null;
  limit?: number;
}

export interface SyncPullPage<T = unknown> {
  accountId: string;
  fromCursor: string | null;
  nextCursor: string;
  changes: SyncChange<T>[];
  hasMore: boolean;
  serverTime: string;
}

export interface SyncRealtimeReadyEvent {
  type: "realtime.ready";
  protocolVersion: 1;
  accountId: string;
  serverTime: string;
}

export interface SyncRealtimeChangesAvailableEvent {
  type: "sync.changes_available";
  protocolVersion: 1;
  accountId: string;
  cursor: string;
  sequence: number;
  collection: SyncCollection;
  emittedAt: string;
}

export type SyncRealtimeEvent = SyncRealtimeReadyEvent | SyncRealtimeChangesAvailableEvent;

export type McpAccessScope = "mcp:read" | "mcp:act";

export interface McpAccessTokenSummary {
  id: string;
  accountId: string;
  name: string;
  scopes: McpAccessScope[];
  shopId: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface McpAccessTokenCreated {
  accessToken: string;
  token: McpAccessTokenSummary;
}

export interface McpPrincipal {
  tokenId: string;
  accountId: string;
  userId: string;
  scopes: McpAccessScope[];
  shopId: string | null;
  expiresAt: string;
}

export interface LocalSyncRecord<T = unknown> {
  accountId: string;
  collection: SyncCollection;
  entityId: string;
  sequence: number;
  cursor: string;
  shopId: string | null;
  entity: T | null;
  changedAt: string;
  deletedAt: string | null;
  tombstoneExpiresAt: string | null;
}

export interface LocalSyncSnapshot<T = unknown> {
  accountId: string;
  cursor: string | null;
  records: LocalSyncRecord<T>[];
}

export type SyncQueueStatus = "pending" | "processing" | "synced" | "failed" | "conflict";

export type SyncMutationType =
  | "product.create"
  | "customer.create"
  | "supplier.create"
  | "inventory.adjust"
  | "invoice.create"
  | "invoice.confirm"
  | "payment.record"
  | "logistics.create"
  | "logistics.update_status";

export interface SyncProductCreatePayload {
  name: string;
  sku?: string | null;
  unit?: string | null;
  quantity?: number;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
}

export interface SyncContactCreatePayload {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

export interface SyncInventoryAdjustPayload {
  productId: string;
  quantityAfter: number;
  reason?: string | null;
}

export interface SyncInvoiceLinePayload {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface SyncInvoiceCreatePayload {
  customerId?: string | null;
  customerName?: string | null;
  taxRate?: number | null;
  items: SyncInvoiceLinePayload[];
}

export interface SyncInvoiceConfirmPayload {
  invoiceId: string;
}

export interface SyncPaymentRecordPayload {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
}

export interface SyncLogisticsCreatePayload {
  invoiceId: string;
  method: FulfillmentMethod;
  destination?: string | null;
  note?: string | null;
}

export interface SyncLogisticsStatusPayload {
  logisticsId: string;
  status: FulfillmentStatus;
  note?: string | null;
}

export type SyncMutationPayload =
  | SyncProductCreatePayload
  | SyncContactCreatePayload
  | SyncInventoryAdjustPayload
  | SyncInvoiceCreatePayload
  | SyncInvoiceConfirmPayload
  | SyncPaymentRecordPayload
  | SyncLogisticsCreatePayload
  | SyncLogisticsStatusPayload;

/**
 * Which field/record class a blocked sync conflict touches. "money" and
 * "product_quantity" cover the two conflict-prone value types the current
 * invoice/payment model actually has (payment amounts against balance, and
 * stock on hand). There is no "tax" or "discount" category: tax is a single
 * server-validated rate with no client-trusted value to conflict over, and
 * invoices have no discount field at all — adding either would be a new
 * product feature, not a sync-conflict fix. "duplicate" covers offline
 * records that look like the same real-world event recorded twice under
 * different idempotency keys (e.g. two devices queuing the same product or
 * payment while disconnected).
 */
export type SyncConflictCategory = "money" | "product_quantity" | "duplicate" | "generic";

export interface SyncConflict {
  code: string;
  message: string;
  statusCode: number;
  retryable: boolean;
  category: SyncConflictCategory;
}

export interface SyncQueueItem {
  id: string;
  idempotencyKey: string;
  businessId: string;
  actorId: string;
  mutationType: SyncMutationType;
  payload: SyncMutationPayload;
  status: SyncQueueStatus;
  attempts: number;
  clientCreatedAt: string;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  result: unknown | null;
  conflict: SyncConflict | null;
}

export interface LocalSyncMutation extends SyncQueueItem {
  accountId: string;
}

export interface SyncQueueSummary {
  businessId: string;
  pending: number;
  processing: number;
  synced: number;
  failed: number;
  conflict: number;
  total: number;
}

export interface SyncReplayResult {
  item: SyncQueueItem;
  replayed: boolean;
}

export interface SalesReportSummary {
  invoiceCount: number;
  confirmedInvoiceCount: number;
  grossSales: number;
  collectedTotal: number;
  outstandingTotal: number;
}

export interface InventoryReportSummary {
  productCount: number;
  totalUnitsOnHand: number;
  lowStockCount: number;
  outOfStockCount: number;
  movementCount: number;
}

export interface PaymentsReportSummary {
  paymentCount: number;
  paidInvoiceCount: number;
  partiallyPaidInvoiceCount: number;
  unpaidInvoiceCount: number;
  totalPaid: number;
}

export interface DebtReportSummary {
  customerCount: number;
  totalOutstanding: number;
  largestBalanceDue: number;
}

export interface ImportsReportSummary {
  totalJobs: number;
  previewedJobs: number;
  confirmedJobs: number;
  failedJobs: number;
  confirmedRows: number;
}

export interface SyncHealthReportSummary extends SyncQueueSummary {
  active: number;
}

export interface BusinessReportSummary {
  businessId: string;
  generatedAt: string;
  sales: SalesReportSummary;
  inventory: InventoryReportSummary;
  payments: PaymentsReportSummary;
  debts: DebtReportSummary;
  imports: ImportsReportSummary;
  logistics: LogisticsReportSummary;
  compliance: ComplianceReportSummary;
  beta: BetaReadinessReportSummary;
  launch: LaunchReadinessReportSummary;
  sync: SyncHealthReportSummary;
}

export type BusinessNotificationType =
  | "low_stock"
  | "open_debt"
  | "sync_conflict"
  | "import_failed"
  | "fulfillment_pending"
  | "beta_readiness"
  | "launch_readiness"
  | "security_event"
  | "shop_deletion";

export type BusinessNotificationSeverity = "info" | "warning" | "critical";

export type BusinessNotificationStatus = "unread" | "read" | "archived";

export interface BusinessNotificationSummary {
  id: string;
  businessId: string;
  type: BusinessNotificationType;
  severity: BusinessNotificationSeverity;
  status: BusinessNotificationStatus;
  title: string;
  body: string;
  sourceType:
    | "report"
    | "product"
    | "customer_debt"
    | "sync_queue"
    | "document_import"
    | "logistics"
    | "beta_readiness"
    | "launch_readiness"
    | "security"
    | "shop_deletion";
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface NotificationInboxSummary {
  businessId: string;
  unread: number;
  read: number;
  archived: number;
  total: number;
}

export interface NotificationInbox {
  summary: NotificationInboxSummary;
  notifications: BusinessNotificationSummary[];
}

export interface BusinessKnowledgeFact {
  topic:
    | "sales"
    | "inventory"
    | "payments"
    | "debt"
    | "imports"
    | "logistics"
    | "compliance"
    | "beta"
    | "launch"
    | "sync"
    | "notifications";
  severity: BusinessNotificationSeverity;
  detail: string;
  metric: number;
}

export interface BusinessKnowledgeSummary {
  businessId: string;
  generatedAt: string;
  report: BusinessReportSummary;
  notificationSummary: NotificationInboxSummary;
  facts: BusinessKnowledgeFact[];
}

export type RuntimeToolName =
  | "products.list"
  | "invoices.list"
  | "reports.summary"
  | "notifications.list"
  | "compliance.review"
  | "network.route"
  | "network.contacts.resolve"
  | "network.identity.list"
  | "network.identity.propose"
  | "network.identity.confirm"
  | "network.identity.reject"
  | "network.identity.unlink"
  | "network.identity.add"
  | "commerce.search"
  | "commerce.checkout"
  | "product.create"
  | "product.update"
  | "product.delete"
  | "product.stock_adjust"
  | "product.field.add"
  | "product.field.remove"
  | "customer.create"
  | "customer.update"
  | "supplier.create"
  | "supplier.update"
  | "contacts.search"
  | "supplier.contact.attach"
  | "purchase.record"
  | "purchase.price.change"
  | "purchase.history"
  | "procurement.quote.record"
  | "procurement.prepare"
  | "sale.record"
  | "sales.history"
  | "route.record"
  | "route.history"
  | "invoice.draft"
  | "payments.debtors"
  | "payment.record"
  | "logistics.update_status"
  | "receipt.scan"
  | "receipt.review"
  | "receipt.confirm"
  | "receipt.correct"
  | "receipt.cancel"
  | "receipt.lookup"
  | "receipt.list"
  | "document_import.confirm"
  | "messaging.send"
  | "workspace.deliver"
  | "computer.session.create"
  | "computer.session.resume"
  | "computer.navigate"
  | "computer.observe"
  | "computer.click"
  | "computer.type"
  | "computer.scroll"
  | "computer.upload"
  | "computer.control.take"
  | "computer.control.release"
  | "computer.checkpoint"
  | "computer.suspend"
  | "computer.close"
  | "unknown.clarify";

export type RuntimeParserIntent =
  | "add_product"
  | "update_product"
  | "adjust_stock"
  | "add_customer"
  | "update_customer"
  | "add_supplier"
  | "update_supplier"
  | "create_invoice"
  | "record_payment"
  | "update_logistics"
  | "check_debt"
  | "show_products"
  | "show_invoices"
  | "show_reports"
  | "show_notifications"
  | "confirm_document_import"
  | "unknown";

export type RuntimeTurnStatus =
  "completed" | "needs_confirmation" | "clarifying" | "blocked" | "rate_limited";

export type RuntimePlanStatus =
  "safe_to_execute" | "needs_confirmation" | "clarification_required" | "blocked";

export type RuntimeTelemetryState =
  | "turn.received"
  | "context.built"
  | "agent.started"
  | "agent.completed"
  | "model.prompt_built"
  | "model.inference_started"
  | "model.completed"
  | "model.fallback"
  | "model.fallback_completed"
  | "context.plan.completed"
  | "grounding.accepted"
  | "grounding.rejected"
  | "recall.candidate_generated"
  | "recall.candidate_rejected"
  | "recall.deduplicated"
  | "recall.persisted"
  | "recall.retrieved"
  | "recall.applied"
  | "recall.persistence_failed"
  | "intent.routed"
  | "plan.created"
  | "verification.completed"
  | "tool.executed"
  | "confirmation.required"
  | "response.generated"
  | "turn.rate_limited"
  | "turn.blocked";

export interface RuntimeContextSummary {
  businessId: string;
  userId: string;
  role: BusinessRole;
  productCount: number;
  customerCount: number;
  supplierCount: number;
  invoiceCount: number;
  openInvoiceCount: number;
  paymentCount: number;
  importJobCount: number;
  logisticsCount: number;
  activeLogisticsCount: number;
  complianceExportCount: number;
  scheduledDeletionCount: number;
  verificationTier: VerificationTier;
  deviceTrustLevel: DeviceTrustLevel;
  betaAccessStatus: BetaAccessStatus;
  betaReadinessStatus: BetaReadinessStatus;
  openSupportTicketCount: number;
  crashFreeSessionRate: number;
  publicLaunchStatus: LaunchAccessStatus;
  launchReadinessStatus: LaunchReadinessStatus;
  openLaunchIncidentCount: number;
  lowStockCount: number;
  outstandingDebtTotal: number;
  unreadNotificationCount: number;
  knowledgeFactCount: number;
}

export type RuntimeModelProviderName = ModelProviderId;

export type RuntimeModelAdapterStatus =
  "disabled" | "available" | "unavailable" | "timeout" | "malformed" | "error";

export interface RuntimeModelTemplateRecipe {
  templateId: string;
  templateVersionId: string;
  version: string;
  task: string | null;
  allowedTools: RuntimeToolName[];
  contextRequirements: string[];
  outputSchema?: Record<string, unknown>;
  constraints: Record<string, unknown>;
  templateVocabularySnapshot: string;
  currentVocabularySnapshot: string;
}

export interface RuntimeModelPrompt {
  /**
   * The user turn: untrusted retrieved data (if any) followed by the current message. Never holds
   * the agent's own instructions - those are `agentInstructions`.
   */
  message: string;
  /**
   * The agent's trusted operating instructions (platform rules, identity, business policy,
   * personality, available tools, output rules). Adapters send these as the system message, so a
   * model never mistakes them for something the merchant said.
   */
  agentInstructions?: string;
  conversationHistory?: RuntimeModelConversationMessage[];
  /**
   * Owner-facing operational counts (invoices, compliance, etc.). Absent for callers with no
   * business membership, such as an anonymous storefront visitor's message to the shop's agent —
   * that data must never be computed for or shown to a non-member caller.
   */
  context?: RuntimeContextSummary;
  allowedTools: RuntimeToolName[];
  schemaVersion: "cp11-runtime-model-v1";
  runtimeVersion?: number;
  compiledInstructions?: CompiledAgentInstructionSet;
  retrievedContext?: RetrievedAgentContextItem[];
  modelTemplate?: RuntimeModelTemplateRecipe;
}

export interface RuntimeModelConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Provider-neutral inference failure categories. Every inference-capable surface in this
 * repository - server model adapters (services/api/src/inference/model-runtime.ts), which talk to
 * local Ollama - throws or returns its
 * own specific error code (e.g. "MODEL_PROVIDER_TIMEOUT", "CLOUD_TIMEOUT", "INFERENCE_TIMEOUT").
 * (There is no OpenAI or other cloud-LLM-API provider in this repository; one existed historically
 * and was removed by migration 068_remove_cloud_fallback.sql.) Those specific
 * codes stay exactly as they are: this type and normalizeInferenceErrorCode() only add a shared,
 * coarser category on top, so telemetry and user-facing messaging can reason about "a timeout
 * happened" the same way regardless of which surface produced it, without either changing what it
 * already throws. The WEBGPU_UNAVAILABLE/MODEL_DOWNLOAD_FAILED/... entries below the server codes
 * are historical - they categorized the retired browser-local inference architecture's error
 * codes and are kept only so a client still holding a stale cached code from before that
 * retirement normalizes safely instead of falling through to "UNKNOWN"; no surface in this
 * repository produces them anymore.
 */
export type RuntimeInferenceErrorCategory =
  | "TIMEOUT"
  | "ENGINE_UNREACHABLE"
  | "MODEL_NOT_INSTALLED"
  | "MODEL_LOADING"
  | "MODEL_UNAVAILABLE"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "EMPTY_RESPONSE"
  | "INVALID_RESPONSE"
  | "INVALID_TOOL_CALL"
  | "RATE_LIMITED"
  | "AUTHENTICATION_FAILED"
  | "PROVIDER_ERROR"
  | "ABORTED"
  /**
   * A deliberate policy decision, not a fault: a budget or rate ceiling, a client-executed (local)
   * model, a forbidden endpoint, an unsupported capability. Never retryable - moving to another
   * runtime candidate would route around the policy (e.g. onto a more expensive model).
   */
  | "POLICY_REJECTED"
  | "UNKNOWN";

/**
 * Machine-readable, provider-neutral description of an inference failure. Never includes secrets,
 * API keys, raw provider response bodies, prompts, or other private data - only the normalized
 * category, the original specific code, and (when known) which provider/model was involved.
 */
export interface RuntimeInferenceError {
  category: RuntimeInferenceErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  provider?: RuntimeModelProviderName | "browser";
  model?: string;
  status?: number;
  retryAfterMs?: number;
}

const inferenceErrorCategoryByCode: Record<string, RuntimeInferenceErrorCategory> = {
  // services/api/src/inference/model-runtime.ts (llama.cpp and Hugging Face backends alike)
  MODEL_PROVIDER_TIMEOUT: "TIMEOUT",
  INFERENCE_TIMEOUT: "TIMEOUT",
  CLOUD_TIMEOUT: "TIMEOUT",
  MODEL_PROVIDER_UNREACHABLE: "ENGINE_UNREACHABLE",
  INFERENCE_SERVICE_UNREACHABLE: "ENGINE_UNREACHABLE",
  INFERENCE_ENGINE_UNREACHABLE: "ENGINE_UNREACHABLE",
  RUNTIME_UNAVAILABLE: "ENGINE_UNREACHABLE",
  RUNTIME_NOT_CONFIGURED: "MODEL_UNAVAILABLE",
  MODEL_NOT_INSTALLED: "MODEL_NOT_INSTALLED",
  MODEL_LOADING: "MODEL_LOADING",
  MODEL_NOT_CONFIGURED: "MODEL_UNAVAILABLE",
  AGENT_MODEL_NOT_CONFIGURED: "MODEL_UNAVAILABLE",
  AGENT_MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  MODEL_IDENTITY_MISMATCH: "MODEL_UNAVAILABLE",
  MODEL_GENERATION_FAILED: "PROVIDER_ERROR",
  MODEL_PROBE_FAILED: "PROVIDER_ERROR",
  MODEL_HEALTH_CHECK_FAILED: "PROVIDER_ERROR",
  MODEL_ENDPOINT: "PROVIDER_ERROR",
  INVALID_INFERENCE_RESPONSE: "INVALID_RESPONSE",
  CLOUD_SPENDING_LIMIT_REACHED: "RATE_LIMITED",
  CLOUD_CIRCUIT_OPEN: "ENGINE_UNREACHABLE",
  CLOUD_REQUEST_FAILED: "PROVIDER_ERROR",
  // services/api/src/inference/providers/errors.ts (multi-provider inference router)
  PROVIDER_UNAVAILABLE: "ENGINE_UNREACHABLE",
  PROVIDER_MISCONFIGURED: "MODEL_UNAVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  INVALID_CREDENTIAL: "AUTHENTICATION_FAILED",
  CREDENTIAL_MISSING: "AUTHENTICATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  CONTEXT_TOO_LARGE: "CONTEXT_WINDOW_EXCEEDED",
  REQUEST_TIMEOUT: "TIMEOUT",
  REQUEST_CANCELLED: "ABORTED",
  CAPABILITY_UNSUPPORTED: "POLICY_REJECTED",
  BUDGET_EXCEEDED: "POLICY_REJECTED",
  CONTENT_REJECTED: "POLICY_REJECTED",
  INFERENCE_FAILED: "PROVIDER_ERROR",
  ENDPOINT_FORBIDDEN: "POLICY_REJECTED",
  LOCAL_EXECUTION_REQUIRED: "POLICY_REJECTED",
  LOCAL_DEVICE_UNAVAILABLE: "ENGINE_UNREACHABLE",
  INVALID_PROVIDER_RESPONSE: "INVALID_RESPONSE",
  // Historical: the retired browser-local inference architecture's error codes (see this type's
  // own docblock above) - no surface in this repository produces these anymore.
  WEBGPU_UNAVAILABLE: "ENGINE_UNREACHABLE",
  WASM_UNAVAILABLE: "ENGINE_UNREACHABLE",
  MODEL_DOWNLOAD_FAILED: "MODEL_NOT_INSTALLED",
  MODEL_CACHE_CORRUPT: "MODEL_NOT_INSTALLED",
  MODEL_LOAD_FAILED: "MODEL_LOADING",
  OUT_OF_MEMORY: "PROVIDER_ERROR",
  CONTEXT_LIMIT_EXCEEDED: "CONTEXT_WINDOW_EXCEEDED",
  TASK_BUDGET_EXCEEDED: "RATE_LIMITED",
  GENERATION_CANCELLED: "ABORTED",
  WORKER_CRASHED: "PROVIDER_ERROR",
  STORAGE_QUOTA_EXCEEDED: "PROVIDER_ERROR",
  UNSUPPORTED_BROWSER: "ENGINE_UNREACHABLE"
};

/**
 * Maps any of this repository's existing provider-specific inference error codes to a shared
 * category. Unknown codes normalize to "UNKNOWN" rather than throwing, since this is meant to be
 * safe to call from telemetry/logging paths with an error that originated somewhere new.
 */
export function normalizeInferenceErrorCode(code: string): RuntimeInferenceErrorCategory {
  return inferenceErrorCategoryByCode[code] ?? "UNKNOWN";
}

const retryableInferenceErrorCategories: ReadonlySet<RuntimeInferenceErrorCategory> = new Set([
  "TIMEOUT",
  "ENGINE_UNREACHABLE",
  "MODEL_NOT_INSTALLED",
  "MODEL_LOADING",
  "MODEL_UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_ERROR"
]);

/**
 * Whether a normalized inference failure category is worth trying a different runtime candidate
 * (model/host/target) for, as opposed to a caller-facing or structural failure that will not be
 * fixed by retrying (authentication, an invalid tool call, a malformed request, a user abort).
 * Lives beside RuntimeInferenceErrorCategory/normalizeInferenceErrorCode so a category never has a
 * retry policy defined anywhere else - see runtime candidate-fallback usage in
 * services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts. This is distinct from a
 * specific ModelRuntimeAdapter's own `retryable` flag on an individual thrown error, which decides
 * whether that one adapter call is worth retrying at the I/O level, not whether the runtime
 * resolver should move on to a different candidate.
 */
export function isRetryableInferenceCategory(category: RuntimeInferenceErrorCategory): boolean {
  return retryableInferenceErrorCategories.has(category);
}

export interface RuntimeModelDiagnostic {
  provider: RuntimeModelProviderName;
  status: "ready" | "unavailable";
  model: string | null;
  modelAvailable: boolean | null;
  inferenceAvailable: boolean | null;
  errorCode: string | null;
  checkedAt: string;
}

export interface RuntimeModelCompletionResult {
  provider: RuntimeModelProviderName;
  status: Exclude<RuntimeModelAdapterStatus, "disabled" | "malformed">;
  outputText: string | null;
  durationMs: number;
  errorCode: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RuntimeModelProvider {
  name: RuntimeModelProviderName;
  complete(prompt: RuntimeModelPrompt, signal?: AbortSignal): Promise<RuntimeModelCompletionResult>;
  diagnose?(runInference?: boolean): Promise<RuntimeModelDiagnostic>;
}

export interface RuntimeModelTrace {
  provider: RuntimeModelProviderName | null;
  status: RuntimeModelAdapterStatus;
  durationMs: number | null;
  outputKind: "tool" | "clarification" | "response" | null;
  errorCode: string | null;
  /**
   * The model's raw completion text, verbatim (truncated past runtimeModelTraceTextLimit chars).
   * Kept for audit - so a disputed mutating action (a drafted invoice, a payment record) has a
   * traceable rationale behind it - even when the parsed proposal is what actually executed.
   * Present only on the merchant-owner runtime turn path; the public storefront reply path never
   * calls createRuntimeModelRoute and never gets a RuntimeModelTrace at all.
   */
  rawOutputText?: string;
  bindingId?: string;
  modelId?: string;
  providerModelId?: string;
  inferenceRequestId?: string;
  promptTokens?: number;
  completionTokens?: number;
  executionTarget?: ModelExecutionTarget;
  executionHostId?: string | null;
  fallbackIndex?: number;
  resolutionReason?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  agentId?: string;
  agentAdapterId?: string;
}

export interface RuntimePlannedAction {
  id: string;
  toolName: RuntimeToolName;
  risk: "low" | "medium" | "high" | "critical";
  requiresConfirmation: boolean;
  status: RuntimePlanStatus;
  input: Record<string, unknown>;
  validationErrors: string[];
  confirmationToken: string | null;
  executedAt: string | null;
}

export interface RuntimeVerificationResult {
  ok: boolean;
  requiresConfirmation: boolean;
  confirmationSatisfied: boolean;
  roleAllowed: boolean;
  rateLimited: boolean;
  errors: string[];
}

export interface RuntimeTelemetryEvent {
  id: string;
  sessionId: string;
  turnId: string;
  state: RuntimeTelemetryState;
  occurredAt: string;
  toolName: RuntimeToolName | null;
  risk: RuntimePlannedAction["risk"] | null;
  status: RuntimeTurnStatus | RuntimePlanStatus;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RuntimeSessionSummary {
  id: string;
  businessId: string;
  userId: string;
  /** Retry key for session creation. Scoped to the authenticated user and business. */
  idempotencyKey?: string;
  status: "active" | "closed";
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeTurnSummary {
  id: string;
  sessionId: string;
  businessId: string;
  actorId: string;
  message: string;
  normalizedInput: string;
  parserIntent: RuntimeParserIntent;
  parserConfidence: number;
  status: RuntimeTurnStatus;
  context: RuntimeContextSummary;
  plan: RuntimePlannedAction;
  verification: RuntimeVerificationResult;
  model: RuntimeModelTrace | null;
  response: string;
  toolResult: unknown | null;
  telemetry: RuntimeTelemetryEvent[];
  runtimeVersion: number;
  createdAt: string;
}

export interface RuntimeTurnResult {
  session: RuntimeSessionSummary;
  turn: RuntimeTurnSummary;
}

export type AgentRuntimeStatus = "draft" | "active" | "paused" | "archived";
export type AgentAudience = "owner" | "staff" | "customer";
export type AgentContextSensitivity = "public" | "internal" | "confidential" | "restricted";
export type AgentContextSourceType =
  | "catalogue"
  | "inventory"
  | "customer"
  | "supplier"
  | "receipt"
  | "order"
  | "policy"
  | "document"
  | "conversation"
  | "context_script"
  | "owner_note"
  | "recall";

export interface AgentIdentity {
  agentName: string;
  shopName: string;
  shopIdentifier: string;
  role: string;
  supportedLanguages: SupportedLanguage[];
  shopDescription: string;
  businessCategory: string;
  publicIntroduction: string;
}

export interface AgentPersonality {
  tone: "warm" | "neutral" | "direct" | "formal";
  formality: "casual" | "balanced" | "formal";
  responseLength: "brief" | "balanced" | "detailed";
  sellingStyle: "consultative" | "informative" | "proactive";
  negotiationStyle: "fixed" | "guided" | "flexible";
  greetingStyle: "minimal" | "friendly" | "formal";
  useLocalVocabulary: boolean;
  preferredLanguageOrder: SupportedLanguage[];
  humourLevel: "none" | "light" | "moderate";
  customerCareBehaviour: "concise" | "empathetic" | "solution_focused";
  escalationBehaviour: "when_required" | "when_uncertain" | "owner_first";
  confidenceBoundary: number;
  additionalGuidance: string;
}

export type AgentDefinitionId =
  | `builtin:${string}`
  | `github:${string}/${string}`
  | `huggingface:${string}/${string}`
  | `portable:${string}`;
export type OssAgentSource = "github" | "huggingface";
export type OssAgentRuntime =
  "docker" | "gradio" | "javascript" | "python" | "typescript" | "unknown";
export type OssAgentExecutionMode = "hosted-api" | "backend-adapter";

export interface AgentDefinition {
  id: AgentDefinitionId;
  displayName: string;
  role: string;
  description: string;
  operatingPattern: string;
  workloadClass: "focused";
  minimumDeviceTier: BrowserDeviceTier;
  minimumMemoryGb: number;
  recommendedContextTokens: number;
  personality: string;
  instructions: string;
  knowledge: string;
  tools: string[];
  skillIds: RuntimeToolName[];
  /** Which registered AgentRuntimeAdapter executes this agent's turns (e.g. "pi", "grogoni") - fixed
   *  per definition, not independently swappable. Engine choice changes by picking a different
   *  agent definition, not by editing this field on an existing one. */
  runtimeAdapterId: string;
}

export interface OssAgentSummary {
  id: AgentDefinitionId;
  label: string;
  description: string;
  source: OssAgentSource;
  sourceId: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  licenseVerified: boolean;
  runtime: OssAgentRuntime;
  executionMode: OssAgentExecutionMode;
  minimumDeviceTier: BrowserDeviceTier;
  minimumMemoryGb: number;
  requiresGpu: boolean;
  popularity: number;
  capabilities: string[];
  updatedAt: string | null;
}

export interface OssAgentSearchResult {
  agents: OssAgentSummary[];
  status: "available" | "unavailable";
  connection: "authenticated" | "public";
  message: string;
}

/**
 * Safe offline fallback for legacy profiles and discovery outages. Owner-facing agent choices are
 * discovered from GitHub and Hugging Face rather than this built-in definition.
 */
export const defaultAgentDefinitionId: AgentDefinitionId = "builtin:shopkeeper";
export const defaultAgentDefinition: AgentDefinition = {
  id: defaultAgentDefinitionId,
  displayName: "Shopkeeper",
  role: "General shopkeeper and storefront attendant",
  description:
    "Grogoni's default shop assistant, running on Grogoni's built-in agent engine. Also the safe fallback while the open-source agent catalogue is unavailable.",
  operatingPattern: "Focused operator",
  workloadClass: "focused",
  minimumDeviceTier: "low",
  minimumMemoryGb: 2,
  recommendedContextTokens: 1_024,
  personality: "Warm, concise, accurate and commercially practical",
  instructions:
    "Handle one clear shop task at a time, use saved business records, and ask before risky changes. When a workspace file should be given to the user, call workspace.deliver and refer to the delivered attachment without exposing its filesystem path.",
  knowledge: "Use saved products, customers, invoices, payments, receipts and shop policies.",
  tools: [
    "Products",
    "Customers",
    "Suppliers",
    "Invoices",
    "Payments",
    "Receipts",
    "Reports",
    "Notifications",
    "Logistics",
    "Workspace delivery"
  ],
  skillIds: [],
  runtimeAdapterId: "grogoni"
};

/**
 * Same built-in shopkeeper behavior as defaultAgentDefinition, also on Grogoni's built-in engine.
 * Kept as its own id because shops that swapped off the retired ZeroClaw engine reference it.
 */
export const grogoniEngineAgentDefinitionId: AgentDefinitionId = "builtin:shopkeeper-grogoni";
export const grogoniEngineAgentDefinition: AgentDefinition = {
  ...defaultAgentDefinition,
  id: grogoniEngineAgentDefinitionId,
  displayName: "Shopkeeper (Grogoni engine)",
  description: "Same shopkeeper behavior, running on Grogoni's built-in agent engine.",
  runtimeAdapterId: "grogoni"
};

/**
 * Same built-in shopkeeper behavior as defaultAgentDefinition, running on the Pi engine instead of
 * Grogoni's built-in one. Engine choice is a property of which agent definition is active (see
 * AgentDefinition.runtimeAdapterId) - this is how a shop swaps engines: pick this definition
 * instead of defaultAgentDefinition, rather than toggling an adapter field independently.
 */
export const piAgentDefinitionId: AgentDefinitionId = "builtin:pi-assistant";
export const piAgentDefinition: AgentDefinition = {
  ...defaultAgentDefinition,
  id: piAgentDefinitionId,
  displayName: "Shopkeeper (Pi engine)",
  description: "Same shopkeeper behavior, running on the Pi agent-loop engine.",
  runtimeAdapterId: "pi"
};

export function isAgentDefinitionId(value: unknown): value is AgentDefinitionId {
  if (typeof value !== "string" || value.length > 220) return false;
  return (
    // builtin:<slug> covers defaultAgentDefinitionId ("builtin:shopkeeper") and any other built-in
    // fallback template hosted in cp2_agent_catalog (see services/api/src/cp2/store.ts
    // upsertAgentCatalogEntry) - a platform operator can add more without a code change.
    /^builtin:[a-z0-9][a-z0-9_-]{0,79}$/.test(value) ||
    /^portable:[a-z0-9][a-z0-9_-]{0,79}$/.test(value) ||
    /^(?:github|huggingface):[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value)
  );
}

export interface AgentInstructions {
  generalOperatingRules: string[];
  salesRules: string[];
  pricingRules: string[];
  maximumDiscountPercent: number;
  negotiationAllowed: boolean;
  creditSalesAllowed: boolean;
  maximumCreditDays: number;
  deliveryRules: string[];
  returnsAndRefundRules: string[];
  inventoryRules: string[];
  supplierRules: string[];
  customerPrivacyRules: string[];
  escalationRules: string[];
  restrictedActions: RuntimeToolName[];
  substituteOutOfStockAllowed: boolean;
  ownerApprovalRequiredFor: RuntimeToolName[];
  customerDataRecommendationsAllowed: boolean;
  catalogueModificationAllowed: boolean;
  externalMessagingAllowed: boolean;
}

export interface AgentContextAccessRules {
  audiences: AgentAudience[];
  requiredPermission: string | null;
  customerVisible: boolean;
}

/**
 * How a piece of evidence was established. `canonical_record` means it was read directly from an
 * authoritative business record (a product/customer/order row) - the strongest grade. The others
 * name progressively less-verified origins. A model's own free-text claim is never a valid
 * resolver: model output is not evidence until it is checked against a canonical record.
 */
export type EvidenceProvenanceResolver =
  | "canonical_record"
  | "owner_authored"
  | "ocr_extraction"
  | "model_recall"
  | "context_script"
  | "unknown";

export interface EvidenceProvenance {
  resolver: EvidenceProvenanceResolver;
  sourceType: AgentContextSourceType;
  /** The canonical business record this evidence was read from, when one exists. */
  sourceId: string | null;
}

export interface AgentContextSource {
  id: string;
  tenantId: string;
  shopId: string;
  type: AgentContextSourceType;
  title: string;
  status: "active" | "disabled" | "archived";
  sensitivity: AgentContextSensitivity;
  accessRules: AgentContextAccessRules;
  freshnessTimestamp: string;
  version: number;
  retrievalMetadata: {
    keywords: string[];
    sourceRecordId: string | null;
    content: string | null;
    /**
     * How confident the resolver is that `content` is accurate, 0-1. `null` when confidence was
     * never assessed (the historical default - most canonical-record-backed sources are
     * unambiguous and don't need a score). Optional so existing persisted rows and test fixtures
     * built before this field existed remain valid without a migration.
     */
    confidence?: number | null;
    provenance?: EvidenceProvenance;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BusinessContextManifest {
  tenantId: string;
  shopId: string;
  generatedAt: string;
  sources: AgentContextSource[];
}

/**
 * How strictly a context recipe's grounding gate treats missing required evidence. "none" never
 * blocks (the historical behavior for every intent before this field existed). "require_evidence"
 * blocks with a deterministic abstention when a required evidence domain has real candidate
 * records the caller could see but none were actually retrieved for this turn - it never blocks on
 * a domain that is genuinely empty for the business, since "there are none" is itself a grounded
 * answer, not a hallucination risk.
 */
export type GroundingPolicyId = "none" | "require_evidence";

/**
 * A versioned, named declaration of what a recognized task type needs - evidence domains, a
 * grounding policy, and (for the runtime report card) the tools it's expected to use. Distinct from
 * `RuntimeModelTemplateRecipe`, which shapes a Model Template's compiled prompt/tool list for one
 * template version; a `ContextRecipe` is keyed by task type (`RuntimeParserIntent`), not by
 * template, and every agent/template resolves the same recipe for the same recognized task.
 */
export interface ContextRecipe {
  /** `grogoni.<taskType>@<version>`, e.g. `grogoni.show_products@1`. */
  id: string;
  taskType: RuntimeParserIntent;
  version: number;
  requiredEvidence: AgentContextSourceType[];
  optionalEvidence: AgentContextSourceType[];
  tools: RuntimeToolName[];
  groundingPolicy: GroundingPolicyId;
}

export interface ContextSelectionDiagnostics {
  candidateNodes: number;
  selectedNodes: number;
  rejectedNodes: number;
  estimatedTokens: number;
  tokenBudget: number | null;
  byDomain: Partial<
    Record<AgentContextSourceType, { candidates: number; authorized: number; selected: number }>
  >;
}

/**
 * The brief's abstention contract: a model must never be left to decide whether mandatory evidence
 * exists. `conflicting_evidence` is declared for forward compatibility with a future detector but is
 * never produced today - no code path currently compares retrieved evidence for contradictions, and
 * this change does not add one (see docs/architecture/runtime-grounding.md).
 */
export type GroundingDecision =
  | { status: "grounded"; evidenceIds: string[] }
  | { status: "insufficient_evidence"; missing: AgentContextSourceType[] }
  | { status: "unauthorized"; missingScopes: AgentContextSourceType[] }
  | { status: "conflicting_evidence"; conflicts: string[] };

export interface RetrievedAgentContextItem {
  sourceId: string;
  type: AgentContextSourceType;
  title: string;
  content: string;
  sensitivity: AgentContextSensitivity;
  freshnessTimestamp: string;
  relevanceScore: number;
  /** 0-1, or `null` when the source never assessed one. See `EvidenceProvenance`. */
  confidence: number | null;
  provenance: EvidenceProvenance;
}

export interface AgentSkillBinding {
  skillId: RuntimeToolName;
  version: number;
  enabled: boolean;
  permissions: string[];
  allowedIntents: RuntimeParserIntent[];
  requiredConfirmationLevel: "none" | "owner" | "explicit";
  executionEnvironment: "server" | "browser_worker" | "native";
  quotaPerHour: number | null;
  lastSuccessfulExecution: string | null;
  failureCount: number;
}

export interface AgentMemoryPolicy {
  sessionMemoryEnabled: boolean;
  customerConversationMemoryEnabled: boolean;
  shopSemanticMemoryEnabled: boolean;
  ownerCorrectionsEnabled: boolean;
  reusableWorkflowMemoryEnabled: boolean;
  customerMemoryRequiresConsent: boolean;
  retentionDays: number;
  maximumItemsPerScope: number;
}

export interface AgentEvaluationPolicy {
  enabled: boolean;
  sampleRate: number;
  recordLatency: boolean;
  recordToolOutcomes: boolean;
  recordPolicyBlocks: boolean;
  customerSatisfactionEnabled: boolean;
  retainDays: number;
}

export interface AgentModelBinding {
  modelId: string;
  provider: string;
  executionMode: PreferredExecutionMode;
  deviceAssignmentId: string | null;
}

export interface ShopAgentRuntime {
  agentId: string;
  shopId: string;
  tenantId: string;
  identity: AgentIdentity;
  personality: AgentPersonality;
  instructions: AgentInstructions;
  context: BusinessContextManifest;
  skills: AgentSkillBinding[];
  memory: AgentMemoryPolicy;
  evaluations: AgentEvaluationPolicy;
  model: AgentModelBinding;
  version: number;
  status: AgentRuntimeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntimeVersion {
  id: string;
  tenantId: string;
  shopId: string;
  agentId: string;
  version: number;
  runtime: ShopAgentRuntime;
  createdBy: string;
  changeSummary: string;
  createdAt: string;
  previousVersion: number | null;
}

export interface AgentOwnerCorrection {
  id: string;
  tenantId: string;
  shopId: string;
  agentId: string;
  runtimeVersion: number;
  correction: string;
  category: "instruction" | "business_fact" | "memory" | "response";
  status: "active" | "disabled";
  sourceMessageId: string | null;
  promotedToInstruction: boolean;
  createdBy: string;
  createdAt: string;
  disabledAt: string | null;
}

/**
 * MUSE-adoption brief §8/§9/§15: a structured, reusable fact distilled from a completed execution
 * trajectory - never hidden chain-of-thought, never a raw conversation transcript. Fills the
 * `"recall"` `AgentContextSourceType` slot that was already wired into context retrieval and prompt
 * assembly (`context-semantic-runtime.md`) but, until this type existed, nothing ever populated.
 * Distinct from `AgentOwnerCorrection`: a correction is owner-authored; a `RuntimeExperience` is
 * extracted automatically from what actually happened during execution, following the same
 * candidate -> validated -> deprecated lifecycle a correction's `active`/`disabled` status models,
 * one level more cautious (see `validationState`/`corroborationCount`).
 */
export type RuntimeExperienceOutcome =
  "successful" | "adjusted" | "rejected" | "failed" | "unknown";

/**
 * `candidate`: extracted once, not yet corroborated - never surfaced into a prompt.
 * `validated`: corroborated by `corroborationCount` independent occurrences - eligible for recall.
 * `deprecated`: retired by the retention sweep or an explicit disable - excluded from recall,
 * audit history preserved (never hard-deleted), mirroring `AgentOwnerCorrection.disabledAt`.
 */
export type RuntimeExperienceValidationState = "candidate" | "validated" | "deprecated";

export interface RuntimeExperience {
  id: string;
  tenantId: string;
  shopId: string;
  agentId: string;
  taskType: RuntimeParserIntent;
  /** A short, deterministic description of the situation - never freeform model narration. */
  situation: string;
  /** A stable key identifying "the same lesson recurring" for deduplication/corroboration. */
  lessonKey: string;
  recipeId: string | null;
  recipeVersion: number | null;
  /** `RetrievedAgentContextItem.sourceId` values consulted for the execution this was drawn from. */
  evidenceRefs: string[];
  toolSequence: RuntimeToolName[];
  resultType: string;
  verificationResult: string | null;
  outcome: RuntimeExperienceOutcome;
  lesson: string;
  validationState: RuntimeExperienceValidationState;
  /** Corroborations under the trigger's evidence policy. Business-task lessons additionally
   *  require disjoint authoritative source episodes, not just distinct turns. */
  corroborationCount: number;
  /** Bounded durable replay ledger. Older records may only identify sourceTurnId. */
  corroboratingTurnIds?: string[];
  /** The turn extraction last ran from - diagnostic only, never used to resume execution. */
  sourceTurnId: string;
  createdAt: string;
  updatedAt: string;
  deprecatedAt: string | null;
  environmentScope?: {
    environmentId: string;
    environmentVersion: string;
    contextKey: string;
    sourceMask: string;
    sourceFingerprints: string[];
    taskIds: string[];
  };
}

export type AgentEvaluationEventType =
  | "business_task_verification"
  | "intent_classification"
  | "context_retrieval"
  | "tool_selection"
  | "tool_execution"
  | "policy_compliance"
  | "customer_correction"
  | "owner_correction"
  | "sale_completed"
  | "order_abandoned"
  | "escalation_required"
  | "unsupported_request"
  | "response_latency"
  | "model_failure"
  | "hallucinated_product_or_price"
  | "invalid_discount_attempt"
  | "customer_satisfaction"
  | "owner_feedback";

export interface AgentEvaluationEvent {
  id: string;
  tenantId: string;
  shopId: string;
  agentId: string;
  sessionId: string | null;
  messageId: string | null;
  eventType: AgentEvaluationEventType;
  outcome: "success" | "partial" | "failure" | "blocked";
  score: number | null;
  reason: string | null;
  metadata: Record<string, string | number | boolean | null>;
  runtimeVersion: number;
  modelId: string | null;
  createdAt: string;
}

export interface AgentEvaluationSummary {
  tenantId: string;
  shopId: string;
  runtimeVersion: number;
  total: number;
  success: number;
  partial: number;
  failure: number;
  blocked: number;
  averageScore: number | null;
  /**
   * Turns where the parser/model asked the merchant to clarify, as a distinct count from the
   * broader "partial" bucket (which also includes healthy needs_confirmation turns) - METR's
   * "Measuring AI Ability to Complete Long Software Tasks" finding that models degrade on long,
   * under-specified interactions is only checkable if clarify requests are counted on their own.
   */
  clarifying: number;
  /**
   * Average RuntimeSessionSummary.turnCount at the moment a clarifying turn happened, across the
   * same sampled events "clarifying" is counted from. A rising value over time is the concrete,
   * traceable signal for the degradation METR's paper describes - clarifies clustering late in
   * long sessions rather than at a session's first turn or two. Null when no clarifying turns have
   * been recorded yet.
   */
  averageSessionTurnCountAtClarify: number | null;
  recentEvents: AgentEvaluationEvent[];
  environmentOutcomes?: EnvironmentEvaluation[];
}

export interface EnvironmentEvaluation {
  verificationId: string;
  taskId: string;
  stepId: string;
  environmentId: string;
  environmentVersion: string;
  evaluationPolicyId: string | null;
  executionSuccess: boolean | null;
  constraintViolations: number | null;
  executionAccuracy: number | null;
  toolCalls: number | null;
  toolEfficiency: number | null;
  latencyMs: number | null;
  modelLatencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  humanInterventions: number | null;
  reward: number | null;
  outcomeStatus: "VERIFIED" | "PENDING" | "INCONCLUSIVE" | "FAILED";
  inventory: {
    budgetCompliance: number | null;
    orderAccuracy: number | null;
    forecastAccuracy: number | null;
    stockoutReduction: number | null;
  } | null;
  event: AgentEvaluationEvent;
}

/**
 * MUSE-adoption brief §16/§17: "P = f(M, C, T, R)" - the model, context recipe, tools, and runtime
 * a group of turns actually ran with, so different configurations can be compared systematically.
 * `modelId`/`recipeId` are `null` when a turn used no resolvable model (a fully deterministic
 * proposal) or matched no `ContextRecipe` (an intent with no recipe, e.g. "unknown"). Distinct from
 * `TemplateReportCard` (model-templates domain): that compares Model Template *versions* in an
 * offline evaluation run; this compares live runtime turns as they actually executed, grouped by
 * what configuration answered them - a read-only aggregation over already-recorded
 * `RuntimeTurnSummary`/telemetry data, not a second evaluate/gate/promote pipeline.
 */
export interface RuntimeReportCardKey {
  runtimeVersion: number;
  modelId: string | null;
  recipeId: string | null;
}

export interface RuntimeReportCard {
  key: RuntimeReportCardKey;
  sampleSize: number;
  taskSuccessRate: number;
  /** Turns ending in clarifying/blocked as a share of sampleSize - the brief's "abstention
   *  correctness" is a judgment call on top of this raw rate, not computed here. */
  abstentionRate: number;
  /** Share of grounding-evaluated turns that were accepted, or `null` if this group had no
   *  grounding-policy recipe among its turns. */
  groundedAcceptRate: number | null;
  toolCallRate: number;
  averageLatencyMs: number | null;
  averagePromptTokens: number | null;
  averageCompletionTokens: number | null;
  averageContextTokens: number | null;
}

export interface CompiledAgentInstructionSet {
  precedence: [
    "platform_security",
    "tenant_identity",
    "business_policy",
    "personality",
    "task",
    "retrieved_context",
    "tools",
    "memory",
    "output_contract"
  ];
  platformRules: string[];
  identityRules: string[];
  businessRules: string[];
  personalityRules: string[];
  outputRules: string[];
}

export type RuntimeReadinessIssue =
  | "AGENT_NOT_FOUND"
  | "MODEL_NOT_SELECTED"
  | "MODEL_UNAVAILABLE"
  | "INVALID_RUNTIME_PROFILE"
  | "CONTEXT_SERVICE_UNAVAILABLE"
  | "TOOL_REGISTRY_UNAVAILABLE"
  | "SESSION_CREATION_FAILED"
  | "TENANT_BINDING_INVALID";

export interface AgentRuntimeReadiness {
  tenantId: string;
  shopId: string;
  agentId: string;
  runtimeVersion: number;
  ready: boolean;
  issues: Array<{
    code: RuntimeReadinessIssue;
    message: string;
    actionable: boolean;
  }>;
  checkedAt: string;
}

/** Backend-derived effective runtime used by chat and settings. It exposes resource identity and
 * readiness only; host endpoints and credentials never cross the API boundary. */
export interface EffectiveRuntimeSummary {
  agent: { id: string; name: string; runtimeAdapterId: string };
  model: { id: string; name: string };
  execution: {
    type: ModelExecutionTarget;
    hostId: string | null;
    ready: boolean;
  };
  binding: { id: string } | null;
  source: NativeRuntimeResolutionSource;
  status: "READY" | "UNAVAILABLE" | "ERROR";
  ready: boolean;
}

/** Native, database-backed runtime graph. Agents, models, and hosts are independent slots. */
export type NativeRuntimeEntityStatus = "active" | "inactive";
export type NativeRuntimeAvailabilityStatus =
  | "registered"
  | "online"
  | "healthy"
  | "temporarily-unavailable"
  | "disabled"
  | "incompatible"
  | "available"
  | "unavailable";
export type NativeRuntimeBindingStatus = "draft" | "active" | "inactive" | "failed";

export interface NativeRuntimeAgentSummary {
  id: string;
  businessId: string | null;
  accountId: string | null;
  name: string;
  provider: string;
  packageRef: string | null;
  version: string;
  runtimeContractVersion: string;
  capabilities: string[];
  configuration: Record<string, unknown>;
  status: NativeRuntimeEntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NativeRuntimeModelSummary {
  id: string;
  name: string;
  provider: string;
  providerModelId: string;
  runtimeContractVersion: string;
  capabilities: string[];
  configuration: Record<string, unknown>;
  status: NativeRuntimeEntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NativeExecutionHostSummary {
  id: string;
  businessId: string | null;
  accountId: string | null;
  type: string;
  name: string;
  endpoint: string | null;
  status: NativeRuntimeAvailabilityStatus;
  capabilities: string[];
  configuration: Record<string, unknown>;
  credentialReference: string | null;
  lastKnownHealthyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeModelInstallationSummary {
  id: string;
  modelId: string;
  executionHostId: string;
  status: NativeRuntimeAvailabilityStatus;
  configuration: Record<string, unknown>;
  lastKnownHealthyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeRuntimeBindingSummary {
  id: string;
  businessId: string | null;
  accountId: string | null;
  agentId: string;
  name: string;
  status: NativeRuntimeBindingStatus;
  isDefault: boolean;
  configuration: Record<string, unknown>;
  runtimeContractVersion: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface NativeRuntimeActivationInput {
  businessId: string;
  accountId: string;
  agentId: string;
  agentName: string;
  agentRuntimeAdapterId?: string;
  model: AiModelSummary;
  executionTarget: ModelExecutionTarget;
  fallbackModel: AiModelSummary | null;
  fallbackExecutionTarget?: ModelExecutionTarget;
  updatedBy: string;
  checkedAt: string;
}

/**
 * A model/host pair that has been verified by the execution adapter for automatic runtime
 * provisioning. Provider identity remains model metadata; `executionTarget` is only location.
 */
export interface NativeRuntimeProvisioningCandidate {
  model: AiModelSummary;
  executionTarget: ModelExecutionTarget;
  checkedAt: string;
}

/** The single input to native runtime resolution. Conversation-scoped callers supply a
 * conversation id; direct merchant/runtime-session callers do not. Both resolve through the same
 * precedence implementation. */
export interface NativeRuntimeResolutionInput {
  businessId: string;
  /** Authenticated account for direct runtime calls. Conversation calls derive this from the
   * conversation when omitted, so account overrides keep the same scope on reads and writes. */
  accountId?: string;
  agentId: string;
  conversationId?: string;
}

export type NativeRuntimeResolutionSource =
  "explicit-conversation" | "explicit-account" | "default";

export interface NativeDefaultRuntimeProvisioningInput {
  /** Absent when the caller is a non-conversation surface (e.g. the merchant's own runtime-session
   *  chat with their shop's agent) - provisioning is keyed on businessId/accountId/agentId either
   *  way, and a conversation's runtimeBindingId is only updated when one is supplied. */
  conversationId?: string;
  businessId: string;
  accountId: string;
  agentId: string;
  agentName: string;
  agentRuntimeAdapterId?: string;
  candidates: NativeRuntimeProvisioningCandidate[];
  updatedBy: string;
  checkedAt: string;
}

export interface NativeDefaultRuntimeProvisioningResult {
  binding: NativeRuntimeBindingSummary;
  created: boolean;
  resolutionReason:
    "existing-binding-preserved" | "hosted-fallback-attached" | "default-binding-created";
}

export interface NativeRuntimeBindingModelSummary {
  id: string;
  runtimeBindingId: string;
  modelId: string;
  /** Extensible role name: primary/fallback plus future verifier, vision, coding, etc. */
  role: string;
  priority: number;
  executionHostId: string | null;
  configuration: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedNativeRuntimeModel {
  bindingModel: NativeRuntimeBindingModelSummary;
  model: NativeRuntimeModelSummary;
  installation: NativeModelInstallationSummary | null;
  host: NativeExecutionHostSummary | null;
  available: boolean;
  unavailabilityReason: string | null;
}

export interface ResolvedNativeRuntimeBinding {
  conversationId: string;
  usedGlobalDefault: boolean;
  source: NativeRuntimeResolutionSource;
  binding: NativeRuntimeBindingSummary;
  agent: NativeRuntimeAgentSummary;
  primary: ResolvedNativeRuntimeModel;
  fallbacks: ResolvedNativeRuntimeModel[];
  auxiliaries: Record<string, ResolvedNativeRuntimeModel[]>;
  selected: ResolvedNativeRuntimeModel;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  configuration: Record<string, unknown>;
}

/** The flat, agent-scoped read shape for "which model is this agent using" - the single
 *  per-shop-agent binding lookup that replaced the retired legacy agentModelBindings
 *  map/table (see cp2/domains/native-runtime/store.ts getActiveBindingForAgent, the sole
 *  producer, and cp2/domains/agent-runtime/native-binding-projection.ts, the sole consumer).
 *  `executionTarget` is resolved the same way turn-time resolution resolves it (host type,
 *  falling back to the model's declared configuration), so callers never need to reach into
 *  either object's loose `configuration` bag themselves. */
export interface ActiveNativeAgentBinding {
  binding: NativeRuntimeBindingSummary;
  model: NativeRuntimeModelSummary;
  role: NativeRuntimeBindingModelSummary;
  executionTarget: ModelExecutionTarget;
}

/** Merchant-facing copy in every language the owner app ships. */
export interface ShopHubText {
  en: string;
  sw: string;
}

export type ShopCapabilitySetupState = "ready" | "needs_setup" | "unavailable";

export interface ShopCapabilityTool {
  name: string;
  label: ShopHubText;
  readOnly: boolean;
  requiresConfirmation: boolean;
  risk: "low" | "medium" | "high" | "critical";
}

export interface ShopCapabilityModule {
  id: string;
  icon: string;
  label: ShopHubText;
  description: ShopHubText;
  setup: {
    state: ShopCapabilitySetupState;
    /** Null when ready. */
    reason: ShopHubText | null;
  };
  /** Only the tools the caller's role may invoke. */
  tools: ShopCapabilityTool[];
}

export interface ShopCapabilityCategory {
  id: string;
  label: ShopHubText;
  modules: ShopCapabilityModule[];
}

/**
 * GET /businesses/:businessId/capabilities - the Shop Hub, projected from the canonical tool and
 * module registries in @grogoni/tool-core and filtered by the caller's role in this business.
 */
export interface ShopCapabilitiesSummary {
  businessId: string;
  role: BusinessRole;
  categories: ShopCapabilityCategory[];
  /** Modules in `needs_setup`, in hub order - the needs-attention strip. */
  needsAttention: Array<{ moduleId: string; label: ShopHubText; reason: ShopHubText }>;
  checkedAt: string;
}
