/**
 * Grogoni-user-to-Grogoni-user connections discovered through the phonebook. Owned by NetworkDomain
 * (store.ts), which injects the maps this reads. A connection can only be requested from one of
 * the requester's own phonebook nodes that auto-linked to another Grogoni account, so asking to
 * connect requires already holding that person's number or email.
 *
 * One record per pair of users, whoever asked first is the requester:
 * - request when the other side already asked you: accepts theirs (mutual intent).
 * - request when you already asked, or are already connected: returns the existing record.
 * - decline is private: nothing the requester can read changes (status stays "pending",
 *   `updatedAt` is not bumped), and the recipient no longer sees the request, so the recipient can
 *   still connect later by requesting (which accepts it).
 * - cancelling an unanswered request withdraws it (`requesterWithdrawnAt`): hidden from both
 *   sides, record kept. Asking again un-hides the same record, so cancel-and-ask cannot re-send a
 *   declined request, and behaves identically whether or not the recipient had declined.
 * - once withdrawn, the other side asking starts a fresh request in their direction: the original
 *   requester withdrew, so it is not consent.
 * - removing an accepted connection deletes it; either side can.
 * - the recipient removing a pending request is a decline.
 */
import { randomUUID } from "node:crypto";
import type {
  BusinessSummary,
  MembershipSummary,
  NetworkConnectionRecord,
  NetworkConnectionSummary,
  NetworkNodeSummary,
  UserSummary
} from "@grogoni/shared-types";
import { contactIsBlocked } from "./shared.js";
import { Cp2Error } from "../../cp2-error.js";

export const maxPendingOutgoingConnections = 100;

