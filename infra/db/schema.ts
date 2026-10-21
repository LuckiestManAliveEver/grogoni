import {
  bigserial,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ACCOUNT_SYNC_COLLECTIONS } from "../../packages/shared-types/src/index.js";

const accountSyncCollectionValues = sql.raw(
  ACCOUNT_SYNC_COLLECTIONS.map((collection) => `'${collection}'`).join(", ")
);

export const businessEvents = pgTable("business_events", {
  id: uuid("id").primaryKey(),
  aggregateId: text("aggregate_id").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  actorId: text("actor_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  risk: text("risk").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull()
});

export const syncQueue = pgTable("sync_queue", {
  id: uuid("id").primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => businessEvents.id),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  primaryAuthChannel: text("primary_auth_channel").notNull(),
  primaryAuthDestination: text("primary_auth_destination").notNull(),
  identityLevel: text("identity_level").notNull().default("strong"),
  status: text("status").notNull().default("active"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    displayName: text("display_name").notNull(),
    language: text("language").notNull(),
    phoneNumberE164: text("phone_number_e164"),
    phoneCountryCode: text("phone_country_code"),
    phoneNationalNumber: text("phone_national_number"),
    phoneVerificationStatus: text("phone_verification_status"),
    phoneAddedAt: timestamp("phone_added_at", { withTimezone: true }),
    phoneUpdatedAt: timestamp("phone_updated_at", { withTimezone: true }),
    phoneSource: text("phone_source"),
    publicPhoneEnabled: boolean("public_phone_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    accountUnique: uniqueIndex("users_account_id_unique_idx").on(table.accountId),
    phoneNumberUnique: uniqueIndex("users_phone_number_e164_unique_idx")
      .on(table.phoneNumberE164)
      .where(sql`${table.phoneNumberE164} is not null`)
  })
);

export const identityProviders = pgTable("identity_providers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  authorizationUrl: text("authorization_url").notNull(),
  tokenUrl: text("token_url").notNull(),
  userInfoUrl: text("user_info_url"),
  scopes: jsonb("scopes").notNull(),
  pkce: boolean("pkce").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const userIdentities = pgTable("user_identities", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  providerId: text("provider_id")
    .notNull()
    .references(() => identityProviders.id),
  providerSubject: text("provider_subject").notNull(),
  email: text("email"),
  displayName: text("display_name"),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  encryptedIdToken: text("encrypted_id_token"),
  tokenType: text("token_type"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const oauthSessions = pgTable("oauth_sessions", {
  id: uuid("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => identityProviders.id),
  accountId: uuid("account_id").references(() => accounts.id),
  stateHash: text("state_hash").notNull(),
  csrfHash: text("csrf_hash").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    grogoniId: text("grogoni_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    grogoniIdUnique: uniqueIndex("businesses_grogoni_id_unique_idx").on(table.grogoniId)
  })
);

export const businessMemberships = pgTable(
  "business_memberships",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    oneOwnedStorePerUser: uniqueIndex("business_memberships_owner_user_unique_idx")
      .on(table.userId)
      .where(sql`${table.role} = 'owner'`)
  })
);

export const otpChallenges = pgTable("otp_challenges", {
  id: uuid("id").primaryKey(),
  channel: text("channel").notNull(),
  destination: text("destination").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const accountIdentities = pgTable(
  "account_identities",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    displayValue: text("display_value").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    identityUnique: uniqueIndex("account_identities_normalized_unique_idx").on(
      table.type,
      table.normalizedValue
    )
  })
);

export const passwordCredentials = pgTable("password_credentials", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const authTransactions = pgTable("auth_transactions", {
  id: uuid("id").primaryKey(),
  purpose: text("purpose").notNull(),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  identifierType: text("identifier_type"),
  identifierHash: text("identifier_hash"),
  providerChallengeId: text("provider_challenge_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const mfaFactors = pgTable("mfa_factors", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  factorType: text("factor_type").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true })
});

export const recoveryCodes = pgTable("recovery_codes", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name").notNull(),
  platform: text("platform").notNull(),
  browserOrApp: text("browser_or_app").notNull(),
  userAgentHash: text("user_agent_hash").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  sessionFamilyId: uuid("session_family_id").notNull(),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  revocationReason: text("revocation_reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  pinVerifiedAt: timestamp("pin_verified_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

const nativeEnvelopeColumns = () => ({
  businessId: text("business_id"),
  accountId: text("account_id"),
  userId: text("user_id"),
  parentId: text("parent_id"),
  record: jsonb("record").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const nativeRuntimeAgents = pgTable("cp2_native_runtime_agents", {
  entityId: text("entity_id").primaryKey(),
  ...nativeEnvelopeColumns()
});

export const nativeRuntimeModels = pgTable("cp2_native_runtime_models", {
  entityId: text("entity_id").primaryKey(),
  ...nativeEnvelopeColumns()
});

export const nativeExecutionHosts = pgTable("cp2_native_execution_hosts", {
  entityId: text("entity_id").primaryKey(),
  ...nativeEnvelopeColumns()
});

export const nativeModelInstallations = pgTable("cp2_native_model_installations", {
  entityId: text("entity_id").primaryKey(),
  ...nativeEnvelopeColumns()
});

export const nativeRuntimeBindings = pgTable(
  "cp2_native_runtime_bindings",
  {
    entityId: text("entity_id").primaryKey(),
    ...nativeEnvelopeColumns()
  },
  (table) => ({
    businessAgent: index("cp2_native_runtime_bindings_business_agent_idx").on(
      table.businessId,
      table.parentId
    )
  })
);

export const nativeRuntimeBindingModels = pgTable(
  "cp2_native_runtime_binding_models",
  {
    entityId: text("entity_id").primaryKey(),
    ...nativeEnvelopeColumns()
  },
  (table) => ({
    binding: index("cp2_native_runtime_binding_models_binding_idx").on(table.parentId)
  })
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").notNull(),
    activeShopId: uuid("active_shop_id").references(() => businesses.id),
    runtimeBindingId: text("runtime_binding_id").references(() => nativeRuntimeBindings.entityId, {
      onDelete: "restrict"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    accountUpdated: index("conversations_account_updated_idx").on(table.accountId, table.updatedAt)
  })
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    accountId: uuid("account_id").references(() => accounts.id),
    businessId: uuid("business_id").references(() => businesses.id),
    agentId: text("agent_id"),
    externalIdentityId: text("external_identity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    conversation: index("conversation_participants_conversation_idx").on(table.conversationId)
  })
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    clientMessageId: text("client_message_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    author: text("author").notNull(),
    authorId: text("author_id").notNull(),
    content: jsonb("content").notNull(),
    status: text("status").notNull().default("delivered"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    selectedChannel: text("selected_channel").notNull().default("grogoni"),
    actualChannel: text("actual_channel"),
    providerMessageId: text("provider_message_id"),
    provider: text("provider").notNull(),
    direction: text("direction").notNull(),
    externalConversationId: text("external_conversation_id"),
    channelIdentityId: text("channel_identity_id"),
    importedSource: text("imported_source"),
    importedExternalId: text("imported_external_id"),
    consentRecordId: uuid("consent_record_id"),
    clientTimestamp: timestamp("client_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    clientMessageUnique: uniqueIndex("conversation_messages_client_message_unique_idx").on(
      table.conversationId,
      table.clientMessageId
    ),
    idempotencyUnique: uniqueIndex("conversation_messages_idempotency_idx").on(
      table.conversationId,
      table.idempotencyKey
    ),
    conversationCreated: index("conversation_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt
    )
  })
);

export const messageDeliveryAttempts = pgTable(
  "message_delivery_attempts",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    result: text("result").notNull(),
    normalizedFailureCode: text("normalized_failure_code"),
    providerResponseReference: text("provider_response_reference")
  },
  (table) => ({
    accountRequested: index("message_delivery_attempts_account_requested_idx").on(
      table.accountId,
      table.requestedAt
    ),
    messageAttempt: uniqueIndex("message_delivery_attempts_message_channel_attempt_idx").on(
      table.messageId,
      table.channel,
      table.attemptNumber
    )
  })
);

export const mcpAccessTokens = pgTable(
  "mcp_access_tokens",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBySessionId: uuid("created_by_session_id"),
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    scopes: text("scopes").array().notNull(),
    shopId: uuid("shop_id").references(() => businesses.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => ({
    accountUpdated: index("mcp_access_tokens_account_updated_idx").on(
      table.accountId,
      table.createdAt
    )
  })
);

export const grogoniSessionContexts = pgTable("grogoni_session_contexts", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  activeShopId: uuid("active_shop_id").references(() => businesses.id),
  activeModelId: text("active_model_id").notNull(),
  mode: text("mode").notNull(),
  activeSurface: text("active_surface").notNull(),
  sessionVersion: integer("session_version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const accountSyncChanges = pgTable(
  "account_sync_changes",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    cursor: uuid("cursor").notNull(),
    collection: text("collection").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    shopId: uuid("shop_id"),
    entity: jsonb("entity"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    tombstoneExpiresAt: timestamp("tombstone_expires_at", { withTimezone: true })
  },
  (table) => ({
    primary: primaryKey({ columns: [table.accountId, table.sequence] }),
    cursorUnique: uniqueIndex("account_sync_changes_cursor_unique_idx").on(table.cursor),
    validCollection: check(
      "account_sync_changes_collection_check",
      sql`${table.collection} in (${accountSyncCollectionValues})`
    ),
    validPayload: check(
      "account_sync_changes_valid_payload_check",
      sql`(${table.operation} = 'upsert' and ${table.entity} is not null and ${table.tombstoneExpiresAt} is null) or (${table.operation} = 'delete' and ${table.entity} is null and ${table.tombstoneExpiresAt} is not null)`
    )
  })
);

export const accountPinHashes = pgTable("account_pin_hashes", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id),
  pinHash: text("pin_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const deviceTrust = pgTable(
  "device_trust",
  {
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    deviceId: text("device_id").notNull(),
    level: text("level").notNull(),
    reason: text("reason"),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedByType: text("updated_by_type").notNull().default("user"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.businessId, table.userId, table.deviceId] }),
    updatedByActor: check(
      "device_trust_updated_by_actor_check",
      sql`(${table.updatedByType} = 'user' and ${table.updatedBy} is not null)
        or (${table.updatedByType} in ('system', 'service') and ${table.updatedBy} is null)`
    ),
    businessUser: index("device_trust_business_user_idx").on(
      table.businessId,
      table.userId,
      table.updatedAt
    )
  })
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    name: text("name").notNull(),
    sku: text("sku"),
    aliases: text("aliases").array().notNull().default([]),
    unit: text("unit").notNull(),
    quantity: numeric("quantity").notNull(),
    buyingPrice: numeric("buying_price"),
    sellingPrice: numeric("selling_price"),
    primaryMediaId: text("primary_media_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    businessSkuUnique: uniqueIndex("products_business_sku_unique_idx").on(
      table.businessId,
      table.sku
    ),
    businessUpdated: index("products_business_updated_idx").on(table.businessId, table.updatedAt)
  })
);

function platformCommerceRecordTable(name: string) {
  return pgTable(name, {
    entityId: text("entity_id").primaryKey(),
    businessId: text("business_id"),
    accountId: text("account_id"),
    userId: text("user_id"),
    parentId: text("parent_id"),
    record: jsonb("record").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  });
}

export const platformIdentities = platformCommerceRecordTable("platform_identities");
export const conversationChannels = platformCommerceRecordTable("conversation_channels");
export const providerUpdateReceipts = platformCommerceRecordTable("provider_update_receipts");
export const channelIdentityLinkGrants = platformCommerceRecordTable(
  "channel_identity_link_grants"
);
export const nativeSmsDevices = platformCommerceRecordTable("native_sms_devices");
export const nativeSmsDeviceCommands = platformCommerceRecordTable("native_sms_device_commands");
export const connectedMailboxes = platformCommerceRecordTable("connected_mailboxes");
export const connectedMailboxOAuthSessions = platformCommerceRecordTable(
  "connected_mailbox_oauth_sessions"
);
export const customerRuntimeCapabilities = platformCommerceRecordTable(
  "customer_runtime_capabilities"
);
export const productMedia = platformCommerceRecordTable("product_media");
export const productCaptureJobs = platformCommerceRecordTable("product_capture_jobs");
export const statusBroadcasts = platformCommerceRecordTable("status_broadcasts");
export const buyOrders = platformCommerceRecordTable("buy_orders");
export const statusOrders = platformCommerceRecordTable("status_orders");
export const unifiedCheckouts = platformCommerceRecordTable("unified_checkouts");
export const buyerShoppingSessions = platformCommerceRecordTable("buyer_shopping_sessions");
export const canonicalContacts = platformCommerceRecordTable("cp2_contacts");
export const supplierContactRelationships = platformCommerceRecordTable(
  "cp2_supplier_contact_relationships"
);
export const purchasePriceHistory = platformCommerceRecordTable("cp2_purchase_price_history");
export const purchaseRecords = platformCommerceRecordTable("cp2_purchase_records");
export const saleRecords = platformCommerceRecordTable("cp2_sale_records");
export const locations = platformCommerceRecordTable("cp2_locations");
export const deliveryRoutes = platformCommerceRecordTable("cp2_delivery_routes");
export const deliveryRouteStops = platformCommerceRecordTable("cp2_delivery_route_stops");

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    linkedAccountId: uuid("linked_account_id").references(() => accounts.id, {
      onDelete: "set null"
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    businessContact: index("customers_business_contact_idx").on(
      table.businessId,
      table.phone,
      table.email
    )
  })
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    name: text("name").notNull(),
    phone: text("phone"),
    linkedPhonebookContactId: text("linked_phonebook_contact_id"),
    linkedPhonebookContactName: text("linked_phonebook_contact_name"),
    email: text("email"),
    notes: text("notes"),
    salesAgentCount: integer("sales_agent_count").notNull().default(0),
    purchaseReceiptCount: integer("purchase_receipt_count").notNull().default(0),
    lastPurchaseDate: timestamp("last_purchase_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    businessUpdated: index("suppliers_business_updated_idx").on(table.businessId, table.updatedAt)
  })
);

export const salesAgents = pgTable(
  "sales_agents",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    supplierName: text("supplier_name").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    linkedPhonebookContactId: text("linked_phonebook_contact_id"),
    linkedPhonebookContactName: text("linked_phonebook_contact_name"),
    notes: text("notes"),
    receiptsHandled: integer("receipts_handled").notNull().default(0),
    lastTransactionDate: timestamp("last_transaction_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    businessSupplier: index("sales_agents_business_supplier_idx").on(
      table.businessId,
      table.supplierId,
      table.name
    ),
    businessPhone: index("sales_agents_business_phone_idx").on(table.businessId, table.phone)
  })
);

