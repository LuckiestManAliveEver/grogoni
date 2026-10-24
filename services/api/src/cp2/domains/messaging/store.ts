/**
 * Eighth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns every messaging/channels Map:
 * `conversations`, `conversationParticipants`, `conversationMessages`, `platformIdentities`,
 * `conversationChannels`, `providerUpdateReceipts`, `channelIdentityLinkGrants`,
 * `nativeSmsDevices`, `nativeSmsDeviceCommands`, `connectedMailboxes`,
 * `connectedMailboxOAuthSessions`, `customerRuntimeCapabilities`, `messageDeliveryAttempts`,
 * `messageNotificationDeliveries`, `e2eeDevices`, `pushSubscriptions` (+ derived
 * `pushSubscriptionIdByEndpoint`), `conversationTyping` (ephemeral, never persisted), and the
 * two derived message-lookup indexes `messageByClientId`/`messageByIdempotencyKey`.
 *
 * `customerRuntimeCapabilities` and `pushSubscriptions`/`pushSubscriptionIdByEndpoint` were not
 * in the roadmap's original row-7 Map list - reading the method bodies during this extraction
 * showed they are exclusively messaging/storefront infrastructure (a hashed bearer token scoping
 * an anonymous storefront visitor to one conversation, and Web Push subscriptions respectively),
 * so they moved here too rather than staying stranded on `Cp2Store`.
 *
 * **Load-bearing invariant - read before touching `createConversationMessage` or
 * `updateConversationMessage`:** `validateConversationEncryption` (below) enforces that once a
 * conversation has two or more distinct human `role: "account"` participants, every user message must
 * be `content.type === "encrypted"`, every participant must have a live registered
 * `e2eeDevices` entry, and the encrypted envelope's recipient device set must exactly match the
 * live device set. Dropping or reordering this check re-opens a real confidentiality regression:
 * plaintext would persist into `conversationMessages`/Postgres and leak into push-notification
 * payloads for a conversation the product promises is end-to-end encrypted.
 * `tests/cp20-unified-session-conversations.test.ts`'s "supports full direct-message lifecycle
 * across two accounts" test is the direct regression check (asserts a plaintext POST to a
 * two-account conversation 400s with `e2ee_required`) - it must keep failing-if-broken after any
 * future change here.
 *
 * Coupling with the not-yet-extracted domains, resolved as constructor-injected callbacks/raw
 * Map references (same pattern used throughout this refactor):
 * - Core auth/identity kernel (`accounts`, `users`, `userByAccount`, `businesses`, `memberships`,
 *   `sessions`, `accountByDestination`) - read-only raw Map references, same shape `NetworkDomain`
 *   already uses.
 * - Customer ownership (`customers` Map, `requireCustomer`, `createGuestCustomer`) - stays on
 *   `Cp2Store` since customer CRUD (`updateCustomer`, `linkCustomerAccount`) isn't messaging and
 *   isn't extracted yet; injected the same way `CommerceDomainDeps` already takes `customers`.
 * - Invoicing (`requireInvoice`, used only by `resolveTrustedEmailAttachments` to attach a
 *   confirmed invoice to an outbound email) - single callback.
 * - Agent/AI runtime (`createRuntimeTurn`, `agentModelRecoveryGuidance`) - both stay on
 *   `Cp2Store` (domain 8, not yet extracted); injected as callbacks exactly like
 *   `DocumentImportDomainDeps.createSupplier`/`LogisticsDomainDeps.requireInvoice` already do for
 *   their own not-yet-extracted dependencies.
 * - `attemptPublicAgentReply` - deliberately **not** moved here even though
 *   `createPublicStorefrontMessage` is its only caller: it depends on six separate agent-runtime
 *   primitives (`computeAgentRuntimeReadiness`, `currentAgentProfile`,
 *   `resolveActiveRuntimeModelId`, `buildShopAgentRuntime`, `resolveRuntimeModelProvider`,
 *   `contextSourcesForRuntime`) that will all move together when domain 8 is eventually
 *   extracted. Injecting all six here now would create churn on both sides of that future PR for
 *   no present benefit, so it stays on `Cp2Store` as a single injected callback instead. It calls
 *   back into this domain's `persistExternalConversationMessage`/`persistExternalProductCard`/
 *   `publicMessageView`/`requireCustomerCapability`, which is why those four are deliberately
 *   public rather than private, mirroring `ComplianceDomain`'s public `getOrCreate*` accessors
 *   for the same reason.
 * - `requirePublicStorefrontBusiness` moved into this domain's `shared.ts` as a standalone
 *   function (takes `businesses`/`quarantinedBusinessIds` as parameters) since `Cp2Store` still
 *   needs it too (`createPublicOrder`, which stays - it owns `publicOrders`/`invoices`, not a
 *   messaging concern, and only reads `platformIdentities` via this domain's public map getter).
 * - `ChannelGateway`/`EmailMailboxProviderClient` stay exactly where they already lived
 *   (`services/api/src/messaging/`) - both are pure adapter/client objects with no `Cp2Store`
 *   Map ownership, injected here unchanged. The two `channelGateway.registerAdapter(...)` calls
 *   moved from `Cp2Store`'s constructor into this domain's constructor since their closures
 *   reference `nativeSmsTransportReadiness`/`queueNativeSmsCommand`/`emailTransportReadiness`/
 *   `sendEmailTransport`, all of which live here now.
 */
import { contactIsBlocked } from "../network/shared.js";
import { helpConversationId, helpGuides, helpGuideText } from "./help-guides.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { InventoryTaskController } from "../agent-runtime/inventory-task-controller.js";
import type {
  PurchaseOrderActor,
  PurchaseOrderDelivery,
  PurchaseOrderSubmission
} from "../agent-runtime/purchase-order-store.js";
import { resolve } from "node:path";
import type {
  AccountSummary,
  AuthChannel,
  AuthSessionView,
  AuthenticatedActorView,
  BusinessSummary,
  CatalogueQueryResult,
  ChannelEndpointSummary,
  ChannelMessageSendResult,
  ChannelProvider,
  ChannelProviderReadiness,
  ClientWorkspaceFileTransfer,
  ConnectedMailboxOAuthStartSummary,
  ConnectedMailboxProvider,
  ConnectedMailboxProviderSummary,
  ConnectedMailboxSummary,
  ConnectedMailboxSyncSummary,
  ConversationAttachment,
  ConversationChannelSummary,
  ConversationExecutionSummary,
  ConversationInboxItem,
  ConversationKind,
  ConversationMessageAuthor,
  ConversationMessageContent,
  ConversationMessageSummary,
  ConversationParticipantSummary,
  ConversationSummary,
  ConversationTypingSummary,
  ConversationView,
  CustomerSummary,
  E2eeDeviceSummary,
  E2eePublicKey,
  InvoiceSummary,
  MembershipSummary,
  MessageChannel,
  MessageDeliveryAttemptSummary,
  MessageHandoffChannel,
  MessageHandoffStatus,
  MessageHandoffSummary,
  NativeSmsDeviceCapability,
  NativeSmsDeviceCommandSummary,
  NativeSmsDeviceSummary,
  NativeSmsExecutableCommand,
  NativeSmsInboundResult,
  NativeSmsResultCode,
  OfflineOrderIntent,
  OfflineOrderIntentOutcome,
  PlatformIdentitySummary,
  ProductSummary,
  ProviderUpdateReceiptSummary,
  PublicDaemonTask,
  PublicStorefrontMessageSummary,
  PushSubscriptionSummary,
  RecycleBinItemSummary,
  RecycleBinStatusSummary,
  RuntimeModelConversationMessage,
  RuntimeTurnResult,
  StoredGrogoniSessionContext,
  SyncChange,
  SyncCollection,
  TrustedMessageAttachmentReference,
  UserSummary,
  WorkspaceDeliverResult
} from "@grogoni/shared-types";
import type { BusinessPermission } from "@grogoni/business-core";
import {
  ChannelGatewayError,
  type CanonicalInboundChannelMessage,
  createEmailChannelAdapter,
  createNativeSmsChannelAdapter,
  providerToMessageChannel,
  type ChannelGateway,
  type OutboundChannelMessage
} from "../../../messaging/channel-gateway.js";
import {
  EmailProviderClientError,
  type EmailMailboxProviderClient,
  type EmailProviderTokens,
  type NormalizedProviderEmail
} from "../../../messaging/email-provider-client.js";
import { Cp2Error } from "../../cp2-error.js";
import {
  managedAttachmentFromRecord,
  resolveTransferredWorkspaceFile,
  resolveWorkspaceFile,
  type ConversationAttachmentRecord
} from "../../workspace-file-delivery.js";
import { decryptOAuthToken, encryptOAuthToken, hashOAuthSecret } from "../../oauth.js";
import {
  offlineOrderClarificationMessage,
  offlineOrderOutcomeMessage,
  parseOfflineOrderText
} from "../agent-runtime/offline-order-planning.js";
import {
  normalizeDestination,
  normalizeInternationalOwnerPhoneNumber
} from "../../phone-identity.js";
import {
  normalizeOptionalBoundedText,
  normalizeRequiredBoundedText
} from "../../text-normalization.js";
import type { Cp2Snapshot, SessionRecord } from "../../store.js";
import type { ConversationAttachmentBlobStore } from "../../conversation-attachment-blob-store.js";
import {
  connectedMailboxView,
  hashCustomerCapability,
  isBase64Url,
  isEmailReauthorizationError,
  isRecoverableAgentModelChatError,
  mailboxOAuthSessionTtlMs,
  mailboxScopeAllows,
  nativeSmsCommandTtlMs,
  nativeSmsDeviceRequirement,
  nativeSmsMissingCapabilityCode,
  nativeSmsOnlineWindowMs,
  nativeSmsReadinessErrorCode,
  nativeSmsReadinessFromRegistration,
  normalizeAbsoluteHttpUrl,
  normalizeEmailIdentity,
  normalizeEmailSubject,
  normalizeExistingCustomerPhone,
  normalizeMailboxHistoryDays,
  normalizeNativeSmsOccurredAt,
  normalizeNativeSmsSubscriptionId,
  normalizePositiveInteger,
  normalizeStoredEmailIdentity,
  renderInvoiceAttachment,
  requirePublicStorefrontBusiness,
  sanitizeAttachmentFilename,
  validateConversationMessageContent,
  validateE2eePublicKey,
  type AgentConversationMessageResult,
  type AppUpdateBroadcastSummary,
  type ChannelIdentityLinkGrantRecord,
  type ConnectedMailboxBackgroundSyncSummary,
  type ConnectedMailboxOAuthSessionRecord,
  type ConnectedMailboxRecord,
  type CustomerRuntimeCapabilityRecord,
  type MessageNotificationDelivery,
  type MessageNotificationDeliveryRunSummary,
  type PublicStorefrontSessionResult
} from "./shared.js";

/** How long a deleted conversation sits in the recycle bin before a background sweep purges it. */
export const RECYCLE_BIN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Total serialized size (conversation + messages + participants, per scope) the recycle bin will
 * hold before new deletions are refused with `recycle_bin_full` and an admin has to empty it.
 */
export const RECYCLE_BIN_CAPACITY_BYTES = 5 * 1024 * 1024;
const systemChannelDelivery = Symbol("systemChannelDelivery");

export interface MessagingDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthSessionView;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  recordSyncChange: (input: {
    accountId: string;
    collection: SyncCollection;
    entityId: string;
    operation: "upsert" | "delete";
    shopId: string | null;
    entity: unknown | null;
    now: Date;
  }) => SyncChange;
  requireMembership: (businessId: string, userId: string) => MembershipSummary;
  requireBusiness: (businessId: string) => BusinessSummary;
  requireCustomer: (businessId: string, customerId: string) => CustomerSummary;
  createGuestCustomer: (input: {
    businessId: string;
    displayName?: string | null;
    provider: ChannelProvider;
    externalUserId: string;
    now: Date;
  }) => CustomerSummary;
  requireInvoice: (businessId: string, invoiceId: string) => InvoiceSummary;
  /** Same callback shape as requireInvoice above - offline-order reconciliation isn't extracted
   *  out of Cp2Store yet either, and SMS order parsing needs the live product catalogue to match
   *  quoted item names against. */
  productsForBusiness: (businessId: string) => ProductSummary[];
  /** The one reconciliation path for OfflineOrderIntent, whichever transport captured it - see
   *  Cp2Store.pushOfflineOrderIntents. Injected rather than duplicated here. */
  pushOfflineOrderIntents: (
    sessionId: string | null,
    intents: OfflineOrderIntent[]
  ) => OfflineOrderIntentOutcome[];
  createChannelOrder: (input: {
    businessId: string;
    customerId: string;
    provider: ChannelProvider;
    actorId: string;
    items: Array<{ productId: string; quantity: number; name: string }>;
    idempotencyKey: string;
    now: Date;
  }) => OfflineOrderIntentOutcome;
  ensureGrogoniSessionContext: (session: AuthSessionView, now: Date) => StoredGrogoniSessionContext;
  createRuntimeTurn: (input: {
    sessionId: string | null;
    businessId: string;
    conversationId?: string;
    runtimeSessionId?: string;
    message: string;
    conversationHistory?: RuntimeModelConversationMessage[];
    signal?: AbortSignal;
    now?: Date;
  }) => Promise<RuntimeTurnResult>;
  agentModelRecoveryGuidance: (businessId: string, error: Cp2Error) => string;
  attemptPublicAgentReply: (input: {
    businessId: string;
    capability: CustomerRuntimeCapabilityRecord;
    visitorId: string;
    body: string;
    now: Date;
  }) => Promise<PublicStorefrontMessageSummary | null>;
  assignRuntimeBinding: (input: {
    accountId: string;
    activeShopId: string | null;
    requestedBindingId?: string | null;
  }) => string;
  channelGateway: ChannelGateway;
  emailMailboxProviderClient: EmailMailboxProviderClient;
  pushNotificationSender?: (
    subscription: PushSubscriptionSummary,
    payload:
      | {
          type: "message.new";
          conversationId: string;
          messageId: string;
          title: string;
          body: string;
        }
      | {
          type: "app.update_available";
          deployId: string;
          service: string;
          title: string;
          body: string;
        }
      | {
          type: "network.connection";
          connectionId: string;
          event: "requested" | "accepted";
          title: string;
          body: string;
        }
  ) => Promise<"sent" | "failed" | "expired">;
  messageEmailNotificationSender?: (input: {
    conversationId: string;
    messageId: string;
    openUrl: string;
    to: string;
  }) => Promise<"sent" | "failed" | "expired">;
  messageWebBaseUrl?: string;
  accounts: Map<string, AccountSummary>;
  users: Map<string, UserSummary>;
  userByAccount: Map<string, string>;
  businesses: Map<string, BusinessSummary>;
  memberships: Map<string, MembershipSummary>;
  sessions: Map<string, SessionRecord>;
  customers: Map<string, CustomerSummary>;
  quarantinedBusinessIds: Set<string>;
  resolveContactAccount: (channel: AuthChannel, destination: string) => string | undefined;
  resolvePhonebookAccount: (ownerUserId: string, nodeId: string) => string | null;
  findPhonebookNode: (ownerUserId: string, counterpartAccountId: string) => string | null;
  verifiedNotificationEmail: (accountId: string) => string | undefined;
  workspaceRoot?: string;
  workspaceDeliveryMaxFileBytes?: number;
  conversationAttachmentBlobStore: ConversationAttachmentBlobStore;
}

export class MessagingDomain {
  private inventoryTaskController: InventoryTaskController | undefined;
  private readonly conversations = new Map<string, ConversationSummary>();
  private readonly conversationParticipants = new Map<string, ConversationParticipantSummary>();
  private readonly conversationMessages = new Map<string, ConversationMessageSummary>();
  private readonly conversationAttachments = new Map<string, ConversationAttachmentRecord>();
  private readonly platformIdentities = new Map<string, PlatformIdentitySummary>();
  private readonly conversationChannels = new Map<string, ConversationChannelSummary>();
  private readonly providerUpdateReceipts = new Map<string, ProviderUpdateReceiptSummary>();
  private readonly channelIdentityLinkGrants = new Map<string, ChannelIdentityLinkGrantRecord>();
  private readonly nativeSmsDevices = new Map<string, NativeSmsDeviceSummary>();
  private readonly nativeSmsDeviceCommands = new Map<string, NativeSmsDeviceCommandSummary>();
  private readonly connectedMailboxes = new Map<string, ConnectedMailboxRecord>();
  private readonly connectedMailboxOAuthSessions = new Map<
    string,
    ConnectedMailboxOAuthSessionRecord
  >();
  private readonly customerRuntimeCapabilities = new Map<string, CustomerRuntimeCapabilityRecord>();
  private readonly messageDeliveryAttempts = new Map<string, MessageDeliveryAttemptSummary>();
  private readonly messageNotificationDeliveries = new Map<string, MessageNotificationDelivery>();
  private readonly e2eeDevices = new Map<string, E2eeDeviceSummary>();
  private readonly pushSubscriptions = new Map<string, PushSubscriptionSummary>();
  private readonly pushSubscriptionIdByEndpoint = new Map<string, string>();
  private readonly conversationTyping = new Map<
    string,
    ConversationTypingSummary & { conversationId: string }
  >();
  private readonly messageByClientId = new Map<string, string>();
  private readonly messageByIdempotencyKey = new Map<string, string>();

  setInventoryTaskController(controller: InventoryTaskController): void {
    this.inventoryTaskController = controller;
  }

  constructor(private readonly deps: MessagingDomainDeps) {
    this.deps.channelGateway.registerAdapter(
      createNativeSmsChannelAdapter({
        readiness: (businessId) => this.nativeSmsTransportReadiness(businessId, new Date()),
        queue: (request) => this.queueNativeSmsCommand(request, new Date())
      })
    );
    this.deps.channelGateway.registerAdapter(
      createEmailChannelAdapter({
        readiness: (businessId) => this.emailTransportReadiness(businessId),
        send: (request) => this.sendEmailTransport(request, new Date())
      })
    );
  }

  get conversationsMap(): Map<string, ConversationSummary> {
    return this.conversations;
  }

  get conversationParticipantsMap(): Map<string, ConversationParticipantSummary> {
    return this.conversationParticipants;
  }

  get conversationMessagesMap(): Map<string, ConversationMessageSummary> {
    return this.conversationMessages;
  }

  get conversationAttachmentsMap(): Map<string, ConversationAttachmentRecord> {
    return this.conversationAttachments;
  }

  deleteConversationAttachmentsForBusiness(businessId: string): number {
    return this.deleteConversationAttachmentsWhere(
      (attachment) => attachment.businessId === businessId
    );
  }

  deleteConversationAttachmentsForAccount(accountId: string): number {
    return this.deleteConversationAttachmentsWhere(
      (attachment) => attachment.accountId === accountId
    );
  }

  get platformIdentitiesMap(): Map<string, PlatformIdentitySummary> {
    return this.platformIdentities;
  }

  get conversationChannelsMap(): Map<string, ConversationChannelSummary> {
    return this.conversationChannels;
  }

  get providerUpdateReceiptsMap(): Map<string, ProviderUpdateReceiptSummary> {
    return this.providerUpdateReceipts;
  }

  get channelIdentityLinkGrantsMap(): Map<string, ChannelIdentityLinkGrantRecord> {
    return this.channelIdentityLinkGrants;
  }

  get nativeSmsDevicesMap(): Map<string, NativeSmsDeviceSummary> {
    return this.nativeSmsDevices;
  }

  get nativeSmsDeviceCommandsMap(): Map<string, NativeSmsDeviceCommandSummary> {
    return this.nativeSmsDeviceCommands;
  }

  get connectedMailboxesMap(): Map<string, ConnectedMailboxRecord> {
    return this.connectedMailboxes;
  }

  get connectedMailboxOAuthSessionsMap(): Map<string, ConnectedMailboxOAuthSessionRecord> {
    return this.connectedMailboxOAuthSessions;
  }

  get customerRuntimeCapabilitiesMap(): Map<string, CustomerRuntimeCapabilityRecord> {
    return this.customerRuntimeCapabilities;
  }

  get messageDeliveryAttemptsMap(): Map<string, MessageDeliveryAttemptSummary> {
    return this.messageDeliveryAttempts;
  }

  get messageNotificationDeliveriesMap(): Map<string, MessageNotificationDelivery> {
    return this.messageNotificationDeliveries;
  }

  get e2eeDevicesMap(): Map<string, E2eeDeviceSummary> {
    return this.e2eeDevices;
  }

  get pushSubscriptionsMap(): Map<string, PushSubscriptionSummary> {
    return this.pushSubscriptions;
  }

  get pushSubscriptionIdByEndpointMap(): Map<string, string> {
    return this.pushSubscriptionIdByEndpoint;
  }

  get conversationTypingMap(): Map<string, ConversationTypingSummary & { conversationId: string }> {
    return this.conversationTyping;
  }

  get messageByClientIdMap(): Map<string, string> {
    return this.messageByClientId;
  }

  get messageByIdempotencyKeyMap(): Map<string, string> {
    return this.messageByIdempotencyKey;
  }

  clear(): void {
    this.conversations.clear();
    this.conversationParticipants.clear();
    this.conversationMessages.clear();
    this.conversationAttachments.clear();
    this.platformIdentities.clear();
    this.conversationChannels.clear();
    this.providerUpdateReceipts.clear();
    this.channelIdentityLinkGrants.clear();
    this.nativeSmsDevices.clear();
    this.nativeSmsDeviceCommands.clear();
    this.connectedMailboxes.clear();
    this.connectedMailboxOAuthSessions.clear();
    this.customerRuntimeCapabilities.clear();
    this.messageDeliveryAttempts.clear();
    this.messageNotificationDeliveries.clear();
    this.e2eeDevices.clear();
    this.pushSubscriptions.clear();
    this.pushSubscriptionIdByEndpoint.clear();
    this.conversationTyping.clear();
    this.messageByClientId.clear();
    this.messageByIdempotencyKey.clear();
  }

  rebuildDerivedIndexes(): void {
    this.messageByClientId.clear();
    this.messageByIdempotencyKey.clear();
    for (const message of this.conversationMessages.values()) {
      this.messageByClientId.set(
        `${message.conversationId}:${message.clientMessageId}`,
        message.id
      );
      this.messageByIdempotencyKey.set(
        `${message.conversationId}:${message.idempotencyKey}`,
        message.id
      );
    }

    this.pushSubscriptionIdByEndpoint.clear();
    for (const subscription of this.pushSubscriptions.values()) {
      this.pushSubscriptionIdByEndpoint.set(subscription.endpoint, subscription.id);
    }
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const conversation of snapshot.conversations ?? []) {
      this.conversations.set(conversation.id, {
        ...conversation,
        runtimeBindingId: conversation.runtimeBindingId ?? null
      });
    }

    for (const participant of snapshot.conversationParticipants ?? []) {
      this.conversationParticipants.set(participant.id, participant);
    }

    for (const attachment of snapshot.conversationAttachments ?? []) {
      this.conversationAttachments.set(attachment.id, attachment);
    }

    for (const message of snapshot.conversationMessages ?? []) {
      const restored: ConversationMessageSummary = {
        ...message,
        idempotencyKey:
          message.idempotencyKey ?? `grogoni:${message.conversationId}:${message.clientMessageId}`,
        queuedAt: message.queuedAt ?? null,
        sentAt:
          message.sentAt === undefined
            ? message.status === "sent" ||
              message.status === "delivered" ||
              message.status === "read" ||
              message.status === undefined
              ? (message.deliveredAt ?? message.createdAt)
              : null
            : message.sentAt,
        failureCode: message.failureCode ?? null,
        retryCount: message.retryCount ?? 0,
        nextRetryAt: message.nextRetryAt ?? null,
        selectedChannel: message.selectedChannel ?? "grogoni",
        actualChannel:
          message.actualChannel === undefined
            ? message.status === "sent" ||
              message.status === "delivered" ||
              message.status === "read" ||
              message.status === undefined
              ? "grogoni"
              : null
            : message.actualChannel,
        providerMessageId: message.providerMessageId ?? null,
        provider:
          message.provider ?? (message.selectedChannel === "telegram" ? "telegram" : "grogoni"),
        direction:
          message.direction ??
          (snapshot.platformIdentities?.some((identity) => identity.id === message.authorId)
            ? "inbound"
            : "outbound"),
        externalConversationId: message.externalConversationId ?? null,
        channelIdentityId: message.channelIdentityId ?? null,
        importedSource: message.importedSource ?? null,
        importedExternalId: message.importedExternalId ?? null,
        consentRecordId: message.consentRecordId ?? null
      };
      this.conversationMessages.set(restored.id, restored);
      this.messageByClientId.set(
        `${restored.conversationId}:${restored.clientMessageId}`,
        restored.id
      );
      this.messageByIdempotencyKey.set(
        `${restored.conversationId}:${restored.idempotencyKey}`,
        restored.id
      );
    }

    for (const identity of snapshot.platformIdentities ?? []) {
      this.platformIdentities.set(identity.id, {
        ...identity,
        customerId: identity.customerId ?? null,
        verifiedAt: identity.verifiedAt ?? null,
        optInStatus: identity.optInStatus ?? "unknown",
        optInSource: identity.optInSource ?? null,
        optInAt: identity.optInAt ?? null,
        optOutAt: identity.optOutAt ?? null
      });
    }
    for (const channel of snapshot.conversationChannels ?? []) {
      this.conversationChannels.set(channel.id, {
        ...channel,
        capabilities: channel.capabilities ?? [],
        status: channel.status ?? "available",
        lastInboundAt: channel.lastInboundAt ?? null,
        lastOutboundAt: channel.lastOutboundAt ?? null
      });
    }
    for (const receipt of snapshot.providerUpdateReceipts ?? []) {
      this.providerUpdateReceipts.set(receipt.id, receipt);
    }
    for (const grant of snapshot.channelIdentityLinkGrants ?? []) {
      this.channelIdentityLinkGrants.set(grant.id, grant);
    }
    for (const device of snapshot.nativeSmsDevices ?? []) {
      this.nativeSmsDevices.set(device.id, device);
    }
    for (const command of snapshot.nativeSmsDeviceCommands ?? []) {
      this.nativeSmsDeviceCommands.set(command.id, command);
    }
    for (const mailbox of snapshot.connectedMailboxes ?? []) {
      this.connectedMailboxes.set(mailbox.id, {
        ...mailbox,
        automaticReplyEnabled: mailbox.automaticReplyEnabled ?? false,
        automaticReplyText: mailbox.automaticReplyText ?? null
      });
    }
    for (const session of snapshot.connectedMailboxOAuthSessions ?? []) {
      this.connectedMailboxOAuthSessions.set(session.id, session);
    }
    for (const capability of snapshot.customerRuntimeCapabilities ?? []) {
      this.customerRuntimeCapabilities.set(capability.id, capability);
    }

    for (const attempt of snapshot.messageDeliveryAttempts ?? []) {
      this.messageDeliveryAttempts.set(attempt.id, attempt);
    }

    for (const delivery of snapshot.messageNotificationDeliveries ?? []) {
      this.messageNotificationDeliveries.set(delivery.id, delivery);
    }

    for (const device of snapshot.e2eeDevices ?? []) {
      this.e2eeDevices.set(device.id, device);
    }

