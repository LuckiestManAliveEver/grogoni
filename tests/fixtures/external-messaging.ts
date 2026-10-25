import { createHmac } from "node:crypto";
import type { ChannelEndpointSummary, ChannelProvider } from "@grogoni/shared-types";
export function messagingEnvironment(businessId = "shop-1") {
  return {
    EXTERNAL_MESSAGING_SHOP_ID: businessId,
    WHATSAPP_ACCESS_TOKEN: "wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "101",
    WHATSAPP_PHONE_NUMBER: "+442079460991",
    WHATSAPP_APP_SECRET: "meta-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-wa",
    MESSENGER_ACCESS_TOKEN: "fb-token",
    MESSENGER_PAGE_ID: "102",
    MESSENGER_APP_SECRET: "meta-secret",
    MESSENGER_VERIFY_TOKEN: "verify-fb",
    INSTAGRAM_ACCESS_TOKEN: "ig-token",
    INSTAGRAM_ACCOUNT_ID: "103",
    INSTAGRAM_USERNAME: "fixture_shop",
    INSTAGRAM_APP_SECRET: "meta-secret",
    INSTAGRAM_VERIFY_TOKEN: "verify-ig",
    X_USER_ACCESS_TOKEN: "x-token",
    X_USER_ID: "104",
    X_CONSUMER_SECRET: "x-secret",
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "sms-secret",
    TWILIO_FROM_NUMBER: "+442079460992",
    TWILIO_WEBHOOK_URL: "https://grogoni.com/api/v1/webhooks/channels/sms"
  };
}
export function providerEndpoint(provider: ChannelProvider): ChannelEndpointSummary {
  return {
    channelId: "channel",
    conversationId: "conversation",
    businessId: "shop-1",
    customerId: "customer",
    channelIdentityId: "identity",
    provider,
    externalUserId: provider === "sms" ? "+442079460993" : "201",
    externalConversationId: "thread",
    capabilities: ["CAN_REPLY"],
    status: "available",
    configured: true,
    authorized: true,
    lastInboundAt: new Date().toISOString(),
    lastOutboundAt: null
  } as ChannelEndpointSummary;
}
export function signedMeta(body: string) {
  return {
    "x-hub-signature-256": `sha256=${createHmac("sha256", "meta-secret").update(body).digest("hex")}`
  };
}
export function whatsappUpdate(text = "Hello", id = "wamid.inbound") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "101" },
              messages: [
                {
                  id,
                  from: "201",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}
