import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { baileysLinkedDriver } from "./baileys-driver.js";
const protocol = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown) => void>(),
  make: vi.fn(),
  requestPairingCode: vi.fn(async () => "CODE1234"),
  sendMessage: vi.fn(async () => ({ key: { id: "sent-id" } })),
  end: vi.fn(),
  logout: vi.fn(async () => undefined),
  downloadContent: vi.fn(),
  groups: vi.fn(async () => ({
    "123456789@g.us": {
      id: "123456789@g.us",
      subject: "Shop group",
      participants: ["PRIVATE_PARTICIPANT_CANARY"]
    }
  })),
  lookupPhone: vi.fn(async (_lid: string): Promise<string | null> => {
    void _lid;
    return null;
  }),
  lookupMappings: vi.fn(async (): Promise<Array<{ pn: string; lid: string }> | null> => null)
}));
vi.mock("baileys", () => ({
  default: protocol.make,
  downloadContentFromMessage: protocol.downloadContent,
  initAuthCreds: () => ({ registered: false, secret: "private-key" }),
  BufferJSON: {
    replacer: (_key: string, value: unknown) => value,
    reviver: (_key: string, value: unknown) => value
  },
  proto: {
    WebMessageInfo: { StubType: { REVOKE: 1 } },
    Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => value } }
  },
  DisconnectReason: {
    loggedOut: 401,
    badSession: 500,
    connectionReplaced: 440,
    multideviceMismatch: 411,
    restartRequired: 515
  },
  jidNormalizedUser: (jid: string) => jid.replace(/:\d+@/, "@"),
  normalizeMessageContent: (value: unknown) => value
}));
beforeEach(() => {
  vi.clearAllMocks();
  protocol.listeners.clear();
  protocol.lookupPhone.mockResolvedValue(null);
  protocol.lookupMappings.mockResolvedValue(null);
  protocol.make.mockImplementation(() => ({
    user: { id: "254700000000:1@s.whatsapp.net" },
    signalRepository: {
      lidMapping: { getPNForLID: protocol.lookupPhone, getLIDsForPNs: protocol.lookupMappings }
    },
    ev: {
      on: (type: string, callback: (event: unknown) => void) =>
        protocol.listeners.set(type, callback)
    },
    requestPairingCode: protocol.requestPairingCode,
    sendMessage: protocol.sendMessage,
    groupFetchAllParticipating: protocol.groups,
    end: protocol.end,
    logout: protocol.logout
  }));
});
async function fixture(auth: string | null = null, approved: string[] = []) {
  const input = {
    auth,
    approvedContacts: () => approved,
    save: vi.fn(),
    state: vi.fn(),
    inbound: vi.fn()
  };
  const socket = await baileysLinkedDriver.open(input);
  const emit = (type: string, data: unknown) => protocol.listeners.get(type)!(data);
  return { socket, input, emit };
}
describe("Baileys protocol boundary (mocked, not live compatibility)", () => {
  it("lists only group names and identifiers after an explicit lookup", async () => {
    const f = await fixture();
    expect(protocol.groups).not.toHaveBeenCalled();
    expect(await f.socket.groups!()).toEqual([{ chat: "123456789@g.us", name: "Shop group" }]);
    expect(protocol.groups).toHaveBeenCalledTimes(1);
  });
  it("normalizes provider edits, revocations and monotonic delivery receipt events", async () => {
    const f = await fixture();
    const key = { remoteJid: "254711111111@s.whatsapp.net", id: "original", fromMe: false };
    f.emit("messages.update", [
      {
        key,
        update: {
          message: { editedMessage: { message: { conversation: "Edited" } } },
          messageTimestamp: 1794111000
        }
      }
    ]);
    await vi.waitFor(() => expect(f.input.inbound).toHaveBeenCalledTimes(1));
    expect(f.input.inbound.mock.calls[0]![0]).toMatchObject({
      text: "Edited",
      mutation: { kind: "edit", targetId: "original", fromMe: false }
    });
    f.emit("messages.update", [
      { key, update: { message: null, messageStubType: 1 } },
      { key: { ...key, fromMe: true }, update: { status: 4 } }
    ]);
    await vi.waitFor(() => expect(f.input.inbound).toHaveBeenCalledTimes(3));
    expect(f.input.inbound.mock.calls[2]![0]).toMatchObject({
      mutation: { kind: "receipt", status: "read", fromMe: true }
    });
    f.emit("messages.delete", { all: true, jid: key.remoteJid });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.input.inbound).toHaveBeenCalledTimes(3);
  });
  it("sends supported attachments with the stable message ID and caption in one provider call", async () => {
    const f = await fixture();
    const bytes = Buffer.from("%PDF-1.7\nTest");
    await f.socket.send("254711111111@s.whatsapp.net", "Invoice", "stable-id", {
      bytes,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      category: "document"
    });
    expect(protocol.sendMessage).toHaveBeenCalledTimes(1);
    expect(protocol.sendMessage).toHaveBeenCalledWith(
      "254711111111@s.whatsapp.net",
      {
        document: bytes,
        mimetype: "application/pdf",
        fileName: "invoice.pdf",
        caption: "Invoice"
      },
      { messageId: "stable-id" }
    );
  });
  it("disables history, broadcasts, online presence and protocol logging", async () => {
    await fixture();
    const config = protocol.make.mock.calls[0]![0];
    expect(config.syncFullHistory).toBe(false);
    expect(config.shouldSyncHistoryMessage({})).toBe(false);
    expect(config.markOnlineOnConnect).toBe(false);
    expect(config.logger.level).toBe("silent");
    expect(config.shouldIgnoreJid("status@broadcast")).toBe(true);
    expect(config.shouldIgnoreJid("123@newsletter")).toBe(true);
  });
  it("waits for pairing readiness and keeps codes out of persisted unregistered credentials", async () => {
    const f = await fixture();
    const pairing = f.socket.pairingCode("254700000000");
    expect(protocol.requestPairingCode).not.toHaveBeenCalled();
    f.emit("creds.update", { registered: false });
    expect(f.input.save).not.toHaveBeenCalled();
    f.emit("connection.update", { qr: "private-qr" });
    expect(await pairing).toBe("CODE1234");
    expect(protocol.requestPairingCode).toHaveBeenCalledWith("254700000000");
    f.emit("creds.update", { registered: true });
    expect(f.input.save).toHaveBeenCalled();
  });
  it("imports notify text, sender, provider timestamp and mention/reply metadata only", async () => {
    const f = await fixture();
    const message = {
      key: {
        id: "id",
        remoteJid: "123456@g.us",
        participant: "254711111111@s.whatsapp.net",
        fromMe: false
      },
      messageTimestamp: 1700000000,
      message: {
        extendedTextMessage: {
          text: "Habari",
          contextInfo: { mentionedJid: ["254700000000@s.whatsapp.net"], stanzaId: "quoted" }
        }
      }
    };
    f.emit("messages.upsert", { type: "append", messages: [message] });
    expect(f.input.inbound).not.toHaveBeenCalled();
    f.emit("messages.upsert", {
      type: "notify",
      messages: [
        message,
        { ...message, key: { ...message.key, fromMe: true } },
        { ...message, message: { audioMessage: { url: "https://untrusted.test/audio" } } }
      ]
    });
    expect(f.input.inbound).toHaveBeenCalledTimes(2);
    expect(f.input.inbound).toHaveBeenNthCalledWith(1, {
      id: "id",
      chat: "123456@g.us",
      sender: "254711111111@s.whatsapp.net",
      text: "Habari",
      timestamp: "2023-11-14T22:13:20.000Z",
      fromMe: false,
      mentioned: true,
      replyTo: "quoted"
    });
    expect(f.input.inbound).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "[Attachment rejected: unsupported format or size.]"
      })
    );
    expect(protocol.downloadContent).not.toHaveBeenCalled();
  });
  it("journals media descriptors without downloading and bounds the later authorized stream", async () => {
    const f = await fixture();
    const bytes = Buffer.from("%PDF-1.7\nexample");
    f.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "media", remoteJid: "254711111111@s.whatsapp.net" },
          messageTimestamp: 1700000000,
          message: {
            documentMessage: {
              fileName: "invoice.pdf",
              mimetype: "application/pdf",
              fileLength: bytes.length,
              directPath: "/mms/test.enc",
              mediaKey: Buffer.alloc(32),
              fileSha256: createHash("sha256").update(bytes).digest()
            }
          }
        }
      ]
    });
    const media = f.input.inbound.mock.calls[0]![0].media[0];
    expect(protocol.downloadContent).not.toHaveBeenCalled();
    protocol.downloadContent.mockResolvedValue(Readable.from([bytes]));
    expect(await f.socket.downloadMedia!(media, new AbortController().signal)).toEqual(bytes);
    expect(protocol.downloadContent.mock.calls[0]![0].url).toBeUndefined();
    expect(protocol.downloadContent.mock.calls[0]![2]).toMatchObject({
      host: "mmg.whatsapp.net",
      options: { redirect: "error" }
    });
    const oversized = Readable.from([Buffer.alloc(bytes.length + 1)]);
    protocol.downloadContent.mockResolvedValue(oversized);
    await expect(f.socket.downloadMedia!(media, new AbortController().signal)).rejects.toThrow(
      "declared size"
    );
    expect(oversized.destroyed).toBe(true);
  });
  it("uses only protocol-supplied phone aliases for LID-addressed contacts", async () => {
    const f = await fixture();
    const message = {
      key: {
        id: "lid-message",
        remoteJid: "999999999999@lid",
        remoteJidAlt: "254711111111@s.whatsapp.net"
      },
      messageTimestamp: 1700000000,
      message: { conversation: "Grogoni test" }
    };
    f.emit("messages.upsert", { type: "notify", messages: [message] });
    expect(f.input.inbound).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chat: "254711111111@s.whatsapp.net",
        sender: "254711111111@s.whatsapp.net"
      })
    );
    f.emit("messages.upsert", {
      type: "notify",
      messages: [{ ...message, key: { ...message.key, remoteJidAlt: "untrusted@username" } }]
    });
    await new Promise(setImmediate);
    expect(f.input.inbound).toHaveBeenLastCalledWith(
      expect.objectContaining({ chat: "999999999999@lid" })
    );
  });
  it("resolves omitted phone aliases through the protocol mapping cache", async () => {
    const f = await fixture();
    protocol.lookupPhone.mockResolvedValue("254711111111@s.whatsapp.net");
    f.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "mapped", remoteJid: "999999999999@lid" },
          messageTimestamp: 1700000000,
          message: { conversation: "Grogoni test" }
        }
      ]
    });
    await new Promise(setImmediate);
    expect(f.input.inbound).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "254711111111@s.whatsapp.net",
        sender: "254711111111@s.whatsapp.net"
      })
    );
  });
  it("queries only approved phone identities once per scope set for unknown LIDs", async () => {
    const phone = "254711111111@s.whatsapp.net";
    const f = await fixture(null, [phone, "123456@g.us"]);
    protocol.lookupMappings.mockResolvedValue([{ pn: phone, lid: "999999999999@lid" }]);
    const message = {
      key: { id: "mapped", remoteJid: "999999999999@lid" },
      messageTimestamp: 1700000000,
      message: { conversation: "Grogoni test" }
    };
    f.emit("messages.upsert", { type: "notify", messages: [message, message] });
    await new Promise(setImmediate);
    expect(protocol.lookupMappings).toHaveBeenCalledTimes(1);
    expect(protocol.lookupMappings).toHaveBeenCalledWith([phone]);
    expect(f.input.inbound).toHaveBeenCalledWith(
      expect.objectContaining({ chat: phone, sender: phone })
    );
  });
  it("bounds unresolved identity work before protocol lookups complete", async () => {
    const f = await fixture();
    protocol.lookupPhone.mockImplementation(() => new Promise(() => undefined));
    f.emit("messages.upsert", {
      type: "notify",
      messages: Array.from({ length: 65 }, (_, index) => ({
        key: { id: `pending-${index}`, remoteJid: "999999999999@lid" },
        messageTimestamp: 1700000000,
        message: { conversation: "test" }
      }))
    });
    expect(protocol.lookupPhone).toHaveBeenCalledTimes(64);
    expect(f.input.state).toHaveBeenCalledWith("close", "retry");
    expect(f.input.inbound).not.toHaveBeenCalled();
    f.socket.close();
  });
  it.each([
    [401, "revoked"],
    [440, "auth"],
    [500, "auth"],
    [411, "auth"],
    [515, "restart"],
    [408, "retry"]
  ])("classifies provider disconnect %s as %s", async (statusCode, reason) => {
    const f = await fixture();
    f.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode } } }
    });
    expect(f.input.state).toHaveBeenCalledWith("close", reason);
  });
  it("preserves the deterministic send ID and closes listeners after stop", async () => {
    const f = await fixture();
    expect(await f.socket.send("254711111111@s.whatsapp.net", "Hello", "deterministic")).toBe(
      "sent-id"
    );
    expect(protocol.sendMessage).toHaveBeenCalledWith(
      "254711111111@s.whatsapp.net",
      { text: "Hello" },
      { messageId: "deterministic" }
    );
    f.socket.close();
    f.emit("connection.update", { connection: "open" });
    expect(f.input.state).not.toHaveBeenCalled();
  });
});
