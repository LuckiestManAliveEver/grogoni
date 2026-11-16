import type { ChannelEndpointSummary } from "@grogoni/shared-types";
import {
  LinkedWhatsAppConnector,
  validLinkedChat,
  type LinkedDriver,
  type LinkedInbound,
  type LinkedState
} from "../connector.js";
import type { LinkedSessionVault } from "../vault.js";
import type { SidecarError, SidecarIngressMessage, SidecarMethod } from "./protocol.js";

/**
 * The on-device seam around the unchanged LinkedWhatsAppConnector. The API process supplies
 * `authorize` and `receive` from Cp2Store; on Android there is no store, so:
 *
 * - `authorize` accepts only the signed-in owner the app enrolled at start, minus businesses the
 *   app has denied after the Grogoni API refused ownership. The API re-checks ownership on every
 *   forwarded event, so this is a local fence, not the authority.
 * - `receive` hands the event to the app over the loopback socket and resolves only when the app
 *   acknowledges that the Grogoni API stored it. Until then the event stays in the encrypted
 *   journal, exactly as in the server deployment.
 *
 * The sidecar holds no Grogoni credential at all: the app makes the API call with the owner's
 * own session.
 */
export interface SidecarRelay {
  /** True while an authenticated app connection is open. */
  connected(): boolean;
  /** Sends one ingress event; resolves on a positive ack, rejects on nack, timeout or loss. */
  ingress(businessId: string, message: SidecarIngressMessage): Promise<void>;
  state(businessId: string, state: LinkedState): void;
}

export interface SidecarEnrollment {
  /** Opaque id of the signed-in owner (the app's account id). One vault directory per owner. */
  ownerId: string;
}

export class SidecarRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
  }
}

const vaultCheckRecord = "$sidecar-self-check";
const mediaNote = "[Attachment not imported: the on-device WhatsApp worker forwards text only.]";

/**
 * Wraps a LinkedDriver so media never downloads on the phone: the connector would otherwise
 * fetch up to 5 MiB per attachment over mobile data, and this deployment forwards text only.
 */
export function textOnlyDriver(driver: LinkedDriver): LinkedDriver {
  return {
    open: (input) =>
      driver.open({
        ...input,
        inbound: (message: LinkedInbound) => {
          if (!message.media?.length) return input.inbound(message);
          const { media: _media, ...rest } = message;
          void _media;
          input.inbound({ ...rest, text: `${rest.text}\n${mediaNote}`.trim().slice(0, 4000) });
        }
      })
  };
}

function text(params: Record<string, unknown>, name: string, max: number): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new SidecarRequestError("invalid_request", `${name} is required.`);
  return value;
}

function businessIdOf(params: Record<string, unknown>): string {
  const value = text(params, "businessId", 128);
  if (!/^[A-Za-z0-9_:.-]+$/.test(value))
    throw new SidecarRequestError("invalid_request", "businessId is invalid.");
  return value;
}

const providerIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const senderPattern = /^[0-9]{5,20}(?::[0-9]{1,4})?@(?:s\.whatsapp\.net|lid)$/;

function readKeys(value: unknown): Array<{ id: string; sender: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    throw new SidecarRequestError("invalid_request", "keys is required.");
  return value.map((key) => {
    const { id, sender } = (key ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !providerIdPattern.test(id))
      throw new SidecarRequestError("invalid_request", "A read receipt id is invalid.");
    if (typeof sender !== "string" || !senderPattern.test(sender))
      throw new SidecarRequestError("invalid_request", "A read receipt sender is invalid.");
    return { id, sender };
  });
}

function readQuote(
  value: unknown
): { id: string; sender: string | null; fromMe: boolean; text: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const { id, sender, fromMe, text: body } = value as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    !providerIdPattern.test(id) ||
    !(sender === null || (typeof sender === "string" && senderPattern.test(sender))) ||
    typeof fromMe !== "boolean" ||
    typeof body !== "string" ||
    body.length > 2000
  )
    throw new SidecarRequestError("invalid_request", "quotedMessage is invalid.");
  return { id, sender: sender as string | null, fromMe, text: body };
}

export interface SidecarHostOptions {
  vault: LinkedSessionVault;
  driver: LinkedDriver;
  enrollment: SidecarEnrollment;
  relay: SidecarRelay;
  /** Loads the protocol library without connecting; used by the device self-check. */
  probe?: () => Promise<Record<string, unknown>>;
  /** Cool-down before a session that reached ERROR is reopened. */
  recoveryMs?: number;
  now?: () => number;
}