    for (const subscription of snapshot.pushSubscriptions ?? []) {
      this.pushSubscriptions.set(subscription.id, subscription);
      this.pushSubscriptionIdByEndpoint.set(subscription.endpoint, subscription.id);
    }
  }

  ensureHelpConversations(input: { sessionId: string | null; now?: Date }): {
    conversationId: string;
  } {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const rootId = helpConversationId(session.account.id, "home");
    for (const guide of helpGuides) {
      const id = helpConversationId(session.account.id, guide.key);
      const existing = this.conversations.get(id);
      if (existing) {
        if (existing.accountId !== session.account.id || existing.helpTopic !== guide.key)
          throw new Cp2Error(
            409,
            "help_conversation_conflict",
            "Help conversation ownership changed."
          );
      } else
        this.createAccountConversation({
          accountId: session.account.id,
          userId: session.user.id,
          kind: "personal",
          activeShopId: null,
          title: guide.title,
          taskConversationId: id,
          helpTopic: guide.key,
          ...(guide.key === "home" ? {} : { helpParentConversationId: rootId }),
          now
        });
      const chunks: string[] = [];
      for (const line of helpGuideText(guide.key).split("\n")) {
        const last = chunks.length - 1;
        if (last >= 0 && chunks[last]!.length + line.length + 1 <= 3500)
          chunks[last] += `\n${line}`;
        else chunks.push(line);
      }
      chunks.forEach((text, index) =>
        this.createConversationMessage({
          sessionId: input.sessionId,
          conversationId: id,
          clientMessageId: `help-guide-v1:${guide.key}:${index}`,
          author: "agent",
          content: { type: "text", text },
          now
        })
      );
    }
    return { conversationId: rootId };
  }

  addConversationParticipant(input: {
    sessionId: string | null;
    conversationId: string;
    recipient?: string;
    agent?: boolean;
    now?: Date;
  }): ConversationView {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const conversation = this.requireAccountConversation(input.conversationId, session.account.id);
    if (conversation.accountId !== session.account.id) {
      throw new Cp2Error(
        403,
        "conversation_owner_required",
        "Only the chat owner can add participants."
      );
    }
    if (
      conversation.kind !== "personal" ||
      conversation.helpTopic ||
      conversation.isPermanentDaemon ||
      conversation.taskParentConversationId
    ) {
      throw new Cp2Error(
        400,
        "conversation_group_unavailable",
        "Start a new personal chat to create a discussion."
      );
    }
    if (Boolean(input.agent) === Boolean(input.recipient?.trim())) {
      throw new Cp2Error(400, "participant_invalid", "Choose an agent or a contact.");
    }
    let accountId: string | null = null;
    if (!input.agent) {
      const recipient = input.recipient!.trim();
      if (recipient.startsWith("network-node:")) {
        accountId = this.deps.resolvePhonebookAccount(session.user.id, recipient.slice(13).trim());
      } else {
        const channel: AuthChannel = recipient.includes("@") ? "email" : "phone";
        accountId =
          this.deps.resolveContactAccount(channel, normalizeDestination(channel, recipient)) ??
          null;
      }
      if (!accountId)
        throw new Cp2Error(404, "recipient_not_found", "No Grogoni account matches that contact.");
    }
    if (accountId) this.requireContactAllowed(session.user.id, accountId, true);
    const agentId = input.agent ? `account-${session.account.id}-agent` : null;
    const existing = [...this.conversationParticipants.values()].some(
      (participant) =>
        participant.conversationId === conversation.id &&
        (input.agent
          ? participant.agentId === agentId
          : participant.role === "account" && participant.accountId === accountId)
    );
    if (existing) return this.conversationView(conversation);
    const userId = accountId ? this.deps.userByAccount.get(accountId) : undefined;
    const displayName = input.agent
      ? "Grogoni agent"
      : ((userId ? this.deps.users.get(userId)?.displayName : null) ?? "Contact");
    const participant: ConversationParticipantSummary = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: input.agent ? "agent" : "account",
      accountId,
      agentId,
      businessId: null,
      displayName,
      lastReadAt: null,
      archivedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      createdAt: now.toISOString()
    };
    this.conversationParticipants.set(participant.id, participant);
    this.deps.recordAuditEvent({
      type: "conversation.participant_added",
      aggregateType: "conversation",
      aggregateId: conversation.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { participantId: participant.id, role: participant.role }
    });
    const updated = { ...conversation, updatedAt: now.toISOString() };
    this.conversations.set(conversation.id, updated);
    // Membership metadata is server-authored. User message content still always passes
    // validateConversationEncryption; an invitation never exposes message text to push.
    const eventId = randomUUID();
    const message: ConversationMessageSummary = {
      id: eventId,
      conversationId: conversation.id,
      clientMessageId: eventId,
      idempotencyKey: `membership:${participant.id}`,
      author: "system",
      authorId: session.user.id,
      content: { type: "text", text: `${displayName} was added to the discussion.` },
      status: "delivered",
      selectedChannel: "grogoni",
      actualChannel: "grogoni",
      sentAt: now.toISOString(),
      deliveredAt: now.toISOString(),
      readAt: null,
      clientTimestamp: null,
      createdAt: now.toISOString()
    };
    this.conversationMessages.set(message.id, message);
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversations",
      conversation.id,
      updated,
      now
    );
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_participants",
      participant.id,
      participant,
      now
    );
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_messages",
      message.id,
      message,
      now
    );
    this.enqueueConversationNotifications(updated, message, session.account.id, now);
    return this.conversationView(updated);
  }

  createConversation(input: {
    sessionId: string | null;
    kind: ConversationKind;
    activeShopId: string | null;
    recipient?: string | null;
    title?: string | null;
    runtimeBindingId?: string | null;
    /** Trusted server-only identity for idempotent task conversations; not parsed from HTTP. */
    taskConversationId?: string;
    taskParentConversationId?: string;
    now?: Date;
  }): ConversationView {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);

    if (input.activeShopId !== null) {
      if (!this.deps.businesses.has(input.activeShopId)) {
        throw new Cp2Error(404, "business_not_found", "Conversation shop was not found.");
      }
      if (input.kind !== "storefront" && input.kind !== "order") {
        this.deps.requireMembership(input.activeShopId, session.user.id);
      }
    }

    let recipientAccountId: string | null = null;
    if (input.recipient?.trim()) {
      if (input.recipient.startsWith("network-node:")) {
        recipientAccountId = this.deps.resolvePhonebookAccount(
          session.user.id,
          input.recipient.slice("network-node:".length).trim()
        );
      } else {
        const channel: AuthChannel = input.recipient.includes("@") ? "email" : "phone";
        const destination = normalizeDestination(channel, input.recipient);
        recipientAccountId = this.deps.resolveContactAccount(channel, destination) ?? null;
      }
      if (recipientAccountId === null) {
        throw new Cp2Error(404, "recipient_not_found", "No Grogoni account matches that contact.");
      }
      this.requireContactAllowed(session.user.id, recipientAccountId, true);
      if (recipientAccountId === session.account.id) {
        throw new Cp2Error(400, "recipient_invalid", "Choose another Grogoni account.");
      }
    }

    // Reuse the authoritative pair, including when the other person starts the chat.
    // This method has no await between lookup and insertion; store transactions serialize writes.
    if (recipientAccountId !== null) {
      if (input.kind !== "personal" || input.activeShopId !== null) {
        throw new Cp2Error(
          400,
          "direct_conversation_scope_invalid",
          "Direct conversations cannot have a business scope."
        );
      }
      const existing = [...this.conversations.values()].find(
        (candidate) =>
          candidate.deletedAt == null &&
          candidate.kind === "personal" &&
          candidate.activeShopId === null &&
          this.humanConversationAccountIds(candidate.id).length === 2 &&
          this.accountConversationParticipant(candidate.id, session.account.id) !== null &&
          this.accountConversationParticipant(candidate.id, recipientAccountId!) !== null
      );
      if (existing) return this.conversationView(existing);
    }
    if ((input.kind === "storefront" || input.kind === "order") && input.activeShopId === null) {
      throw new Cp2Error(
        400,
        "business_conversation_scope_required",
        "Choose a business for this conversation."
      );
    }
    if (input.kind === "storefront" && !input.recipient) {
      const existing = [...this.conversations.values()].find(
        (candidate) =>
          candidate.deletedAt == null &&
          candidate.kind === "storefront" &&
          candidate.accountId === session.account.id &&
          candidate.activeShopId === input.activeShopId &&
          ![...this.conversationChannels.values()].some(
            (channel) => channel.conversationId === candidate.id
          )
      );
      if (existing) return this.conversationView(existing);
    }

    if (input.taskConversationId !== undefined) {
      if (
        input.kind !== "personal" ||
        input.recipient ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(input.taskConversationId)
      )
        throw new Cp2Error(400, "task_conversation_invalid", "Invalid task conversation.");
      if (input.taskParentConversationId !== undefined) {
        const parent = this.requireAccountConversation(
          input.taskParentConversationId,
          session.account.id
        );
        if (parent.activeShopId !== input.activeShopId)
          throw new Cp2Error(
            403,
            "task_conversation_parent_mismatch",
            "Task parent belongs to another business."
          );
      }
      const existing = this.conversations.get(input.taskConversationId);
      if (existing) {
        const owned = this.requireAccountConversation(existing.id, session.account.id);
        if (
          owned.accountId !== session.account.id ||
          owned.activeShopId !== input.activeShopId ||
          owned.kind !== input.kind ||
          owned.taskParentConversationId !== input.taskParentConversationId
        )
          throw new Cp2Error(409, "task_conversation_conflict", "Task conversation scope changed.");
        return this.conversationView(owned);
      }
    }

    const conversation = this.createAccountConversation({
      accountId: session.account.id,
      userId: session.user.id,
      kind: input.kind,
      activeShopId: input.activeShopId,
      recipientAccountId,
      title: input.title?.trim() || null,
      ...(input.taskConversationId === undefined
        ? {}
        : { taskConversationId: input.taskConversationId }),
      ...(input.taskParentConversationId === undefined
        ? {}
        : { taskParentConversationId: input.taskParentConversationId }),
      ...(input.runtimeBindingId === undefined ? {} : { runtimeBindingId: input.runtimeBindingId }),
      ...(recipientAccountId
        ? { identityKey: `direct:${[session.account.id, recipientAccountId].sort().join(":")}` }
        : input.kind === "storefront"
          ? { identityKey: `business:${input.activeShopId}:${session.account.id}` }
          : {}),
      now
    });
    this.deps.recordAuditEvent({
      type: "conversation.created",
      aggregateType: "conversation",
      aggregateId: conversation.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        accountId: session.account.id,
        activeShopId: conversation.activeShopId,
        kind: conversation.kind
      }
    });
    return this.conversationView(conversation);
  }

  createProviderConversation(input: {
    sessionId: string | null;
    businessId: string;
    provider: ChannelProvider;
    customerId?: string;
    externalUserId: string;
    externalConversationId: string;
    displayName?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
    now?: Date;
  }): { identity: PlatformIdentitySummary; channel: ConversationChannelSummary } {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    return this.upsertProviderConversation({
      businessId: input.businessId,
      provider: input.provider,
      customerId: input.customerId ?? null,
      externalUserId: input.externalUserId,
      externalConversationId: input.externalConversationId,
      displayName: input.displayName ?? null,
      metadata: input.metadata ?? {},
      ownerAccountId: auth.account.id,
      ownerUserId: auth.user.id,
      now
    });
  }

  private upsertProviderConversation(input: {
    businessId: string;
    provider: ChannelProvider;
    customerId: string | null;
    externalUserId: string;
    externalConversationId: string;
    displayName: string | null;
    metadata: Record<string, string | number | boolean | null>;
    ownerAccountId: string;
    ownerUserId: string;
    now: Date;
  }): { identity: PlatformIdentitySummary; channel: ConversationChannelSummary } {
    const now = input.now;
    const externalUserId = normalizeRequiredBoundedText(
      input.externalUserId,
      "externalUserId",
      200
    );
    const requestedCustomer =
      input.customerId === null
        ? null
        : this.deps.requireCustomer(input.businessId, input.customerId);
    let identity = [...this.platformIdentities.values()].find(
      (candidate) =>
        candidate.provider === input.provider &&
        candidate.businessId === input.businessId &&
        candidate.externalUserId === externalUserId
    );
    if (
      identity !== undefined &&
      requestedCustomer !== null &&
      identity.customerId !== null &&
      identity.customerId !== requestedCustomer.id
    ) {
      throw new Cp2Error(
        409,
        "CHANNEL_IDENTITY_ALREADY_LINKED",
        "This provider identity is already linked to another customer."
      );
    }
    const customer =
      requestedCustomer ??
      (identity?.customerId
        ? this.deps.requireCustomer(input.businessId, identity.customerId)
        : null) ??
      this.deps.createGuestCustomer({
        businessId: input.businessId,
        displayName: input.displayName,
        provider: input.provider,
        externalUserId,
        now
      });
    if (identity === undefined) {
      identity = {
        id: randomUUID(),
        provider: input.provider,
        externalUserId,
        accountId: null,
        customerId: customer.id,
        verifiedAt: null,
        optInStatus: "unknown",
        optInSource: null,
        optInAt: null,
        optOutAt: null,
        businessId: input.businessId,
        displayName: normalizeOptionalBoundedText(input.displayName ?? null, 120),
        metadata: { ...(input.metadata ?? {}) },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.platformIdentities.set(identity.id, identity);
    } else if (identity.customerId === null) {
      identity = { ...identity, customerId: customer.id, updatedAt: now.toISOString() };
      this.platformIdentities.set(identity.id, identity);
    }
    let channel = [...this.conversationChannels.values()].find(
      (candidate) =>
        candidate.provider === input.provider &&
        candidate.businessId === input.businessId &&
        candidate.externalConversationId === input.externalConversationId
    );
    if (channel === undefined) {
      const existingCustomerChannel = [...this.conversationChannels.values()].find((candidate) => {
        const candidateIdentity = this.platformIdentities.get(candidate.platformIdentityId);
        return (
          candidate.businessId === input.businessId && candidateIdentity?.customerId === customer.id
        );
      });
      const conversation =
        existingCustomerChannel === undefined
          ? this.createAccountConversation({
              accountId: input.ownerAccountId,
              userId: input.ownerUserId,
              kind: "storefront",
              activeShopId: input.businessId,
              title: customer.name,
              now
            })
          : this.conversations.get(existingCustomerChannel.conversationId);
      if (conversation === undefined) {
        throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
      }
      const participantId = randomUUID();
      this.conversationParticipants.set(participantId, {
        id: participantId,
        conversationId: conversation.id,
        role: "external",
        accountId: null,
        businessId: input.businessId,
        agentId: null,
        externalIdentityId: identity.id,
        displayName: identity.displayName,
        lastReadAt: null,
        archivedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        createdAt: now.toISOString()
      });
      channel = {
        id: randomUUID(),
        conversationId: conversation.id,
        businessId: input.businessId,
        provider: input.provider,
        externalConversationId: normalizeRequiredBoundedText(
          input.externalConversationId,
          "externalConversationId",
          200
        ),
        platformIdentityId: identity.id,
        capabilities: [],
        status: "available",
        lastInboundAt: null,
        lastOutboundAt: null,
        metadata: { ...(input.metadata ?? {}) },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.conversationChannels.set(channel.id, channel);
    } else if (channel.platformIdentityId !== identity.id) {
      throw new Cp2Error(
        409,
        "CHANNEL_IDENTITY_ALREADY_LINKED",
        "This provider conversation is already linked to another customer."
      );
    }
    return { identity, channel };
  }

  listChannelProviderReadiness(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ChannelProviderReadiness[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now
    );
    return this.deps.channelGateway.providerReadiness({ businessId: input.businessId });
  }

  registerNativeSmsDevice(input: {
    sessionId: string | null;
    roleAvailable: boolean;
    roleGranted: boolean;
    sendPermissionGranted: boolean;
    receivePermissionGranted: boolean;
    simReady: boolean;
    subscriptionId?: number | null;
    preferred?: boolean;
    lastErrorCode?: string | null;
    now?: Date;
  }): NativeSmsDeviceSummary {
    const now = input.now ?? new Date();
    const auth = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const session = this.deps.sessions.get(auth.session.id);
    if (
      session === undefined ||
      session.platform.toLocaleLowerCase() !== "android" ||
      session.browserOrApp.toLocaleLowerCase() !== "android-native"
    ) {
      throw new Cp2Error(
        403,
        "SMS_DEVICE_UNAVAILABLE",
        "Native SMS registration requires an authenticated Android-native session."
      );
    }
    const existingForDevice = [...this.nativeSmsDevices.values()].find(
      (candidate) => candidate.deviceId === session.deviceId && candidate.revokedAt === null
    );
    if (existingForDevice !== undefined && existingForDevice.accountId !== auth.account.id) {
      throw new Cp2Error(409, "sms_device_conflict", "This device is linked to another account.");
    }
    const existingForAccount = [...this.nativeSmsDevices.values()].filter(
      (candidate) => candidate.accountId === auth.account.id && candidate.revokedAt === null
    );
    const preferred = input.preferred ?? existingForAccount.length === 0;
    if (preferred) {
      for (const candidate of existingForAccount) {
        this.nativeSmsDevices.set(candidate.id, {
          ...candidate,
          preferred: false,
          updatedAt: now.toISOString()
        });
      }
    }
    const capabilities: NativeSmsDeviceCapability[] = [];
    if (input.roleAvailable && input.roleGranted && input.sendPermissionGranted && input.simReady) {
      capabilities.push("native_sms_send");
    }
    if (
      input.roleAvailable &&
      input.roleGranted &&
      input.receivePermissionGranted &&
      input.simReady
    ) {
      capabilities.push("native_sms_receive");
    }
    const readiness = nativeSmsReadinessFromRegistration({
      roleAvailable: input.roleAvailable,
      roleGranted: input.roleGranted,
      sendPermissionGranted: input.sendPermissionGranted,
      receivePermissionGranted: input.receivePermissionGranted,
      simReady: input.simReady,
      lastErrorCode: input.lastErrorCode ?? null
    });
    const device: NativeSmsDeviceSummary = {
      id: existingForDevice?.id ?? randomUUID(),
      accountId: auth.account.id,
      sessionFamilyId: session.sessionFamilyId,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      platform: "android",
      executionEnvironment: "android-device",
      capabilities,
      readiness,
      roleAvailable: input.roleAvailable,
      roleGranted: input.roleGranted,
      sendPermissionGranted: input.sendPermissionGranted,
      receivePermissionGranted: input.receivePermissionGranted,
      simReady: input.simReady,
      subscriptionId:
        input.subscriptionId === undefined || input.subscriptionId === null
          ? null
          : normalizeNativeSmsSubscriptionId(input.subscriptionId),
      preferred,
      lastSeenAt: now.toISOString(),
      lastErrorCode: normalizeOptionalBoundedText(input.lastErrorCode ?? null, 80),
      revokedAt: null,
      createdAt: existingForDevice?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.nativeSmsDevices.set(device.id, device);
    this.deps.recordAuditEvent({
      type: "native_sms.device_registered",
      aggregateType: "native_sms_device",
      aggregateId: device.id,
      actorId: auth.user.id,
      occurredAt: now.toISOString(),
      payload: {
        accountId: device.accountId,
        readiness: device.readiness,
        sendCapable: device.capabilities.includes("native_sms_send"),
        receiveCapable: device.capabilities.includes("native_sms_receive")
      }
    });
    return this.nativeSmsDeviceView(device, now);
  }

  listNativeSmsDevices(input: { sessionId: string | null; now?: Date }): NativeSmsDeviceSummary[] {
    const now = input.now ?? new Date();
    const auth = this.deps.requirePinVerifiedSession(input.sessionId, now);
    return [...this.nativeSmsDevices.values()]
      .filter((device) => device.accountId === auth.account.id && device.revokedAt === null)
      .map((device) => this.nativeSmsDeviceView(device, now))
      .sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          right.lastSeenAt.localeCompare(left.lastSeenAt)
      );
  }

  listNativeSmsBusinesses(input: { sessionId: string | null; now?: Date }): BusinessSummary[] {
    const auth = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    const businessIds = new Set(
      [...this.deps.memberships.values()]
        .filter((membership) => membership.userId === auth.user.id)
        .map((membership) => membership.businessId)
    );
    return [...this.deps.businesses.values()].filter((business) => businessIds.has(business.id));
  }

  revokeNativeSmsDevice(input: {
    sessionId: string | null;
    deviceId: string;
    now?: Date;
  }): NativeSmsDeviceSummary {
    const now = input.now ?? new Date();
    const auth = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const device = this.nativeSmsDevices.get(input.deviceId);
    if (device === undefined || device.accountId !== auth.account.id) {
      throw new Cp2Error(404, "sms_device_not_found", "Native SMS device was not found.");
    }
    const revoked: NativeSmsDeviceSummary = {
      ...device,
      capabilities: [],
      readiness: "unavailable",
      revokedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.nativeSmsDevices.set(revoked.id, revoked);
    for (const command of this.nativeSmsDeviceCommands.values()) {
      if (
        command.deviceId === revoked.id &&
        !["completed", "failed", "cancelled"].includes(command.status)
      ) {
        this.nativeSmsDeviceCommands.set(command.id, {
          ...command,
          status: "cancelled",
          resultCode: "SMS_DEVICE_UNAVAILABLE",
          completedAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
        this.failNativeSmsMessage(command.messageId, "SMS_DEVICE_UNAVAILABLE", now);
      }
    }
    return revoked;
  }

  fetchNativeSmsCommands(input: { sessionId: string | null; limit?: number; now?: Date }): {
    device: NativeSmsDeviceSummary;
    commands: NativeSmsExecutableCommand[];
  } {
    const now = input.now ?? new Date();
    const device = this.requireCurrentNativeSmsDevice(input.sessionId, "native_sms_send", now);
    const touched = this.touchNativeSmsDevice(device, now);
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const commands = [...this.nativeSmsDeviceCommands.values()]
      .filter(
        (command) =>
          command.deviceId === touched.id &&
          ["queued", "waiting_for_device", "dispatched", "acknowledged"].includes(command.status) &&
          Date.parse(command.expiresAt) > now.getTime()
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map((command) => {
        const message = this.conversationMessages.get(command.messageId);
        if (message?.content.type !== "text") {
          throw new Cp2Error(409, "sms_command_invalid", "SMS command content is unavailable.");
        }
        const dispatched: NativeSmsDeviceCommandSummary = {
          ...command,
          status:
            command.status === "queued" || command.status === "waiting_for_device"
              ? "dispatched"
              : command.status,
          dispatchedAt: command.dispatchedAt ?? now.toISOString(),
          updatedAt: now.toISOString()
        };
        this.nativeSmsDeviceCommands.set(dispatched.id, dispatched);
        return { ...dispatched, text: message.content.text };
      });
    return { device: touched, commands };
  }

  acknowledgeNativeSmsCommand(input: {
    sessionId: string | null;
    commandId: string;
    now?: Date;
  }): NativeSmsDeviceCommandSummary {
    const now = input.now ?? new Date();
    const device = this.requireCurrentNativeSmsDevice(input.sessionId, "native_sms_send", now);
    const command = this.requireNativeSmsCommand(device, input.commandId, now);
    if (["completed", "failed", "cancelled"].includes(command.status)) return command;
    const acknowledged: NativeSmsDeviceCommandSummary = {
      ...command,
      status: "acknowledged",
      acknowledgedAt: command.acknowledgedAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.nativeSmsDeviceCommands.set(acknowledged.id, acknowledged);
    return acknowledged;
  }

  reportNativeSmsCommandResult(input: {
    sessionId: string | null;
    commandId: string;
    status: "sending" | "sent" | "delivered" | "failed";
    resultCode: NativeSmsResultCode;
    carrierReference?: string | null;
    now?: Date;
  }): { command: NativeSmsDeviceCommandSummary; message: ConversationMessageSummary } {
    const now = input.now ?? new Date();
    const device = this.requireCurrentNativeSmsDevice(input.sessionId, "native_sms_send", now);
    const command = this.requireNativeSmsCommand(device, input.commandId, now);
    const message = this.conversationMessages.get(command.messageId);
    if (message === undefined || message.provider !== "native_sms") {
      throw new Cp2Error(409, "sms_command_invalid", "Canonical SMS message is unavailable.");
    }
    const deliveryUpgrade =
      command.status === "completed" &&
      command.resultCode === "SMS_SENT" &&
      input.status === "delivered";
    if (
      ["failed", "cancelled"].includes(command.status) ||
      (command.status === "completed" && !deliveryUpgrade)
    ) {
      return { command, message };
    }
    const terminal =
      input.status === "sent" || input.status === "delivered" || input.status === "failed";
    const updatedCommand: NativeSmsDeviceCommandSummary = {
      ...command,
      status:
        input.status === "failed"
          ? "failed"
          : input.status === "sent" || input.status === "delivered"
            ? "completed"
            : "sending",
      resultCode: input.resultCode,
      carrierReference: normalizeOptionalBoundedText(input.carrierReference ?? null, 200),
      completedAt: terminal ? now.toISOString() : null,
      updatedAt: now.toISOString()
    };
    this.nativeSmsDeviceCommands.set(updatedCommand.id, updatedCommand);
    const updatedMessage: ConversationMessageSummary = {
      ...message,
      status:
        input.status === "failed"
          ? "failed"
          : input.status === "delivered"
            ? "delivered"
            : input.status === "sent"
              ? "sent"
              : "sending",
      actualChannel: "native_sms",
      providerMessageId: command.id,
      sentAt:
        input.status === "sent" || input.status === "delivered"
          ? (message.sentAt ?? now.toISOString())
          : (message.sentAt ?? null),
      deliveredAt: input.status === "delivered" ? now.toISOString() : (message.deliveredAt ?? null),
      failureCode: input.status === "failed" ? input.resultCode : null,
      nextRetryAt: null
    };
    this.conversationMessages.set(updatedMessage.id, updatedMessage);
    this.recordConversationSyncForParticipants(
      updatedMessage.conversationId,
      "conversation_messages",
      updatedMessage.id,
      updatedMessage,
      now
    );
    if (terminal) {
      this.finishChannelDeliveryAttempt(
        updatedMessage,
        input.status === "failed" ? "permanent_failure" : "succeeded",
        input.status === "failed" ? input.resultCode : null,
        now
      );
    }
    return { command: updatedCommand, message: updatedMessage };
  }

  ingestNativeSmsMessage(input: {
    sessionId: string | null;
    businessId: string;
    externalMessageId: string;
    sender: string;
    text: string;
    occurredAt: string;
    now?: Date;
  }): NativeSmsInboundResult {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const device = this.requireCurrentNativeSmsDevice(input.sessionId, "native_sms_receive", now);
    const sender = normalizeInternationalOwnerPhoneNumber(input.sender).e164;
    const externalMessageId = normalizeRequiredBoundedText(
      input.externalMessageId,
      "externalMessageId",
      200
    );
    const occurredAt = normalizeNativeSmsOccurredAt(input.occurredAt, now);
    let customer = [...this.deps.customers.values()].find(
      (candidate) =>
        candidate.businessId === input.businessId &&
        normalizeExistingCustomerPhone(candidate.phone) === sender
    );
    if (customer === undefined) {
      customer = this.deps.createGuestCustomer({
        businessId: input.businessId,
        provider: "native_sms",
        externalUserId: sender,
        now
      });
      customer = { ...customer, phone: sender };
      this.deps.customers.set(customer.id, customer);
    }
    const linked = this.upsertProviderConversation({
      businessId: input.businessId,
      provider: "native_sms",
      customerId: customer.id,
      externalUserId: sender,
      externalConversationId: sender,
      displayName: customer.name,
      metadata: { automaticRepliesEnabled: false, executionEnvironment: "android-device" },
      ownerAccountId: auth.account.id,
      ownerUserId: auth.user.id,
      now
    });
    const ingested = this.ingestProviderMessage({
      provider: "native_sms",
      businessId: input.businessId,
      externalConversationId: linked.channel.externalConversationId,
      externalUpdateId: `${device.id}:${externalMessageId}`,
      body: normalizeRequiredBoundedText(input.text, "message", 4000),
      providerMessageId: externalMessageId,
      now: new Date(occurredAt)
    });
    const orderIntentOutcome = this.reconcileInboundSmsOrder({
      sessionId: input.sessionId,
      businessId: input.businessId,
      accountId: auth.account.id,
      device,
      externalMessageId,
      sender,
      customer,
      text: input.text,
      occurredAt,
      now
    });
    const touchedDevice = this.touchNativeSmsDevice(device, now);
    return {
      device: this.nativeSmsDeviceView(touchedDevice, now),
      customer,
      ...ingested,
      orderIntentOutcome
    };
  }

  /** The single hook where an inbound SMS becomes an OfflineOrderIntent. Text that doesn't look
   *  order-shaped is left alone (returns null, no reply sent) - only messages with at least one
   *  quantity-led segment reach the parser at all. Reuses
   *  offline-order-planning.ts's parseOfflineOrderText (same function the unit tests exercise
   *  directly) and Cp2Store.pushOfflineOrderIntents (the same reconciliation path BLE intents go
   *  through via POST /sync/order-intents) - there is exactly one place order text turns into a
   *  structured intent and exactly one place an intent turns into a real invoice. */
  private reconcileInboundSmsOrder(input: {
    sessionId: string | null;
    businessId: string;
    accountId: string;
    device: NativeSmsDeviceSummary;
    externalMessageId: string;
    sender: string;
    customer: CustomerSummary;
    text: string;
    occurredAt: string;
    now: Date;
  }): OfflineOrderIntentOutcome | null {
    const parsed = parseOfflineOrderText(
      input.text,
      this.deps.productsForBusiness(input.businessId)
    );
    if (!parsed.looksLikeOrder) return null;
    const replyIdempotencyKey = `sms-order:${input.device.id}:${input.externalMessageId}`;
    if (parsed.items.length === 0) {
      // Ambiguous - reply asking for clarification instead of guessing at the order. This is a
      // system-initiated transactional reply, not an automatic conversational one; the
      // `automaticRepliesEnabled: false` metadata set on this conversation above is about the AI
      // agent, and doesn't apply here.
      this.sendChannelMessage({
        sessionId: input.sessionId,
        businessId: input.businessId,
        customerId: input.customer.id,
        provider: "native_sms",
        text: offlineOrderClarificationMessage(parsed.problems),
        idempotencyKey: `${replyIdempotencyKey}:clarify`,
        now: input.now
      }).catch(() => undefined);
      return null;
    }
    const intent: OfflineOrderIntent = {
      id: replyIdempotencyKey,
      accountId: input.accountId,
      storeId: input.businessId,
      transport: "sms",
      customerClaim: { type: "phone", phone: input.sender, displayName: input.customer.name },
      items: parsed.items.map((item) => ({
        productCloudId: item.productId,
        name: item.name,
        quantity: item.quantity,
        quotedUnitPrice: null
      })),
      paymentMethod: null,
      paymentReference: null,
      note: null,
      receivedAtLocal: input.occurredAt,
      rawText: input.text
    };
    // Best-effort relative to message ingestion: the canonical conversation message above is
    // already durably recorded by this point, and a reconciliation failure (e.g. a transient
    // authorization or stock-conflict error) must never fail the whole ingestion response - the
    // device would otherwise retry an inbound message it already delivered successfully.
    let outcome: OfflineOrderIntentOutcome | undefined;
    try {
      [outcome] = this.deps.pushOfflineOrderIntents(input.sessionId, [intent]);
    } catch {
      return null;
    }
    if (outcome) {
      this.sendChannelMessage({
        sessionId: input.sessionId,
        businessId: input.businessId,
        customerId: input.customer.id,
        provider: "native_sms",
        text: offlineOrderOutcomeMessage(outcome),
        idempotencyKey: `${replyIdempotencyKey}:outcome`,
        now: input.now
      }).catch(() => undefined);
    }
    return outcome ?? null;
  }

  listConnectedMailboxProviders(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ConnectedMailboxProviderSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now ?? new Date()
    );
    return this.deps.emailMailboxProviderClient.providers();
  }

  beginConnectedMailboxOAuth(input: {
    sessionId: string | null;
    businessId: string;
    provider: ConnectedMailboxProvider;
    redirectUri: string;
    returnUrl: string;
    now?: Date;
  }): ConnectedMailboxOAuthStartSummary {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const configured = this.deps.emailMailboxProviderClient
      .providers()
      .find((candidate) => candidate.provider === input.provider)?.configured;
    if (configured !== true) {
      throw new Cp2Error(
        503,
        "EMAIL_PROVIDER_UNAVAILABLE",
        "This mailbox provider is not configured."
      );
    }
    const authorization = this.deps.emailMailboxProviderClient.beginAuthorization({
      provider: input.provider,
      redirectUri: normalizeAbsoluteHttpUrl(input.redirectUri, "redirectUri")
    });
    const expiresAt = new Date(now.getTime() + mailboxOAuthSessionTtlMs).toISOString();
    const session: ConnectedMailboxOAuthSessionRecord = {
      id: randomUUID(),
      accountId: auth.account.id,
      businessId: input.businessId,
      provider: input.provider,
      stateHash: hashOAuthSecret(authorization.state),
      encryptedCodeVerifier: encryptOAuthToken(authorization.codeVerifier),
      redirectUri: input.redirectUri,
      returnUrl: normalizeAbsoluteHttpUrl(input.returnUrl, "returnUrl"),
      expiresAt,
      completedAt: null,
      createdAt: now.toISOString()
    };
    this.connectedMailboxOAuthSessions.set(session.id, session);
    return {
      provider: input.provider,
      authorizationUrl: authorization.authorizationUrl,
      expiresAt
    };
  }

  async completeConnectedMailboxOAuth(input: {
    provider: ConnectedMailboxProvider;
    code: string;
    state: string;
    now?: Date;
  }): Promise<{ mailbox: ConnectedMailboxSummary; returnUrl: string }> {
    const now = input.now ?? new Date();
    const stateHash = hashOAuthSecret(normalizeRequiredBoundedText(input.state, "state", 500));
    const session = [...this.connectedMailboxOAuthSessions.values()].find(
      (candidate) => candidate.provider === input.provider && candidate.stateHash === stateHash
    );
    if (
      session === undefined ||
      session.completedAt !== null ||
      Date.parse(session.expiresAt) <= now.getTime()
    ) {
      throw new Cp2Error(
        401,
        "mailbox_oauth_invalid",
        "Mailbox authorization is invalid or expired."
      );
    }
    const authorization = await this.deps.emailMailboxProviderClient.completeAuthorization({
      provider: input.provider,
      code: normalizeRequiredBoundedText(input.code, "code", 4000),
      codeVerifier: decryptOAuthToken(session.encryptedCodeVerifier),
      redirectUri: session.redirectUri
    });
    const address = normalizeEmailIdentity(authorization.profile.address);
    const existing = [...this.connectedMailboxes.values()].find(
      (candidate) =>
        candidate.businessId === session.businessId &&
        candidate.provider === input.provider &&
        candidate.providerAccountId === authorization.profile.providerAccountId
    );
    if (existing !== undefined && existing.accountId !== session.accountId) {
      throw new Cp2Error(
        409,
        "mailbox_identity_conflict",
        "This mailbox is already connected by another account for this business."
      );
    }
    const tokens = authorization.tokens;
    const canSend = mailboxScopeAllows(input.provider, tokens.scope, "send");
    const canReceive = mailboxScopeAllows(input.provider, tokens.scope, "receive");
    if (!canSend || !canReceive) {
      throw new Cp2Error(
        403,
        "mailbox_scope_missing",
        "Mailbox authorization did not grant both send and receive access."
      );
    }
    const isDefault =
      existing?.isDefault ??
      ![...this.connectedMailboxes.values()].some(
        (candidate) =>
          candidate.businessId === session.businessId &&
          candidate.status === "connected" &&
          candidate.isDefault
      );
    const record: ConnectedMailboxRecord = {
      id: existing?.id ?? randomUUID(),
      businessId: session.businessId,
      accountId: session.accountId,
      address,
      provider: input.provider,
      providerAccountId: authorization.profile.providerAccountId,
      status: "connected",
      readiness: "READY",
      canSend,
      canReceive,
      isDefault,
      ingestUnknownSenders: existing?.ingestUnknownSenders ?? false,
      automaticReplyEnabled: existing?.automaticReplyEnabled ?? false,
      automaticReplyText: existing?.automaticReplyText ?? null,
      encryptedAccessToken: encryptOAuthToken(tokens.accessToken),
      encryptedRefreshToken:
        tokens.refreshToken === null
          ? (existing?.encryptedRefreshToken ?? null)
          : encryptOAuthToken(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
      connectedAt: existing?.connectedAt ?? now.toISOString(),
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastErrorCode: null,
      disconnectedAt: null,
      updatedAt: now.toISOString()
    };
    this.connectedMailboxes.set(record.id, record);
    this.connectedMailboxOAuthSessions.set(session.id, {
      ...session,
      completedAt: now.toISOString()
    });
    this.setMailboxChannelStatus(record.id, "available", now);
    this.deps.recordAuditEvent({
      type: "mailbox.connected",
      aggregateType: "connected_mailbox",
      aggregateId: record.id,
      actorId: session.accountId,
      occurredAt: now.toISOString(),
      payload: {
        accountId: session.accountId,
        businessId: session.businessId,
        mailboxId: record.id,
        provider: record.provider
      }
    });
    return { mailbox: connectedMailboxView(record), returnUrl: session.returnUrl };
  }

  listConnectedMailboxes(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ConnectedMailboxSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now ?? new Date()
    );
    return [...this.connectedMailboxes.values()]
      .filter((mailbox) => mailbox.businessId === input.businessId)
      .sort(
        (left, right) =>
          Number(right.isDefault) - Number(left.isDefault) ||
          right.updatedAt.localeCompare(left.updatedAt)
      )
      .map(connectedMailboxView);
  }

  updateConnectedMailbox(input: {
    sessionId: string | null;
    businessId: string;
    mailboxId: string;
    isDefault?: boolean;
    ingestUnknownSenders?: boolean;
    automaticReplyEnabled?: boolean;
    automaticReplyText?: string | null;
    now?: Date;
  }): ConnectedMailboxSummary {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const mailbox = this.requireConnectedMailbox(input.businessId, input.mailboxId);
    if (mailbox.accountId !== auth.account.id) {
      throw new Cp2Error(403, "mailbox_forbidden", "This mailbox belongs to another account.");
    }
    if (input.isDefault === true) {
      for (const candidate of this.connectedMailboxes.values()) {
        if (candidate.businessId === input.businessId && candidate.id !== mailbox.id) {
          this.connectedMailboxes.set(candidate.id, {
            ...candidate,
            isDefault: false,
            updatedAt: now.toISOString()
          });
        }
      }
    }
    const automaticReplyText =
      input.automaticReplyText === undefined
        ? mailbox.automaticReplyText
        : normalizeOptionalBoundedText(input.automaticReplyText, 1000);
    const automaticReplyEnabled = input.automaticReplyEnabled ?? mailbox.automaticReplyEnabled;
    if (automaticReplyEnabled && automaticReplyText === null) {
      throw new Cp2Error(
        400,
        "mailbox_automatic_reply_text_required",
        "Automatic acknowledgement text is required before enabling automatic replies."
      );
    }
    const updated: ConnectedMailboxRecord = {
      ...mailbox,
      isDefault: input.isDefault === true ? true : mailbox.isDefault,
      ingestUnknownSenders: input.ingestUnknownSenders ?? mailbox.ingestUnknownSenders,
      automaticReplyEnabled,
      automaticReplyText,
      updatedAt: now.toISOString()
    };
    this.connectedMailboxes.set(updated.id, updated);
    if (input.automaticReplyEnabled !== undefined) {
      for (const channel of this.conversationChannels.values()) {
        if (channel.provider === "email" && channel.metadata.mailboxId === updated.id) {
          this.conversationChannels.set(channel.id, {
            ...channel,
            metadata: {
              ...channel.metadata,
              automaticRepliesEnabled: updated.automaticReplyEnabled
            },
            updatedAt: now.toISOString()
          });
        }
      }
    }
    return connectedMailboxView(updated);
  }

  async disconnectConnectedMailbox(input: {
    sessionId: string | null;
    businessId: string;
    mailboxId: string;
    now?: Date;
  }): Promise<ConnectedMailboxSummary> {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const mailbox = this.requireConnectedMailbox(input.businessId, input.mailboxId);
    if (mailbox.accountId !== auth.account.id) {
      throw new Cp2Error(403, "mailbox_forbidden", "This mailbox belongs to another account.");
    }
    const accessToken =
      mailbox.encryptedAccessToken === null
        ? null
        : decryptOAuthToken(mailbox.encryptedAccessToken);
    await this.deps.emailMailboxProviderClient.revoke({ provider: mailbox.provider, accessToken });
    const disconnected: ConnectedMailboxRecord = {
      ...mailbox,
      status: "disconnected",
      readiness: "NOT_CONFIGURED",
      canSend: false,
      canReceive: false,
      isDefault: false,
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
      lastErrorCode: null,
      disconnectedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.connectedMailboxes.set(disconnected.id, disconnected);
    this.setMailboxChannelStatus(disconnected.id, "authorization_required", now);
    return connectedMailboxView(disconnected);
  }

  async syncConnectedMailbox(input: {
    sessionId: string | null;
    businessId: string;
    mailboxId: string;
    historyDays?: number;
    now?: Date;
  }): Promise<ConnectedMailboxSyncSummary> {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const mailbox = this.requireConnectedMailbox(input.businessId, input.mailboxId);
    if (mailbox.accountId !== auth.account.id) {
      throw new Cp2Error(403, "mailbox_forbidden", "This mailbox belongs to another account.");
    }
    const historyDays = normalizeMailboxHistoryDays(input.historyDays);
    return this.syncMailboxRecord(mailbox, now, historyDays);
  }

  async syncDueConnectedMailboxes(
    input: {
      now?: Date;
      staleAfterMs?: number;
      limit?: number;
    } = {}
  ): Promise<ConnectedMailboxBackgroundSyncSummary> {
    const now = input.now ?? new Date();
    const staleAfterMs = normalizePositiveInteger(input.staleAfterMs, 5 * 60_000, 60_000);
    const limit = Math.min(50, normalizePositiveInteger(input.limit, 20, 1));
    const due = [...this.connectedMailboxes.values()]
      .filter(
        (mailbox) =>
          mailbox.status === "connected" &&
          mailbox.canReceive &&
          Date.parse(mailbox.lastSyncAt ?? mailbox.connectedAt) <= now.getTime() - staleAfterMs
      )
      .sort((left, right) =>
        (left.lastSyncAt ?? left.connectedAt).localeCompare(right.lastSyncAt ?? right.connectedAt)
      )
      .slice(0, limit);
    const summary: ConnectedMailboxBackgroundSyncSummary = {
      checked: due.length,
      synchronized: 0,
      ingested: 0,
      deduplicated: 0,
      filtered: 0,
      failed: 0
    };
    for (const mailbox of due) {
      try {
        const result = await this.syncMailboxRecord(mailbox, now, null);
        summary.synchronized += 1;
        summary.ingested += result.ingested;
        summary.deduplicated += result.deduplicated;
        summary.filtered += result.filtered;
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  private async syncMailboxRecord(
    mailbox: ConnectedMailboxRecord,
    now: Date,
    historyDays: number | null
  ): Promise<ConnectedMailboxSyncSummary> {
    try {
      let authorized = await this.authorizedMailbox(mailbox, now);
      const since =
        historyDays === null
          ? (authorized.mailbox.lastSyncAt ?? authorized.mailbox.connectedAt)
          : new Date(now.getTime() - historyDays * 24 * 60 * 60_000).toISOString();
      const limit = historyDays === null ? 25 : 100;
      let messages: NormalizedProviderEmail[];
      try {
        messages = await this.deps.emailMailboxProviderClient.fetchInbound({
          provider: authorized.mailbox.provider,
          accessToken: authorized.accessToken,
          since,
          limit
        });
      } catch (error) {
        if (!isEmailReauthorizationError(error)) throw error;
        authorized = await this.refreshMailboxAuthorization(authorized.mailbox, now);
        messages = await this.deps.emailMailboxProviderClient.fetchInbound({
          provider: authorized.mailbox.provider,
          accessToken: authorized.accessToken,
          since,
          limit
        });
      }
      let ingested = 0;
      let deduplicated = 0;
      let filtered = 0;
      for (const message of messages) {
        const result = await this.ingestConnectedMailboxEmail(authorized.mailbox, message, now);
        if (result === "ingested") ingested += 1;
        else if (result === "deduplicated") deduplicated += 1;
        else filtered += 1;
      }
      const synchronized: ConnectedMailboxRecord = {
        ...authorized.mailbox,
        lastSyncAt: now.toISOString(),
        lastErrorCode: null,
        updatedAt: now.toISOString()
      };
      this.connectedMailboxes.set(synchronized.id, synchronized);
      return {
        mailbox: connectedMailboxView(synchronized),
        fetched: messages.length,
        ingested,
        deduplicated,
        filtered
      };
    } catch (error) {
      this.handleEmailProviderFailure(mailbox, error, now);
      throw this.emailProviderCp2Error(error);
    }
  }

  createConnectedEmailConversation(input: {
    sessionId: string | null;
    businessId: string;
    mailboxId: string;
    recipientAddress: string;
    displayName?: string;
    now?: Date;
  }): ConversationView {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const mailbox = this.requireConnectedMailbox(input.businessId, input.mailboxId);
    if (
      mailbox.accountId !== auth.account.id ||
      mailbox.status !== "connected" ||
      !mailbox.canSend
    ) {
      throw new Cp2Error(
        403,
        "EMAIL_MAILBOX_NOT_CONNECTED",
        "This mailbox is not authorized to send email for the current account."
      );
    }
    const recipientAddress = normalizeEmailIdentity(input.recipientAddress);
    const existingCustomer = [...this.deps.customers.values()].find(
      (candidate) =>
        candidate.businessId === input.businessId &&
        normalizeStoredEmailIdentity(candidate.email) === recipientAddress
    );
    const customer =
      existingCustomer ??
      this.deps.createGuestCustomer({
        businessId: input.businessId,
        displayName: input.displayName ?? recipientAddress,
        provider: "email",
        externalUserId: recipientAddress,
        now
      });
    this.ensureEmailEndpoint({
      businessId: input.businessId,
      customer,
      accountId: auth.account.id,
      userId: auth.user.id,
      mailboxId: mailbox.id,
      conversationId: null,
      allowUnconnected: false,
      now
    });
    const channel = [...this.conversationChannels.values()].find((candidate) => {
      const identity = this.platformIdentities.get(candidate.platformIdentityId);
      return (
        candidate.provider === "email" &&
        candidate.businessId === input.businessId &&
        candidate.metadata.mailboxId === mailbox.id &&
        identity?.customerId === customer.id
      );
    });
    if (channel === undefined) {
      throw new Cp2Error(500, "EMAIL_CONVERSATION_FAILED", "Email conversation was not created.");
    }
    return this.conversationView(
      this.requireAccountConversation(channel.conversationId, auth.account.id)
    );
  }

  listCustomerChannelEndpoints(input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string;
    conversationId?: string;
    now?: Date;
  }): ChannelEndpointSummary[] {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:read",
      now
    );
    const customer =
      input.customerId === undefined
        ? null
        : this.deps.requireCustomer(input.businessId, input.customerId);
    if (customer !== null) {
      this.ensureNativeSmsEndpoint({
        businessId: input.businessId,
        customer,
        accountId: auth.account.id,
        userId: auth.user.id,
        now
      });
      this.ensureEmailEndpoint({
        businessId: input.businessId,
        customer,
        accountId: auth.account.id,
        userId: auth.user.id,
        mailboxId: null,
        conversationId: input.conversationId ?? null,
        allowUnconnected: true,
        now
      });
    }
    return this.channelEndpoints({
      businessId: input.businessId,
      customerId: customer?.id ?? null,
      conversationId: input.conversationId ?? null
    });
  }

  createChannelIdentityLinkGrant(input: {
    sessionId: string | null;
    businessId: string;
    customerId: string;
    provider: ChannelProvider;
    conversationId?: string | null;
    automaticRepliesEnabled?: boolean;
    now?: Date;
  }): {
    grantId: string;
    provider: ChannelProvider;
    token: string;
    linkUrl: string;
    expiresAt: string;
  } {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    this.deps.requireCustomer(input.businessId, input.customerId);
    if (input.conversationId) {
      const conversation = this.conversations.get(input.conversationId);
      if (conversation?.activeShopId !== input.businessId) {
        throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
      }
    }
    const token = randomBytes(32).toString("base64url");
    const linkUrl = this.deps.channelGateway.createLinkUrl(input.provider, token, input.businessId);
    if (linkUrl === null) {
      throw new Cp2Error(
        409,
        "CHANNEL_NOT_CONNECTED",
        "This provider is not configured for secure identity linking."
      );
    }
    const grant: ChannelIdentityLinkGrantRecord = {
      id: randomUUID(),
      businessId: input.businessId,
      customerId: input.customerId,
      conversationId: input.conversationId ?? null,
      provider: input.provider,
      tokenHash: hashCustomerCapability(token),
      automaticRepliesEnabled: input.automaticRepliesEnabled ?? false,
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      consumedAt: null,
      createdBy: auth.user.id,
      createdAt: now.toISOString()
    };
    this.channelIdentityLinkGrants.set(grant.id, grant);
    this.deps.recordAuditEvent({
      type: "channel.identity_link_grant_created",
      aggregateType: "channel_identity_link_grant",
      aggregateId: grant.id,
      actorId: auth.user.id,
      occurredAt: grant.createdAt,
      payload: {
        businessId: grant.businessId,
        customerId: grant.customerId,
        provider: grant.provider
      }
    });
    return {
      grantId: grant.id,
      provider: grant.provider,
      token,
      linkUrl,
      expiresAt: grant.expiresAt
    };
  }

  ingestChannelWebhook(input: {
    provider: ChannelProvider;
    headers: Record<string, string | string[] | undefined>;
    payload: unknown;
    rawBody?: Buffer;
    now?: Date;
  }): {
    receipt: ProviderUpdateReceiptSummary;
    message: ConversationMessageSummary | null;
    orderIntentOutcome: OfflineOrderIntentOutcome | null;
  } {
    const now = input.now ?? new Date();
    let inbound;
    try {
      inbound = this.deps.channelGateway.normalizeInbound({
        provider: input.provider,
        headers: input.headers,
        payload: input.payload,
        ...(input.rawBody ? { rawBody: input.rawBody } : {})
      });
    } catch (error) {
      throw this.channelError(error);
    }

    return this.ingestNormalizedChannelMessage(input.provider, inbound, now);
  }

  channelWebhookChallenge(
    provider: ChannelProvider,
    query: Record<string, unknown>
  ): string | null {
    return this.deps.channelGateway.webhookChallenge(provider, query);
  }

  ingestChannelWebhookBatch(input: {
    provider: ChannelProvider;
    headers: Record<string, string | string[] | undefined>;
    payload: unknown;
    rawBody: Buffer;
    now?: Date;
  }) {
    let messages;
    try {
      messages = this.deps.channelGateway.normalizeInboundBatch(input);
    } catch (error) {
      throw this.channelError(error);
    }
    return messages.map((inbound) =>
      this.ingestNormalizedChannelMessage(input.provider, inbound, input.now ?? new Date())
    );
  }

  private ingestNormalizedChannelMessage(
    provider: ChannelProvider,
    inbound: CanonicalInboundChannelMessage,
    now: Date
  ): {
    receipt: ProviderUpdateReceiptSummary;
    message: ConversationMessageSummary | null;
    orderIntentOutcome: OfflineOrderIntentOutcome | null;
  } {
    const existingReceipt = [...this.providerUpdateReceipts.values()].find(
      (candidate) =>
        candidate.provider === provider && candidate.externalUpdateId === inbound.externalUpdateId
    );
    if (existingReceipt) {
      return {
        receipt: existingReceipt,
        message:
          existingReceipt.messageId === null
            ? null
            : (this.conversationMessages.get(existingReceipt.messageId) ?? null),
        orderIntentOutcome: null
      };
    }

    const matchingChannels = [...this.conversationChannels.values()].filter(
      (candidate) =>
        candidate.provider === provider &&
        candidate.externalConversationId === inbound.externalConversationId &&
        (inbound.businessId === undefined || candidate.businessId === inbound.businessId)
    );
    let channel = matchingChannels.length === 1 ? matchingChannels[0] : undefined;
    if (inbound.linkToken !== null) {
      const tokenHash = hashCustomerCapability(inbound.linkToken);
      const grant = [...this.channelIdentityLinkGrants.values()].find(
        (candidate) =>
          candidate.provider === provider &&
          candidate.tokenHash === tokenHash &&
          (inbound.businessId === undefined || candidate.businessId === inbound.businessId)
      );
      if (
        grant === undefined ||
        grant.consumedAt !== null ||
        Date.parse(grant.expiresAt) <= now.getTime()
      ) {
        throw new Cp2Error(401, "channel_link_invalid", "This channel link is invalid or expired.");
      }
      const ownerMembership = [...this.deps.memberships.values()].find(
        (membership) => membership.businessId === grant.businessId && membership.role === "owner"
      );
      const owner = ownerMembership ? this.deps.users.get(ownerMembership.userId) : undefined;
      if (owner === undefined) {
        throw new Cp2Error(409, "storefront_owner_missing", "Storefront owner is unavailable.");
      }
      const linked = this.upsertProviderConversation({
        businessId: grant.businessId,
        provider: provider,
        customerId: grant.customerId,
        externalUserId: inbound.externalUserId,
        externalConversationId: inbound.externalConversationId,
        displayName: inbound.displayName,
        metadata: { linkGrantId: grant.id, automaticRepliesEnabled: grant.automaticRepliesEnabled },
        ownerAccountId: owner.accountId,
        ownerUserId: owner.id,
        now
      });
      this.platformIdentities.set(linked.identity.id, {
        ...linked.identity,
        verifiedAt: now.toISOString(),
        optInStatus: "granted",
        optInSource: "provider_link_grant",
        optInAt: now.toISOString(),
        optOutAt: null
      });
      channel = linked.channel;
      this.channelIdentityLinkGrants.set(grant.id, { ...grant, consumedAt: now.toISOString() });
    }
    if (channel === undefined) {
      throw new Cp2Error(
        404,
        "CHANNEL_IDENTITY_NOT_FOUND",
        "No customer is linked to this provider conversation."
      );
    }
    const ingested = this.ingestProviderMessage({
      provider: provider,
      businessId: channel.businessId,
      externalConversationId: inbound.externalConversationId,
      externalUpdateId: inbound.externalUpdateId,
      body: inbound.linkToken === null ? inbound.text : `[${provider} identity linked]`,
      providerMessageId: inbound.externalMessageId,
      now
    });
    const currentChannel = this.conversationChannels.get(channel.id);
    const providerTime = Date.parse(inbound.receivedAt);
    const previousTime = Date.parse(channel.lastInboundAt ?? "");
    if (currentChannel && Number.isFinite(providerTime)) {
      this.conversationChannels.set(channel.id, {
        ...currentChannel,
        lastInboundAt: new Date(
          Math.max(providerTime, Number.isFinite(previousTime) ? previousTime : 0)
        ).toISOString()
      });
    }
    const identity = [...this.platformIdentities.values()].find(
      (candidate) =>
        candidate.businessId === channel.businessId &&
        candidate.provider === provider &&
        candidate.externalUserId === inbound.externalUserId
    );
    if (
      identity &&
      (provider === "sms" || provider === "whatsapp") &&
      /^(?:stop|unsubscribe)$/i.test(inbound.text.trim())
    ) {
      this.platformIdentities.set(identity.id, {
        ...identity,
        optInStatus: "revoked",
        optOutAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
    }
    if (
      identity &&
      (provider === "sms" || provider === "whatsapp") &&
      /^start$/i.test(inbound.text.trim())
    ) {
      this.platformIdentities.set(identity.id, {
        ...identity,
        optInStatus: "granted",
        optInSource: "provider_start_message",
        optInAt: now.toISOString(),
        optOutAt: null,
        updatedAt: now.toISOString()
      });
    }
    const ownerMembership = [...this.deps.memberships.values()].find(
      (membership) => membership.businessId === channel.businessId && membership.role === "owner"
    );
    const orderIntentOutcome =
      inbound.linkToken !== null ||
      provider !== "telegram" ||
      identity?.customerId == null ||
      ownerMembership === undefined
        ? null
        : this.reconcileInboundChannelOrder({
            provider: provider,
            businessId: channel.businessId,
            customerId: identity.customerId,
            actorId: ownerMembership.userId,
            externalMessageId: inbound.externalMessageId,
            text: inbound.text,
            now
          });
    return { ...ingested, orderIntentOutcome };
  }

  private reconcileInboundChannelOrder(input: {
    provider: ChannelProvider;
    businessId: string;
    customerId: string;
    actorId: string;
    externalMessageId: string;
    text: string;
    now: Date;
  }): OfflineOrderIntentOutcome | null {
    const parsed = parseOfflineOrderText(
      input.text,
      this.deps.productsForBusiness(input.businessId)
    );
    if (!parsed.looksLikeOrder) return null;
    if (parsed.items.length === 0) {
      this.sendChannelMessage({
        sessionId: null,
        businessId: input.businessId,
        customerId: input.customerId,
        provider: input.provider,
        text: offlineOrderClarificationMessage(parsed.problems),
        idempotencyKey: `${input.provider}-order:${input.externalMessageId}:clarify`,
        now: input.now,
        [systemChannelDelivery]: true
      }).catch(() => undefined);
      return null;
    }
    try {
      const outcome = this.deps.createChannelOrder({
        businessId: input.businessId,
        customerId: input.customerId,
        provider: input.provider,
        actorId: input.actorId,
        items: parsed.items,
        idempotencyKey: `${input.provider}-order:${input.externalMessageId}`,
        now: input.now
      });
      this.sendChannelMessage({
        sessionId: null,
        businessId: input.businessId,
        customerId: input.customerId,
        provider: input.provider,
        text: offlineOrderOutcomeMessage(outcome),
        idempotencyKey: `${input.provider}-order:${input.externalMessageId}:outcome`,
        now: input.now,
        [systemChannelDelivery]: true
      }).catch(() => undefined);
      return outcome;
    } catch {
      return null;
    }
  }

  async sendChannelMessage(input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string;
    customerName?: string;
    conversationId?: string;
    provider?: ChannelProvider;
    mailboxId?: string;
    subject?: string;
    replyToMessageId?: string;
    attachments?: TrustedMessageAttachmentReference[];
    text: string;
    idempotencyKey: string;
    now?: Date;
    [systemChannelDelivery]?: true;
  }): Promise<ChannelMessageSendResult> {
    const now = input.now ?? new Date();
    const auth =
      input[systemChannelDelivery] === true
        ? this.systemBusinessActor(input.businessId)
        : this.deps.requireAuthorizedSession(
            input.sessionId,
            input.businessId,
            "customer:write",
            now
          );
    const text = normalizeRequiredBoundedText(input.text, "message", 4000);
    const idempotencyKey = normalizeRequiredBoundedText(
      input.idempotencyKey,
      "idempotencyKey",
      200
    );
    const customer = this.resolveMessagingCustomer(input.businessId, {
      customerId: input.customerId,
      customerName: input.customerName,
      conversationId: input.conversationId
    });
    if (input.provider === "native_sms" || input.provider === undefined) {
      this.ensureNativeSmsEndpoint({
        businessId: input.businessId,
        customer,
        accountId: auth.account.id,
        userId: auth.user.id,
        now
      });
    }
    if (input.provider === "email") {
      this.ensureEmailEndpoint({
        businessId: input.businessId,
        customer,
        accountId: auth.account.id,
        userId: auth.user.id,
        mailboxId: input.mailboxId ?? null,
        conversationId: input.conversationId ?? null,
        allowUnconnected: false,
        now
      });
    }
    let endpoints = this.channelEndpoints({
      businessId: input.businessId,
      customerId: customer.id,
      conversationId: input.conversationId ?? null
    });
    if (input.mailboxId !== undefined) {
      endpoints = endpoints.filter(
        (endpoint) =>
          endpoint.provider !== "email" || endpoint.executionMailboxId === input.mailboxId
      );
    }
    let selection;
    try {
      selection = this.deps.channelGateway.select({
        endpoints,
        ...(input.provider === undefined ? {} : { preferredProvider: input.provider })
      });
    } catch (error) {
      throw this.channelError(error);
    }
    const existingId = this.messageByIdempotencyKey.get(
      `${selection.endpoint.conversationId}:${idempotencyKey}`
    );
    if (existingId) {
      return {
        message: this.conversationMessages.get(existingId) as ConversationMessageSummary,
        selection
      };
    }
    const replyTo =
      input.replyToMessageId === undefined
        ? null
        : this.requireEmailReplyTarget(selection.endpoint.conversationId, input.replyToMessageId);
    const subject =
      selection.endpoint.provider === "email"
        ? normalizeEmailSubject(input.subject ?? replyTo?.subject ?? "")
        : null;
    if (selection.endpoint.provider !== "email" && (input.attachments?.length ?? 0) > 0) {
      throw new Cp2Error(
        400,
        "channel_attachment_unsupported",
        "Send document attachments through a connected mailbox."
      );
    }
    const resolvedAttachments =
      selection.endpoint.provider === "email"
        ? this.resolveTrustedEmailAttachments(
            input.businessId,
            customer.id,
            input.attachments ?? []
          )
        : { canonical: [], provider: [] };
    const message = this.persistOutboundChannelMessage({
      endpoint: selection.endpoint,
      authorId: auth.user.id,
      text,
      subject,
      replyToMessageId: replyTo?.id ?? null,
      externalThreadId: replyTo?.externalThreadId ?? null,
      attachments: resolvedAttachments.canonical,
      idempotencyKey,
      now
    });
    try {
      const dispatched = await this.deps.channelGateway.send({
        businessId: input.businessId,
        conversationId: selection.endpoint.conversationId,
        customerId: customer.id,
        idempotencyKey,
        text,
        ...(subject === null ? {} : { subject }),
        ...(replyTo === null
          ? {}
          : {
              replyToProviderMessageId: replyTo.providerMessageId ?? null,
              externalThreadId: replyTo.externalThreadId ?? null
            }),
        ...(resolvedAttachments.provider.length === 0
          ? {}
          : { attachments: resolvedAttachments.provider }),
        endpoints,
        preferredProvider: selection.endpoint.provider
      });
      const delivered: ConversationMessageSummary = {
        ...message,
        status: dispatched.result.status,
        sentAt: dispatched.result.status === "queued" ? null : now.toISOString(),
        deliveredAt: dispatched.result.status === "delivered" ? now.toISOString() : null,
        failureCode: null,
        actualChannel: providerToMessageChannel(dispatched.selection.endpoint.provider),
        providerMessageId: dispatched.result.providerMessageId,
        externalThreadId: dispatched.result.externalThreadId ?? message.externalThreadId ?? null,
        externalConversationId:
          dispatched.result.externalThreadId ?? message.externalConversationId ?? null
      };
      this.conversationMessages.set(delivered.id, delivered);
      if (dispatched.result.status !== "queued") {
        this.finishChannelDeliveryAttempt(delivered, "succeeded", null, now);
      }
      const channel = this.conversationChannels.get(selection.endpoint.channelId);
      if (channel) {
        this.conversationChannels.set(channel.id, {
          ...channel,
          externalConversationId:
            dispatched.result.externalThreadId ?? channel.externalConversationId,
          metadata: subject === null ? channel.metadata : { ...channel.metadata, subject },
          lastOutboundAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
      }
      return { message: delivered, selection: dispatched.selection };
    } catch (error) {
      const normalized = this.channelError(error);
      const failed: ConversationMessageSummary = {
        ...message,
        status: "failed",
        failureCode: normalized.code,
        retryCount: 1,
        nextRetryAt:
          error instanceof ChannelGatewayError && error.retryable
            ? new Date(now.getTime() + 60_000).toISOString()
            : null
      };
      this.conversationMessages.set(failed.id, failed);
      this.finishChannelDeliveryAttempt(
        failed,
        error instanceof ChannelGatewayError && error.retryable
          ? "transient_failure"
          : "permanent_failure",
        normalized.code,
        now
      );
      throw normalized;
    }
  }

  async deliverFulfillmentNotification(input: {
    id: string;
    businessId: string;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }): Promise<void> {
    const invoiceIds = Array.isArray(input.payload.invoiceIds)
      ? input.payload.invoiceIds.filter((value): value is string => typeof value === "string")
      : typeof input.payload.invoiceId === "string"
        ? [input.payload.invoiceId]
        : [];
    const text =
      input.eventType === "manifest.created"
        ? "Your delivery has been scheduled."
        : input.eventType === "delivery.completed"
          ? "Your order has been delivered."
          : null;
    if (text === null) return;
    for (const invoiceId of invoiceIds) {
      let invoice: InvoiceSummary;
      try {
        invoice = this.deps.requireInvoice(input.businessId, invoiceId);
      } catch (error) {
        if (error instanceof Cp2Error && error.statusCode === 404) continue;
        throw error;
      }
      if (invoice.customerId === null) continue;
      const endpoints = this.channelEndpoints({
        businessId: input.businessId,
        customerId: invoice.customerId,
        conversationId: null
      });
      if (endpoints.every((endpoint) => endpoint.provider === "grogoni")) continue;
      await this.sendChannelMessage({
        sessionId: null,
        businessId: input.businessId,
        customerId: invoice.customerId,
        text,
        idempotencyKey: `fulfillment:${input.id}:${invoiceId}`,
        now: new Date(input.occurredAt),
        [systemChannelDelivery]: true
      });
    }
  }

  private systemBusinessActor(businessId: string): AuthenticatedActorView {
    const membership = [...this.deps.memberships.values()].find(
      (candidate) => candidate.businessId === businessId && candidate.role === "owner"
    );
    const user = membership === undefined ? undefined : this.deps.users.get(membership.userId);
    const account = user === undefined ? undefined : this.deps.accounts.get(user.accountId);
    if (user === undefined || account === undefined) {
      throw new Cp2Error(409, "business_owner_missing", "The business owner is unavailable.");
    }
    return { user, account };
  }

  ingestProviderMessage(input: {
    provider: ChannelProvider;
    businessId: string;
    externalConversationId: string;
    externalUpdateId: string;
    body: string;
    providerMessageId?: string | null;
    subject?: string | null;
    externalThreadId?: string | null;
    senderAddress?: string | null;
    recipientAddresses?: string[];
    ccAddresses?: string[];
    now?: Date;
  }): { receipt: ProviderUpdateReceiptSummary; message: ConversationMessageSummary | null } {
    const now = input.now ?? new Date();
    const existing = [...this.providerUpdateReceipts.values()].find(
      (candidate) =>
        candidate.provider === input.provider &&
        candidate.externalUpdateId === input.externalUpdateId
    );
    if (existing !== undefined) {
      return {
        receipt: existing,
        message: existing.messageId
          ? (this.conversationMessages.get(existing.messageId) ?? null)
          : null
      };
    }
    const channel = [...this.conversationChannels.values()].find(
      (candidate) =>
        candidate.provider === input.provider &&
        candidate.businessId === input.businessId &&
        candidate.externalConversationId === input.externalConversationId
    );
    if (channel === undefined) {
      throw new Cp2Error(
        404,
        "conversation_channel_not_found",
        "Provider relationship was not found."
      );
    }
    const message = this.persistExternalConversationMessage({
      conversationId: channel.conversationId,
      provider: input.provider,
      channelIdentityId: channel.platformIdentityId,
      externalConversationId: channel.externalConversationId,
      author: "user",
      authorId: channel.platformIdentityId,
      body: normalizeRequiredBoundedText(input.body, "message", 4000),
      attachmentNames: [],
      idempotencyKey: `${input.provider}:update:${input.externalUpdateId}`,
      providerMessageId: input.providerMessageId ?? null,
      subject: input.subject ?? null,
      externalThreadId: input.externalThreadId ?? null,
      senderAddress: input.senderAddress ?? null,
      recipientAddresses: input.recipientAddresses ?? [],
      ccAddresses: input.ccAddresses ?? [],
      now
    });
    this.conversationChannels.set(channel.id, {
      ...channel,
      lastInboundAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    const receipt: ProviderUpdateReceiptSummary = {
      id: randomUUID(),
      provider: input.provider,
      externalUpdateId: input.externalUpdateId,
      businessId: input.businessId,
      conversationChannelId: channel.id,
      messageId: message.id,
      status: "processed",
      createdAt: now.toISOString(),
      processedAt: now.toISOString()
    };
    this.providerUpdateReceipts.set(receipt.id, receipt);
    return { receipt, message };
  }

  listConversations(input: {
    sessionId: string | null;
    includeArchived?: boolean;
    now?: Date;
  }): ConversationInboxItem[] {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    this.ensurePersonalAccountConversation({
      accountId: session.account.id,
      userId: session.user.id,
      now
    });
    return [...this.conversations.values()]
      .map((conversation): ConversationInboxItem | null => {
        if (conversation.deletedAt != null) return null;
        const participant = this.accountConversationParticipant(
          conversation.id,
          session.account.id
        );
        if (participant === null || (!input.includeArchived && participant.archivedAt)) return null;
        const messages = this.messagesForConversation(conversation.id);
        const lastMessage = messages.at(-1) ?? null;
        const lastRead =
          participant.lastReadAt === null || participant.lastReadAt === undefined
            ? 0
            : Date.parse(participant.lastReadAt);
        return {
          ...conversation,
          conversationType: this.conversationType(conversation),
          lastMessage,
          unreadCount: messages.filter(
            (message) =>
              message.authorId !== session.user.id &&
              message.deletedAt == null &&
              Date.parse(message.createdAt) > lastRead
          ).length,
          participant: {
            ...this.participantView(participant),
            networkNodeId: this.contactNodeForConversation(conversation.id, session.account.id)
          },
          hasHumanRecipient: this.conversationHasHumanRecipient(conversation.id, session.account.id)
        } satisfies ConversationInboxItem;
      })
      .filter((conversation): conversation is ConversationInboxItem => conversation !== null)
      .sort((left, right) => {
        if (left.helpTopic || right.helpTopic) {
          if (!left.helpTopic) return 1;
          if (!right.helpTopic) return -1;
          return (
            helpGuides.findIndex((guide) => guide.key === left.helpTopic) -
            helpGuides.findIndex((guide) => guide.key === right.helpTopic)
          );
        }
        const pinned =
          Number(Boolean(right.participant.pinnedAt)) - Number(Boolean(left.participant.pinnedAt));
        return pinned || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
  }

  getConversation(input: {
    sessionId: string | null;
    conversationId: string;
    now?: Date;
  }): ConversationView {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    return this.conversationView(
      this.requireAccountConversation(input.conversationId, session.account.id)
    );
  }

  async deliverWorkspaceFile(input: {
    sessionId: string | null;
    businessId: string;
    conversationId: string;
    requestedPaths: string[];
    transferredFiles?: ClientWorkspaceFileTransfer[];
    caption?: string;
    toolCallId: string;
    now?: Date;
  }): Promise<WorkspaceDeliverResult> {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    this.requireAccountConversation(input.conversationId, auth.account.id);
    this.deps.recordAuditEvent({
      type: "workspace.file_delivery_requested",
      aggregateType: "conversation",
      aggregateId: input.conversationId,
      actorId: auth.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        toolCallId: input.toolCallId,
        fileCount: input.requestedPaths.length
      }
    });
    if (input.requestedPaths.length < 1 || input.requestedPaths.length > 10) {
      this.recordWorkspaceDeliveryFailure(input, auth.user.id, "DELIVERY_FILE_COUNT_INVALID", now);
      throw new Cp2Error(
        400,
        "DELIVERY_FILE_COUNT_INVALID",
        "Choose between one and ten workspace files to deliver."
      );
    }
    const requestedPaths = input.requestedPaths;
    const transferredFiles = input.transferredFiles ?? [];
    if (
      transferredFiles.length > requestedPaths.length ||
      new Set(transferredFiles.map((file) => file.path)).size !== transferredFiles.length ||
      transferredFiles.some((file) => !requestedPaths.includes(file.path))
    ) {
      this.recordWorkspaceDeliveryFailure(input, auth.user.id, "LOCAL_FILE_TRANSFER_MISMATCH", now);
      throw new Cp2Error(
        400,
        "LOCAL_FILE_TRANSFER_MISMATCH",
        "The transferred files do not match the requested workspace files."
      );
    }
    const expectedToolCallIds = requestedPaths.map((_, index) =>
      requestedPaths.length === 1 ? input.toolCallId : `${input.toolCallId}:${index}`
    );
    const existing = [...this.conversationAttachments.values()].filter(
      (attachment) =>
        attachment.conversationId === input.conversationId &&
        expectedToolCallIds.includes(attachment.toolCallId)
    );
    if (existing.length === requestedPaths.length && existing.length > 0) {
      const attachments = expectedToolCallIds.map((toolCallId) => {
        const record = existing.find((attachment) => attachment.toolCallId === toolCallId);
        if (record === undefined) {
          throw new Cp2Error(409, "ATTACHMENT_RETRY_CONFLICT", "File delivery retry conflicted.");
        }
        return managedAttachmentFromRecord(record);
      });
      this.deps.recordAuditEvent({
        type: "workspace.file_delivery_deduplicated",
        aggregateType: "conversation",
        aggregateId: input.conversationId,
        actorId: auth.user.id,
        occurredAt: now.toISOString(),
        payload: { businessId: input.businessId, toolCallId: input.toolCallId }
      });
      return { ok: true, delivered: true, attachment: attachments[0]!, attachments };
    }
    const configuredRoot = this.deps.workspaceRoot?.trim();
    if (!configuredRoot && transferredFiles.length !== requestedPaths.length) {
      this.recordWorkspaceDeliveryFailure(input, auth.user.id, "WORKSPACE_UNAVAILABLE", now);
      throw new Cp2Error(409, "WORKSPACE_UNAVAILABLE", "The active workspace is unavailable.");
    }
    let files;
    try {
      const maxFileBytes = this.deps.workspaceDeliveryMaxFileBytes ?? 10_000_000;
      files = await Promise.all(
        requestedPaths.map((requestedPath) => {
          const transfer = transferredFiles.find((candidate) => candidate.path === requestedPath);
          return transfer === undefined
            ? resolveWorkspaceFile({
                workspaceRoot: resolve(configuredRoot!, input.businessId),
                requestedPath,
                maxFileBytes
              })
            : Promise.resolve(
                resolveTransferredWorkspaceFile({ requestedPath, transfer, maxFileBytes })
              );
        })
      );
    } catch (error) {
      this.recordWorkspaceDeliveryFailure(
        input,
        auth.user.id,
        error instanceof Cp2Error ? error.code : "FILE_UNREADABLE",
        now
      );
      throw error;
    }
    this.deps.recordAuditEvent({
      type: "workspace.files_validated",
      aggregateType: "conversation",
      aggregateId: input.conversationId,
      actorId: auth.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        toolCallId: input.toolCallId,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
        mimeTypes: files.map((file) => file.mimeType)
      }
    });
    const caption = sanitizeWorkspaceAttachmentCaption(input.caption);
    const attachmentIds = files.map(() => randomUUID());
    const records = files.map<ConversationAttachmentRecord>((file, index) => ({
      id: attachmentIds[index]!,
      accountId: auth.account.id,
      userId: auth.user.id,
      businessId: input.businessId,
      conversationId: input.conversationId,
      messageId: null,
      toolCallId: expectedToolCallIds[index]!,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      kind: file.kind,
      previewable: file.previewable,
      caption,
      checksum: file.checksum,
      storageKey: `conversation-attachments/${attachmentIds[index]!}`,
      createdAt: now.toISOString()
    }));
    const storedKeys: string[] = [];
    try {
      for (const [index, record] of records.entries()) {
        await this.deps.conversationAttachmentBlobStore.put({
          storageKey: record.storageKey,
          bytes: files[index]!.bytes,
          checksum: record.checksum,
          mimeType: record.mimeType
        });
        storedKeys.push(record.storageKey);
      }
    } catch {
      await Promise.all(
        storedKeys.map((storageKey) =>
          this.deps.conversationAttachmentBlobStore.delete(storageKey).catch(() => undefined)
        )
      );
      this.recordWorkspaceDeliveryFailure(input, auth.user.id, "STORAGE_FAILED", now);
      throw new Cp2Error(503, "STORAGE_FAILED", "The workspace file could not be stored.");
    }
    for (const record of records) {
      this.conversationAttachments.set(record.id, record);
      this.deps.recordAuditEvent({
        type: "workspace.file_delivered",
        aggregateType: "conversation_attachment",
        aggregateId: record.id,
        actorId: auth.user.id,
        occurredAt: now.toISOString(),
        payload: {
          businessId: input.businessId,
          conversationId: input.conversationId,
          toolCallId: record.toolCallId,
          mimeType: record.mimeType,
          size: record.size
        }
      });
    }
    const attachments = records.map(managedAttachmentFromRecord);
    return { ok: true, delivered: true, attachment: attachments[0]!, attachments };
  }

  async getConversationAttachment(input: {
    sessionId: string | null;
    conversationId: string;
    attachmentId: string;
    now?: Date;
  }): Promise<{ record: ConversationAttachmentRecord; bytes: Buffer }> {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    this.requireAccountConversation(input.conversationId, session.account.id);
    const record = this.conversationAttachments.get(input.attachmentId);
    if (
      record === undefined ||
      record.accountId !== session.account.id ||
      record.conversationId !== input.conversationId ||
      record.messageId === null
    ) {
      throw new Cp2Error(404, "ATTACHMENT_NOT_FOUND", "The conversation attachment was not found.");
    }
    const bytes = await this.deps.conversationAttachmentBlobStore.get(record.storageKey);
    if (bytes === null) {
      throw new Cp2Error(404, "ATTACHMENT_NOT_FOUND", "The conversation attachment was not found.");
    }
    return { record, bytes };
  }

  registerE2eeDevice(input: {
    sessionId: string | null;
    deviceId: string;
    label: string;
    publicKey: E2eePublicKey;
    now?: Date;
  }): E2eeDeviceSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const deviceId = input.deviceId.trim();
    const label = input.label.trim();
    if (deviceId.length < 8 || deviceId.length > 120 || label.length < 1 || label.length > 120) {
      throw new Cp2Error(400, "e2ee_device_invalid", "Device id or label is invalid.");
    }
    validateE2eePublicKey(input.publicKey);
    const current = this.e2eeDevices.get(deviceId);
    if (current && current.accountId !== session.account.id) {
      throw new Cp2Error(409, "e2ee_device_conflict", "Device id is already registered.");
    }
    const device: E2eeDeviceSummary = {
      id: deviceId,
      accountId: session.account.id,
      label,
      publicKey: input.publicKey,
      createdAt: current?.createdAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      revokedAt: null
    };
    this.e2eeDevices.set(device.id, device);
    return device;
  }

  listE2eeDevices(input: { sessionId: string | null; now?: Date }): E2eeDeviceSummary[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    return [...this.e2eeDevices.values()].filter(
      (device) => device.accountId === session.account.id && device.revokedAt === null
    );
  }

  revokeE2eeDevice(input: {
    sessionId: string | null;
    deviceId: string;
    now?: Date;
  }): E2eeDeviceSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const current = this.e2eeDevices.get(input.deviceId);
    if (!current || current.accountId !== session.account.id) {
      throw new Cp2Error(404, "e2ee_device_not_found", "Encryption device was not found.");
    }
    const device = { ...current, revokedAt: now.toISOString() };
    this.e2eeDevices.set(device.id, device);
    return device;
  }

  listConversationE2eeDevices(input: {
    sessionId: string | null;
    conversationId: string;
    now?: Date;
  }): E2eeDeviceSummary[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    this.requireAccountConversation(input.conversationId, session.account.id);
    const accountIds = new Set(this.humanConversationAccountIds(input.conversationId));
    return [...this.e2eeDevices.values()].filter(
      (device) => accountIds.has(device.accountId) && device.revokedAt === null
    );
  }

  registerPushSubscription(input: {
    sessionId: string | null;
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
    now?: Date;
  }): PushSubscriptionSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const endpoint = input.endpoint.trim();
    if (!endpoint.startsWith("https://") || endpoint.length > 2_048) {
      throw new Cp2Error(400, "push_subscription_invalid", "Push endpoint is invalid.");
    }
    if (!isBase64Url(input.keys.auth, 16, 256) || !isBase64Url(input.keys.p256dh, 32, 512)) {
      throw new Cp2Error(400, "push_subscription_invalid", "Push keys are invalid.");
    }
    const currentId = this.pushSubscriptionIdByEndpoint.get(endpoint);
    const current = currentId ? this.pushSubscriptions.get(currentId) : undefined;
    if (current && current.accountId !== session.account.id) {
      throw new Cp2Error(409, "push_subscription_conflict", "Push endpoint is already registered.");
    }
    const subscription: PushSubscriptionSummary = {
      id: current?.id ?? randomUUID(),
      accountId: session.account.id,
      endpoint,
      expirationTime: input.expirationTime,
      keys: input.keys,
      createdAt: current?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.pushSubscriptions.set(subscription.id, subscription);
    this.pushSubscriptionIdByEndpoint.set(endpoint, subscription.id);
    return subscription;
  }

  removePushSubscription(input: { sessionId: string | null; endpoint: string; now?: Date }): {
    removed: boolean;
  } {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    const id = this.pushSubscriptionIdByEndpoint.get(input.endpoint);
    const subscription = id ? this.pushSubscriptions.get(id) : undefined;
    if (!subscription || subscription.accountId !== session.account.id) return { removed: false };
    this.pushSubscriptions.delete(subscription.id);
    this.pushSubscriptionIdByEndpoint.delete(subscription.endpoint);
    return { removed: true };
  }

  recordMessageHandoff(input: {
    sessionId: string | null;
    businessId: string | null;
    conversationId: string | null;
    channel: MessageHandoffChannel;
    status: MessageHandoffStatus;
    normalizedErrorCode: string | null;
    now?: Date;
  }): MessageHandoffSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    if (input.businessId !== null) {
      this.deps.requireMembership(input.businessId, session.user.id);
    }
    if (input.conversationId !== null) {
      this.requireAccountConversation(input.conversationId, session.account.id);
    }
    if (
      input.normalizedErrorCode !== null &&
      !/^[a-z0-9_]{1,80}$/.test(input.normalizedErrorCode)
    ) {
      throw new Cp2Error(
        400,
        "message_handoff_error_invalid",
        "The normalized handoff error code is invalid."
      );
    }

    const handoff: MessageHandoffSummary = {
      id: randomUUID(),
      accountId: session.account.id,
      businessId: input.businessId,
      conversationId: input.conversationId,
      channel: input.channel,
      status: input.status,
      normalizedErrorCode: input.normalizedErrorCode,
      createdAt: now.toISOString()
    };
    this.deps.recordAuditEvent({
      type: "message.handoff",
      aggregateType: "message_handoff",
      aggregateId: handoff.id,
      actorId: session.user.id,
      occurredAt: handoff.createdAt,
      payload: {
        accountId: handoff.accountId,
        businessId: handoff.businessId,
        conversationId: handoff.conversationId,
        channel: handoff.channel,
        status: handoff.status,
        normalizedErrorCode: handoff.normalizedErrorCode
      }
    });
    return handoff;
  }

  /**
   * `conversationId` is optional only so a client can send its very first message before it has
   * loaded its inbox: the session's own durable personal (assistant) conversation is opened - and
   * created if needed - instead. `requireAccountConversation` then applies the same ownership check
   * to it as to any explicit id, so this can never reach another account's conversation.
   */
  createConversationMessage(input: {
    sessionId: string | null;
    conversationId?: string;
    clientMessageId: string;
    idempotencyKey?: string;
    content: ConversationMessageContent;
    author?: ConversationMessageAuthor;
    replyToMessageId?: string | null;
    forwardedFromMessageId?: string | null;
    clientTimestamp?: string | null;
    queuedAt?: string | null;
    selectedChannel?: MessageChannel;
    now?: Date;
  }): ConversationMessageSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const conversation =
      input.conversationId === undefined
        ? this.ensurePersonalAccountConversation({
            accountId: actor.account.id,
            userId: actor.user.id,
            now
          })
        : this.requireAccountConversation(input.conversationId, actor.account.id);
    if (input.author === "agent" && conversation.kind !== "personal" && conversation.activeShopId) {
      this.deps.requireAuthorizedSession(
        input.sessionId,
        conversation.activeShopId,
        "customer:write",
        now
      );
      if (!conversation.businessAgentEnabled)
        throw new Cp2Error(409, "business_agent_disabled", "The business agent is disabled.");
    }
    return this.createMessageForActor({ ...input, conversationId: conversation.id }, actor);
  }

  /**
   * The one message writer. `createConversationMessage` reaches it with the caller's pinned
   * session; the daemon bridge reaches it with the session of the account that owns the task, so a
   * server-owned reply lands in the same conversation with the same checks as a typed one.
   */
  private createMessageForActor(
    input: {
      sessionId: string | null;
      conversationId: string;
      clientMessageId: string;
      idempotencyKey?: string;
      content: ConversationMessageContent;
      author?: ConversationMessageAuthor;
      replyToMessageId?: string | null;
      forwardedFromMessageId?: string | null;
      clientTimestamp?: string | null;
      queuedAt?: string | null;
      selectedChannel?: MessageChannel;
      now?: Date;
    },
    session: Pick<AuthSessionView, "account" | "user">
  ): ConversationMessageSummary {
    const now = input.now ?? new Date();
    const conversation = this.requireAccountConversation(input.conversationId, session.account.id);
    if (conversation.kind === "personal")
      for (const accountId of this.humanConversationAccountIds(conversation.id)) {
        if (accountId !== session.account.id)
          this.requireContactAllowed(session.user.id, accountId, false);
      }
    const clientMessageId = input.clientMessageId.trim();

    if (clientMessageId.length < 8 || clientMessageId.length > 120) {
      throw new Cp2Error(
        400,
        "client_message_id_invalid",
        "clientMessageId must be between 8 and 120 characters."
      );
    }

    const idempotencyKey = (
      input.idempotencyKey ?? `grogoni:${conversation.id}:${clientMessageId}`
    ).trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new Cp2Error(
        400,
        "idempotency_key_invalid",
        "idempotencyKey must be between 8 and 200 characters."
      );
    }
    const selectedChannel = input.selectedChannel ?? "grogoni";
    const externalChannel =
      selectedChannel === "grogoni"
        ? undefined
        : [...this.conversationChannels.values()].find(
            (channel) =>
              channel.conversationId === conversation.id && channel.provider === selectedChannel
          );
    if (selectedChannel !== "grogoni" && externalChannel === undefined) {
      throw new Cp2Error(
        400,
        "message_channel_unavailable",
        "The requested messaging channel is not configured."
      );
    }

    const clientLookupKey = `${conversation.id}:${clientMessageId}`;
    const idempotencyLookupKey = `${conversation.id}:${idempotencyKey}`;
    const existingId =
      this.messageByClientId.get(clientLookupKey) ??
      this.messageByIdempotencyKey.get(idempotencyLookupKey);

    if (existingId !== undefined) {
      return this.conversationMessages.get(existingId) as ConversationMessageSummary;
    }

    validateConversationMessageContent(input.content);
    this.validateConversationEncryption(conversation.id, input.content);
    this.validateManagedConversationAttachments(input.content, conversation, session.account.id);
    for (const referencedId of [input.replyToMessageId, input.forwardedFromMessageId]) {
      if (
        referencedId &&
        this.requireConversationMessage(referencedId, conversation.id).deletedAt
      ) {
        throw new Cp2Error(400, "message_reference_invalid", "Referenced message was deleted.");
      }
    }
    if (input.content.type === "owner-controls") {
      this.deps.requireMembership(input.content.shopId, session.user.id);
      // Only owner controls need the session's mode, which a trusted daemon writer never sends.
      const context = this.deps.ensureGrogoniSessionContext(session as AuthSessionView, now);

      if (context.mode !== "seller" || context.activeShopId !== input.content.shopId) {
        throw new Cp2Error(
          403,
          "seller_context_required",
          "Owner controls require seller mode for the active shop."
        );
      }
    }
    if (input.content.type === "storefront" && !this.deps.businesses.has(input.content.shopId)) {
      throw new Cp2Error(404, "business_not_found", "Storefront shop was not found.");
    }
    const author = input.author ?? "user";
    if (
      author === "agent" &&
      conversation.kind === "personal" &&
      input.content.type !== "encrypted" &&
      [...this.conversationParticipants.values()].some(
        (participant) =>
          participant.conversationId === conversation.id &&
          participant.role === "account" &&
          participant.accountId !== session.account.id
      )
    ) {
      throw new Cp2Error(
        403,
        "agent_message_forbidden",
        "Agent messages in direct conversations must be end-to-end encrypted."
      );
    }
    const message: ConversationMessageSummary = {
      id: randomUUID(),
      conversationId: conversation.id,
      clientMessageId,
      idempotencyKey,
      author,
      authorId: author === "agent" ? `account-${session.account.id}-agent` : session.user.id,
      content: input.content,
      status: selectedChannel === "grogoni" ? "delivered" : "queued",
      queuedAt: input.queuedAt ?? (selectedChannel === "grogoni" ? null : now.toISOString()),
      sentAt: selectedChannel === "grogoni" ? now.toISOString() : null,
      deliveredAt: selectedChannel === "grogoni" ? now.toISOString() : null,
      readAt: null,
      failureCode: selectedChannel === "grogoni" ? null : "provider_adapter_unconfigured",
      retryCount: 0,
      nextRetryAt: null,
      selectedChannel,
      actualChannel: selectedChannel === "grogoni" ? "grogoni" : null,
      providerMessageId: null,
      importedSource: null,
      importedExternalId: null,
      consentRecordId: null,
      editedAt: null,
      deletedAt: null,
      replyToMessageId: input.replyToMessageId ?? null,
      forwardedFromMessageId: input.forwardedFromMessageId ?? null,
      reactions: [],
      clientTimestamp: input.clientTimestamp ?? null,
      createdAt: now.toISOString()
    };
    this.conversationMessages.set(message.id, message);
    this.associateManagedConversationAttachments(message);
    this.messageByClientId.set(clientLookupKey, message.id);
    this.messageByIdempotencyKey.set(idempotencyLookupKey, message.id);
    const attempt: MessageDeliveryAttemptSummary = {
      id: randomUUID(),
      accountId: conversation.accountId,
      conversationId: conversation.id,
      messageId: message.id,
      channel: selectedChannel,
      provider: selectedChannel,
      attemptNumber: 1,
      requestedAt: now.toISOString(),
      respondedAt: selectedChannel === "grogoni" ? now.toISOString() : null,
      result: selectedChannel === "grogoni" ? "succeeded" : "transient_failure",
      normalizedFailureCode: selectedChannel === "grogoni" ? null : "provider_adapter_unconfigured",
      providerResponseReference: null
    };
    this.messageDeliveryAttempts.set(attempt.id, attempt);
    this.conversations.set(conversation.id, {
      ...conversation,
      updatedAt: now.toISOString()
    });
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversations",
      conversation.id,
      this.conversations.get(conversation.id) as ConversationSummary,
      now
    );
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_messages",
      message.id,
      message,
      now
    );
    this.deps.recordAuditEvent({
      type: "message.created",
      aggregateType: "conversation_message",
      aggregateId: message.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        clientMessageId,
        idempotencyKey,
        contentType: message.content.type,
        conversationId: conversation.id,
        selectedChannel
      }
    });
    this.enqueueConversationNotifications(
      conversation,
      message,
      message.author === "agent" ? "agent" : session.account.id,
      now
    );
    return message;
  }

  /**
   * Trusted daemon bridge. Never accepts caller-supplied author identities or delivery content: the
   * only account it will write for is the one that owns the task, found through `ownerUserId`.
   */
  deliverDaemonTask(task: PublicDaemonTask, ownerUserId: string): void {
    const origin = task.payload.kind === "agent" ? task.payload.conversation : undefined;
    if (!origin || task.payload.kind !== "agent") return;
    const user = this.deps.users.get(ownerUserId);
    const account = user && this.deps.accounts.get(user.accountId);
    if (!user || !account)
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    const conversation = this.requireAccountConversation(origin.id, account.id);
    if (conversation.accountId !== account.id || this.conversationType(conversation) !== "DAEMON")
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    const execution: ConversationExecutionSummary = {
      taskId: task.id,
      status: task.status,
      modelId: task.payload.modelId,
      attempts: task.attempts,
      errorCode: task.errorCode,
      retryable: task.status === "failed" || task.status === "cancelled",
      updatedAt: task.updatedAt
    };
    const source = this.messagesForConversation(origin.id).find(
      (message) => message.clientMessageId === origin.clientMessageId && message.author === "user"
    );
    const attach = (message: ConversationMessageSummary) => {
      // A newer execution already on the message wins, so an out-of-order update cannot regress it.
      if (message.execution && Date.parse(message.execution.updatedAt) > Date.parse(task.updatedAt))
        return;
      const next = { ...message, execution };
      this.conversationMessages.set(next.id, next);
      this.recordConversationSyncForParticipants(
        origin.id,
        "conversation_messages",
        next.id,
        next,
        new Date(task.updatedAt)
      );
    };
    if (source) attach(source);
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
      return;
    const result = task.result as { text?: unknown } | null;
    const text =
      task.status === "completed" && typeof result?.text === "string"
        ? origin.kind === "reminder" && origin.reminderText
          ? `Reminder: ${origin.reminderText}`
          : result.text
        : task.status === "cancelled"
          ? "This task was cancelled."
          : "The daemon could not finish this task. You can retry it here.";
    // Failed attempts and a later successful retry must not share the same response key.
    const message = this.createMessageForActor(
      {
        sessionId: null,
        conversationId: origin.id,
        clientMessageId: `daemon:${task.id}:${task.executions}:${task.status}:${task.attempts}`,
        author: "agent",
        content: { type: "text", text },
        replyToMessageId: source?.id ?? null,
        clientTimestamp: task.updatedAt,
        now: new Date(task.updatedAt)
      },
      { account, user }
    );
    attach(message);
  }

  async createAgentConversationMessage(input: {
    sessionId: string | null;
    /** Omitted means the caller's own personal conversation - see createConversationMessage. */
    conversationId?: string;
    clientMessageId: string;
    idempotencyKey?: string;
    content: ConversationMessageContent;
    replyToMessageId?: string | null;
    forwardedFromMessageId?: string | null;
    clientTimestamp?: string | null;
    queuedAt?: string | null;
    selectedChannel?: MessageChannel;
    businessId: string;
    message: string;
    runtimeSessionId?: string;
    now?: Date;
  }): Promise<AgentConversationMessageResult> {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const conversation =
      input.conversationId === undefined
        ? this.ensurePersonalAccountConversation({
            accountId: session.account.id,
            userId: session.user.id,
            now
          })
        : this.requireAccountConversation(input.conversationId, session.account.id);
    if (conversation.activeShopId !== null && conversation.activeShopId !== input.businessId) {
      throw new Cp2Error(
        403,
        "conversation_business_mismatch",
        "Agent business does not match this conversation."
      );
    }
    if (conversation.kind !== "personal" && !conversation.businessAgentEnabled)
      throw new Cp2Error(
        409,
        "business_agent_disabled",
        "The business owner has not enabled its agent in this conversation."
      );
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "customer:write", now);
    const hasHumanRecipient = this.conversationHasHumanRecipient(
      conversation.id,
      session.account.id
    );

    if (hasHumanRecipient) {
      throw new Cp2Error(
        409,
        "agent_processing_requires_agent_conversation",
        "Encrypted direct messages are not processed by the business agent."
      );
    }

    const message = this.createConversationMessage({
      sessionId: input.sessionId,
      conversationId: conversation.id,
      clientMessageId: input.clientMessageId,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      content: input.content,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
      ...(input.forwardedFromMessageId === undefined
        ? {}
        : { forwardedFromMessageId: input.forwardedFromMessageId }),
      ...(input.clientTimestamp === undefined ? {} : { clientTimestamp: input.clientTimestamp }),
      ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
      ...(input.selectedChannel === undefined ? {} : { selectedChannel: input.selectedChannel }),
      now
    });
    const existingAgentMessage = this.messagesForConversation(conversation.id).find(
      (candidate) =>
        candidate.author === "agent" &&
        candidate.replyToMessageId === message.id &&
        candidate.deletedAt === null
    );

    if (existingAgentMessage !== undefined) {
      return {
        message,
        agentMessage: existingAgentMessage,
        runtime: null,
        processing: {
          correlationId: message.id,
          status: "completed",
          errorCode: null,
          retryable: false
        }
      };
    }

    if (this.inventoryTaskController && message.content.type === "text") {
      const handled = await this.inventoryTaskController.handle({
        sessionId: input.sessionId,
        businessId: input.businessId,
        conversationId: conversation.id,
        messageId: message.id,
        text: message.content.text
      });
      if (handled) {
        const agentMessage = this.createConversationMessage({
          sessionId: input.sessionId,
          conversationId: conversation.id,
          clientMessageId: `agent-reply-${message.id}`,
          idempotencyKey: `grogoni-agent-reply:${message.id}`,
          author: "agent",
          replyToMessageId: message.id,
          content: {
            type: "text",
            text: handled.text,
            ...(handled.taskId === null
              ? {}
              : { businessTask: { businessId: input.businessId, taskId: handled.taskId } })
          },
          now
        });
        return {
          message: this.markAgentProcessedMessageDelivered(message, now),
          agentMessage,
          runtime: null,
          processing: {
            correlationId: message.id,
            status: "completed",
            errorCode: null,
            retryable: false
          }
        };
      }
    }

    const conversationHistory = this.runtimeConversationHistory(conversation.id, message.id);
    let runtime: RuntimeTurnResult;
    try {
      runtime = await this.deps.createRuntimeTurn({
        sessionId: input.sessionId,
        businessId: input.businessId,
        conversationId: conversation.id,
        ...(input.runtimeSessionId === undefined
          ? {}
          : { runtimeSessionId: input.runtimeSessionId }),
        message: input.message,
        conversationHistory,
        now
      });
    } catch (error) {
      if (!isRecoverableAgentModelChatError(error)) throw error;

      const agentMessage = this.createConversationMessage({
        sessionId: input.sessionId,
        conversationId: conversation.id,
        clientMessageId: `agent-reply-${message.id}`,
        idempotencyKey: `grogoni-agent-reply:${message.id}`,
        author: "agent",
        content: {
          type: "text",
          text: this.deps.agentModelRecoveryGuidance(input.businessId, error)
        },
        replyToMessageId: message.id,
        clientTimestamp: now.toISOString(),
        now
      });
      return {
        message: this.markAgentProcessedMessageDelivered(message, now),
        agentMessage,
        runtime: null,
        processing: {
          correlationId: message.id,
          status: "completed",
          errorCode: error.code,
          retryable: error.retryable ?? true
        }
      };
    }
    const confirmationToken = runtime.turn.plan.confirmationToken;
    const deliveredAttachments = workspaceAttachmentsFromToolResult(runtime.turn.toolResult);
    let agentMessage: ConversationMessageSummary;
    try {
      agentMessage = this.createConversationMessage({
        sessionId: input.sessionId,
        conversationId: conversation.id,
        clientMessageId: `agent-reply-${message.id}`,
        idempotencyKey: `grogoni-agent-reply:${message.id}`,
        author: "agent",
        content:
          confirmationToken === null
            ? {
                type: "text",
                text: runtime.turn.response,
                ...(deliveredAttachments.length === 0 ? {} : { attachments: deliveredAttachments })
              }
            : {
                type: "confirmation",
                confirmationToken,
                approvalScope: {
                  businessId: input.businessId,
                  runtimeSessionId: runtime.session.id,
                  conversationId: conversation.id
                },
                prompt: runtime.turn.response
              },
        replyToMessageId: message.id,
        clientTimestamp: now.toISOString(),
        now
      });
    } catch (error) {
      await this.discardUnassociatedWorkspaceAttachments(deliveredAttachments);
      throw error;
    }
    const deliveredMessage = this.markAgentProcessedMessageDelivered(message, now);

    return {
      message: deliveredMessage,
      agentMessage,
      runtime,
      processing: {
        correlationId: message.id,
        status: "completed",
        errorCode: null,
        retryable: false
      }
    };
  }

  private markAgentProcessedMessageDelivered(
    message: ConversationMessageSummary,
    now: Date
  ): ConversationMessageSummary {
    if (message.status !== "failed") return message;

    const deliveredMessage: ConversationMessageSummary = {
      ...message,
      status: "delivered",
      failureCode: null,
      nextRetryAt: null
    };
    this.conversationMessages.set(message.id, deliveredMessage);
    this.recordConversationSyncForParticipants(
      message.conversationId,
      "conversation_messages",
      deliveredMessage.id,
      deliveredMessage,
      now
    );
    return deliveredMessage;
  }

  daemonConversationHistory(
    ownerUserId: string,
    conversationId: string,
    clientMessageId: string,
    submittedAt: Date
  ): RuntimeModelConversationMessage[] {
    const owner = this.deps.users.get(ownerUserId);
    if (!owner) throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    const conversation = this.requireAccountConversation(conversationId, owner.accountId);
    if (
      this.conversationType(conversation) !== "DAEMON" ||
      conversation.accountId !== owner.accountId
    )
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    const messages = this.messagesForConversation(conversationId);
    const current = messages.findIndex(
      (message) => message.clientMessageId === clientMessageId && message.author === "user"
    );
    const previous =
      current >= 0
        ? messages.slice(0, current)
        : messages.filter((message) => Date.parse(message.createdAt) < submittedAt.getTime());
    return previous
      .filter((message) => !message.deletedAt && message.content.type === "text")
      .slice(-24)
      .flatMap((message): RuntimeModelConversationMessage[] =>
        message.content.type === "text"
          ? [
              {
                role: message.author === "agent" ? "assistant" : "user",
                content: message.content.text.slice(0, 1000)
              }
            ]
          : []
      );
  }

  private runtimeConversationHistory(
    conversationId: string,
    currentMessageId: string
  ): RuntimeModelConversationMessage[] {
    return this.messagesForConversation(conversationId)
      .filter(
        (message) =>
          message.id !== currentMessageId &&
          message.deletedAt === null &&
          (message.content.type === "text" || message.content.type === "confirmation")
      )
      .slice(-12)
      .flatMap((message): RuntimeModelConversationMessage[] => {
        if (message.content.type === "text") {
          return [
            {
              role: message.author === "agent" ? "assistant" : "user",
              content: message.content.text.slice(0, 1_000)
            }
          ];
        }
        if (message.content.type === "confirmation") {
          return [
            {
              role: message.author === "agent" ? "assistant" : "user",
              content: message.content.prompt.slice(0, 1_000)
            }
          ];
        }
        return [];
      });
  }

  listMessageDeliveryAttempts(input: {
    sessionId: string | null;
    conversationId: string;
    messageId: string;
    now?: Date;
  }): MessageDeliveryAttemptSummary[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    const conversation = this.requireAccountConversation(input.conversationId, session.account.id);
    this.requireConversationMessage(input.messageId, conversation.id);
    return [...this.messageDeliveryAttempts.values()]
      .filter(
        (attempt) =>
          attempt.accountId === session.account.id &&
          attempt.conversationId === conversation.id &&
          attempt.messageId === input.messageId
      )
      .sort(
        (left, right) =>
          left.attemptNumber - right.attemptNumber ||
          left.requestedAt.localeCompare(right.requestedAt)
      );
  }

  async deliverPendingMessageNotifications(
    input: {
      messageId?: string;
      limit?: number;
      now?: Date;
    } = {}
  ): Promise<MessageNotificationDeliveryRunSummary> {
    const now = input.now ?? new Date();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const summary: MessageNotificationDeliveryRunSummary = {
      checked: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0
    };
    const due = [...this.messageNotificationDeliveries.values()]
      .filter(
        (delivery) =>
          (delivery.status === "pending" || delivery.status === "failed") &&
          (input.messageId === undefined || delivery.messageId === input.messageId) &&
          (delivery.nextAttemptAt === null || Date.parse(delivery.nextAttemptAt) <= now.getTime())
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);

    for (const delivery of due) {
      summary.checked += 1;
      const result = await this.attemptMessageNotificationDelivery(delivery, now);
      if (result.status === "sent") summary.sent += 1;
      else if (result.status === "dead_letter") summary.deadLettered += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  /**
   * Best-effort push to every device one account subscribed. Expired subscriptions are dropped,
   * the same as broadcastAppUpdateAvailable; nothing is retried (callers with a durable path, like
   * the in-app connection-request prompt, use this only as a nudge).
   */
  async pushToAccount(
    accountId: string,
    payload: Parameters<NonNullable<MessagingDomainDeps["pushNotificationSender"]>>[1]
  ): Promise<{ targeted: number; sent: number; expired: number; failed: number }> {
    const summary = { targeted: 0, sent: 0, expired: 0, failed: 0 };
    if (this.deps.pushNotificationSender === undefined) return summary;

    for (const subscription of [...this.pushSubscriptions.values()]) {
      if (subscription.accountId !== accountId) continue;
      summary.targeted += 1;
      // One device failing (even by throwing) must not stop the others or their expiry cleanup.
      const outcome = await this.deps
        .pushNotificationSender(subscription, payload)
        .catch(() => "failed" as const);
      if (outcome === "sent") {
        summary.sent += 1;
      } else if (outcome === "expired") {
        summary.expired += 1;
        this.pushSubscriptions.delete(subscription.id);
        this.pushSubscriptionIdByEndpoint.delete(subscription.endpoint);
      } else {
        summary.failed += 1;
      }
    }
    return summary;
  }

  async broadcastAppUpdateAvailable(input: {
    deployId: string;
    service: string;
    title: string;
    body: string;
  }): Promise<AppUpdateBroadcastSummary> {
    const summary: AppUpdateBroadcastSummary = { targeted: 0, sent: 0, expired: 0, failed: 0 };
    if (this.deps.pushNotificationSender === undefined) return summary;

    for (const subscription of [...this.pushSubscriptions.values()]) {
      summary.targeted += 1;
      const outcome = await this.deps.pushNotificationSender(subscription, {
        type: "app.update_available",
        deployId: input.deployId,
        service: input.service,
        title: input.title,
        body: input.body
      });
      if (outcome === "sent") {
        summary.sent += 1;
      } else if (outcome === "expired") {
        summary.expired += 1;
        this.pushSubscriptions.delete(subscription.id);
        this.pushSubscriptionIdByEndpoint.delete(subscription.endpoint);
      } else {
        summary.failed += 1;
      }
    }
    return summary;
  }

  updateConversationSettings(input: {
    sessionId: string | null;
    conversationId: string;
    agentEnabled?: boolean;
    archived?: boolean;
    mutedUntil?: string | null;
    pinned?: boolean;
    read?: boolean;
    title?: string | null;
    now?: Date;
  }): ConversationView {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const conversation = this.requireAccountConversation(input.conversationId, session.account.id);
    if (input.agentEnabled !== undefined) {
      if (
        typeof input.agentEnabled !== "boolean" ||
        conversation.kind === "personal" ||
        !conversation.activeShopId
      )
        throw new Cp2Error(
          400,
          "business_agent_configuration_invalid",
          "Choose a business conversation."
        );
      const membership = this.deps.requireMembership(conversation.activeShopId, session.user.id);
      if (membership.role !== "owner")
        throw new Cp2Error(
          403,
          "business_owner_required",
          "Only the business owner can configure its agent."
        );
      this.conversations.set(conversation.id, {
        ...conversation,
        businessAgentEnabled: input.agentEnabled
      });
    }
    if (conversation.isPermanentDaemon && input.archived === true)
      throw new Cp2Error(
        400,
        "daemon_conversation_permanent",
        "Your daemon remains available in the messenger."
      );
    if (
      conversation.helpTopic &&
      (input.archived === true || input.title !== undefined || input.pinned === false)
    )
      throw new Cp2Error(
        400,
        "help_conversation_permanent",
        "Help chats keep their names and remain available."
      );
    const participant = this.accountConversationParticipant(conversation.id, session.account.id);
    if (participant === null)
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    const nextParticipant: ConversationParticipantSummary = {
      ...participant,
      ...(input.archived !== undefined
        ? { archivedAt: input.archived ? now.toISOString() : null }
        : {}),
      ...(input.mutedUntil !== undefined ? { mutedUntil: input.mutedUntil } : {}),
      ...(input.pinned !== undefined ? { pinnedAt: input.pinned ? now.toISOString() : null } : {}),
      ...(input.read ? { lastReadAt: now.toISOString() } : {})
    };
    this.conversationParticipants.set(participant.id, nextParticipant);
    if (input.title !== undefined) {
      this.conversations.set(conversation.id, {
        ...(this.conversations.get(conversation.id) ?? conversation),
        title: input.title?.trim() || null,
        updatedAt: now.toISOString()
      });
    }
    if (input.read) {
      for (const message of this.messagesForConversation(conversation.id)) {
        if (message.authorId !== session.user.id && !message.readAt) {
          this.conversationMessages.set(message.id, {
            ...message,
            status: "read",
            readAt: now.toISOString()
          });
        }
      }
    }
    if (input.agentEnabled !== undefined || input.title !== undefined)
      this.recordConversationSyncForParticipants(
        conversation.id,
        "conversations",
        conversation.id,
        this.conversations.get(conversation.id) ?? conversation,
        now
      );
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_participants",
      nextParticipant.id,
      nextParticipant,
      now
    );
    return this.conversationView(this.conversations.get(conversation.id) ?? conversation);
  }

  /**
   * Moves a conversation to the recycle bin instead of deleting it outright. Requires admin
   * privileges (the shop's owner for a shop-scoped conversation, or - for a personal conversation
   * with no shop - an account that either owns no business yet or owns at least one) and refuses
   * once the owning scope's recycle bin is at capacity, so a flood of deletions can't grow without
   * bound. A background sweep (`purgeExpiredRecycleBinConversations`) hard-deletes anything still
   * here after `RECYCLE_BIN_RETENTION_MS`; an admin can also restore or empty it early.
   */
  deleteConversation(input: {
    sessionId: string | null;
    conversationId: string;
    now?: Date;
  }): ConversationSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const conversation = this.requireAccountConversation(input.conversationId, session.account.id);
    if (conversation.isPermanentDaemon)
      throw new Cp2Error(
        400,
        "daemon_conversation_permanent",
        "Your daemon conversation cannot be deleted."
      );
    if (conversation.helpTopic)
      throw new Cp2Error(
        400,
        "help_conversation_permanent",
        "Help chats remain available and cannot be deleted."
      );
    this.requireConversationAdmin(conversation, session);

    const { scope, scopeId } = this.recycleBinScopeKey(conversation);
    const projectedSize = this.conversationByteSize(conversation.id);
    const usedBytes = this.recycleBinUsageBytes(scope, scopeId);
    if (usedBytes + projectedSize > RECYCLE_BIN_CAPACITY_BYTES) {
      throw new Cp2Error(
        507,
        "recycle_bin_full",
        "The recycle bin is full. Ask an admin to empty it before deleting more chats."
      );
    }

    const deleted: ConversationSummary = {
      ...conversation,
      deletedAt: now.toISOString(),
      deletedByUserId: session.user.id,
      updatedAt: now.toISOString()
    };
    this.conversations.set(conversation.id, deleted);
    this.deps.recordAuditEvent({
      type: "conversation.deleted",
      aggregateType: "conversation",
      aggregateId: conversation.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { activeShopId: conversation.activeShopId, kind: conversation.kind }
    });
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversations",
      conversation.id,
      deleted,
      now
    );
    return deleted;
  }

  /** Admin-only: pulls a conversation back out of the recycle bin before its retention expires. */
  restoreConversationFromRecycleBin(input: {
    sessionId: string | null;
    conversationId: string;
    now?: Date;
  }): ConversationSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const conversation = this.conversations.get(input.conversationId);
    if (
      conversation === undefined ||
      conversation.deletedAt == null ||
      this.accountConversationParticipant(conversation.id, session.account.id) === null
    ) {
      throw new Cp2Error(404, "conversation_not_found", "This chat isn't in the recycle bin.");
    }
    this.requireConversationAdmin(conversation, session);

    const restored: ConversationSummary = {
      ...conversation,
      deletedAt: null,
      deletedByUserId: null,
      updatedAt: now.toISOString()
    };
    this.conversations.set(conversation.id, restored);
    this.deps.recordAuditEvent({
      type: "conversation.restored",
      aggregateType: "conversation",
      aggregateId: conversation.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { activeShopId: conversation.activeShopId }
    });
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversations",
      conversation.id,
      restored,
      now
    );
    return restored;
  }

  /**
   * Admin-only view of one scope's recycle bin (a shop's shared chats, or an account's own
   * personal chats). Reports usage against `RECYCLE_BIN_CAPACITY_BYTES` so the UI can tell a
   * non-admin exactly when to ask an admin to empty it.
   */
  listRecycleBin(input: {
    sessionId: string | null;
    businessId?: string | null;
    now?: Date;
  }): RecycleBinStatusSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const scope: "business" | "account" = input.businessId ? "business" : "account";
    const scopeId = input.businessId ?? session.account.id;
    this.requireRecycleBinAdmin(scope, scopeId, session);

    const items: RecycleBinItemSummary[] = this.trashedConversationsForScope(scope, scopeId)
      .sort((left, right) => Date.parse(right.deletedAt ?? "") - Date.parse(left.deletedAt ?? ""))
      .map((conversation) => ({
        conversation,
        title: conversation.title ?? null,
        deletedAt: conversation.deletedAt as string,
        deletedByUserId: conversation.deletedByUserId as string,
        purgeAt: new Date(
          Date.parse(conversation.deletedAt as string) + RECYCLE_BIN_RETENTION_MS
        ).toISOString(),
        sizeBytes: this.conversationByteSize(conversation.id)
      }));
    const usedBytes = items.reduce((total, item) => total + item.sizeBytes, 0);

    return {
      scope,
      scopeId,
      items,
      usedBytes,
      capacityBytes: RECYCLE_BIN_CAPACITY_BYTES,
      isFull: usedBytes >= RECYCLE_BIN_CAPACITY_BYTES
    };
  }

  /**
   * Admin-only: permanently purges some or all of a scope's recycle bin ahead of the 14-day
   * retention window - the escape hatch a non-admin is told to ask for once the bin is full.
   */
  emptyRecycleBin(input: {
    sessionId: string | null;
    businessId?: string | null;
    conversationIds?: string[];
    now?: Date;
  }): { purged: number } {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const scope: "business" | "account" = input.businessId ? "business" : "account";
    const scopeId = input.businessId ?? session.account.id;
    this.requireRecycleBinAdmin(scope, scopeId, session);

    const candidates = this.trashedConversationsForScope(scope, scopeId).filter(
      (conversation) =>
        input.conversationIds === undefined || input.conversationIds.includes(conversation.id)
    );
    for (const conversation of candidates) {
      this.deps.recordAuditEvent({
        type: "conversation.purged",
        aggregateType: "conversation",
        aggregateId: conversation.id,
        actorId: session.user.id,
        occurredAt: now.toISOString(),
        payload: { activeShopId: conversation.activeShopId, reason: "admin_emptied_recycle_bin" }
      });
      this.hardDeleteConversation(conversation.id, now);
    }
    return { purged: candidates.length };
  }

  /** Background-sweep entry point: hard-deletes anything past its 14-day recycle-bin retention. */
  purgeExpiredRecycleBinConversations(now = new Date()): number {
    let purged = 0;
    for (const conversation of [...this.conversations.values()]) {
      if (conversation.deletedAt == null) continue;
      if (Date.parse(conversation.deletedAt) + RECYCLE_BIN_RETENTION_MS > now.getTime()) continue;
      this.deps.recordAuditEvent({
        type: "conversation.purged",
        aggregateType: "conversation",
        aggregateId: conversation.id,
        actorId: conversation.deletedByUserId ?? "system",
        occurredAt: now.toISOString(),
        payload: {
          activeShopId: conversation.activeShopId,
          reason: "recycle_bin_retention_expired"
        }
      });
      this.hardDeleteConversation(conversation.id, now);
      purged += 1;
    }
    return purged;
  }

  private recycleBinScopeKey(conversation: ConversationSummary): {
    scope: "business" | "account";
    scopeId: string;
  } {
    return conversation.activeShopId !== null
      ? { scope: "business", scopeId: conversation.activeShopId }
      : { scope: "account", scopeId: conversation.accountId };
  }

  private trashedConversationsForScope(
    scope: "business" | "account",
    scopeId: string
  ): ConversationSummary[] {
    return [...this.conversations.values()].filter((conversation) => {
      if (conversation.deletedAt == null) return false;
      const key = this.recycleBinScopeKey(conversation);
      return key.scope === scope && key.scopeId === scopeId;
    });
  }

  private recycleBinUsageBytes(scope: "business" | "account", scopeId: string): number {
    return this.trashedConversationsForScope(scope, scopeId).reduce(
      (total, conversation) => total + this.conversationByteSize(conversation.id),
      0
    );
  }

  private conversationByteSize(conversationId: string): number {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) return 0;
    const messages = this.messagesForConversation(conversationId);
    const participants = [...this.conversationParticipants.values()].filter(
      (participant) => participant.conversationId === conversationId
    );
    return Buffer.byteLength(JSON.stringify({ conversation, messages, participants }), "utf8");
  }

  /**
   * "Admin" for conversation deletion mirrors the codebase's existing highest-privilege gate
   * (`requireOwnerMembership`, used for shop deletion): the shop's owner for a shop-scoped
   * conversation. A personal conversation has no shop to check, so an account that hasn't created
   * a business yet is trivially its own admin; one that has must own at least one business, so a
   * non-owner staff account can't purge its own chat history unilaterally.
   */
  private requireConversationAdmin(
    conversation: ConversationSummary,
    session: AuthSessionView
  ): void {
    const { scope, scopeId } = this.recycleBinScopeKey(conversation);
    this.requireRecycleBinAdmin(scope, scopeId, session);
  }

  private requireRecycleBinAdmin(
    scope: "business" | "account",
    scopeId: string,
    session: AuthSessionView
  ): void {
    if (scope === "business") {
      const membership = this.deps.requireMembership(scopeId, session.user.id);
      if (membership.role !== "owner") {
        throw new Cp2Error(
          403,
          "conversation_delete_requires_admin",
          "Only a shop owner has admin access to this recycle bin."
        );
      }
      return;
    }
    if (scopeId !== session.account.id) {
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    }
    const memberships = [...this.deps.memberships.values()].filter(
      (membership) => membership.userId === session.user.id
    );
    const ownsAnyBusiness = memberships.some((membership) => membership.role === "owner");
    if (memberships.length > 0 && !ownsAnyBusiness) {
      throw new Cp2Error(
        403,
        "conversation_delete_requires_admin",
        "Only a shop owner has admin access to deleted chats. Ask an admin."
      );
    }
  }

  /** Hard-deletes a conversation and every row that hangs off it. Not reversible. */
  private hardDeleteConversation(conversationId: string, now: Date): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) return;

    const participantAccountIds = new Set(
      [...this.conversationParticipants.values()]
        .filter(
          (participant) =>
            participant.conversationId === conversationId && participant.accountId !== null
        )
        .map((participant) => participant.accountId as string)
    );

    for (const [id, participant] of this.conversationParticipants) {
      if (participant.conversationId === conversationId) this.conversationParticipants.delete(id);
    }
    for (const [id, message] of this.conversationMessages) {
      if (message.conversationId !== conversationId) continue;
      this.conversationMessages.delete(id);
      this.messageByClientId.delete(`${conversationId}:${message.clientMessageId}`);
      this.messageByIdempotencyKey.delete(`${conversationId}:${message.idempotencyKey}`);
    }
    for (const [id, attempt] of this.messageDeliveryAttempts) {
      if (attempt.conversationId === conversationId) this.messageDeliveryAttempts.delete(id);
    }
    for (const [id, delivery] of this.messageNotificationDeliveries) {
      if (delivery.conversationId === conversationId) this.messageNotificationDeliveries.delete(id);
    }
    for (const [id, channel] of this.conversationChannels) {
      if (channel.conversationId === conversationId) this.conversationChannels.delete(id);
    }
    for (const [key, typing] of this.conversationTyping) {
      if (typing.conversationId === conversationId) this.conversationTyping.delete(key);
    }
    this.deleteConversationAttachmentsWhere(
      (attachment) => attachment.conversationId === conversationId
    );
    this.conversations.delete(conversationId);

    for (const accountId of participantAccountIds) {
      this.deps.recordSyncChange({
        accountId,
        collection: "conversations",
        entityId: conversationId,
        operation: "delete",
        shopId: conversation.activeShopId,
        entity: null,
        now
      });
    }
  }

  updateConversationMessage(input: {
    sessionId: string | null;
    conversationId: string;
    messageId: string;
    text?: string;
    content?: ConversationMessageContent;
    deleted?: boolean;
    reaction?: string | null;
    now?: Date;
  }): ConversationMessageSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    this.requireAccountConversation(input.conversationId, session.account.id);
    const current = this.requireConversationMessage(input.messageId, input.conversationId);
    let next = current;
    if (input.content !== undefined) {
      if (current.authorId !== session.user.id || current.deletedAt) {
        throw new Cp2Error(
          403,
          "message_edit_forbidden",
          "Only your active messages can be edited."
        );
      }
      validateConversationMessageContent(input.content);
      this.validateConversationEncryption(input.conversationId, input.content);
      next = { ...next, content: input.content, editedAt: now.toISOString() };
    }
    if (input.text !== undefined) {
      if (current.authorId !== session.user.id || current.deletedAt)
        throw new Cp2Error(
          403,
          "message_edit_forbidden",
          "Only your active messages can be edited."
        );
      if (current.content.type !== "text")
        throw new Cp2Error(400, "message_edit_invalid", "Only text messages can be edited.");
      const content = { ...current.content, text: input.text };
      validateConversationMessageContent(content);
      next = { ...next, content, editedAt: now.toISOString() };
    }
    if (input.deleted) {
      if (current.authorId !== session.user.id)
        throw new Cp2Error(403, "message_delete_forbidden", "Only your messages can be deleted.");
      next = {
        ...next,
        deletedAt: now.toISOString()
      };
    }
    if (input.reaction !== undefined) {
      const emoji = input.reaction?.trim() ?? "";
      if (emoji.length > 16) throw new Cp2Error(400, "reaction_invalid", "Reaction is too long.");
      const reactions = (next.reactions ?? []).filter(
        (reaction) => reaction.actorId !== session.user.id
      );
      if (emoji) reactions.push({ emoji, actorId: session.user.id, createdAt: now.toISOString() });
      next = { ...next, reactions };
    }
    this.conversationMessages.set(next.id, next);
    this.recordConversationSyncForParticipants(
      input.conversationId,
      "conversation_messages",
      next.id,
      next,
      now
    );
    this.deps.recordAuditEvent({
      type: input.deleted
        ? "message.deleted"
        : input.text !== undefined
          ? "message.edited"
          : "message.reacted",
      aggregateType: "conversation_message",
      aggregateId: next.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { conversationId: input.conversationId }
    });
    return next;
  }

  setConversationTyping(input: {
    sessionId: string | null;
    conversationId: string;
    typing: boolean;
    now?: Date;
  }): ConversationTypingSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    this.requireAccountConversation(input.conversationId, session.account.id);
    const key = `${input.conversationId}:${session.user.id}`;
    if (input.typing) {
      this.conversationTyping.set(key, {
        conversationId: input.conversationId,
        actorId: session.user.id,
        displayName: session.user.displayName,
        expiresAt: new Date(now.getTime() + 8_000).toISOString()
      });
    } else this.conversationTyping.delete(key);
    this.recordConversationSyncForParticipants(
      input.conversationId,
      "conversation_typing",
      session.user.id,
      { typing: input.typing },
      now
    );
    return this.typingForConversation(input.conversationId, now, session.user.id);
  }

  createPublicStorefrontSession(input: {
    agentId: string;
    visitorId: string;
    displayName?: string | null;
    now?: Date;
  }): PublicStorefrontSessionResult {
    const now = input.now ?? new Date();
    const business = requirePublicStorefrontBusiness(
      this.deps.businesses,
      this.deps.quarantinedBusinessIds,
      input.agentId
    );
    const externalUserId = normalizeRequiredBoundedText(input.visitorId, "visitorId", 100);
    let identity = [...this.platformIdentities.values()].find(
      (candidate) =>
        candidate.provider === "grogoni" &&
        candidate.businessId === business.id &&
        candidate.externalUserId === externalUserId
    );
    if (identity === undefined) {
      const customer = this.deps.createGuestCustomer({
        businessId: business.id,
        displayName: input.displayName ?? null,
        provider: "grogoni",
        externalUserId,
        now
      });
      identity = {
        id: randomUUID(),
        provider: "grogoni",
        externalUserId,
        accountId: null,
        customerId: customer.id,
        verifiedAt: now.toISOString(),
        optInStatus: "granted",
        optInSource: "public_storefront_session",
        optInAt: now.toISOString(),
        optOutAt: null,
        businessId: business.id,
        displayName: normalizeOptionalBoundedText(input.displayName ?? null, 120),
        metadata: {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.platformIdentities.set(identity.id, identity);
    } else if (identity.customerId === null) {
      const customer = this.deps.createGuestCustomer({
        businessId: business.id,
        displayName: input.displayName ?? identity.displayName,
        provider: "grogoni",
        externalUserId,
        now
      });
      identity = { ...identity, customerId: customer.id, updatedAt: now.toISOString() };
      this.platformIdentities.set(identity.id, identity);
    }

    let channel = [...this.conversationChannels.values()].find(
      (candidate) =>
        candidate.provider === "grogoni" &&
        candidate.businessId === business.id &&
        candidate.externalConversationId === externalUserId
    );
    if (channel === undefined) {
      const ownerMembership = [...this.deps.memberships.values()].find(
        (membership) => membership.businessId === business.id && membership.role === "owner"
      );
      const ownerUser = ownerMembership ? this.deps.users.get(ownerMembership.userId) : undefined;
      if (ownerUser === undefined) {
        throw new Cp2Error(409, "storefront_owner_missing", "Storefront owner is unavailable.");
      }
      const conversation = this.createAccountConversation({
        accountId: ownerUser.accountId,
        userId: ownerUser.id,
        kind: "storefront",
        activeShopId: business.id,
        title: `${business.name} storefront customer`,
        now
      });
      const participant: ConversationParticipantSummary = {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "external",
        accountId: null,
        businessId: business.id,
        agentId: null,
        externalIdentityId: identity.id,
        displayName: identity.displayName,
        lastReadAt: null,
        archivedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        createdAt: now.toISOString()
      };
      this.conversationParticipants.set(participant.id, participant);
      channel = {
        id: randomUUID(),
        conversationId: conversation.id,
        businessId: business.id,
        provider: "grogoni",
        externalConversationId: externalUserId,
        platformIdentityId: identity.id,
        capabilities: ["CAN_RECEIVE", "CAN_REPLY", "CAN_INITIATE", "SUPPORTS_PRODUCT_CARD"],
        status: "available",
        lastInboundAt: null,
        lastOutboundAt: null,
        metadata: {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.conversationChannels.set(channel.id, channel);
    }

    for (const capability of this.customerRuntimeCapabilities.values()) {
      if (capability.conversationId === channel.conversationId && capability.revokedAt === null) {
        this.customerRuntimeCapabilities.set(capability.id, {
          ...capability,
          revokedAt: now.toISOString()
        });
      }
    }
    const capabilityToken = randomBytes(32).toString("base64url");
    const capability: CustomerRuntimeCapabilityRecord = {
      id: randomUUID(),
      businessId: business.id,
      conversationId: channel.conversationId,
      platformIdentityId: identity.id,
      tokenHash: hashCustomerCapability(capabilityToken),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      createdAt: now.toISOString()
    };
    this.customerRuntimeCapabilities.set(capability.id, capability);
    return {
      conversationId: channel.conversationId,
      capabilityToken,
      expiresAt: capability.expiresAt
    };
  }

  async createPublicStorefrontMessage(input: {
    agentId: string;
    capabilityToken: string;
    body: string;
    attachmentNames: string[];
    now?: Date;
  }): Promise<
    PublicStorefrontMessageSummary & { agentReply: PublicStorefrontMessageSummary | null }
  > {
    const now = input.now ?? new Date();
    const business = requirePublicStorefrontBusiness(
      this.deps.businesses,
      this.deps.quarantinedBusinessIds,
      input.agentId
    );
    const principal = this.requireCustomerCapability(input.capabilityToken, business.id, now);
    const identity = this.platformIdentities.get(principal.platformIdentityId);
    if (identity === undefined) {
      throw new Cp2Error(401, "customer_capability_invalid", "Customer session is invalid.");
    }
    if (input.attachmentNames.length > 10) {
      throw new Cp2Error(400, "attachments_limit", "A message can include up to 10 attachments.");
    }
    const body = normalizeRequiredBoundedText(input.body, "message", 4000);
    const attachmentNames = input.attachmentNames.map((name) =>
      normalizeRequiredBoundedText(name, "attachment name", 255)
    );
    const canonical = this.persistExternalConversationMessage({
      conversationId: principal.conversationId,
      provider: "grogoni",
      author: "user",
      authorId: identity.id,
      body,
      attachmentNames,
      idempotencyKey: `grogoni-storefront:${principal.id}:${randomUUID()}`,
      now
    });
    const message = this.publicMessageView(canonical, business.id, identity.externalUserId);
    const agentReply = await this.deps.attemptPublicAgentReply({
      businessId: business.id,
      capability: principal,
      visitorId: identity.externalUserId,
      body: message.body,
      now
    });
    return { ...message, agentReply };
  }

  /**
   * Answers an anonymous storefront visitor's message using the same context-retrieval and
   * model-routing machinery as the authenticated owner/staff runtime turn, scoped to
   * audience "customer" (only sources marked customerVisible are ever retrieved) and with no
   * tools available: an anonymous, non-member caller can never trigger a privileged action, so
   * the model is never even told a tool exists to propose. If the model nonetheless returns a
   * tool proposal, it is discarded — never executed, never surfaced to the customer as if it were
   * a completed action.
   *
   * Every failure mode here (agent not ready, rate limited, no model provider, malformed model
   * output) resolves to `null` rather than throwing: the customer's own message must always be
   * accepted, whether or not an automatic reply could be produced.
   */
  requireCustomerCapability(
    token: string,
    businessId: string,
    now: Date
  ): CustomerRuntimeCapabilityRecord {
    const tokenHash = hashCustomerCapability(
      normalizeRequiredBoundedText(token, "capabilityToken", 200)
    );
    const capability = [...this.customerRuntimeCapabilities.values()].find(
      (candidate) => candidate.tokenHash === tokenHash
    );
    if (
      capability === undefined ||
      capability.businessId !== businessId ||
      capability.revokedAt !== null ||
      Date.parse(capability.expiresAt) <= now.getTime()
    ) {
      throw new Cp2Error(401, "customer_capability_invalid", "Customer session is invalid.");
    }
    return capability;
  }

  persistExternalConversationMessage(input: {
    conversationId: string;
    provider: ChannelProvider;
    author: "user" | "agent";
    authorId: string;
    body: string;
    attachmentNames: string[];
    idempotencyKey: string;
    providerMessageId?: string | null;
    channelIdentityId?: string | null;
    externalConversationId?: string | null;
    subject?: string | null;
    externalThreadId?: string | null;
    senderAddress?: string | null;
    recipientAddresses?: string[];
    ccAddresses?: string[];
    bccAddresses?: string[];
    now: Date;
  }): ConversationMessageSummary {
    const conversation = this.conversations.get(input.conversationId);
    if (conversation === undefined) {
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    }
    const existingId = this.messageByIdempotencyKey.get(
      `${conversation.id}:${input.idempotencyKey}`
    );
    if (existingId !== undefined) {
      return this.conversationMessages.get(existingId) as ConversationMessageSummary;
    }
    const attachments = input.attachmentNames.map((name) => ({
      id: randomUUID(),
      name,
      mimeType: "application/octet-stream",
      size: 0,
      category: "other" as const,
      url: `https://grogoni.com/attachment-reference/${encodeURIComponent(name)}`
    }));
    const content: ConversationMessageContent = {
      type: "text",
      text: input.body,
      ...(attachments.length === 0 ? {} : { attachments })
    };
    validateConversationMessageContent(content);
    const message: ConversationMessageSummary = {
      id: randomUUID(),
      conversationId: conversation.id,
      clientMessageId: `${input.provider}-${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      author: input.author,
      authorId: input.authorId,
      content,
      status: "delivered",
      queuedAt: null,
      sentAt: input.now.toISOString(),
      deliveredAt: input.now.toISOString(),
      readAt: null,
      failureCode: null,
      retryCount: 0,
      nextRetryAt: null,
      selectedChannel: providerToMessageChannel(input.provider),
      actualChannel: providerToMessageChannel(input.provider),
      providerMessageId: input.providerMessageId ?? null,
      subject: input.subject ?? null,
      externalThreadId: input.externalThreadId ?? null,
      senderAddress: input.senderAddress ?? null,
      recipientAddresses: [...(input.recipientAddresses ?? [])],
      ccAddresses: [...(input.ccAddresses ?? [])],
      bccAddresses: [...(input.bccAddresses ?? [])],
      provider: input.provider,
      direction: input.author === "user" ? "inbound" : "outbound",
      externalConversationId: input.externalConversationId ?? null,
      channelIdentityId: input.channelIdentityId ?? null,
      importedSource: input.provider,
      importedExternalId: input.providerMessageId ?? null,
      consentRecordId: null,
      editedAt: null,
      deletedAt: null,
      replyToMessageId: null,
      forwardedFromMessageId: null,
      reactions: [],
      clientTimestamp: null,
      createdAt: input.now.toISOString()
    };
    this.conversationMessages.set(message.id, message);
    this.messageByClientId.set(`${conversation.id}:${message.clientMessageId}`, message.id);
    this.messageByIdempotencyKey.set(`${conversation.id}:${message.idempotencyKey}`, message.id);
    this.conversations.set(conversation.id, {
      ...conversation,
      updatedAt: input.now.toISOString()
    });
    const attempt: MessageDeliveryAttemptSummary = {
      id: randomUUID(),
      accountId: conversation.accountId,
      conversationId: conversation.id,
      messageId: message.id,
      channel: providerToMessageChannel(input.provider),
      provider: input.provider,
      attemptNumber: 1,
      requestedAt: input.now.toISOString(),
      respondedAt: input.now.toISOString(),
      result: "succeeded",
      normalizedFailureCode: null,
      providerResponseReference: input.providerMessageId ?? null
    };
    this.messageDeliveryAttempts.set(attempt.id, attempt);
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_messages",
      message.id,
      message,
      input.now
    );
    if (input.author === "user") {
      this.enqueueConversationNotifications(conversation, message, "external", input.now);
    }
    return message;
  }

  persistExternalProductCard(input: {
    conversationId: string;
    provider: "grogoni" | "telegram";
    product: CatalogueQueryResult["products"][number];
    runtimeTurnId: string;
    now: Date;
  }): ConversationMessageSummary {
    const conversation = this.conversations.get(input.conversationId);
    if (conversation === undefined) {
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    }
    const idempotencyKey = `product-card:${input.runtimeTurnId}:${input.product.productId}`;
    const existingId = this.messageByIdempotencyKey.get(`${conversation.id}:${idempotencyKey}`);
    if (existingId !== undefined) {
      return this.conversationMessages.get(existingId) as ConversationMessageSummary;
    }
    const message: ConversationMessageSummary = {
      id: randomUUID(),
      conversationId: conversation.id,
      clientMessageId: `${input.provider}-product-${randomUUID()}`,
      idempotencyKey,
      author: "agent",
      authorId: `shop-${input.product.businessId}-agent`,
      content: { type: "product-card", product: input.product },
      status: "delivered",
      queuedAt: null,
      sentAt: input.now.toISOString(),
      deliveredAt: input.now.toISOString(),
      readAt: null,
      failureCode: null,
      retryCount: 0,
      nextRetryAt: null,
      selectedChannel: input.provider,
      actualChannel: input.provider,
      providerMessageId: null,
      importedSource: input.provider,
      importedExternalId: null,
      consentRecordId: null,
      editedAt: null,
      deletedAt: null,
      replyToMessageId: null,
      forwardedFromMessageId: null,
      reactions: [],
      clientTimestamp: null,
      createdAt: input.now.toISOString()
    };
    validateConversationMessageContent(message.content);
    this.conversationMessages.set(message.id, message);
    this.messageByClientId.set(`${conversation.id}:${message.clientMessageId}`, message.id);
    this.messageByIdempotencyKey.set(`${conversation.id}:${idempotencyKey}`, message.id);
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_messages",
      message.id,
      message,
      input.now
    );
    return message;
  }

  publicMessageView(
    message: ConversationMessageSummary,
    businessId: string,
    visitorId: string
  ): PublicStorefrontMessageSummary {
    const content =
      message.content.type === "text" ? message.content : { text: "", attachments: [] };
    return {
      id: message.id,
      conversationId: message.conversationId,
      businessId,
      visitorId,
      author: message.author === "agent" ? "agent" : "customer",
      body: content.text,
      attachmentNames: content.attachments?.map((attachment) => attachment.name) ?? [],
      createdAt: message.createdAt
    };
  }

  listPublicStorefrontMessages(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): PublicStorefrontMessageSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:read",
      input.now
    );
    const channels = [...this.conversationChannels.values()].filter(
      (channel) => channel.businessId === input.businessId
    );
    const channelByConversation = new Map(
      channels.map((channel) => [channel.conversationId, channel])
    );
    return [...this.conversationMessages.values()]
      .filter(
        (message) =>
          channelByConversation.has(message.conversationId) && message.content.type === "text"
      )
      .map((message) => {
        const channel = channelByConversation.get(
          message.conversationId
        ) as ConversationChannelSummary;
        const identity = this.platformIdentities.get(channel.platformIdentityId);
        return this.publicMessageView(
          message,
          input.businessId,
          identity?.externalUserId ?? "external"
        );
      });
  }

  private createAccountConversation(input: {
    identityKey?: string;
    accountId: string;
    userId: string;
    kind: ConversationKind;
    activeShopId: string | null;
    recipientAccountId?: string | null;
    title?: string | null;
    runtimeBindingId?: string | null;
    helpTopic?: string;
    helpParentConversationId?: string;
    taskConversationId?: string;
    taskParentConversationId?: string;
    now: Date;
  }): ConversationSummary {
    const conversation: ConversationSummary = {
      id:
        input.taskConversationId ??
        (input.identityKey ? stableConversationId(input.identityKey) : randomUUID()),
      ...(input.helpTopic ? { helpTopic: input.helpTopic } : {}),
      ...(input.helpParentConversationId
        ? { helpParentConversationId: input.helpParentConversationId }
        : {}),
      ...(input.taskParentConversationId === undefined
        ? {}
        : { taskParentConversationId: input.taskParentConversationId }),
      accountId: input.accountId,
      kind: input.kind,
      activeShopId: input.activeShopId,
      runtimeBindingId: input.recipientAccountId
        ? null
        : this.deps.assignRuntimeBinding({
            accountId: input.accountId,
            activeShopId: input.activeShopId,
            ...(input.runtimeBindingId === undefined
              ? {}
              : { requestedBindingId: input.runtimeBindingId })
          }),
      title: input.title ?? null,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    if (this.conversations.has(conversation.id))
      throw new Cp2Error(
        409,
        "conversation_identity_conflict",
        "Restore the existing conversation before reopening it."
      );
    this.conversations.set(conversation.id, conversation);
    const participants: ConversationParticipantSummary[] = [
      {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "account",
        accountId: input.accountId,
        businessId: null,
        agentId: null,
        displayName: this.deps.users.get(input.userId)?.displayName ?? null,
        lastReadAt: input.now.toISOString(),
        archivedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        createdAt: input.now.toISOString()
      },
      {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "agent",
        accountId: null,
        businessId: null,
        agentId: `account-${input.accountId}-agent`,
        displayName: "Grogoni agent",
        createdAt: input.now.toISOString()
      }
    ];

    if (input.recipientAccountId) {
      const recipientUserId = this.deps.userByAccount.get(input.recipientAccountId);
      participants.push({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "account",
        accountId: input.recipientAccountId,
        businessId: null,
        agentId: null,
        displayName: recipientUserId
          ? (this.deps.users.get(recipientUserId)?.displayName ?? null)
          : null,
        lastReadAt: null,
        archivedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        createdAt: input.now.toISOString()
      });
    }

    if (input.activeShopId !== null) {
      participants.push({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "shop",
        accountId: null,
        businessId: input.activeShopId,
        agentId: null,
        createdAt: input.now.toISOString()
      });
    }

    for (const participant of participants) {
      if (input.recipientAccountId && participant.role === "agent") continue;
      this.conversationParticipants.set(participant.id, participant);
    }

    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversations",
      conversation.id,
      conversation,
      input.now
    );

    return conversation;
  }

  ensurePersonalAccountConversation(input: {
    accountId: string;
    userId: string;
    now: Date;
  }): ConversationSummary {
    const candidates = [...this.conversations.values()].filter(
      (conversation) =>
        conversation.accountId === input.accountId &&
        conversation.kind === "personal" &&
        this.humanConversationAccountIds(conversation.id).length === 1 &&
        !conversation.taskParentConversationId &&
        !conversation.helpTopic &&
        conversation.activeShopId === null &&
        conversation.deletedAt == null &&
        this.accountConversationParticipant(conversation.id, input.accountId) !== null
    );

    const existing =
      candidates.find((conversation) => conversation.isPermanentDaemon) ?? candidates[0];
    const conversation =
      existing ??
      this.createAccountConversation({
        ...input,
        kind: "personal",
        activeShopId: null,
        identityKey: `daemon:${input.accountId}`,
        title: "Your daemon"
      });
    if (conversation.isPermanentDaemon) return conversation;
    const permanent = { ...conversation, isPermanentDaemon: true };
    this.conversations.set(permanent.id, permanent);
    return permanent;
  }

  private validateManagedConversationAttachments(
    content: ConversationMessageContent,
    conversation: ConversationSummary,
    accountId: string
  ): void {
    if (content.type !== "text") return;
    for (const attachment of content.attachments ?? []) {
      if (attachment.source !== "managed") continue;
      const record = this.conversationAttachments.get(attachment.id);
      const expected = record === undefined ? null : managedAttachmentFromRecord(record);
      if (
        record === undefined ||
        expected === null ||
        record.accountId !== accountId ||
        record.conversationId !== conversation.id ||
        record.messageId !== null ||
        attachment.name !== record.filename ||
        attachment.mimeType !== record.mimeType ||
        attachment.size !== record.size ||
        attachment.category !== expected.category ||
        attachment.kind !== record.kind ||
        attachment.previewable !== record.previewable ||
        attachment.caption !== expected.caption
      ) {
        throw new Cp2Error(
          400,
          "ATTACHMENT_INVALID",
          "The managed conversation attachment is invalid."
        );
      }
    }
  }

  private associateManagedConversationAttachments(message: ConversationMessageSummary): void {
    if (message.content.type !== "text") return;
    for (const attachment of message.content.attachments ?? []) {
      if (attachment.source !== "managed") continue;
      const record = this.conversationAttachments.get(attachment.id);
      if (record !== undefined) {
        this.conversationAttachments.set(record.id, { ...record, messageId: message.id });
        this.deps.recordAuditEvent({
          type: "workspace.file_associated",
          aggregateType: "conversation_attachment",
          aggregateId: record.id,
          actorId: record.userId,
          occurredAt: message.createdAt,
          payload: {
            businessId: record.businessId,
            conversationId: record.conversationId,
            messageId: message.id,
            toolCallId: record.toolCallId
          }
        });
      }
    }
  }

  private async discardUnassociatedWorkspaceAttachments(
    attachments: WorkspaceDeliverResult["attachments"]
  ): Promise<void> {
    for (const attachment of attachments) {
      const record = this.conversationAttachments.get(attachment.id);
      if (record?.messageId === null) {
        this.conversationAttachments.delete(record.id);
        await this.deps.conversationAttachmentBlobStore
          .delete(record.storageKey)
          .catch(() => undefined);
      }
    }
  }

  private deleteConversationAttachmentsWhere(
    predicate: (attachment: ConversationAttachmentRecord) => boolean
  ): number {
    let deleted = 0;
    for (const [id, attachment] of this.conversationAttachments.entries()) {
      if (!predicate(attachment)) continue;
      this.conversationAttachments.delete(id);
      void this.deps.conversationAttachmentBlobStore
        .delete(attachment.storageKey)
        .catch(() => undefined);
      deleted += 1;
    }
    return deleted;
  }

  private recordWorkspaceDeliveryFailure(
    input: {
      businessId: string;
      conversationId: string;
      toolCallId: string;
      requestedPaths: string[];
    },
    actorId: string,
    errorCode: string,
    now: Date
  ): void {
    this.deps.recordAuditEvent({
      type: "workspace.file_delivery_failed",
      aggregateType: "conversation",
      aggregateId: input.conversationId,
      actorId,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        toolCallId: input.toolCallId,
        fileCount: input.requestedPaths.length,
        errorCode
      }
    });
  }

  requireAccountConversation(conversationId: string, accountId: string): ConversationSummary {
    const conversation = this.conversations.get(conversationId);

    if (
      conversation === undefined ||
      conversation.deletedAt != null ||
      this.accountConversationParticipant(conversationId, accountId) === null
    ) {
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    }

    return conversation;
  }

  private conversationType(conversation: ConversationSummary): "DIRECT" | "DAEMON" | "BUSINESS" {
    if (conversation.kind !== "personal") return "BUSINESS";
    return this.humanConversationAccountIds(conversation.id).length > 1 ? "DIRECT" : "DAEMON";
  }

  private conversationView(conversation: ConversationSummary): ConversationView {
    const now = new Date();
    const channels = [...this.conversationChannels.values()]
      .filter((channel) => channel.conversationId === conversation.id)
      .flatMap((channel) => {
        const identity = this.platformIdentities.get(channel.platformIdentityId);
        return identity === undefined ? [] : [this.deps.channelGateway.endpoint(channel, identity)];
      });
    return {
      conversation: { ...conversation, conversationType: this.conversationType(conversation) },
      participants: [...this.conversationParticipants.values()]
        .filter((participant) => participant.conversationId === conversation.id)
        .map((participant) => this.participantView(participant)),
      messages: this.messagesForConversation(conversation.id),
      channels,
      typing: this.typingForConversation(conversation.id, now)
    };
  }

  private participantView(
    participant: ConversationParticipantSummary
  ): ConversationParticipantSummary {
    if (participant.role !== "account" || participant.accountId === null) return participant;
    const userId = this.deps.userByAccount.get(participant.accountId);
    return {
      ...participant,
      displayName: userId
        ? (this.deps.users.get(userId)?.displayName ?? participant.displayName ?? null)
        : (participant.displayName ?? null)
    };
  }

  private accountConversationParticipant(
    conversationId: string,
    accountId: string
  ): ConversationParticipantSummary | null {
    const conversation = this.conversations.get(conversationId);
    const businessConversation =
      conversation && conversation.kind !== "personal" && conversation.activeShopId !== null;
    const userId = this.deps.userByAccount.get(accountId);
    const member =
      businessConversation &&
      [...this.deps.memberships.values()].some(
        (membership) =>
          membership.businessId === conversation.activeShopId && membership.userId === userId
      );
    if (businessConversation && conversation.accountId !== accountId && !member) return null;
    const existing = [...this.conversationParticipants.values()].find(
      (participant) =>
        participant.conversationId === conversationId &&
        participant.role === "account" &&
        participant.accountId === accountId
    );
    if (existing) return existing;
    if (!member || !conversation) return null;
    const participant: ConversationParticipantSummary = {
      id: randomUUID(),
      conversationId,
      role: "account",
      accountId,
      businessId: conversation.activeShopId,
      agentId: null,
      displayName: userId ? (this.deps.users.get(userId)?.displayName ?? null) : null,
      lastReadAt: null,
      archivedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      createdAt: new Date().toISOString()
    };
    this.conversationParticipants.set(participant.id, participant);
    return participant;
  }

  private humanConversationAccountIds(conversationId: string): string[] {
    return [
      ...new Set(
        [...this.conversationParticipants.values()]
          .filter(
            (participant) =>
              participant.conversationId === conversationId &&
              participant.role === "account" &&
              participant.accountId !== null
          )
          .map((participant) => participant.accountId as string)
      )
    ];
  }

  private requireContactAllowed(
    ownerUserId: string,
    targetAccountId: string,
    discovery: boolean
  ): void {
    const targetId = this.deps.userByAccount.get(targetAccountId);
    if (
      !targetId ||
      contactIsBlocked(this.deps.users, ownerUserId, targetId) ||
      (discovery && this.deps.users.get(targetId)?.contactDiscoveryEnabled === false)
    )
      throw new Cp2Error(
        404,
        "recipient_not_found",
        "No available Grogoni account matches that contact."
      );
  }

  private contactNodeForConversation(conversationId: string, accountId: string): string | null {
    const ownerUserId = this.deps.userByAccount.get(accountId);
    const counterpart = this.humanConversationAccountIds(conversationId).filter(
      (id) => id !== accountId
    );
    return ownerUserId && counterpart.length === 1
      ? this.deps.findPhonebookNode(ownerUserId, counterpart[0]!)
      : null;
  }

  private conversationHasHumanRecipient(conversationId: string, callerAccountId: string): boolean {
    if (this.conversations.get(conversationId)?.kind !== "personal") return false;
    return this.humanConversationAccountIds(conversationId).some(
      (accountId) => accountId !== callerAccountId
    );
  }

  private validateConversationEncryption(
    conversationId: string,
    content: ConversationMessageContent
  ): void {
    if (this.conversations.get(conversationId)?.kind !== "personal") return;
    const accountIds = this.humanConversationAccountIds(conversationId);
    if (accountIds.length < 2) return;
    if (content.type !== "encrypted") {
      throw new Cp2Error(
        400,
        "e2ee_required",
        "Direct messages between people must be end-to-end encrypted."
      );
    }
    const devices = [...this.e2eeDevices.values()].filter(
      (device) => accountIds.includes(device.accountId) && device.revokedAt === null
    );
    for (const accountId of accountIds) {
      if (!devices.some((device) => device.accountId === accountId)) {
        throw new Cp2Error(
          409,
          "e2ee_recipient_unavailable",
          "Every participant must register an encryption device before messaging."
        );
      }
    }
    const expected = new Set(devices.map((device) => device.id));
    const actual = new Set(content.envelopes.map((envelope) => envelope.recipientDeviceId));
    if (
      actual.size !== content.envelopes.length ||
      expected.size !== actual.size ||
      [...expected].some((deviceId) => !actual.has(deviceId))
    ) {
      throw new Cp2Error(
        409,
        "e2ee_device_set_changed",
        "Encryption recipients changed. Refresh device keys and retry."
      );
    }
  }

  private conversationAudience(conversation: ConversationSummary): string[] {
    const ids = new Set(
      this.humanConversationAccountIds(conversation.id).filter(
        (accountId) => this.accountConversationParticipant(conversation.id, accountId) !== null
      )
    );
    if (conversation.kind !== "personal" && conversation.activeShopId !== null) {
      for (const membership of this.deps.memberships.values()) {
        if (membership.businessId !== conversation.activeShopId) continue;
        const user = this.deps.users.get(membership.userId);
        if (user) ids.add(user.accountId);
      }
    }
    return [...ids];
  }

  private enqueueConversationNotifications(
    conversation: ConversationSummary,
    message: ConversationMessageSummary,
    senderAccountId: string,
    now: Date
  ): void {
    const recipientIds = new Set(
      this.conversationAudience(conversation).filter((accountId) => accountId !== senderAccountId)
    );
    for (const participant of this.conversationParticipants.values()) {
      if (
        participant.conversationId === conversation.id &&
        participant.accountId !== null &&
        participant.mutedUntil !== null &&
        participant.mutedUntil !== undefined &&
        Date.parse(participant.mutedUntil) > now.getTime()
      ) {
        recipientIds.delete(participant.accountId);
      }
    }
    if (this.deps.pushNotificationSender !== undefined) {
      for (const subscription of this.pushSubscriptions.values()) {
        if (!recipientIds.has(subscription.accountId)) continue;
        this.addMessageNotificationDelivery({
          message,
          accountId: subscription.accountId,
          channel: "push",
          targetId: subscription.id,
          destination: null,
          now
        });
      }
    }
    if (this.deps.messageEmailNotificationSender !== undefined) {
      for (const accountId of recipientIds) {
        const destination = this.deps.verifiedNotificationEmail(accountId);
        if (destination === undefined) continue;
        this.addMessageNotificationDelivery({
          message,
          accountId,
          channel: "email",
          targetId: `email:${accountId}`,
          destination,
          now
        });
      }
    }
  }

  private addMessageNotificationDelivery(input: {
    message: ConversationMessageSummary;
    accountId: string;
    channel: MessageNotificationDelivery["channel"];
    targetId: string;
    destination: string | null;
    now: Date;
  }): void {
    const id = `${input.message.id}:${input.channel}:${input.targetId}`;
    if (this.messageNotificationDeliveries.has(id)) return;
    const timestamp = input.now.toISOString();
    this.messageNotificationDeliveries.set(id, {
      id,
      messageId: input.message.id,
      conversationId: input.message.conversationId,
      accountId: input.accountId,
      channel: input.channel,
      targetId: input.targetId,
      destination: input.destination,
      status: "pending",
      attempts: 0,
      nextAttemptAt: timestamp,
      lastAttemptedAt: null,
      deliveredAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  private async attemptMessageNotificationDelivery(
    delivery: MessageNotificationDelivery,
    now: Date
  ): Promise<MessageNotificationDelivery> {
    const target = this.conversations.get(delivery.conversationId);
    const recipientUser = this.deps.userByAccount.get(delivery.accountId);
    const blocked =
      target?.kind === "personal" &&
      recipientUser &&
      this.humanConversationAccountIds(target.id).some((accountId) => {
        const otherUser = this.deps.userByAccount.get(accountId);
        return otherUser && contactIsBlocked(this.deps.users, recipientUser, otherUser);
      });
    if (
      !target ||
      target.deletedAt != null ||
      blocked ||
      this.accountConversationParticipant(delivery.conversationId, delivery.accountId) === null
    ) {
      const expired: MessageNotificationDelivery = {
        ...delivery,
        status: "dead_letter",
        nextAttemptAt: null,
        updatedAt: now.toISOString()
      };
      this.messageNotificationDeliveries.set(expired.id, expired);
      return expired;
    }
    const attempts = delivery.attempts + 1;
    let outcome: "sent" | "failed" | "expired" = "failed";
    try {
      if (delivery.channel === "push") {
        const subscription = this.pushSubscriptions.get(delivery.targetId);
        if (subscription === undefined || this.deps.pushNotificationSender === undefined) {
          outcome = "expired";
        } else {
          const conversation = this.conversations.get(delivery.conversationId);
          outcome = await this.deps.pushNotificationSender(subscription, {
            type: "message.new",
            conversationId: delivery.conversationId,
            messageId: delivery.messageId,
            title: conversation?.title?.trim() || "New Grogoni message",
            body: this.conversationMessages
              .get(delivery.messageId)
              ?.idempotencyKey.startsWith("membership:")
              ? "A participant was added to your discussion. Open Grogoni to view it."
              : "Open Grogoni to read your message."
          });
          if (outcome === "expired") {
            this.pushSubscriptions.delete(subscription.id);
            this.pushSubscriptionIdByEndpoint.delete(subscription.endpoint);
          }
        }
      } else if (
        delivery.destination !== null &&
        this.deps.messageEmailNotificationSender !== undefined
      ) {
        const webBaseUrl = (this.deps.messageWebBaseUrl ?? "https://grogoni.com").replace(
          /\/+$/u,
          ""
        );
        outcome = await this.deps.messageEmailNotificationSender({
          conversationId: delivery.conversationId,
          messageId: delivery.messageId,
          openUrl: `${webBaseUrl}/?conversation=${encodeURIComponent(delivery.conversationId)}`,
          to: delivery.destination
        });
      }
    } catch {
      outcome = "failed";
    }

    const timestamp = now.toISOString();
    const terminal = outcome === "expired" || (outcome === "failed" && attempts >= 5);
    const next: MessageNotificationDelivery = {
      ...delivery,
      status: outcome === "sent" ? "sent" : terminal ? "dead_letter" : "failed",
      attempts,
      nextAttemptAt:
        outcome === "sent" || terminal
          ? null
          : new Date(
              now.getTime() + Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1))
            ).toISOString(),
      lastAttemptedAt: timestamp,
      deliveredAt: outcome === "sent" ? timestamp : null,
      lastError:
        outcome === "sent"
          ? null
          : outcome === "expired"
            ? "push_subscription_expired"
            : "notification_delivery_failed",
      updatedAt: timestamp
    };
    this.messageNotificationDeliveries.set(next.id, next);
    return next;
  }

  private messagesForConversation(conversationId: string): ConversationMessageSummary[] {
    return [...this.conversationMessages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  private requireConversationMessage(
    messageId: string,
    conversationId: string
  ): ConversationMessageSummary {
    const message = this.conversationMessages.get(messageId);
    if (!message || message.conversationId !== conversationId)
      throw new Cp2Error(404, "message_not_found", "Message was not found.");
    return message;
  }

  private typingForConversation(
    conversationId: string,
    now: Date,
    excludeActorId?: string
  ): ConversationTypingSummary[] {
    const result: ConversationTypingSummary[] = [];
    for (const [key, typing] of this.conversationTyping) {
      if (Date.parse(typing.expiresAt) <= now.getTime()) {
        this.conversationTyping.delete(key);
      } else if (typing.conversationId === conversationId && typing.actorId !== excludeActorId) {
        result.push({
          actorId: typing.actorId,
          displayName: typing.displayName,
          expiresAt: typing.expiresAt
        });
      }
    }
    return result;
  }

  private recordConversationSyncForParticipants(
    conversationId: string,
    collection: SyncCollection,
    entityId: string,
    entity: unknown,
    now: Date
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const accountIds = new Set(this.conversationAudience(conversation));
    for (const accountId of accountIds) {
      this.deps.recordSyncChange({
        accountId,
        collection,
        entityId,
        operation: "upsert",
        shopId: conversation.activeShopId,
        entity,
        now
      });
    }
  }

  purchaseOrderDelivery(): PurchaseOrderDelivery {
    const emailMailbox = (actor: PurchaseOrderActor, input: PurchaseOrderSubmission) => {
      const auth = this.deps.requireAuthorizedSession(
        actor.sessionId,
        actor.businessId,
        "supplier:write",
        new Date()
      );
      const mailbox = this.requireConnectedMailbox(actor.businessId, input.mailboxId ?? "");
      const providerConfigured = this.deps.emailMailboxProviderClient
        .providers()
        .some((provider) => provider.provider === mailbox.provider && provider.configured);
      if (
        !providerConfigured ||
        mailbox.accountId !== auth.account.id ||
        mailbox.status !== "connected" ||
        !mailbox.canSend
      )
        throw new Cp2Error(
          503,
          "purchase_order_channel_unavailable",
          "The exact buyer mailbox must be connected and authorized."
        );
      return mailbox;
    };
    return {
      check: async (actor, input) => {
        if (input.channel === "whatsapp") {
          const { createWhatsAppPurchaseOrderDelivery } =
            await import("../../../messaging/purchase-order-delivery.js");
          return createWhatsAppPurchaseOrderDelivery().check(actor, input);
        }
        if (input.channel !== "email")
          throw new Cp2Error(
            503,
            "purchase_order_channel_unavailable",
            "Unsupported external purchase order channel."
          );
        emailMailbox(actor, input);
      },
      send: async (actor, input, order) => {
        const { createWhatsAppPurchaseOrderDelivery, purchaseOrderMessage } =
          await import("../../../messaging/purchase-order-delivery.js");
        if (input.channel === "whatsapp")
          return createWhatsAppPurchaseOrderDelivery().send(actor, input, order);
        const authorized = await this.authorizedMailbox(emailMailbox(actor, input), new Date());
        const result = await this.deps.emailMailboxProviderClient.send({
          provider: authorized.mailbox.provider,
          accessToken: authorized.accessToken,
          senderAddress: authorized.mailbox.address,
          recipientAddress: input.recipient,
          subject: `Purchase order ${order.order_id}`,
          text: purchaseOrderMessage(order),
          idempotencyKey: order.order_id,
          externalThreadId: null,
          replyToProviderMessageId: null,
          attachments: []
        });
        if (!result.externalMessageId)
          throw new Error("Email provider acknowledgment unavailable.");
        return { providerMessageId: result.externalMessageId };
      }
    };
  }

  private emailTransportReadiness(businessId: string | undefined) {
    const providerConfigured = this.deps.emailMailboxProviderClient
      .providers()
      .some((provider) => provider.configured);
    const candidates = [...this.connectedMailboxes.values()].filter(
      (mailbox) =>
        (businessId === undefined || mailbox.businessId === businessId) &&
        mailbox.status !== "disconnected"
    );
    const mailbox =
      candidates.find((candidate) => candidate.isDefault) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!providerConfigured) {
      return {
        configured: false,
        authorized: false,
        status: "unavailable" as const,
        mailboxId: null,
        configurationRequirement: "Configure Gmail or Outlook mailbox OAuth credentials.",
        errorCode: "EMAIL_PROVIDER_UNAVAILABLE" as const
      };
    }
    if (mailbox === undefined) {
      return {
        configured: false,
        authorized: false,
        status: candidates.length > 1 ? ("error" as const) : ("unavailable" as const),
        mailboxId: null,
        configurationRequirement:
          candidates.length > 1
            ? "Choose one connected mailbox as the business default."
            : "Connect and authorize a Gmail or Outlook mailbox.",
        errorCode:
          candidates.length > 1
            ? ("EMAIL_MAILBOX_NOT_FOUND" as const)
            : ("EMAIL_MAILBOX_NOT_CONNECTED" as const)
      };
    }
    if (mailbox.status === "reauthorization_required") {
      return {
        configured: true,
        authorized: false,
        status: "authorization_required" as const,
        mailboxId: mailbox.id,
        configurationRequirement: "Reconnect this mailbox to restore provider authorization.",
        errorCode: "EMAIL_REAUTHORIZATION_REQUIRED" as const
      };
    }
    if (mailbox.status === "error" || !mailbox.canSend) {
      return {
        configured: true,
        authorized: mailbox.status === "connected",
        status: "error" as const,
        mailboxId: mailbox.id,
        configurationRequirement: "The connected mailbox cannot currently send email.",
        errorCode: "EMAIL_PROVIDER_UNAVAILABLE" as const
      };
    }
    return {
      configured: true,
      authorized: true,
      status: "available" as const,
      mailboxId: mailbox.id,
      configurationRequirement: null,
      errorCode: null
    };
  }

  private async sendEmailTransport(
    request: OutboundChannelMessage,
    now: Date
  ): Promise<{
    accepted: true;
    providerMessageId: string | null;
    externalThreadId: string | null;
    status: "sent";
  }> {
    const conversation = this.conversations.get(request.conversationId);
    if (conversation === undefined || conversation.activeShopId !== request.businessId) {
      throw new ChannelGatewayError(
        "EMAIL_SEND_FAILED",
        "The canonical email conversation is unavailable."
      );
    }
    const messageId = this.messageByIdempotencyKey.get(
      `${request.conversationId}:${request.idempotencyKey}`
    );
    if (messageId === undefined) {
      throw new ChannelGatewayError(
        "EMAIL_SEND_FAILED",
        "The canonical email message is unavailable."
      );
    }
    const mailboxId = request.endpoint.executionMailboxId;
    if (mailboxId === null || mailboxId === undefined) {
      throw new ChannelGatewayError(
        "EMAIL_MAILBOX_NOT_FOUND",
        "No sending mailbox was selected for this conversation."
      );
    }
    const mailbox = this.requireConnectedMailbox(request.businessId, mailboxId);
    if (mailbox.accountId !== conversation.accountId) {
      throw new ChannelGatewayError(
        "EMAIL_MAILBOX_NOT_FOUND",
        "The selected mailbox is not authorized for this account."
      );
    }
    if (request.subject === undefined) {
      throw new ChannelGatewayError(
        "EMAIL_SEND_FAILED",
        "A subject is required when starting an email conversation."
      );
    }
    const subject = normalizeRequiredBoundedText(request.subject, "subject", 200);
    const recipientAddress = normalizeEmailIdentity(request.endpoint.externalUserId);
    try {
      let authorized = await this.authorizedMailbox(mailbox, now);
      const send = (authorization: { mailbox: ConnectedMailboxRecord; accessToken: string }) =>
        this.deps.emailMailboxProviderClient.send({
          provider: authorization.mailbox.provider,
          accessToken: authorization.accessToken,
          senderAddress: authorization.mailbox.address,
          recipientAddress,
          subject,
          text: request.text,
          idempotencyKey: messageId,
          externalThreadId: request.externalThreadId ?? null,
          replyToProviderMessageId: request.replyToProviderMessageId ?? null,
          attachments: request.attachments ?? []
        });
      let result;
      try {
        result = await send(authorized);
      } catch (error) {
        if (!isEmailReauthorizationError(error)) throw error;
        authorized = await this.refreshMailboxAuthorization(authorized.mailbox, now);
        result = await send(authorized);
      }
      this.deps.recordAuditEvent({
        type: "email.send_completed",
        aggregateType: "conversation_message",
        aggregateId: messageId,
        actorId: "channel-gateway",
        occurredAt: now.toISOString(),
        payload: {
          accountId: mailbox.accountId,
          businessId: mailbox.businessId,
          mailboxId: mailbox.id,
          conversationId: request.conversationId,
          messageId,
          provider: mailbox.provider
        }
      });
      return {
        accepted: true,
        providerMessageId: result.externalMessageId,
        externalThreadId: result.externalThreadId,
        status: "sent"
      };
    } catch (error) {
      this.handleEmailProviderFailure(mailbox, error, now);
      const normalized = this.emailProviderCp2Error(error);
      throw new ChannelGatewayError(
        normalized.code as
          "EMAIL_REAUTHORIZATION_REQUIRED" | "EMAIL_SEND_FAILED" | "EMAIL_PROVIDER_UNAVAILABLE",
        normalized.message,
        normalized.statusCode >= 500
      );
    }
  }

  private resolveTrustedEmailAttachments(
    businessId: string,
    customerId: string,
    references: TrustedMessageAttachmentReference[]
  ): {
    canonical: ConversationAttachment[];
    provider: Array<{ filename: string; mimeType: string; contentBase64: string }>;
  } {
    if (references.length > 3) {
      throw new Cp2Error(
        400,
        "EMAIL_ATTACHMENT_UNAVAILABLE",
        "At most three trusted attachments may be sent in one email."
      );
    }
    const unique = new Set<string>();
    const canonical: ConversationAttachment[] = [];
    const provider: Array<{ filename: string; mimeType: string; contentBase64: string }> = [];
    for (const reference of references) {
      if (reference.resourceType !== "invoice" || unique.has(reference.resourceId)) continue;
      unique.add(reference.resourceId);
      const invoice = this.deps.requireInvoice(businessId, reference.resourceId);
      if (invoice.customerId !== customerId) {
        throw new Cp2Error(
          403,
          "EMAIL_ATTACHMENT_UNAVAILABLE",
          "The invoice belongs to a different customer."
        );
      }
      if (invoice.status !== "confirmed") {
        throw new Cp2Error(
          409,
          "EMAIL_ATTACHMENT_UNAVAILABLE",
          "Confirm the invoice before attaching it to an email."
        );
      }
      const text = renderInvoiceAttachment(this.deps.requireBusiness(businessId), invoice);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > 512 * 1024) {
        throw new Cp2Error(
          413,
          "EMAIL_ATTACHMENT_UNAVAILABLE",
          "The generated invoice attachment is too large."
        );
      }
      const filename = `invoice-${sanitizeAttachmentFilename(invoice.invoiceNumber)}.txt`;
      const contentBase64 = bytes.toString("base64");
      canonical.push({
        id: `invoice:${invoice.id}`,
        name: filename,
        mimeType: "text/plain",
        size: bytes.byteLength,
        category: "document",
        url: `data:text/plain;base64,${contentBase64}`
      });
      provider.push({ filename, mimeType: "text/plain", contentBase64 });
    }
    return { canonical, provider };
  }

  private requireConnectedMailbox(businessId: string, mailboxId: string): ConnectedMailboxRecord {
    const mailbox = this.connectedMailboxes.get(mailboxId);
    if (mailbox === undefined || mailbox.businessId !== businessId) {
      throw new Cp2Error(404, "EMAIL_MAILBOX_NOT_FOUND", "Connected mailbox was not found.");
    }
    return mailbox;
  }

  private async authorizedMailbox(
    mailbox: ConnectedMailboxRecord,
    now: Date
  ): Promise<{ mailbox: ConnectedMailboxRecord; accessToken: string }> {
    if (mailbox.status !== "connected" || mailbox.encryptedAccessToken === null) {
      throw new EmailProviderClientError(
        "EMAIL_REAUTHORIZATION_REQUIRED",
        "Reconnect this mailbox before using it."
      );
    }
    if (mailbox.tokenExpiresAt === null || Date.parse(mailbox.tokenExpiresAt) > now.getTime()) {
      return { mailbox, accessToken: decryptOAuthToken(mailbox.encryptedAccessToken) };
    }
    return this.refreshMailboxAuthorization(mailbox, now);
  }

  private async refreshMailboxAuthorization(
    mailbox: ConnectedMailboxRecord,
    now: Date
  ): Promise<{ mailbox: ConnectedMailboxRecord; accessToken: string }> {
    if (mailbox.encryptedRefreshToken === null) {
      throw new EmailProviderClientError(
        "EMAIL_REAUTHORIZATION_REQUIRED",
        "Mailbox offline authorization is unavailable. Reconnect the mailbox."
      );
    }
    const tokens = await this.deps.emailMailboxProviderClient.refreshAuthorization({
      provider: mailbox.provider,
      refreshToken: decryptOAuthToken(mailbox.encryptedRefreshToken)
    });
    const refreshed = this.withMailboxTokens(mailbox, tokens, now);
    this.connectedMailboxes.set(refreshed.id, refreshed);
    return { mailbox: refreshed, accessToken: tokens.accessToken };
  }

  private withMailboxTokens(
    mailbox: ConnectedMailboxRecord,
    tokens: EmailProviderTokens,
    now: Date
  ): ConnectedMailboxRecord {
    return {
      ...mailbox,
      encryptedAccessToken: encryptOAuthToken(tokens.accessToken),
      encryptedRefreshToken:
        tokens.refreshToken === null
          ? mailbox.encryptedRefreshToken
          : encryptOAuthToken(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
      status: "connected",
      readiness: "READY",
      canSend: mailboxScopeAllows(mailbox.provider, tokens.scope, "send"),
      canReceive: mailboxScopeAllows(mailbox.provider, tokens.scope, "receive"),
      lastErrorCode: null,
      updatedAt: now.toISOString()
    };
  }

  private async ingestConnectedMailboxEmail(
    mailbox: ConnectedMailboxRecord,
    inbound: NormalizedProviderEmail,
    now: Date
  ): Promise<"ingested" | "deduplicated" | "filtered"> {
    const senderAddress = normalizeEmailIdentity(inbound.senderAddress);
    if (inbound.automated || senderAddress === mailbox.address) return "filtered";
    const externalUpdateId = `${mailbox.id}:${normalizeRequiredBoundedText(inbound.externalMessageId, "externalMessageId", 200)}`;
    if (
      [...this.providerUpdateReceipts.values()].some(
        (receipt) => receipt.provider === "email" && receipt.externalUpdateId === externalUpdateId
      )
    ) {
      return "deduplicated";
    }
    const externalThreadId = normalizeRequiredBoundedText(
      inbound.externalThreadId,
      "externalThreadId",
      200
    );
    let channel = [...this.conversationChannels.values()].find(
      (candidate) =>
        candidate.provider === "email" &&
        candidate.businessId === mailbox.businessId &&
        candidate.externalConversationId === externalThreadId &&
        candidate.metadata.mailboxId === mailbox.id
    );
    const hadExistingThread = channel !== undefined;
    let identity = channel ? this.platformIdentities.get(channel.platformIdentityId) : undefined;
    if (identity === undefined) {
      identity = [...this.platformIdentities.values()].find(
        (candidate) =>
          candidate.provider === "email" &&
          candidate.businessId === mailbox.businessId &&
          normalizeStoredEmailIdentity(candidate.externalUserId) === senderAddress
      );
    }
    let customer =
      identity?.customerId === null || identity?.customerId === undefined
        ? undefined
        : this.deps.customers.get(identity.customerId);
    if (customer === undefined) {
      const matches = [...this.deps.customers.values()].filter(
        (candidate) =>
          candidate.businessId === mailbox.businessId &&
          normalizeStoredEmailIdentity(candidate.email) === senderAddress
      );
      if (matches.length > 1) return "filtered";
      customer = matches[0];
    }
    if (customer === undefined && !mailbox.ingestUnknownSenders) return "filtered";
    if (channel === undefined) {
      const ownerUserId = this.deps.userByAccount.get(mailbox.accountId);
      if (ownerUserId === undefined) {
        throw new Cp2Error(409, "mailbox_owner_missing", "Mailbox owner is unavailable.");
      }
      const linked = this.upsertProviderConversation({
        businessId: mailbox.businessId,
        provider: "email",
        customerId: customer?.id ?? null,
        externalUserId: senderAddress,
        externalConversationId: externalThreadId,
        displayName: customer?.name ?? null,
        metadata: {
          mailboxId: mailbox.id,
          subject: normalizeEmailSubject(inbound.subject),
          automaticRepliesEnabled: mailbox.automaticReplyEnabled
        },
        ownerAccountId: mailbox.accountId,
        ownerUserId,
        now
      });
      channel = linked.channel;
      identity = linked.identity;
    }
    const ingested = this.ingestProviderMessage({
      provider: "email",
      businessId: mailbox.businessId,
      externalConversationId: channel.externalConversationId,
      externalUpdateId,
      body: inbound.text,
      providerMessageId: inbound.externalMessageId,
      subject: normalizeEmailSubject(inbound.subject),
      externalThreadId,
      senderAddress,
      recipientAddresses: inbound.recipientAddresses.map(normalizeEmailIdentity),
      ccAddresses: inbound.ccAddresses.map(normalizeEmailIdentity),
      now: new Date(inbound.receivedAt)
    });
    this.deps.recordAuditEvent({
      type: "email.received",
      aggregateType: "conversation_message",
      aggregateId: ingested.message?.id ?? ingested.receipt.id,
      actorId: "email-sync",
      occurredAt: now.toISOString(),
      payload: {
        accountId: mailbox.accountId,
        businessId: mailbox.businessId,
        mailboxId: mailbox.id,
        conversationId: channel.conversationId,
        customerId: identity?.customerId ?? null,
        messageId: ingested.message?.id ?? null,
        provider: mailbox.provider
      }
    });
    if (
      hadExistingThread &&
      ingested.message !== null &&
      mailbox.automaticReplyEnabled &&
      mailbox.automaticReplyText !== null
    ) {
      await this.sendMailboxAutomaticReply(mailbox, channel, inbound, ingested.message, now).catch(
        () => undefined
      );
    }
    return "ingested";
  }

  private async sendMailboxAutomaticReply(
    mailbox: ConnectedMailboxRecord,
    channel: ConversationChannelSummary,
    inbound: NormalizedProviderEmail,
    inboundMessage: ConversationMessageSummary,
    now: Date
  ): Promise<void> {
    const automaticReplyText = mailbox.automaticReplyText;
    if (!mailbox.automaticReplyEnabled || automaticReplyText === null) return;
    const lastAutomaticReplyAt =
      typeof channel.metadata.lastAutomaticReplyAt === "string"
        ? channel.metadata.lastAutomaticReplyAt
        : null;
    if (
      lastAutomaticReplyAt !== null &&
      Date.parse(lastAutomaticReplyAt) > now.getTime() - 24 * 60 * 60_000
    ) {
      return;
    }
    const identity = this.platformIdentities.get(channel.platformIdentityId);
    if (identity?.customerId === null || identity?.customerId === undefined) return;
    const ownerUserId = this.deps.userByAccount.get(mailbox.accountId);
    if (ownerUserId === undefined) return;
    const endpoint = this.deps.channelGateway.endpoint(channel, identity);
    const idempotencyKey = `email-auto-reply:${mailbox.id}:${inbound.externalMessageId}`;
    const existingId = this.messageByIdempotencyKey.get(
      `${channel.conversationId}:${idempotencyKey}`
    );
    if (existingId !== undefined) return;
    const subject = normalizeEmailSubject(inbound.subject);
    const message = this.persistOutboundChannelMessage({
      endpoint,
      authorId: ownerUserId,
      text: automaticReplyText,
      subject,
      replyToMessageId: inboundMessage.id,
      externalThreadId: inbound.externalThreadId,
      attachments: [],
      idempotencyKey,
      now
    });
    try {
      const dispatched = await this.deps.channelGateway.send({
        businessId: mailbox.businessId,
        conversationId: channel.conversationId,
        customerId: identity.customerId,
        idempotencyKey,
        text: automaticReplyText,
        subject,
        replyToProviderMessageId: inbound.externalMessageId,
        externalThreadId: inbound.externalThreadId,
        endpoints: [endpoint],
        preferredProvider: "email"
      });
      const sent: ConversationMessageSummary = {
        ...message,
        status: dispatched.result.status,
        sentAt: now.toISOString(),
        actualChannel: "email",
        providerMessageId: dispatched.result.providerMessageId,
        externalThreadId: dispatched.result.externalThreadId ?? inbound.externalThreadId
      };
      this.conversationMessages.set(sent.id, sent);
      this.finishChannelDeliveryAttempt(sent, "succeeded", null, now);
      this.conversationChannels.set(channel.id, {
        ...channel,
        metadata: {
          ...channel.metadata,
          lastAutomaticReplyAt: now.toISOString(),
          lastAutomaticReplyMessageId: sent.id
        },
        lastOutboundAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      this.deps.recordAuditEvent({
        type: "email.automatic_reply_sent",
        aggregateType: "conversation_message",
        aggregateId: sent.id,
        actorId: ownerUserId,
        occurredAt: now.toISOString(),
        payload: {
          businessId: mailbox.businessId,
          mailboxId: mailbox.id,
          conversationId: channel.conversationId,
          messageId: sent.id,
          provider: mailbox.provider
        }
      });
    } catch (error) {
      const normalized = this.channelError(error);
      const failed: ConversationMessageSummary = {
        ...message,
        status: "failed",
        failureCode: normalized.code,
        retryCount: 1,
        nextRetryAt: null
      };
      this.conversationMessages.set(failed.id, failed);
      this.finishChannelDeliveryAttempt(failed, "permanent_failure", normalized.code, now);
      throw error;
    }
  }

  private setMailboxChannelStatus(
    mailboxId: string,
    status: "available" | "authorization_required",
    now: Date
  ): void {
    for (const channel of this.conversationChannels.values()) {
      if (channel.provider === "email" && channel.metadata.mailboxId === mailboxId) {
        this.conversationChannels.set(channel.id, {
          ...channel,
          status,
          updatedAt: now.toISOString()
        });
      }
    }
  }

  private handleEmailProviderFailure(
    mailbox: ConnectedMailboxRecord,
    error: unknown,
    now: Date
  ): void {
    const reauthorization =
      error instanceof EmailProviderClientError && error.code === "EMAIL_REAUTHORIZATION_REQUIRED";
    const failed: ConnectedMailboxRecord = {
      ...mailbox,
      status: reauthorization ? "reauthorization_required" : "error",
      readiness: reauthorization ? "REAUTHORIZATION_REQUIRED" : "ERROR",
      lastErrorCode:
        error instanceof EmailProviderClientError ? error.code : "EMAIL_PROVIDER_UNAVAILABLE",
      updatedAt: now.toISOString()
    };
    this.connectedMailboxes.set(failed.id, failed);
    this.setMailboxChannelStatus(
      failed.id,
      reauthorization ? "authorization_required" : "authorization_required",
      now
    );
  }

  private emailProviderCp2Error(error: unknown): Cp2Error {
    if (error instanceof EmailProviderClientError) {
      return new Cp2Error(
        error.code === "EMAIL_REAUTHORIZATION_REQUIRED" ? 401 : error.retryable ? 503 : 502,
        error.code,
        error.message
      );
    }
    return new Cp2Error(502, "EMAIL_PROVIDER_UNAVAILABLE", "The mailbox provider is unavailable.");
  }

  private nativeSmsTransportReadiness(businessId: string | undefined, now: Date) {
    const accountId =
      businessId === undefined ? undefined : this.nativeSmsAccountForBusiness(businessId);
    const candidates = [...this.nativeSmsDevices.values()]
      .filter(
        (device) =>
          device.revokedAt === null &&
          (accountId === undefined || device.accountId === accountId) &&
          (businessId === undefined || accountId !== undefined)
      )
      .map((device) => this.nativeSmsDeviceView(device, now))
      .sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          right.lastSeenAt.localeCompare(left.lastSeenAt) ||
          left.id.localeCompare(right.id)
      );
    const device = candidates[0];
    if (device === undefined) {
      return {
        configured: false,
        authorized: false,
        status: "unavailable" as const,
        deviceId: null,
        configurationRequirement: "Register an authenticated SMS-capable Android device.",
        errorCode: "SMS_DEVICE_UNAVAILABLE" as const
      };
    }
    const requirement = nativeSmsDeviceRequirement(device);
    return {
      configured: true,
      authorized: device.revokedAt === null,
      status:
        device.readiness === "ready"
          ? ("available" as const)
          : device.readiness === "offline"
            ? ("offline" as const)
            : device.readiness === "error"
              ? ("error" as const)
              : device.readiness === "setup_required"
                ? ("setup_required" as const)
                : ("unavailable" as const),
      deviceId: device.id,
      configurationRequirement: requirement,
      errorCode: nativeSmsReadinessErrorCode(device)
    };
  }

  private nativeSmsAccountForBusiness(businessId: string): string | undefined {
    const ownerMembership = [...this.deps.memberships.values()].find(
      (membership) => membership.businessId === businessId && membership.role === "owner"
    );
    return ownerMembership === undefined
      ? undefined
      : this.deps.users.get(ownerMembership.userId)?.accountId;
  }

  private nativeSmsDeviceView(device: NativeSmsDeviceSummary, now: Date): NativeSmsDeviceSummary {
    if (device.revokedAt !== null) return { ...device, readiness: "unavailable", capabilities: [] };
    if (!this.hasActiveSessionFamily(device.accountId, device.sessionFamilyId, now)) {
      return { ...device, readiness: "unavailable", capabilities: [] };
    }
    if (
      device.readiness === "ready" &&
      now.getTime() - Date.parse(device.lastSeenAt) > nativeSmsOnlineWindowMs
    ) {
      return { ...device, readiness: "offline" };
    }
    return device;
  }

  private hasActiveSessionFamily(accountId: string, sessionFamilyId: string, now: Date): boolean {
    return [...this.deps.sessions.values()].some(
      (session) =>
        session.accountId === accountId &&
        session.sessionFamilyId === sessionFamilyId &&
        session.revokedAt === null &&
        Date.parse(session.inactivityExpiresAt) > now.getTime() &&
        Date.parse(session.absoluteExpiresAt) > now.getTime()
    );
  }

  private queueNativeSmsCommand(
    request: OutboundChannelMessage,
    now: Date
  ): { commandId: string; waitingForDevice: boolean } {
    const conversation = this.conversations.get(request.conversationId);
    if (conversation === undefined || conversation.activeShopId !== request.businessId) {
      throw new ChannelGatewayError("SMS_DEVICE_UNAVAILABLE", "SMS conversation is unavailable.");
    }
    const existingMessageId = this.messageByIdempotencyKey.get(
      `${request.conversationId}:${request.idempotencyKey}`
    );
    if (existingMessageId === undefined) {
      throw new ChannelGatewayError("SMS_SEND_FAILED", "Canonical SMS message is unavailable.");
    }
    const existing = [...this.nativeSmsDeviceCommands.values()].find(
      (command) => command.messageId === existingMessageId
    );
    if (existing !== undefined) {
      return {
        commandId: existing.id,
        waitingForDevice: existing.status === "waiting_for_device"
      };
    }
    const device = [...this.nativeSmsDevices.values()]
      .filter(
        (candidate) =>
          candidate.accountId === conversation.accountId &&
          candidate.revokedAt === null &&
          candidate.capabilities.includes("native_sms_send")
      )
      .map((candidate) => this.nativeSmsDeviceView(candidate, now))
      .filter((candidate) => candidate.readiness === "ready" || candidate.readiness === "offline")
      .sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          right.lastSeenAt.localeCompare(left.lastSeenAt) ||
          left.id.localeCompare(right.id)
      )[0];
    if (device === undefined) {
      throw new ChannelGatewayError(
        "SMS_DEVICE_UNAVAILABLE",
        "No eligible Android SMS device is linked to this account."
      );
    }
    const recipient = normalizeInternationalOwnerPhoneNumber(request.endpoint.externalUserId).e164;
    const waitingForDevice = device.readiness === "offline";
    const command: NativeSmsDeviceCommandSummary = {
      id: randomUUID(),
      accountId: conversation.accountId,
      businessId: request.businessId,
      deviceId: device.id,
      messageId: existingMessageId,
      type: "native_sms.send",
      recipient,
      status: waitingForDevice ? "waiting_for_device" : "queued",
      resultCode: null,
      carrierReference: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + nativeSmsCommandTtlMs).toISOString(),
      dispatchedAt: null,
      acknowledgedAt: null,
      completedAt: null,
      updatedAt: now.toISOString()
    };
    this.nativeSmsDeviceCommands.set(command.id, command);
    this.deps.recordAuditEvent({
      type: "native_sms.command_queued",
      aggregateType: "native_sms_device_command",
      aggregateId: command.id,
      actorId: "channel-gateway",
      occurredAt: now.toISOString(),
      payload: {
        accountId: command.accountId,
        businessId: command.businessId,
        conversationId: request.conversationId,
        messageId: command.messageId,
        deviceId: command.deviceId,
        status: command.status
      }
    });
    return { commandId: command.id, waitingForDevice };
  }

  private requireCurrentNativeSmsDevice(
    sessionId: string | null,
    capability: NativeSmsDeviceCapability,
    now: Date
  ): NativeSmsDeviceSummary {
    const auth = this.deps.requirePinVerifiedSession(sessionId, now);
    const session = this.deps.sessions.get(auth.session.id);
    const device = [...this.nativeSmsDevices.values()].find(
      (candidate) =>
        candidate.accountId === auth.account.id &&
        candidate.deviceId === session?.deviceId &&
        candidate.sessionFamilyId === session?.sessionFamilyId &&
        candidate.revokedAt === null
    );
    if (device === undefined) {
      throw new Cp2Error(403, "SMS_DEVICE_UNAVAILABLE", "Native SMS device is not registered.");
    }
    if (!device.capabilities.includes(capability)) {
      throw new Cp2Error(
        403,
        nativeSmsMissingCapabilityCode(device, capability),
        "Native SMS role, permissions, and SIM readiness are required."
      );
    }
    return device;
  }

  private touchNativeSmsDevice(device: NativeSmsDeviceSummary, now: Date): NativeSmsDeviceSummary {
    const touched: NativeSmsDeviceSummary = {
      ...device,
      readiness:
        device.roleGranted &&
        device.sendPermissionGranted &&
        device.receivePermissionGranted &&
        device.simReady &&
        device.lastErrorCode === null
          ? "ready"
          : device.readiness,
      lastSeenAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.nativeSmsDevices.set(touched.id, touched);
    return touched;
  }

  private requireNativeSmsCommand(
    device: NativeSmsDeviceSummary,
    commandId: string,
    now: Date
  ): NativeSmsDeviceCommandSummary {
    const command = this.nativeSmsDeviceCommands.get(commandId);
    if (
      command === undefined ||
      command.deviceId !== device.id ||
      command.accountId !== device.accountId
    ) {
      throw new Cp2Error(404, "sms_command_not_found", "Native SMS command was not found.");
    }
    if (
      Date.parse(command.expiresAt) <= now.getTime() &&
      !["completed", "failed", "cancelled"].includes(command.status)
    ) {
      const cancelled: NativeSmsDeviceCommandSummary = {
        ...command,
        status: "cancelled",
        resultCode: "SMS_DEVICE_UNAVAILABLE",
        completedAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.nativeSmsDeviceCommands.set(cancelled.id, cancelled);
      this.failNativeSmsMessage(command.messageId, "SMS_DEVICE_UNAVAILABLE", now);
      throw new Cp2Error(410, "sms_command_expired", "Native SMS command has expired.");
    }
    return command;
  }

  private failNativeSmsMessage(messageId: string, code: string, now: Date): void {
    const message = this.conversationMessages.get(messageId);
    if (message === undefined || message.status === "delivered" || message.status === "sent")
      return;
    const failed: ConversationMessageSummary = {
      ...message,
      status: "failed",
      failureCode: code,
      nextRetryAt: null
    };
    this.conversationMessages.set(failed.id, failed);
    this.finishChannelDeliveryAttempt(failed, "permanent_failure", code, now);
    this.recordConversationSyncForParticipants(
      failed.conversationId,
      "conversation_messages",
      failed.id,
      failed,
      now
    );
  }

  private ensureNativeSmsEndpoint(input: {
    businessId: string;
    customer: CustomerSummary;
    accountId: string;
    userId: string;
    now: Date;
  }): void {
    const phone = normalizeExistingCustomerPhone(input.customer.phone);
    if (phone === null) return;
    this.upsertProviderConversation({
      businessId: input.businessId,
      provider: "native_sms",
      customerId: input.customer.id,
      externalUserId: phone,
      externalConversationId: phone,
      displayName: input.customer.name,
      metadata: { automaticRepliesEnabled: false, executionEnvironment: "android-device" },
      ownerAccountId: input.accountId,
      ownerUserId: input.userId,
      now: input.now
    });
  }

  private ensureEmailEndpoint(input: {
    businessId: string;
    customer: CustomerSummary;
    accountId: string;
    userId: string;
    mailboxId: string | null;
    conversationId: string | null;
    allowUnconnected: boolean;
    now: Date;
  }): void {
    if (input.customer.email === null) {
      throw new Cp2Error(404, "EMAIL_RECIPIENT_NOT_FOUND", "This customer has no email identity.");
    }
    const recipient = normalizeEmailIdentity(input.customer.email);
    const existing = [...this.conversationChannels.values()].find((channel) => {
      const identity = this.platformIdentities.get(channel.platformIdentityId);
      return (
        channel.provider === "email" &&
        channel.businessId === input.businessId &&
        identity?.customerId === input.customer.id &&
        (input.conversationId === null || channel.conversationId === input.conversationId) &&
        (input.mailboxId === null || channel.metadata.mailboxId === input.mailboxId)
      );
    });
    const eligible = [...this.connectedMailboxes.values()].filter(
      (mailbox) =>
        mailbox.businessId === input.businessId &&
        mailbox.accountId === input.accountId &&
        mailbox.status === "connected" &&
        mailbox.canSend
    );
    const mailbox =
      input.mailboxId === null
        ? (eligible.find((candidate) => candidate.isDefault) ??
          (eligible.length === 1 ? eligible[0] : undefined))
        : eligible.find((candidate) => candidate.id === input.mailboxId);
    if (mailbox === undefined) {
      if (input.allowUnconnected) {
        if (existing !== undefined) return;
        this.upsertProviderConversation({
          businessId: input.businessId,
          provider: "email",
          customerId: input.customer.id,
          externalUserId: recipient,
          externalConversationId: `email:unconnected:${recipient}`,
          displayName: input.customer.name,
          metadata: { mailboxId: null, automaticRepliesEnabled: false },
          ownerAccountId: input.accountId,
          ownerUserId: input.userId,
          now: input.now
        });
        return;
      }
      throw new Cp2Error(
        eligible.length > 1 ? 409 : 404,
        eligible.length > 1 ? "EMAIL_MAILBOX_NOT_FOUND" : "EMAIL_MAILBOX_NOT_CONNECTED",
        eligible.length > 1
          ? "Choose a default or explicit sending mailbox."
          : "Connect an authorized mailbox before sending email."
      );
    }
    if (existing !== undefined) {
      if (existing.metadata.mailboxId === mailbox.id) return;
      this.conversationChannels.set(existing.id, {
        ...existing,
        externalConversationId: `email:${mailbox.id}:${recipient}`,
        status: "available",
        metadata: {
          ...existing.metadata,
          mailboxId: mailbox.id,
          senderAddress: mailbox.address,
          automaticRepliesEnabled: false
        },
        updatedAt: input.now.toISOString()
      });
      return;
    }
    this.upsertProviderConversation({
      businessId: input.businessId,
      provider: "email",
      customerId: input.customer.id,
      externalUserId: recipient,
      externalConversationId: `email:${mailbox.id}:${recipient}`,
      displayName: input.customer.name,
      metadata: {
        mailboxId: mailbox.id,
        senderAddress: mailbox.address,
        automaticRepliesEnabled: false
      },
      ownerAccountId: input.accountId,
      ownerUserId: input.userId,
      now: input.now
    });
  }

  private requireEmailReplyTarget(
    conversationId: string,
    messageId: string
  ): ConversationMessageSummary {
    const message = this.conversationMessages.get(messageId);
    if (
      message === undefined ||
      message.conversationId !== conversationId ||
      message.provider !== "email" ||
      message.externalThreadId === null ||
      message.externalThreadId === undefined
    ) {
      throw new Cp2Error(404, "email_reply_target_not_found", "Email reply target was not found.");
    }
    return message;
  }

  private resolveMessagingCustomer(
    businessId: string,
    input: {
      customerId: string | undefined;
      customerName: string | undefined;
      conversationId: string | undefined;
    }
  ): CustomerSummary {
    if (input.customerId !== undefined)
      return this.deps.requireCustomer(businessId, input.customerId);
    if (input.conversationId !== undefined) {
      const conversation = this.conversations.get(input.conversationId);
      if (conversation?.activeShopId !== businessId) {
        throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
      }
      const customerIds = new Set(
        [...this.conversationChannels.values()]
          .filter((channel) => channel.conversationId === input.conversationId)
          .map((channel) => this.platformIdentities.get(channel.platformIdentityId)?.customerId)
          .filter(
            (customerId): customerId is string => customerId !== null && customerId !== undefined
          )
      );
      if (customerIds.size === 1) {
        return this.deps.requireCustomer(businessId, [...customerIds][0] as string);
      }
    }
    const name = input.customerName?.trim().toLocaleLowerCase();
    if (name) {
      const matches = [...this.deps.customers.values()].filter(
        (customer) =>
          customer.businessId === businessId && customer.name.toLocaleLowerCase() === name
      );
      if (matches.length === 1) return matches[0] as CustomerSummary;
      if (matches.length > 1) {
        throw new Cp2Error(409, "customer_ambiguous", "More than one customer has that name.");
      }
    }
    throw new Cp2Error(404, "customer_not_found", "Customer was not found.");
  }

  private channelEndpoints(input: {
    businessId: string;
    customerId: string | null;
    conversationId: string | null;
  }): ChannelEndpointSummary[] {
    return [...this.conversationChannels.values()]
      .filter((channel) => {
        if (channel.businessId !== input.businessId) return false;
        if (input.conversationId !== null && channel.conversationId !== input.conversationId) {
          return false;
        }
        const identity = this.platformIdentities.get(channel.platformIdentityId);
        return input.customerId === null || identity?.customerId === input.customerId;
      })
      .flatMap((channel) => {
        const identity = this.platformIdentities.get(channel.platformIdentityId);
        return identity === undefined ? [] : [this.deps.channelGateway.endpoint(channel, identity)];
      });
  }

  private persistOutboundChannelMessage(input: {
    endpoint: ChannelEndpointSummary;
    authorId: string;
    text: string;
    subject: string | null;
    replyToMessageId: string | null;
    externalThreadId: string | null;
    attachments: ConversationAttachment[];
    idempotencyKey: string;
    now: Date;
  }): ConversationMessageSummary {
    const conversation = this.conversations.get(input.endpoint.conversationId);
    if (conversation === undefined || conversation.activeShopId !== input.endpoint.businessId) {
      throw new Cp2Error(404, "conversation_not_found", "Conversation was not found.");
    }
    const message: ConversationMessageSummary = {
      id: randomUUID(),
      conversationId: conversation.id,
      clientMessageId: `channel-${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      author: "user",
      authorId: input.authorId,
      content: {
        type: "text",
        text: input.text,
        ...(input.attachments.length === 0 ? {} : { attachments: input.attachments })
      },
      status: "queued",
      queuedAt: input.now.toISOString(),
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failureCode: null,
      retryCount: 0,
      nextRetryAt: null,
      selectedChannel: providerToMessageChannel(input.endpoint.provider),
      actualChannel: null,
      providerMessageId: null,
      subject: input.subject,
      externalThreadId: input.externalThreadId,
      senderAddress:
        input.endpoint.executionMailboxId === null ||
        input.endpoint.executionMailboxId === undefined
          ? null
          : (this.connectedMailboxes.get(input.endpoint.executionMailboxId)?.address ?? null),
      recipientAddresses:
        input.endpoint.provider === "email" ? [input.endpoint.externalUserId] : [],
      ccAddresses: [],
      bccAddresses: [],
      provider: input.endpoint.provider,
      direction: "outbound",
      externalConversationId: input.endpoint.externalConversationId,
      channelIdentityId: input.endpoint.channelIdentityId,
      importedSource: null,
      importedExternalId: null,
      consentRecordId: null,
      editedAt: null,
      deletedAt: null,
      replyToMessageId: input.replyToMessageId,
      forwardedFromMessageId: null,
      reactions: [],
      clientTimestamp: input.now.toISOString(),
      createdAt: input.now.toISOString()
    };
    validateConversationMessageContent(message.content);
    this.conversationMessages.set(message.id, message);
    this.messageByClientId.set(`${conversation.id}:${message.clientMessageId}`, message.id);
    this.messageByIdempotencyKey.set(`${conversation.id}:${message.idempotencyKey}`, message.id);
    const attempt: MessageDeliveryAttemptSummary = {
      id: randomUUID(),
      accountId: conversation.accountId,
      conversationId: conversation.id,
      messageId: message.id,
      channel: providerToMessageChannel(input.endpoint.provider),
      provider: input.endpoint.provider,
      attemptNumber: 1,
      requestedAt: input.now.toISOString(),
      respondedAt: null,
      result: "transient_failure",
      normalizedFailureCode: null,
      providerResponseReference: null
    };
    this.messageDeliveryAttempts.set(attempt.id, attempt);
    this.recordConversationSyncForParticipants(
      conversation.id,
      "conversation_messages",
      message.id,
      message,
      input.now
    );
    return message;
  }

  private finishChannelDeliveryAttempt(
    message: ConversationMessageSummary,
    result: MessageDeliveryAttemptSummary["result"],
    failureCode: string | null,
    now: Date
  ): void {
    const attempt = [...this.messageDeliveryAttempts.values()].find(
      (candidate) => candidate.messageId === message.id && candidate.attemptNumber === 1
    );
    if (attempt) {
      this.messageDeliveryAttempts.set(attempt.id, {
        ...attempt,
        respondedAt: now.toISOString(),
        result,
        normalizedFailureCode: failureCode,
        providerResponseReference: message.providerMessageId ?? null
      });
    }
    this.recordConversationSyncForParticipants(
      message.conversationId,
      "conversation_messages",
      message.id,
      message,
      now
    );
  }

  private channelError(error: unknown): Cp2Error {
    if (!(error instanceof ChannelGatewayError)) {
      return new Cp2Error(503, "CHANNEL_SEND_FAILED", "Channel delivery failed.");
    }
    const status =
      error.code === "CHANNEL_RATE_LIMITED"
        ? 429
        : error.code === "CHANNEL_WEBHOOK_INVALID" ||
            error.code === "EMAIL_REAUTHORIZATION_REQUIRED" ||
            error.code === "PROVIDER_AUTH_EXPIRED"
          ? 401
          : error.code === "CHANNEL_IDENTITY_NOT_FOUND"
            ? 404
            : error.retryable
              ? 503
              : 409;
    return new Cp2Error(status, error.code, error.message);
  }
}

function workspaceAttachmentsFromToolResult(value: unknown): WorkspaceDeliverResult["attachments"] {
  if (value === null || typeof value !== "object") return [];
  const result = value as Partial<WorkspaceDeliverResult>;
  if (result.ok !== true || result.delivered !== true || result.attachment?.source !== "managed") {
    return [];
  }
  if (
    Array.isArray(result.attachments) &&
    result.attachments.length > 0 &&
    result.attachments.every((attachment) => attachment.source === "managed")
  ) {
    return result.attachments;
  }
  return [result.attachment];
}

function sanitizeWorkspaceAttachmentCaption(value: string | undefined): string | null {
  if (value === undefined) return null;
  const caption = [...value.trim()]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .slice(0, 240);
  return caption || null;
}

/** Stable UUID-shaped server identity; legacy conversations are always reused before calling. */
function stableConversationId(key: string): string {
  const hex = createHash("sha256").update(`grogoni:conversation:v1:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
