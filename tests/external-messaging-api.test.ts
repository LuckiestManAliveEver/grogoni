import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createChannelGatewayFromEnvironment } from "../services/api/src/messaging/channel-gateway";
import { createExternalChannelAdapters } from "../services/api/src/messaging/external-channel-adapters";
import { messagingEnvironment, signedMeta, whatsappUpdate } from "./fixtures/external-messaging";

describe("external messaging through the real HTTP routes", () => {
  it("links a verified WhatsApp recipient, keeps a canonical thread, confirms one send, and respects opt-out", async () => {
    const fetcher = vi.fn(async () => Response.json({ messages: [{ id: "wamid.sent" }] }));
    const gateway = createChannelGatewayFromEnvironment({});
    const store = createCp2Store({ channelGateway: gateway });
    const app = buildApi({ cp2: { store } });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "+442079460981", pin: "7412" }
      });
      expect(signup.statusCode, signup.body).toBe(200);
      const cookie = String(signup.headers["set-cookie"]).split(";")[0]!;
      const business = await app.inject({
        method: "POST",
        url: "/businesses",
        headers: { cookie },
        payload: { name: "External fixture", language: "en" }
      });
      expect(business.statusCode, business.body).toBe(200);
      const businessId = business.json().business.id as string;
      for (const adapter of createExternalChannelAdapters(
        messagingEnvironment(businessId),
        fetcher
      ))
        gateway.registerAdapter(adapter);
      const customer = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/customers`,
        headers: { cookie },
        payload: { name: "Verified customer", phone: null, email: null, notes: null }
      });
      expect(customer.statusCode, customer.body).toBe(200);
      const customerId = customer.json().id as string;
      const grant = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/customers/${customerId}/channel-link-grants`,
        headers: { cookie },
        payload: { provider: "whatsapp" }
      });
      expect(grant.statusCode, grant.body).toBe(200);
      expect(grant.json().linkUrl).toContain("https://wa.me/");
      const payload = JSON.stringify(whatsappUpdate(`link ${grant.json().token}`), null, 2);
      const webhook = () =>
        app.inject({
          method: "POST",
          url: "/v1/webhooks/channels/whatsapp",
          headers: { "content-type": "application/json", ...signedMeta(payload) },
          payload
        });
      const linked = await webhook();
      expect(linked.statusCode, linked.body).toBe(200);
      expect((await webhook()).json().receipt.id).toBe(linked.json().receipt.id);
      const verification = await app.inject({
        method: "GET",
        url: "/v1/webhooks/channels/whatsapp?hub.mode=subscribe&hub.verify_token=verify-wa&hub.challenge=1234"
      });
      expect(verification.statusCode, verification.body).toBe(200);
      expect(verification.body).toBe("1234");
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/webhooks/channels/whatsapp",
        headers: { "content-type": "application/json" },
        payload
      });
      expect(rejected.statusCode).toBe(401);
      const proposal = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/runtime/turns`,
        headers: { cookie },
        payload: {
          message: `#messaging.send ${JSON.stringify({ customerId, provider: "whatsapp", text: "Your order is ready" })}`
        }
      });
      expect(proposal.statusCode, proposal.body).toBe(200);
      expect(proposal.json().turn.status).toBe("needs_confirmation");
      expect(fetcher).not.toHaveBeenCalled();
      const confirmation = {
        runtimeSessionId: proposal.json().session.id,
        message: "confirm",
        confirmationToken: proposal.json().turn.plan.confirmationToken
      };
      const execute = () =>
        app.inject({
          method: "POST",
          url: `/businesses/${businessId}/runtime/turns`,
          headers: { cookie },
          payload: confirmation
        });
      const sent = await execute();
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json().turn.status).toBe("completed");
      expect(fetcher).toHaveBeenCalledTimes(1);
      await execute();
      expect(fetcher).toHaveBeenCalledTimes(1);
      const threadId = linked.json().message.conversationId as string;
      const thread = await app.inject({
        method: "GET",
        url: `/v1/conversations/${threadId}`,
        headers: { cookie }
      });
      expect(thread.statusCode, thread.body).toBe(200);
      expect(
        thread
          .json()
          .messages.some(
            (m: { providerMessageId?: string }) => m.providerMessageId === "wamid.sent"
          )
      ).toBe(true);
      const stop = JSON.stringify(whatsappUpdate("STOP", "wamid.stop"));
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/webhooks/channels/whatsapp",
            headers: { "content-type": "application/json", ...signedMeta(stop) },
            payload: stop
          })
        ).statusCode
      ).toBe(200);
      const blocked = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/channel-messages`,
        headers: { cookie },
        payload: {
          customerId,
          provider: "whatsapp",
          text: "Another update",
          idempotencyKey: "after-opt-out"
        }
      });
      expect(blocked.statusCode).not.toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