export const supplierContactLinks = pgTable(
  "supplier_contact_links",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    linkType: text("link_type").notNull(),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    salesAgentId: uuid("sales_agent_id").references(() => salesAgents.id),
    networkNodeId: text("network_node_id").notNull(),
    contactName: text("contact_name").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    supplierUnique: uniqueIndex("supplier_contact_links_supplier_unique_idx").on(
      table.businessId,
      table.supplierId,
      table.networkNodeId
    ),
    agentUnique: uniqueIndex("supplier_contact_links_agent_unique_idx").on(
      table.businessId,
      table.salesAgentId,
      table.networkNodeId
    )
  })
);

export const inventoryMovements = pgTable("inventory_movements", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  type: text("type").notNull(),
  quantityBefore: numeric("quantity_before").notNull(),
  quantityAfter: numeric("quantity_after").notNull(),
  delta: numeric("delta").notNull(),
  reason: text("reason").notNull(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  invoiceNumber: text("invoice_number").notNull(),
  status: text("status").notNull(),
  customerId: uuid("customer_id").references(() => customers.id),
  customerName: text("customer_name"),
  subtotal: numeric("subtotal").notNull(),
  taxRate: numeric("tax_rate").notNull(),
  taxTotal: numeric("tax_total").notNull(),
  total: numeric("total").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").primaryKey(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  productName: text("product_name").notNull(),
  quantity: numeric("quantity").notNull(),
  unitPrice: numeric("unit_price").notNull(),
  lineTotal: numeric("line_total").notNull()
});

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    customerId: uuid("customer_id").references(() => customers.id),
    method: text("method").notNull(),
    amount: numeric("amount").notNull(),
    reference: text("reference"),
    note: text("note"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    businessInvoice: index("payments_business_invoice_idx").on(
      table.businessId,
      table.invoiceId,
      table.createdAt
    )
  })
);

