import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApi } from "../../app.js";
import { createCp2Store } from "../../cp2/store.js";
import { parseDeviceIngress, registerLinkedWhatsAppDeviceRoutes } from "./device-worker-routes.js";

const chat = "254711000001@s.whatsapp.net";

async function setup(enabled = true) {
  const store = createCp2Store();
  const main = buildApi({ cp2: { store } });
  async function owner(phone: string) {
    const signup = await main.inject({
      method: "POST",
      url: "/auth/pin/signup",
      payload: { method: "phone", contact: phone, pin: "1771" }
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const header = signup.headers["set-cookie"];
    const cookie = (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
    const created = await main.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie },
      payload: { name: "Phone worker shop", language: "en" }
    });
    expect(created.statusCode, created.body).toBe(200);
    return { cookie, businessId: created.json().business.id as string };
  }
  const first = await owner("254700008871");
  const second = await owner("254700008872");
  const app = Fastify();
  registerLinkedWhatsAppDeviceRoutes(
    app,
    store,
    enabled ? { WHATSAPP_LINKED_DEVICE_WORKER_ENABLED: "true" } : {}
  );
  await app.ready();
  const base = `/businesses/${first.businessId}/channels/whatsapp-linked/device`;
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: "3EB0C0FFEE01",
    chat,
    sender: chat,
    text: "Do you deliver to Kisumu?",
    timestamp: "2026-11-09T10:00:00.000Z",
    ...overrides
  });
  const messages = () =>
    store.snapshot().conversationMessages.filter((entry) => entry.provider === "whatsapp_linked");
  return {
    app,
    store,
    first,
    second,
    base,
    message,
    messages,
    close: async () => {
      await app.close();
      await main.close();
    }
  };
}

describe("WhatsApp device-worker routes", () => {
  it("stores approved-chat text from the owner's phone exactly once", async () => {
    const f = await setup();
    try {
      const scope = await f.app.inject({
        method: "POST",
        url: `${f.base}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat, approved: true }
      });
      expect(scope.statusCode, scope.body).toBe(200);
      expect(scope.headers["cache-control"]).toBe("no-store");
      const conversationId = scope.json().conversationId as string;
      expect(conversationId).toBeTruthy();

      const ingress = () =>
        f.app.inject({
          method: "POST",
          url: `${f.base}/ingress`,
          headers: { cookie: f.first.cookie },
          payload: { message: f.message() }
        });
      const stored = await ingress();
      expect(stored.statusCode, stored.body).toBe(200);
      expect(stored.json()).toEqual({ received: true, duplicate: false });
      const replay = await ingress();
      expect(replay.json()).toEqual({ received: true, duplicate: true });
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]).toMatchObject({
        conversationId,
        content: { type: "text", text: "Do you deliver to Kisumu?" }
      });

      // Same approval twice reuses the conversation.
      const again = await f.app.inject({
        method: "POST",
        url: `${f.base}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat, approved: true }
      });
      expect(again.json().conversationId).toBe(conversationId);
    } finally {
      await f.close();
    }
  });

  it("refuses chats that were never approved, so the phone revokes them", async () => {
    const f = await setup();
    try {
      const result = await f.app.inject({
        method: "POST",
        url: `${f.base}/ingress`,
        headers: { cookie: f.first.cookie },
        payload: { message: f.message({ chat: "254711000009@s.whatsapp.net" }) }
      });
      expect(result.statusCode).toBe(404);
      expect(result.json().code).toBe("conversation_channel_not_found");
      expect(f.messages()).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("accepts nothing beyond the signed-in owner's own business", async () => {
    const f = await setup();
    try {
      for (const request of [
        { cookie: f.second.cookie, url: `${f.base}/scopes`, payload: { chat, approved: true } },
        { cookie: f.second.cookie, url: `${f.base}/ingress`, payload: { message: f.message() } },
        { cookie: undefined, url: `${f.base}/ingress`, payload: { message: f.message() } }
      ]) {
        const result = await f.app.inject({
          method: "POST",
          url: request.url,
          ...(request.cookie ? { headers: { cookie: request.cookie } } : {}),
          payload: request.payload
        });
        expect([401, 403, 404]).toContain(result.statusCode);
      }
      expect(f.messages()).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("refuses every request unless the host enables device workers", async () => {
    const f = await setup(false);
    try {
      const result = await f.app.inject({
        method: "POST",
        url: `${f.base}/ingress`,
        headers: { cookie: f.first.cookie },
        payload: { message: f.message() }
      });
      expect(result.statusCode).toBe(404);
      expect(result.json().code).toBe("whatsapp_device_worker_disabled");
      expect(f.messages()).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("validates every field of device input", () => {
    const valid = {
      id: "ABC123",
      chat,
      sender: "254711000002:12@s.whatsapp.net",
      text: "hi",
      timestamp: "2026-11-09T10:00:00Z"
    };
    expect(parseDeviceIngress(valid).timestamp).toBe("2026-11-09T10:00:00.000Z");
    expect(
      parseDeviceIngress({ ...valid, mutation: { kind: "delete", targetId: "X1", fromMe: false } })
        .mutation
    ).toEqual({
      kind: "delete",
      targetId: "X1",
      fromMe: false
    });
    for (const bad of [
      null,
      { ...valid, id: "../x" },
      { ...valid, chat: "status@broadcast" },
      { ...valid, sender: "someone" },
      { ...valid, text: "" },
      { ...valid, text: "x".repeat(4001) },
      { ...valid, timestamp: "yesterday" },
      { ...valid, replyTo: 5 },
      { ...valid, mutation: { kind: "receipt", targetId: "X", fromMe: false, status: "read" } },
      { ...valid, mutation: { kind: "rewrite", targetId: "X", fromMe: true } }
    ])
      expect(() => parseDeviceIngress(bad)).toThrow();
  });
});
