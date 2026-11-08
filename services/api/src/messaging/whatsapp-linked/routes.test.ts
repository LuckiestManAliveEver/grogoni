import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createMemoryConversationAttachmentBlobStore } from "../../cp2/conversation-attachment-blob-store.js";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../../app.js";
import { createCp2Store, type Cp2StoreOptions } from "../../cp2/store.js";
import { createOpenRouterModelAdapter } from "../../inference/openrouter-model-runtime.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";
import type { LinkedDownloadedMedia } from "./media.js";
import type { LinkedInbound, LinkedDriver } from "./connector.js";

async function setup(
  enabled = true,
  assistant = false,
  modelRuntimeAdapterResolver?: Cp2StoreOptions["modelRuntimeAdapterResolver"]
) {
  const root = mkdtempSync(join(tmpdir(), "wa-http-"));
  const blobStore = createMemoryConversationAttachmentBlobStore();
  const store = createCp2Store({
    conversationAttachmentBlobStore: blobStore,
    ...(modelRuntimeAdapterResolver ? { modelRuntimeAdapterResolver } : {})
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
      payload: { name: "WhatsApp test shop", language: "en" }
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
  const first = await owner("254700009871");
  const second = await owner("254700009872");
  const callbacks: Parameters<LinkedDriver["open"]>[0][] = [];
  const send = vi.fn(
    async (_chat: string, _text: string, id: string, _media?: LinkedDownloadedMedia) => {
      void _media;
      return id;
    }
  );
  const groups = vi.fn(async () => [{ chat: "123456789@g.us", name: "Approved test group" }]);
  const downloadMedia = vi.fn(async () => Buffer.from("%PDF-1.7\nPRIVATE_ATTACHMENT_CANARY"));
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      callbacks.push(input);
      return {
        pairingCode: async () => "CODE1234",
        groups,
        send,
        downloadMedia,
        close: vi.fn(),
        logout: async () => undefined
      };
    })
  };
  const app = Fastify();
  registerLinkedWhatsAppRoutes(
    app,
    store,
    enabled
      ? {
          WHATSAPP_LINKED_ENABLED: "true",
          ...(assistant
            ? {
                WHATSAPP_LINKED_DAEMON_URL: "https://daemon.example",
                DAEMON_SERVICE_TOKEN: "t".repeat(32)
              }
            : {}),
          WHATSAPP_LINKED_SESSION_DIR: root,
          WHATSAPP_LINKED_SESSION_KEY: "01".repeat(32)
        }
      : {},
    driver
  );
  await app.ready();
  const path = `/businesses/${first.businessId}/channels/whatsapp-linked`;
  return {
    app,
    main,
    store,
    first,
    second,
    callbacks,
    driver,
    send,
    blobStore,
    groups,
    downloadMedia,
    path,
    close: async () => {
      await app.close();
      await main.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("Linked Devices authenticated HTTP and canonical inbox", () => {
  it("downloads only approved media, stores encrypted managed attachments and deduplicates retries", async () => {
    const f = await setup();
    try {
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { phone: "254700000000", consent: true }
      });
      f.callbacks[0]!.state("open");
      const bytes = Buffer.from("%PDF-1.7\nPRIVATE_ATTACHMENT_CANARY");
      const message = {
        id: "media-event",
        chat: "254711111111@s.whatsapp.net",
        sender: "254711111111@s.whatsapp.net",
        text: "Invoice",
        fromMe: false,
        mentioned: false,
        timestamp: new Date().toISOString(),
        media: [
          {
            type: "document" as const,
            mimeType: "application/pdf",
            filename: "invoice.exe",
            size: bytes.length,
            key: Buffer.alloc(32).toString("base64"),
            directPath: "/mms/test.enc",
            sha256: createHash("sha256").update(bytes).digest("base64")
          }
        ]
      };
      f.callbacks[0]!.inbound(message);
      await settle();
      expect(f.downloadMedia).not.toHaveBeenCalled();
      await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat: message.chat, approved: true }
      });
      f.callbacks[0]!.inbound(message);
      await vi.waitFor(() => expect(f.store.snapshot().conversationAttachments).toHaveLength(1));
      const attachment = f.store.snapshot().conversationAttachments![0]!;
      expect(attachment.filename).toBe("invoice.pdf");
      const encrypted = await f.blobStore.get(attachment.storageKey);
      expect(encrypted!.includes(Buffer.from("PRIVATE_ATTACHMENT_CANARY"))).toBe(false);
      const url = `/v1/conversations/${attachment.conversationId}/attachments/${attachment.id}/download`;
      const download = await f.main.inject({
        method: "GET",
        url,
        headers: { cookie: f.first.cookie }
      });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.rawPayload).toEqual(bytes);
      const denied = await f.main.inject({
        method: "GET",
        url,
        headers: { cookie: f.second.cookie }
      });
      expect(denied.statusCode).toBe(404);
      f.callbacks[0]!.inbound(message);
      await settle();
      expect(f.downloadMedia).toHaveBeenCalledTimes(1);
      const imported = f.store
        .snapshot()
        .conversationMessages.find((entry) => entry.providerMessageId === message.id)!;
      expect(imported.content).toMatchObject({
        type: "text",
        attachments: [{ id: attachment.id, source: "managed", name: "invoice.pdf" }]
      });
      f.callbacks[0]!.inbound({
        ...message,
        id: "quoted-reply",
        media: [],
        text: "About this invoice",
        replyTo: message.id
      });
      await settle();
      const quotedReply = f.store
        .snapshot()
        .conversationMessages.find((entry) => entry.providerMessageId === "quoted-reply")!;
      expect(quotedReply.replyToMessageId).toBe(imported.id);
      f.callbacks[0]!.inbound({
        ...message,
        id: "unknown-quote",
        media: [],
        text: "Unknown quote",
        replyTo: "another-chat-message"
      });
      await settle();
      expect(
        f.store
          .snapshot()
          .conversationMessages.find((entry) => entry.providerMessageId === "unknown-quote")!
          .replyToMessageId
      ).toBeNull();
      const payload = {
        conversationId: attachment.conversationId,
        provider: "whatsapp_linked",
        text: "Your document",
        replyToMessageId: imported.id,
        idempotencyKey: "media-reply-once",
        attachments: [{ resourceType: "conversation_attachment", resourceId: attachment.id }]
      };
      const send = (body: typeof payload, cookie = f.first.cookie) =>
        f.main.inject({
          method: "POST",
          url: `/businesses/${f.first.businessId}/channel-messages`,
          headers: { cookie },
          payload: body
        });
      expect((await send(payload, f.second.cookie)).statusCode).toBe(403);
      const missing = await send({
        ...payload,
        attachments: [{ resourceType: "conversation_attachment", resourceId: "other-tenant-id" }]
      });
      expect(missing.statusCode, missing.body).toBe(404);
      const sent = await send(payload);
      expect(sent.statusCode, sent.body).toBe(200);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect((f.send.mock.calls[0] as unknown[])[4]).toMatchObject({
        id: message.id,
        sender: message.sender,
        fromMe: false,
        text: "Invoice"
      });
      expect(f.send.mock.calls[0]?.[3]).toMatchObject({
        bytes,
        filename: "invoice.pdf",
        mimeType: "application/pdf"
      });
      expect((await send(payload)).statusCode).toBe(200);
      expect(f.send).toHaveBeenCalledTimes(1);
      const sentAttachment = f.store
        .snapshot()
        .conversationAttachments!.find((record) => record.messageId === sent.json().message.id)!;
      expect(sentAttachment.id).not.toBe(attachment.id);
      expect(
        (await f.blobStore.get(sentAttachment.storageKey))!.includes(
          Buffer.from("PRIVATE_ATTACHMENT_CANARY")
        )
      ).toBe(false);
      const emitMutation = async (
        id: string,
        mutation: NonNullable<LinkedInbound["mutation"]>,
        text = "[Update]",
        sender = message.sender
      ) => {
        f.callbacks[0]!.inbound({
          ...message,
          media: [],
          id,
          sender,
          text,
          timestamp: new Date(Date.now() + 1000).toISOString(),
          fromMe: mutation.fromMe,
          mutation
        });
        await settle();
      };
      const sentId = sent.json().message.id;
      const providerId = sent.json().message.providerMessageId;
      await emitMutation("read-receipt", {
        kind: "receipt",
        targetId: providerId,
        fromMe: true,
        status: "read"
      });
      expect(
        f.store.snapshot().conversationMessages.find((entry) => entry.id === sentId)
      ).toMatchObject({ status: "delivered", readAt: expect.any(String) });
      await emitMutation("old-sent-receipt", {
        kind: "receipt",
        targetId: providerId,
        fromMe: true,
        status: "sent"
      });
      expect(
        f.store.snapshot().conversationMessages.find((entry) => entry.id === sentId)
      ).toMatchObject({ status: "delivered", readAt: expect.any(String) });
      await emitMutation(
        "spoofed-edit",
        { kind: "edit", targetId: message.id, fromMe: false },
        "Spoof",
        "254722222222@s.whatsapp.net"
      );
      expect(
        f.store.snapshot().conversationMessages.find((entry) => entry.id === imported.id)!.content
      ).toMatchObject({ text: "Invoice" });
      await emitMutation(
        "valid-edit",
        { kind: "edit", targetId: message.id, fromMe: false },
        "Updated invoice caption"
      );
      expect(
        f.store.snapshot().conversationMessages.find((entry) => entry.id === imported.id)
      ).toMatchObject({
        content: { text: "Updated invoice caption" },
        editedAt: expect.any(String)
      });
      await emitMutation("valid-delete", { kind: "delete", targetId: message.id, fromMe: false });
      await vi.waitFor(() =>
        expect(
          f.store.snapshot().conversationMessages.find((entry) => entry.id === imported.id)!
            .deletedAt
        ).toBeTruthy()
      );
      expect(await f.blobStore.get(attachment.storageKey)).toBeNull();
      expect(
        (await f.main.inject({ method: "GET", url, headers: { cookie: f.first.cookie } }))
          .statusCode
      ).toBe(404);
      await emitMutation(
        "late-edit",
        { kind: "edit", targetId: message.id, fromMe: false },
        "Resurrect"
      );
      expect(
        f.store.snapshot().conversationMessages.find((entry) => entry.id === imported.id)!.content
      ).toMatchObject({ text: "[Message deleted on WhatsApp]" });
    } finally {
      await f.close();
    }
  });
  it("requires the owner to choose and approve a group before importing any of its messages", async () => {
    const f = await setup();
    try {
      const url = `${f.path}/groups`,
        headers = { cookie: f.first.cookie };
      expect(
        (await f.app.inject({ method: "GET", url, headers: { cookie: f.second.cookie } }))
          .statusCode
      ).toBe(403);
      expect(f.groups).not.toHaveBeenCalled();
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers,
        payload: { phone: "254700000000", consent: true }
      });
      f.callbacks[0]!.state("open");
      const listed = await f.app.inject({ method: "GET", url, headers });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().groups).toEqual([
        { chat: "123456789@g.us", name: "Approved test group" }
      ]);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(f.store.snapshot().conversationChannels).toHaveLength(0);
      const approval = await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers,
        payload: { chat: "123456789@g.us", approved: true }
      });
      expect(approval.statusCode, approval.body).toBe(200);
      expect(approval.json().scopes[0].automation).toBe(false);
      expect(f.send).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it("reads approved image pixels through the selected existing model without publishing records", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "openai/gpt-6-luna",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                type: "response",
                message: "Visible label: Milk. Price and stock are not visible."
              })
            }
          }
        ]
      })
    );
    const adapter = createOpenRouterModelAdapter({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "test-only",
      request
    });
    const f = await setup(true, true, () => adapter);
    try {
      const headers = { cookie: f.first.cookie },
        chat = "254711111111@s.whatsapp.net";
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers,
        payload: { phone: "254700000000", consent: true }
      });
      f.callbacks[0]!.state("open");
      await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers,
        payload: { chat, approved: true, automation: true }
      });
      const bytes = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      bytes.write("IHDR", 12);
      bytes.writeUInt32BE(1, 16);
      bytes.writeUInt32BE(1, 20);
      await f.store.ingestLinkedWhatsAppMessage({
        businessId: f.first.businessId,
        ownerId: f.first.ownerId,
        chat,
        sender: chat,
        id: "photo",
        text: "Draft this catalogue item",
        timestamp: new Date().toISOString(),
        media: [
          { bytes, filename: "milk.png", mimeType: "image/png", kind: "image", category: "image" }
        ]
      });
      const input = {
        businessId: f.first.businessId,
        ownerId: f.first.ownerId,
        chat,
        sender: chat,
        messageId: "photo"
      };
      expect(await f.store.readLinkedWhatsAppEvidence(input)).toContain(
        "Price and stock are not visible"
      );
      expect(await f.store.readLinkedWhatsAppEvidence(input)).toContain("Milk");
      expect(request).toHaveBeenCalledTimes(1);
      const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
      expect(body.model).toBe("openai/gpt-6-luna");
      expect(JSON.stringify(body.messages)).toContain(bytes.toString("base64"));
      expect(body.tools).toBeUndefined();
      expect(f.store.snapshot().products).toHaveLength(0);
      f.store.setLinkedToolGrants({
        businessId: f.first.businessId,
        ownerId: f.first.ownerId,
        chat,
        tools: [],
        enabled: false
      });
      expect(await f.store.readLinkedWhatsAppEvidence(input)).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(f.send).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it("delegates only explicit tools, suppresses owner context and requires owner approval for writes", async () => {
    const f = await setup(true, true);
    try {
      const headers = { cookie: f.first.cookie },
        chat = "254711111111@s.whatsapp.net";
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers,
        payload: { phone: "254700000000", consent: true }
      });
      f.callbacks[0]!.state("open");
      const scopes = await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers,
        payload: { chat, approved: true, automation: true }
      });
      expect(scopes.statusCode, scopes.body).toBe(200);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${f.path}/tools`,
            headers,
            payload: { chat, tools: ["products.list"] }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${f.path}/tools`,
            headers,
            payload: { chat, consent: true, tools: ["computer.session.create"] }
          })
        ).statusCode
      ).toBe(400);
      const granted = await f.app.inject({
        method: "POST",
        url: `${f.path}/tools`,
        headers,
        payload: { chat, consent: true, tools: ["products.list", "product.create"] }
      });
      expect(granted.statusCode, granted.body).toBe(200);
      const source = {
        businessId: f.first.businessId,
        ownerId: f.first.ownerId,
        chat,
        sender: chat,
        id: "catalogue-request",
        text: "show products",
        timestamp: new Date().toISOString()
      };
      await f.store.ingestLinkedWhatsAppMessage(source);
      const ticket = {
        businessId: source.businessId,
        ownerId: source.ownerId,
        chat,
        sender: chat,
        messageId: source.id,
        grantId: granted.json().id
      };
      const call = (payload = ticket, authorization = `Bearer ${"t".repeat(32)}`) =>
        f.app.inject({
          method: "POST",
          url: "/internal/whatsapp-linked/turn",
          headers: { authorization },
          payload
        });
      expect((await call(ticket, "Bearer wrong")).statusCode).toBe(401);
      expect((await call({ ...ticket, sender: "254722222222@s.whatsapp.net" })).statusCode).toBe(
        403
      );
      const result = await call();
      expect(result.statusCode, result.body).toBe(200);
      const turns = f.store.snapshot().runtimeTurns;
      const turn = turns.find((turn) => turn.sourceMessageId)!;
      expect(turn.plan.toolName).toBe("products.list");
      expect(turn.context).toMatchObject({
        role: "view_only",
        customerCount: 0,
        supplierCount: 0,
        invoiceCount: 0,
        outstandingDebtTotal: 0
      });
      expect(turn.plan.channelDelegation).toMatchObject({ actorId: chat, grantId: ticket.grantId });
      expect((await call()).statusCode).toBe(200);
      expect(f.store.snapshot().runtimeTurns).toHaveLength(turns.length);
      await f.store.ingestLinkedWhatsAppMessage({
        ...source,
        id: "draft-product",
        text: "Add 3 packets of milk at 100 each"
      });
      const prepared = await call({ ...ticket, messageId: "draft-product" });
      expect(prepared.statusCode, prepared.body).toBe(200);
      expect(prepared.json().text).toContain("owner's approval");
      expect(f.store.snapshot().products).toHaveLength(0);
      const proposal = f.store
        .snapshot()
        .runtimeTurns.find((turn) => turn.plan.toolName === "product.create")!;
      expect(proposal.status).toBe("needs_confirmation");
      expect(prepared.body).not.toContain(proposal.plan.confirmationToken);
      const ownerCard = f.store
        .snapshot()
        .conversationMessages.find((message) => message.content.type === "confirmation")!;
      expect(ownerCard.content).toMatchObject({
        type: "confirmation",
        approvalScope: { runtimeSessionId: proposal.sessionId }
      });
      const confirm = (turn: typeof proposal) =>
        f.main.inject({
          method: "POST",
          url: `/businesses/${f.first.businessId}/runtime/turns`,
          headers,
          payload: {
            runtimeSessionId: turn.sessionId,
            conversationId: ownerCard.conversationId,
            message: "confirm",
            confirmationToken: turn.plan.confirmationToken
          }
        });
      const accepted = await confirm(proposal);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().turn.status).toBe("completed");
      expect(f.store.snapshot().products).toHaveLength(1);
      await f.store.ingestLinkedWhatsAppMessage({
        ...source,
        id: "revoked-draft",
        text: "Add 2 packets of maize at 80 each"
      });
      expect((await call({ ...ticket, messageId: "revoked-draft" })).statusCode).toBe(200);
      const revocable = f.store
        .snapshot()
        .runtimeTurns.filter(
          (turn) => turn.plan.toolName === "product.create" && turn.status === "needs_confirmation"
        )
        .at(-1)!;
      await f.app.inject({
        method: "POST",
        url: `${f.path}/tools`,
        headers,
        payload: { chat, consent: true, tools: [] }
      });
      expect((await call()).statusCode).toBe(403);
      const deniedConfirmation = await confirm(revocable);
      expect(
        deniedConfirmation.statusCode === 403 ||
          deniedConfirmation.json().turn?.status === "blocked",
        deniedConfirmation.body
      ).toBe(true);
      expect(f.store.snapshot().products).toHaveLength(1);
      expect(() =>
        f.store.validateLinkedToolDelegation(
          f.first.businessId,
          proposal.plan.channelDelegation!,
          "product.create"
        )
      ).toThrow();
      // Only the approved write reports back to WhatsApp; the revoked one stays silent.
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0]!.slice(0, 2)).toEqual([
        chat,
        "Done: the new catalogue item was added."
      ]);
    } finally {
      await f.close();
    }
  });
  it("provisions the existing default model on first assistant consent without manual setup", async () => {
    const f = await setup(true, true);
    try {
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { consent: true, phone: "254700000000" }
      });
      f.callbacks[0]!.state("open");
      const approve = () =>
        f.app.inject({
          method: "POST",
          url: `${f.path}/scopes`,
          headers: { cookie: f.first.cookie },
          payload: { chat: "254711111111@s.whatsapp.net", approved: true, automation: true }
        });
      const enabled = await approve();
      expect(enabled.statusCode, enabled.body).toBe(200);
      expect(enabled.json().scopes[0].automation).toBe(true);
      expect(
        f.store.linkedWhatsAppRuntime(
          f.first.businessId,
          f.first.ownerId,
          enabled.json().scopes[0].conversationId
        ).modelId
      ).toBe("gpt-6-luna");
    } finally {
      await f.close();
    }
  });
  it("preserves an already selected model when enabling assistant replies", async () => {
    const f = await setup(true, true);
    try {
      const model = f.store.listModelCatalog().find((entry) => entry.id === "gpt-6-luna")!;
      f.store.activateGlobalDefaultModel({
        model: { ...model, id: "selected-existing-model" },
        executionTarget: "backend",
        checkedAt: new Date().toISOString(),
        updatedBy: f.first.ownerId
      });
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { consent: true, phone: "254700000000" }
      });
      f.callbacks[0]!.state("open");
      const approved = await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat: "254711111111@s.whatsapp.net", approved: true, automation: true }
      });
      expect(approved.statusCode, approved.body).toBe(200);
      const conversationId = approved.json().scopes[0].conversationId;
      expect(
        f.store.linkedWhatsAppRuntime(f.first.businessId, f.first.ownerId, conversationId).modelId
      ).toBe("selected-existing-model");
    } finally {
      await f.close();
    }
  });
  it("requires owner authentication before exposing connection state and explicit pairing consent", async () => {
    const f = await setup();
    try {
      expect((await f.app.inject({ method: "GET", url: f.path })).statusCode).toBe(401);
      expect(
        (await f.app.inject({ method: "GET", url: f.path, headers: { cookie: f.second.cookie } }))
          .statusCode
      ).toBe(403);
      const denied = await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { phone: "254700000000" }
      });
      expect(denied.statusCode).toBe(400);
      expect(f.driver.open).not.toHaveBeenCalled();
      const paired = await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { phone: "254700000000", consent: true }
      });
      expect(paired.statusCode, paired.body).toBe(200);
      expect(paired.json().pairingCode).toBe("CODE1234");
      expect(paired.headers["cache-control"]).toBe("no-store");
    } finally {
      await f.close();
    }
  });
  it("gates ingestion by approval, deduplicates reconnect events, and preserves tenant identity", async () => {
    const f = await setup();
    try {
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { phone: "254700000000", consent: true }
      });
      f.callbacks[0]!.save("auth");
      f.callbacks[0]!.state("open");
      const message = {
        id: "same-provider-id",
        chat: "254711111111@s.whatsapp.net",
        sender: "254711111111@s.whatsapp.net",
        text: "Nahitaji bidhaa",
        fromMe: false,
        mentioned: false,
        timestamp: new Date().toISOString()
      };
      f.callbacks[0]!.inbound(message);
      await settle();
      expect(
        f.store
          .snapshot()
          .conversationMessages.filter((entry) => entry.provider === "whatsapp_linked")
      ).toHaveLength(0);
      const approved = await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat: message.chat, approved: true }
      });
      expect(approved.statusCode, approved.body).toBe(200);
      f.callbacks[0]!.inbound(message);
      f.callbacks[0]!.inbound(message);
      await settle();
      const imported = f.store
        .snapshot()
        .conversationMessages.filter((entry) => entry.provider === "whatsapp_linked");
      expect(imported).toHaveLength(1);
      expect(imported[0]!.content).toMatchObject({ type: "text", text: message.text });
      expect(imported[0]!.senderAddress).toBe(message.sender);
      expect(imported[0]!.providerMessageId).toBe(message.id);
      expect(imported[0]!.clientTimestamp).toBe(message.timestamp);
      const conversation = f.store
        .snapshot()
        .conversations.find((entry) => entry.id === imported[0]!.conversationId)!;
      expect(conversation.activeShopId).toBe(f.first.businessId);
      expect(f.send).not.toHaveBeenCalled();
      const outbound = {
        conversationId: imported[0]!.conversationId,
        provider: "whatsapp_linked",
        text: "Karibu",
        idempotencyKey: "reply-once"
      };
      const sent = await f.main.inject({
        method: "POST",
        url: `/businesses/${f.first.businessId}/channel-messages`,
        headers: { cookie: f.first.cookie },
        payload: outbound
      });
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json().message).toMatchObject({
        status: "sent",
        actualChannel: "whatsapp_linked"
      });
      const repeated = await f.main.inject({
        method: "POST",
        url: `/businesses/${f.first.businessId}/channel-messages`,
        headers: { cookie: f.first.cookie },
        payload: outbound
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(
        f.store
          .snapshot()
          .auditEvents.some((event) => event.type === "whatsapp_linked.connection_state")
      ).toBe(true);
      expect(JSON.stringify(f.store.snapshot().auditEvents)).not.toContain("CODE1234");

      await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat: message.chat, approved: false }
      });
      f.callbacks[0]!.inbound({ ...message, id: "after-revoke" });
      await settle();
      expect(
        f.store
          .snapshot()
          .conversationMessages.filter((entry) => entry.provider === "whatsapp_linked")
      ).toHaveLength(2);
      expect(
        (
          await f.app.inject({
            method: "DELETE",
            url: f.path,
            headers: { cookie: f.second.cookie }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await f.app.inject({ method: "DELETE", url: f.path, headers: { cookie: f.first.cookie } })
        ).json().state
      ).toBe("DISCONNECTED");
    } finally {
      await f.close();
    }
  });
  it("honors recipient STOP and START through existing gateway opt-out checks", async () => {
    const f = await setup();
    try {
      await f.app.inject({
        method: "POST",
        url: `${f.path}/connect`,
        headers: { cookie: f.first.cookie },
        payload: { consent: true, phone: "254700000000" }
      });
      f.callbacks[0]!.save("auth");
      f.callbacks[0]!.state("open");
      const chat = "254711111111@s.whatsapp.net";
      const approved = await f.app.inject({
        method: "POST",
        url: `${f.path}/scopes`,
        headers: { cookie: f.first.cookie },
        payload: { chat, approved: true }
      });
      const conversationId = approved.json().scopes[0].conversationId;
      const message = {
        id: "stop",
        chat,
        sender: chat,
        text: "STOP",
        fromMe: false,
        mentioned: false,
        timestamp: new Date().toISOString()
      };
      f.callbacks[0]!.inbound(message);
      await settle();
      const send = () =>
        f.main.inject({
          method: "POST",
          url: `/businesses/${f.first.businessId}/channel-messages`,
          headers: { cookie: f.first.cookie },
          payload: {
            conversationId,
            provider: "whatsapp_linked",
            text: "Hello",
            idempotencyKey: "optout-reply"
          }
        });
      expect((await send()).statusCode).toBe(409);
      expect(f.send).not.toHaveBeenCalled();
      f.callbacks[0]!.inbound({ ...message, id: "start", text: "START" });
      await settle();
      const sent = await send();
      expect(sent.statusCode, sent.body).toBe(200);
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it("leaves core messaging available when the connector is disabled", async () => {
    const f = await setup(false);
    try {
      const state = await f.app.inject({
        method: "GET",
        url: f.path,
        headers: { cookie: f.first.cookie }
      });
      expect(state.json()).toMatchObject({ enabled: false, state: "DISCONNECTED" });
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${f.path}/connect`,
            headers: { cookie: f.first.cookie },
            payload: { consent: true, phone: "254700000000" }
          })
        ).statusCode
      ).toBe(503);
      expect(
        (
          await f.main.inject({
            method: "GET",
            url: "/v1/conversations",
            headers: { cookie: f.first.cookie }
          })
        ).statusCode
      ).toBe(200);
    } finally {
      await f.close();
    }
  });
});
