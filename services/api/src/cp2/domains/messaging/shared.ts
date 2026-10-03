import { createHash } from "node:crypto";
import type {
  BusinessSummary,
  ChannelProvider,
  ConnectedMailboxProvider,
  ConnectedMailboxSummary,
  ConversationMessageContent,
  ConversationMessageSummary,
  E2eePublicKey,
  InvoiceSummary,
  NativeSmsDeviceCapability,
  NativeSmsDeviceReadiness,
  NativeSmsDeviceSummary,
  RuntimeTurnResult
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { normalizeRequiredBoundedText } from "../../text-normalization.js";
import { normalizeInternationalOwnerPhoneNumber } from "../../phone-identity.js";
import { EmailProviderClientError } from "../../../messaging/email-provider-client.js";
import { normalizeEmailIdentity } from "../../email-identity.js";
export type { CustomerRuntimeCapabilityRecord } from "../../domain-contracts.js";
export { normalizeEmailIdentity } from "../../email-identity.js";
export { requirePublicStorefrontBusiness } from "../../storefront-access.js";

export interface AgentConversationMessageResult {
  message: ConversationMessageSummary;
  agentMessage: ConversationMessageSummary | null;
  runtime: RuntimeTurnResult | null;
  processing: {
    correlationId: string;
    status: "completed" | "failed";
    errorCode: string | null;
    retryable: boolean;
  };
}

export interface PublicStorefrontSessionResult {
  conversationId: string;
  capabilityToken: string;
  expiresAt: string;
}

export interface MessageNotificationDeliveryRunSummary {
  checked: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

export interface AppUpdateBroadcastSummary {
  targeted: number;
  sent: number;
  expired: number;
  failed: number;
}

export interface ConnectedMailboxBackgroundSyncSummary {
  checked: number;
  synchronized: number;
  ingested: number;
  deduplicated: number;
  filtered: number;
  failed: number;
}

export interface ConnectedMailboxOAuthSessionRecord {
  id: string;
  accountId: string;
  businessId: string;
  provider: ConnectedMailboxProvider;
  stateHash: string;
  encryptedCodeVerifier: string;
  redirectUri: string;
  returnUrl: string;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface ConnectedMailboxRecord extends ConnectedMailboxSummary {
  accountId: string;
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: string | null;
  tokenType: string;
  scope: string;
}

export interface MessageNotificationDelivery {
  id: string;
  messageId: string;
  conversationId: string;
  accountId: string;
  channel: "push" | "email";
  targetId: string;
  destination: string | null;
  status: "pending" | "failed" | "sent" | "dead_letter";
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptedAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const recoverableAgentModelChatErrorCodes = new Set([
  "AGENT_MODEL_NOT_CONFIGURED",
  "AGENT_MODEL_UNAVAILABLE",
  "BROWSER_RUNTIME_DISABLED",
  "BRIDGE_UNAVAILABLE",
  "MODEL_HEALTH_CHECK_FAILED",
  "MODEL_UNAVAILABLE",
  "RUNTIME_UNAVAILABLE"
]);

export function isRecoverableAgentModelChatError(error: unknown): error is Cp2Error {
  return error instanceof Cp2Error && recoverableAgentModelChatErrorCodes.has(error.code);
}

export interface ChannelIdentityLinkGrantRecord {
  id: string;
  businessId: string;
  customerId: string;
  conversationId: string | null;
  provider: ChannelProvider;
  tokenHash: string;
  automaticRepliesEnabled: boolean;
  expiresAt: string;
  consumedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export const nativeSmsOnlineWindowMs = 2 * 60_000;
export const nativeSmsCommandTtlMs = 24 * 60 * 60_000;
export const mailboxOAuthSessionTtlMs = 10 * 60_000;

export function isEmailReauthorizationError(error: unknown): error is EmailProviderClientError {
  return (
    error instanceof EmailProviderClientError && error.code === "EMAIL_REAUTHORIZATION_REQUIRED"
  );
}

export function normalizeStoredEmailIdentity(value: string | null): string | null {
  if (value === null) return null;
  try {
    return normalizeEmailIdentity(value);
  } catch {
    return null;
  }
}

export function normalizeEmailSubject(value: string): string {
  return normalizeRequiredBoundedText(value.replace(/^(?:\s*re:\s*)+/giu, "Re: "), "subject", 200);
}

export function normalizeAbsoluteHttpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
      throw new Error("invalid protocol");
    }
    return url.toString();
  } catch {
    throw new Cp2Error(400, `${label}_invalid`, `${label} must be an absolute HTTPS URL.`);
  }
}

export function mailboxScopeAllows(
  provider: ConnectedMailboxProvider,
  scope: string,
  capability: "send" | "receive"
): boolean {
  const scopes = new Set(scope.split(/\s+/u).map((item) => item.toLowerCase()));
  if (provider === "gmail") {
    return capability === "send"
      ? scopes.has("https://www.googleapis.com/auth/gmail.send") ||
          scopes.has("https://www.googleapis.com/auth/gmail.modify") ||
          scopes.has("https://mail.google.com/")
      : scopes.has("https://www.googleapis.com/auth/gmail.readonly") ||
          scopes.has("https://www.googleapis.com/auth/gmail.modify") ||
          scopes.has("https://mail.google.com/");
  }
  return capability === "send" ? scopes.has("mail.send") : scopes.has("mail.read");
}

export function connectedMailboxView(mailbox: ConnectedMailboxRecord): ConnectedMailboxSummary {
  return {
    id: mailbox.id,
    businessId: mailbox.businessId,
    address: mailbox.address,
    provider: mailbox.provider,
    providerAccountId: mailbox.providerAccountId,
    status: mailbox.status,
    readiness: mailbox.readiness,
    canSend: mailbox.canSend,
    canReceive: mailbox.canReceive,
    isDefault: mailbox.isDefault,
    ingestUnknownSenders: mailbox.ingestUnknownSenders,
    automaticReplyEnabled: mailbox.automaticReplyEnabled,
    automaticReplyText: mailbox.automaticReplyText,
    connectedAt: mailbox.connectedAt,
    lastSyncAt: mailbox.lastSyncAt,
    lastErrorCode: mailbox.lastErrorCode,
    disconnectedAt: mailbox.disconnectedAt,
    updatedAt: mailbox.updatedAt
  };
}

export function nativeSmsReadinessFromRegistration(input: {
  roleAvailable: boolean;
  roleGranted: boolean;
  sendPermissionGranted: boolean;
  receivePermissionGranted: boolean;
  simReady: boolean;
  lastErrorCode: string | null;
}): NativeSmsDeviceReadiness {
  if (!input.roleAvailable) return "unavailable";
  if (
    !input.roleGranted ||
    !input.sendPermissionGranted ||
    !input.receivePermissionGranted ||
    !input.simReady
  ) {
    return "setup_required";
  }
  if (input.lastErrorCode !== null) return "error";
  return "ready";
}

export function nativeSmsDeviceRequirement(device: NativeSmsDeviceSummary): string | null {
  if (device.readiness === "ready") return null;
  if (device.readiness === "offline") return "The preferred Android SMS device is offline.";
  if (!device.roleAvailable) return "The Android SMS role is unavailable on this device.";
  if (!device.roleGranted) return "Grant Grogoni the Android default SMS role.";
  if (!device.sendPermissionGranted || !device.receivePermissionGranted) {
    return "Grant the required Android SMS permissions after granting the SMS role.";
  }
  if (!device.simReady) return "An active, deterministically selected SIM is required.";
  return device.lastErrorCode ?? "Native SMS setup requires attention on the Android device.";
}

export function nativeSmsReadinessErrorCode(
  device: NativeSmsDeviceSummary
):
  | "SMS_DEVICE_UNAVAILABLE"
  | "SMS_SETUP_REQUIRED"
  | "SMS_PERMISSION_REQUIRED"
  | "SMS_ROLE_REQUIRED"
  | "SMS_SIM_UNAVAILABLE"
  | "SMS_SIM_SELECTION_REQUIRED"
  | null {
  if (device.readiness === "ready" || device.readiness === "offline") return null;
  if (!device.roleAvailable) return "SMS_DEVICE_UNAVAILABLE";
  if (!device.roleGranted) return "SMS_ROLE_REQUIRED";
  if (!device.sendPermissionGranted || !device.receivePermissionGranted) {
    return "SMS_PERMISSION_REQUIRED";
  }
  if (!device.simReady) {
    return device.lastErrorCode === "SMS_SIM_SELECTION_REQUIRED"
      ? "SMS_SIM_SELECTION_REQUIRED"
      : "SMS_SIM_UNAVAILABLE";
  }
  return "SMS_SETUP_REQUIRED";
}

export function nativeSmsMissingCapabilityCode(
  device: NativeSmsDeviceSummary,
  capability: NativeSmsDeviceCapability
): string {
  if (!device.roleGranted) return "SMS_ROLE_REQUIRED";
  if (
    (capability === "native_sms_send" && !device.sendPermissionGranted) ||
    (capability === "native_sms_receive" && !device.receivePermissionGranted)
  ) {
    return "SMS_PERMISSION_REQUIRED";
  }
  if (!device.simReady) return "SMS_SIM_UNAVAILABLE";
  return "SMS_SETUP_REQUIRED";
}

export function normalizeNativeSmsSubscriptionId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Cp2Error(400, "sms_subscription_invalid", "SMS subscription id is invalid.");
  }
  return value;
}

