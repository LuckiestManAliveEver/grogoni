import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundChannelMessage } from "../services/api/src/messaging/channel-gateway";
import { LinkedSessionVault } from "../services/api/src/messaging/whatsapp-linked/vault";
import {
  LinkedWhatsAppConnector,
  type LinkedDriver,
  type LinkedInbound
} from "../services/api/src/messaging/whatsapp-linked/connector";

const roots: string[] = [];
const connectors: LinkedWhatsAppConnector[] = [];
afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.stop()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});
function fixture(automation = false) {
  const root = mkdtempSync(join(tmpdir(), "grogoni-wa-"));
  roots.push(root);
  const vault = new LinkedSessionVault(root, Buffer.alloc(32, 7));
  const events: Parameters<LinkedDriver["open"]>[0][] = [];
  const send = vi.fn(async (_chat: string, _text: string, id: string) => id);
  const close = vi.fn();
  const logout = vi.fn(async () => undefined);
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      events.push(input);
      return { send, close, logout, pairingCode: async () => "ABCD1234" };
    })
  };
  const receive = vi.fn<
    (
      businessId: string,
      ownerId: string,
      generation: string,
      message: LinkedInbound
    ) => Promise<void>
  >(async () => undefined);
  const authorize = vi.fn((_business: string, owner: string) => {
    if (owner !== "owner-1") throw new Error("owner revoked");
  });
  const respond = vi.fn(async () => "Karibu");
  const deliver = vi.fn(async () => undefined);
  const options = {
    vault,
    driver,
    receive,
    authorize,
    ...(automation ? { respond, deliver } : {})
  };
  const connector = new LinkedWhatsAppConnector(options);
  connectors.push(connector);
  const inbound: LinkedInbound = {
    id: "message-1",
    chat: "254711111111@s.whatsapp.net",
    sender: "254711111111@s.whatsapp.net",
    text: "Habari",
    fromMe: false,
    mentioned: false,
    timestamp: "2026-11-06T15:00:00.000Z"
  };
  async function connect() {
    await connector.connect("business-1", "owner-1", "254700000000");
    events.at(-1)!.save("secret-auth");
    events.at(-1)!.state("open");
  }
  function approve(automate = false) {
    connector.approve("business-1", "owner-1", inbound.chat, "conversation-1", automate);
  }
  function outbound(): OutboundChannelMessage {
    return {
      businessId: "business-1",
      conversationId: "conversation-1",
      customerId: null,
      idempotencyKey: "send-1",
      text: "Hello",
      endpoint: {
        businessId: "business-1",
        conversationId: "conversation-1",
        channelId: "channel-1",
        channelIdentityId: "identity-1",
        customerId: null,
        provider: "whatsapp_linked",
        externalUserId: inbound.chat,
        externalConversationId: inbound.chat,
        configured: true,
        authorized: true,
        status: "available",
        capabilities: ["CAN_REPLY"],
        lastInboundAt: inbound.timestamp,
        lastOutboundAt: null
      }
    };
  }
  return {
    root,
    vault,
    connector,
    options,
    events,
    send,
    close,
    logout,
    driver,
    receive,
    respond,
    deliver,
    authorize,
    inbound,
    connect,
    approve,
    outbound
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("encrypted Linked Devices vault", () => {
  it("rewraps sessions with the current key and retires the previous key", () => {
    const f = fixture();
    f.vault.write("rotation", "durable session");
    const currentKey = Buffer.alloc(32, 9);
    const rotated = new LinkedSessionVault(f.root, currentKey, [Buffer.alloc(32, 7)]);
    expect(rotated.read("rotation")).toBe("durable session");
    expect(new LinkedSessionVault(f.root, currentKey).read("rotation")).toBe("durable session");
    expect(() => f.vault.read("rotation")).toThrow();
  });
  it("encrypts with authenticated tenant binding and random nonces; deletion removes credentials", () => {
    const f = fixture();
    f.vault.write("a", "private session");
    const file = readdirSync(f.root).find((name) => name.endsWith(".session"))!;
    const first = readFileSync(join(f.root, file));
    expect(first.includes(Buffer.from("private session"))).toBe(false);
    expect(f.vault.read("a")).toBe("private session");
    f.vault.write("a", "private session");
    expect(readFileSync(join(f.root, file)).equals(first)).toBe(false);
    f.vault.write("b", "other");
    const b = readdirSync(f.root).find((name) => name !== file)!;
    writeFileSync(join(f.root, b), first);
    expect(() => f.vault.read("b")).toThrow();
    f.vault.delete("a");
    expect(f.vault.read("a")).toBeNull();
  });
  it("rejects wrong keys, modified ciphertext and oversized records", () => {
    const f = fixture();
    f.vault.write("a", "secret");
    expect(() => new LinkedSessionVault(f.root, Buffer.alloc(32, 8)).read("a")).toThrow();
    const file = join(f.root, readdirSync(f.root)[0]!);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    expect(() => f.vault.read("a")).toThrow();
    expect(() => f.vault.write("large", "x".repeat(16 * 1024 * 1024 + 1))).toThrow();
  });
});

describe("Linked Devices lifecycle and consent", () => {
  it("fails closed when session storage fails during a provider connection event", async () => {
    const f = fixture();
    await f.connector.connect("business-1", "owner-1", "254700000000");
    const write = vi.spyOn(f.vault, "write").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => f.events[0]!.state("open")).not.toThrow();
    expect(f.connector.status("business-1", "owner-1").state).toBe("ERROR");
    expect(f.close).toHaveBeenCalled();
    write.mockRestore();
  });
  it("requires a phone for first pairing, keeps a single attempt, and clears the pairing code on success", async () => {
    const f = fixture();
    await expect(f.connector.connect("business-1", "owner-1")).rejects.toThrow();
    await Promise.all([
      f.connector.connect("business-1", "owner-1", "254700000000"),
      f.connector.connect("business-1", "owner-1", "254700000000")
    ]);
    expect(f.driver.open).toHaveBeenCalledTimes(1);
    expect(f.connector.status("business-1", "owner-1")).toMatchObject({
      state: "PAIRING",
      pairingCode: "ABCD1234",
      scopes: []
    });
    f.events[0]!.save("auth");
    f.events[0]!.state("open");
    expect(f.connector.status("business-1", "owner-1")).toMatchObject({
      state: "CONNECTED",
      pairingCode: null
    });
  });
  it("caps the number of accounts on a host", async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++)
      await f.connector.connect(`business-${i}`, "owner-1", "254700000000");
    await expect(f.connector.connect("business-extra", "owner-1", "254700000000")).rejects.toThrow(
      "eight-account"
    );
    expect(f.driver.open).toHaveBeenCalledTimes(8);
  });
  it("replays encrypted inbound work after process termination and only acknowledges committed messages", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    let complete!: () => void;
    f.receive.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    f.events[0]!.inbound(f.inbound);
    expect(JSON.parse(f.vault.read("business-1")!).inbox).toHaveLength(1);
    await f.connector.stop();
    const restored = new LinkedWhatsAppConnector(f.options);
    connectors.push(restored);
    await restored.restore();
    f.events.at(-1)!.state("open");
    await settle();
    expect(f.receive).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.vault.read("business-1")!).inbox).toHaveLength(0);
    complete();
    await settle();
    expect(JSON.parse(f.vault.read("business-1")!).inbox).toHaveLength(0);
  });
  it("retains failed inbound work for retry after a restart", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    f.receive.mockRejectedValueOnce(new Error("database unavailable"));
    f.events[0]!.inbound(f.inbound);
    await settle();
    expect(f.connector.status("business-1", "owner-1").state).toBe("RECONNECTING");
    expect(JSON.parse(f.vault.read("business-1")!).inbox).toHaveLength(1);
    await f.connector.stop();
    const restored = new LinkedWhatsAppConnector(f.options);
    connectors.push(restored);
    await restored.restore();
    f.events.at(-1)!.state("open");
    await settle();
    expect(f.receive).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.vault.read("business-1")!).inbox).toHaveLength(0);
  });
  it("scope removal during an in-flight commit never discards another chat's queued message", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    const second = { ...f.inbound, chat: "254722222222@s.whatsapp.net", id: "second" };
    f.connector.approve("business-1", "owner-1", second.chat, "conversation-2");
    let complete!: () => void;
    f.receive.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    f.events[0]!.inbound(f.inbound);
    f.events[0]!.inbound(second);
    f.connector.revoke("business-1", "owner-1", f.inbound.chat);
    complete();
    await settle();
    expect(f.receive).toHaveBeenCalledTimes(2);
    expect(f.receive.mock.calls[1]![3]).toMatchObject({ id: "second" });
  });
  it("only runs assistant replies after separate contact approval", async () => {
    const f = fixture(true);
    await f.connect();
    f.approve();
    f.events[0]!.inbound(f.inbound);
    await settle();
    expect(f.respond).not.toHaveBeenCalled();
    f.approve(true);
    f.events[0]!.inbound({ ...f.inbound, id: "enabled" });
    await settle();
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit invocation in an approved automated group", async () => {
    const f = fixture(true);
    await f.connect();
    const group = { ...f.inbound, chat: "123456789@g.us" };
    f.connector.approve("business-1", "owner-1", group.chat, "group", true);
    f.events[0]!.inbound(group);
    await settle();
    expect(f.respond).not.toHaveBeenCalled();
    f.events[0]!.inbound({ ...group, id: "mention", mentioned: true });
    await settle();
    f.events[0]!.inbound({ ...group, id: "command", text: "Grogoni, habari" });
    await settle();
    expect(f.respond).toHaveBeenCalledTimes(2);
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });
  it("blocks a late assistant reply immediately after STOP or scope removal", async () => {
    const f = fixture(true);
    await f.connect();
    f.approve(true);
    let complete!: (text: string) => void;
    f.respond.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        })
    );
    f.events[0]!.inbound(f.inbound);
    await settle();
    f.events[0]!.inbound({ ...f.inbound, id: "stop", text: "STOP" });
    complete("late reply");
    await settle();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.connector.status("business-1", "owner-1").scopes[0]!.automation).toBe(false);
  });
  it("expires pairing and ignores late success or credential events", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connector.connect("business-1", "owner-1", "254700000000");
    await vi.advanceTimersByTimeAsync(120_001);
    f.events[0]!.save("stale-secret");
    f.events[0]!.state("open");
    expect(f.connector.status("business-1", "owner-1").state).toBe("AUTH_REQUIRED");
    expect(f.vault.read("business-1")).not.toContain("stale-secret");
  });
  it("keeps an approval received before expiry while the authorized socket restarts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connector.connect("business-1", "owner-1", "254700000000");
    await vi.advanceTimersByTimeAsync(119_000);
    f.events[0]!.save("registered-credentials");
    await vi.advanceTimersByTimeAsync(5000);
    f.events[0]!.state("open");
    expect(f.connector.status("business-1", "owner-1").state).toBe("CONNECTED");
    expect(f.vault.read("business-1")).toContain("registered-credentials");
  });
  it("restores authorized sessions without requesting another pairing code", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    await f.connector.stop();
    const restored = new LinkedWhatsAppConnector(f.options);
    connectors.push(restored);
    await restored.restore();
    expect(f.events.at(-1)!.auth).toBe("secret-auth");
    f.events.at(-1)!.state("open");
    expect(restored.status("business-1", "owner-1")).toMatchObject({
      state: "CONNECTED",
      pairingCode: null,
      scopes: [{ chat: f.inbound.chat }]
    });
  });
  it("does not relink revoked sessions and deletes their protocol credentials", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    f.events[0]!.state("close", "revoked");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.driver.open).toHaveBeenCalledTimes(1);
    expect(f.connector.status("business-1", "owner-1").state).toBe("REVOKED");
    expect(f.vault.read("business-1")).not.toContain("secret-auth");
  });
  it("reconnects with backoff and fences replaced socket events", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    f.approve();
    const old = f.events[0]!;
    old.state("close", "retry");
    expect(f.connector.status("business-1", "owner-1").state).toBe("RECONNECTING");
    await vi.advanceTimersByTimeAsync(2600);
    expect(f.driver.open).toHaveBeenCalledTimes(2);
    old.state("open");
    old.save("stale");
    old.inbound(f.inbound);
    expect(f.connector.status("business-1", "owner-1").state).toBe("RECONNECTING");
    expect(f.receive).not.toHaveBeenCalled();
    f.events[1]!.state("open");
    expect(f.connector.status("business-1", "owner-1").state).toBe("CONNECTED");
  });
  it("bounds repeated network failures", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    for (let i = 0; i < 9; i++) {
      f.events.at(-1)!.state("close", "retry");
      await vi.advanceTimersByTimeAsync(61_000);
    }
    expect(f.connector.status("business-1", "owner-1").state).toBe("ERROR");
    expect(f.driver.open).toHaveBeenCalledTimes(9);
  });
  it("rejects account switching and cross-tenant outbound requests", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    expect(() => f.connector.status("business-1", "owner-2")).toThrow();
    await expect(
      f.connector.sendMessage({ ...f.outbound(), businessId: "business-2" })
    ).rejects.toThrow();
    await expect(
      f.connector.sendMessage({
        ...f.outbound(),
        endpoint: { ...f.outbound().endpoint, businessId: "business-2" }
      })
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("only imports explicitly approved conversations and blocks self-message loops", async () => {
    const f = fixture();
    await f.connect();
    f.events[0]!.inbound(f.inbound);
    await settle();
    expect(f.receive).not.toHaveBeenCalled();
    f.approve();
    f.events[0]!.inbound({ ...f.inbound, fromMe: true });
    f.events[0]!.inbound({ ...f.inbound, text: "x".repeat(4001) });
    f.events[0]!.inbound(f.inbound);
    await settle();
    expect(f.receive).toHaveBeenCalledTimes(1);
    f.connector.revoke("business-1", "owner-1", f.inbound.chat);
    f.events[0]!.inbound(f.inbound);
    await settle();
    expect(f.receive).toHaveBeenCalledTimes(1);
  });
  it("does not ingest groups without their separate approval or execute group automation", async () => {
    const f = fixture();
    await f.connect();
    const group = { ...f.inbound, chat: "123456789@g.us", mentioned: true };
    f.events[0]!.inbound(group);
    await settle();
    expect(f.receive).not.toHaveBeenCalled();
    f.connector.approve("business-1", "owner-1", group.chat, "group-conversation");
    f.events[0]!.inbound(group);
    await settle();
    expect(f.receive).toHaveBeenCalledTimes(1);
  });
  it("erases old credentials and approvals when a new authorized business owner takes over", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    f.authorize.mockImplementation((_business, owner) => {
      if (owner !== "owner-2") throw new Error("owner revoked");
    });
    expect(f.connector.status("business-1", "owner-2")).toMatchObject({
      state: "DISCONNECTED",
      scopes: []
    });
    expect(f.vault.read("business-1")).toBeNull();
    await Promise.resolve();
    expect(f.logout).toHaveBeenCalledTimes(1);
    f.events[0]!.inbound(f.inbound);
    await Promise.resolve();
    expect(f.receive).not.toHaveBeenCalled();
  });
  it("drops account-specific approvals when pairing a different WhatsApp number", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    f.events[0]!.state("close", "revoked");
    await f.connector.connect("business-1", "owner-1", "254700000001");
    expect(f.connector.status("business-1", "owner-1").scopes).toEqual([]);
    expect(f.events[1]!.expectedPhone).toBe("254700000001");
  });
  it("revokes an idle connection within the bounded authorization interval", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    f.approve();
    f.authorize.mockImplementation(() => {
      throw new Error("owner revoked");
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.vault.read("business-1")).toBeNull();
    expect(f.logout).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalled();
  });
  it("binds media bytes and quoted targets to the outbound delivery key", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    const attachment = {
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.7\nFirst").toString("base64")
    };
    const request = { ...f.outbound(), attachments: [attachment] };
    await f.connector.sendMessage(request);
    await expect(
      f.connector.sendMessage({
        ...request,
        attachments: [
          { ...attachment, contentBase64: Buffer.from("%PDF-1.7\nDifferent").toString("base64") }
        ]
      })
    ).rejects.toThrow("already used");
    await expect(
      f.connector.sendMessage({
        ...request,
        quotedMessage: { id: "other", sender: null, fromMe: true, text: "Quote" }
      })
    ).rejects.toThrow("already used");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("journals outbound sends before delivery, rejects key reuse, and does not resend uncertain deliveries", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    const first = await f.connector.sendMessage(f.outbound());
    expect(await f.connector.sendMessage(f.outbound())).toEqual(first);
    expect(f.send).toHaveBeenCalledTimes(1);
    await expect(f.connector.sendMessage({ ...f.outbound(), text: "Changed" })).rejects.toThrow();
    f.send.mockRejectedValueOnce(new Error("network lost"));
    const next = { ...f.outbound(), idempotencyKey: "uncertain" };
    await expect(f.connector.sendMessage(next)).rejects.toThrow();
    await expect(f.connector.sendMessage(next)).rejects.toThrow("uncertain");
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("prevents concurrent outbound attempts from duplicating transport sends", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    const results = await Promise.allSettled([
      f.connector.sendMessage(f.outbound()),
      f.connector.sendMessage(f.outbound())
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported attachments and sends after scope removal or owner revocation", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    await expect(
      f.connector.sendMessage({
        ...f.outbound(),
        attachments: [{ filename: "x", mimeType: "image/png", contentBase64: "a" }]
      })
    ).rejects.toThrow();
    f.authorize.mockImplementation(() => {
      throw new Error("owner revoked");
    });
    await expect(f.connector.sendMessage(f.outbound())).rejects.toThrow("owner revoked");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("disconnects and deletes credentials, blocks late events, and supports the kill switch", async () => {
    const f = fixture();
    await f.connect();
    f.approve();
    await f.connector.disconnect("business-1", "owner-1");
    expect(f.logout).toHaveBeenCalledOnce();
    expect(f.vault.read("business-1")).toBeNull();
    f.events[0]!.save("stale");
    f.events[0]!.inbound(f.inbound);
    await settle();
    expect(f.receive).not.toHaveBeenCalled();
    expect(f.connector.status("business-1", "owner-1").state).toBe("DISCONNECTED");
    await f.connect();
    await f.connector.stop();
    expect(f.connector.readiness({ businessId: "business-1" }).authorized).toBe(false);
    await expect(f.connector.connect("business-1", "owner-1")).rejects.toThrow();
  });
});
