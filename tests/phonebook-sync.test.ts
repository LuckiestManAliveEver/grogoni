import { describe, expect, it, vi } from "vitest";

import {
  browserDefaultCountry,
  contactPickerContactToSyncContact,
  describeInviteOutcome,
  inviteBatchSize,
  phonebookSyncBatchSize,
  sendInvitesInBatches,
  syncPhonebookInBatches,
  type PhonebookSyncContact
} from "../apps/web/src/phonebook-sync";
import type { NetworkGraphSummary } from "../apps/web/src/grogoni-application-shared";
import { parseVcardContacts } from "../apps/web/src/phonebook-vcard";

const at = "2026-09-26T00:00:00.000Z";

function contacts(count: number): PhonebookSyncContact[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Contact ${index}`,
    phone: `07${String(index).padStart(8, "0")}`,
    email: null,
    phones: [`07${String(index).padStart(8, "0")}`],
    emails: []
  }));
}

function graphFor(body: Record<string, unknown>): NetworkGraphSummary {
  const sent = body.contacts as PhonebookSyncContact[];
  return {
    ownerUserId: "owner",
    generatedAt: at,
    nodes: [],
    edges: [],
    sources: [],
    routes: [],
    syncedContactNodeIds: sent.map((contact) => `node:${contact.name}`)
  };
}

describe("contact picker conversion", () => {
  it("keeps every number and email, and falls back to a number for the name", () => {
    expect(
      contactPickerContactToSyncContact({
        name: [" Wanjiru "],
        tel: ["0722 000 101", "", "0733 000 202", "0722 000 101"],
        email: ["w@example.com"]
      })
    ).toEqual({
      name: "Wanjiru",
      phone: "0722 000 101",
      email: "w@example.com",
      phones: ["0722 000 101", "0733 000 202"],
      emails: ["w@example.com"]
    });
    expect(contactPickerContactToSyncContact({ tel: ["0722000101"] })?.name).toBe("0722000101");
    expect(contactPickerContactToSyncContact({ name: [""], tel: [] })).toBeNull();
  });
});

describe("device region", () => {
  it("reads the region from the browser language, defaulting to Kenya", () => {
    expect(browserDefaultCountry("en-UG")).toBe("UG");
    expect(browserDefaultCountry("sw-ke")).toBe("KE");
    expect(browserDefaultCountry("en")).toBe("KE");
    expect(browserDefaultCountry("zh-Hant-TW")).toBe("KE");
    expect(browserDefaultCountry("")).toBe("KE");
  });
});

describe("phonebook sync batching", () => {
  it("splits a large phonebook into server-sized merge batches and keeps node ids in order", async () => {
    const post = vi.fn(async (body: Record<string, unknown>) => graphFor(body));
    const all = contacts(phonebookSyncBatchSize * 2 + 1);

    const result = await syncPhonebookInBatches(post, all, "KE");

    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.map(([body]) => (body.contacts as unknown[]).length)).toEqual([
      phonebookSyncBatchSize,
      phonebookSyncBatchSize,
      1
    ]);
    expect(post.mock.calls.every(([body]) => body.mode === "merge")).toBe(true);
    expect(post.mock.calls.every(([body]) => body.defaultCountry === "KE")).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodeIds).toHaveLength(all.length);
    expect(result.nodeIds.at(-1)).toBe(`node:${all.at(-1)!.name}`);
  });

  it("stops at a failed batch and reports exactly what was synced before it", async () => {
    const failure = new Error("offline");
    const post = vi
      .fn()
      .mockImplementationOnce(async (body: Record<string, unknown>) => graphFor(body))
      .mockRejectedValueOnce(failure);

    const result = await syncPhonebookInBatches(post, contacts(phonebookSyncBatchSize + 10));

    expect(result.error).toBe(failure);
    expect(result.nodeIds).toHaveLength(phonebookSyncBatchSize);
    expect(result.graph).not.toBeNull();
  });

  it("reports a first-batch failure with no graph", async () => {
    const result = await syncPhonebookInBatches(
      vi.fn().mockRejectedValue(new Error("x")),
      contacts(1)
    );
    expect(result).toMatchObject({ graph: null, nodeIds: [] });
  });
});

describe("invite batching and messages", () => {
  it("sends invites 100 at a time and adds up the results", async () => {
    const post = vi.fn(async (batch: Array<{ name: string }>) => ({
      invites: batch.slice(1).map((_, index) => ({ id: `i${index}`, status: "sent" as const })),
      alreadyOnGrogoniCount: 1,
      invalidCount: 2
    }));

    const outcome = await sendInvitesInBatches(
      post,
      Array.from({ length: inviteBatchSize * 2 + 5 }, (_, index) => ({
        name: `C${index}`,
        phone: `+2547220${String(index).padStart(5, "0")}`,
        email: null
      }))
    );

    expect(post.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5]);
    expect(outcome).toEqual({ invited: 202, alreadyOnGrogoni: 3, invalid: 6, shared: false });
  });

  it("says what actually happened", () => {
    expect(
      describeInviteOutcome({ invited: 2, alreadyOnGrogoni: 0, invalid: 0, shared: false })
    ).toBe("2 invites sent.");
    expect(
      describeInviteOutcome({ invited: 1, alreadyOnGrogoni: 1, invalid: 0, shared: false })
    ).toBe("1 invite sent. 1 is already on Grogoni: connect with them instead.");
    expect(
      describeInviteOutcome({ invited: 0, alreadyOnGrogoni: 2, invalid: 0, shared: false })
    ).toBe("Nobody to invite. 2 are already on Grogoni: connect with them instead.");
    expect(
      describeInviteOutcome({ invited: 0, alreadyOnGrogoni: 0, invalid: 0, shared: true })
    ).toBe("Share the invite link with the people you picked.");
    expect(
      describeInviteOutcome({ invited: 0, alreadyOnGrogoni: 0, invalid: 0, shared: false })
    ).toBe("No invites were sent.");
    expect(
      describeInviteOutcome({ invited: 1, alreadyOnGrogoni: 0, invalid: 2, shared: false })
    ).toBe("1 invite sent. 2 had no number or email Grogoni could read.");
  });
});

describe("vCard import", () => {
  it("keeps every number and email per card, including grouped and folded properties", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Wanjiru Kamau",
      "TEL;TYPE=CELL:0722 000 101",
      "item1.TEL;TYPE=WORK:0733 000 202",
      "EMAIL;TYPE=INTERNET:w@example.com",
      "END:VCARD",
      "BEGIN:VCARD",
      "N:Otieno;Brian;;;",
      "TEL:+254 711",
      " 000 002",
      "END:VCARD"
    ].join("\r\n");

    expect(parseVcardContacts(vcf)).toEqual([
      {
        name: ["Wanjiru Kamau"],
        tel: ["0722 000 101", "0733 000 202"],
        email: ["w@example.com"]
      },
      { name: ["Brian Otieno"], tel: ["+254 711000 002"], email: [] }
    ]);
    expect(parseVcardContacts("name,phone\nA,0722")).toBeNull();
  });
});
