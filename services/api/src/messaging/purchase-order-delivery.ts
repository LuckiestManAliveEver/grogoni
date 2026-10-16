import { Cp2Error } from "../cp2/cp2-error.js";
import type {
  PurchaseOrderDelivery,
  PurchaseOrderReceipt
} from "../cp2/domains/agent-runtime/purchase-order-store.js";

export function purchaseOrderMessage(order: PurchaseOrderReceipt): string {
  const draft = order.snapshot;
  return [
    `Purchase order ${order.order_id}`,
    `Buyer: ${order.business_id}`,
    ...draft.items.map(
      (item) =>
        `${item.productId}: ${item.quantityMilli / 1000} ${item.unit}; ${draft.currency} ${(item.totalMinor / 100).toFixed(2)}`
    ),
    `Total: ${draft.currency} ${(draft.totalMinor / 100).toFixed(2)}`,
    "Please confirm acceptance. This message is not proof of payment or delivery."
  ].join("\n");
}

/** Buyer-scoped operator secrets; never accepts a client-supplied URL or token. */
export function createWhatsAppPurchaseOrderDelivery(
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch
): PurchaseOrderDelivery {
  function sender(businessId: string) {
    let settings: unknown;
    try {
      settings = JSON.parse(environment.PURCHASE_ORDER_WHATSAPP_SENDERS ?? "{}");
    } catch {
      throw new Cp2Error(
        503,
        "purchase_order_channel_unavailable",
        "WhatsApp sender configuration is invalid."
      );
    }
    const config =
      settings &&
      typeof settings === "object" &&
      !Array.isArray(settings) &&
      Object.hasOwn(settings, businessId)
        ? ((settings as Record<string, unknown>)[businessId] as Record<string, unknown>)
        : undefined;
    if (
      !config ||
      typeof config.token !== "string" ||
      config.token.length < 20 ||
      typeof config.phoneNumberId !== "string" ||
      !/^[0-9]+$/.test(config.phoneNumberId) ||
      typeof config.apiVersion !== "string" ||
      !/^v[0-9]+\.0$/.test(config.apiVersion) ||
      typeof config.templateName !== "string" ||
      !/^[a-z0-9_]+$/.test(config.templateName) ||
      typeof config.language !== "string" ||
      !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(config.language)
    )
      throw new Cp2Error(
        503,
        "purchase_order_channel_unavailable",
        "Connect an approved WhatsApp sender and utility template for this buyer business."
      );
    return config as {
      token: string;
      phoneNumberId: string;
      apiVersion: string;
      templateName: string;
      language: string;
    };
  }
  return {
    async check(actor, input) {
      if (
        input.channel !== "whatsapp" ||
        input.optInConfirmed !== true ||
        !/^\+[1-9][0-9]{7,14}$/.test(input.recipient)
      )
        throw new Cp2Error(
          400,
          "purchase_order_channel_invalid",
          "Exact WhatsApp recipient and consent are required."
        );
      sender(actor.businessId);
    },
    async send(actor, input, order) {
      const config = sender(actor.businessId);
      const text = purchaseOrderMessage(order);
      if (text.length > 1024)
        throw new Error("Order exceeds the approved template parameter limit.");
      const response = await request(
        `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: input.recipient.slice(1),
            type: "template",
            template: {
              name: config.templateName,
              language: { code: config.language },
              components: [{ type: "body", parameters: [{ type: "text", text }] }]
            }
          })
        }
      );
      if (!response.ok) throw new Error("WhatsApp provider acknowledgment unavailable.");
      const body = (await response.json()) as { messages?: { id?: string }[] };
      const providerMessageId = body.messages?.[0]?.id;
      if (!providerMessageId) throw new Error("WhatsApp provider message identifier missing.");
      return { providerMessageId };
    }
  };
}
