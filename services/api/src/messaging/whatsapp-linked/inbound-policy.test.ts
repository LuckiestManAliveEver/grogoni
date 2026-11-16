import Fastify from "fastify";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../../app.js";
import { createCp2Store, type Cp2Store } from "../../cp2/store.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";
import type { LinkedDriver } from "./connector.js";
import { validateLinkedMedia, type LinkedDownloadedMedia } from "./media.js";
import { linkedOptOutCommand } from "./opt-out.js";
import {
  linkedInboundQuotaDefaults,
  linkedInboundQuotaFromEnvironment,
  linkedMediaOverQuotaText
} from "./inbound-quota.js";

const direct = "254711111111@s.whatsapp.net";
const second = "254722222222@s.whatsapp.net";
const group = "123456789@g.us";
const alice = "254733333333@s.whatsapp.net";
const bob = "254744444444@s.whatsapp.net";

describe("STOP and START recognition", () => {
  it.each([
    "STOP",
    "stop",
    "Stop.",
    "STOP!",
    " stop ",
    "stop!!!",
    "¡Stop!",
    "stop 🙏",
    "Stop all",
    "STOPALL",
    "unsubscribe",
    "Unsubscribe.",
    "opt-out",
    "Opt out",
    "optout",
    "stop\n"
  ])("%j is an opt-out", (text) => expect(linkedOptOutCommand(text)).toBe("stop"));
  it.each(["START", "start.", " Start! ", "unstop", "Subscribe", "opt in", "opt-in"])(
    "%j is an opt-in",
    (text) => expect(linkedOptOutCommand(text)).toBe("start")
  );
  it.each([
    "don't stop sending",
    "Don't stop!",
    "please stop by tomorrow",
    "stop sending me the old price list and send the new one",
    "bus stop",
    "start my order",
    "cancel",
    "end",
    "quit",
    "stopped",
    "stops",
    "",
    "stop".padEnd(80, "!")
  ])("%j is an ordinary message", (text) => expect(linkedOptOutCommand(text)).toBeNull());
});

describe("inbound quota configuration", () => {
  it("uses documented defaults and accepts positive integer overrides", () => {
    expect(linkedInboundQuotaFromEnvironment({})).toEqual(linkedInboundQuotaDefaults);
    expect(
      linkedInboundQuotaFromEnvironment({
        WHATSAPP_LINKED_INBOUND_CHAT_MESSAGES_PER_HOUR: "5",
        WHATSAPP_LINKED_INBOUND_BUSINESS_MESSAGES_PER_HOUR: " 50 ",
        WHATSAPP_LINKED_INBOUND_CHAT_MEDIA_BYTES_PER_DAY: "1000",
        WHATSAPP_LINKED_INBOUND_BUSINESS_MEDIA_BYTES_PER_DAY: ""
      })
    ).toEqual({
      ...linkedInboundQuotaDefaults,
      chatMessagesPerHour: 5,
      businessMessagesPerHour: 50,
      chatMediaBytesPerDay: 1000
    });
  });
  it.each(["0", "-1", "1.5", "lots", "1e3"])("refuses %j", (value) => {
    expect(() =>
      linkedInboundQuotaFromEnvironment({ WHATSAPP_LINKED_INBOUND_CHAT_MESSAGES_PER_HOUR: value })
    ).toThrow("positive integer");
  });
});

