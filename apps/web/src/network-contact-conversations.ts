import type { ConversationInboxItem } from "@grogoni/shared-types";

import { destinationKey } from "./phonebook-device-cache";
import type { DevicePhonebookContact } from "./phonebook-device-cache";

/**
 * Starting a chat from Phone Contacts.
 *
 * Phone Contacts shows people by the name the owner saved on this device ("Mama Njeri"), while the
 * conversation inbox can only show the display name the counterpart's own account advertises
 * ("Njeri Kamau"). Without this pairing, tapping a contact in Phone Contacts and then opening
 * Message history looked like two different people.
 *
 * The server resolves each viewer's own phonebook node into the inbox participant view.
 * Private node IDs are never copied into another account's shared participant record.
 * Only an explicit contact selection/import sends raw identifiers for secure server matching.
 */

/**
 * The `recipient` that opens a conversation with a phonebook node. The server resolves the node in
 * the caller's own phonebook (never another owner's) and rejects one it cannot find.
 */
export const networkNodeRecipientPrefix = "network-node:";

export function phonebookRecipientForNode(nodeId: string): string {
  return `${networkNodeRecipientPrefix}${nodeId}`;
}

/**
 * The phonebook node a `recipient` names, or null for a phone number / email address. Only the
 * prefix is stripped; a number keeps whatever formatting the owner typed until it is normalized.
 */
export function readNodeIdFromRecipient(recipient: string): string | null {
  const trimmed = recipient.trim();
  if (!trimmed.startsWith(networkNodeRecipientPrefix)) return null;
  const nodeId = trimmed.slice(networkNodeRecipientPrefix.length).trim();
  return nodeId.length === 0 ? null : nodeId;
}

/**
 * The device contact that a phonebook node belongs to. The server returns one node id per
 * submitted contact in submission order and the device cache keeps those ids alongside the raw
 * numbers, so this is an exact match. A node the device cannot place (synced from another device,
 * or before the cache existed) returns null and the caller falls back to the advertised name.
 */
export function deviceContactForNode(
  nodeId: string,
  deviceContacts: readonly DevicePhonebookContact[]
): DevicePhonebookContact | null {
  const wanted = nodeId.trim();
  if (wanted.length === 0) return null;
  return deviceContacts.find((contact) => contact.nodeId === wanted) ?? null;
}

/**
 * The conversation between this account and a phonebook node, if one exists: matched on the
 * counterpart's node id, so a contact row offers "Message" only while there is no chat to reopen.
 * Deliberately no name fallback: two contacts can share a display name, and opening someone else's
 * chat is worse than starting a second one.
 */
export function conversationForNode(
  inbox: readonly ConversationInboxItem[],
  nodeId: string
): ConversationInboxItem | null {
  const wanted = nodeId.trim();
  if (wanted.length === 0) return null;
  return (
    inbox.find((item) => item.hasHumanRecipient && item.participant.networkNodeId === wanted) ??
    null
  );
}

/**
 * The owner's name for a conversation started from the phonebook: the saved contact name for the
 * counterpart's node, else the name the counterpart advertises. Null when neither is known, and
 * then the inbox keeps its own default title.
 */
export function contactLabelForConversation(
  inboxItem: ConversationInboxItem,
  deviceContacts: readonly DevicePhonebookContact[]
): string | null {
  const nodeId = inboxItem.participant.networkNodeId;
  if (nodeId !== null && nodeId !== undefined) {
    const named = deviceContactForNode(nodeId, deviceContacts);
    if (named !== null) return named.name;
  }
  const displayName = inboxItem.participant.displayName?.trim() ?? "";
  return displayName.length === 0 ? null : displayName;
}

/** The phone or email to open a conversation with, when the owner picked a contact directly. */
export function contactDestination(contact: DevicePhonebookContact): string | null {
  if (contact.phone !== null && contact.phone.trim().length > 0) return contact.phone.trim();
  if (contact.email !== null && contact.email.trim().length > 0) return contact.email.trim();
  return null;
}

/**
 * True when two contacts have the same complete normalized phone identity or email address.
 * International country codes are preserved; national numbers use the application's default region.
 */
export function sameContactDestination(
  left: Pick<DevicePhonebookContact, "phone" | "email">,
  right: Pick<DevicePhonebookContact, "phone" | "email">
): boolean {
  if (left.phone !== null && right.phone !== null)
    return destinationKey("phone", left.phone) === destinationKey("phone", right.phone);
  if (left.email !== null && right.email !== null)
    return destinationKey("email", left.email) === destinationKey("email", right.email);
  return false;
}
