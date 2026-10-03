/**
 * Staff invitations and membership management (docs/architecture/staff-invitations.md).
 *
 * An owner or manager invites a phone number or email into their business with a role. Nothing is
 * granted until the invited person signs in with that identity and explicitly accepts, which
 * creates an ordinary `MembershipSummary` - the same record every permission check already reads,
 * so a removal or role change takes effect on the very next request, MCP included.
 *
 * Who may do what is decided only by `rolesGrantableBy` / `canManageMemberRole`
 * (business-core/roles.ts): you may grant, change or remove only roles strictly below your own, so
 * a manager can never touch the owner or another manager, and the owner role is never grantable.
 *
 * Trust model: Grogoni signs people in by phone number, so a phone identity *is* the account; an
 * invite to +2547... is an invite to whichever Grogoni account signs in with that number. Emails only
 * match when verified. See the architecture doc for the squatting risk and its mitigations.
 *
 * This domain owns the `staffInvitations` collection. Memberships stay in the core store (they are
 * the auth kernel's), injected here as the live Map, like the other domain slices do.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  canManageMemberRole,
  isBusinessRole,
  rolesGrantableBy,
  type BusinessPermission
} from "@grogoni/business-core";
import type {
  AccountSummary,
  AuthenticatedActorView,
  BusinessRole,
  BusinessSummary,
  MembershipSummary,
  MyStaffInvitationSummary,
  StaffInvitationChannel,
  StaffInvitationSummary,
  StaffMemberSummary,
  StaffOverviewSummary,
  UserSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";

/** How long an invitation stays acceptable. */
export const staffInvitationTtlMs = 7 * 24 * 60 * 60 * 1000;
/** Open invitations per business, so a compromised manager account cannot spray invites. */
export const maxPendingStaffInvitations = 50;

export interface StaffIdentity {
  accountId: string;
  type: string;
  normalizedValue: string;
  isPrimary: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

/** After a decline, the same destination cannot be re-invited for this long (no invite spam). */
export const staffReinviteAfterDeclineMs = 24 * 60 * 60 * 1000;

export interface StaffDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  requireAuthenticatedActor: (sessionId: string | null, now: Date) => AuthenticatedActorView;
  memberships: Map<string, MembershipSummary>;
  businesses: Map<string, BusinessSummary>;
  users: Map<string, UserSummary>;
  accounts: Map<string, AccountSummary>;
  quarantinedBusinessIds: Set<string>;
  accountIdentities: () => Iterable<StaffIdentity>;
  /**
   * A member's role changed, they left, or they just joined: fulfillment releases trips they can
   * no longer drive (or, on joining, stale trips from an earlier membership).
   */
  onMembershipChanged?: (
    businessId: string,
    userId: string,
    change: { previousRole: BusinessRole | null; joined: boolean; at: string }
  ) => void;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
}

export class StaffDomain {
  private readonly staffInvitations = new Map<string, StaffInvitationSummary>();

  constructor(private readonly deps: StaffDomainDeps) {}

  get staffInvitationsMap(): Map<string, StaffInvitationSummary> {
    return this.staffInvitations;
  }

  // ---- Owner / manager side --------------------------------------------------------------

