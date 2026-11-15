import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { MembershipSummary } from "@grogoni/shared-types";
import { buildApi } from "../../app.js";
import { createCp2Store } from "../../cp2/store.js";
import { registerLinkedWhatsAppDeviceRoutes } from "./device-worker-routes.js";
import { linkedDeviceOutboxLimits } from "./device-outbox.js";

/**
 * The phone-hosted outbound path end to end through the real store and routes: an inbox reply
 * queues instead of failing, the phone pulls it with the owner's session, sends, and
 * acknowledges; read receipts and delegated results ride the same pull.
 */
const chat = "254711000301@s.whatsapp.net";

async function setup() {
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
      payload: { name: "Phone outbox shop", language: "en" }
    });
    expect(created.statusCode, created.body).toBe(200);
    const businessId = created.json().business.id as string;
    const memberships = (store as unknown as { memberships: Map<string, MembershipSummary> })
      .memberships;
    const userId = [...memberships.values()].find(
      (membership) => membership.businessId === businessId && membership.role === "owner"
    )!.userId;
    return { cookie, sessionId: cookie.split("=")[1]!, businessId, userId };
  }
  const first = await owner("254700009301");
  const second = await owner("254700009302");
  const app = Fastify();
  registerLinkedWhatsAppDeviceRoutes(app, store, { WHATSAPP_LINKED_DEVICE_WORKER_ENABLED: "true" });
  await app.ready();
  const base = `/businesses/${first.businessId}/channels/whatsapp-linked/device`;
  const post = (path: string, payload: unknown, cookie = first.cookie) =>
    app.inject({
      method: "POST",
      url: `${base}${path}`,
      headers: { cookie },
      payload: payload as object
    });
  let counter = 0;
  const ingest = async (text: string) => {
    counter += 1;
    const result = await post("/ingress", {
      message: {
        id: `3EB0IN${String(counter).padStart(6, "0")}`,
        chat,
        sender: chat,
        text,
        timestamp: new Date().toISOString()
      }
    });
    expect(result.statusCode, result.body).toBe(200);
  };
  const approve = async () => {
    const result = await post("/scopes", { chat, approved: true });
    expect(result.statusCode, result.body).toBe(200);
    return result.json().conversationId as string;
  };
  const report = (state: string, cookie = first.cookie) => post("/state", { state }, cookie);
  const reply = (conversationId: string, text: string, idempotencyKey: string) =>
    main.inject({
      method: "POST",
      url: `/businesses/${first.businessId}/channel-messages`,
      headers: { cookie: first.cookie },
      payload: { conversationId, provider: "whatsapp_linked", text, idempotencyKey }
    });
  const pull = (cookie = first.cookie) => post("/outbox/pull", {}, cookie);
  const ack = (results: unknown[]) => post("/outbox/ack", { results });
  const message = (id: string) =>
    store.snapshot().conversationMessages.find((entry) => entry.id === id)!;
  return {
    store,
    main,
    app,
    first,
    second,
    base,
    post,
    ingest,
    approve,
    report,
    reply,
    pull,
    ack,
    message,
    close: async () => {
      await app.close();
      await main.close();
    }
  };
}

