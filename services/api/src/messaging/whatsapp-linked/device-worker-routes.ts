import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Cp2Store } from "../../cp2/store.js";
import { readSessionCookie } from "../../cp2/store.js";
import { Cp2Error } from "../../cp2/cp2-error.js";
import { parseRequestBody, parseString, sendCp2Error } from "../../cp2/route-helpers.js";
import { validLinkedChat, type LinkedMutation } from "./connector.js";
import { parseLinkedDeviceAcks } from "./device-outbox.js";

/**
 * Local-first deployment: the owner's Android phone runs the connector (the sidecar under
 * apps/android) and forwards approved-chat text here. The phone authenticates with the owner's
 * ordinary Grogoni session, the same cookie its native client already uses, so the device can
 * never act beyond what that owner's session may do. No service token and no new credential.
 *
 * Answers 404 `whatsapp_device_worker_disabled` unless WHATSAPP_LINKED_DEVICE_WORKER_ENABLED=true.
 * The routes are always registered so route classification (recovery-probation-routes.ts) sees
 * them; the flag is read per request. Independent of
 * WHATSAPP_LINKED_ENABLED: a host can accept device ingress without holding any WhatsApp
 * session itself (the normal Edge deployment cannot hold sockets, but can store messages).
 */
export function registerLinkedWhatsAppDeviceRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  environment: NodeJS.ProcessEnv = process.env
): void {
  type Params = { businessId: string };
  const flush = () => (store as Cp2Store & { flush?: () => Promise<void> }).flush?.();

  function owner(request: FastifyRequest<{ Params: Params }>) {
    if (environment.WHATSAPP_LINKED_DEVICE_WORKER_ENABLED !== "true")
      throw new Cp2Error(
        404,
        "whatsapp_device_worker_disabled",
        "WhatsApp on the owner's phone is not enabled on this host."
      );
    const businessId = parseString(request.params.businessId, "businessId");
    const sessionId = readSessionCookie(request.headers.cookie);
    const actor = store.authorizeBusinessPermission({
      sessionId,
      businessId,
      permission: "business:read"
    });
    if (actor.role !== "owner")
      throw new Cp2Error(
        403,
        "permission_denied",
        "Only the business owner can link WhatsApp on a phone."
      );
    store.validateLinkedWhatsAppOwner(businessId, actor.userId);
    return { businessId, sessionId, ownerId: actor.userId };
  }

  const path = "/businesses/:businessId/channels/whatsapp-linked/device";

  /** Creates (or reuses) the conversation for a chat before the phone accepts its messages. */
  app.post<{ Params: Params; Body: unknown }>(`${path}/scopes`, async (request, reply) => {
    try {
      const actor = owner(request);
      const body = parseRequestBody(request.body);
      const chat = parseString(body.chat, "chat");
      if (!validLinkedChat(chat))
        throw new Cp2Error(
          400,
          "whatsapp_chat_invalid",
          "Enter a valid WhatsApp contact or group identifier."
        );
      reply.header("cache-control", "no-store");
      if (body.approved === false) {
        store.revokeLinkedWhatsAppDeviceChat({
          businessId: actor.businessId,
          ownerId: actor.ownerId,
          chat
        });
        await flush();
        return { chat, approved: false };
      }
      if (body.approved !== true)
        throw new Cp2Error(
          400,
          "whatsapp_scope_consent_required",
          "Explicit conversation approval is required."
        );
      const linked = store.createProviderConversation({
        sessionId: actor.sessionId,
        businessId: actor.businessId,
        provider: "whatsapp_linked",
        externalUserId: chat,
        externalConversationId: chat,
        metadata: {
          automaticRepliesEnabled: false,
          linkedDeviceOwnerId: actor.ownerId,
          linkedDeviceWorker: "android"
        }
      });
      // Assistant replies need the server-side Daemon bridge, which a phone worker lacks.
      store.updateConversationSettings({
        sessionId: actor.sessionId,
        conversationId: linked.channel.conversationId,
        agentEnabled: false
      });
      await flush();
      return { chat, approved: true, conversationId: linked.channel.conversationId };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  /** What the phone path looks like for the owner: host, last check-in, waiting sends. */
  app.get<{ Params: Params }>(`${path}/status`, async (request, reply) => {
    try {
      const actor = owner(request);
      reply.header("cache-control", "no-store");
      return {
        enabled: true,
        ...store.linkedWhatsAppDeviceStatus(actor.businessId, actor.ownerId)
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  /**
   * The phone's session state for this business. Reporting a state makes the business
   * phone-hosted: replies typed in the inbox, assistant replies and delegated results then queue
   * in the device outbox for this phone (device-outbox.ts).
   */
  app.post<{ Params: Params; Body: unknown }>(`${path}/state`, async (request, reply) => {
    try {
      const actor = owner(request);
      const body = parseRequestBody(request.body);
      const status = store.recordLinkedWhatsAppDeviceState({
        businessId: actor.businessId,
        ownerId: actor.ownerId,
        state: parseString(body.state, "state")
      });
      reply.header("cache-control", "no-store");
      await flush();
      return status;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  /**
   * Hands the phone the sends it may perform now and the queued read receipts. Authority (owner,
   * chat approval binding, STOP) is re-checked for every entry at this moment. Never holds the
   * request open: Edge cannot, so the phone polls (WhatsAppSidecarController).
   */
  app.post<{ Params: Params; Body: unknown }>(`${path}/outbox/pull`, async (request, reply) => {
    try {
      const actor = owner(request);
      const result = await store.pullLinkedWhatsAppDeviceOutbox(actor);
      reply.header("cache-control", "no-store");
      await flush();
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  /** Outcomes for pulled sends: sent, failed (retryable or not) or uncertain. */
  app.post<{ Params: Params; Body: unknown }>(`${path}/outbox/ack`, async (request, reply) => {
    try {
      const actor = owner(request);
      const acks = parseLinkedDeviceAcks(parseRequestBody(request.body).results);
      if (!acks)
        throw new Cp2Error(400, "whatsapp_ack_invalid", "Invalid WhatsApp delivery results.");
      const result = store.acknowledgeLinkedWhatsAppDeviceOutbox({
        businessId: actor.businessId,
        ownerId: actor.ownerId,
        acks
      });
      reply.header("cache-control", "no-store");
      await flush();
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  /** One approved-chat event from the owner's phone. Idempotent on the provider message id. */
  app.post<{ Params: Params; Body: unknown }>(`${path}/ingress`, async (request, reply) => {
    try {
      const actor = owner(request);
      const message = parseDeviceIngress(parseRequestBody(request.body).message);
      reply.header("cache-control", "no-store");
      if (store.hasLinkedWhatsAppMessage(actor.businessId, actor.ownerId, message))
        return { received: true, duplicate: true };
      const result = await store.ingestLinkedWhatsAppMessage({
        businessId: actor.businessId,
        ownerId: actor.ownerId,
        ...message
      });
      await flush();
      // Over the inbound quota: acknowledged so the phone's journal moves on, but not stored.
      if ("throttled" in result && result.throttled)
        return { received: true, duplicate: false, throttled: true };
      return { received: true, duplicate: false };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
}

export interface DeviceIngressMessage {
  id: string;
  chat: string;
  sender: string;
  text: string;
  timestamp: string;
  replyTo?: string;
  mutation?: LinkedMutation;
}

const senderPattern = /^[0-9]{5,20}(?::[0-9]{1,4})?@(?:s\.whatsapp\.net|lid)$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

function invalid(field: string): never {
  throw new Cp2Error(400, "whatsapp_ingress_invalid", `Invalid WhatsApp message ${field}.`);
}

/** Strict validation: the phone is the owner's own device, but its input is still untrusted. */
export function parseDeviceIngress(value: unknown): DeviceIngressMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("body");
  const input = value as Record<string, unknown>;
  const { id, chat, sender, text, timestamp, replyTo, mutation } = input;
  if (typeof id !== "string" || !idPattern.test(id)) invalid("id");
  if (typeof chat !== "string" || !validLinkedChat(chat)) invalid("chat");
  if (typeof sender !== "string" || !senderPattern.test(sender)) invalid("sender");
  if (typeof text !== "string" || text.length === 0 || text.length > 4000) invalid("text");
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))
    invalid("timestamp");
  if (replyTo !== undefined && (typeof replyTo !== "string" || !idPattern.test(replyTo)))
    invalid("replyTo");
  const parsed: DeviceIngressMessage = {
    id,
    chat,
    sender,
    text,
    timestamp: new Date(timestamp).toISOString()
  };
  if (replyTo !== undefined) parsed.replyTo = replyTo as string;
  if (mutation !== undefined) parsed.mutation = parseMutation(mutation);
  return parsed;
}

function parseMutation(value: unknown): LinkedMutation {
  if (!value || typeof value !== "object") invalid("mutation");
  const { kind, targetId, fromMe, status } = value as Record<string, unknown>;
  if (typeof targetId !== "string" || !idPattern.test(targetId) || typeof fromMe !== "boolean")
    invalid("mutation");
  if (kind === "edit" || kind === "delete") return { kind, targetId, fromMe };
  if (
    kind === "receipt" &&
    fromMe === true &&
    (status === "sent" || status === "delivered" || status === "read" || status === "failed")
  )
    return { kind, targetId, fromMe, status };
  return invalid("mutation");
}