export class SidecarHost {
  readonly connector: LinkedWhatsAppConnector;
  private readonly denied = new Set<string>();
  private readonly recovery = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly options: SidecarHostOptions) {
    const { enrollment, relay } = options;
    this.connector = new LinkedWhatsAppConnector({
      vault: options.vault,
      driver: textOnlyDriver(options.driver),
      authorize: (businessId, ownerId) => {
        if (ownerId !== enrollment.ownerId || this.denied.has(businessId))
          throw new SidecarRequestError(
            "owner_not_enrolled",
            "This WhatsApp session belongs to another Grogoni account."
          );
      },
      receive: async (businessId, _ownerId, _generation, message) => {
        if (!relay.connected())
          throw new SidecarRequestError("relay_unavailable", "Grogoni is not connected.", true);
        await relay.ingress(businessId, {
          id: message.id,
          chat: message.chat,
          sender: message.sender,
          text: message.text,
          timestamp: message.timestamp,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.mutation ? { mutation: message.mutation } : {})
        });
      },
      event: ({ businessId, state }) => {
        relay.state(businessId, state);
        this.scheduleRecovery(businessId, state);
      },
      ...(options.now ? { now: options.now } : {})
    });
  }

  async restore(): Promise<void> {
    await this.connector.restore();
  }

  /**
   * The connector parks a session in ERROR after eight failed reconnects or ingress attempts.
   * On a phone that is usually a long API or network outage, so retry after a cool-down instead
   * of waiting for the owner. AUTH_REQUIRED and REVOKED are never retried: they need the owner.
   */
  private scheduleRecovery(businessId: string, state: LinkedState): void {
    clearTimeout(this.recovery.get(businessId));
    this.recovery.delete(businessId);
    if (state !== "ERROR" || this.stopped || this.denied.has(businessId)) return;
    const timer = setTimeout(() => {
      this.recovery.delete(businessId);
      if (this.stopped) return;
      void this.connector
        .connect(businessId, this.options.enrollment.ownerId)
        .catch(() => undefined);
    }, this.options.recoveryMs ?? 300_000);
    timer.unref?.();
    this.recovery.set(businessId, timer);
  }

  async handle(method: SidecarMethod, params: Record<string, unknown>): Promise<unknown> {
    const ownerId = this.options.enrollment.ownerId;
    switch (method) {
      case "status":
        return this.connector.status(businessIdOf(params), ownerId);
      case "connect": {
        const businessId = businessIdOf(params);
        const phone = params.phone === undefined ? undefined : text(params, "phone", 15);
        if (phone !== undefined && !/^[1-9][0-9]{6,14}$/.test(phone))
          throw new SidecarRequestError(
            "phone_invalid",
            "Enter the WhatsApp number including country code, using digits only."
          );
        await this.connector.connect(businessId, ownerId, phone);
        return this.connector.status(businessId, ownerId);
      }
      case "approve": {
        const businessId = businessIdOf(params);
        const chat = text(params, "chat", 64);
        if (!validLinkedChat(chat))
          throw new SidecarRequestError("whatsapp_chat_invalid", "Invalid WhatsApp chat.");
        this.connector.approve(businessId, ownerId, chat, text(params, "conversationId", 128));
        return this.connector.status(businessId, ownerId);
      }
      case "revoke": {
        const businessId = businessIdOf(params);
        this.connector.revoke(businessId, ownerId, text(params, "chat", 64));
        return this.connector.status(businessId, ownerId);
      }
      case "groups":
        return { groups: await this.connector.groups(businessIdOf(params), ownerId) };
      case "send": {
        const businessId = businessIdOf(params);
        const chat = text(params, "chat", 64);
        const conversationId = text(params, "conversationId", 128);
        const endpoint: ChannelEndpointSummary = {
          channelId: `whatsapp_linked:${chat}`,
          conversationId,
          businessId,
          customerId: null,
          channelIdentityId: chat,
          provider: "whatsapp_linked",
          externalUserId: chat,
          externalConversationId: chat,
          capabilities: this.connector.getCapabilities(),
          status: "available",
          configured: true,
          authorized: true,
          executionEnvironment: "android-device",
          lastInboundAt: null,
          lastOutboundAt: null
        };
        this.connector.status(businessId, ownerId);
        return this.connector.sendMessage({
          businessId,
          conversationId,
          customerId: null,
          idempotencyKey: text(params, "idempotencyKey", 200),
          text: text(params, "text", 4000),
          endpoint
        });
      }
      case "deliver":
        return this.deliver(params);
      case "markRead": {
        // Read receipts pulled from the device outbox. The connector re-checks that the chat is
        // approved on this phone's connected session; anything else sends nothing (0).
        const businessId = businessIdOf(params);
        const chat = text(params, "chat", 64);
        if (!validLinkedChat(chat))
          throw new SidecarRequestError("whatsapp_chat_invalid", "Invalid WhatsApp chat.");
        const keys = readKeys(params.keys);
        return { sent: await this.connector.markRead(businessId, ownerId, chat, keys) };
      }
      case "disconnect": {
        const businessId = businessIdOf(params);
        await this.connector.disconnect(businessId, ownerId);
        return this.connector.status(businessId, ownerId);
      }
      case "deny": {
        // The API said this owner no longer owns the business: log out and erase locally first,
        // then fence every later call for it.
        const businessId = businessIdOf(params);
        clearTimeout(this.recovery.get(businessId));
        this.recovery.delete(businessId);
        await this.connector.disconnect(businessId, ownerId).catch(() => undefined);
        this.denied.add(businessId);
        return { denied: true };
      }
      case "probe":
        return this.options.probe ? await this.options.probe() : { protocol: false };
      case "vaultCheck": {
        // Device self-check: one fixed record, so the app can prove the vault encrypts with the
        // key it supplied and reads back after a restart. It never touches session records.
        if (params.write !== undefined) {
          const canary = text(params, "write", 128);
          this.options.vault.write(vaultCheckRecord, canary);
          return { written: true };
        }
        return { value: this.options.vault.read(vaultCheckRecord) };
      }
      case "shutdown":
        await this.stop();
        return { stopped: true };
    }
  }

  /**
   * One send pulled from the Grogoni device outbox. Never throws for a delivery problem: it
   * answers with the outcome the outbox needs, read from the connector's own encrypted journal
   * rather than from error text.
   *
   * - The journal already holds the key as `pending`: a previous attempt handed it to WhatsApp
   *   without a confirmed answer. `uncertain`, and nothing is sent again.
   * - The send fails and the journal now holds it as `pending`: same, `uncertain`.
   * - The send fails before the journal recorded it: `failed`, retryable when the session is
   *   just not connected yet.
   * - Otherwise `sent`, with the WhatsApp id (a repeat of a sent key returns the stored id).
   */
  private async deliver(params: Record<string, unknown>): Promise<unknown> {
    const ownerId = this.options.enrollment.ownerId;
    const businessId = businessIdOf(params);
    const chat = text(params, "chat", 64);
    if (!validLinkedChat(chat))
      throw new SidecarRequestError("whatsapp_chat_invalid", "Invalid WhatsApp chat.");
    const conversationId = text(params, "conversationId", 128);
    const idempotencyKey = text(params, "idempotencyKey", 200);
    const body = text(params, "text", 4000);
    const quotedMessage = readQuote(params.quotedMessage);
    const journal = () => {
      try {
        return this.connector.deliveryState(businessId, ownerId, idempotencyKey);
      } catch {
        return "none" as const;
      }
    };
    if (journal() === "pending")
      return { outcome: "uncertain", code: "WHATSAPP_DELIVERY_UNCERTAIN" };
    try {
      const result = await this.connector.sendMessage({
        businessId,
        conversationId,
        customerId: null,
        idempotencyKey,
        text: body,
        ...(quotedMessage ? { quotedMessage } : {}),
        endpoint: this.endpoint(businessId, chat, conversationId)
      });
      if (!result.providerMessageId)
        return { outcome: "uncertain", code: "WHATSAPP_DELIVERY_UNCERTAIN" };
      return { outcome: "sent", deliveredId: result.providerMessageId };
    } catch (error) {
      if (journal() === "pending")
        return { outcome: "uncertain", code: "WHATSAPP_DELIVERY_UNCERTAIN" };
      const wire = toSidecarError(error);
      const code = /^[A-Za-z_]{2,64}$/.test(wire.code) ? wire.code : "CHANNEL_SEND_FAILED";
      // Not connected (yet) is worth retrying from the outbox; a refusal of the message is not.
      const state = (() => {
        try {
          return this.connector.status(businessId, ownerId).state;
        } catch {
          return "ERROR";
        }
      })();
      const retryable =
        wire.retryable ||
        (code === "CHANNEL_UNAVAILABLE" &&
          ["CONNECTING", "RECONNECTING", "SUSPENDED"].includes(state));
      return { outcome: "failed", code, retryable };
    }
  }

  private endpoint(
    businessId: string,
    chat: string,
    conversationId: string
  ): ChannelEndpointSummary {
    return {
      channelId: `whatsapp_linked:${chat}`,
      conversationId,
      businessId,
      customerId: null,
      channelIdentityId: chat,
      provider: "whatsapp_linked",
      externalUserId: chat,
      externalConversationId: chat,
      capabilities: this.connector.getCapabilities(),
      status: "available",
      configured: true,
      authorized: true,
      executionEnvironment: "android-device",
      lastInboundAt: null,
      lastOutboundAt: null
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.recovery.values()) clearTimeout(timer);
    this.recovery.clear();
    await this.connector.stop();
  }
}

/** Maps any thrown value to a wire error without leaking stack traces or credentials. */
export function toSidecarError(error: unknown): SidecarError {
  if (error instanceof SidecarRequestError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  const gateway = error as { code?: unknown; retryable?: unknown; message?: unknown };
  if (typeof gateway?.code === "string" && /^[A-Z_]{3,64}$/.test(gateway.code))
    return {
      code: gateway.code,
      message: typeof gateway.message === "string" ? gateway.message.slice(0, 300) : "Failed.",
      retryable: gateway.retryable === true
    };
  const message = error instanceof Error ? error.message : "";
  // Connector validation errors are plain Errors with owner-facing text and no secrets.
  return {
    code: "request_failed",
    message: message && message.length <= 300 ? message : "The WhatsApp worker request failed.",
    retryable: false
  };
}
