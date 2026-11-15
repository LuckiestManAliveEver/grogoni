import { describe, expect, it } from "vitest";
import {
  batchLinkedReadReceipts,
  dispatchLinkedReadReceipts,
  linkedReadReceiptLimits,
  linkedReadReceiptMessageKeys,
  type LinkedReadReceiptEntry
} from "./read-receipts.js";
import {
  isLinkedOwnerStateRecord,
  mergeLinkedOwnerChange,
  newLinkedOwnerStateRecord,
  type LinkedOwnerChange
} from "./owner-transfer.js";

const contact = "254711111111@s.whatsapp.net";
const entry = (index: number, chat = contact): LinkedReadReceiptEntry => ({
  messageId: `m${index}`,
  businessId: "b",
  ownerId: "o",
  channelId: "c",
  chat,
  sender: contact,
  providerMessageId: `P${index}`,
  queuedAt: new Date(Date.UTC(2026, 10, 9, 0, 0, index)).toISOString()
});

describe("read receipt keys and batches", () => {
  it("never produces a key for our own messages or an unapproved address form", () => {
    expect(
      linkedReadReceiptMessageKeys("status@broadcast", [{ id: "A", sender: contact }])
    ).toEqual([]);
    expect(linkedReadReceiptMessageKeys(contact, [{ id: "A", sender: "123@g.us" }])).toEqual([]);
    expect(linkedReadReceiptMessageKeys(contact, [{ id: "A", sender: contact }])).toEqual([
      { remoteJid: contact, id: "A", fromMe: false }
    ]);
  });

  it("groups per chat, oldest first, at most 100 keys per batch", () => {
    const entries = [
      ...Array.from({ length: 250 }, (_, index) => entry(index)),
      entry(999, "123456789@g.us")
    ].reverse();
    const batches = batchLinkedReadReceipts(entries);
    expect(batches.map((batch) => [batch.chat, batch.keys.length])).toEqual([
      [contact, 100],
      [contact, 100],
      [contact, 50],
      ["123456789@g.us", 1]
    ]);
    expect(batches[0]!.keys[0]).toEqual({ id: "P0", sender: contact });
    expect(linkedReadReceiptLimits.maxKeysPerBatch).toBe(100);
  });

  it("never throws, even when the queue does", async () => {
    const result = await dispatchLinkedReadReceipts(
      {
        takeLinkedReadReceipts: () => {
          throw new Error("store unavailable");
        }
      },
      { approved: () => true, markRead: async () => 1 },
      "b",
      "o"
    );
    expect(result).toEqual({ sent: 0, failed: 0 });
  });
});

describe("owner-state records", () => {
  const change: LinkedOwnerChange = {
    previousOwnerId: "former",
    detectedAt: "2026-11-09T00:00:00.000Z",
    channelsDetached: 2,
    grantsRevoked: 1,
    resultsSuppressed: 0,
    readReceiptsDropped: 3
  };

  it("keeps the first detection and adds later counts", () => {
    expect(mergeLinkedOwnerChange(null, change)).toBe(change);
    expect(
      mergeLinkedOwnerChange(change, {
        ...change,
        previousOwnerId: "other",
        detectedAt: "2026-11-10T00:00:00.000Z",
        channelsDetached: 1
      })
    ).toEqual({ ...change, channelsDetached: 3, grantsRevoked: 2, readReceiptsDropped: 6 });
  });

  it("accepts well-formed rows and ignores malformed ones", () => {
    const record = newLinkedOwnerStateRecord("business", new Date("2026-11-09T00:00:00.000Z"));
    expect(isLinkedOwnerStateRecord(record)).toBe(true);
    expect(isLinkedOwnerStateRecord({ ...record, ownerChange: change })).toBe(true);
    expect(isLinkedOwnerStateRecord(null)).toBe(false);
    expect(isLinkedOwnerStateRecord({ ...record, id: "other" })).toBe(false);
    expect(isLinkedOwnerStateRecord({ ...record, ownerId: 7 })).toBe(false);
    expect(isLinkedOwnerStateRecord({ ...record, updatedAt: "soon" })).toBe(false);
    expect(
      isLinkedOwnerStateRecord({ ...record, ownerChange: { ...change, grantsRevoked: -1 } })
    ).toBe(false);
    expect(
      isLinkedOwnerStateRecord({ ...record, ownerChange: { ...change, previousOwnerId: null } })
    ).toBe(false);
  });
});
