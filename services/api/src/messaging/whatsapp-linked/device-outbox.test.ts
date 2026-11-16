import { describe, expect, it } from "vitest";
import {
  claimLinkedDeviceSend,
  isLinkedDeviceOutboxEntry,
  linkedDeviceOutboxLimits,
  mergeLinkedDeviceEntry,
  newLinkedDeviceRead,
  newLinkedDeviceSend,
  parseLinkedDeviceAcks,
  prunableLinkedDeviceEntry,
  retryLinkedDeviceSend,
  settleLinkedDeviceEntry
} from "./device-outbox.js";
import {
  createLinkedDeviceChannelAdapter,
  linkedDeviceHosting,
  linkedHostRouter
} from "./device-channel-adapter.js";
import type { MessagingChannelAdapter, OutboundChannelMessage } from "../channel-gateway.js";

const t0 = new Date("2026-11-10T08:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const base = {
  businessId: "b1",
  ownerId: "u1",
  channelId: "c1",
  conversationId: "v1",
  chat: "254711000001@s.whatsapp.net",
  messageId: "m1"
};
const send = () => newLinkedDeviceSend({ ...base, idempotencyKey: "reply-1" }, t0);

describe("device outbox claim rule", () => {
  it("offers a pending send once, then waits for its acknowledgement", () => {
    const offered = claimLinkedDeviceSend(send(), "phone-a", "claim-0001", t0);
    expect(offered.action).toBe("offer");
    if (offered.action !== "offer") return;
    expect(offered.entry).toMatchObject({
      status: "claimed",
      claims: 1,
      claimedBy: "phone-a",
      claimId: "claim-0001"
    });
    expect(claimLinkedDeviceSend(offered.entry, "phone-a", "claim-0002", at(60_000))).toEqual({
      action: "wait"
    });
  });

  it("re-offers a timed-out claim only to the device whose journal can deduplicate it", () => {
    const first = claimLinkedDeviceSend(send(), "phone-a", "claim-0001", t0);
    if (first.action !== "offer") throw new Error("expected an offer");
    const later = at(linkedDeviceOutboxLimits.claimTimeoutMs);
    const again = claimLinkedDeviceSend(first.entry, "phone-a", "claim-0002", later);
    expect(again).toMatchObject({ action: "offer", entry: { claims: 2, claimId: "claim-0002" } });
    // Another phone has no record of what the first one handed to WhatsApp: never resend there.
    expect(claimLinkedDeviceSend(first.entry, "phone-b", "claim-0003", later)).toEqual({
      action: "settle",
      status: "uncertain",
      reason: "claim_lost_other_device"
    });
  });

  it("settles as uncertain after the claim budget, and as failed once expired unclaimed", () => {
    let entry = send();
    for (let claim = 0; claim < linkedDeviceOutboxLimits.maxClaims; claim += 1) {
      const decision = claimLinkedDeviceSend(
        entry,
        "phone-a",
        `claim-000${claim}`,
        at(claim * linkedDeviceOutboxLimits.claimTimeoutMs)
      );
      if (decision.action !== "offer") throw new Error("expected an offer");
      entry = decision.entry;
    }
    expect(
      claimLinkedDeviceSend(
        entry,
        "phone-a",
        "claim-9999",
        at(linkedDeviceOutboxLimits.maxClaims * linkedDeviceOutboxLimits.claimTimeoutMs)
      )
    ).toMatchObject({ action: "settle", status: "uncertain", reason: "claim_unacknowledged" });
    expect(
      claimLinkedDeviceSend(
        send(),
        "phone-a",
        "claim-0001",
        at(linkedDeviceOutboxLimits.sendExpiresAfterMs)
      )
    ).toMatchObject({ action: "settle", status: "failed", reason: "expired" });
  });

  it("backs off a failure reported before handoff and resets the claim count", () => {
    const offered = claimLinkedDeviceSend(send(), "phone-a", "claim-0001", t0);
    if (offered.action !== "offer") throw new Error("expected an offer");
    const retried = retryLinkedDeviceSend(offered.entry, t0, "CHANNEL_UNAVAILABLE");
    expect(retried).toMatchObject({ status: "pending", attempts: 1, claims: 0, claimId: null });
    expect(claimLinkedDeviceSend(retried, "phone-a", "claim-0002", at(1000))).toEqual({
      action: "wait"
    });
    expect(
      claimLinkedDeviceSend(
        retried,
        "phone-a",
        "claim-0002",
        at(linkedDeviceOutboxLimits.baseBackoffMs)
      ).action
    ).toBe("offer");
    let entry = retried;
    for (let attempt = 1; attempt < linkedDeviceOutboxLimits.maxAttempts; attempt += 1)
      entry = retryLinkedDeviceSend(entry, t0, "CHANNEL_UNAVAILABLE");
    expect(entry).toMatchObject({ status: "failed", reason: "retries_exhausted" });
  });

  it("never offers or reopens a settled entry, and prunes it after retention", () => {
    const sent = settleLinkedDeviceEntry(send(), "sent", t0, { deliveredId: "3EB0AA" });
    expect(claimLinkedDeviceSend(sent, "phone-a", "claim-0001", at(1)).action).toBe("wait");
    expect(mergeLinkedDeviceEntry(sent, send())).toBe(sent);
    expect(mergeLinkedDeviceEntry(send(), sent)).toBe(sent);
    expect(prunableLinkedDeviceEntry(sent, at(1))).toBe(false);
    expect(prunableLinkedDeviceEntry(sent, at(linkedDeviceOutboxLimits.retainSettledMs))).toBe(
      true
    );
    expect(prunableLinkedDeviceEntry(send(), at(linkedDeviceOutboxLimits.retainSettledMs))).toBe(
      false
    );
  });
});

