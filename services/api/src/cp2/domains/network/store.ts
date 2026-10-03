/**
 * Sixth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns the phone/social contact-graph
 * Maps: `networkNodes`, `networkEdges`, `networkSources`, `networkPermissions`,
 * `networkRoutes`, `contactHashes` (+ derived `contactHashIdByValue`), `externalIdentities`
 * (+ derived `externalIdentityIdBySubject`), and `grogoniIdentityLinks` - plus every method that
 * reads/writes them directly.
 *
 * Unlike every domain extracted so far, this one is **user-scoped, not business-scoped**: its
 * public methods gate on `requirePinVerifiedSession`, never `requireAuthorizedSession`, and
 * none of them take a `businessId`. That's why `deleteShopOwnedData` (the business-scoped
 * purge) never touches any of these Maps, while `deleteAccountOwnedData` (the account/user-
 * scoped purge) does.
 *
 * The coupling for this domain runs in the opposite direction from most prior slices: instead
 * of cross-cutting report builders reaching into this domain, this domain's own methods
 * (`syncConnectedSocialProvider`, `findGrogoniIdentityLink`) reach into the not-yet-extracted core
 * auth/identity kernel (`accounts`, `userByAccount`, `memberships`, `businesses`,
 * `userIdentities`) to auto-link a contact to an existing Grogoni account. All five are injected
 * as read-only raw `Map` references, the same pattern already used elsewhere.
 *
 * `CommerceDomain` and `SupplierDomain` were both extracted before this domain existed, so they
 * already receive `networkNodes`/`networkSources` as raw `Map` references via their own deps
 * interfaces. Both only ever read those Maps (confirmed - never `.set()`/`.delete()`), so
 * `Cp2Store`'s constructor now points those same deps at `this.networkDomain.networkNodesMap`/
 * `networkSourcesMap` instead of its own former private fields - zero code change needed inside
 * either of those two domain files. `requirePhonebookNode` (used only by `SupplierDomain`) moved
 * here too, since it operates purely on `networkNodes`; `sanitizeNetworkNode` moved to this
 * domain's `shared.ts` and is imported directly by `SupplierDomain`'s own file (no `this`
 * dependency, so no callback injection needed, same as `roundMoney`/`money.ts`).
 */
