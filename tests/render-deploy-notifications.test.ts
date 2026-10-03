import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Webhook } from "standardwebhooks";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const testWebhookSecret = "whsec_dGVzdC1zaWduaW5nLXNlY3JldC1mb3ItcmVuZGVyLWRlcGxveXM=";

describe("Cp2Store.broadcastAppUpdateAvailable", () => {
  it("sends an app.update_available push to every stored subscription", async () => {
    const deliveries: Array<{ endpoint: string; payload: unknown }> = [];
    const store = createCp2Store({
      pushNotificationSender: async (subscription, payload) => {
        deliveries.push({ endpoint: subscription.endpoint, payload });
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store, vapidPublicKey: "test-vapid-public-key" } });
    const cookie = await createAccountSession(app, "254700000101");
    await postJson(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: "https://push.example.test/subscriber-a",
        expirationTime: null,
        keys: { auth: "AAAAAAAAAAAAAAAAAAAAAA", p256dh: "B".repeat(43) }
      },
      cookie
    );

    const summary = await store.broadcastAppUpdateAvailable({
      deployId: "evt-happy-path",
      service: "grogoni",
      title: "Grogoni update available",
      body: "The Grogoni API and database just deployed a new version. Open Grogoni to refresh."
    });

    expect(summary).toEqual({ targeted: 1, sent: 1, expired: 0, failed: 0 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.endpoint).toBe("https://push.example.test/subscriber-a");
    expect(deliveries[0]?.payload).toEqual({
      type: "app.update_available",
      deployId: "evt-happy-path",
      service: "grogoni",
      title: "Grogoni update available",
      body: "The Grogoni API and database just deployed a new version. Open Grogoni to refresh."
    });

    await app.close();
  });

  it("prunes subscriptions the push service reports as expired", async () => {
    const store = createCp2Store({
      pushNotificationSender: async () => "expired"
    });
    const app = buildApi({ cp2: { store, vapidPublicKey: "test-vapid-public-key" } });
    const cookie = await createAccountSession(app, "254700000102");
    await postJson(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: "https://push.example.test/subscriber-b",
        expirationTime: null,
        keys: { auth: "AAAAAAAAAAAAAAAAAAAAAA", p256dh: "B".repeat(43) }
      },
      cookie
    );
    expect(store.snapshot().pushSubscriptions).toHaveLength(1);

    const summary = await store.broadcastAppUpdateAvailable({
      deployId: "evt-expired",
      service: "grogoni",
      title: "Grogoni update available",
      body: "Grogoni just deployed a new version. Open Grogoni to refresh."
    });

    expect(summary).toEqual({ targeted: 1, sent: 0, expired: 1, failed: 0 });
    expect(store.snapshot().pushSubscriptions).toHaveLength(0);

    await app.close();
  });

  it("is a no-op when no push sender is configured", async () => {
    const store = createCp2Store();
    const summary = await store.broadcastAppUpdateAvailable({
      deployId: "evt-no-sender",
      service: "grogoni",
      title: "Grogoni update available",
      body: "Ignored."
    });
    expect(summary).toEqual({ targeted: 0, sent: 0, expired: 0, failed: 0 });
  });
});