export interface NetworkConnectionDeps {
  connections: Map<string, NetworkConnectionRecord>;
  networkNodes: Map<string, NetworkNodeSummary>;
  users: Map<string, UserSummary>;
  memberships: Map<string, MembershipSummary>;
  businesses: Map<string, BusinessSummary>;
  maxPendingOutgoing?: number;
  recordAuditEvent?: (event: {
    type: string;
    actorId: string;
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
}

export function requestNetworkConnection(
  deps: NetworkConnectionDeps,
  input: { userId: string; nodeId: string; now: Date }
): NetworkConnectionSummary {
  const node = deps.networkNodes.get(input.nodeId);

  if (node === undefined || node.ownerUserId !== input.userId || node.degree !== 1) {
    throw new Cp2Error(404, "network_node_not_found", "Contact was not found in your network.");
  }

  const targetUserId = node.grogoniUserId;

  if (targetUserId === null) {
    throw new Cp2Error(
      409,
      "network_contact_not_on_grogoni",
      "This contact is not on Grogoni yet. Invite them instead."
    );
  }

  // Defense in depth: discovery never links the owner's own number (findGrogoniIdentityLink), so
  // this and the users check below only fire if a node was linked some other way.
  if (targetUserId === input.userId) {
    throw new Cp2Error(409, "network_connection_self", "You cannot connect with yourself.");
  }

  if (
    !deps.users.has(targetUserId) ||
    deps.users.get(targetUserId)?.contactDiscoveryEnabled === false ||
    contactIsBlocked(deps.users, input.userId, targetUserId)
  ) {
    throw new Cp2Error(
      409,
      "network_contact_not_on_grogoni",
      "This contact is not on Grogoni yet. Invite them instead."
    );
  }

  const existing = findConnectionBetween(deps.connections, input.userId, targetUserId);
  const at = input.now.toISOString();

  if (existing !== null) {
    if (existing.status === "accepted") {
      return summarizeConnection(deps, existing, input.userId);
    }

    const withdrawn = existing.requesterWithdrawnAt != null;

    if (existing.requesterUserId === input.userId) {
      if (!withdrawn) return summarizeConnection(deps, existing, input.userId);
      assertBelowPendingLimit(deps, input.userId);
      // Asking again after cancelling: the same request is shown again (to the recipient only if
      // they have not answered it). Nothing observable depends on whether they had declined.
      const restored: NetworkConnectionRecord = { ...existing, requesterWithdrawnAt: null };
      deps.connections.set(restored.id, restored);
      return summarizeConnection(deps, restored, input.userId);
    }

    if (withdrawn) {
      assertBelowPendingLimit(deps, input.userId);
      // The first requester cancelled, so the other side asking is a new request of its own.
      const reversed: NetworkConnectionRecord = {
        ...existing,
        requesterUserId: input.userId,
        recipientUserId: targetUserId,
        status: "pending",
        createdAt: at,
        updatedAt: at,
        respondedAt: null,
        requesterWithdrawnAt: null
      };
      deps.connections.set(reversed.id, reversed);
      audit(deps, "network.connection_requested", input.userId, reversed, at, {});
      return summarizeConnection(deps, reversed, input.userId);
    }

    // The other side asked first (pending, or declined by this user earlier): asking back is
    // consent from both sides.
    const accepted: NetworkConnectionRecord = {
      ...existing,
      status: "accepted",
      updatedAt: at,
      respondedAt: at,
      requesterWithdrawnAt: null
    };
    deps.connections.set(accepted.id, accepted);
    audit(deps, "network.connection_accepted", input.userId, accepted, at, { via: "mutual" });
    return summarizeConnection(deps, accepted, input.userId);
  }

  assertBelowPendingLimit(deps, input.userId);

  const created: NetworkConnectionRecord = {
    id: randomUUID(),
    requesterUserId: input.userId,
    recipientUserId: targetUserId,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    respondedAt: null
  };
  deps.connections.set(created.id, created);
  audit(deps, "network.connection_requested", input.userId, created, at, {});
  return summarizeConnection(deps, created, input.userId);
}

export function respondToNetworkConnection(
  deps: NetworkConnectionDeps,
  input: { userId: string; connectionId: string; accept: boolean; now: Date }
): NetworkConnectionSummary | null {
  const connection = deps.connections.get(input.connectionId);

  // Declined and withdrawn requests are invisible to the recipient, so "not found" here too.
  if (
    connection === undefined ||
    connection.recipientUserId !== input.userId ||
    !isVisibleTo(connection, input.userId) ||
    contactIsBlocked(deps.users, connection.requesterUserId, connection.recipientUserId)
  ) {
    throw new Cp2Error(404, "network_connection_not_found", "Connection request was not found.");
  }

  if (connection.status === "accepted") {
    if (input.accept) return summarizeConnection(deps, connection, input.userId);
    throw new Cp2Error(
      409,
      "network_connection_already_accepted",
      "You are already connected. Remove the connection instead."
    );
  }

  const at = input.now.toISOString();
  const updated: NetworkConnectionRecord = input.accept
    ? { ...connection, status: "accepted", updatedAt: at, respondedAt: at }
    : // updatedAt stays: the requester reads it, and a decline must not be observable.
      { ...connection, status: "declined", respondedAt: at };
  deps.connections.set(updated.id, updated);
  audit(
    deps,
    input.accept ? "network.connection_accepted" : "network.connection_declined",
    input.userId,
    updated,
    at,
    { via: "response" }
  );
  return input.accept ? summarizeConnection(deps, updated, input.userId) : null;
}

export function removeNetworkConnection(
  deps: NetworkConnectionDeps,
  input: { userId: string; connectionId: string; now: Date }
): void {
  const connection = deps.connections.get(input.connectionId);

  if (connection === undefined || !isVisibleTo(connection, input.userId)) {
    throw new Cp2Error(404, "network_connection_not_found", "Connection was not found.");
  }

  if (connection.status === "accepted") {
    deps.connections.delete(connection.id);
  } else if (connection.requesterUserId === input.userId) {
    deps.connections.set(connection.id, {
      ...connection,
      requesterWithdrawnAt: input.now.toISOString()
    });
  } else {
    respondToNetworkConnection(deps, { ...input, accept: false });
    return;
  }
  audit(deps, "network.connection_removed", input.userId, connection, input.now.toISOString(), {
    previousStatus: connection.status
  });
}

/** How one party sees one connection, or null when it is not visible to them. */
export function summarizeConnectionFor(
  deps: NetworkConnectionDeps,
  connectionId: string,
  viewerUserId: string
): NetworkConnectionSummary | null {
  const connection = deps.connections.get(connectionId);
  if (
    connection === undefined ||
    !isVisibleTo(connection, viewerUserId) ||
    contactIsBlocked(deps.users, connection.requesterUserId, connection.recipientUserId)
  )
    return null;
  if (!deps.users.has(counterpartOf(connection, viewerUserId))) return null;
  return summarizeConnection(deps, connection, viewerUserId);
}

export function listNetworkConnections(
  deps: NetworkConnectionDeps,
  userId: string
): NetworkConnectionSummary[] {
  const phonebookNodes = phonebookNodesByUser(deps, userId);
  const businessByUser = primaryBusinessByUser(deps);
  return [...deps.connections.values()]
    .filter(
      (connection) =>
        isVisibleTo(connection, userId) &&
        !contactIsBlocked(deps.users, connection.requesterUserId, connection.recipientUserId)
    )
    .filter((connection) => deps.users.has(counterpartOf(connection, userId)))
    .map((connection) =>
      summarizeConnection(deps, connection, userId, phonebookNodes, businessByUser)
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Every path that makes a request of this user's visible (new, re-asked after a cancel, or asked
 * back after the other side cancelled) goes through this cap.
 */
function assertBelowPendingLimit(deps: NetworkConnectionDeps, userId: string): void {
  // What the requester sees as waiting: unanswered or declined, and not cancelled.
  const pendingOutgoing = [...deps.connections.values()].filter(
    (connection) =>
      connection.requesterUserId === userId &&
      connection.status !== "accepted" &&
      isVisibleTo(connection, userId)
  ).length;
  const limit = deps.maxPendingOutgoing ?? maxPendingOutgoingConnections;

  if (pendingOutgoing >= limit) {
    throw new Cp2Error(
      429,
      "network_connection_limit",
      `You have ${limit} unanswered connection requests. Wait for replies or cancel some first.`
    );
  }
}

function isVisibleTo(connection: NetworkConnectionRecord, userId: string): boolean {
  if (connection.status === "accepted") {
    return connection.requesterUserId === userId || connection.recipientUserId === userId;
  }
  if (connection.requesterWithdrawnAt != null) return false;
  if (connection.requesterUserId === userId) return true;
  return connection.recipientUserId === userId && connection.status === "pending";
}

/** The viewer's direct contacts, by the Grogoni user each one is linked to. */
function phonebookNodesByUser(
  deps: NetworkConnectionDeps,
  viewerUserId: string
): Map<string, NetworkNodeSummary> {
  const nodes = new Map<string, NetworkNodeSummary>();
  for (const node of deps.networkNodes.values()) {
    if (
      node.ownerUserId === viewerUserId &&
      node.degree === 1 &&
      node.grogoniUserId !== null &&
      !nodes.has(node.grogoniUserId)
    ) {
      nodes.set(node.grogoniUserId, node);
    }
  }
  return nodes;
}

function summarizeConnection(
  deps: NetworkConnectionDeps,
  connection: NetworkConnectionRecord,
  viewerUserId: string,
  phonebookNodes = phonebookNodesByUser(deps, viewerUserId),
  businessByUser?: Map<string, BusinessSummary>
): NetworkConnectionSummary {
  const direction = connection.requesterUserId === viewerUserId ? "outgoing" : "incoming";
  const counterpartUserId = counterpartOf(connection, viewerUserId);
  const counterpart = deps.users.get(counterpartUserId);
  const phonebookNode = phonebookNodes.get(counterpartUserId);
  // Someone's shop is shown once you are connected, or when they asked you (they chose to be
  // seen). Holding their number, or asking them, does not reveal which shop is theirs.
  const business =
    connection.status === "accepted" || direction === "incoming"
      ? (businessByUser ?? primaryBusinessByUser(deps)).get(counterpartUserId)
      : undefined;

  return {
    id: connection.id,
    status:
      direction === "outgoing" && connection.status === "declined" ? "pending" : connection.status,
    direction,
    counterpartUserId,
    // The viewer's own name for this person wins; otherwise the name they chose on Grogoni.
    counterpartDisplayName:
      phonebookNode?.displayName ?? counterpart?.displayName ?? "Grogoni user",
    counterpartBusinessName: business?.name ?? null,
    counterpartGrogoniId: business?.grogoniId ?? null,
    nodeId: phonebookNode?.id ?? null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    respondedAt:
      direction === "outgoing" && connection.status === "declined" ? null : connection.respondedAt
  };
}

function findConnectionBetween(
  connections: Map<string, NetworkConnectionRecord>,
  leftUserId: string,
  rightUserId: string
): NetworkConnectionRecord | null {
  for (const connection of connections.values()) {
    if (
      (connection.requesterUserId === leftUserId && connection.recipientUserId === rightUserId) ||
      (connection.requesterUserId === rightUserId && connection.recipientUserId === leftUserId)
    ) {
      return connection;
    }
  }
  return null;
}

function counterpartOf(connection: NetworkConnectionRecord, viewerUserId: string): string {
  return connection.requesterUserId === viewerUserId
    ? connection.recipientUserId
    : connection.requesterUserId;
}

/**
 * Each user's primary shop (their first membership whose business exists), from one pass over
 * memberships.
 */
export function primaryBusinessByUser(deps: {
  memberships: Map<string, MembershipSummary>;
  businesses: Map<string, BusinessSummary>;
}): Map<string, BusinessSummary> {
  const byUser = new Map<string, BusinessSummary>();
  for (const membership of deps.memberships.values()) {
    if (byUser.has(membership.userId)) continue;
    const business = deps.businesses.get(membership.businessId);
    if (business !== undefined) byUser.set(membership.userId, business);
  }
  return byUser;
}

function audit(
  deps: NetworkConnectionDeps,
  type: string,
  actorId: string,
  connection: NetworkConnectionRecord,
  occurredAt: string,
  payload: Record<string, unknown>
): void {
  deps.recordAuditEvent?.({
    type,
    actorId,
    aggregateId: connection.id,
    occurredAt,
    payload: {
      requesterUserId: connection.requesterUserId,
      recipientUserId: connection.recipientUserId,
      ...payload
    }
  });
}