  inviteStaff(input: {
    sessionId: string | null;
    businessId: string;
    role: BusinessRole;
    inviteeName: string;
    channel: StaffInvitationChannel;
    /** Already normalized by the route: E.164 phone, or lowercased email. */
    destination: string;
    now?: Date;
  }): StaffInvitationSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:invite",
      now
    );
    const actorRole = this.roleOf(input.businessId, actor.user.id);
    if (!isBusinessRole(input.role) || !rolesGrantableBy(actorRole).includes(input.role)) {
      throw new Cp2Error(
        403,
        "staff_role_not_grantable",
        "You cannot invite someone into that role.",
        false,
        { grantableRoles: rolesGrantableBy(actorRole) }
      );
    }
    const inviteeName = input.inviteeName.trim();
    if (inviteeName.length < 1 || inviteeName.length > 120) {
      throw new Cp2Error(400, "staff_invitee_name_invalid", "Give a name of 1 to 120 characters.");
    }
    const destination = input.destination.trim();
    if (destination.length === 0 || destination.length > 254) {
      throw new Cp2Error(400, "staff_destination_invalid", "Give a phone number or email.");
    }

    const existingMember = this.memberForIdentity(
      input.businessId,
      input.channel,
      destination,
      now.toISOString()
    );
    if (existingMember !== undefined) {
      throw new Cp2Error(
        409,
        "staff_already_member",
        "That person is already part of this business.",
        false,
        { membershipId: existingMember.id, role: existingMember.role }
      );
    }
    const pending = this.pendingFor(input.businessId, now);
    const duplicate = pending.find(
      (invite) => invite.channel === input.channel && invite.destination === destination
    );
    if (duplicate !== undefined) {
      throw new Cp2Error(
        409,
        "staff_invitation_pending",
        "That person already has an invitation waiting. Revoke it to send a different one.",
        false,
        { invitationId: duplicate.id }
      );
    }
    const recentlyDeclined = [...this.staffInvitations.values()].some(
      (invite) =>
        invite.businessId === input.businessId &&
        invite.channel === input.channel &&
        invite.destination === destination &&
        invite.status === "declined" &&
        invite.respondedAt !== null &&
        now.getTime() - Date.parse(invite.respondedAt) < staffReinviteAfterDeclineMs
    );
    if (recentlyDeclined) {
      throw new Cp2Error(
        409,
        "staff_invitation_recently_declined",
        "That person declined an invitation in the last day. Talk to them before inviting again."
      );
    }
    if (pending.length >= maxPendingStaffInvitations) {
      throw new Cp2Error(
        409,
        "staff_invitation_limit",
        `A business can have at most ${maxPendingStaffInvitations} open invitations.`
      );
    }

    const invitation: StaffInvitationSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      role: input.role,
      inviteeName,
      channel: input.channel,
      destination,
      status: "pending",
      invitedByUserId: actor.user.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + staffInvitationTtlMs).toISOString(),
      respondedAt: null,
      acceptedByUserId: null,
      membershipId: null,
      // 144 random bits: the join link's secret, sent to the invited number by the owner.
      joinToken: randomBytes(18).toString("base64url"),
      acceptedWithLink: false
    };
    this.staffInvitations.set(invitation.id, invitation);
    this.audit("staff.invitation_created", invitation.id, actor.user.id, now, {
      businessId: input.businessId,
      role: input.role,
      channel: input.channel
    });
    return invitation;
  }

  getStaffOverview(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): StaffOverviewSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:read",
      now
    );
    const actorRole = this.roleOf(input.businessId, actor.user.id);
    const members = [...this.deps.memberships.values()]
      .filter((membership) => membership.businessId === input.businessId)
      .map((membership): StaffMemberSummary => {
        const user = this.deps.users.get(membership.userId);
        const isYou = membership.userId === actor.user.id;
        return {
          membershipId: membership.id,
          userId: membership.userId,
          displayName: user?.displayName ?? "",
          phone: this.phoneOf(membership.userId),
          role: membership.role,
          isYou,
          confirmedByLink: this.joinedWithLink(membership.id),
          manageable: !isYou && canManageMemberRole(actorRole, membership.role)
        };
      })
      .sort(
        (left, right) =>
          roleOrder.indexOf(left.role) - roleOrder.indexOf(right.role) ||
          left.displayName.localeCompare(right.displayName)
      );
    return {
      businessId: input.businessId,
      members,
      invitations: this.pendingFor(input.businessId, now)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((invitation) => ({ ...invitation, needsReinvite: this.needsReinvite(invitation) })),
      grantableRoles: rolesGrantableBy(actorRole)
    };
  }

  revokeStaffInvitation(input: {
    sessionId: string | null;
    businessId: string;
    invitationId: string;
    now?: Date;
  }): StaffInvitationSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:invite",
      now
    );
    const invitation = this.staffInvitations.get(input.invitationId);
    if (invitation === undefined || invitation.businessId !== input.businessId) {
      throw invitationNotFound();
    }
    if (!rolesGrantableBy(this.roleOf(input.businessId, actor.user.id)).includes(invitation.role)) {
      throw new Cp2Error(403, "staff_role_not_grantable", "You cannot revoke that invitation.");
    }
    this.requireStillPending(invitation, now);
    const revoked = this.close(invitation, "revoked", now);
    this.audit("staff.invitation_revoked", invitation.id, actor.user.id, now, {
      businessId: input.businessId
    });
    return revoked;
  }

  changeStaffRole(input: {
    sessionId: string | null;
    businessId: string;
    membershipId: string;
    role: BusinessRole;
    now?: Date;
  }): StaffMemberSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:invite",
      now
    );
    const actorRole = this.roleOf(input.businessId, actor.user.id);
    const membership = this.requireManageableMember(input, actor, actorRole);
    if (!isBusinessRole(input.role) || !rolesGrantableBy(actorRole).includes(input.role)) {
      throw new Cp2Error(
        403,
        "staff_role_not_grantable",
        "You cannot give someone that role.",
        false,
        {
          grantableRoles: rolesGrantableBy(actorRole)
        }
      );
    }
    if (membership.role !== input.role) {
      const updated: MembershipSummary = { ...membership, role: input.role };
      this.deps.memberships.set(membership.id, updated);
      this.revokeInvitationsNoLongerGrantable(membership.businessId, membership.userId, now);
      this.deps.onMembershipChanged?.(membership.businessId, membership.userId, {
        previousRole: membership.role,
        joined: false,
        at: now.toISOString()
      });
      this.audit("staff.role_changed", membership.id, actor.user.id, now, {
        businessId: input.businessId,
        userId: membership.userId,
        previousRole: membership.role,
        role: input.role
      });
    }
    return this.memberSummary(
      this.deps.memberships.get(membership.id) as MembershipSummary,
      actor.user.id,
      actorRole
    );
  }

  removeStaffMember(input: {
    sessionId: string | null;
    businessId: string;
    membershipId: string;
    now?: Date;
  }): { removed: true; membershipId: string } {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:invite",
      now
    );
    const actorRole = this.roleOf(input.businessId, actor.user.id);
    const membership = this.requireManageableMember(input, actor, actorRole);
    this.deps.memberships.delete(membership.id);
    this.revokeInvitationsNoLongerGrantable(membership.businessId, membership.userId, now);
    this.deps.onMembershipChanged?.(membership.businessId, membership.userId, {
      previousRole: membership.role,
      joined: false,
      at: now.toISOString()
    });
    this.audit("staff.member_removed", membership.id, actor.user.id, now, {
      businessId: input.businessId,
      userId: membership.userId,
      role: membership.role
    });
    return { removed: true, membershipId: membership.id };
  }

  /** A non-owner leaves a business on their own. The owner cannot leave their own business. */
  leaveBusiness(input: { sessionId: string | null; businessId: string; now?: Date }): {
    left: true;
    businessId: string;
  } {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    const membership = this.membershipOf(input.businessId, actor.user.id);
    if (membership === undefined)
      throw new Cp2Error(403, "permission_denied", "Permission denied.");
    if (membership.role === "owner") {
      throw new Cp2Error(409, "owner_cannot_leave", "The owner cannot leave their own business.");
    }
    this.deps.memberships.delete(membership.id);
    this.revokeInvitationsNoLongerGrantable(membership.businessId, membership.userId, now);
    this.deps.onMembershipChanged?.(membership.businessId, membership.userId, {
      previousRole: membership.role,
      joined: false,
      at: now.toISOString()
    });
    this.audit("staff.member_left", membership.id, actor.user.id, now, {
      businessId: input.businessId,
      role: membership.role
    });
    return { left: true, businessId: input.businessId };
  }

  // ---- Invited person side ---------------------------------------------------------------

  listMyStaffInvitations(input: {
    sessionId: string | null;
    now?: Date;
  }): MyStaffInvitationSummary[] {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthenticatedActor(input.sessionId, now);
    return [...this.staffInvitations.values()]
      .filter(
        (invitation) =>
          this.isOpen(invitation, now) &&
          this.matchesActor(invitation, actor.account.id) &&
          this.membershipOf(invitation.businessId, actor.user.id) === undefined
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((invitation) => ({
        id: invitation.id,
        businessId: invitation.businessId,
        businessName: this.deps.businesses.get(invitation.businessId)?.name ?? "",
        role: invitation.role,
        invitedByName: this.deps.users.get(invitation.invitedByUserId)?.displayName ?? "",
        expiresAt: invitation.expiresAt
      }));
  }

  acceptStaffInvitation(input: {
    sessionId: string | null;
    invitationId: string;
    /** The join link's secret, when the person opened the link sent to their number. */
    joinToken?: string | null;
    now?: Date;
  }): {
    invitation: Omit<StaffInvitationSummary, "joinToken">;
    business: BusinessSummary;
    membership: MembershipSummary;
  } {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthenticatedActor(input.sessionId, now);
    const invitation = this.requireMyInvitation(input.invitationId, actor.account.id);
    // A link never grants anything by itself (the identity check above still applies), but a wrong
    // secret is refused rather than silently accepted without proof.
    const withLink = input.joinToken !== undefined && input.joinToken !== null;
    if (withLink && !joinTokenMatches(invitation.joinToken, input.joinToken as string)) {
      throw new Cp2Error(
        403,
        "staff_invitation_link_invalid",
        "This invitation link is not valid. Ask for a new one."
      );
    }
    this.requireStillPending(invitation, now);
    if (!this.isOpen(invitation, now)) {
      // The inviter lost the authority to grant this role, or the business is being removed.
      throw new Cp2Error(
        409,
        "staff_invitation_not_pending",
        "This invitation is no longer valid."
      );
    }
    const existing = this.membershipOf(invitation.businessId, actor.user.id);
    if (existing !== undefined) {
      throw new Cp2Error(
        409,
        "staff_already_member",
        "You are already part of this business.",
        false,
        { membershipId: existing.id, role: existing.role }
      );
    }
    const membership: MembershipSummary = {
      id: randomUUID(),
      businessId: invitation.businessId,
      userId: actor.user.id,
      role: invitation.role
    };
    this.deps.memberships.set(membership.id, membership);
    const accepted: StaffInvitationSummary = {
      ...invitation,
      status: "accepted",
      respondedAt: now.toISOString(),
      acceptedByUserId: actor.user.id,
      membershipId: membership.id,
      acceptedWithLink: withLink
    };
    this.staffInvitations.set(accepted.id, accepted);
    // A new member cannot have legitimate trips yet: clear any left over from an earlier
    // membership whose release did not run (removal releases are fire-and-forget).
    this.deps.onMembershipChanged?.(invitation.businessId, actor.user.id, {
      previousRole: null,
      joined: true,
      at: now.toISOString()
    });
    this.audit("staff.invitation_accepted", invitation.id, actor.user.id, now, {
      businessId: invitation.businessId,
      role: invitation.role,
      membershipId: membership.id,
      viaLink: withLink
    });
    // The invitee never receives the join-link secret.
    const invitationForInvitee: Omit<StaffInvitationSummary, "joinToken"> = { ...accepted };
    delete (invitationForInvitee as Partial<StaffInvitationSummary>).joinToken;
    return {
      invitation: invitationForInvitee,
      business: this.deps.businesses.get(invitation.businessId) as BusinessSummary,
      membership
    };
  }

  declineStaffInvitation(input: { sessionId: string | null; invitationId: string; now?: Date }): {
    declined: true;
    invitationId: string;
  } {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthenticatedActor(input.sessionId, now);
    const invitation = this.requireMyInvitation(input.invitationId, actor.account.id);
    this.requireStillPending(invitation, now);
    this.close(invitation, "declined", now);
    this.audit("staff.invitation_declined", invitation.id, actor.user.id, now, {
      businessId: invitation.businessId
    });
    return { declined: true, invitationId: invitation.id };
  }

  // ---- Snapshot / purge ------------------------------------------------------------------

  snapshot(): StaffInvitationSummary[] {
    return [...this.staffInvitations.values()];
  }

  restore(invitations: StaffInvitationSummary[] | undefined): void {
    this.staffInvitations.clear();
    for (const invitation of invitations ?? [])
      this.staffInvitations.set(invitation.id, invitation);
  }

  deleteForBusiness(businessId: string): number {
    let deleted = 0;
    for (const [id, invitation] of this.staffInvitations) {
      if (invitation.businessId === businessId) {
        this.staffInvitations.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  // ---- Internals -------------------------------------------------------------------------

  private roleOf(businessId: string, userId: string): BusinessRole {
    const membership = this.membershipOf(businessId, userId);
    if (membership === undefined) {
      throw new Cp2Error(403, "permission_denied", "Permission denied for this business.");
    }
    return membership.role;
  }

  private membershipOf(businessId: string, userId: string): MembershipSummary | undefined {
    for (const membership of this.deps.memberships.values()) {
      if (membership.businessId === businessId && membership.userId === userId) return membership;
    }
    return undefined;
  }

  private requireManageableMember(
    input: { businessId: string; membershipId: string },
    actor: AuthenticatedActorView,
    actorRole: BusinessRole
  ): MembershipSummary {
    const membership = this.deps.memberships.get(input.membershipId);
    if (membership === undefined || membership.businessId !== input.businessId) {
      throw new Cp2Error(
        404,
        "staff_member_not_found",
        "That person is not part of this business."
      );
    }
    if (membership.userId === actor.user.id) {
      throw new Cp2Error(
        403,
        "staff_self_change",
        "You cannot change your own role or remove yourself here. Use Leave business instead."
      );
    }
    if (!canManageMemberRole(actorRole, membership.role)) {
      throw new Cp2Error(
        403,
        "staff_member_not_manageable",
        "You cannot change this person's access."
      );
    }
    return membership;
  }

  private memberSummary(
    membership: MembershipSummary,
    viewerUserId: string,
    viewerRole: BusinessRole
  ): StaffMemberSummary {
    const isYou = membership.userId === viewerUserId;
    return {
      membershipId: membership.id,
      userId: membership.userId,
      displayName: this.deps.users.get(membership.userId)?.displayName ?? "",
      phone: this.phoneOf(membership.userId),
      role: membership.role,
      isYou,
      confirmedByLink: this.joinedWithLink(membership.id),
      manageable: !isYou && canManageMemberRole(viewerRole, membership.role)
    };
  }

  /** Whether the member accepted through the join link sent to their number. */
  private joinedWithLink(membershipId: string): boolean {
    for (const invitation of this.staffInvitations.values()) {
      if (invitation.membershipId === membershipId) return invitation.acceptedWithLink === true;
    }
    return false;
  }

  /** The member's sign-in phone (not the editable profile phone), so the owner sees who joined. */
  private phoneOf(userId: string): string | null {
    const user = this.deps.users.get(userId);
    if (user === undefined) return null;
    const account = this.deps.accounts.get(user.accountId);
    if (account?.primaryAuthChannel === "phone") return account.primaryAuthDestination;
    for (const identity of this.deps.accountIdentities()) {
      if (
        identity.accountId === user.accountId &&
        identity.type === "phone" &&
        identity.isPrimary
      ) {
        return identity.normalizedValue;
      }
    }
    return null;
  }

  /**
   * The identities an account may accept an invitation created at `asOf` for. Grogoni signs people in
   * by phone without verifying it, so every phone the account signs in with is the account:
   * - its primary phone (sign-up), its `primaryAuthDestination` (accounts older than the identity
   *   ledger), and any verified phone always count;
   * - a phone later linked to the profile (`PUT /account/phone`: how one-tap accounts add a phone,
   *   and how a number is changed) counts only if it was linked at or before the moment the invitation was created.
   *   So a one-tap owner or someone who changed number is reachable, but an existing account cannot
   *   attach an already-invited number to take the invitation.
   * Emails count only when verified.
   */
  private identitiesOf(
    accountId: string,
    asOf: string
  ): Array<{ channel: StaffInvitationChannel; value: string }> {
    const cutoff = Date.parse(asOf);
    const identities: Array<{ channel: StaffInvitationChannel; value: string }> = [];
    for (const identity of this.deps.accountIdentities()) {
      if (identity.accountId !== accountId) continue;
      if (identity.type === "phone") {
        if (
          identity.isPrimary ||
          identity.verifiedAt !== null ||
          Date.parse(identity.createdAt) <= cutoff
        ) {
          identities.push({ channel: "phone", value: identity.normalizedValue });
        }
      } else if (identity.type === "email" && identity.verifiedAt !== null) {
        identities.push({ channel: "email", value: identity.normalizedValue.toLowerCase() });
      }
    }
    const account = this.deps.accounts.get(accountId);
    if (account?.primaryAuthChannel === "phone") {
      identities.push({ channel: "phone", value: account.primaryAuthDestination });
    }
    return identities;
  }

  /**
   * The invited destination belongs to an account that cannot accept this invitation: the number
   * was linked to it only after the invitation was created. Re-inviting fixes it (the new
   * invitation is newer than the link).
   */
  private needsReinvite(invitation: StaffInvitationSummary): boolean {
    const accounts = new Set<string>();
    for (const identity of this.deps.accountIdentities()) {
      const value =
        identity.type === "email"
          ? identity.normalizedValue.toLowerCase()
          : identity.normalizedValue;
      if (identity.type === invitation.channel && value === invitation.destination) {
        accounts.add(identity.accountId);
      }
    }
    return [...accounts].some((accountId) => !this.matchesActor(invitation, accountId));
  }

  private matchesActor(invitation: StaffInvitationSummary, accountId: string): boolean {
    return this.identitiesOf(accountId, invitation.createdAt).some(
      (identity) =>
        identity.channel === invitation.channel && identity.value === invitation.destination
    );
  }

  private memberForIdentity(
    businessId: string,
    channel: StaffInvitationChannel,
    destination: string,
    asOf: string
  ): MembershipSummary | undefined {
    for (const membership of this.deps.memberships.values()) {
      if (membership.businessId !== businessId) continue;
      const user = this.deps.users.get(membership.userId);
      if (user === undefined) continue;
      if (
        this.identitiesOf(user.accountId, asOf).some(
          (identity) => identity.channel === channel && identity.value === destination
        )
      ) {
        return membership;
      }
    }
    return undefined;
  }

  /** Pending, unexpired, and still backed by an inviter who may grant the role. */
  private isOpen(invitation: StaffInvitationSummary, now: Date): boolean {
    if (invitation.status !== "pending") return false;
    if (Date.parse(invitation.expiresAt) <= now.getTime()) return false;
    if (this.deps.quarantinedBusinessIds.has(invitation.businessId)) return false;
    if (!this.deps.businesses.has(invitation.businessId)) return false;
    const inviter = this.membershipOf(invitation.businessId, invitation.invitedByUserId);
    return inviter !== undefined && rolesGrantableBy(inviter.role).includes(invitation.role);
  }

  private pendingFor(businessId: string, now: Date): StaffInvitationSummary[] {
    return [...this.staffInvitations.values()].filter(
      (invitation) => invitation.businessId === businessId && this.isOpen(invitation, now)
    );
  }

  private requireMyInvitation(invitationId: string, accountId: string): StaffInvitationSummary {
    const invitation = this.staffInvitations.get(invitationId);
    // Someone else's invitation is indistinguishable from a missing one.
    if (invitation === undefined || !this.matchesActor(invitation, accountId)) {
      throw invitationNotFound();
    }
    return invitation;
  }

  private requireStillPending(invitation: StaffInvitationSummary, now: Date): void {
    if (invitation.status !== "pending") {
      throw new Cp2Error(
        409,
        "staff_invitation_not_pending",
        `This invitation was already ${invitation.status}.`,
        false,
        { status: invitation.status }
      );
    }
    if (Date.parse(invitation.expiresAt) <= now.getTime()) {
      throw new Cp2Error(409, "staff_invitation_expired", "This invitation has expired.", false, {
        status: "expired"
      });
    }
  }

  private close(
    invitation: StaffInvitationSummary,
    status: "revoked" | "declined",
    now: Date
  ): StaffInvitationSummary {
    const closed = { ...invitation, status, respondedAt: now.toISOString() };
    this.staffInvitations.set(closed.id, closed);
    return closed;
  }

  /**
   * A person who was removed or demoted keeps no power through invitations they sent: any still
   * pending that they could no longer grant are revoked (acceptance re-checks this as well).
   */
  private revokeInvitationsNoLongerGrantable(businessId: string, userId: string, now: Date): void {
    const membership = this.membershipOf(businessId, userId);
    const grantable = membership === undefined ? [] : rolesGrantableBy(membership.role);
    for (const invitation of this.staffInvitations.values()) {
      if (
        invitation.businessId === businessId &&
        invitation.invitedByUserId === userId &&
        invitation.status === "pending" &&
        !grantable.includes(invitation.role)
      ) {
        this.close(invitation, "revoked", now);
        this.audit("staff.invitation_revoked", invitation.id, userId, now, {
          businessId,
          reason: "inviter_lost_authority"
        });
      }
    }
  }

  private audit(
    type: string,
    aggregateId: string,
    actorId: string,
    now: Date,
    payload: Record<string, unknown>
  ): void {
    this.deps.recordAuditEvent({
      type,
      aggregateType: type.startsWith("staff.invitation") ? "staff_invitation" : "membership",
      aggregateId,
      actorId,
      occurredAt: now.toISOString(),
      payload
    });
  }
}

const roleOrder: BusinessRole[] = [
  "owner",
  "manager",
  "sales_agent",
  "cashier",
  "driver",
  "view_only"
];

function invitationNotFound(): Cp2Error {
  return new Cp2Error(404, "staff_invitation_not_found", "Invitation was not found.");
}

/** Constant-time comparison of a presented join-link secret with the stored one. */
function joinTokenMatches(expected: string | undefined, presented: string): boolean {
  if (expected === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}
