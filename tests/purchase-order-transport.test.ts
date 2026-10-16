import { describe, expect, it, vi } from "vitest";
import {
  createWhatsAppPurchaseOrderDelivery,
  purchaseOrderMessage
} from "../services/api/src/messaging/purchase-order-delivery";
import type { PurchaseOrderReceipt } from "../services/api/src/cp2/domains/agent-runtime/purchase-order-store";

const actor = { sessionId: "buyer-user", businessId: "buyer" };
const input = {
  draftId: "draft",
  draftDigest: "a".repeat(64),
  channel: "whatsapp" as const,
  recipient: "+254700000001",
  optInConfirmed: true
};
const order: PurchaseOrderReceipt = {
  order_id: "order",
  business_id: "buyer",
  draft_id: "draft",
  actor_id: "buyer-user",
  draft_digest: input.draftDigest,
  channel: "whatsapp",
  recipient: input.recipient,
  recipient_business_id: null,
  mailbox_id: null,
  status: "DISPATCHING",
  revision: 0,
  provider_message_id: null,
  error_code: null,
  created_at: new Date(),
  updated_at: new Date(),
  snapshot: {
    id: "draft",
    businessId: "buyer",
    supplierId: "supplier",
    currency: "KES",
    totalMinor: 12000,
    items: [{ productId: "Beans", quantityMilli: 2000, totalMinor: 12000, unit: "kg" }]
  }
};
const config = {
  buyer: {
    token: "private-token-not-for-logs",
    phoneNumberId: "123456",
    apiVersion: "v23.0",
    templateName: "approved_purchase_order",
    language: "en_US"
  }
};
describe("buyer-scoped WhatsApp purchase order transport", () => {
  it("fails closed for missing configuration, another buyer or missing consent without network calls", async () => {
    const request = vi.fn();
    const delivery = createWhatsAppPurchaseOrderDelivery(
      { PURCHASE_ORDER_WHATSAPP_SENDERS: JSON.stringify(config) },
      request
    );
    await expect(delivery.check({ ...actor, businessId: "other" }, input)).rejects.toThrow(
      "Connect"
    );
    await expect(delivery.check(actor, { ...input, optInConfirmed: false })).rejects.toThrow(
      "consent"
    );
    await expect(
      createWhatsAppPurchaseOrderDelivery({}, request).check(actor, input)
    ).rejects.toThrow("Connect");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses only the fixed Meta endpoint and approved template, with no fallback or delivered claim", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.real" }] }), { status: 200 })
    );
    const delivery = createWhatsAppPurchaseOrderDelivery(
      { PURCHASE_ORDER_WHATSAPP_SENDERS: JSON.stringify(config) },
      request
    );
    await delivery.check(actor, input);
    expect(await delivery.send(actor, input, order)).toEqual({ providerMessageId: "wamid.real" });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v23.0/123456/messages");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(String(options.body))).toMatchObject({
      messaging_product: "whatsapp",
      to: "254700000001",
      type: "template",
      template: {
        name: "approved_purchase_order",
        components: [
          { type: "body", parameters: [{ type: "text", text: purchaseOrderMessage(order) }] }
        ]
      }
    });
  });
  it.each([
    new Response("SECRET provider body", { status: 500 }),
    new Response("{}", { status: 200 })
  ])(
    "rejects missing provider acknowledgments without exposing response bodies or retrying",
    async (response) => {
      const request = vi.fn(async () => response);
      const delivery = createWhatsAppPurchaseOrderDelivery(
        { PURCHASE_ORDER_WHATSAPP_SENDERS: JSON.stringify(config) },
        request
      );
      await expect(delivery.send(actor, input, order)).rejects.toThrow(/acknowledgment|identifier/);
      expect(request).toHaveBeenCalledTimes(1);
    }
  );
});