export const receiptOCRJobs = pgTable(
  "receipt_ocr_jobs",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    tenantId: text("tenant_id").notNull(),
    shopId: text("shop_id").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    status: text("status").notNull(),
    sourceFileName: text("source_file_name").notNull(),
    contentType: text("content_type").notNull(),
    engine: text("engine").notNull(),
    engineVersion: text("engine_version").notNull(),
    modelVersion: text("model_version").notNull(),
    profile: text("profile").notNull(),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    languageHints: jsonb("language_hints").notNull().default([]),
    fullText: text("full_text").notNull().default(""),
    averageConfidence: numeric("average_confidence").notNull().default("0"),
    warnings: jsonb("warnings").notNull().default([]),
    fieldEvidence: jsonb("field_evidence").notNull().default([]),
    structuredExtraction: jsonb("structured_extraction").notNull().default({}),
    contactMatchingResult: jsonb("contact_matching_result").notNull().default({}),
    supplierCandidates: jsonb("supplier_candidates").notNull().default([]),
    salesAgentCandidates: jsonb("sales_agent_candidates").notNull().default([]),
    supplierName: text("supplier_name"),
    salesAgentName: text("sales_agent_name"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    businessStatus: index("receipt_ocr_jobs_business_status_idx").on(
      table.businessId,
      table.status,
      table.updatedAt
    )
  })
);