export function normalizeNativeSmsOccurredAt(value: string, now: Date): string {
  const occurredAt = Date.parse(value);
  if (
    !Number.isFinite(occurredAt) ||
    occurredAt > now.getTime() + 5 * 60_000 ||
    occurredAt < now.getTime() - 30 * 24 * 60 * 60_000
  ) {
    throw new Cp2Error(400, "sms_timestamp_invalid", "SMS timestamp is invalid.");
  }
  return new Date(occurredAt).toISOString();
}

export function normalizeExistingCustomerPhone(value: string | null): string | null {
  if (value === null || !value.trim().startsWith("+")) return null;
  try {
    return normalizeInternationalOwnerPhoneNumber(value).e164;
  } catch {
    return null;
  }
}

export function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Cp2Error(400, "value_invalid", `Value must be an integer of at least ${minimum}.`);
  }
  return value;
}

export function normalizeMailboxHistoryDays(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 30) {
    throw new Cp2Error(
      400,
      "mailbox_history_range_invalid",
      "Mailbox history import must be between 1 and 30 days."
    );
  }
  return value;
}

export function renderInvoiceAttachment(
  business: BusinessSummary,
  invoice: InvoiceSummary
): string {
  const lines = [
    business.name,
    `Invoice ${invoice.invoiceNumber}`,
    `Customer: ${invoice.customerName ?? "Customer"}`,
    `Issued: ${invoice.confirmedAt ?? invoice.createdAt}`,
    "",
    ...invoice.items.map(
      (item) =>
        `${item.productName} — ${item.quantity} × ${item.unitPrice.toFixed(2)} = ${item.lineTotal.toFixed(2)}`
    ),
    "",
    `Subtotal: ${invoice.subtotal.toFixed(2)}`,
    `Tax (${invoice.taxRate}%): ${invoice.taxTotal.toFixed(2)}`,
    `Total: ${invoice.total.toFixed(2)}`
  ];
  return `${lines.join("\n")}\n`;
}