describe("WhatsApp device outbox (phone-hosted sessions)", () => {
  it("revokes server chat authority and suppresses pending sends before another pull", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Hello");
      const queued = await f.reply(conversationId, "Queued reply", "revoke-pending");
      expect(queued.statusCode, queued.body).toBe(200);
      const before = f.store
        .snapshot()
        .conversationChannels?.find((row) => row.conversationId === conversationId);
      if (!before) throw new Error("Expected the conversation channel after replying");
      expect((await f.post("/scopes", { chat, approved: false })).statusCode).toBe(200);
      const after = f.store.snapshot().conversationChannels?.find((row) => row.id === before.id);
      if (!after) throw new Error("Expected the conversation channel after revocation");
      expect(after.platformIdentityId).toBe(before.platformIdentityId);
      expect(after.metadata.linkedDeviceOwnerId).toBeUndefined();
      expect(after.status).toBe("blocked");
      const pulled = await f.pull();
      expect(pulled.statusCode, pulled.body).toBe(200);
      expect(pulled.json().sends).toEqual([]);
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "suppressed", reason: "approval_revoked" })
        ])
      );
      const ingress = await f.post("/ingress", {
        message: {
          id: "3EB0REVOKED001",
          chat,
          sender: chat,
          text: "Must not arrive",
          timestamp: new Date().toISOString()
        }
      });
      expect(ingress.statusCode).toBe(404);
      expect(ingress.json().code).toBe("conversation_channel_not_found");
      // A fresh explicit approval restores authority through a newly bound conversation.
      expect(await f.approve()).not.toBe(conversationId);
    } finally {
      await f.close();
    }
  });

  it("queues an inbox reply for the phone, hands it over once, and records the outcome", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      // Before the phone reports a session, a reply has nowhere to go.
      const early = await f.reply(conversationId, "Too early", "early-1");
      expect(early.statusCode).not.toBe(200);

      expect((await f.report("CONNECTED")).json()).toMatchObject({
        host: "android",
        state: "CONNECTED",
        status: "available",
        waiting: 0
      });
      await f.ingest("Do you have 2kg maize flour?");
      const sent = await f.reply(conversationId, "Yes, 2kg is KES 230.", "reply-1");
      expect(sent.statusCode, sent.body).toBe(200);
      const queued = sent.json().message;
      expect(queued).toMatchObject({ status: "queued", actualChannel: "whatsapp_linked" });
      const [entry] = f.store.linkedDeviceOutboxEntries(f.first.businessId);
      expect(entry).toMatchObject({ id: `send:${queued.id}`, status: "pending", chat });
      // The durable row carries routing ids only, never the text.
      expect(JSON.stringify(entry)).not.toContain("KES 230");

      // The same reply again is the same message and the same entry.
      expect(
        (await f.reply(conversationId, "Yes, 2kg is KES 230.", "reply-1")).json().message.id
      ).toBe(queued.id);
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)).toHaveLength(1);

      const pulled = await f.pull();
      expect(pulled.statusCode, pulled.body).toBe(200);
      const { sends, receipts, status } = pulled.json();
      expect(receipts).toEqual([]);
      expect(status.waiting).toBe(1);
      expect(sends).toEqual([
        {
          id: `send:${queued.id}`,
          claimId: expect.any(String),
          chat,
          conversationId,
          idempotencyKey: "reply-1",
          text: "Yes, 2kg is KES 230."
        }
      ]);
      // Claimed: a second pull does not hand it out again.
      expect((await f.pull()).json().sends).toEqual([]);

      const acked = await f.ack([
        { id: sends[0].id, claimId: sends[0].claimId, outcome: "sent", deliveredId: "3EB0OUT0001" }
      ]);
      expect(acked.statusCode, acked.body).toBe(200);
      expect(acked.json().results).toEqual([{ id: sends[0].id, status: "sent" }]);
      expect(f.message(queued.id)).toMatchObject({
        status: "sent",
        providerMessageId: "3EB0OUT0001",
        failureCode: null
      });
      // A repeated acknowledgement is harmless.
      expect(
        (
          await f.ack([
            {
              id: sends[0].id,
              claimId: sends[0].claimId,
              outcome: "failed",
              code: "CHANNEL_SEND_FAILED"
            }
          ])
        ).json().results
      ).toEqual([{ id: sends[0].id, status: "sent" }]);
      expect(f.message(queued.id).status).toBe("sent");
      expect(
        f.store
          .snapshot()
          .auditEvents.filter((event) => event.type.startsWith("whatsapp_linked.device_send_"))
          .map((event) => event.type)
      ).toEqual([
        "whatsapp_linked.device_send_queued",
        "whatsapp_linked.device_send_claimed",
        "whatsapp_linked.device_send_sent"
      ]);
    } finally {
      await f.close();
    }
  });

  it("never resends an uncertain delivery and backs off a clean failure", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Hello");
      const uncertain = (await f.reply(conversationId, "First", "k-uncertain")).json().message;
      const retry = (await f.reply(conversationId, "Second", "k-retry")).json().message;
      const fatal = (await f.reply(conversationId, "Third", "k-fatal")).json().message;
      const { sends } = (await f.pull()).json();
      expect(sends.map((send: { idempotencyKey: string }) => send.idempotencyKey)).toEqual([
        "k-uncertain",
        "k-retry",
        "k-fatal"
      ]);
      const [a, b, c] = sends;
      const results = (
        await f.ack([
          { id: a.id, claimId: a.claimId, outcome: "uncertain" },
          {
            id: b.id,
            claimId: b.claimId,
            outcome: "failed",
            code: "CHANNEL_UNAVAILABLE",
            retryable: true
          },
          { id: c.id, claimId: c.claimId, outcome: "failed", code: "CHANNEL_SEND_FAILED" }
        ])
      ).json().results;
      expect(results).toEqual([
        { id: a.id, status: "uncertain" },
        { id: b.id, status: "pending" },
        { id: c.id, status: "failed" }
      ]);
      expect(f.message(uncertain.id)).toMatchObject({
        status: "failed",
        failureCode: "WHATSAPP_DELIVERY_UNCERTAIN"
      });
      expect(f.message(fatal.id)).toMatchObject({
        status: "failed",
        failureCode: "CHANNEL_SEND_FAILED"
      });
      expect(f.message(retry.id).status).toBe("queued");
      // Backing off: not offered at once, offered again after the delay; the uncertain one never.
      expect((await f.pull()).json().sends).toEqual([]);
      const later = await f.store.pullLinkedWhatsAppDeviceOutbox({
        sessionId: f.first.sessionId,
        businessId: f.first.businessId,
        ownerId: f.first.userId,
        now: new Date(Date.now() + linkedDeviceOutboxLimits.baseBackoffMs + 1000)
      });
      expect(later.sends.map((send) => send.idempotencyKey)).toEqual(["k-retry"]);
      // A stale claim's failure is ignored; its success is the truth and is kept.
      expect(
        f.store.acknowledgeLinkedWhatsAppDeviceOutbox({
          businessId: f.first.businessId,
          ownerId: f.first.userId,
          acks: [{ id: b.id, claimId: b.claimId, outcome: "failed", code: "CHANNEL_SEND_FAILED" }]
        }).results
      ).toEqual([{ id: b.id, status: "claimed" }]);
      expect(
        f.store.acknowledgeLinkedWhatsAppDeviceOutbox({
          businessId: f.first.businessId,
          ownerId: f.first.userId,
          acks: [{ id: b.id, claimId: b.claimId, outcome: "sent", deliveredId: "3EB0LATE01" }]
        }).results
      ).toEqual([{ id: b.id, status: "sent" }]);
    } finally {
      await f.close();
    }
  });

  it("re-offers an unacknowledged claim to the same phone only", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Hello");
      const sent = (await f.reply(conversationId, "Karibu", "k-claim")).json().message;
      const pullAt = (sessionId: string, offsetMs: number) =>
        f.store.pullLinkedWhatsAppDeviceOutbox({
          sessionId,
          businessId: f.first.businessId,
          ownerId: f.first.userId,
          now: new Date(Date.now() + offsetMs)
        });
      const first = await pullAt(f.first.sessionId, 0);
      expect(first.sends).toHaveLength(1);
      const timeout = linkedDeviceOutboxLimits.claimTimeoutMs + 1000;
      const again = await pullAt(f.first.sessionId, timeout);
      expect(again.sends).toHaveLength(1);
      expect(again.sends[0]!.claimId).not.toBe(first.sends[0]!.claimId);
      expect(again.sends[0]!.idempotencyKey).toBe("k-claim");

      // The same owner signed in on another phone (a new session family): no second send.
      const sessions = (f.store as unknown as { sessions: Map<string, Record<string, unknown>> })
        .sessions;
      const original = sessions.get(f.first.sessionId)!;
      const otherSession = "00000000-0000-4000-8000-00000000c1a1";
      sessions.set(otherSession, {
        ...original,
        id: otherSession,
        sessionFamilyId: "other-phone-family"
      });
      const other = await pullAt(otherSession, timeout * 2);
      expect(other.sends).toEqual([]);
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)[0]).toMatchObject({
        status: "uncertain",
        reason: "claim_lost_other_device"
      });
      expect(f.message(sent.id).failureCode).toBe("WHATSAPP_DELIVERY_UNCERTAIN");
    } finally {
      await f.close();
    }
  });

  it("re-checks STOP and the chat approval at pull time", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Hi");
      const stopped = (await f.reply(conversationId, "Offer!", "k-stop")).json().message;
      await f.ingest("STOP");
      const pulled = (await f.pull()).json();
      expect(pulled.sends).toEqual([]);
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)[0]).toMatchObject({
        status: "suppressed",
        reason: "recipient_opted_out"
      });
      expect(f.message(stopped.id)).toMatchObject({
        status: "failed",
        failureCode: "CHANNEL_UNAVAILABLE"
      });
      // STOP also blocks new replies at the gateway.
      expect((await f.reply(conversationId, "Again", "k-stop-2")).statusCode).not.toBe(200);
    } finally {
      await f.close();
    }
  });

  it("refuses new sends when the outbox is full instead of evicting one", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Hi");
      // Fill the outbox directly: the channel-messages API has its own per-minute send limit.
      const template = (await f.reply(conversationId, "Line 0", "k-full-0")).json().message;
      const [seed] = f.store.linkedDeviceOutboxEntries(f.first.businessId);
      const snapshot = f.store.snapshot();
      for (let index = 1; index < linkedDeviceOutboxLimits.maxPendingSends; index += 1) {
        const id = `${template.id}-${index}`;
        snapshot.conversationMessages.push({ ...template, id, idempotencyKey: `k-full-${index}` });
        snapshot.whatsappLinkedDeviceOutbox!.push({
          ...seed!,
          id: `send:${id}`,
          messageId: id,
          idempotencyKey: `k-full-${index}`
        });
      }
      f.store.hydrateSnapshot(snapshot);
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)).toHaveLength(
        linkedDeviceOutboxLimits.maxPendingSends
      );
      const refused = await f.reply(conversationId, "One more", "k-full-over");
      expect(refused.statusCode).toBe(429);
      expect(refused.json().code).toBe("CHANNEL_RATE_LIMITED");
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)).toHaveLength(
        linkedDeviceOutboxLimits.maxPendingSends
      );
      const first = (await f.pull()).json();
      expect(first.sends).toHaveLength(linkedDeviceOutboxLimits.pullSends);
      expect(first.more).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("queues read receipts durably for the phone and hands each over once", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Unread one");
      await f.ingest("Unread two");
      const toggled = await f.main.inject({
        method: "POST",
        url: `/businesses/${f.first.businessId}/channels/whatsapp-linked/chats/read-receipts`,
        headers: { cookie: f.first.cookie },
        payload: { chat, enabled: true }
      });
      expect(toggled.statusCode, toggled.body).toBe(200);
      const read = await f.main.inject({
        method: "PATCH",
        url: `/v1/conversations/${conversationId}`,
        headers: { cookie: f.first.cookie },
        payload: { read: true }
      });
      expect(read.statusCode, read.body).toBe(200);
      // Server-hosted receipts stay in memory; phone-hosted ones are durable outbox rows.
      expect(f.store.linkedReadReceiptEntries(f.first.businessId)).toEqual([]);
      expect(
        f.store
          .linkedDeviceOutboxEntries(f.first.businessId)
          .filter((entry) => entry.kind === "read")
      ).toHaveLength(2);
      const pulled = (await f.pull()).json();
      expect(pulled.receipts).toEqual([
        {
          chat,
          keys: [
            { id: "3EB0IN000001", sender: chat },
            { id: "3EB0IN000002", sender: chat }
          ]
        }
      ]);
      expect((await f.pull()).json().receipts).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("drops a former owner's queued sends when the shop changes owner", async () => {
    const f = await setup();
    try {
      const conversationId = await f.approve();
      await f.report("CONNECTED");
      await f.ingest("Hi");
      const pending = (await f.reply(conversationId, "Pending", "k-owner")).json().message;
      const memberships = (f.store as unknown as { memberships: Map<string, MembershipSummary> })
        .memberships;
      for (const [id, membership] of memberships)
        if (membership.businessId === f.first.businessId && membership.role === "owner")
          memberships.set(id, { ...membership, userId: f.second.userId });
      f.store.reconcileLinkedWhatsAppOwnership(f.first.businessId);
      expect(f.store.linkedDeviceOutboxEntries(f.first.businessId)[0]).toMatchObject({
        status: "suppressed",
        reason: "owner_changed"
      });
      expect(f.message(pending.id).status).toBe("failed");
      // The former owner's phone can no longer pull anything.
      expect([403, 404]).toContain((await f.pull()).statusCode);
    } finally {
      await f.close();
    }
  });

  it("validates input and answers only the owner on an enabled host", async () => {
    const f = await setup();
    try {
      await f.approve();
      expect((await f.report("NOT_A_STATE")).statusCode).toBe(400);
      expect((await f.pull()).json().code).toBe("whatsapp_device_not_hosting");
      await f.report("CONNECTED");
      expect((await f.ack([{ id: "send:x", claimId: "short", outcome: "sent" }])).statusCode).toBe(
        400
      );
      expect(
        (
          await f.ack([
            { id: "send:unknown", claimId: "claim-0001", outcome: "sent", deliveredId: "X1" }
          ])
        ).json().results
      ).toEqual([{ id: "send:unknown", status: "unknown" }]);
      for (const path of ["/state", "/outbox/pull", "/outbox/ack"])
        expect([403, 404]).toContain(
          (await f.post(path, { state: "CONNECTED", results: [] }, f.second.cookie)).statusCode
        );
      const status = await f.app.inject({
        method: "GET",
        url: `${f.base}/status`,
        headers: { cookie: f.first.cookie }
      });
      expect(status.json()).toMatchObject({ enabled: true, host: "android", state: "CONNECTED" });
      const disabled = Fastify();
      registerLinkedWhatsAppDeviceRoutes(disabled, f.store, {});
      await disabled.ready();
      const off = await disabled.inject({
        method: "GET",
        url: `${f.base}/status`,
        headers: { cookie: f.first.cookie }
      });
      expect(off.json().code).toBe("whatsapp_device_worker_disabled");
      await disabled.close();
    } finally {
      await f.close();
    }
  });
});
