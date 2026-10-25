import { describe, expect, it } from "vitest";

import type { ConversationInboxItem } from "@grogoni/shared-types";

import {
  contactDestination,
  contactLabelForConversation,
  conversationForNode,
  deviceContactForNode,
  phonebookRecipientForNode,
  readNodeIdFromRecipient,
  sameContactDestination
} from "../apps/web/src/network-contact-conversations";
import type { DevicePhonebookContact } from "../apps/web/src/phonebook-device-cache";

const mamaNjeri: DevicePhonebookContact = {
  name: "Mama Njeri",
  phone: "+254 722 000 101",
  email: null,
  nodeId: "node-mama-njeri"
};
const otieno: DevicePhonebookContact = {
  name: "Otieno",
  phone: null,
  email: "otieno@example.com",
  nodeId: "node-otieno"
};
const unsynced: DevicePhonebookContact = {
  name: "Unsynced contact",
  phone: "+254 733 000 202",
  email: null,
  nodeId: null
};
const deviceContacts = [mamaNjeri, otieno, unsynced];

function inboxItem(input: {
  id: string;
  networkNodeId?: string | null;
  displayName?: string | null;
  hasHumanRecipient?: boolean;
}): ConversationInboxItem {
  return {
    id: input.id,
    kind: "personal",
    activeShopId: null,
    title: null,
    updatedAt: "2026-09-26T00:00:00.000Z",
    createdAt: "2026-09-26T00:00:00.000Z",
    unreadCount: 0,
    lastMessage: null,
    hasHumanRecipient: input.hasHumanRecipient ?? true,
    participant: {
      id: `participant-${input.id}`,
      conversationId: input.id,
      role: "account",
      accountId: "account-other",
      businessId: null,
      agentId: null,
      networkNodeId: input.networkNodeId ?? null,
      displayName: input.displayName ?? null,
      createdAt: "2026-09-26T00:00:00.000Z"
    }
  };
}

describe("phonebook conversation recipients", () => {
  it("round-trips a node id through the recipient the server accepts", () => {
    const recipient = phonebookRecipientForNode("node-mama-njeri");
    expect(recipient).toBe("network-node:node-mama-njeri");
    expect(readNodeIdFromRecipient(recipient)).toBe("node-mama-njeri");
    // Whitespace from a copied value is tolerated, the node itself is not altered.
    expect(readNodeIdFromRecipient("  network-node: node-mama-njeri ")).toBe("node-mama-njeri");
  });

  it("leaves numbers and email addresses alone, and rejects an empty node", () => {
    expect(readNodeIdFromRecipient("+254 722 000 101")).toBeNull();
    expect(readNodeIdFromRecipient("mama@example.com")).toBeNull();
    expect(readNodeIdFromRecipient("network-node:")).toBeNull();
    expect(readNodeIdFromRecipient("network-node:   ")).toBeNull();
    expect(readNodeIdFromRecipient("")).toBeNull();
  });
});

describe("pairing a contact with its conversation", () => {
  it("finds the device contact behind a node id, but never by name", () => {
    expect(deviceContactForNode("node-mama-njeri", deviceContacts)).toBe(mamaNjeri);
    expect(deviceContactForNode(" node-otieno ", deviceContacts)).toBe(otieno);
    // A node the device cannot place is null, not the nearest name.
    expect(deviceContactForNode("node-elsewhere", deviceContacts)).toBeNull();
    expect(deviceContactForNode("", deviceContacts)).toBeNull();
  });

  it("matches the chat the counterpart's participant marks with the node id", () => {
    const inbox = [
      inboxItem({ id: "conversation-mama", networkNodeId: "node-mama-njeri" }),
      // Someone else's chat, whose advertised name happens to match a device contact.
      inboxItem({
        id: "conversation-namesake",
        networkNodeId: "node-namesake",
        displayName: "Otieno"
      })
    ];
    expect(conversationForNode(inbox, "node-mama-njeri")?.id).toBe("conversation-mama");
    expect(conversationForNode(inbox, "node-otieno")).toBeNull();
  });

  it("ignores a shop conversation that carries no human recipient", () => {
    const inbox = [
      inboxItem({
        id: "conversation-storefront",
        networkNodeId: "node-mama-njeri",
        hasHumanRecipient: false
      })
    ];
    expect(conversationForNode(inbox, "node-mama-njeri")).toBeNull();
  });

  it("shows the owner's saved name, falling back to the advertised one", () => {
    const named = inboxItem({
      id: "conversation-mama",
      networkNodeId: "node-mama-njeri",
      displayName: "Njeri Kamau"
    });
    expect(contactLabelForConversation(named, deviceContacts)).toBe("Mama Njeri");

    // The node predates this device's cache: the counterpart's own name is still better than none.
    const unplaced = inboxItem({
      id: "conversation-moved",
      networkNodeId: "node-from-another-device",
      displayName: "  Njeri Kamau  "
    });
    expect(contactLabelForConversation(unplaced, deviceContacts)).toBe("Njeri Kamau");

    // A chat started from a number rather than a contact keeps its display name.
    const byNumber = inboxItem({ id: "conversation-number", displayName: "Njeri Kamau" });
    expect(contactLabelForConversation(byNumber, deviceContacts)).toBe("Njeri Kamau");

    // Nothing known: the inbox keeps its own default title.
    expect(contactLabelForConversation(inboxItem({ id: "conversation-blank" }), [])).toBeNull();
    expect(
      contactLabelForConversation(
        inboxItem({ id: "conversation-blank-name", displayName: "   " }),
        []
      )
    ).toBeNull();
  });
});

describe("contact destinations", () => {
  it("prefers a number, then an address, and gives up on anything else", () => {
    expect(contactDestination(mamaNjeri)).toBe("+254 722 000 101");
    expect(contactDestination(otieno)).toBe("otieno@example.com");
    expect(contactDestination(unsynced)).toBe("+254 733 000 202");
    expect(contactDestination({ ...mamaNjeri, phone: "  " })).toBeNull();
    expect(
      contactDestination({ name: "Nothing", phone: null, email: null, nodeId: null })
    ).toBeNull();
  });

  it("treats the same person's differently formatted number as one destination", () => {
    expect(
      sameContactDestination(
        { phone: "+254 722 000 101", email: null },
        { phone: "0722 000 101", email: null }
      )
    ).toBe(true);
    // Different numbers never collide just because both sides have a number.
    expect(
      sameContactDestination(
        { phone: "+254 722 000 101", email: null },
        { phone: "+254 722 000 999", email: null }
      )
    ).toBe(false);
    // Email addresses compare case-insensitively.
    expect(
      sameContactDestination(
        { phone: null, email: "Otieno@Example.com" },
        { phone: null, email: "otieno@example.com" }
      )
    ).toBe(true);
    // One side having only an address and the other only a number is not a match.
    expect(
      sameContactDestination(
        { phone: "+254 722 000 101", email: null },
        { phone: null, email: "otieno@example.com" }
      )
    ).toBe(false);
  });
});