export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    supplierName: text("supplier_name").notNull(),
    salesAgentId: uuid("sales_agent_id").references(() => salesAgents.id),
    salesAgentName: text("sales_agent_name"),
    receiptDate: timestamp("receipt_date", { withTimezone: true }).notNull(),
    total: numeric("total").notNull(),
    sourceFileName: text("source_file_name"),
    ocrJobId: uuid("ocr_job_id").references(() => receiptOCRJobs.id),
    imageStored: boolean("image_stored").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    businessSupplierDate: index("purchase_receipts_business_supplier_date_idx").on(
      table.businessId,
      table.supplierId,
      table.receiptDate
    ),
    businessAgentDate: index("purchase_receipts_business_agent_date_idx").on(
      table.businessId,
      table.salesAgentId,
      table.receiptDate
    )
  })
);

export const receiptLineItems = pgTable(
  "receipt_line_items",
  {
    id: uuid("id").primaryKey(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => purchaseReceipts.id),
    name: text("name").notNull(),
    quantity: numeric("quantity").notNull(),
    unitPrice: numeric("unit_price").notNull(),
    total: numeric("total").notNull()
  },
  (table) => ({
    receipt: index("receipt_line_items_receipt_idx").on(table.receiptId)
  })
);

export const databaseBackupRuns = pgTable(
  "database_backup_runs",
  {
    id: uuid("id").primaryKey(),
    status: text("status").notNull(),
    backupFile: text("backup_file").notNull(),
    uploadConfigured: boolean("upload_configured").notNull(),
    retentionDays: integer("retention_days").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorMessage: text("error_message")
  },
  (table) => ({
    statusStarted: index("database_backup_runs_status_started_idx").on(
      table.status,
      table.startedAt
    )
  })
);

