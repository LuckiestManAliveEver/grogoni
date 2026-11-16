import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../../app.js";
import { createCp2Store, type Cp2Store } from "../../cp2/store.js";
import { createMemoryConversationAttachmentBlobStore } from "../../cp2/conversation-attachment-blob-store.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";
import type { LinkedDriver, LinkedInbound } from "./connector.js";
import { linkedOwnerChangeNotice } from "./owner-transfer.js";
import { dispatchLinkedReadReceipts, linkedReadReceiptLimits } from "./read-receipts.js";
import { linkedInboundQuotaDefaults } from "./inbound-quota.js";
import type { MembershipSummary } from "@grogoni/shared-types";

const contact = "254711111111@s.whatsapp.net";
const group = "123456789@g.us";
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * `liveReceipts: false` (the default) keeps the connector host from taking the read-receipt queue
 * as soon as it fills, so these tests can inspect the store's queue rules directly. The live
 * dispatch itself is tested below with `liveReceipts: true`.
 */
async function setup({ liveReceipts = false }: { liveReceipts?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wa-account-"));
  const store = createCp2Store({
    conversationAttachmentBlobStore: createMemoryConversationAttachmentBlobStore()
  });
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
    const result = await main.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie },
      payload: { name: "WhatsApp account shop", language: "en" }
    });
    expect(result.statusCode, result.body).toBe(200);
    const businessId = result.json().business.id as string;
    const ownerId = store
      .snapshot()
      .memberships.find(
        (membership) => membership.businessId === businessId && membership.role === "owner"
      )!.userId;
    return { cookie, businessId, ownerId };
  }
  const first = await owner("254700008871");
  const second = await owner("254700008872");
  const callbacks: Parameters<LinkedDriver["open"]>[0][] = [];
  const logout = vi.fn(async () => undefined);
  const markRead = vi.fn(async (_chat: string, keys: unknown[]) => keys.length);
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      callbacks.push(input);
      return {
        pairingCode: async () => "CODE1234",
        send: vi.fn(async (_chat: string, _text: string, id: string) => id),
        close: vi.fn(),
        logout,
        markRead
      };
    })
  };
  const app = Fastify();
  if (!liveReceipts)
    vi.spyOn(store, "onLinkedReadReceiptsQueued").mockImplementationOnce(() => () => undefined);
  registerLinkedWhatsAppRoutes(
    app,
    store,
    {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_SESSION_DIR: root,
      WHATSAPP_LINKED_SESSION_KEY: "02".repeat(32)
    },
    driver
  );
  await app.ready();
  const connector = `/businesses/${first.businessId}/channels/whatsapp-linked`;
  const account = (cookie = first.cookie) =>
    main.inject({ method: "GET", url: `${connector}/account`, headers: { cookie } });
  const post = (path: string, payload: Record<string, unknown>, cookie = first.cookie) =>
    main.inject({
      method: "POST",
      url: `${connector}/${path}`,
      headers: { cookie },
      payload: payload as Record<string, unknown> as object
    });
  async function connect(cookie = first.cookie) {
    const response = await app.inject({
      method: "POST",
      url: `${connector}/connect`,
      headers: { cookie },
      payload: { phone: "254700000000", consent: true }
    });
    expect(response.statusCode, response.body).toBe(200);
    callbacks.at(-1)!.state("open");
    await settle();
  }
  async function approve(chat: string, cookie = first.cookie) {
    const response = await app.inject({
      method: "POST",
      url: `${connector}/scopes`,
      headers: { cookie },
      payload: { chat, approved: true }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { scopes: Array<{ chat: string; conversationId: string }> };
  }
  async function inbound(message: Partial<LinkedInbound> & { id: string }) {
    callbacks.at(-1)!.inbound({
      chat: contact,
      sender: contact,
      text: "Hello shop",
      fromMe: false,
      mentioned: false,
      timestamp: new Date().toISOString(),
      ...message
    });
    await vi.waitFor(() =>
      expect(
        store
          .snapshot()
          .conversationMessages.some((entry) => entry.providerMessageId === message.id)
      ).toBe(true)
    );
    return store
      .snapshot()
      .conversationMessages.find((entry) => entry.providerMessageId === message.id)!;
  }
  const read = (conversationId: string, cookie = first.cookie) =>
    main.inject({
      method: "PATCH",
      url: `/v1/conversations/${conversationId}`,
      headers: { cookie },
      payload: { read: true }
    });
  /** The shop changes owner: `to` becomes the business owner, the previous owner is removed. */
  function transfer(to: string) {
    const memberships = (store as unknown as { memberships: Map<string, MembershipSummary> })
      .memberships;
    for (const [id, membership] of memberships)
      if (membership.businessId === first.businessId && membership.role === "owner")
        memberships.set(id, { ...membership, userId: to });
  }
  const channel = (chat: string) =>
    (store.snapshot().conversationChannels ?? []).find(
      (entry) =>
        entry.businessId === first.businessId &&
        entry.provider === "whatsapp_linked" &&
        entry.externalConversationId === chat
    )!;
  const identity = (chat: string) =>
    (store.snapshot().platformIdentities ?? []).find(
      (entry) => entry.id === channel(chat).platformIdentityId
    )!;
  return {
    store,
    main,
    app,
    markRead,
    first,
    second,
    callbacks,
    logout,
    connector,
    account,
    post,
    connect,
    approve,
    inbound,
    read,
    transfer,
    channel,
    identity,
    close: async () => {
      await app.close();
      await main.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function resolution(store: Cp2Store, businessId: string, ownerId: string, channelId: string) {
  void store;
  return {
    businessId,
    turnId: `turn-${channelId}`,
    delegation: {
      channelId,
      grantId: "grant",
      ownerId,
      sourceMessageId: "source",
      actorId: contact
    },
    toolName: "product.create" as const,
    outcome: "executed" as const,
    resolvedBy: ownerId
  };
}

describe("shop owner change", { timeout: 30_000 }, () => {
  it("removes the former owner's grants, results, receipts and binding and tells the new owner", async () => {
    const f = await setup();
    try {
      await f.connect();
      const { scopes } = await f.approve(contact);
      const oldConversation = scopes[0]!.conversationId;
      f.store.setLinkedToolGrants({
        businessId: f.first.businessId,
        ownerId: f.first.ownerId,
        chat: contact,
        tools: ["product.create"],
        enabled: true
      });
      expect(
        (await f.post("chats/read-receipts", { chat: contact, enabled: true })).statusCode
      ).toBe(200);
      await f.inbound({ id: "before-transfer" });
      expect((await f.read(oldConversation)).statusCode).toBe(200);
      expect(f.store.linkedReadReceiptEntries(f.first.businessId)).toHaveLength(1);
      // The socket drops, so the delegated result waits in the outbox (the drain skips
      // businesses that are not connected).
      f.callbacks.at(-1)!.state("close", "retry");
      await settle();
      await f.store.deliverLinkedDelegationResult(
        resolution(f.store, f.first.businessId, f.first.ownerId, f.channel(contact).id)
      );
      await settle();
      expect(f.store.linkedDelegationResultEntries(f.first.businessId)[0]!.status).toBe("pending");
      expect((await f.account()).json().ownerChange).toBeNull();

      f.transfer(f.second.ownerId);
      // The new owner opens the connection: the connector erases the old session (REVOKED).
      const status = await f.app.inject({
        method: "GET",
        url: f.connector,
        headers: { cookie: f.second.cookie }
      });
      expect(status.json()).toMatchObject({ state: "DISCONNECTED", scopes: [] });

      const view = await f.account(f.second.cookie);
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({
        ownerChange: {
          notice: linkedOwnerChangeNotice,
          previousOwnerId: f.first.ownerId,
          channelsDetached: 1,
          grantsRevoked: 1,
          resultsSuppressed: 1,
          readReceiptsDropped: 1
        },
        chats: []
      });
      expect(f.channel(contact).metadata).toEqual({
        automaticRepliesEnabled: false,
        linkedDeviceFormerOwnerId: f.first.ownerId,
        linkedDeviceDetachedAt: expect.any(String)
      });
      expect(f.store.linkedDelegationResultEntries(f.first.businessId)[0]).toMatchObject({
        status: "suppressed",
        reason: "owner_changed"
      });
      expect(f.store.linkedReadReceiptEntries(f.first.businessId)).toEqual([]);
      expect(
        f.store
          .snapshot()
          .auditEvents.filter((event) => event.type === "whatsapp_linked.owner_changed")
      ).toHaveLength(1);
      // Idempotent: a second read changes nothing and keeps the notice.
      expect((await f.account(f.second.cookie)).json().ownerChange.channelsDetached).toBe(1);
      expect(
        f.store
          .snapshot()
          .auditEvents.filter((event) => event.type === "whatsapp_linked.owner_changed")
      ).toHaveLength(1);
      // The former owner has no access and cannot ingest into the old conversation.
      expect((await f.account(f.first.cookie)).statusCode).toBe(403);
      expect(() =>
        f.store.ingestLinkedWhatsAppMessage({
          businessId: f.first.businessId,
          ownerId: f.second.ownerId,
          chat: contact,
          sender: contact,
          id: "unapproved-after-transfer",
          text: "Hello",
          timestamp: new Date().toISOString()
        })
      ).toThrow(/not approved/);

      // Linking again resolves the notice; re-approval binds the chat to a fresh conversation.
      await f.connect(f.second.cookie);
      expect((await f.account(f.second.cookie)).json().ownerChange).toBeNull();
      const rebound = await f.approve(contact, f.second.cookie);
      const newConversation = rebound.scopes[0]!.conversationId;
      expect(newConversation).not.toBe(oldConversation);
      expect(f.channel(contact).metadata.linkedDeviceOwnerId).toBe(f.second.ownerId);
      expect(f.channel(contact).metadata.linkedDeviceDetachedAt).toBeUndefined();
      const after = await f.inbound({ id: "after-transfer" });
      expect(after.conversationId).toBe(newConversation);
      const conversations = f.store.snapshot().conversations;
      const accountOf = (userId: string) =>
        f.store.snapshot().users.find((user) => user.id === userId)!.accountId;
      expect(conversations.find((entry) => entry.id === newConversation)!.accountId).toBe(
        accountOf(f.second.ownerId)
      );
      expect(conversations.find((entry) => entry.id === oldConversation)!.accountId).toBe(
        accountOf(f.first.ownerId)
      );
    } finally {
      await f.close();
    }
  });

  it("notices a change of owner who linked WhatsApp but approved no chat", async () => {
    const f = await setup();
    try {
      await f.connect();
      f.transfer(f.second.ownerId);
      const view = await f.account(f.second.cookie);
      expect(view.json().ownerChange).toMatchObject({
        previousOwnerId: f.first.ownerId,
        channelsDetached: 0,
        grantsRevoked: 0
      });
      const dismissed = await f.post("account/owner-change/acknowledge", {}, f.second.cookie);
      expect(dismissed.statusCode, dismissed.body).toBe(200);
      expect(dismissed.json().ownerChange).toBeNull();
      expect((await f.account(f.second.cookie)).json().ownerChange).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("reports nothing when the owner never changed", async () => {
    const f = await setup();
    try {
      await f.connect();
      await f.approve(contact);
      expect((await f.account()).json()).toMatchObject({
        ownerChange: null,
        chats: [{ chat: contact }]
      });
      expect(f.store.linkedWhatsAppOwnerStates(f.first.businessId)[0]).toMatchObject({
        ownerId: f.first.ownerId,
        state: "CONNECTED",
        ownerChange: null
      });
    } finally {
      await f.close();
    }
  });
});

describe("existing-customer linking", { timeout: 30_000 }, () => {
  it("links only the chosen customer, never by display name, and unlinks back to the guest", async () => {
    const f = await setup();
    try {
      await f.connect();
      await f.approve(contact);
      const guestId = f.identity(contact).customerId!;
      const guest = f.store.snapshot().customers.find((entry) => entry.id === guestId)!;
      const create = async (
        name: string,
        cookie = f.first.cookie,
        businessId = f.first.businessId
      ) =>
        (
          await f.main.inject({
            method: "POST",
            url: `/businesses/${businessId}/customers`,
            headers: { cookie },
            payload: { name, phone: "254711111111" }
          })
        ).json() as { id: string };
      // Same name and phone as the WhatsApp contact: still never matched automatically.
      const twin = await create(guest.name);
      const chosen = await create("Amina Wanjiru");
      expect(f.identity(contact).customerId).toBe(guestId);
      expect((await f.account()).json().chats[0].customer).toEqual({
        id: guestId,
        name: guest.name,
        linked: false
      });

      const linked = await f.post("chats/customer", { chat: contact, customerId: chosen.id });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json().chats[0].customer).toEqual({
        id: chosen.id,
        name: "Amina Wanjiru",
        linked: true
      });
      expect(f.identity(contact).customerId).toBe(chosen.id);
      expect(f.identity(contact).customerId).not.toBe(twin.id);
      // Nothing was merged or removed.
      expect(f.store.snapshot().customers.map((entry) => entry.id)).toEqual(
        expect.arrayContaining([guestId, twin.id, chosen.id])
      );

      const unlinked = await f.post("chats/customer", { chat: contact, customerId: null });
      expect(unlinked.json().chats[0].customer).toEqual({
        id: guestId,
        name: guest.name,
        linked: false
      });
      expect(f.identity(contact).metadata.linkedCustomerAt).toBeUndefined();
      expect(
        f.store
          .snapshot()
          .auditEvents.filter((event) => event.type.startsWith("whatsapp_linked.customer_"))
          .map((event) => event.type)
      ).toEqual(["whatsapp_linked.customer_linked", "whatsapp_linked.customer_unlinked"]);
    } finally {
      await f.close();
    }
  });

  it("refuses groups, unknown and foreign customers, invalid bodies and other users", async () => {
    const f = await setup();
    try {
      await f.connect();
      await f.approve(contact);
      await f.approve(group);
      const foreign = (
        await f.main.inject({
          method: "POST",
          url: `/businesses/${f.second.businessId}/customers`,
          headers: { cookie: f.second.cookie },
          payload: { name: "Other shop customer" }
        })
      ).json() as { id: string };
      const before = f.identity(contact).customerId;
      const groupLink = await f.post("chats/customer", { chat: group, customerId: foreign.id });
      expect(groupLink.json().code).toBe("whatsapp_group_not_linkable");
      expect(
        (await f.post("chats/customer", { chat: contact, customerId: foreign.id })).statusCode
      ).toBe(404);
      expect(
        (await f.post("chats/customer", { chat: contact, customerId: "missing" })).statusCode
      ).toBe(404);
      expect((await f.post("chats/customer", { chat: contact, customerId: 7 })).statusCode).toBe(
        400
      );
      expect(
        (await f.post("chats/customer", { chat: "not-a-chat", customerId: null })).statusCode
      ).toBe(400);
      expect(
        (await f.post("chats/customer", { chat: "254799999999@s.whatsapp.net", customerId: null }))
          .statusCode
      ).toBe(404);
      expect(
        (await f.post("chats/customer", { chat: contact, customerId: foreign.id }, f.second.cookie))
          .statusCode
      ).toBe(403);
      expect(f.identity(contact).customerId).toBe(before);
    } finally {
      await f.close();
    }
  });
});

describe("read receipts back to WhatsApp", { timeout: 30_000 }, () => {
  it("is off by default, sends each read message once, and stops for STOP or removed approval", async () => {
    const f = await setup();
    try {
      await f.connect();
      const { scopes } = await f.approve(contact);
      const conversation = scopes[0]!.conversationId;
      const take = (approved = true) =>
        f.store.takeLinkedReadReceipts({
          businessId: f.first.businessId,
          ownerId: f.first.ownerId,
          approved: () => approved
        });
      expect((await f.account()).json().chats[0].readReceipts).toBe(false);
      await f.inbound({ id: "off-1" });
      await f.read(conversation);
      expect(f.store.linkedReadReceiptEntries()).toEqual([]);

      const on = await f.post("chats/read-receipts", { chat: contact, enabled: true });
      expect(on.json().chats[0].readReceipts).toBe(true);
      const queued = vi.fn();
      const unsubscribe = f.store.onLinkedReadReceiptsQueued(queued);
      await f.inbound({ id: "on-1" });
      await f.inbound({ id: "on-2" });
      await f.read(conversation);
      await f.read(conversation);
      expect(queued).toHaveBeenCalledTimes(1);
      expect(queued).toHaveBeenCalledWith(f.first.businessId, f.first.ownerId);
      unsubscribe();
      expect(take()).toEqual([
        {
          chat: contact,
          keys: [
            { id: "on-1", sender: contact },
            { id: "on-2", sender: contact }
          ]
        }
      ]);
      expect(take()).toEqual([]);

      // Not approved on the connector (approval removed): dropped, not kept for later.
      await f.inbound({ id: "unapproved" });
      await f.read(conversation);
      expect(take(false)).toEqual([]);
      expect(take()).toEqual([]);

      // STOP: the STOP message itself and anything after it get no receipt.
      await f.inbound({ id: "stop", text: "STOP" });
      await f.read(conversation);
      expect(f.store.linkedReadReceiptEntries()).toEqual([]);
      expect((await f.account()).json().chats[0].optedOut).toBe(true);

      // Turning it off drops what is queued.
      await f.inbound({ id: "start", text: "START" });
      await f.read(conversation);
      expect(f.store.linkedReadReceiptEntries()).toHaveLength(1);
      await f.post("chats/read-receipts", { chat: contact, enabled: false });
      expect(f.store.linkedReadReceiptEntries()).toEqual([]);
      expect(
        (await f.post("chats/read-receipts", { chat: contact, enabled: "yes" })).statusCode
      ).toBe(400);
    } finally {
      await f.close();
    }
  });

  it("the connector host sends queued receipts on the live socket, once", async () => {
    const f = await setup({ liveReceipts: true });
    try {
      await f.connect();
      const { scopes } = await f.approve(contact);
      const conversation = scopes[0]!.conversationId;
      await f.post("chats/read-receipts", { chat: contact, enabled: true });
      await f.inbound({ id: "live-1" });
      await f.read(conversation);
      await vi.waitFor(() => expect(f.markRead).toHaveBeenCalledTimes(1));
      expect(f.markRead).toHaveBeenCalledWith(contact, [{ id: "live-1", sender: contact }]);
      expect(f.store.linkedReadReceiptEntries()).toEqual([]);
      // Reading again sends nothing more.
      await f.read(conversation);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.markRead).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("names the participant in groups, skips old messages, and bounds the queue", async () => {
    const f = await setup();
    try {
      await f.connect();
      const { scopes } = await f.approve(group);
      const conversation = scopes.find((scope) => scope.chat === group)!.conversationId;
      await f.post("chats/read-receipts", { chat: group, enabled: true });
      const member = "254722222222@s.whatsapp.net";
      await f.inbound({ id: "group-1", chat: group, sender: member, mentioned: true });
      await f.store.ingestLinkedWhatsAppMessage({
        businessId: f.first.businessId,
        ownerId: f.first.ownerId,
        chat: group,
        sender: member,
        id: "old",
        text: "From last week",
        timestamp: new Date(
          Date.now() - linkedReadReceiptLimits.maxMessageAgeMs - 60_000
        ).toISOString()
      });
      await f.read(conversation);
      const sent: unknown[] = [];
      const result = await dispatchLinkedReadReceipts(
        f.store,
        {
          approved: (_business, _owner, chat) => chat === group,
          markRead: async (_business, _owner, chat, keys) => {
            sent.push({ chat, keys });
            return keys.length;
          }
        },
        f.first.businessId,
        f.first.ownerId
      );
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(sent).toEqual([{ chat: group, keys: [{ id: "group-1", sender: member }] }]);

      // This floods one group on purpose to reach the receipt queue bound; lift the inbound quota
      // (inbound-policy.test.ts covers it) so every message is stored.
      f.store.setLinkedInboundQuota({
        ...linkedInboundQuotaDefaults,
        chatMessagesPerHour: 10_000,
        businessMessagesPerHour: 10_000
      });
      for (let index = 0; index < linkedReadReceiptLimits.maxQueuedPerBusiness + 5; index += 1)
        await f.store.ingestLinkedWhatsAppMessage({
          businessId: f.first.businessId,
          ownerId: f.first.ownerId,
          chat: group,
          sender: member,
          id: `bulk-${index}`,
          text: "bulk",
          timestamp: new Date().toISOString()
        });
      await f.read(conversation);
      const entries = f.store.linkedReadReceiptEntries(f.first.businessId);
      expect(entries).toHaveLength(linkedReadReceiptLimits.maxQueuedPerBusiness);
      // A failing socket drops the batch instead of retrying it.
      const failing = await dispatchLinkedReadReceipts(
        f.store,
        {
          approved: () => true,
          markRead: async () => {
            throw new Error("socket closed");
          }
        },
        f.first.businessId,
        f.first.ownerId
      );
      expect(failing).toEqual({ sent: 0, failed: linkedReadReceiptLimits.maxQueuedPerBusiness });
      expect(f.store.linkedReadReceiptEntries()).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
