import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import {
  createCp2Store,
  type PushNotificationPayload,
  type PushNotificationSender
} from "../services/api/src/cp2/store";
import type { NetworkConnectionSummary, NetworkGraphSummary } from "../packages/shared-types/src";

// Push for connection requests (docs/architecture/phonebook-identity-resolution.md): the other
// person is pushed when someone asks to connect or accepts; never for a decline, and never twice
// for the same request.

type App = ReturnType<typeof buildApi>;

const alicePhone = "+254711000101";
const bobPhone = "+254711000102";

interface Delivery {
  endpoint: string;
  payload: PushNotificationPayload;
}

function setup(outcome: Awaited<ReturnType<PushNotificationSender>> = "sent") {
  const deliveries: Delivery[] = [];
  const sender = vi.fn<PushNotificationSender>(async (subscription, payload) => {
    deliveries.push({ endpoint: subscription.endpoint, payload });
    return outcome;
  });
  const store = createCp2Store({ pushNotificationSender: sender });
  const app = buildApi({ cp2: { store, vapidPublicKey: "test-vapid-public-key" } });
  return { app, store, sender, deliveries };
}

describe("connection request push", () => {
  it("pushes the recipient on a request and the requester on acceptance", async () => {
    const { app, deliveries } = setup();
    const alice = await signUp(app, alicePhone);
    const bob = await signUp(app, bobPhone);
    await subscribe(app, alice, "https://push.example.test/alice");
    await subscribe(app, bob, "https://push.example.test/bob");

    const request = await connect(app, alice, "Bob", bobPhone);
    await settle();
    expect(deliveries).toEqual([
      {
        endpoint: "https://push.example.test/bob",
        payload: expect.objectContaining({
          type: "network.connection",
          event: "requested",
          connectionId: request.id,
          title: expect.stringMatching(/wants to connect on Soko$/u)
        })
      }
    ]);

    await post(app, `/network/connections/${request.id}/respond`, bob, { accept: true });
    await settle();
    expect(deliveries[1]).toEqual({
      endpoint: "https://push.example.test/alice",
      payload: expect.objectContaining({
        event: "accepted",
        // Alice's own name for Bob, from her phonebook.
        title: "You are now connected with Bob"
      })
    });
    expect(deliveries).toHaveLength(2);
    await app.close();
  });

  it("never pushes a decline, and cancel-and-ask does not push the recipient again", async () => {
    const { app, deliveries } = setup();
    const alice = await signUp(app, alicePhone);
    const bob = await signUp(app, bobPhone);
    await subscribe(app, alice, "https://push.example.test/alice");
    await subscribe(app, bob, "https://push.example.test/bob");

    const request = await connect(app, alice, "Bob", bobPhone);
    await post(app, `/network/connections/${request.id}/respond`, bob, { accept: false });
    await remove(app, alice, request.id);
    await connect(app, alice, "Bob", bobPhone);
    await settle();

    // Only the original request reached Bob; nothing about the decline reached Alice.
    expect(deliveries.map((delivery) => delivery.endpoint)).toEqual([
      "https://push.example.test/bob"
    ]);
    await app.close();
  });

  it("pushes the first requester when the other side asks back (mutual)", async () => {
    const { app, deliveries } = setup();
    const alice = await signUp(app, alicePhone);
    const bob = await signUp(app, bobPhone);
    await subscribe(app, alice, "https://push.example.test/alice");

    await connect(app, alice, "Bob", bobPhone);
    await connect(app, bob, "Alice", alicePhone);
    await settle();

    expect(deliveries).toEqual([
      {
        endpoint: "https://push.example.test/alice",
        payload: expect.objectContaining({ event: "accepted" })
      }
    ]);
    await app.close();
  });

  it("keeps requests working when push fails, and drops expired subscriptions", async () => {
    const failing = setup();
    failing.sender.mockRejectedValue(new Error("push service down"));
    const alice = await signUp(failing.app, alicePhone);
    const bob = await signUp(failing.app, bobPhone);
    await subscribe(failing.app, bob, "https://push.example.test/bob");
    const request = await connect(failing.app, alice, "Bob", bobPhone);
    await settle();
    expect(request.status).toBe("pending");
    await failing.app.close();

    const expired = setup("expired");
    const carol = await signUp(expired.app, alicePhone);
    const dan = await signUp(expired.app, bobPhone);
    await subscribe(expired.app, dan, "https://push.example.test/dan");
    await connect(expired.app, carol, "Dan", bobPhone);
    await settle();
    expect(expired.store.snapshot().pushSubscriptions).toEqual([]);
    expect(expired.store.snapshot().auditEvents).toContainEqual(
      expect.objectContaining({
        type: "network.connection_push",
        payload: expect.objectContaining({ targeted: 1, expired: 1 })
      })
    );
    await expired.app.close();
  });
});

/** Pushes run off the request path; let them finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function signUp(app: App, phone: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: phone, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
}

async function subscribe(app: App, cookie: string, endpoint: string) {
  await post(app, "/v1/push/subscriptions", cookie, {
    endpoint,
    expirationTime: null,
    keys: { auth: "AAAAAAAAAAAAAAAAAAAAAA", p256dh: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }
  });
}

async function connect(app: App, cookie: string, name: string, phone: string) {
  const graph = await post<NetworkGraphSummary>(app, "/network/sync/contacts", cookie, {
    mode: "merge",
    contacts: [{ name, phone }]
  });
  return post<NetworkConnectionSummary>(app, "/network/connections", cookie, {
    nodeId: graph.syncedContactNodeIds?.[0]
  });
}

async function remove(app: App, cookie: string, connectionId: string) {
  const response = await app.inject({
    method: "DELETE",
    url: `/network/connections/${connectionId}`,
    headers: { cookie }
  });
  expect(response.statusCode).toBe(200);
}

async function post<T>(app: App, url: string, cookie: string, payload: unknown): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
