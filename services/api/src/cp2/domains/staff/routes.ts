/**
 * HTTP surface for staff invitations (docs/architecture/staff-invitations.md). Routes parse and
 * normalize input, then delegate to the StaffDomain via Cp2Store; no rule lives here. Phone
 * numbers are normalized with the same functions sign-in uses, so an invitation matches exactly
 * the identity the invitee signs in with.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isBusinessRole } from "@grogoni/business-core";
import type { BusinessRole, StaffInvitationChannel } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import {
  parseRequestBody,
  parseString,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";
import {
  normalizeInternationalOwnerPhoneNumber,
  normalizeOwnerPhoneNumber
} from "../../phone-identity.js";

interface InvitationParams extends BusinessParams {
  invitationId: string;
}

interface MemberParams extends BusinessParams {
  membershipId: string;
}

interface MyInvitationParams {
  invitationId: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function parseRole(value: unknown): BusinessRole {
  const role = parseString(value, "role");
  if (!isBusinessRole(role)) {
    throw new Cp2Error(400, "staff_role_invalid", "Role is not supported.");
  }
  return role;
}

/** Exactly one of `phone` (with optional ISO `country`) or `email`. */
export function parseStaffDestination(body: Record<string, unknown>): {
  channel: StaffInvitationChannel;
  destination: string;
} {
  const hasPhone = typeof body.phone === "string" && body.phone.trim() !== "";
  const hasEmail = typeof body.email === "string" && body.email.trim() !== "";
  if (hasPhone === hasEmail) {
    throw new Cp2Error(
      400,
      "staff_destination_invalid",
      "Give either a phone number or an email address."
    );
  }
  if (hasEmail) {
    const email = (body.email as string).trim().toLowerCase();
    if (email.length > 254 || !emailPattern.test(email)) {
      throw new Cp2Error(400, "staff_destination_invalid", "Enter a valid email address.");
    }
    return { channel: "email", destination: email };
  }
  const phone = (body.phone as string).trim();
  const country =
    typeof body.country === "string" && body.country.trim() !== ""
      ? body.country.trim()
      : undefined;
  try {
    const normalized =
      country === undefined
        ? normalizeInternationalOwnerPhoneNumber(phone)
        : normalizeOwnerPhoneNumber(phone, country);
    return { channel: "phone", destination: normalized.e164 };
  } catch {
    throw new Cp2Error(400, "INVALID_PHONE_NUMBER", "Enter a valid phone number.");
  }
}

export function registerStaffRoutes(app: FastifyInstance, store: Cp2Store): void {
  const session = (request: FastifyRequest) => readSessionCookie(request.headers.cookie);

  app.get(
    "/businesses/:businessId/staff",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getStaffOverview({
          sessionId: session(request),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/staff/invitations",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.inviteStaff({
          sessionId: session(request),
          businessId: request.params.businessId,
          role: parseRole(body.role),
          inviteeName: parseString(body.name, "name"),
          ...parseStaffDestination(body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/staff/invitations/:invitationId/revoke",
    async (request: FastifyRequest<{ Params: InvitationParams }>, reply) => {
      try {
        return store.revokeStaffInvitation({
          sessionId: session(request),
          businessId: request.params.businessId,
          invitationId: request.params.invitationId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/staff/members/:membershipId",
    async (request: FastifyRequest<{ Params: MemberParams; Body: unknown }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.changeStaffRole({
          sessionId: session(request),
          businessId: request.params.businessId,
          membershipId: request.params.membershipId,
          role: parseRole(body.role)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/businesses/:businessId/staff/members/:membershipId",
    async (request: FastifyRequest<{ Params: MemberParams }>, reply) => {
      try {
        return store.removeStaffMember({
          sessionId: session(request),
          businessId: request.params.businessId,
          membershipId: request.params.membershipId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/staff/leave",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.leaveBusiness({
          sessionId: session(request),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/v1/staff-invitations", async (request, reply) => {
    try {
      return { invitations: store.listMyStaffInvitations({ sessionId: session(request) }) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/v1/staff-invitations/:invitationId/accept",
    async (request: FastifyRequest<{ Params: MyInvitationParams; Body: unknown }>, reply) => {
      try {
        const body =
          request.body === undefined || request.body === null ? {} : parseRequestBody(request.body);
        const joinToken = typeof body.joinToken === "string" ? body.joinToken.trim() : null;
        return store.acceptStaffInvitation({
          sessionId: session(request),
          invitationId: request.params.invitationId,
          joinToken: joinToken === "" ? null : joinToken
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/staff-invitations/:invitationId/decline",
    async (request: FastifyRequest<{ Params: MyInvitationParams }>, reply) => {
      try {
        return store.declineStaffInvitation({
          sessionId: session(request),
          invitationId: request.params.invitationId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
