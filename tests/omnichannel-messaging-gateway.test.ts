import { readFile } from "node:fs/promises";
import type {
  ChannelCapability,
  ChannelEndpointSummary,
  ChannelProvider
} from "@grogoni/shared-types";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  ChannelGatewayError,
  createChannelGatewayFromEnvironment
} from "../services/api/src/messaging/channel-gateway";

describe("omnichannel messaging gateway", () => {
  it("links Telegram to one canonical customer and sends idempotently through the official adapter", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 991 } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const gateway = createChannelGatewayFromEnvironment(
      {
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
        TELEGRAM_BOT_USERNAME: "grogoni_test_bot"
      },
      fetcher
    );
    const store = createCp2Store({ channelGateway: gateway });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000771", "Gateway Shop", "1771");
    const customer = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/customers`,
      { name: "Brian", phone: null, email: null, notes: null },
      owner.cookie
    );
    const grant = await postJson<{ token: string; linkUrl: string }>(
      app,
      `/businesses/${owner.business.id}/customers/${customer.id}/channel-link-grants`,
      { provider: "telegram", automaticRepliesEnabled: false },
      owner.cookie
    );
    expect(grant.linkUrl).toContain("https://t.me/grogoni_test_bot?start=");

    const webhookPayload = {
      update_id: 5501,
      message: {
        message_id: 4401,
        from: { id: 3301, first_name: "Brian" },
        chat: { id: 2201 },
        text: `/start ${grant.token}`
      }
    };
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/webhooks/channels/telegram",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(webhookPayload)
    });
    expect(rejected.statusCode).toBe(401);

    const linked = await app.inject({
      method: "POST",
      url: "/v1/webhooks/channels/telegram",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret"
      },
      payload: JSON.stringify(webhookPayload)
    });
    expect(linked.statusCode, linked.body).toBe(200);
    const duplicateWebhook = await app.inject({
      method: "POST",
      url: "/v1/webhooks/channels/telegram",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret"
      },
      payload: JSON.stringify(webhookPayload)
    });
    expect(duplicateWebhook.statusCode, duplicateWebhook.body).toBe(200);
    expect(duplicateWebhook.json<{ receipt: { id: string } }>().receipt.id).toBe(
      linked.json<{ receipt: { id: string } }>().receipt.id
    );
    const snapshot = store.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(grant.token);
    expect(snapshot.platformIdentities).toEqual([
      expect.objectContaining({
        provider: "telegram",
        accountId: null,
        customerId: customer.id,
        externalUserId: "3301"
      })
    ]);
    expect(snapshot.conversationMessages).toEqual([
      expect.objectContaining({
        provider: "telegram",
        direction: "inbound",
        providerMessageId: "4401"
      })
    ]);

    const conversationId = snapshot.conversationChannels?.[0]?.conversationId as string;
    const request = {
      conversationId,
      provider: "telegram",
      text: "Your order is ready.",
      idempotencyKey: "gateway-send-brian-001"
    };
    const first = await postJson<{ message: { id: string; status: string; provider: string } }>(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      request,
      owner.cookie
    );
    const duplicate = await postJson<{ message: { id: string } }>(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      request,
      owner.cookie
    );
    expect(first.message).toMatchObject({ status: "sent", provider: "telegram" });
    expect(duplicate.message.id).toBe(first.message.id);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const proposed = await postJson<{
      session: { id: string };
      turn: { status: string; plan: { toolName: string; confirmationToken: string } };
    }>(
      app,
      `/businesses/${owner.business.id}/runtime/turns`,
      { message: "Message Brian that his order is ready" },
      owner.cookie
    );
    expect(proposed.turn).toMatchObject({
      status: "needs_confirmation",
      plan: { toolName: "messaging.send" }
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const confirmed = await postJson<{ turn: { status: string; toolResult: unknown } }>(
      app,
      `/businesses/${owner.business.id}/runtime/turns`,
      {
        runtimeSessionId: proposed.session.id,
        message: "confirm",
        confirmationToken: proposed.turn.plan.confirmationToken
      },
      owner.cookie
    );
    expect(confirmed.turn).toMatchObject({
      status: "completed",
      toolResult: { message: { provider: "telegram", direction: "outbound" } }
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const readiness = await getJson<{
      providers: Array<{ provider: string; configured: boolean }>;
    }>(app, `/businesses/${owner.business.id}/channels/readiness`, owner.cookie);
    expect(readiness.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "telegram", configured: true }),
        expect.objectContaining({ provider: "whatsapp", configured: false })
      ])
    );
    await app.close();
  });

  it("reuses a customer's canonical conversation and rejects conflicting identity links", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000772", "Identity Shop", "1772");
    const first = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/customers`,
      { name: "Amina", phone: null, email: null, notes: null },
      owner.cookie
    );
    const second = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/customers`,
      { name: "Marta", phone: null, email: null, notes: null },
      owner.cookie
    );
    const sessionId = owner.cookie.slice(owner.cookie.indexOf("=") + 1);
    const telegram = store.createProviderConversation({
      sessionId,
      businessId: owner.business.id,
      customerId: first.id,
      provider: "telegram",
      externalUserId: "shared-external-id",
      externalConversationId: "telegram-thread"
    });
    const grogoni = store.createProviderConversation({
      sessionId,
      businessId: owner.business.id,
      customerId: first.id,
      provider: "grogoni",
      externalUserId: "browser-id",
      externalConversationId: "browser-thread"
    });
    expect(grogoni.channel.conversationId).toBe(telegram.channel.conversationId);
    const whatsapp = store.createProviderConversation({
      sessionId,
      businessId: owner.business.id,
      customerId: first.id,
      provider: "whatsapp",
      externalUserId: "254711000001",
      externalConversationId: "whatsapp-thread"
    });
    expect(whatsapp.channel.conversationId).toBe(telegram.channel.conversationId);
    const ownerAccountId = store.snapshot().accounts[0]?.id as string;
    const linked = await postJson<{ id: string; linkedAccountId: string }>(
      app,
      `/businesses/${owner.business.id}/customers/${first.id}/account-link`,
      { accountId: ownerAccountId },
      owner.cookie
    );
    expect(linked).toMatchObject({ id: first.id, linkedAccountId: ownerAccountId });
    const conflictingAccountLink = await app.inject({
      method: "POST",
      url: `/businesses/${owner.business.id}/customers/${second.id}/account-link`,
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify({ accountId: ownerAccountId })
    });
    expect(conflictingAccountLink.statusCode).toBe(409);
    expect(() =>
      store.createProviderConversation({
        sessionId,
        businessId: owner.business.id,
        customerId: second.id,
        provider: "telegram",
        externalUserId: "shared-external-id",
        externalConversationId: "telegram-thread"
      })
    ).toThrowError(/already linked/u);
    await app.close();
  });

  it("selects transports deterministically and explains policy failures", () => {
    const gateway = createChannelGatewayFromEnvironment({});
    const current = endpoint("telegram", ["CAN_REPLY", "REQUIRES_EXISTING_THREAD"], {
      lastInboundAt: "2026-08-13T12:00:00.000Z"
    });
    const recent = endpoint("instagram", ["CAN_REPLY", "REQUIRES_EXISTING_THREAD"], {
      lastInboundAt: "2026-08-13T13:00:00.000Z"
    });
    const grogoni = endpoint("grogoni", ["CAN_REPLY", "CAN_INITIATE"]);

    expect(
      gateway.select({ endpoints: [recent, grogoni, current], currentProvider: "telegram" })
    ).toMatchObject({ endpoint: { provider: "telegram" }, reason: "current_conversation_channel" });
    expect(gateway.select({ endpoints: [current, recent, grogoni] })).toMatchObject({
      endpoint: { provider: "instagram" },
      reason: "most_recent_reachable_channel"
    });
    expect(
      gateway.select({
        endpoints: [current, recent, grogoni],
        preferredProvider: "grogoni"
      })
    ).toMatchObject({ endpoint: { provider: "grogoni" }, reason: "preferred_channel" });

    expectGatewayCode(
      () =>
        gateway.select({
          endpoints: [
            endpoint("telegram", ["CAN_REPLY", "REQUIRES_EXISTING_THREAD"], {
              lastInboundAt: null
            })
          ],
          preferredProvider: "telegram"
        }),
      "CHANNEL_INITIATION_NOT_ALLOWED"
    );
    expectGatewayCode(
      () =>
        gateway.select({
          endpoints: [endpoint("whatsapp", ["REQUIRES_OPT_IN", "CAN_REPLY"])],
          preferredProvider: "whatsapp"
        }),
      "CHANNEL_OPT_IN_REQUIRED"
    );
    expectGatewayCode(
      () =>
        gateway.select({
          endpoints: [endpoint("whatsapp", ["REQUIRES_TEMPLATE"])],
          preferredProvider: "whatsapp"
        }),
      "CHANNEL_TEMPLATE_REQUIRED"
    );
    expectGatewayCode(
      () =>
        gateway.select({
          endpoints: [endpoint("instagram", ["CAN_REPLY"], { authorized: false })],
          preferredProvider: "instagram"
        }),
      "PROVIDER_AUTH_EXPIRED"
    );
    expectGatewayCode(
      () =>
        gateway.select({
          endpoints: [endpoint("messenger", ["CAN_REPLY"], { status: "blocked" })],
          preferredProvider: "messenger"
        }),
      "CHANNEL_UNAVAILABLE"
    );
  });

  it("ships the durable identity, message lifecycle, and grant migration", async () => {
    const migration = await readFile(
      "infra/db/migrations/053_omnichannel_messaging_gateway.sql",
      "utf8"
    );
    expect(migration).toContain("channel_identity_link_grants");
    expect(migration).toContain("linked_account_id");
    expect(migration).toContain("external_conversation_id");
    expect(migration).toContain("conversation_messages_direction_check");
    expect(migration).toContain("tiktok_business");
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin: string
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const cookie = extractCookie(signup.headers["set-cookie"]);
  const result = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name, language: "en" },
    cookie
  );
  return { business: result.business, cookie };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function extractCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Missing cookie");
  return value.split(";")[0] as string;
}

function endpoint(
  provider: ChannelProvider,
  capabilities: ChannelCapability[],
  overrides: Partial<ChannelEndpointSummary> = {}
): ChannelEndpointSummary {
  return {
    channelId: `${provider}-channel`,
    conversationId: "conversation-1",
    businessId: "business-1",
    customerId: "customer-1",
    channelIdentityId: `${provider}-identity`,
    provider,
    externalUserId: `${provider}-user`,
    externalConversationId: `${provider}-conversation`,
    capabilities,
    status: "available",
    configured: true,
    authorized: true,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...overrides
  };
}

function expectGatewayCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelGatewayError);
    expect((error as ChannelGatewayError).code).toBe(code);
  }
}
