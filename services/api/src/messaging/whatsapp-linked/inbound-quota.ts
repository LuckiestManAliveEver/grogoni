/**
 * Inbound quotas for WhatsApp Linked Devices (docs/architecture/whatsapp-linked-devices.md,
 * "Inbound quotas"). Limits are rolling windows over what the canonical store already persisted:
 * stored inbound messages (1 hour) and stored media bytes (24 hours), per chat and per business.
 * Counting persisted rows makes the quota durable across restarts and hosts without a counter
 * table that could drift from the data it limits.
 */
export interface LinkedInboundQuota {
  chatMessagesPerHour: number;
  businessMessagesPerHour: number;
  chatMediaBytesPerDay: number;
  businessMediaBytesPerDay: number;
}

export const linkedInboundQuotaDefaults: LinkedInboundQuota = {
  // Two messages a minute, sustained for an hour, from one chat is already a flood for a shop.
  chatMessagesPerHour: 120,
  businessMessagesPerHour: 1_000,
  // Twenty full-size (5 MiB) attachments a day from one chat; two hundred for the business.
  chatMediaBytesPerDay: 100 * 1024 * 1024,
  businessMediaBytesPerDay: 1024 * 1024 * 1024
};

export const linkedMessageWindowMs = 60 * 60_000;
export const linkedMediaWindowMs = 24 * 60 * 60_000;

const environmentNames: Record<keyof LinkedInboundQuota, string> = {
  chatMessagesPerHour: "WHATSAPP_LINKED_INBOUND_CHAT_MESSAGES_PER_HOUR",
  businessMessagesPerHour: "WHATSAPP_LINKED_INBOUND_BUSINESS_MESSAGES_PER_HOUR",
  chatMediaBytesPerDay: "WHATSAPP_LINKED_INBOUND_CHAT_MEDIA_BYTES_PER_DAY",
  businessMediaBytesPerDay: "WHATSAPP_LINKED_INBOUND_BUSINESS_MEDIA_BYTES_PER_DAY"
};

/** Reads overrides; an unset or empty variable keeps its default, an invalid one refuses startup. */
export function linkedInboundQuotaFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): LinkedInboundQuota {
  const quota = { ...linkedInboundQuotaDefaults };
  for (const key of Object.keys(environmentNames) as Array<keyof LinkedInboundQuota>) {
    const raw = environment[environmentNames[key]]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
      throw new Error(`${environmentNames[key]} must be a positive integer.`);
    quota[key] = value;
  }
  return quota;
}

export type LinkedQuotaScope = "chat" | "business";

/** Pure decision over counts the store computed; `null` means within quota. */
export function linkedInboundOverQuota(
  quota: LinkedInboundQuota,
  usage: {
    chatMessages: number;
    businessMessages: number;
    chatMediaBytes: number;
    businessMediaBytes: number;
  },
  incomingMediaBytes: number
): { messages: LinkedQuotaScope | null; media: LinkedQuotaScope | null } {
  const messages =
    usage.chatMessages >= quota.chatMessagesPerHour
      ? "chat"
      : usage.businessMessages >= quota.businessMessagesPerHour
        ? "business"
        : null;
  const media =
    incomingMediaBytes === 0
      ? null
      : usage.chatMediaBytes + incomingMediaBytes > quota.chatMediaBytesPerDay
        ? "chat"
        : usage.businessMediaBytes + incomingMediaBytes > quota.businessMediaBytesPerDay
          ? "business"
          : null;
  return { messages, media };
}

export const linkedMediaOverQuotaText =
  "[Attachment not stored: this chat's WhatsApp media allowance is used up for today.]";

/** What the store keeps that the quota counts. Only the fields read here. */
interface QuotaRows {
  channels: Iterable<{
    businessId: string;
    provider: string;
    conversationId: string;
  }>;
  messages: Iterable<{
    conversationId: string;
    provider?: string;
    direction?: string;
    createdAt: string;
  }>;
  attachments: Iterable<{
    businessId: string;
    conversationId: string;
    toolCallId: string | null;
    size: number;
    createdAt: string;
  }>;
}

/** Stored inbound WhatsApp messages (last hour) and media bytes (last 24 hours). */
export function linkedInboundUsage(
  rows: QuotaRows,
  businessId: string,
  conversationId: string,
  now: Date
) {
  const conversations = new Set<string>();
  for (const channel of rows.channels)
    if (channel.businessId === businessId && channel.provider === "whatsapp_linked")
      conversations.add(channel.conversationId);
  const messageCutoff = now.getTime() - linkedMessageWindowMs;
  const mediaCutoff = now.getTime() - linkedMediaWindowMs;
  const usage = { chatMessages: 0, businessMessages: 0, chatMediaBytes: 0, businessMediaBytes: 0 };
  for (const message of rows.messages) {
    if (
      message.provider !== "whatsapp_linked" ||
      message.direction !== "inbound" ||
      !conversations.has(message.conversationId) ||
      Date.parse(message.createdAt) < messageCutoff
    )
      continue;
    usage.businessMessages++;
    if (message.conversationId === conversationId) usage.chatMessages++;
  }
  for (const attachment of rows.attachments) {
    if (
      attachment.businessId !== businessId ||
      !attachment.toolCallId?.startsWith("whatsapp-media:") ||
      Date.parse(attachment.createdAt) < mediaCutoff
    )
      continue;
    usage.businessMediaBytes += attachment.size;
    if (attachment.conversationId === conversationId) usage.chatMediaBytes += attachment.size;
  }
  return usage;
}