describe("device outbox validation", () => {
  it("accepts well-formed rows only and stores no message text", () => {
    const entry = send();
    expect(isLinkedDeviceOutboxEntry(entry)).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("Karibu");
    expect(Object.keys(entry)).not.toContain("text");
    expect(isLinkedDeviceOutboxEntry({ ...entry, id: "send:other" })).toBe(false);
    expect(isLinkedDeviceOutboxEntry({ ...entry, status: "maybe" })).toBe(false);
    expect(isLinkedDeviceOutboxEntry({ ...entry, idempotencyKey: "" })).toBe(false);
    expect(isLinkedDeviceOutboxEntry({ ...entry, idempotencyKey: "k".repeat(201) })).toBe(false);
    const read = newLinkedDeviceRead(
      { ...base, providerMessageId: "3EB0BB", sender: base.chat },
      t0
    );
    expect(read.id).toBe("read:m1");
    expect(isLinkedDeviceOutboxEntry(read)).toBe(true);
    expect(isLinkedDeviceOutboxEntry({ ...read, sender: null })).toBe(false);
    expect(isLinkedDeviceOutboxEntry(null)).toBe(false);
  });

  it("parses acknowledgements strictly", () => {
    const good = { id: "send:m1", claimId: "claim-0001", outcome: "sent", deliveredId: "3EB0AA" };
    expect(parseLinkedDeviceAcks([good])).toEqual([good]);
    expect(
      parseLinkedDeviceAcks([
        {
          id: "send:m1",
          claimId: "claim-0001",
          outcome: "failed",
          code: "CHANNEL_UNAVAILABLE",
          retryable: true
        }
      ])
    ).toHaveLength(1);
    for (const bad of [
      undefined,
      [],
      [{ ...good, id: "read:m1" }],
      [{ ...good, id: "send:../x" }],
      [{ ...good, claimId: "x" }],
      [{ ...good, outcome: "maybe" }],
      [{ ...good, deliveredId: undefined }],
      [{ ...good, outcome: "failed", code: "bad code!" }],
      [{ ...good, outcome: "failed", retryable: "yes" }],
      Array.from({ length: linkedDeviceOutboxLimits.pullSends + 1 }, () => good)
    ])
      expect(parseLinkedDeviceAcks(bad)).toBeNull();
  });
});