/** A connected owner with one direct chat, a second direct chat and one group, all approved. */
async function linkedOwner(store: Cp2Store = createCp2Store()) {
  const root = mkdtempSync(join(tmpdir(), "wa-policy-"));
  const main = buildApi({ cp2: { store } });
  const callbacks: Parameters<LinkedDriver["open"]>[0][] = [];
  const send = vi.fn(async (_chat: string, _text: string, id: string) => id);
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      callbacks.push(input);
      return {
        pairingCode: async () => "CODE1234",
        groups: async () => [{ chat: group, name: "Customers" }],
        send,
        close: vi.fn(),
        logout: async () => undefined
      };
    })
  };
  const app = Fastify();
  registerLinkedWhatsAppRoutes(
    app,
    store,
    {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_SESSION_DIR: root,
      WHATSAPP_LINKED_SESSION_KEY: "01".repeat(32)
    },
    driver,
    { transcriber: null }
  );
  await app.ready();
  const signup = await main.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "254700009891", pin: "1771" }
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const header = signup.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
  const created = await main.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie },
    payload: { name: "Quota shop", language: "en" }
  });
  const businessId = created.json().business.id as string;
  const ownerId = store
    .snapshot()
    .memberships.find((entry) => entry.businessId === businessId && entry.role === "owner")!.userId;
  const path = `/businesses/${businessId}/channels/whatsapp-linked`;
  await app.inject({
    method: "POST",
    url: `${path}/connect`,
    headers: { cookie },
    payload: { phone: "254700000000", consent: true }
  });
  callbacks[0]!.save("auth");
  callbacks[0]!.state("open");
  const conversations: Record<string, string> = {};
  for (const chat of [direct, second, group]) {
    const approved = await app.inject({
      method: "POST",
      url: `${path}/scopes`,
      headers: { cookie },
      payload: { chat, approved: true }
    });
    expect(approved.statusCode, approved.body).toBe(200);
    conversations[chat] = approved
      .json()
      .scopes.find((scope: { chat: string }) => scope.chat === chat).conversationId;
  }
  let counter = 0;
  const ingest = (chat: string, text: string, extra: { sender?: string; now?: Date } = {}) =>
    store.ingestLinkedWhatsAppMessage({
      businessId,
      ownerId,
      chat,
      sender: extra.sender ?? chat,
      id: `m-${++counter}`,
      text,
      timestamp: new Date().toISOString(),
      ...(extra.now ? { now: extra.now } : {})
    });
  const optedOut = (chat: string) =>
    store.linkedWhatsAppAccount(businessId, ownerId).chats.find((entry) => entry.chat === chat)!
      .optedOut;
  const stored = (chat: string) =>
    store
      .snapshot()
      .conversationMessages.filter(
        (message) =>
          message.conversationId === conversations[chat] && message.direction === "inbound"
      );
  const audits = (type: string) =>
    store.snapshot().auditEvents.filter((event) => event.type === type);
  const ownerSend = (chat: string, key: string) =>
    main.inject({
      method: "POST",
      url: `/businesses/${businessId}/channel-messages`,
      headers: { cookie },
      payload: {
        conversationId: conversations[chat],
        provider: "whatsapp_linked",
        text: "Hello",
        idempotencyKey: key
      }
    });
  const close = async () => {
    await app.close();
    await main.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    store,
    businessId,
    ownerId,
    conversations,
    ingest,
    optedOut,
    stored,
    audits,
    ownerSend,
    send,
    close
  };
}