export const databaseRestoreDrills = pgTable(
  "database_restore_drills",
  {
    id: uuid("id").primaryKey(),
    backupFile: text("backup_file").notNull(),
    status: text("status").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    notes: text("notes")
  },
  (table) => ({
    checked: index("database_restore_drills_checked_idx").on(table.checkedAt)
  })
);

export const databaseHealthChecks = pgTable(
  "database_health_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    status: text("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    latestMigration: text("latest_migration"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    errorMessage: text("error_message")
  },
  (table) => ({
    checked: index("database_health_checks_checked_idx").on(table.checkedAt)
  })
);

export const invoiceNumberCounters = pgTable("invoice_number_counters", {
  businessId: uuid("business_id")
    .primaryKey()
    .references(() => businesses.id),
  nextNumber: integer("next_number").notNull()
});

export const offlineSyncQueue = pgTable("offline_sync_queue", {
  id: uuid("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => users.id),
  mutationType: text("mutation_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  clientCreatedAt: timestamp("client_created_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  result: jsonb("result"),
  conflict: jsonb("conflict")
});

export const offlineCacheSnapshots = pgTable("offline_cache_snapshots", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  source: text("source").notNull()
});

export const documentImportSources = pgTable("document_import_sources", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const documentImportJobs = pgTable("document_import_jobs", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => documentImportSources.id),
  target: text("target").notNull(),
  status: text("status").notNull(),
  fieldMapping: jsonb("field_mapping").notNull(),
  confirmedCount: integer("confirmed_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true })
});

export const documentImportRows = pgTable("document_import_rows", {
  id: uuid("id").primaryKey(),
  importJobId: uuid("import_job_id")
    .notNull()
    .references(() => documentImportJobs.id),
  rowNumber: integer("row_number").notNull(),
  raw: jsonb("raw").notNull(),
  mapped: jsonb("mapped").notNull(),
  errors: jsonb("errors").notNull(),
  warnings: jsonb("warnings").notNull(),
  selected: integer("selected").notNull().default(0)
});

export const cp2StoreSnapshots = pgTable("cp2_store_snapshots", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const cp2VocabularyEntries = pgTable(
  "cp2_vocabulary_entries",
  {
    entityId: text("entity_id").primaryKey(),
    businessId: text("business_id").notNull(),
    accountId: text("account_id").notNull(),
    userId: text("user_id"),
    record: jsonb("record").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    surfaceUnique: uniqueIndex("cp2_vocabulary_entries_surface_idx").on(
      table.businessId,
      sql`(${table.record} ->> 'surfaceForm')`
    ),
    review: index("cp2_vocabulary_entries_review_idx").on(
      table.businessId,
      sql`(${table.record} ->> 'status')`,
      sql`(${table.record} ->> 'createdAt')`
    )
  })
);

export const cp2VocabularyOccurrences = pgTable(
  "cp2_vocabulary_occurrences",
  {
    entityId: text("entity_id").primaryKey(),
    businessId: text("business_id").notNull(),
    accountId: text("account_id").notNull(),
    userId: text("user_id"),
    parentId: text("parent_id").notNull(),
    record: jsonb("record").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    entry: index("cp2_vocabulary_occurrences_entry_idx").on(
      table.parentId,
      sql`(${table.record} ->> 'createdAt')`
    )
  })
);
