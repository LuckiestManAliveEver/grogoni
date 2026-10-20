import { createHmac } from "node:crypto";
import { validateRuntimeToolInput } from "../packages/tool-core/src/validation/runtime";
import { describe, expect, it, vi } from "vitest";
import { createChannelGatewayFromEnvironment } from "../services/api/src/messaging/channel-gateway";

import {
  messagingEnvironment,
  providerEndpoint,
  signedMeta,
  whatsappUpdate
} from "./fixtures/external-messaging";

describe("external messaging API adapters", () => {
  it("rejects a sender account bound to two shops", () => {
    expect(() =>
      createChannelGatewayFromEnvironment({
        EXTERNAL_MESSAGING_CONNECTIONS_JSON: JSON.stringify({
          "shop-1": messagingEnvironment("shop-1"),
          "shop-2": messagingEnvironment("shop-2")
        })
      })
    ).toThrow("exactly one shop");
  });
  it("preserves the provider inbound timestamp for reply-window enforcement", () => {
    const gateway = createChannelGatewayFromEnvironment(messagingEnvironment());
    const update = whatsappUpdate();
    update.entry[0]!.changes[0]!.value.messages[0]!.timestamp = "1700000000";
    const rawBody = Buffer.from(JSON.stringify(update));
    const messages = gateway.normalizeInboundBatch({
      provider: "whatsapp",
      payload: update,
      rawBody,
      headers: signedMeta(rawBody.toString())
    });
    expect(messages[0]!.receivedAt).toBe(new Date(1700000000000).toISOString());
  });
  it.each(["slack", " email ", "EMAIL", "", null])(
    "rejects unsupported explicit routes without falling back: %s",
    (provider) => {
      expect(
        validateRuntimeToolInput("messaging.send", {
          customerId: "customer",
          text: "Hello",
          provider
        }).ok
      ).toBe(false);
    }
  );
  it.each(["whatsapp", "messenger", "instagram", "x", "sms"] as const)(
    "sends %s through its official API with an authoritative message receipt",
    async (provider) => {
      const fetcher = vi.fn(async () =>
        Response.json(
          provider === "whatsapp"
            ? { messages: [{ id: "sent-id" }] }
            : provider === "x"
              ? { data: { dm_event_id: "sent-id" } }
              : provider === "sms"
                ? { sid: "sent-id", status: "queued" }
                : { message_id: "sent-id" }
        )
      );
      const gateway = createChannelGatewayFromEnvironment(messagingEnvironment(), fetcher);
      const sent = await gateway.send({
        businessId: "shop-1",
        conversationId: "conversation",
        customerId: "customer",
        idempotencyKey: "once",
        text: "Order ready",
        endpoints: [providerEndpoint(provider)],
        preferredProvider: provider
      });
      expect(sent.result.providerMessageId).toBe("sent-id");
      expect(sent.result.status).toBe(provider === "sms" ? "queued" : "sent");
      const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      const hosts = {
        whatsapp: "graph.facebook.com",
        messenger: "graph.facebook.com",
        instagram: "graph.instagram.com",
        x: "api.x.com",
        sms: "api.twilio.com"
      };
      expect(new URL(url).hostname).toBe(hosts[provider]);
      if (provider === "sms")
        expect(new URLSearchParams(String(request.body)).get("To")).toBe("+442079460993");
      else {
        const body = JSON.parse(String(request.body));
        if (provider === "whatsapp")
          expect(body).toMatchObject({
            to: "201",
            messaging_product: "whatsapp",
            text: { body: "Order ready" }
          });
        else if (provider === "x") expect(body).toEqual({ text: "Order ready" });
        else
          expect(body).toMatchObject({
            recipient: { id: "201" },
            message: { text: "Order ready" }
          });
      }
    }
  );
  it("does not enable credentials for another shop", async () => {
    const fetcher = vi.fn();
    const gateway = createChannelGatewayFromEnvironment(messagingEnvironment(), fetcher);
    expect(
      gateway
        .providerReadiness({ businessId: "other-shop" })
        .filter((p) => ["whatsapp", "messenger", "instagram", "x", "sms"].includes(p.provider))
        .every((p) => !p.configured)
    ).toBe(true);
    await expect(
      gateway.send({
        businessId: "other-shop",
        conversationId: "conversation",
        customerId: "customer",
        idempotencyKey: "once",
        text: "Hello",
        endpoints: [providerEndpoint("whatsapp")],
        preferredProvider: "whatsapp"
      })
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONNECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies exact bytes, rejects tampering and routes every message in a Meta batch to the bound shop", () => {
    const gateway = createChannelGatewayFromEnvironment(messagingEnvironment());
    const payload = whatsappUpdate("link " + "a".repeat(32));
    const value = payload.entry[0]!.changes[0]!.value;
    value.messages.push({ ...value.messages[0]!, id: "second", text: { body: "Order update" } });
    const rawBody = Buffer.from(JSON.stringify(payload, null, 2));
    const headers = signedMeta(rawBody.toString());
    const events = gateway.normalizeInboundBatch({
      provider: "whatsapp",
      headers,
      payload,
      rawBody
    });
    expect(events.map((e) => [e.businessId, e.externalConversationId, e.externalUpdateId])).toEqual(
      [
        ["shop-1", "101:201", "wamid.inbound"],
        ["shop-1", "101:201", "second"]
      ]
    );
    expect(events[0]?.linkToken).toBe("a".repeat(32));
    expect(() =>
      gateway.normalizeInboundBatch({
        provider: "whatsapp",
        headers,
        payload,
        rawBody: Buffer.from(JSON.stringify(payload))
      })
    ).toThrow("Webhook authentication failed");
    const wrong = whatsappUpdate();
    wrong.entry[0]!.changes[0]!.value.metadata.phone_number_id = "999";
    const bytes = Buffer.from(JSON.stringify(wrong));
    expect(() =>
      gateway.normalizeInboundBatch({
        provider: "whatsapp",
        headers: signedMeta(bytes.toString()),
        payload: wrong,
        rawBody: bytes
      })
    ).toThrow("Webhook authentication failed");
  });
  it("enforces the Meta reply window before making a request", async () => {
    const fetcher = vi.fn();
    const gateway = createChannelGatewayFromEnvironment(messagingEnvironment(), fetcher);
    const endpoint = providerEndpoint("whatsapp");
    endpoint.lastInboundAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await expect(
      gateway.send({
        businessId: "shop-1",
        conversationId: "conversation",
        customerId: "customer",
        idempotencyKey: "once",
        text: "Hello",
        endpoints: [endpoint],
        preferredProvider: "whatsapp"
      })
    ).rejects.toMatchObject({ code: "CHANNEL_REPLY_WINDOW_EXPIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not schedule ambiguous sends for automatic retry or report a missing provider receipt as sent", async () => {
    const failed = createChannelGatewayFromEnvironment(
      messagingEnvironment(),
      vi.fn().mockRejectedValue(new Error("network"))
    );
    const send = (gateway: ReturnType<typeof createChannelGatewayFromEnvironment>) =>
      gateway.send({
        businessId: "shop-1",
        conversationId: "conversation",
        customerId: "customer",
        idempotencyKey: "once",
        text: "Hello",
        endpoints: [providerEndpoint("whatsapp")],
        preferredProvider: "whatsapp"
      });
    await expect(send(failed)).rejects.toMatchObject({
      code: "CHANNEL_SEND_FAILED",
      retryable: false
    });
    await expect(
      send(
        createChannelGatewayFromEnvironment(messagingEnvironment(), async () => Response.json({}))
      )
    ).rejects.toMatchObject({ code: "CHANNEL_SEND_FAILED" });
  });
  it("handles Meta subscription verification without exposing tokens", () => {
    const gateway = createChannelGatewayFromEnvironment(messagingEnvironment());
    expect(
      gateway.webhookChallenge("whatsapp", {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-wa",
        "hub.challenge": "challenge"
      })
    ).toBe("challenge");
    expect(
      gateway.webhookChallenge("whatsapp", {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "challenge"
      })
    ).toBeNull();
  });
  it("validates Twilio's signed form and links only its configured receiving number", () => {
    const environment = messagingEnvironment();
    const gateway = createChannelGatewayFromEnvironment(environment);
    const payload = {
      AccountSid: environment.TWILIO_ACCOUNT_SID,
      To: environment.TWILIO_FROM_NUMBER,
      From: "+442079460993",
      MessageSid: "SM-inbound",
      Body: "Hello"
    };
    const signature = createHmac("sha1", environment.TWILIO_AUTH_TOKEN)
      .update(
        environment.TWILIO_WEBHOOK_URL +
          Object.keys(payload)
            .sort()
            .map((key) => key + payload[key as keyof typeof payload])
            .join("")
      )
      .digest("base64");
    const events = gateway.normalizeInboundBatch({
      provider: "sms",
      payload,
      rawBody: Buffer.from(new URLSearchParams(payload).toString()),
      headers: { "x-twilio-signature": signature }
    });
    expect(events[0]).toMatchObject({
      businessId: "shop-1",
      externalUserId: "+442079460993",
      text: "Hello"
    });
  });
});