describe("WhatsApp opt-out state", { timeout: 30_000 }, () => {
  it("honours punctuated STOP and START in a direct chat", async () => {
    const f = await linkedOwner();
    try {
      await f.ingest(direct, "Stop.");
      expect(f.optedOut(direct)).toBe(true);
      expect((await f.ownerSend(direct, "blocked-send")).statusCode).toBe(409);
      await f.ingest(direct, "don't stop sending");
      expect(f.optedOut(direct)).toBe(true);
      await f.ingest(direct, " START! ");
      expect(f.optedOut(direct)).toBe(false);
      expect((await f.ownerSend(direct, "allowed-send")).statusCode).toBe(200);
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("keeps a group opted out until every member who sent STOP sends START", async () => {
    const f = await linkedOwner();
    try {
      await f.ingest(group, "STOP", { sender: alice });
      expect(f.optedOut(group)).toBe(true);
      // Another member's START must not undo Alice's STOP.
      await f.ingest(group, "start", { sender: bob });
      expect(f.optedOut(group)).toBe(true);
      expect((await f.ownerSend(group, "group-blocked")).statusCode).toBe(409);
      await f.ingest(group, "Stop!", { sender: bob });
      await f.ingest(group, "START", { sender: alice });
      expect(f.optedOut(group)).toBe(true);
      await f.ingest(group, "Start.", { sender: bob });
      expect(f.optedOut(group)).toBe(false);
      expect((await f.ownerSend(group, "group-allowed")).statusCode).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("disables a group's delegated tools on any member's STOP and START does not restore them", async () => {
    const f = await linkedOwner();
    try {
      f.store.setLinkedToolGrants({
        businessId: f.businessId,
        ownerId: f.ownerId,
        chat: group,
        tools: ["products.list"],
        enabled: true
      });
      await f.ingest(group, "unsubscribe", { sender: alice });
      expect(f.store.linkedToolGrant(f.businessId, f.ownerId, group)).toMatchObject({
        enabled: false,
        tools: []
      });
      await f.ingest(group, "start", { sender: alice });
      expect(f.store.linkedToolGrant(f.businessId, f.ownerId, group)?.enabled).toBe(false);
    } finally {
      await f.close();
    }
  });
});

function pdf(label: string): LinkedDownloadedMedia {
  const bytes = Buffer.from(`%PDF-1.7\n${label}`);
  return validateLinkedMedia(
    {
      type: "document",
      mimeType: "application/pdf",
      filename: `${label}.pdf`,
      size: bytes.length,
      directPath: "/v/x",
      key: Buffer.alloc(32).toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("base64")
    },
    bytes
  );
}

describe("inbound WhatsApp quotas", { timeout: 30_000 }, () => {
  it("refuses messages over the per-chat hourly limit without blocking, auditing once", async () => {
    const f = await linkedOwner();
    try {
      f.store.setLinkedInboundQuota({ ...linkedInboundQuotaDefaults, chatMessagesPerHour: 3 });
      const now = new Date();
      for (let i = 0; i < 3; i++)
        expect(await f.ingest(direct, `order ${i}`, { now })).not.toHaveProperty("throttled");
      for (let i = 0; i < 4; i++)
        expect(await f.ingest(direct, `flood ${i}`, { now })).toMatchObject({
          throttled: true,
          message: null
        });
      expect(f.stored(direct)).toHaveLength(3);
      expect(f.audits("whatsapp_linked.inbound_throttled")).toHaveLength(1);
      expect(f.audits("whatsapp_linked.inbound_throttled")[0]!.payload).toMatchObject({
        scope: "chat",
        limit: 3,
        conversationId: f.conversations[direct]
      });
      // Another chat has its own allowance.
      expect(await f.ingest(second, "hello", { now })).not.toHaveProperty("throttled");
      // STOP always gets through, even over quota.
      expect(await f.ingest(direct, "STOP", { now })).not.toHaveProperty("throttled");
      expect(f.optedOut(direct)).toBe(true);
      // The rolling window moves on.
      const later = new Date(now.getTime() + 61 * 60_000);
      expect(await f.ingest(direct, "next hour", { now: later })).not.toHaveProperty("throttled");
    } finally {
      await f.close();
    }
  });

  it("applies the per-business limit across chats", async () => {
    const f = await linkedOwner();
    try {
      f.store.setLinkedInboundQuota({ ...linkedInboundQuotaDefaults, businessMessagesPerHour: 2 });
      await f.ingest(direct, "one");
      await f.ingest(second, "two");
      expect(await f.ingest(group, "three", { sender: alice })).toMatchObject({
        throttled: true
      });
      expect(f.audits("whatsapp_linked.inbound_throttled")[0]!.payload).toMatchObject({
        scope: "business",
        limit: 2
      });
    } finally {
      await f.close();
    }
  });

  it("keeps the text and replaces an over-quota attachment with a placeholder and an audit", async () => {
    const f = await linkedOwner();
    try {
      const first = pdf("first");
      f.store.setLinkedInboundQuota({
        ...linkedInboundQuotaDefaults,
        chatMediaBytesPerDay: first.bytes.length + 5
      });
      const base = {
        businessId: f.businessId,
        ownerId: f.ownerId,
        chat: direct,
        sender: direct,
        timestamp: new Date().toISOString()
      };
      await f.store.ingestLinkedWhatsAppMessage({
        ...base,
        id: "media-1",
        text: "Invoice",
        media: [first]
      });
      await f.store.ingestLinkedWhatsAppMessage({
        ...base,
        id: "media-2",
        text: "Another invoice",
        media: [pdf("second")]
      });
      expect(f.store.snapshot().conversationAttachments).toHaveLength(1);
      const over = f.stored(direct).find((message) => message.providerMessageId === "media-2")!;
      expect(over.content).toMatchObject({
        type: "text",
        text: `Another invoice\n${linkedMediaOverQuotaText}`
      });
      const audit = f.audits("whatsapp_linked.inbound_media_over_quota");
      expect(audit).toHaveLength(1);
      expect(audit[0]!.payload).toMatchObject({ scope: "chat", bytes: pdf("second").bytes.length });
      // A replay of the stored message is a no-op, not a second refusal.
      await f.store.ingestLinkedWhatsAppMessage({
        ...base,
        id: "media-2",
        text: "Another invoice",
        media: [pdf("second")]
      });
      expect(f.audits("whatsapp_linked.inbound_media_over_quota")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("is durable: a store restored from persisted rows still counts them", async () => {
    const f = await linkedOwner();
    try {
      f.store.setLinkedInboundQuota({ ...linkedInboundQuotaDefaults, chatMessagesPerHour: 2 });
      await f.ingest(direct, "one");
      await f.ingest(direct, "two");
      const restored = createCp2Store();
      restored.hydrateSnapshot(structuredClone(f.store.snapshot()));
      restored.setLinkedInboundQuota({ ...linkedInboundQuotaDefaults, chatMessagesPerHour: 2 });
      expect(
        await restored.ingestLinkedWhatsAppMessage({
          businessId: f.businessId,
          ownerId: f.ownerId,
          chat: direct,
          sender: direct,
          id: "after-restart",
          text: "three",
          timestamp: new Date().toISOString()
        })
      ).toMatchObject({ throttled: true });
    } finally {
      await f.close();
    }
  });
});
