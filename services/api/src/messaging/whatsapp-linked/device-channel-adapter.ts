import type { ChannelCapability, ChannelProviderReadiness } from "@grogoni/shared-types";
import type {
  ChannelSendResult,
  MessagingChannelAdapter,
  OutboundChannelMessage
} from "../channel-gateway.js";
import { ChannelGatewayError } from "../channel-errors.js";

/**
 * The `whatsapp_linked` gateway adapter for sessions hosted on the owner's Android phone
 * (docs/architecture/whatsapp-linked-devices.md, "Device outbox"). Registered on every API host,
 * Supabase Edge included: a send queues a durable outbox entry the phone pulls, and returns
 * `queued`, exactly like native SMS. On a Node host that also runs the server connector,
 * `linkedHostRouter` picks per business.
 */

/** Where a business's linked WhatsApp session currently lives, from its owner-state record. */
export interface LinkedDeviceHosting {
  /** True when the owner's phone reported this session most recently. */
  hosted: boolean;
  /**
   * available: the phone reported a live session recently. offline: a live session, but the phone
   * has not checked in lately (messages wait in the outbox). unavailable: no session to send on.
   */
  status: "available" | "offline" | "unavailable";
}

/** The phone reports its state at least this often while running (WhatsAppSidecarController). */
export const linkedDeviceOfflineAfterMs = 10 * 60_000;

const liveStates = new Set(["CONNECTED", "RECONNECTING", "CONNECTING", "SUSPENDED"]);

/** Pure: the hosting view of one owner-state record. */
export function linkedDeviceHosting(
  record:
    | { host?: unknown; state: string | null; deviceSeenAt?: unknown; ownerId: string | null }
    | undefined,
  ownerIsCurrent: boolean,
  now: Date
): LinkedDeviceHosting {
  if (!record || record.host !== "android" || !record.ownerId || !ownerIsCurrent)
    return { hosted: false, status: "unavailable" };
  if (!record.state || !liveStates.has(record.state))
    return { hosted: true, status: "unavailable" };
  const seen = typeof record.deviceSeenAt === "string" ? Date.parse(record.deviceSeenAt) : NaN;
  const fresh = Number.isFinite(seen) && now.getTime() - seen < linkedDeviceOfflineAfterMs;
  return { hosted: true, status: record.state === "CONNECTED" && fresh ? "available" : "offline" };
}

/** Text only: the phone relay carries no attachment bytes. Offline-capable: sends wait. */
export const linkedDeviceCapabilities: ChannelCapability[] = [
  "CAN_SEND",
  "CAN_RECEIVE",
  "CAN_REPLY",
  "SUPPORTS_OFFLINE",
  "REQUIRES_EXISTING_THREAD",
  "REQUIRES_ANDROID_DEVICE"
];

export function createLinkedDeviceChannelAdapter(transport: {
  hosting(businessId: string): LinkedDeviceHosting;
  /** Records the outbox entry for the canonical message; returns its id. Throws when refused. */
  queue(request: OutboundChannelMessage): string;
}): MessagingChannelAdapter {
  const readiness = (businessId?: string): ChannelProviderReadiness => {
    const hosting = businessId
      ? transport.hosting(businessId)
      : { hosted: false, status: "unavailable" as const };
    return {
      provider: "whatsapp_linked",
      capabilities: [...linkedDeviceCapabilities],
      configured: hosting.hosted,
      authorized: hosting.hosted && hosting.status !== "unavailable",
      status: hosting.status,
      configurationRequirement:
        hosting.status === "unavailable"
          ? "Run WhatsApp on your phone in the Grogoni app and approve conversations."
          : hosting.status === "offline"
            ? "Messages wait until the Grogoni app on your phone is back online."
            : null
    };
  };
  return {
    provider: "whatsapp_linked",
    readiness: (context) => readiness(context?.businessId),
    getCapabilities: () => [...linkedDeviceCapabilities],
    executionContext: () => ({ environment: "android-device", deviceId: null }),
    sendMessage: async (request): Promise<ChannelSendResult> => {
      if ((request.attachments?.length ?? 0) > 0)
        throw new ChannelGatewayError(
          "CHANNEL_SEND_FAILED",
          "Attachments cannot be sent through WhatsApp on your phone yet. Send text only."
        );
      if (!request.text.trim() || request.text.length > 4000)
        throw new ChannelGatewayError(
          "CHANNEL_SEND_FAILED",
          "Messages support up to 4,000 characters."
        );
      const id = transport.queue(request);
      return { accepted: true, providerMessageId: id, status: "queued" };
    }
  };
}

/**
 * On a Node host that runs the server connector too: the phone's adapter for businesses whose
 * session the phone hosts, the server connector for the rest. Readiness, capabilities, execution
 * context and sends all follow the same per-business decision, so selection and send agree.
 */
export function linkedHostRouter(
  server: MessagingChannelAdapter,
  device: MessagingChannelAdapter,
  hostedOnDevice: (businessId: string) => boolean
): MessagingChannelAdapter {
  const pick = (businessId: string | undefined) =>
    businessId !== undefined && hostedOnDevice(businessId) ? device : server;
  return {
    provider: "whatsapp_linked",
    readiness: (context) => pick(context?.businessId).readiness(context),
    getCapabilities: (input) => pick(input.channel.businessId).getCapabilities(input),
    executionContext: (businessId) =>
      pick(businessId).executionContext?.(businessId) ?? {
        environment: "server",
        deviceId: null
      },
    sendMessage: (request) => pick(request.businessId).sendMessage(request)
  };
}