describe("device hosting and the gateway adapter", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    host: "android",
    state: "CONNECTED",
    ownerId: "u1",
    deviceSeenAt: t0.toISOString(),
    ...overrides
  });

  it("derives available, offline and unavailable from the owner-state record", () => {
    expect(linkedDeviceHosting(record(), true, at(1000))).toEqual({
      hosted: true,
      status: "available"
    });
    expect(linkedDeviceHosting(record(), true, at(10 * 60_000)).status).toBe("offline");
    expect(linkedDeviceHosting(record({ state: "RECONNECTING" }), true, t0).status).toBe("offline");
    expect(linkedDeviceHosting(record({ state: "AUTH_REQUIRED" }), true, t0)).toEqual({
      hosted: true,
      status: "unavailable"
    });
    expect(linkedDeviceHosting(record({ host: "server" }), true, t0).hosted).toBe(false);
    expect(linkedDeviceHosting(record(), false, t0).hosted).toBe(false);
    expect(linkedDeviceHosting(undefined, true, t0).hosted).toBe(false);
  });

  it("queues text, refuses attachments, and routes per business next to a server connector", async () => {
    const queued: string[] = [];
    const device = createLinkedDeviceChannelAdapter({
      hosting: (businessId) =>
        businessId === "phone-shop"
          ? { hosted: true, status: "offline" }
          : { hosted: false, status: "unavailable" },
      queue: (request) => {
        queued.push(request.idempotencyKey);
        return `send:${request.idempotencyKey}`;
      }
    });
    const request = (businessId: string, extra: Partial<OutboundChannelMessage> = {}) =>
      ({
        businessId,
        conversationId: "v1",
        customerId: null,
        idempotencyKey: "k1",
        text: "Karibu",
        endpoint: {} as OutboundChannelMessage["endpoint"],
        ...extra
      }) as OutboundChannelMessage;
    expect(device.readiness({ businessId: "phone-shop" })).toMatchObject({
      status: "offline",
      configured: true,
      authorized: true
    });
    expect(device.readiness({ businessId: "other" })).toMatchObject({ status: "unavailable" });
    await expect(device.sendMessage(request("phone-shop"))).resolves.toEqual({
      accepted: true,
      providerMessageId: "send:k1",
      status: "queued"
    });
    await expect(
      device.sendMessage(
        request("phone-shop", {
          attachments: [{ filename: "a.pdf", mimeType: "application/pdf", contentBase64: "" }]
        })
      )
    ).rejects.toMatchObject({ code: "CHANNEL_SEND_FAILED" });
    await expect(device.sendMessage(request("phone-shop", { text: " " }))).rejects.toThrow();
    expect(queued).toEqual(["k1"]);

    const serverSends: string[] = [];
    const server: MessagingChannelAdapter = {
      provider: "whatsapp_linked",
      readiness: () => ({
        provider: "whatsapp_linked",
        capabilities: [],
        configured: true,
        authorized: true,
        status: "available",
        configurationRequirement: null
      }),
      getCapabilities: () => ["CAN_SEND"],
      sendMessage: async (message) => {
        serverSends.push(message.businessId);
        return { accepted: true, providerMessageId: "server", status: "sent" };
      }
    };
    const router = linkedHostRouter(server, device, (businessId) => businessId === "phone-shop");
    expect(router.readiness({ businessId: "phone-shop" }).status).toBe("offline");
    expect(router.readiness({ businessId: "server-shop" }).status).toBe("available");
    expect(router.executionContext?.("phone-shop").environment).toBe("android-device");
    expect(router.executionContext?.("server-shop").environment).toBe("server");
    await router.sendMessage(request("server-shop"));
    expect(serverSends).toEqual(["server-shop"]);
    expect((await router.sendMessage(request("phone-shop", { idempotencyKey: "k2" }))).status).toBe(
      "queued"
    );
  });
});
