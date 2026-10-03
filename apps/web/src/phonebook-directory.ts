import type { NetworkConnectionSummary, NetworkInviteSummary } from "@grogoni/shared-types";

import type { NetworkGraphSummary } from "./grogoni-application-shared";
import {
  destinationKey,
  devicePhonebookContactKey,
  type DevicePhonebookContact
} from "./phonebook-device-cache";

export {
  devicePhonebookContactKey,
  mergeDevicePhonebook,
  type DevicePhonebookContact
} from "./phonebook-device-cache";

/**
 * The owner's phonebook as the Phone Contacts card shows it, WhatsApp-style: requests waiting for
 * the owner, people already on Grogoni (with the connect action that fits their state), people to
 * invite, and contacts with no number or email.
 *
 * Raw numbers only exist on the device (see phonebook-device-cache.ts); the server returns hashed
 * contacts plus discovery. `syncedContactNodeIds` from a sync pairs the two.
 */

export type OnGrogoniState = "connect" | "requested" | "connected";

export interface OnGrogoniEntry {
  key: string;
  name: string;
  businessName: string | null;
  nodeId: string | null;
  connectionId: string | null;
  state: OnGrogoniState;
}

export interface InviteEntry {
  key: string;
  contact: DevicePhonebookContact;
  invited: boolean;
}

export interface PhonebookDirectory {
  requests: NetworkConnectionSummary[];
  onGrogoni: OnGrogoniEntry[];
  invite: InviteEntry[];
  unreachable: DevicePhonebookContact[];
}

export function buildPhonebookDirectory(input: {
  graph: NetworkGraphSummary | null;
  deviceContacts: DevicePhonebookContact[];
  invites: NetworkInviteSummary[];
  search?: string;
}): PhonebookDirectory {
  const query = (input.search ?? "").trim().toLowerCase();
  const matches = (name: string) => query.length === 0 || name.toLowerCase().includes(query);
  const connections = input.graph?.connections ?? [];
  const connectionByUser = new Map(
    connections.map((connection) => [connection.counterpartUserId, connection])
  );
  const nodes = input.graph?.nodes ?? [];
  const directNodeIds = new Set(nodes.filter((node) => node.degree === 1).map((node) => node.id));
  const grogoniNodeIds = new Set<string>();
  const onGrogoni: OnGrogoniEntry[] = [];
  const seenUsers = new Set<string>();

  for (const node of nodes) {
    if (node.degree !== 1 || node.grogoniUserId === null || node.grogoniUserId === undefined) continue;
    grogoniNodeIds.add(node.id);
    if (seenUsers.has(node.grogoniUserId)) continue;
    seenUsers.add(node.grogoniUserId);
    const connection = connectionByUser.get(node.grogoniUserId);
    // Their request to the owner is shown once, under requests.
    if (connection?.direction === "incoming" && connection.status === "pending") continue;
    onGrogoni.push({
      key: `node:${node.id}`,
      name: node.displayName,
      businessName: connection?.counterpartBusinessName ?? null,
      nodeId: node.id,
      connectionId: connection?.id ?? null,
      state: connectionState(connection)
    });
  }

  // Connected through someone else's phonebook: they asked, the owner accepted.
  for (const connection of connections) {
    if (seenUsers.has(connection.counterpartUserId) || connection.status !== "accepted") continue;
    seenUsers.add(connection.counterpartUserId);
    onGrogoni.push({
      key: `connection:${connection.id}`,
      name: connection.counterpartDisplayName,
      businessName: connection.counterpartBusinessName,
      nodeId: connection.nodeId,
      connectionId: connection.id,
      state: "connected"
    });
  }

  const invitedDestinations = new Set(
    input.invites
      .filter((invite) => invite.status !== "failed")
      .map((invite) => destinationKey(invite.channel, invite.destination))
  );
  const invite: InviteEntry[] = [];
  const unreachable: DevicePhonebookContact[] = [];
  const seenContacts = new Set<string>();

  for (const contact of input.deviceContacts) {
    const key = devicePhonebookContactKey(contact);
    if (seenContacts.has(key)) continue;
    seenContacts.add(key);
    // Only contacts still in the synced phonebook: a contact whose node is gone (disconnected,
    // replaced from another device) is not known to be off Grogoni, so it is not offered as an invite.
    if (contact.nodeId === null || !directNodeIds.has(contact.nodeId)) continue;
    if (grogoniNodeIds.has(contact.nodeId)) continue;
    if (!matches(contact.name)) continue;
    if (contact.phone === null && contact.email === null) {
      unreachable.push(contact);
      continue;
    }
    invite.push({
      key,
      contact,
      invited:
        (contact.phone !== null &&
          invitedDestinations.has(destinationKey("phone", contact.phone))) ||
        (contact.email !== null && invitedDestinations.has(destinationKey("email", contact.email)))
    });
  }

  const byName = <T extends { name: string }>(left: T, right: T) =>
    left.name.localeCompare(right.name);

  return {
    requests: connections.filter(
      (connection) =>
        connection.direction === "incoming" &&
        connection.status === "pending" &&
        matches(connection.counterpartDisplayName)
    ),
    onGrogoni: onGrogoni.filter((entry) => matches(entry.name)).sort(byName),
    invite: invite.sort((left, right) => left.contact.name.localeCompare(right.contact.name)),
    unreachable: unreachable.sort(byName)
  };
}

function connectionState(connection: NetworkConnectionSummary | undefined): OnGrogoniState {
  if (connection === undefined) return "connect";
  return connection.status === "accepted" ? "connected" : "requested";
}
