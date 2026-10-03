/**
 * Staff invitations (docs/architecture/staff-invitations.md): an owner or manager invites a phone
 * number or email into their business with a role; nothing is granted until the invited person
 * signs in with that identity and explicitly accepts.
 */
import type { BusinessRole } from "./index.js";

export type StaffInvitationChannel = "phone" | "email";

/**
 * `pending` until the invitee answers or it is revoked. A pending invitation past `expiresAt` can
 * no longer be accepted (409 `staff_invitation_expired`) and is not listed; its stored status
 * stays `pending`.
 */
export type StaffInvitationStatus = "pending" | "accepted" | "declined" | "revoked";

export interface StaffInvitationSummary {
  id: string;
  businessId: string;
  role: BusinessRole;
  /** Who the owner said this is, for their own list. Free text, never used to match. */
  inviteeName: string;
  channel: StaffInvitationChannel;
  /** E.164 phone or lowercased email - the exact identity that may accept. */
  destination: string;
  status: StaffInvitationStatus;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  /** Set on acceptance: which account took it and the membership it created. */
  acceptedByUserId: string | null;
  membershipId: string | null;
  /**
   * Secret for the invitation's join link (`/?staffInvite=<id>&t=<joinToken>`), sent by the owner
   * to the invited number by SMS or WhatsApp. Only the business's owner/managers see it; the
   * invitee API never returns it. Absent on invitations created before join links existed.
   */
  joinToken?: string;
  /** Accepted through the join link: the person received the message sent to the invited number. */
  acceptedWithLink?: boolean;
}

/**
 * A pending invitation in the owner's list. `needsReinvite` is true when the invited number is now
 * linked to a Grogoni account only AFTER the invitation was created (someone added it to an existing
 * account): that account cannot accept this invitation, and the person cannot sign up with the
 * number any more, so the owner should revoke it and invite again.
 */
export interface StaffOverviewInvitation extends StaffInvitationSummary {
  needsReinvite: boolean;
}

export interface StaffMemberSummary {
  membershipId: string;
  userId: string;
  displayName: string;
  /** The member's sign-in phone (not the editable profile phone): exactly who accepted. */
  phone: string | null;
  role: BusinessRole;
  isYou: boolean;
  /** Joined by opening the invitation link sent to their number: proof they hold that phone. */
  confirmedByLink: boolean;
  /** Whether the viewer may change this member's role or remove them. */
  manageable: boolean;
}

export interface StaffOverviewSummary {
  businessId: string;
  members: StaffMemberSummary[];
  /** Pending invitations, newest first. Answered, revoked and expired ones are not listed. */
  invitations: StaffOverviewInvitation[];
  /** Roles the viewer may invite someone into or change someone to. */
  grantableRoles: BusinessRole[];
}

/** An invitation as the invited person sees it. */
export interface MyStaffInvitationSummary {
  id: string;
  businessId: string;
  businessName: string;
  role: BusinessRole;
  invitedByName: string;
  expiresAt: string;
}