export function sanitizeAttachmentFilename(value: string): string {
  return (
    value
      .replace(/[^a-z0-9._-]+/giu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "invoice"
  );
}

export function hashCustomerCapability(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isBase64Url(value: string, minimumLength: number, maximumLength: number): boolean {
  return (
    value.length >= minimumLength && value.length <= maximumLength && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function validateE2eePublicKey(key: E2eePublicKey): void {
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    !isBase64Url(key.x, 32, 128) ||
    !isBase64Url(key.y, 32, 128) ||
    "d" in key
  ) {
    throw new Cp2Error(400, "e2ee_public_key_invalid", "Encryption public key is invalid.");
  }
}

export function validateConversationMessageContent(content: ConversationMessageContent): void {
  switch (content.type) {
    case "text":
      if (
        (content.text.trim().length === 0 && !content.attachments?.length) ||
        content.text.length > 4_000
      ) {
        throw new Cp2Error(
          400,
          "message_content_invalid",
          "Text messages must contain between 1 and 4000 characters."
        );
      }
      if ((content.attachments?.length ?? 0) > 10) {
        throw new Cp2Error(
          400,
          "message_content_invalid",
          "A message can contain at most 10 attachments."
        );
      }
      if (
        (content.attachments ?? [])
          .filter((attachment) => attachment.source !== "managed")
          .reduce((total, attachment) => total + attachment.size, 0) > 10_000_000
      ) {
        throw new Cp2Error(
          413,
          "message_attachment_too_large",
          "Attachments can total at most 10 MB per message."
        );
      }
      for (const attachment of content.attachments ?? []) {
        const managed = attachment.source === "managed";
        if (
          !attachment.id.trim() ||
          !attachment.name.trim() ||
          attachment.size < 0 ||
          (managed
            ? attachment.kind === undefined || attachment.previewable === undefined
            : attachment.url === undefined ||
              (!attachment.url.startsWith("data:") && !attachment.url.startsWith("https://")))
        ) {
          throw new Cp2Error(
            400,
            "message_content_invalid",
            "Attachment metadata or URL is invalid."
          );
        }
      }
      return;
    case "encrypted":
      if (
        content.attachmentCount < 0 ||
        content.attachmentCount > 10 ||
        content.envelopes.length < 1 ||
        content.envelopes.length > 64 ||
        !isBase64Url(content.iv, 12, 64) ||
        !isBase64Url(content.ciphertext, 16, 16_000_000)
      ) {
        throw new Cp2Error(
          400,
          "message_content_invalid",
          "Encrypted message metadata is invalid."
        );
      }
      for (const envelope of content.envelopes) {
        validateE2eePublicKey(envelope.ephemeralPublicKey);
        if (
          envelope.version !== 1 ||
          envelope.algorithm !== "ECDH-P256-HKDF-SHA256-AES-256-GCM" ||
          envelope.recipientDeviceId.length < 8 ||
          envelope.recipientDeviceId.length > 120 ||
          !isBase64Url(envelope.salt, 16, 128) ||
          !isBase64Url(envelope.iv, 12, 64) ||
          !isBase64Url(envelope.ciphertext, 48, 256)
        ) {
          throw new Cp2Error(400, "message_content_invalid", "Encrypted envelope is invalid.");
        }
      }
      return;
    case "storefront":
    case "owner-controls":
      if (content.shopId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "shopId is required.");
      }
      return;
    case "product-card":
      if (
        content.product.productId.trim().length === 0 ||
        content.product.businessId.trim().length === 0 ||
        content.product.name.trim().length === 0
      ) {
        throw new Cp2Error(400, "message_content_invalid", "Product card is invalid.");
      }
      return;
    case "confirmation":
      if (content.confirmationToken.trim().length === 0 || content.prompt.trim().length === 0) {
        throw new Cp2Error(
          400,
          "message_content_invalid",
          "Confirmation token and prompt are required."
        );
      }
      return;
    case "product-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
      return;
    case "supplier-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
      return;
    case "customer-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
      return;
    case "invoice-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
      return;
    case "payment-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
      return;
    case "import-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
      return;
    case "logistics-management":
      if (content.businessId.trim().length === 0) {
        throw new Cp2Error(400, "message_content_invalid", "businessId is required.");
      }
  }
}
