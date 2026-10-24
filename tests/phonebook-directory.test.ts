import { describe, expect, it } from "vitest";
import type { NetworkConnectionSummary, NetworkInviteSummary } from "@grogoni/shared-types";
import {
  buildPhonebookDirectory,
  devicePhonebookContactKey,
  mergeDevicePhonebook,
  type DevicePhonebookContact
} from "../apps/web/src/phonebook-directory";
import type {
  NetworkGraphSummary,
  NetworkNodeSummary
} from "../apps/web/src/grogoni-application-shared";

const at = "2026-09-26T00:00:00.000Z";

function node(id: string, displayName: string, grogoniUserId: string | null): NetworkNodeSummary {
  return {
    id,
    displayName,
    degree: 1,
    sourceId: "phone-source",
    sourceType: "phone_contact",
    sourcePlatform: "phone",
    grogoniUserId,
    kind: grogoniUserId === null ? "external_contact" : "grogoni_user",
    visibilityStatus: "direct",
    consentStatus: "pending"
  };
}

function connection(
  overrides: Partial<NetworkConnectionSummary> &
    Pick<NetworkConnectionSummary, "id" | "counterpartUserId">
): NetworkConnectionSummary {
  return {
    status: "pending",
    direction: "outgoing",
    counterpartDisplayName: "Someone",
    counterpartBusinessName: null,
    counterpartGrogoniId: null,
    nodeId: null,
    createdAt: at,
    updatedAt: at,
    respondedAt: null,
    ...overrides
  };
}

function graph(nodes: NetworkNodeSummary[], connections: NetworkConnectionSummary[] = []) {
  return {
    ownerUserId: "owner",
    generatedAt: at,
    nodes: [{ ...node("owner-node", "You", "owner"), degree: 0 }, ...nodes],
    edges: [],
    sources: [],
    routes: [],
    connections
  } as NetworkGraphSummary;
}

function contact(
  name: string,
  phone: string | null,
  nodeId: string | null,
  email: string | null = null
) {
  return { name, phone, email, nodeId } satisfies DevicePhonebookContact;
}

describe("phonebook directory", () => {
  it("groups requests, on-Grogoni contacts by connection state, invites, and unreachable contacts", () => {
    const directory = buildPhonebookDirectory({
      graph: graph(
        [
          node("n-bob", "Bob", "u-bob"),
          node("n-carol", "Carol", "u-carol"),
          node("n-dan", "Dan", "u-dan"),
          node("n-eve", "Eve", "u-eve"),
          node("n-frank", "Frank", null),
          node("n-hana", "Hana", null),
          node("n-none", "No Number", null)
        ],
        [
          connection({ id: "c-carol", counterpartUserId: "u-carol", status: "pending" }),
          connection({ id: "c-dan", counterpartUserId: "u-dan", status: "accepted" }),
          connection({
            id: "c-eve",
            counterpartUserId: "u-eve",
            direction: "incoming",
            counterpartDisplayName: "Eve"
          }),
          // Connected through their phonebook, not ours.
          connection({
            id: "c-gina",
            counterpartUserId: "u-gina",
            direction: "incoming",
            status: "accepted",
            counterpartDisplayName: "Gina",
            counterpartBusinessName: "Gina Hardware"
          })
        ]
      ),
      deviceContacts: [
        contact("Bob", "+254711000002", "n-bob"),
        contact("Frank", "+254722000101", "n-frank"),
        contact("Hana", null, "n-hana", "hana@example.com"),
        contact("No Number", null, "n-none"),
        // Its node is gone (disconnected, or replaced from another device): not offered.
        contact("Gone", "+254722000999", "n-gone"),
        contact("Never synced", "+254722000998", null)
      ],
      invites: []
    });

    expect(directory.requests.map((request) => request.id)).toEqual(["c-eve"]);
    expect(
      directory.onGrogoni.map((entry) => [entry.name, entry.state, entry.connectionId])
    ).toEqual([
      ["Bob", "connect", null],
      ["Carol", "requested", "c-carol"],
      ["Dan", "connected", "c-dan"],
      ["Gina", "connected", "c-gina"]
    ]);
    // Eve's pending request is shown once, under requests, not again under On Grogoni.
    expect(directory.onGrogoni.some((entry) => entry.name === "Eve")).toBe(false);
    // Bob is on Grogoni: never offered as an invite.
    expect(directory.invite.map((entry) => entry.contact.name)).toEqual(["Frank", "Hana"]);
    expect(directory.unreachable.map((entry) => entry.name)).toEqual(["No Number"]);
  });

  it("marks already-invited contacts across phone formats, ignoring failed invites", () => {
    const invites: NetworkInviteSummary[] = [
      {
        id: "i1",
        businessId: "b",
        invitedByUserId: "owner",
        contactName: "Frank",
        channel: "phone",
        destination: "0722 000 101",
        status: "sent",
        createdAt: at,
        deliveredAt: at,
        failureReason: null
      },
      {
        id: "i2",
        businessId: "b",
        invitedByUserId: "owner",
        contactName: "Hana",
        channel: "email",
        destination: "hana@example.com",
        status: "failed",
        createdAt: at,
        deliveredAt: null,
        failureReason: "bounced"
      }
    ];
    const directory = buildPhonebookDirectory({
      graph: graph([node("n-f", "Frank", null), node("n-h", "Hana", null)]),
      deviceContacts: [
        contact("Frank", "+254722000101", "n-f"),
        contact("Hana", null, "n-h", "HANA@example.com")
      ],
      invites
    });

    expect(directory.invite.map((entry) => [entry.contact.name, entry.invited])).toEqual([
      ["Frank", true],
      ["Hana", false]
    ]);
  });

  it("filters every section by search and dedupes one person synced from two sources", () => {
    const directory = buildPhonebookDirectory({
      graph: graph([
        node("n-1", "Bob Phone", "u-bob"),
        node("n-2", "Bob Google", "u-bob"),
        node("n-f", "Frank", null)
      ]),
      deviceContacts: [contact("Frank", "+254722000101", "n-f")],
      invites: [],
      search: "bob"
    });

    expect(directory.onGrogoni).toHaveLength(1);
    expect(directory.invite).toEqual([]);
  });

  it("merges picker selections on the device instead of replacing them", () => {
    const merged = mergeDevicePhonebook(
      [contact("Frank", "+254722000101", "n-1"), contact("Hana", null, null, "hana@example.com")],
      [contact("Frank Otieno", "0722000101", "n-9"), contact("Ivy", "+254733000000", "n-3")]
    );

    expect(merged.map((entry) => [entry.name, entry.nodeId])).toEqual([
      ["Frank Otieno", "n-9"],
      ["Hana", null],
      ["Ivy", "n-3"]
    ]);
    expect(devicePhonebookContactKey(contact("A", null, null))).toBe("name:a");
  });
  it("does not merge international numbers that share a nine-digit suffix", () => {
    const merged = mergeDevicePhonebook(
      [],
      [contact("US", "+12025550123", "us"), contact("UK", "+442025550123", "uk")]
    );
    expect(merged).toHaveLength(2);
  });
});