import { randomUUID } from "node:crypto";
import type {
  AccountSummary,
  AgentRouteSummary,
  AuthenticatedActorView,
  BusinessSummary,
  ContactHashSummary,
  ContactResolutionMatchSummary,
  ContactResolutionSummary,
  ExternalIdentitySummary,
  IdentityCandidateSummary,
  IdentityProvenance,
  MembershipSummary,
  NetworkConnectionRecord,
  NetworkConnectionSummary,
  NetworkConsentStatus,
  NetworkEdgeSourceType,
  NetworkEdgeSummary,
  NetworkGraphSummary,
  NetworkNodeSummary,
  NetworkPermissionSummary,
  NetworkSyncSourceSummary,
  NetworkVisibilityStatus,
  SocialNetworkProvider,
  GrogoniIdentityLinkSummary,
  UserIdentitySummary,
  UserSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import {
  createContactDisplayHint,
  createContactHash,
  hashCanonicalContact,
  hashStoredDestination,
  normalizeNetworkConnectionInput,
  normalizeSocialRelationship,
  ownerPhoneCountry,
  providerDisplayName,
  sanitizeNetworkNode,
  type NormalizedNetworkConnection,
  type PhoneContactNetworkInput,
  type SocialProfileNetworkInput
} from "./shared.js";
import {
  primaryBusinessByUser,
  listNetworkConnections,
  removeNetworkConnection,
  requestNetworkConnection,
  respondToNetworkConnection,
  type NetworkConnectionDeps
} from "./connections.js";

/** Upper bound for one phonebook sync request; a device syncs a larger phonebook in batches. */
export const maxPhonebookSyncContacts = 5000;
/** Direct contacts one owner's phone source may hold. */
export const maxPhonebookContacts = 20000;
/**
 * Contacts one user may submit for sync per rolling day. Every sync tells the caller which of the
 * submitted numbers are on Grogoni, so this bounds how fast one account can probe numbers it does not
 * actually know, while leaving room to re-sync a typical phonebook (a few thousand contacts)
 * several times a day. Refused syncs are not charged.
 */
export const phonebookSyncDailyBudget = 25000;
const phonebookSyncWindowMs = 24 * 60 * 60 * 1000;

export type PhonebookSyncMode = "replace" | "merge";

export interface NetworkDomainDeps {
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthenticatedActorView;
  accounts: Map<string, AccountSummary>;
  userByAccount: Map<string, string>;
  memberships: Map<string, MembershipSummary>;
  businesses: Map<string, BusinessSummary>;
  userIdentities: Map<string, UserIdentitySummary>;
  users: Map<string, UserSummary>;
  recordAuditEvent?: NetworkConnectionDeps["recordAuditEvent"];
  /** Overrides for the abuse limits below; production uses the defaults. */
  limits?: {
    maxPhonebookSyncContacts?: number;
    phonebookSyncDailyBudget?: number;
    maxPhonebookContacts?: number;
    maxPendingOutgoingConnections?: number;
  };
}

export class NetworkDomain {
  private readonly networkNodes = new Map<string, NetworkNodeSummary>();
  private readonly networkEdges = new Map<string, NetworkEdgeSummary>();
  private readonly networkSources = new Map<string, NetworkSyncSourceSummary>();
  private readonly networkPermissions = new Map<string, NetworkPermissionSummary>();
  private readonly networkRoutes = new Map<string, AgentRouteSummary>();
  private readonly contactHashes = new Map<string, ContactHashSummary>();
  private readonly contactHashIdByValue = new Map<string, string>();
  private readonly externalIdentities = new Map<string, ExternalIdentitySummary>();
  private readonly externalIdentityIdBySubject = new Map<string, string>();
  private readonly grogoniIdentityLinks = new Map<string, GrogoniIdentityLinkSummary>();
  private readonly identityCandidates = new Map<string, IdentityCandidateSummary>();
  private readonly networkConnections = new Map<string, NetworkConnectionRecord>();
  // `${channel}:${destination}` -> discovery key. Accounts rarely change their destination, so
  // hashing each one once keeps late-joiner discovery on every graph load cheap.
  private readonly discoveryKeyMemo = new Map<string, string | null>();
  // userId -> recent syncs. In memory on purpose: a restart resetting the window is harmless.
  private readonly phonebookSyncLog = new Map<string, Array<{ at: number; count: number }>>();

  constructor(private readonly deps: NetworkDomainDeps) {}

  get networkNodesMap(): Map<string, NetworkNodeSummary> {
    return this.networkNodes;
  }

  get networkEdgesMap(): Map<string, NetworkEdgeSummary> {
    return this.networkEdges;
  }

  get networkSourcesMap(): Map<string, NetworkSyncSourceSummary> {
    return this.networkSources;
  }

  get networkPermissionsMap(): Map<string, NetworkPermissionSummary> {
    return this.networkPermissions;
  }

  get networkRoutesMap(): Map<string, AgentRouteSummary> {
    return this.networkRoutes;
  }

  get contactHashesMap(): Map<string, ContactHashSummary> {
    return this.contactHashes;
  }

  get contactHashIdByValueMap(): Map<string, string> {
    return this.contactHashIdByValue;
  }

  get externalIdentitiesMap(): Map<string, ExternalIdentitySummary> {
    return this.externalIdentities;
  }

  get externalIdentityIdBySubjectMap(): Map<string, string> {
    return this.externalIdentityIdBySubject;
  }

  get grogoniIdentityLinksMap(): Map<string, GrogoniIdentityLinkSummary> {
    return this.grogoniIdentityLinks;
  }

  get identityCandidatesMap(): Map<string, IdentityCandidateSummary> {
    return this.identityCandidates;
  }

  get networkConnectionsMap(): Map<string, NetworkConnectionRecord> {
    return this.networkConnections;
  }

  clear(): void {
    this.networkNodes.clear();
    this.networkEdges.clear();
    this.networkSources.clear();
    this.networkPermissions.clear();
    this.networkRoutes.clear();
    this.contactHashes.clear();
    this.contactHashIdByValue.clear();
    this.externalIdentities.clear();
    this.externalIdentityIdBySubject.clear();
    this.grogoniIdentityLinks.clear();
    this.identityCandidates.clear();
    this.networkConnections.clear();
    this.discoveryKeyMemo.clear();
  }

  rebuildDerivedIndexes(): void {
    this.contactHashIdByValue.clear();
    for (const item of this.contactHashes.values()) {
      this.contactHashIdByValue.set(
        `${item.ownerUserId}:${item.hashType}:${item.hashValue}`,
        item.id
      );
    }

    this.externalIdentityIdBySubject.clear();
    for (const item of this.externalIdentities.values()) {
      this.externalIdentityIdBySubject.set(
        `${item.ownerUserId}:${item.provider}:${item.providerSubjectHash}`,
        item.id
      );
    }
  }

  /**
   * Syncs the owner's phonebook. `replace` (the default) treats the input as the whole phonebook:
   * the previous phone source and everything imported through it is dropped first. `merge` adds to
   * the active phone source instead, which is what a device picker that returns only the contacts
   * the owner selected needs: picking A and B, then C, leaves A, B and C. In both modes a contact
   * whose phone or email is already in the source updates that contact instead of duplicating it.
   *
   * Every sync, and every graph load, re-runs Grogoni discovery, so a contact who joins after being
   * synced shows up as a Grogoni user without another sync.
   */
  syncPhoneContacts(input: {
    sessionId: string | null;
    contacts: PhoneContactNetworkInput[];
    sourceName?: string;
    mode?: PhonebookSyncMode;
    /** The device's region, for owners whose own country is unknown (email or device login). */
    defaultCountry?: string | null;
    now?: Date;
  }): NetworkGraphSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const perRequest = this.deps.limits?.maxPhonebookSyncContacts ?? maxPhonebookSyncContacts;

    if (input.contacts.length > perRequest) {
      throw new Cp2Error(
        400,
        "network_contacts_too_many",
        `Sync at most ${perRequest} contacts per request.`
      );
    }
    assertNestedConnectionLimit(input.contacts, perRequest);

    const country = ownerPhoneCountry(session, input.defaultCountry ?? null);
    const importedContacts = input.contacts.map((contact, index) =>
      normalizeNetworkConnectionInput(contact, `contacts.${index}`, country)
    );
    // Charged per number/email probed, not per contact (one contact can carry ten numbers), and
    // only for numbers new to this owner: re-syncing a phonebook reveals nothing new.
    const probes = this.countNewDiscoveryProbes(session.user.id, importedContacts);
    this.assertPhonebookSyncBudget(session.user.id, probes, now);
    const ownerUserId = session.user.id;
    const sourceName = input.sourceName?.trim() || undefined;
    const activeSource =
      input.mode === "merge"
        ? ([...this.networkSources.values()].find(
            (source) =>
              source.ownerUserId === ownerUserId &&
              source.sourcePlatform === "phone" &&
              source.status === "active"
          ) ?? null)
        : null;

    // Checked before any write: a sync that would push the phonebook past the cap is refused
    // whole instead of being half applied. Contacts already in the phonebook are updates, not new.
    const contactLimit = this.deps.limits?.maxPhonebookContacts ?? maxPhonebookContacts;
    const activeIndex =
      activeSource === null ? null : this.phonebookSourceIndex(ownerUserId, activeSource.id);
    if (
      activeSource !== null &&
      activeIndex !== null &&
      activeSource.directCount +
        this.countNewPhonebookContacts(ownerUserId, importedContacts, activeIndex) >
        contactLimit
    ) {
      throw new Cp2Error(
        400,
        "network_contacts_limit",
        `A phonebook can hold at most ${contactLimit} contacts on Grogoni.`
      );
    }

    if (activeSource === null) {
      this.disconnectActiveNetworkSources(ownerUserId, "phone", now);
    }

    const source =
      activeSource ??
      this.createNetworkSource({
        ownerUserId,
        sourceType: "phone_contact",
        sourcePlatform: "phone",
        displayName: sourceName ?? "Phone contacts",
        importedCount: 0,
        now
      });

    if (activeSource !== null && sourceName !== undefined) {
      this.networkSources.set(source.id, { ...source, displayName: sourceName });
    }

    const ownerNode = this.ensureOwnerNetworkNode(session.user, now);
    const index = activeIndex ?? this.phonebookSourceIndex(ownerUserId, source.id);
    const syncedContactNodeIds: Array<string | null> = [];

    for (const contact of importedContacts) {
      const directNode = this.upsertPhonebookContact({
        ownerUserId,
        sourceId: source.id,
        ownerNodeId: ownerNode.id,
        contact,
        index,
        now
      });
      syncedContactNodeIds.push(directNode.id);

      for (const connection of contact.connections ?? []) {
        this.upsertExtendedPhonebookContact({
          ownerUserId,
          sourceId: source.id,
          directNode,
          connection: normalizeNetworkConnectionInput(connection, "connection"),
          index,
          now
        });
      }
    }

    this.refreshNetworkSourceCounts(source.id, now);
    const counted = this.networkSources.get(source.id)!;

    this.networkSources.set(source.id, {
      ...counted,
      importedCount: counted.directCount
    } as NetworkSyncSourceSummary);
    this.recordPhonebookSync(ownerUserId, probes, now);
    return {
      ...this.getNetworkGraph({ sessionId: input.sessionId, now }),
      syncedContactNodeIds
    };
  }

  syncSocialNetwork(input: {
    sessionId: string | null;
    provider: SocialNetworkProvider;
    profiles: SocialProfileNetworkInput[];
    sourceName?: string;
    provenance?: IdentityProvenance;
    now?: Date;
  }): NetworkGraphSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    // Profiles reveal which of their numbers are on Grogoni exactly like a phonebook sync, so they
    // get the same limits.
    const clientSubmitted = (input.provenance ?? "imported") !== "verified";
    const perRequest = this.deps.limits?.maxPhonebookSyncContacts ?? maxPhonebookSyncContacts;
    // A provider fetch (Google Contacts) arrives whole in one request, so it has no per-request
    // cap, but the owner controls what is in it: it is charged to the discovery budget like any
    // other sync.
    if (clientSubmitted && input.profiles.length > perRequest) {
      throw new Cp2Error(
        400,
        "network_contacts_too_many",
        `Sync at most ${perRequest} contacts per request.`
      );
    }
    if (clientSubmitted) assertNestedConnectionLimit(input.profiles, perRequest);
    const country = ownerPhoneCountry(session);
    const profiles = input.profiles.map((profile, index) =>
      normalizeNetworkConnectionInput(profile, `profiles.${index}`, country)
    );
    const probes = this.countNewDiscoveryProbes(session.user.id, profiles);
    this.assertPhonebookSyncBudget(session.user.id, probes, now);
    this.disconnectActiveNetworkSources(session.user.id, input.provider, now);
    const source = this.createNetworkSource({
      ownerUserId: session.user.id,
      sourceType: "social",
      sourcePlatform: input.provider,
      displayName: input.sourceName?.trim() || `${input.provider} connections`,
      importedCount: profiles.length,
      now
    });
    const ownerNode = this.ensureOwnerNetworkNode(session.user, now);
    const provenance = input.provenance ?? "imported";
    const discovery = this.discoveryPass();

    for (const profile of profiles) {
      const relationship = normalizeSocialRelationship(profile.relationship);
      const directNode = this.createImportedNetworkNode({
        ownerUserId: session.user.id,
        sourceId: source.id,
        sourceType: "social",
        sourcePlatform: input.provider,
        displayName: profile.name,
        degree: 1,
        kind: "external_social",
        phone: profile.phone,
        email: profile.email,
        phones: profile.phones,
        emails: profile.emails,
        providerSubject: profile.providerSubject ?? profile.handle ?? profile.name,
        handle: profile.handle,
        provenance,
        discovery,
        now
      });
      this.createNetworkEdge({
        ownerUserId: session.user.id,
        sourceType:
          relationship === "interaction" || relationship === "message"
            ? "social_interaction"
            : "social_follow",
        sourcePlatform: input.provider,
        fromNodeId: ownerNode.id,
        toNodeId: directNode.id,
        degree: 1,
        trustWeight: relationship === "interaction" || relationship === "message" ? 0.7 : 0.55,
        interactionWeight:
          relationship === "interaction" || relationship === "message" ? 0.8 : 0.35,
        visibilityStatus: "direct",
        consentStatus: "pending",
        now
      });

      for (const connection of profile.connections ?? []) {
        const normalizedConnection = normalizeNetworkConnectionInput(connection, "connection");
        const extendedNode = this.createImportedNetworkNode({
          ownerUserId: session.user.id,
          sourceId: source.id,
          sourceType: "social",
          sourcePlatform: input.provider,
          displayName: normalizedConnection.name,
          degree: 2,
          kind: "external_social",
          phone: normalizedConnection.phone,
          email: normalizedConnection.email,
          providerSubject:
            normalizedConnection.providerSubject ??
            normalizedConnection.handle ??
            normalizedConnection.name,
          handle: normalizedConnection.handle,
          provenance,
          discovery,
          now
        });
        this.createNetworkEdge({
          ownerUserId: session.user.id,
          sourceType: "agent_route",
          sourcePlatform: input.provider,
          fromNodeId: directNode.id,
          toNodeId: extendedNode.id,
          degree: 2,
          trustWeight: 0.4,
          interactionWeight: 0.2,
          visibilityStatus: "agent_mediated",
          consentStatus: "agent_required",
          now
        });
      }
    }

    this.refreshNetworkSourceCounts(source.id, now);
    this.recordPhonebookSync(session.user.id, probes, now);
    return this.getNetworkGraph({ sessionId: input.sessionId, now });
  }

  syncConnectedSocialProvider(input: {
    sessionId: string | null;
    provider: SocialNetworkProvider;
    now?: Date;
  }): NetworkGraphSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const identity = [...this.deps.userIdentities.values()].find(
      (candidate) =>
        candidate.accountId === session.account.id && candidate.provider === input.provider
    );

    if (identity === undefined) {
      throw new Cp2Error(
        409,
        "network_provider_not_connected",
        "Connect this provider to your Grogoni account before synchronizing it."
      );
    }

    return this.syncSocialNetwork({
      sessionId: input.sessionId,
      provider: input.provider,
      profiles: [],
      sourceName: `${providerDisplayName(identity.provider)} network`,
      provenance: "verified",
      now
    });
  }

  getNetworkGraph(input: { sessionId: string | null; now?: Date }): NetworkGraphSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    this.ensureOwnerNetworkNode(session.user, now);
    this.refreshGrogoniDiscovery(session.user.id, now);
    return this.networkGraphForUser(session.user.id, now);
  }

  listConnections(input: { sessionId: string | null; now?: Date }): NetworkConnectionSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    return listNetworkConnections(this.connectionDeps(), session.user.id);
  }

  /** Ask a phonebook contact who is on Grogoni to connect. See connections.ts for the rules. */
  requestConnection(input: {
    sessionId: string | null;
    nodeId: string;
    now?: Date;
  }): NetworkConnectionSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    // Discovery first, so a contact who joined since the last graph load can be connected to.
    this.refreshGrogoniDiscovery(session.user.id, now);
    return requestNetworkConnection(this.connectionDeps(), {
      userId: session.user.id,
      nodeId: input.nodeId,
      now
    });
  }

  respondToConnection(input: {
    sessionId: string | null;
    connectionId: string;
    accept: boolean;
    now?: Date;
  }): NetworkConnectionSummary | null {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    return respondToNetworkConnection(this.connectionDeps(), {
      userId: session.user.id,
      connectionId: input.connectionId,
      accept: input.accept,
      now
    });
  }

  removeConnection(input: { sessionId: string | null; connectionId: string; now?: Date }): void {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    removeNetworkConnection(this.connectionDeps(), {
      userId: session.user.id,
      connectionId: input.connectionId,
      now
    });
  }

  /**
   * A lookup of which Grogoni user a canonical phone number or email belongs to, for keeping invites
   * away from people already on Grogoni. Every lookup tells the caller whether a number is on Grogoni,
   * so `probes` is charged to the same daily budget as phonebook syncs (refused up front, recorded
   * on `commit`). The index is built once per lookup, not once per number.
   */
  createDiscoveryLookup(input: {
    userId: string;
    values: Array<{ channel: "phone" | "email"; value: string }>;
    now: Date;
  }): {
    find: (channel: "phone" | "email", canonicalValue: string) => string | null;
    commit: () => void;
  } {
    const probes = input.values.filter(
      ({ channel, value }) => !this.ownerKnowsDestination(input.userId, channel, value)
    ).length;
    this.assertPhonebookSyncBudget(input.userId, probes, input.now);
    const { index } = this.discoveryPass();
    return {
      find: (channel, canonicalValue) =>
        index.get(`${channel}:${hashCanonicalContact(channel, canonicalValue)}`) ?? null,
      commit: () => this.recordPhonebookSync(input.userId, probes, input.now)
    };
  }

  /** Whether this number/email is already in the owner's phonebook hashes (asked about before). */
  private ownerKnowsDestination(
    ownerUserId: string,
    channel: "phone" | "email",
    canonicalValue: string
  ): boolean {
    return this.contactHashIdByValue.has(
      `${ownerUserId}:${channel}:${hashCanonicalContact(channel, canonicalValue)}`
    );
  }

  /** Numbers and emails a sync asks about that this owner has not asked about before. */
  private countNewDiscoveryProbes(
    ownerUserId: string,
    contacts: NormalizedNetworkConnection[]
  ): number {
    const seen = new Set<string>();
    for (const contact of contacts) {
      for (const [channel, values] of [
        ["phone", contact.phones],
        ["email", contact.emails]
      ] as const) {
        for (const value of values) {
          if (!this.ownerKnowsDestination(ownerUserId, channel, value)) {
            seen.add(`${channel}:${value}`);
          }
        }
      }
    }
    return seen.size;
  }

  getDirectNetwork(input: { sessionId: string | null; now?: Date }): NetworkNodeSummary[] {
    return this.getNetworkGraph(input).nodes.filter((node) => node.degree === 1);
  }

  getExtendedNetwork(input: { sessionId: string | null; now?: Date }): NetworkNodeSummary[] {
    return this.getNetworkGraph(input).nodes.filter((node) => node.degree === 2);
  }

  createAgentRoute(input: {
    sessionId: string | null;
    requestText: string;
    targetNodeId?: string | null;
    now?: Date;
  }): AgentRouteSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const targetNode = this.findAgentRouteTarget({
      ownerUserId: session.user.id,
      requestText: input.requestText,
      targetNodeId: input.targetNodeId ?? null
    });
    const directEdge = [...this.networkEdges.values()].find(
      (edge) =>
        edge.ownerUserId === session.user.id && edge.toNodeId === targetNode.id && edge.degree === 2
    );

    if (directEdge === undefined) {
      throw new Cp2Error(
        409,
        "network_route_requires_agent",
        "Only second-degree network nodes require agent-mediated routes."
      );
    }

    const directNode = this.requireNetworkNode(directEdge.fromNodeId, session.user.id);
    const permission: NetworkPermissionSummary = {
      id: randomUUID(),
      ownerUserId: session.user.id,
      routeId: "",
      fromNodeId: directNode.id,
      toNodeId: targetNode.id,
      status: "agent_required",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const route: AgentRouteSummary = {
      id: randomUUID(),
      ownerUserId: session.user.id,
      requestText: input.requestText.trim(),
      status: "pending_permission",
      directNodeId: directNode.id,
      targetNodeId: targetNode.id,
      viaAgentLabel: `${directNode.displayName}'s Agent`,
      path: [
        "You",
        directNode.displayName,
        `${directNode.displayName}'s Agent`,
        targetNode.displayName
      ],
      permissionId: permission.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.networkPermissions.set(permission.id, {
      ...permission,
      routeId: route.id
    });
    this.networkRoutes.set(route.id, route);
    return route;
  }

  getAgentRoute(input: {
    sessionId: string | null;
    routeId: string;
    now?: Date;
  }): AgentRouteSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const route = this.networkRoutes.get(input.routeId);

    if (route === undefined || route.ownerUserId !== session.user.id) {
      throw new Cp2Error(404, "network_route_not_found", "Network route was not found.");
    }

    return route;
  }

  approveAgentRoute(input: {
    sessionId: string | null;
    routeId: string;
    now?: Date;
  }): AgentRouteSummary {
    return this.updateAgentRouteStatus(input, "approved", "granted");
  }

  rejectAgentRoute(input: {
    sessionId: string | null;
    routeId: string;
    now?: Date;
  }): AgentRouteSummary {
    return this.updateAgentRouteStatus(input, "rejected", "rejected");
  }

  deleteNetworkSource(input: {
    sessionId: string | null;
    sourceId: string;
    now?: Date;
  }): NetworkGraphSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const source = this.networkSources.get(input.sourceId);

    if (source === undefined || source.ownerUserId !== session.user.id) {
      throw new Cp2Error(404, "network_source_not_found", "Network sync source was not found.");
    }

    this.disconnectNetworkSourceRecord(source, now);

    return this.networkGraphForUser(session.user.id, now);
  }

  requirePhonebookNode(ownerUserId: string, networkNodeId: string): NetworkNodeSummary {
    const node = this.networkNodes.get(networkNodeId);

    if (
      node === undefined ||
      node.ownerUserId !== ownerUserId ||
      node.sourceType !== "phone_contact"
    ) {
      throw new Cp2Error(404, "phonebook_contact_not_found", "Phonebook contact was not found.");
    }

    return node;
  }

  /**
   * "Who is this?" - resolves a free-text name/phone/email/handle against the caller's own
   * phonebook, ranked phone/email hash match > confirmed-identity handle match > exact name match
   * > substring name match. Used by the runtime capability an agent calls before acting on a
   * person by name (e.g. "tell Kamau I'll take 20 bags") instead of guessing a node id itself.
   */
  resolveContact(input: {
    sessionId: string | null;
    query: string;
    now?: Date;
  }): ContactResolutionSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const query = input.query.trim();

    if (query.length === 0) {
      throw new Cp2Error(
        400,
        "network_resolve_query_required",
        "A contact name, phone, email, or handle is required."
      );
    }

    const nodes = [...this.networkNodes.values()].filter(
      (node) => node.ownerUserId === session.user.id && node.degree > 0
    );
    const bestByNode = new Map<string, ContactResolutionMatchSummary>();
    const record = (
      node: NetworkNodeSummary,
      matchType: ContactResolutionMatchSummary["matchType"],
      confidence: number
    ) => {
      const existing = bestByNode.get(node.id);
      if (existing === undefined || confidence > existing.confidence) {
        bestByNode.set(node.id, { node, matchType, confidence });
      }
    };

    for (const hashType of ["phone", "email"] as const) {
      let candidateHash: string | null = null;
      try {
        candidateHash = createContactHash(hashType, query);
      } catch {
        candidateHash = null;
      }
      if (candidateHash === null) continue;
      for (const node of nodes) {
        const matches = node.contactHashIds.some((hashId) => {
          const hash = this.contactHashes.get(hashId);
          return (
            hash !== undefined && hash.hashType === hashType && hash.hashValue === candidateHash
          );
        });
        if (matches) record(node, hashType, 0.95);
      }
    }

    const normalizedQuery = query.toLowerCase();
    for (const node of nodes) {
      for (const identityId of node.externalIdentityIds) {
        const identity = this.externalIdentities.get(identityId);
        if (identity?.handle !== null && identity?.handle !== undefined) {
          if (identity.handle.toLowerCase() === normalizedQuery) {
            record(node, "handle", 0.9);
          }
        }
      }
      const normalizedName = node.displayName.trim().toLowerCase();
      if (normalizedName === normalizedQuery) {
        record(node, "name", 0.85);
      } else if (normalizedName.includes(normalizedQuery)) {
        record(node, "name", 0.5);
      }
    }

    const connected = this.connectedUserIds(session.user.id);
    return {
      query,
      matches: [...bestByNode.values()]
        .map((match) => ({ ...match, node: this.nodeView(match.node, connected) }))
        .sort((left, right) => right.confidence - left.confidence)
    };
  }

  listIdentityCandidates(input: {
    sessionId: string | null;
    now?: Date;
  }): IdentityCandidateSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    return [...this.identityCandidates.values()]
      .filter(
        (candidate) => candidate.ownerUserId === session.user.id && candidate.status === "pending"
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * The only entry point for an external observation (today: ComputerRuntime reading untrusted
   * web content) to reach the phonebook. Never mutates networkNodes/externalIdentities - it only
   * ever creates a pending IdentityCandidateSummary, which requires an explicit
   * confirmIdentityCandidate call from the owner (never from browser content) before it can become
   * a real identity. `nodeId` is a best-effort guess (exact display-name match only - see
   * findBestNodeMatchForCandidate) that the owner can accept, override, or reject.
   */
  proposeIdentityCandidate(input: {
    sessionId: string | null;
    provider: string;
    providerSubject: string;
    displayName: string;
    handle?: string | null;
    evidence: string;
    now?: Date;
  }): IdentityCandidateSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const provider = input.provider.trim().toLowerCase();
    const providerSubject = input.providerSubject.trim();
    const displayName = input.displayName.trim();
    const evidence = input.evidence.trim();

    if (
      provider.length === 0 ||
      providerSubject.length === 0 ||
      displayName.length === 0 ||
      evidence.length === 0
    ) {
      throw new Cp2Error(
        400,
        "identity_candidate_invalid",
        "provider, providerSubject, displayName, and evidence are required."
      );
    }

    const providerSubjectHash = createContactHash("social", `${provider}:${providerSubject}`);
    const alreadyConfirmedId = this.externalIdentityIdBySubject.get(
      `${session.user.id}:${provider}:${providerSubjectHash}`
    );

    if (alreadyConfirmedId !== undefined) {
      throw new Cp2Error(
        409,
        "identity_candidate_already_confirmed",
        "This identity is already linked to a contact."
      );
    }

    const existingPending = [...this.identityCandidates.values()].find(
      (candidate) =>
        candidate.ownerUserId === session.user.id &&
        candidate.status === "pending" &&
        candidate.provider === provider &&
        candidate.providerSubjectHash === providerSubjectHash
    );

    if (existingPending !== undefined) {
      return existingPending;
    }

    const bestMatch = this.findBestNodeMatchForCandidate(session.user.id, displayName);
    const candidate: IdentityCandidateSummary = {
      id: randomUUID(),
      ownerUserId: session.user.id,
      nodeId: bestMatch?.id ?? null,
      provider,
      providerSubject,
      providerSubjectHash,
      displayName,
      handle: input.handle?.trim() || null,
      evidence,
      confidence: bestMatch !== null ? 0.5 : 0.15,
      status: "pending",
      createdAt: now.toISOString(),
      resolvedAt: null
    };
    this.identityCandidates.set(candidate.id, candidate);
    return candidate;
  }

  confirmIdentityCandidate(input: {
    sessionId: string | null;
    candidateId: string;
    targetNodeId?: string | null;
    createNewContact?: boolean;
    now?: Date;
  }): NetworkNodeSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const candidate = this.requirePendingIdentityCandidate(session.user.id, input.candidateId);

    let targetNode: NetworkNodeSummary;
    if (input.createNewContact === true) {
      targetNode = this.createManualNetworkNode({
        ownerUserId: session.user.id,
        displayName: candidate.displayName,
        now
      });
    } else {
      const nodeId = input.targetNodeId ?? candidate.nodeId;
      if (nodeId === null || nodeId === undefined) {
        throw new Cp2Error(
          409,
          "identity_candidate_ambiguous",
          "Choose an existing contact for this identity, or confirm it as a new contact."
        );
      }
      targetNode = this.requireNetworkNode(nodeId, session.user.id);
    }

    const identity = this.ensureExternalIdentity(
      {
        ownerUserId: session.user.id,
        provider: candidate.provider,
        providerSubject: candidate.providerSubject,
        displayName: candidate.displayName,
        handle: candidate.handle,
        now
      },
      "observed"
    );
    targetNode = this.attachExternalIdentityToNode(targetNode, identity.id, now);

    this.identityCandidates.set(candidate.id, {
      ...candidate,
      status: "confirmed",
      resolvedAt: now.toISOString()
    });

    return this.phonebookNodeView(session.user.id, targetNode);
  }

  rejectIdentityCandidate(input: {
    sessionId: string | null;
    candidateId: string;
    now?: Date;
  }): void {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const candidate = this.requirePendingIdentityCandidate(session.user.id, input.candidateId);
    this.identityCandidates.set(candidate.id, {
      ...candidate,
      status: "rejected",
      resolvedAt: now.toISOString()
    });
  }

  /** Direct, owner-authored identity entry ("Kamau's Instagram is @kamau_cereals") - provenance
   * "user_entered", attached immediately since the owner typing it themselves already is the
   * confirmation. Distinct from proposeIdentityCandidate, which is for untrusted observations. */
  addManualIdentity(input: {
    sessionId: string | null;
    nodeId: string;
    provider: string;
    providerSubject: string;
    displayName?: string;
    handle?: string | null;
    now?: Date;
  }): NetworkNodeSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const node = this.requireNetworkNode(input.nodeId, session.user.id);
    const provider = input.provider.trim().toLowerCase();
    const providerSubject = input.providerSubject.trim();

    if (provider.length === 0 || providerSubject.length === 0) {
      throw new Cp2Error(
        400,
        "network_identity_invalid",
        "provider and providerSubject are required."
      );
    }

    const identity = this.ensureExternalIdentity(
      {
        ownerUserId: session.user.id,
        provider,
        providerSubject,
        displayName: input.displayName?.trim() || node.displayName,
        handle: input.handle?.trim() || null,
        now
      },
      "user_entered"
    );
    return this.phonebookNodeView(
      session.user.id,
      this.attachExternalIdentityToNode(node, identity.id, now)
    );
  }

  unlinkIdentity(input: {
    sessionId: string | null;
    nodeId: string;
    externalIdentityId: string;
    now?: Date;
  }): NetworkNodeSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const node = this.requireNetworkNode(input.nodeId, session.user.id);

    if (!node.externalIdentityIds.includes(input.externalIdentityId)) {
      throw new Cp2Error(
        404,
        "network_identity_not_linked",
        "This identity is not linked to that contact."
      );
    }

    const updated: NetworkNodeSummary = {
      ...node,
      externalIdentityIds: node.externalIdentityIds.filter((id) => id !== input.externalIdentityId),
      updatedAt: now.toISOString()
    };
    this.networkNodes.set(node.id, updated);
    return this.phonebookNodeView(session.user.id, updated);
  }

  private ensureOwnerNetworkNode(user: UserSummary, now: Date): NetworkNodeSummary {
    const existing = [...this.networkNodes.values()].find(
      (node) => node.ownerUserId === user.id && node.degree === 0
    );

    if (existing !== undefined) {
      return existing;
    }

    const node: NetworkNodeSummary = {
      id: randomUUID(),
      ownerUserId: user.id,
      kind: "grogoni_user",
      displayName: user.displayName,
      degree: 0,
      sourceId: null,
      sourceType: "owner",
      sourcePlatform: null,
      grogoniUserId: user.id,
      grogoniBusinessId: null,
      grogoniAgentId: null,
      contactHashIds: [],
      externalIdentityIds: [],
      visibilityStatus: "direct",
      consentStatus: "granted",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.networkNodes.set(node.id, node);
    return node;
  }

  private createNetworkSource(input: {
    ownerUserId: string;
    sourceType: "phone_contact" | "social";
    sourcePlatform: "phone" | SocialNetworkProvider;
    displayName: string;
    importedCount: number;
    now: Date;
  }): NetworkSyncSourceSummary {
    const common = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      displayName: input.displayName,
      importedCount: input.importedCount,
      directCount: 0,
      extendedCount: 0,
      status: "active" as const,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      disconnectedAt: null
    };
    const source: NetworkSyncSourceSummary =
      input.sourceType === "phone_contact"
        ? {
            ...common,
            sourceType: "phone_contact",
            sourcePlatform: "phone"
          }
        : {
            ...common,
            sourceType: "social",
            sourcePlatform: input.sourcePlatform as SocialNetworkProvider
          };
    this.networkSources.set(source.id, source);
    return source;
  }

  private disconnectActiveNetworkSources(
    ownerUserId: string,
    sourcePlatform: "phone" | SocialNetworkProvider,
    now: Date
  ): void {
    for (const source of this.networkSources.values()) {
      if (
        source.ownerUserId === ownerUserId &&
        source.sourcePlatform === sourcePlatform &&
        source.status === "active"
      ) {
        this.disconnectNetworkSourceRecord(source, now);
      }
    }
  }

  private disconnectNetworkSourceRecord(source: NetworkSyncSourceSummary, now: Date): void {
    this.networkSources.set(source.id, {
      ...source,
      status: "disconnected",
      updatedAt: now.toISOString(),
      disconnectedAt: now.toISOString()
    } as NetworkSyncSourceSummary);

    const nodeIds = new Set(
      [...this.networkNodes.values()]
        .filter((node) => node.ownerUserId === source.ownerUserId && node.sourceId === source.id)
        .map((node) => node.id)
    );

    for (const edge of [...this.networkEdges.values()]) {
      if (
        edge.ownerUserId === source.ownerUserId &&
        (nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId))
      ) {
        this.networkEdges.delete(edge.id);
      }
    }

    for (const route of [...this.networkRoutes.values()]) {
      if (
        route.ownerUserId === source.ownerUserId &&
        (nodeIds.has(route.directNodeId) || nodeIds.has(route.targetNodeId))
      ) {
        this.networkRoutes.delete(route.id);
        this.networkPermissions.delete(route.permissionId);
      }
    }

    for (const [id, link] of this.grogoniIdentityLinks.entries()) {
      if (link.ownerUserId === source.ownerUserId && nodeIds.has(link.nodeId)) {
        this.grogoniIdentityLinks.delete(id);
      }
    }

    for (const nodeId of nodeIds) {
      this.networkNodes.delete(nodeId);
    }
  }

  private createImportedNetworkNode(input: {
    ownerUserId: string;
    sourceId: string;
    sourceType: "phone_contact" | "social";
    sourcePlatform: string;
    displayName: string;
    degree: 1 | 2;
    kind: "external_contact" | "external_social";
    phone?: string | null | undefined;
    email?: string | null | undefined;
    phones?: string[] | undefined;
    emails?: string[] | undefined;
    providerSubject?: string | null | undefined;
    handle?: string | null | undefined;
    provenance?: IdentityProvenance;
    discovery?: DiscoveryPass;
    now: Date;
  }): NetworkNodeSummary {
    const contactHashIds =
      input.degree === 1
        ? this.contactHashIdsFor({
            ownerUserId: input.ownerUserId,
            phones: [input.phone, ...(input.phones ?? [])],
            emails: [input.email, ...(input.emails ?? [])],
            now: input.now
          })
        : [];

    const externalIdentityId =
      input.kind === "external_social"
        ? this.ensureExternalIdentity(
            {
              ownerUserId: input.ownerUserId,
              provider: input.sourcePlatform,
              providerSubject: input.providerSubject ?? input.displayName,
              displayName: input.displayName,
              handle: input.handle ?? null,
              now: input.now
            },
            input.provenance ?? "imported"
          ).id
        : null;
    const grogoniLink = this.findGrogoniIdentityLink({
      ownerUserId: input.ownerUserId,
      contactHashIds,
      now: input.now,
      ...(input.discovery === undefined ? {} : { discovery: input.discovery })
    });
    const node: NetworkNodeSummary = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      kind: grogoniLink === null ? input.kind : "grogoni_user",
      displayName: input.displayName,
      degree: input.degree,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      sourcePlatform: input.sourcePlatform,
      grogoniUserId: grogoniLink?.linkedUserId ?? null,
      grogoniBusinessId: grogoniLink?.linkedBusinessId ?? null,
      grogoniAgentId: grogoniLink?.linkedAgentId ?? null,
      contactHashIds,
      externalIdentityIds: externalIdentityId === null ? [] : [externalIdentityId],
      visibilityStatus: input.degree === 1 ? "direct" : "agent_mediated",
      consentStatus: input.degree === 1 ? "pending" : "agent_required",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.networkNodes.set(node.id, node);

    if (grogoniLink !== null) {
      this.grogoniIdentityLinks.set(grogoniLink.id, {
        ...grogoniLink,
        nodeId: node.id
      });
    }

    return node;
  }

  private createNetworkEdge(input: {
    ownerUserId: string;
    sourceType: NetworkEdgeSourceType;
    sourcePlatform: string | null;
    fromNodeId: string;
    toNodeId: string;
    degree: 1 | 2;
    trustWeight: number;
    interactionWeight: number;
    visibilityStatus: NetworkVisibilityStatus;
    consentStatus: NetworkConsentStatus;
    now: Date;
  }): NetworkEdgeSummary {
    const edge: NetworkEdgeSummary = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      sourceType: input.sourceType,
      sourcePlatform: input.sourcePlatform,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      degree: input.degree,
      trustWeight: input.trustWeight,
      interactionWeight: input.interactionWeight,
      visibilityStatus: input.visibilityStatus,
      consentStatus: input.consentStatus,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.networkEdges.set(edge.id, edge);
    return edge;
  }

  private ensureContactHash(input: {
    ownerUserId: string;
    hashType: "phone" | "email" | "social";
    rawValue: string;
    now: Date;
  }): ContactHashSummary {
    // Every caller passes a value normalizeNetworkConnectionInput already made canonical.
    const hashValue =
      input.hashType === "social"
        ? createContactHash("social", input.rawValue)
        : hashCanonicalContact(input.hashType, input.rawValue);
    const mapKey = `${input.ownerUserId}:${input.hashType}:${hashValue}`;
    const existingId = this.contactHashIdByValue.get(mapKey);

    if (existingId !== undefined) {
      return this.contactHashes.get(existingId)!;
    }

    const contactHash: ContactHashSummary = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      hashType: input.hashType,
      hashValue,
      displayHint: createContactDisplayHint(input.rawValue),
      createdAt: input.now.toISOString()
    };
    this.contactHashes.set(contactHash.id, contactHash);
    this.contactHashIdByValue.set(mapKey, contactHash.id);
    return contactHash;
  }

  private ensureExternalIdentity(
    input: {
      ownerUserId: string;
      provider: string;
      providerSubject: string;
      displayName: string;
      handle: string | null;
      now: Date;
    },
    provenance: IdentityProvenance
  ): ExternalIdentitySummary {
    const providerSubjectHash = createContactHash(
      "social",
      `${input.provider}:${input.providerSubject}`
    );
    const mapKey = `${input.ownerUserId}:${input.provider}:${providerSubjectHash}`;
    const existingId = this.externalIdentityIdBySubject.get(mapKey);

    if (existingId !== undefined) {
      return this.externalIdentities.get(existingId)!;
    }

    const identity: ExternalIdentitySummary = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      providerSubjectHash,
      displayName: input.displayName,
      handle: input.handle,
      provenance,
      createdAt: input.now.toISOString()
    };
    this.externalIdentities.set(identity.id, identity);
    this.externalIdentityIdBySubject.set(mapKey, identity.id);
    return identity;
  }

  private findGrogoniIdentityLink(input: {
    ownerUserId: string;
    contactHashIds: string[];
    now: Date;
    discovery?: DiscoveryPass;
  }): GrogoniIdentityLinkSummary | null {
    // Nothing to match (e.g. a second-degree contact): do not build the account index for it.
    if (input.contactHashIds.length === 0) return null;
    const { index, businessByUser } = input.discovery ?? this.discoveryPass();

    for (const hashId of input.contactHashIds) {
      const contactHash = this.contactHashes.get(hashId);

      if (contactHash === undefined || contactHash.hashType === "social") {
        continue;
      }

      const linkedUserId = index.get(`${contactHash.hashType}:${contactHash.hashValue}`);

      // The owner's own number in their own phonebook is not a contact to connect with.
      if (linkedUserId === undefined || linkedUserId === input.ownerUserId) {
        continue;
      }

      const linkedBusiness = businessByUser.get(linkedUserId);

      return {
        id: randomUUID(),
        ownerUserId: input.ownerUserId,
        nodeId: "",
        linkedUserId,
        linkedBusinessId: linkedBusiness?.id ?? null,
        linkedAgentId: linkedBusiness?.grogoniId ?? null,
        confidence: 0.95,
        provenance: "imported",
        createdAt: input.now.toISOString()
      };
    }

    return null;
  }

  /**
   * Discovery key (`phone:<hash>` / `email:<hash>`) -> Grogoni user id for every active account: its
   * primary login destination, plus the user's verified phone and verified email (a device-first
   * account has no phone login but can still have a verified phone). Same hash as ContactHash, so
   * phonebook hashes look up directly and raw numbers never need to be compared.
   */
  private discoveryPass(): DiscoveryPass {
    return { index: this.grogoniDiscoveryIndex(), businessByUser: primaryBusinessByUser(this.deps) };
  }

  private grogoniDiscoveryIndex(): Map<string, string> {
    const index = new Map<string, string>();
    const add = (
      channel: "phone" | "email",
      destination: string | null | undefined,
      userId: string
    ) => {
      if (destination === null || destination === undefined || destination.trim() === "") return;
      const key = this.discoveryKey(channel, destination);
      if (key !== null && !index.has(key)) index.set(key, userId);
    };

    for (const account of this.deps.accounts.values()) {
      if (account.status !== undefined && account.status !== "active") continue;
      const userId = this.deps.userByAccount.get(account.id);
      if (userId === undefined) continue;
      if (account.primaryAuthChannel === "phone" || account.primaryAuthChannel === "email") {
        add(account.primaryAuthChannel, account.primaryAuthDestination, userId);
      }
      const user = this.deps.users.get(userId);
      if (user?.phoneVerificationStatus === "verified") add("phone", user.phoneNumberE164, userId);
      if (user?.emailVerificationStatus === "verified") add("email", user.emailAddress, userId);
    }

    return index;
  }

  private discoveryKey(channel: "phone" | "email", destination: string): string | null {
    const memoKey = `${channel}:${destination}`;
    const memoized = this.discoveryKeyMemo.get(memoKey);

    if (memoized !== undefined) {
      return memoized;
    }

    let key: string | null;
    try {
      key = `${channel}:${hashStoredDestination(channel, destination)}`;
    } catch {
      key = null;
    }
    this.discoveryKeyMemo.set(memoKey, key);
    return key;
  }

  /**
   * Re-links every direct contact of this owner to the Grogoni user its phone/email belongs to right
   * now: links contacts who joined after they were synced, and unlinks contacts whose account is
   * gone or no longer holds that number.
   */
  private refreshGrogoniDiscovery(ownerUserId: string, now: Date): void {
    const discovery = this.discoveryPass();
    // Contacts whose link changed, with their new link (or null). Their old links are replaced in
    // one pass over identity links after the loop, never one pass per contact.
    const relinked = new Map<string, GrogoniIdentityLinkSummary | null>();

    for (const node of [...this.networkNodes.values()]) {
      if (node.ownerUserId !== ownerUserId || node.degree !== 1) continue;
      if (node.contactHashIds.length === 0 && node.grogoniUserId === null) continue;

      const link = this.findGrogoniIdentityLink({
        ownerUserId,
        contactHashIds: node.contactHashIds,
        now,
        discovery
      });
      const linkedUserId = link?.linkedUserId ?? null;

      if (
        linkedUserId === node.grogoniUserId &&
        (link?.linkedBusinessId ?? null) === node.grogoniBusinessId
      ) {
        continue;
      }

      relinked.set(node.id, link);
      this.networkNodes.set(node.id, {
        ...node,
        kind:
          link !== null
            ? "grogoni_user"
            : node.sourceType === "social"
              ? "external_social"
              : "external_contact",
        grogoniUserId: linkedUserId,
        grogoniBusinessId: link?.linkedBusinessId ?? null,
        grogoniAgentId: link?.linkedAgentId ?? null,
        updatedAt: now.toISOString()
      });
    }

    if (relinked.size === 0) return;

    for (const [id, existing] of [...this.grogoniIdentityLinks.entries()]) {
      if (existing.ownerUserId === ownerUserId && relinked.has(existing.nodeId)) {
        this.grogoniIdentityLinks.delete(id);
      }
    }

    for (const [nodeId, link] of relinked) {
      if (link !== null) this.grogoniIdentityLinks.set(link.id, { ...link, nodeId });
    }
  }

  /**
   * "directNodeId:lowercase name" for the owner's existing second-degree contacts, built on first
   * use and kept on the sync's index, so deduping N nested connections is one scan of edges, not N.
   */
  private extendedConnectionKeys(ownerUserId: string, index: PhonebookSourceIndex): Set<string> {
    if (index.extendedKeys === null) {
      index.extendedKeys = new Set();
      for (const edge of this.networkEdges.values()) {
        if (edge.ownerUserId !== ownerUserId || edge.degree !== 2) continue;
        const name = this.networkNodes.get(edge.toNodeId)?.displayName.toLowerCase();
        if (name !== undefined) index.extendedKeys.add(`${edge.fromNodeId}:${name}`);
      }
    }
    return index.extendedKeys;
  }

  private phonebookSourceIndex(ownerUserId: string, sourceId: string): PhonebookSourceIndex {
    const index: PhonebookSourceIndex = {
      byHashId: new Map(),
      byBareName: new Map(),
      discovery: this.discoveryPass(),
      extendedKeys: null
    };

    for (const node of this.networkNodes.values()) {
      if (node.ownerUserId === ownerUserId && node.sourceId === sourceId && node.degree === 1) {
        indexPhonebookNode(index, node);
      }
    }

    return index;
  }

  private upsertPhonebookContact(input: {
    ownerUserId: string;
    sourceId: string;
    ownerNodeId: string;
    contact: NormalizedNetworkConnection;
    index: PhonebookSourceIndex;
    now: Date;
  }): NetworkNodeSummary {
    const hashIds = this.contactHashIdsFor({
      ownerUserId: input.ownerUserId,
      phones: input.contact.phones,
      emails: input.contact.emails,
      now: input.now
    });

    // A phone/email match wins; a name-only contact that now arrives with a number is upgraded.
    const existing =
      hashIds
        .map((hashId) => input.index.byHashId.get(hashId))
        .find((node) => node !== undefined) ??
      input.index.byBareName.get(input.contact.name.toLowerCase());

    if (existing !== undefined) {
      const current = this.networkNodes.get(existing.id) ?? existing;
      // A number already on another contact stays there: one number, one contact.
      const added = hashIds.filter((hashId) => {
        const owner = input.index.byHashId.get(hashId);
        return owner === undefined || owner.id === current.id;
      });
      const updated: NetworkNodeSummary = {
        ...current,
        displayName: input.contact.name,
        contactHashIds: [...new Set([...current.contactHashIds, ...added])],
        updatedAt: input.now.toISOString()
      };
      this.networkNodes.set(updated.id, updated);
      indexPhonebookNode(input.index, updated, current);
      return updated;
    }

    const node = this.createImportedNetworkNode({
      ownerUserId: input.ownerUserId,
      sourceId: input.sourceId,
      sourceType: "phone_contact",
      sourcePlatform: "phone",
      displayName: input.contact.name,
      degree: 1,
      kind: "external_contact",
      phones: input.contact.phones,
      emails: input.contact.emails,
      discovery: input.index.discovery,
      now: input.now
    });
    this.createNetworkEdge({
      ownerUserId: input.ownerUserId,
      sourceType: "phone_contact",
      sourcePlatform: "phone",
      fromNodeId: input.ownerNodeId,
      toNodeId: node.id,
      degree: 1,
      trustWeight: 0.8,
      interactionWeight: 0.3,
      visibilityStatus: "direct",
      consentStatus: "pending",
      now: input.now
    });
    indexPhonebookNode(input.index, node);
    return node;
  }

  private upsertExtendedPhonebookContact(input: {
    ownerUserId: string;
    sourceId: string;
    directNode: NetworkNodeSummary;
    connection: NormalizedNetworkConnection;
    index: PhonebookSourceIndex;
    now: Date;
  }): void {
    const key = `${input.directNode.id}:${input.connection.name.toLowerCase()}`;
    const extended = this.extendedConnectionKeys(input.ownerUserId, input.index);

    if (extended.has(key)) {
      return;
    }
    extended.add(key);

    const extendedNode = this.createImportedNetworkNode({
      ownerUserId: input.ownerUserId,
      sourceId: input.sourceId,
      sourceType: "phone_contact",
      sourcePlatform: "phone",
      displayName: input.connection.name,
      degree: 2,
      kind: "external_contact",
      phone: null,
      email: null,
      now: input.now
    });
    this.createNetworkEdge({
      ownerUserId: input.ownerUserId,
      sourceType: "agent_route",
      sourcePlatform: "phone",
      fromNodeId: input.directNode.id,
      toNodeId: extendedNode.id,
      degree: 2,
      trustWeight: 0.45,
      interactionWeight: 0.15,
      visibilityStatus: "agent_mediated",
      consentStatus: "agent_required",
      now: input.now
    });
  }

  private contactHashIdsFor(input: {
    ownerUserId: string;
    phones: Array<string | null | undefined>;
    emails: Array<string | null | undefined>;
    now: Date;
  }): string[] {
    const ids: string[] = [];

    for (const [hashType, values] of [
      ["phone", input.phones],
      ["email", input.emails]
    ] as const) {
      for (const rawValue of values) {
        if (rawValue === undefined || rawValue === null) continue;
        const id = this.ensureContactHash({
          ownerUserId: input.ownerUserId,
          hashType,
          rawValue,
          now: input.now
        }).id;
        if (!ids.includes(id)) ids.push(id);
      }
    }

    return ids;
  }

  private recentPhonebookSyncs(userId: string, now: Date) {
    const since = now.getTime() - phonebookSyncWindowMs;
    return (this.phonebookSyncLog.get(userId) ?? []).filter((entry) => entry.at > since);
  }

  /** Refuses a sync that would exceed the budget. Only syncs that succeed are charged. */
  private assertPhonebookSyncBudget(userId: string, count: number, now: Date): void {
    const used = this.recentPhonebookSyncs(userId, now).reduce(
      (total, entry) => total + entry.count,
      0
    );

    if (used + count > (this.deps.limits?.phonebookSyncDailyBudget ?? phonebookSyncDailyBudget)) {
      throw new Cp2Error(
        429,
        "network_sync_rate_limited",
        "You have synced a lot of contacts today. Try again tomorrow."
      );
    }
  }

  private recordPhonebookSync(userId: string, count: number, now: Date): void {
    this.phonebookSyncLog.set(userId, [
      ...this.recentPhonebookSyncs(userId, now),
      { at: now.getTime(), count }
    ]);
  }

  /**
   * How many of `contacts` would become new phonebook nodes, without writing anything: the same
   * matching upsertPhonebookContact does (any known phone/email hash, else an exact bare name),
   * with duplicates inside the batch counted once.
   */
  private countNewPhonebookContacts(
    ownerUserId: string,
    contacts: NormalizedNetworkConnection[],
    index: PhonebookSourceIndex
  ): number {
    const seen = new Set<string>();
    let count = 0;

    for (const contact of contacts) {
      const keys = [
        ...contact.phones.map((value) => `phone:${hashCanonicalContact("phone", value)}`),
        ...contact.emails.map((value) => `email:${hashCanonicalContact("email", value)}`)
      ];
      const known = keys.some((key) => {
        const hashId = this.contactHashIdByValue.get(`${ownerUserId}:${key}`);
        return hashId !== undefined && index.byHashId.has(hashId);
      });
      const nameKey = `name:${contact.name.toLowerCase()}`;
      const identity = keys.length > 0 ? keys : [nameKey];

      if (known || (keys.length === 0 && index.byBareName.has(contact.name.toLowerCase()))) {
        continue;
      }
      if (identity.some((key) => seen.has(key))) continue;
      identity.forEach((key) => seen.add(key));
      count += 1;
    }

    return count;
  }

  private connectionDeps(): NetworkConnectionDeps {
    return {
      connections: this.networkConnections,
      networkNodes: this.networkNodes,
      users: this.deps.users,
      memberships: this.deps.memberships,
      businesses: this.deps.businesses,
      ...(this.deps.limits?.maxPendingOutgoingConnections === undefined
        ? {}
        : { maxPendingOutgoing: this.deps.limits.maxPendingOutgoingConnections }),
      ...(this.deps.recordAuditEvent === undefined
        ? {}
        : { recordAuditEvent: this.deps.recordAuditEvent })
    };
  }

  private refreshNetworkSourceCounts(sourceId: string, now: Date): void {
    const source = this.networkSources.get(sourceId);

    if (source === undefined) {
      return;
    }

    const nodes = [...this.networkNodes.values()].filter((node) => node.sourceId === sourceId);
    this.networkSources.set(sourceId, {
      ...source,
      directCount: nodes.filter((node) => node.degree === 1).length,
      extendedCount: nodes.filter((node) => node.degree === 2).length,
      updatedAt: now.toISOString()
    } as NetworkSyncSourceSummary);
  }

  /**
   * Grogoni users this owner is connected with. Discovery links a contact to a Grogoni user so the owner
   * can connect, but which shop they run is only shown once connected: holding someone's number
   * reveals that they use Grogoni, not their business.
   */
  private connectedUserIds(ownerUserId: string): Set<string> {
    const connected = new Set<string>();
    for (const connection of this.networkConnections.values()) {
      if (connection.status !== "accepted") continue;
      if (connection.requesterUserId === ownerUserId) connected.add(connection.recipientUserId);
      if (connection.recipientUserId === ownerUserId) connected.add(connection.requesterUserId);
    }
    return connected;
  }

  /**
   * Before an account purge sweeps every record that references the purged ids: other owners'
   * phonebook contacts that were linked to the purged person are theirs, not the purged
   * person's. Unlink them (back to a plain contact, which the next discovery pass would do
   * anyway) and drop their identity links, so the sweep leaves them in place. Returns how many
   * contacts were unlinked.
   */
  detachPurgedUsers(scope: Set<string>, now: Date): number {
    let detached = 0;
    // The purged user's own nodes and links are skipped here; the sweep deletes those.

    for (const node of [...this.networkNodes.values()]) {
      if (scope.has(node.ownerUserId)) continue;
      const linked =
        (node.grogoniUserId !== null && scope.has(node.grogoniUserId)) ||
        (node.grogoniBusinessId !== null && scope.has(node.grogoniBusinessId));
      if (!linked) continue;
      this.networkNodes.set(node.id, {
        ...node,
        kind: node.sourceType === "social" ? "external_social" : "external_contact",
        grogoniUserId: null,
        grogoniBusinessId: null,
        grogoniAgentId: null,
        updatedAt: now.toISOString()
      });
      detached += 1;
    }

    for (const [id, link] of [...this.grogoniIdentityLinks.entries()]) {
      if (scope.has(link.ownerUserId)) continue;
      if (
        (link.linkedUserId !== null && scope.has(link.linkedUserId)) ||
        (link.linkedBusinessId !== null && scope.has(link.linkedBusinessId))
      ) {
        this.grogoniIdentityLinks.delete(id);
      }
    }

    return detached;
  }

  /** A phonebook node as its owner may see it, for other domains that list the owner's nodes. */
  phonebookNodeView(ownerUserId: string, node: NetworkNodeSummary): NetworkNodeSummary {
    return this.phonebookNodeViewer(ownerUserId)(node);
  }

  /** phonebookNodeView for many nodes of one owner: their connections are read once. */
  phonebookNodeViewer(ownerUserId: string): (node: NetworkNodeSummary) => NetworkNodeSummary {
    const connected = this.connectedUserIds(ownerUserId);
    return (node) => this.nodeView(node, connected);
  }

  private nodeView(node: NetworkNodeSummary, connected: Set<string>): NetworkNodeSummary {
    const view = sanitizeNetworkNode(node);
    return view.grogoniUserId === null || connected.has(view.grogoniUserId)
      ? view
      : { ...view, grogoniBusinessId: null, grogoniAgentId: null };
  }

  private networkGraphForUser(ownerUserId: string, now: Date): NetworkGraphSummary {
    const connected = this.connectedUserIds(ownerUserId);
    return {
      ownerUserId,
      generatedAt: now.toISOString(),
      nodes: [...this.networkNodes.values()]
        .filter((node) => node.ownerUserId === ownerUserId)
        .map((node) => this.nodeView(node, connected))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      edges: [...this.networkEdges.values()]
        .filter((edge) => edge.ownerUserId === ownerUserId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      sources: [...this.networkSources.values()]
        .filter((source) => source.ownerUserId === ownerUserId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      routes: [...this.networkRoutes.values()]
        .filter((route) => route.ownerUserId === ownerUserId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      permissions: [...this.networkPermissions.values()]
        .filter((permission) => permission.ownerUserId === ownerUserId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      identityLinks: [...this.grogoniIdentityLinks.values()]
        .filter((link) => link.ownerUserId === ownerUserId)
        .map((link) =>
          link.linkedUserId !== null && connected.has(link.linkedUserId)
            ? link
            : { ...link, linkedBusinessId: null, linkedAgentId: null }
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      identityCandidates: [...this.identityCandidates.values()]
        .filter(
          (candidate) => candidate.ownerUserId === ownerUserId && candidate.status === "pending"
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      connections: listNetworkConnections(this.connectionDeps(), ownerUserId)
    };
  }

  private findAgentRouteTarget(input: {
    ownerUserId: string;
    requestText: string;
    targetNodeId: string | null;
  }): NetworkNodeSummary {
    const extendedNodes = [...this.networkNodes.values()].filter(
      (node) => node.ownerUserId === input.ownerUserId && node.degree === 2
    );
    const target =
      input.targetNodeId === null
        ? (extendedNodes.find((node) =>
            input.requestText.toLowerCase().includes(node.displayName.toLowerCase())
          ) ?? extendedNodes[0])
        : extendedNodes.find((node) => node.id === input.targetNodeId);

    if (target === undefined) {
      throw new Cp2Error(
        404,
        "network_target_not_found",
        "No reachable second-degree network target was found."
      );
    }

    return target;
  }

  private requireNetworkNode(nodeId: string, ownerUserId: string): NetworkNodeSummary {
    const node = this.networkNodes.get(nodeId);

    if (node === undefined || node.ownerUserId !== ownerUserId) {
      throw new Cp2Error(404, "network_node_not_found", "Network node was not found.");
    }

    return node;
  }

  private requirePendingIdentityCandidate(
    ownerUserId: string,
    candidateId: string
  ): IdentityCandidateSummary {
    const candidate = this.identityCandidates.get(candidateId);

    if (candidate === undefined || candidate.ownerUserId !== ownerUserId) {
      throw new Cp2Error(404, "identity_candidate_not_found", "Identity candidate was not found.");
    }

    if (candidate.status !== "pending") {
      throw new Cp2Error(
        409,
        "identity_candidate_already_resolved",
        "This identity candidate has already been resolved."
      );
    }

    return candidate;
  }

  /**
   * Deliberately conservative: an exact, case-insensitive display-name match only. This is a
   * suggestion the owner still has to confirm, never an auto-merge - per
   * docs/architecture/phonebook-identity-resolution.md, nobody gets linked to an existing contact
   * on name similarity alone.
   */
  private findBestNodeMatchForCandidate(
    ownerUserId: string,
    displayName: string
  ): NetworkNodeSummary | null {
    const normalized = displayName.trim().toLowerCase();
    return (
      [...this.networkNodes.values()].find(
        (node) =>
          node.ownerUserId === ownerUserId &&
          node.degree > 0 &&
          node.displayName.trim().toLowerCase() === normalized
      ) ?? null
    );
  }

  private createManualNetworkNode(input: {
    ownerUserId: string;
    displayName: string;
    now: Date;
  }): NetworkNodeSummary {
    const node: NetworkNodeSummary = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      kind: "external_contact",
      displayName: input.displayName,
      degree: 1,
      sourceId: null,
      sourceType: "manual",
      sourcePlatform: null,
      grogoniUserId: null,
      grogoniBusinessId: null,
      grogoniAgentId: null,
      contactHashIds: [],
      externalIdentityIds: [],
      visibilityStatus: "direct",
      consentStatus: "granted",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.networkNodes.set(node.id, node);
    return node;
  }

  private attachExternalIdentityToNode(
    node: NetworkNodeSummary,
    externalIdentityId: string,
    now: Date
  ): NetworkNodeSummary {
    if (node.externalIdentityIds.includes(externalIdentityId)) {
      return node;
    }

    const updated: NetworkNodeSummary = {
      ...node,
      externalIdentityIds: [...node.externalIdentityIds, externalIdentityId],
      updatedAt: now.toISOString()
    };
    this.networkNodes.set(node.id, updated);
    return updated;
  }

  private updateAgentRouteStatus(
    input: {
      sessionId: string | null;
      routeId: string;
      now?: Date;
    },
    status: AgentRouteSummary["status"],
    permissionStatus: NetworkConsentStatus
  ): AgentRouteSummary {
    const now = input.now ?? new Date();
    const route = this.getAgentRoute({ ...input, now });
    const updatedRoute: AgentRouteSummary = {
      ...route,
      status,
      updatedAt: now.toISOString()
    };
    const permission = this.networkPermissions.get(route.permissionId);

    if (permission !== undefined) {
      this.networkPermissions.set(permission.id, {
        ...permission,
        status: permissionStatus,
        updatedAt: now.toISOString()
      });
    }

    this.networkRoutes.set(route.id, updatedRoute);
    return updatedRoute;
  }
}

/**
 * One discovery pass: which Grogoni user each phone/email hash belongs to, and each user's primary
 * shop. Built once per request and handed to every lookup in it, so linking N contacts costs one
 * scan of accounts and memberships, not N.
 */
interface DiscoveryPass {
  index: Map<string, string>;
  businessByUser: Map<string, BusinessSummary>;
}

interface PhonebookSourceIndex {
  byHashId: Map<string, NetworkNodeSummary>;
  /** Contacts with neither phone nor email, matched by exact (case-insensitive) name. */
  byBareName: Map<string, NetworkNodeSummary>;
  /** Built once per sync; see NetworkDomain.grogoniDiscoveryIndex. */
  discovery: DiscoveryPass;
  /** See NetworkDomain.extendedConnectionKeys; null until first needed. */
  extendedKeys: Set<string> | null;
}

function indexPhonebookNode(
  index: PhonebookSourceIndex,
  node: NetworkNodeSummary,
  previous?: NetworkNodeSummary
): void {
  const previousName = previous?.displayName.toLowerCase();
  if (previousName !== undefined && index.byBareName.get(previousName)?.id === node.id) {
    index.byBareName.delete(previousName);
  }

  if (node.contactHashIds.length === 0) {
    index.byBareName.set(node.displayName.toLowerCase(), node);
    return;
  }

  for (const hashId of node.contactHashIds) {
    index.byHashId.set(hashId, node);
  }
}

/** Second-degree connections (a contact's own contacts) sent in one request, in total. */
function assertNestedConnectionLimit(
  contacts: Array<{ connections?: unknown[] | undefined }>,
  limit: number
): void {
  const nested = contacts.reduce((total, contact) => total + (contact.connections?.length ?? 0), 0);
  if (nested > limit) {
    throw new Cp2Error(
      400,
      "network_connections_too_many",
      `Send at most ${limit} second-degree connections per request.`
    );
  }
}