describe("POST /internal/render/deploy-webhook", () => {
  it("broadcasts an update-available push on a verified, successful deploy_ended event", async () => {
    const deliveries: unknown[] = [];
    const store = createCp2Store({
      pushNotificationSender: async (_subscription, payload) => {
        deliveries.push(payload);
        return "sent";
      }
    });
    const app = buildApi({
      cp2: { store, vapidPublicKey: "test-vapid-public-key" },
      renderDeployWebhookSecret: testWebhookSecret
    });
    const cookie = await createAccountSession(app, "254700000111");
    await postJson(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: "https://push.example.test/subscriber-c",
        expirationTime: null,
        keys: { auth: "AAAAAAAAAAAAAAAAAAAAAA", p256dh: "B".repeat(43) }
      },
      cookie
    );

    const response = await sendRenderWebhook(app, testWebhookSecret, {
      type: "deploy_ended",
      timestamp: new Date().toISOString(),
      data: {
        id: `evt-${randomUUID()}`,
        serviceId: "srv-abc123",
        serviceName: "grogoni",
        status: "succeeded"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: "render_webhook_processed", sent: 1 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      type: "app.update_available",
      service: "grogoni"
    });

    await app.close();
  });

  it("rejects a request with an invalid signature", async () => {
    const store = createCp2Store({ pushNotificationSender: async () => "sent" });
    const app = buildApi({ cp2: { store }, renderDeployWebhookSecret: testWebhookSecret });

    const eventId = `evt-${randomUUID()}`;
    const timestamp = new Date();
    const body = JSON.stringify({
      type: "deploy_ended",
      data: { id: eventId, serviceName: "grogoni", status: "succeeded" }
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/render/deploy-webhook",
      headers: {
        "content-type": "application/json",
        "webhook-id": eventId,
        "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "webhook-signature": "v1,not-a-real-signature"
      },
      payload: body
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "render_webhook_signature_invalid" });

    await app.close();
  });

  it("ignores a deploy_ended event that did not succeed", async () => {
    const deliveries: unknown[] = [];
    const store = createCp2Store({
      pushNotificationSender: async (_subscription, payload) => {
        deliveries.push(payload);
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store }, renderDeployWebhookSecret: testWebhookSecret });

    const response = await sendRenderWebhook(app, testWebhookSecret, {
      type: "deploy_ended",
      data: {
        id: `evt-${randomUUID()}`,
        serviceName: "grogoni",
        status: "failed"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ code: "render_webhook_ignored" });
    expect(deliveries).toHaveLength(0);

    await app.close();
  });

  it("ignores a successful deploy for a service outside the notified allowlist", async () => {
    const deliveries: unknown[] = [];
    const store = createCp2Store({
      pushNotificationSender: async (_subscription, payload) => {
        deliveries.push(payload);
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store }, renderDeployWebhookSecret: testWebhookSecret });

    const response = await sendRenderWebhook(app, testWebhookSecret, {
      type: "deploy_ended",
      data: {
        id: `evt-${randomUUID()}`,
        serviceName: "grogoni-db-backup",
        status: "succeeded"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ code: "render_webhook_service_not_notified" });
    expect(deliveries).toHaveLength(0);

    await app.close();
  });

  it("deduplicates a replayed webhook-id instead of double-broadcasting", async () => {
    const deliveries: unknown[] = [];
    const store = createCp2Store({
      pushNotificationSender: async (_subscription, payload) => {
        deliveries.push(payload);
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store }, renderDeployWebhookSecret: testWebhookSecret });
    const cookie = await createAccountSession(app, "254700000112");
    await postJson(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: "https://push.example.test/subscriber-d",
        expirationTime: null,
        keys: { auth: "AAAAAAAAAAAAAAAAAAAAAA", p256dh: "B".repeat(43) }
      },
      cookie
    );

    const event = {
      type: "deploy_ended",
      data: {
        id: `evt-${randomUUID()}`,
        serviceName: "grogoni",
        status: "succeeded"
      }
    };

    const first = await sendRenderWebhook(app, testWebhookSecret, event);
    const second = await sendRenderWebhook(app, testWebhookSecret, event);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ code: "render_webhook_duplicate" });
    expect(deliveries).toHaveLength(1);

    await app.close();
  });
});

async function sendRenderWebhook(app: FastifyInstance, secret: string, event: unknown) {
  const body = JSON.stringify(event);
  const webhook = new Webhook(secret);
  const eventId =
    typeof event === "object" && event !== null && "data" in event
      ? ((event as { data?: { id?: string } }).data?.id ?? randomUUID())
      : randomUUID();
  const timestamp = new Date();
  const signature = webhook.sign(eventId, timestamp, body);

  return app.inject({
    method: "POST",
    url: "/internal/render/deploy-webhook",
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": signature
    },
    payload: body
  });
}

async function createAccountSession(app: FastifyInstance, destination: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  const cookie = response.headers["set-cookie"];
  const value = Array.isArray(cookie) ? cookie[0] : cookie;
  if (value === undefined) throw new Error("Session cookie missing");
  return value.split(";")[0] ?? value;
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}
