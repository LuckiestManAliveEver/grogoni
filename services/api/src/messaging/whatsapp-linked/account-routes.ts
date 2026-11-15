import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Cp2Store } from "../../cp2/store.js";
import { readSessionCookie } from "../../cp2/store.js";
import { Cp2Error } from "../../cp2/cp2-error.js";
import { parseRequestBody, parseString, sendCp2Error } from "../../cp2/route-helpers.js";
import { validLinkedChat } from "./connector.js";

/**
 * The owner's account-side view of WhatsApp Linked Devices: the shop owner-change notice,
 * existing-customer linking and per-chat read receipts (docs/architecture/whatsapp-linked-
 * devices.md). Store-only: these routes never touch a WhatsApp socket, so they run on every API
 * host, including the Edge API, whether or not this host runs the connector.
 *
 * All require the business owner, like the connector routes in routes.ts.
 */
export function registerLinkedWhatsAppAccountRoutes(app: FastifyInstance, store: Cp2Store): void {
  type Params = { businessId: string };
  const flush = () => (store as Cp2Store & { flush?: () => Promise<void> }).flush?.();

  function owner(request: FastifyRequest<{ Params: Params }>) {
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
        "Only the business owner can manage this WhatsApp connection."
      );
    return { businessId, ownerId: actor.userId };
  }

  function chatOf(body: Record<string, unknown>): string {
    const chat = parseString(body.chat, "chat");
    if (!validLinkedChat(chat))
      throw new Cp2Error(
        400,
        "whatsapp_chat_invalid",
        "Enter a valid WhatsApp contact or group identifier."
      );
    return chat;
  }

  const path = "/businesses/:businessId/channels/whatsapp-linked";

  app.get<{ Params: Params }>(`${path}/account`, async (request, reply) => {
    try {
      const actor = owner(request);
      reply.header("cache-control", "no-store");
      const account = store.linkedWhatsAppAccount(actor.businessId, actor.ownerId);
      // The first read after an owner change runs the cleanup; persist it before answering.
      if (account.ownerChange) await flush();
      return account;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post<{ Params: Params; Body: unknown }>(
    `${path}/account/owner-change/acknowledge`,
    async (request, reply) => {
      try {
        const actor = owner(request);
        reply.header("cache-control", "no-store");
        store.acknowledgeLinkedWhatsAppOwnerChange(actor.businessId, actor.ownerId);
        await flush();
        return store.linkedWhatsAppAccount(actor.businessId, actor.ownerId);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  /** `{ chat, customerId }` links the contact to that customer; `customerId: null` unlinks. */
  app.post<{ Params: Params; Body: unknown }>(`${path}/chats/customer`, async (request, reply) => {
    try {
      const actor = owner(request);
      const body = parseRequestBody(request.body);
      const chat = chatOf(body);
      if (body.customerId !== null && typeof body.customerId !== "string")
        throw new Cp2Error(
          400,
          "customer_id_invalid",
          "Choose a customer record, or null to unlink."
        );
      const account = store.linkLinkedWhatsAppCustomer({
        businessId: actor.businessId,
        ownerId: actor.ownerId,
        chat,
        customerId: body.customerId === null ? null : parseString(body.customerId, "customerId")
      });
      await flush();
      reply.header("cache-control", "no-store");
      return account;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  /** `{ chat, enabled }`: send WhatsApp read receipts for that chat, or stop. */
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/chats/read-receipts`,
    async (request, reply) => {
      try {
        const actor = owner(request);
        const body = parseRequestBody(request.body);
        const chat = chatOf(body);
        if (typeof body.enabled !== "boolean")
          throw new Cp2Error(400, "whatsapp_read_receipts_invalid", "Choose on or off.");
        const account = store.setLinkedReadReceipts({
          businessId: actor.businessId,
          ownerId: actor.ownerId,
          chat,
          enabled: body.enabled
        });
        await flush();
        reply.header("cache-control", "no-store");
        return account;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
