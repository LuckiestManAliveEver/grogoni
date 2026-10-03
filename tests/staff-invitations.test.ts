/**
 * Staff invitations (docs/architecture/staff-invitations.md), gate lane: pure role rules, identity
 * matching, and the full HTTP flow on the in-memory store. The frozen rubric is
 * /tmp/staff-invites/critique/rubric.md; each security rule below has its own test.
 */
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store, type Cp2Store } from "../services/api/src/cp2/store";
import { StaffDomain, staffInvitationTtlMs } from "../services/api/src/cp2/domains/staff/store";
import {
  canManageMemberRole,
  invitableRoles,
  rolesGrantableBy
} from "../packages/business-core/src";
import type {
  MembershipSummary,
  MyStaffInvitationSummary,
  StaffOverviewSummary
} from "../packages/shared-types/src";
import {
  createOwner,
  ok,
  request,
  signUp,
  uniquePhone,
  type TestApp,
  type TestOwner
} from "./fixtures/fulfillment-test-helpers";

function setup() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  return { app, store };
}

const staffUrl = (owner: { businessId: string }, path = "") =>
  `/businesses/${owner.businessId}/staff${path}`;

async function invite(
  app: TestApp,
  actor: { businessId: string; cookie: string },
  phone: string,
  role: string,
  name = "New staff"
) {
  return request<{ id: string; code?: string; destination: string; expiresAt: string }>(
    app,
    "POST",
    staffUrl(actor, "/invitations"),
    actor.cookie,
    { phone: `+${phone}`, role, name }
  );
}

/** Invites a fresh phone, signs that person up, and has them accept. */
async function join(app: TestApp, actor: TestOwner, role: string) {
  const phone = uniquePhone();
  const invitation = await invite(app, actor, phone, role);
  expect(invitation.status).toBe(200);
  const person = await signUp(app, phone);
  const accepted = await ok<{ membership: MembershipSummary }>(
    app,
    "POST",
    `/v1/staff-invitations/${invitation.body.id}/accept`,
    person.cookie
  );
  return { ...person, phone, membershipId: accepted.membership.id, businessId: actor.businessId };
}

describe("staff role rules", () => {
  it("lets each role grant and manage only roles strictly below it", () => {
    expect(rolesGrantableBy("owner")).toEqual([
      "manager",
      "sales_agent",
      "cashier",
      "driver",
      "view_only"
    ]);
    expect(rolesGrantableBy("manager")).toEqual(["sales_agent", "cashier", "driver", "view_only"]);
    for (const role of ["sales_agent", "cashier", "driver", "view_only"] as const) {
      expect(rolesGrantableBy(role)).toEqual([]);
      expect(canManageMemberRole(role, "view_only")).toBe(false);
    }
    expect(invitableRoles).not.toContain("owner");
    expect(canManageMemberRole("owner", "manager")).toBe(true);
    expect(canManageMemberRole("manager", "manager")).toBe(false);
    expect(canManageMemberRole("manager", "owner")).toBe(false);
    expect(canManageMemberRole("owner", "owner")).toBe(false);
    expect(canManageMemberRole("manager", "driver")).toBe(true);
  });
});

describe("staff invitation identity matching", () => {
  function domainWith(
    identities: Array<{
      type: string;
      normalizedValue: string;
      verifiedAt: string | null;
      isPrimary?: boolean;
      createdAt?: string;
    }>,
    extraMemberships: MembershipSummary[] = [],
    inviteeAccount?: { primaryAuthChannel: "phone" | "email"; primaryAuthDestination: string }
  ) {
    const memberships = new Map<string, MembershipSummary>([
      ["m-owner", { id: "m-owner", businessId: "b1", userId: "u-owner", role: "owner" }],
      ...extraMemberships.map((membership) => [membership.id, membership] as const)
    ]);
    const domain = new StaffDomain({
      requireAuthorizedSession: () =>
        ({ account: { id: "a-owner" }, user: { id: "u-owner" } }) as never,
      requireAuthenticatedActor: () =>
        ({ account: { id: "a-invitee" }, user: { id: "u-invitee" } }) as never,
      memberships,
      businesses: new Map([
        ["b1", { id: "b1", name: "Shop", language: "en", grogoniId: "grogoni.shop" }]
      ]),
      users: new Map(),
      accounts: new Map(
        inviteeAccount === undefined
          ? []
          : [["a-invitee", { id: "a-invitee", identityLevel: "strong", ...inviteeAccount }]]
      ) as never,
      quarantinedBusinessIds: new Set(),
      accountIdentities: () =>
        identities.map((identity) => ({
          isPrimary: false,
          createdAt: "2000-01-01T00:00:00.000Z",
          ...identity,
          accountId: "a-invitee"
        })),
      recordAuditEvent: () => undefined
    });
    return domain;
  }

  it("matches the invitee's phone identity, and an email only once it is verified", () => {
    const byEmail = domainWith([
      { type: "email", normalizedValue: "rider@example.com", verifiedAt: null }
    ]);
    const emailInvite = byEmail.inviteStaff({
      sessionId: "s",
      businessId: "b1",
      role: "driver",
      inviteeName: "Rider",
      channel: "email",
      destination: "rider@example.com"
    });
    // Unverified: someone merely claiming the address cannot take the invitation.
    expect(byEmail.listMyStaffInvitations({ sessionId: "s" })).toEqual([]);
    expect(() =>
      byEmail.acceptStaffInvitation({ sessionId: "s", invitationId: emailInvite.id })
    ).toThrow(expect.objectContaining({ code: "staff_invitation_not_found" }));

    const verified = domainWith([
      { type: "email", normalizedValue: "rider@example.com", verifiedAt: "2026-01-01T00:00:00Z" }
    ]);
    verified.inviteStaff({
      sessionId: "s",
      businessId: "b1",
      role: "driver",
      inviteeName: "Rider",
      channel: "email",
      destination: "rider@example.com"
    });
    expect(verified.listMyStaffInvitations({ sessionId: "s" })).toHaveLength(1);

    const phoneInvite = {
      sessionId: "s",
      businessId: "b1",
      role: "driver" as const,
      inviteeName: "Rider",
      channel: "phone" as const,
      destination: "+254700000001"
    };
    // The sign-in phone (primary identity) matches, verified or not: it is the account.
    const signIn = domainWith([
      { type: "phone", normalizedValue: "+254700000001", verifiedAt: null, isPrimary: true }
    ]);
    signIn.inviteStaff(phoneInvite);
    expect(signIn.listMyStaffInvitations({ sessionId: "s" })).toHaveLength(1);
    // A number attached to a profile AFTER the invitation (unverified, not primary) does not:
    // an existing account cannot grab an invited number.
    const attached = domainWith([
      {
        type: "phone",
        normalizedValue: "+254700000001",
        verifiedAt: null,
        isPrimary: false,
        createdAt: "2999-01-01T00:00:00.000Z"
      }
    ]);
    const attachedInvite = attached.inviteStaff(phoneInvite);
    expect(attached.listMyStaffInvitations({ sessionId: "s" })).toEqual([]);
    expect(() =>
      attached.acceptStaffInvitation({ sessionId: "s", invitationId: attachedInvite.id })
    ).toThrow(expect.objectContaining({ code: "staff_invitation_not_found" }));
    // One attached BEFORE the invitation does: that is how one-tap accounts add their phone, and
    // how people change number; they sign in with it.
    const linkedEarlier = domainWith([
      {
        type: "phone",
        normalizedValue: "+254700000001",
        verifiedAt: null,
        isPrimary: false,
        createdAt: "2000-01-01T00:00:00.000Z"
      }
    ]);
    linkedEarlier.inviteStaff(phoneInvite);
    expect(linkedEarlier.listMyStaffInvitations({ sessionId: "s" })).toHaveLength(1);
    // A verified secondary phone does, even when linked after the invitation.
    const verifiedPhone = domainWith([
      {
        type: "phone",
        normalizedValue: "+254700000001",
        verifiedAt: "2026-01-01T00:00:00Z",
        isPrimary: false,
        createdAt: "2999-01-01T00:00:00.000Z"
      }
    ]);
    verifiedPhone.inviteStaff(phoneInvite);
    expect(verifiedPhone.listMyStaffInvitations({ sessionId: "s" })).toHaveLength(1);
  });

  it("never creates a second membership when an already-member accepts", () => {
    const domain = domainWith(
      [{ type: "phone", normalizedValue: "+254700000002", verifiedAt: null, isPrimary: true }],
      [{ id: "m-invitee", businessId: "b1", userId: "u-invitee", role: "cashier" }]
    );
    // An invitation that predates the membership (e.g. created before a second invite was taken).
    domain.restore([
      {
        id: "inv-old",
        businessId: "b1",
        role: "driver",
        inviteeName: "Rider",
        channel: "phone",
        destination: "+254700000002",
        status: "pending",
        invitedByUserId: "u-owner",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        respondedAt: null,
        acceptedByUserId: null,
        membershipId: null
      }
    ]);
    // Not even offered: a member is never shown an invitation into their own shop...
    expect(domain.listMyStaffInvitations({ sessionId: "s" })).toEqual([]);
    // ...and accepting it anyway is refused.
    expect(() => domain.acceptStaffInvitation({ sessionId: "s", invitationId: "inv-old" })).toThrow(
      expect.objectContaining({ code: "staff_already_member" })
    );
  });

  it("counts a phone linked at the very moment of the invitation (at or before)", () => {
    const at = new Date("2026-06-01T10:00:00.000Z");
    const sameInstant = domainWith([
      {
        type: "phone",
        normalizedValue: "+254700000004",
        verifiedAt: null,
        isPrimary: false,
        createdAt: at.toISOString()
      }
    ]);
    sameInstant.inviteStaff({
      sessionId: "s",
      businessId: "b1",
      role: "driver",
      inviteeName: "Rider",
      channel: "phone",
      destination: "+254700000004",
      now: at
    });
    expect(sameInstant.listMyStaffInvitations({ sessionId: "s", now: at })).toHaveLength(1);
  });

  it("matches a legacy account whose sign-in phone predates the identity ledger", () => {
    const legacy = domainWith([], [], {
      primaryAuthChannel: "phone",
      primaryAuthDestination: "+254700000003"
    });
    legacy.inviteStaff({
      sessionId: "s",
      businessId: "b1",
      role: "driver",
      inviteeName: "Rider",
      channel: "phone",
      destination: "+254700000003"
    });
    expect(legacy.listMyStaffInvitations({ sessionId: "s" })).toHaveLength(1);
  });
});

describe("staff invitations over HTTP", () => {
  it("brings a salesperson in: invite, sign up, accept, then exactly their role's access", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app, "Invite Wholesale");
    const phone = uniquePhone();
    const invitation = await invite(app, owner, phone, "sales_agent", "Wanjiru");
    expect(invitation.status).toBe(200);
    expect(invitation.body.destination).toBe(`+${phone}`);

    const person = await signUp(app, phone);
    // Nothing is granted before acceptance.
    expect(
      (await request(app, "GET", `/businesses/${owner.businessId}/customers`, person.cookie)).status
    ).toBe(403);
    const mine = await ok<{ invitations: MyStaffInvitationSummary[] }>(
      app,
      "GET",
      "/v1/staff-invitations",
      person.cookie
    );
    expect(mine.invitations).toEqual([
      expect.objectContaining({
        id: invitation.body.id,
        businessName: "Invite Wholesale",
        role: "sales_agent"
      })
    ]);

    await ok(app, "POST", `/v1/staff-invitations/${invitation.body.id}/accept`, person.cookie);
    const shops = await ok<{
      shops: Array<{ business: { id: string }; membership: { role: string } }>;
    }>(app, "GET", "/v1/shops", person.cookie);
    expect(shops.shops).toEqual([
      expect.objectContaining({
        business: expect.objectContaining({ id: owner.businessId }),
        membership: expect.objectContaining({ role: "sales_agent" })
      })
    ]);
    // Allowed for a sales agent: adding a customer (shop).
    expect(
      (
        await request(app, "POST", `/businesses/${owner.businessId}/customers`, person.cookie, {
          name: "Mama Njeri Shop"
        })
      ).status
    ).toBe(200);
    // Refused: fulfillment setup is owner-only.
    expect(
      (
        await request(
          app,
          "PATCH",
          `/businesses/${owner.businessId}/fulfillment/settings`,
          person.cookie,
          { timezone: "Africa/Nairobi" }
        )
      ).status
    ).toBe(403);
    expect((await request(app, "GET", `/v1/staff-invitations`, person.cookie)).body).toEqual({
      invitations: []
    });

    const overview = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(overview.invitations).toEqual([]);
    expect(overview.members).toEqual([
      expect.objectContaining({ role: "owner", isYou: true, manageable: false }),
      expect.objectContaining({
        userId: person.userId,
        role: "sales_agent",
        phone: `+${phone}`,
        isYou: false,
        manageable: true
      })
    ]);
    expect(store.snapshot().auditEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["staff.invitation_created", "staff.invitation_accepted"])
    );
  });

  it("only lets the invited account accept, and never twice", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    const invitation = await invite(app, owner, phone, "driver");
    const stranger = await signUp(app);
    expect(
      (await ok<{ invitations: unknown[] }>(app, "GET", "/v1/staff-invitations", stranger.cookie))
        .invitations
    ).toEqual([]);
    const stolen = await request<{ code: string }>(
      app,
      "POST",
      `/v1/staff-invitations/${invitation.body.id}/accept`,
      stranger.cookie
    );
    expect(stolen).toMatchObject({ status: 404, body: { code: "staff_invitation_not_found" } });

    const person = await signUp(app, phone);
    await ok(app, "POST", `/v1/staff-invitations/${invitation.body.id}/accept`, person.cookie);
    const again = await request<{ code: string }>(
      app,
      "POST",
      `/v1/staff-invitations/${invitation.body.id}/accept`,
      person.cookie
    );
    expect(again).toMatchObject({ status: 409, body: { code: "staff_invitation_not_pending" } });
    const shops = await ok<{ shops: unknown[] }>(app, "GET", "/v1/shops", person.cookie);
    expect(shops.shops).toHaveLength(1);
  });

  it("refuses revoked, declined and expired invitations", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app);
    const revokedPhone = uniquePhone();
    const revoked = await invite(app, owner, revokedPhone, "driver");
    await ok(app, "POST", staffUrl(owner, `/invitations/${revoked.body.id}/revoke`), owner.cookie);
    const revokedPerson = await signUp(app, revokedPhone);
    expect(
      await request(
        app,
        "POST",
        `/v1/staff-invitations/${revoked.body.id}/accept`,
        revokedPerson.cookie
      )
    ).toMatchObject({ status: 409, body: { code: "staff_invitation_not_pending" } });

    const declinedPhone = uniquePhone();
    const declined = await invite(app, owner, declinedPhone, "driver");
    const declinedPerson = await signUp(app, declinedPhone);
    await ok(
      app,
      "POST",
      `/v1/staff-invitations/${declined.body.id}/decline`,
      declinedPerson.cookie
    );
    expect(
      await request(
        app,
        "POST",
        `/v1/staff-invitations/${declined.body.id}/accept`,
        declinedPerson.cookie
      )
    ).toMatchObject({ status: 409, body: { code: "staff_invitation_not_pending" } });

    const latePhone = uniquePhone();
    const late = await invite(app, owner, latePhone, "driver");
    const latePerson = await signUp(app, latePhone);
    // Age just this invitation past its lifetime (the sessions stay valid).
    const snapshot = store.snapshot();
    store.hydrateSnapshot({
      ...snapshot,
      staffInvitations: (snapshot.staffInvitations ?? []).map((entry) =>
        entry.id === late.body.id
          ? { ...entry, expiresAt: new Date(Date.now() - 1000).toISOString() }
          : entry
      )
    });
    expect(Date.parse(late.body.expiresAt) - Date.now()).toBeGreaterThan(
      staffInvitationTtlMs - 60_000
    );
    expect(
      (await ok<{ invitations: unknown[] }>(app, "GET", "/v1/staff-invitations", latePerson.cookie))
        .invitations
    ).toEqual([]);
    expect(
      await request(app, "POST", `/v1/staff-invitations/${late.body.id}/accept`, latePerson.cookie)
    ).toMatchObject({ status: 409, body: { code: "staff_invitation_expired" } });
  });

  it("lets a manager handle staff below them and nothing above", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const manager = await join(app, owner, "manager");
    const otherManager = await join(app, owner, "manager");
    const driver = await join(app, manager, "driver");

    expect((await invite(app, manager, uniquePhone(), "manager")).body).toMatchObject({
      code: "staff_role_not_grantable"
    });
    expect((await invite(app, manager, uniquePhone(), "owner")).status).toBe(403);
    // Manager can move staff between roles below them...
    expect(
      await ok(app, "PATCH", staffUrl(owner, `/members/${driver.membershipId}`), manager.cookie, {
        role: "cashier"
      })
    ).toMatchObject({ role: "cashier" });
    // ...but not promote to manager, nor touch another manager or the owner.
    expect(
      await request(
        app,
        "PATCH",
        staffUrl(owner, `/members/${driver.membershipId}`),
        manager.cookie,
        {
          role: "manager"
        }
      )
    ).toMatchObject({ status: 403, body: { code: "staff_role_not_grantable" } });
    expect(
      await request(
        app,
        "DELETE",
        staffUrl(owner, `/members/${otherManager.membershipId}`),
        manager.cookie
      )
    ).toMatchObject({ status: 403, body: { code: "staff_member_not_manageable" } });
    const overview = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), manager.cookie);
    const ownerRow = overview.members.find((member) => member.role === "owner");
    expect(ownerRow?.manageable).toBe(false);
    expect(overview.grantableRoles).not.toContain("manager");
    expect(
      await request(
        app,
        "DELETE",
        staffUrl(owner, `/members/${ownerRow?.membershipId}`),
        manager.cookie
      )
    ).toMatchObject({ status: 403, body: { code: "staff_member_not_manageable" } });
    // The owner can promote staff to manager.
    expect(
      await ok(app, "PATCH", staffUrl(owner, `/members/${driver.membershipId}`), owner.cookie, {
        role: "manager"
      })
    ).toMatchObject({ role: "manager" });
  });

  it("never lets anyone change their own role, and the owner cannot leave", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const overview = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    const own = overview.members[0]?.membershipId;
    expect(
      await request(app, "PATCH", staffUrl(owner, `/members/${own}`), owner.cookie, {
        role: "manager"
      })
    ).toMatchObject({ status: 403, body: { code: "staff_self_change" } });
    expect(
      await request(app, "DELETE", staffUrl(owner, `/members/${own}`), owner.cookie)
    ).toMatchObject({
      status: 403,
      body: { code: "staff_self_change" }
    });
    expect(await request(app, "POST", staffUrl(owner, "/leave"), owner.cookie)).toMatchObject({
      status: 409,
      body: { code: "owner_cannot_leave" }
    });
    const driver = await join(app, owner, "driver");
    await ok(app, "POST", staffUrl(owner, "/leave"), driver.cookie);
    expect((await ok<{ shops: unknown[] }>(app, "GET", "/v1/shops", driver.cookie)).shops).toEqual(
      []
    );
  });

  it("takes removal and demotion into effect on the next request, MCP included", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const agent = await join(app, owner, "sales_agent");
    const token = await request<{ accessToken: string }>(
      app,
      "POST",
      "/v1/mcp/tokens",
      agent.cookie,
      { name: "Agent", scopes: ["mcp:read"], shopId: owner.businessId },
      { origin: "http://localhost:5173" }
    );
    expect(token.status).toBe(200);
    const customers = `/businesses/${owner.businessId}/customers`;
    expect((await request(app, "GET", customers, agent.cookie)).status).toBe(200);

    // Demoted to driver: customer data is no longer theirs to read.
    await ok(app, "PATCH", staffUrl(owner, `/members/${agent.membershipId}`), owner.cookie, {
      role: "driver"
    });
    expect((await request(app, "GET", customers, agent.cookie)).status).toBe(403);

    await ok(app, "DELETE", staffUrl(owner, `/members/${agent.membershipId}`), owner.cookie);
    expect(
      (
        await request(
          app,
          "GET",
          `/businesses/${owner.businessId}/fulfillment/settings`,
          agent.cookie
        )
      ).status
    ).toBe(403);
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token.body.accessToken}`,
        "content-type": "application/json"
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" }
        }
      })
    });
    const sessionId = String(mcp.headers["mcp-session-id"]);
    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token.body.accessToken}`,
        "content-type": "application/json",
        "mcp-session-id": sessionId
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "grogoni.query_catalogue",
          arguments: { shopId: owner.businessId, query: "x" }
        }
      })
    });
    const outcome = call.json() as { result?: { isError: boolean }; error?: unknown };
    expect(outcome.error !== undefined || outcome.result?.isError === true).toBe(true);
  });

  it("revokes pending invitations a removed or demoted inviter could no longer grant", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app);
    const manager = await join(app, owner, "manager");
    const phone = uniquePhone();
    const pending = await invite(app, manager, phone, "driver");
    expect(pending.status).toBe(200);
    await ok(app, "DELETE", staffUrl(owner, `/members/${manager.membershipId}`), owner.cookie);
    // Layer 1: removing the inviter revokes what they sent, recorded as such.
    expect(
      store.snapshot().staffInvitations?.find((entry) => entry.id === pending.body.id)?.status
    ).toBe("revoked");
    expect(
      store
        .snapshot()
        .auditEvents.some(
          (event) =>
            event.type === "staff.invitation_revoked" &&
            (event.payload as { reason?: string }).reason === "inviter_lost_authority"
        )
    ).toBe(true);
    const person = await signUp(app, phone);
    expect(
      (await ok<{ invitations: unknown[] }>(app, "GET", "/v1/staff-invitations", person.cookie))
        .invitations
    ).toEqual([]);
    expect(
      await request(app, "POST", `/v1/staff-invitations/${pending.body.id}/accept`, person.cookie)
    ).toMatchObject({ status: 409, body: { code: "staff_invitation_not_pending" } });
  });

  it("re-checks the inviter's authority at acceptance, whatever changed it", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app);
    const manager = await join(app, owner, "manager");
    const phone = uniquePhone();
    const pending = await invite(app, manager, phone, "driver");
    // Layer 2: the manager's role changes by a path that does not revoke (e.g. restored data).
    const snapshot = store.snapshot();
    store.hydrateSnapshot({
      ...snapshot,
      memberships: snapshot.memberships.map((membership) =>
        membership.id === manager.membershipId ? { ...membership, role: "driver" } : membership
      )
    });
    const person = await signUp(app, phone);
    expect(
      (await ok<{ invitations: unknown[] }>(app, "GET", "/v1/staff-invitations", person.cookie))
        .invitations
    ).toEqual([]);
    expect(
      await request(app, "POST", `/v1/staff-invitations/${pending.body.id}/accept`, person.cookie)
    ).toMatchObject({ status: 409, body: { code: "staff_invitation_not_pending" } });
    expect((await ok<{ shops: unknown[] }>(app, "GET", "/v1/shops", person.cookie)).shops).toEqual(
      []
    );
  });

  it("refuses duplicates, existing members, bad input and too many open invitations", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    await invite(app, owner, phone, "driver");
    expect((await invite(app, owner, phone, "cashier")).body).toMatchObject({
      code: "staff_invitation_pending"
    });
    const member = await join(app, owner, "driver");
    expect((await invite(app, owner, member.phone, "cashier")).body).toMatchObject({
      code: "staff_already_member"
    });
    for (const body of [
      { role: "driver", name: "X" },
      { role: "driver", name: "X", phone: "+254700000000", email: "a@b.co" },
      { role: "driver", name: "X", email: "not-an-email" },
      { role: "driver", name: "X", phone: "12" },
      { role: "chief", name: "X", phone: `+${uniquePhone()}` },
      { role: "driver", name: "", phone: `+${uniquePhone()}` }
    ]) {
      expect(
        (await request(app, "POST", staffUrl(owner, "/invitations"), owner.cookie, body)).status
      ).toBe(400);
    }
    // Local numbers with a country normalize to the same E.164 identity sign-in uses.
    const local = await request<{ destination: string }>(
      app,
      "POST",
      staffUrl(owner, "/invitations"),
      owner.cookie,
      { role: "driver", name: "Local", phone: "0712 345 678", country: "KE" }
    );
    expect(local.body.destination).toBe("+254712345678");
    // The owner already has 3 open (phone, local, and none for the joined member).
    let status = 200;
    for (let index = 0; index < 60 && status === 200; index += 1) {
      status = (await invite(app, owner, uniquePhone(), "driver")).status;
    }
    expect(status).toBe(409);
    const overview = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(overview.invitations).toHaveLength(50);
  });

  it("does not let a manager revoke an invitation above their authority", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const manager = await join(app, owner, "manager");
    const managerInvite = await invite(app, owner, uniquePhone(), "manager");
    expect(
      await request(
        app,
        "POST",
        staffUrl(owner, `/invitations/${managerInvite.body.id}/revoke`),
        manager.cookie
      )
    ).toMatchObject({ status: 403, body: { code: "staff_role_not_grantable" } });
    const driverInvite = await invite(app, owner, uniquePhone(), "driver");
    await ok(
      app,
      "POST",
      staffUrl(owner, `/invitations/${driverInvite.body.id}/revoke`),
      manager.cookie
    );
  });

  it("lets only the invited account decline, and pauses re-inviting after a decline", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    const invitation = await invite(app, owner, phone, "driver");
    const stranger = await signUp(app);
    expect(
      await request(
        app,
        "POST",
        `/v1/staff-invitations/${invitation.body.id}/decline`,
        stranger.cookie
      )
    ).toMatchObject({ status: 404, body: { code: "staff_invitation_not_found" } });
    const person = await signUp(app, phone);
    await ok(app, "POST", `/v1/staff-invitations/${invitation.body.id}/decline`, person.cookie);
    expect((await invite(app, owner, phone, "driver")).body).toMatchObject({
      code: "staff_invitation_recently_declined"
    });
  });

  it("does not let an existing account claim an invited number by attaching it to its profile", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    const invitation = await invite(app, owner, phone, "manager");
    const squatter = await signUp(app);
    const attached = await request(app, "PUT", "/account/phone", squatter.cookie, {
      phoneNumber: `+${phone}`,
      country: "KE"
    });
    expect(attached.status).toBe(200);
    expect(
      (await ok<{ invitations: unknown[] }>(app, "GET", "/v1/staff-invitations", squatter.cookie))
        .invitations
    ).toEqual([]);
    expect(
      await request(
        app,
        "POST",
        `/v1/staff-invitations/${invitation.body.id}/accept`,
        squatter.cookie
      )
    ).toMatchObject({ status: 404 });
  });

  it("reaches someone who linked or changed their number before being invited", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const person = await signUp(app);
    const newNumber = uniquePhone();
    await ok(app, "PUT", "/account/phone", person.cookie, {
      phoneNumber: `+${newNumber}`,
      country: "KE"
    });
    const invitation = await invite(app, owner, newNumber, "driver");
    expect(
      (
        await ok<{ invitations: Array<{ id: string }> }>(
          app,
          "GET",
          "/v1/staff-invitations",
          person.cookie
        )
      ).invitations.map((entry) => entry.id)
    ).toEqual([invitation.body.id]);
    await ok(app, "POST", `/v1/staff-invitations/${invitation.body.id}/accept`, person.cookie);
    // And, now a member under that number, they cannot be invited again.
    expect((await invite(app, owner, newNumber, "cashier")).body).toMatchObject({
      code: "staff_already_member"
    });
  });

  it("tells the owner to re-invite when the number was linked to an account after inviting", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    const first = await invite(app, owner, phone, "driver");
    const before = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(before.invitations.find((entry) => entry.id === first.body.id)?.needsReinvite).toBe(
      false
    );
    // The person adds the number to the account they already use (e.g. a one-tap account).
    const person = await signUp(app);
    await ok(app, "PUT", "/account/phone", person.cookie, {
      phoneNumber: `+${phone}`,
      country: "KE"
    });
    const flagged = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(flagged.invitations.find((entry) => entry.id === first.body.id)?.needsReinvite).toBe(
      true
    );
    // Revoke and invite again: the new invitation is newer than the link, so it works.
    await ok(app, "POST", staffUrl(owner, `/invitations/${first.body.id}/revoke`), owner.cookie);
    const second = await invite(app, owner, phone, "driver");
    const after = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(after.invitations.find((entry) => entry.id === second.body.id)?.needsReinvite).toBe(
      false
    );
    await ok(app, "POST", `/v1/staff-invitations/${second.body.id}/accept`, person.cookie);
  });

  it("scopes the decline cooldown to the business that was declined", async () => {
    const { app } = setup();
    const shopA = await createOwner(app, "Shop A");
    const shopB = await createOwner(app, "Shop B");
    const phone = uniquePhone();
    const fromA = await invite(app, shopA, phone, "driver");
    const person = await signUp(app, phone);
    await ok(app, "POST", `/v1/staff-invitations/${fromA.body.id}/decline`, person.cookie);
    expect((await invite(app, shopA, phone, "driver")).status).toBe(409);
    expect((await invite(app, shopB, phone, "driver")).status).toBe(200);
  });

  it("shows the owner each member's sign-in phone, not an editable profile phone", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const member = await join(app, owner, "driver");
    await ok(app, "PUT", "/account/phone", member.cookie, {
      phoneNumber: `+${uniquePhone()}`,
      country: "KE"
    });
    const overview = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(overview.members.find((entry) => entry.userId === member.userId)?.phone).toBe(
      `+${member.phone}`
    );
  });

  it("returns a removed member's app to the marketplace instead of a shop they lost", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const member = await join(app, owner, "sales_agent");
    await ok(app, "PATCH", "/v1/session/context", member.cookie, {
      mode: "seller",
      activeShopId: owner.businessId
    });
    await ok(app, "DELETE", staffUrl(owner, `/members/${member.membershipId}`), owner.cookie);
    const context = await ok<{ mode: string; activeShopId: string | null; shops: unknown[] }>(
      app,
      "GET",
      "/v1/session/context",
      member.cookie
    );
    expect(context).toMatchObject({ mode: "marketplace", activeShopId: null, shops: [] });
    // And the app can keep working with its context.
    expect(
      (
        await request(app, "PATCH", "/v1/session/context", member.cookie, {
          activeSurface: "conversation"
        })
      ).status
    ).toBe(200);
  });

  it("gives the owner a secret join link and records proof when it is used", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    const created = await request<{ id: string; joinToken: string }>(
      app,
      "POST",
      staffUrl(owner, "/invitations"),
      owner.cookie,
      { phone: `+${phone}`, role: "driver", name: "Otieno" }
    );
    expect(created.body.joinToken).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    const overview = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(overview.invitations[0]?.joinToken).toBe(created.body.joinToken);

    const person = await signUp(app, phone);
    // The invitee never receives the secret from the API.
    const mine = await ok<{ invitations: Array<Record<string, unknown>> }>(
      app,
      "GET",
      "/v1/staff-invitations",
      person.cookie
    );
    expect(mine.invitations[0]).not.toHaveProperty("joinToken");
    // A wrong secret is refused and grants nothing.
    const wrong = await request<{ code: string }>(
      app,
      "POST",
      `/v1/staff-invitations/${created.body.id}/accept`,
      person.cookie,
      { joinToken: "not-the-secret-000000000" }
    );
    expect(wrong).toMatchObject({ status: 403, body: { code: "staff_invitation_link_invalid" } });
    expect((await ok<{ shops: unknown[] }>(app, "GET", "/v1/shops", person.cookie)).shops).toEqual(
      []
    );
    // A stranger holding the right link still cannot use it: the invited number is required.
    const stranger = await signUp(app);
    expect(
      await request(
        app,
        "POST",
        `/v1/staff-invitations/${created.body.id}/accept`,
        stranger.cookie,
        {
          joinToken: created.body.joinToken
        }
      )
    ).toMatchObject({ status: 404 });

    const accepted = await ok<{ invitation: Record<string, unknown> }>(
      app,
      "POST",
      `/v1/staff-invitations/${created.body.id}/accept`,
      person.cookie,
      { joinToken: created.body.joinToken }
    );
    expect(accepted.invitation).not.toHaveProperty("joinToken");
    expect(accepted.invitation).toMatchObject({ acceptedWithLink: true });
    const members = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(members.members.find((member) => member.userId === person.userId)).toMatchObject({
      confirmedByLink: true
    });
    expect(
      store
        .snapshot()
        .auditEvents.some(
          (event) =>
            event.type === "staff.invitation_accepted" &&
            (event.payload as { viaLink?: boolean }).viaLink === true
        )
    ).toBe(true);
  });

  it("does not accept one invitation's secret for another, and marks in-app joins unconfirmed", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const phone = uniquePhone();
    const other = await request<{ joinToken: string }>(
      app,
      "POST",
      staffUrl(owner, "/invitations"),
      owner.cookie,
      { phone: `+${uniquePhone()}`, role: "driver", name: "Other" }
    );
    const mineInvite = await invite(app, owner, phone, "driver");
    const person = await signUp(app, phone);
    expect(
      await request(
        app,
        "POST",
        `/v1/staff-invitations/${mineInvite.body.id}/accept`,
        person.cookie,
        {
          joinToken: other.body.joinToken
        }
      )
    ).toMatchObject({ status: 403 });
    await ok(app, "POST", `/v1/staff-invitations/${mineInvite.body.id}/accept`, person.cookie);
    const members = await ok<StaffOverviewSummary>(app, "GET", staffUrl(owner), owner.cookie);
    expect(members.members.find((member) => member.userId === person.userId)).toMatchObject({
      confirmedByLink: false
    });
  });

  it("keeps every business's staff and invitations to itself", async () => {
    const { app } = setup();
    const owner = await createOwner(app, "Shop A");
    const other = await createOwner(app, "Shop B");
    const invitation = await invite(app, owner, uniquePhone(), "driver");
    const member = await join(app, owner, "driver");
    expect((await request(app, "GET", staffUrl(owner), other.cookie)).status).toBe(403);
    expect(
      (
        await request(
          app,
          "POST",
          staffUrl(owner, `/invitations/${invitation.body.id}/revoke`),
          other.cookie
        )
      ).status
    ).toBe(403);
    // Through their own business, another business's ids look missing.
    expect(
      await request(
        app,
        "POST",
        staffUrl(other, `/invitations/${invitation.body.id}/revoke`),
        other.cookie
      )
    ).toMatchObject({ status: 404 });
    expect(
      await request(app, "DELETE", staffUrl(other, `/members/${member.membershipId}`), other.cookie)
    ).toMatchObject({ status: 404 });
  });

  it("shows staff management only to roles that may use it", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const agent = await join(app, owner, "sales_agent");
    expect((await request(app, "GET", staffUrl(owner), agent.cookie)).status).toBe(403);
    expect((await invite(app, agent, uniquePhone(), "driver")).status).toBe(403);
  });

  it("hides invitations of a shop being deleted and purges them with the shop", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app, "Closing Down");
    const phone = uniquePhone();
    const pending = await invite(app, owner, phone, "driver");
    const shops = await ok<{ shops: Array<{ business: { id: string; grogoniId: string } }> }>(
      app,
      "GET",
      "/v1/shops",
      owner.cookie
    );
    const grogoniId = shops.shops[0]?.business.grogoniId;
    const deletion = await ok<{ request: { id: string } }>(
      app,
      "POST",
      `/businesses/${owner.businessId}/shop-deletion/request`,
      owner.cookie,
      { shopId: grogoniId }
    );
    await ok(
      app,
      "POST",
      `/businesses/${owner.businessId}/shop-deletion/${deletion.request.id}/finalize`,
      owner.cookie,
      { pin: "1234", acknowledgement: true, idempotencyKey: "close-shop" }
    );
    // Quarantined: the invitation can no longer be seen or accepted.
    const person = await signUp(app, phone);
    expect(
      (await ok<{ invitations: unknown[] }>(app, "GET", "/v1/staff-invitations", person.cookie))
        .invitations
    ).toEqual([]);
    expect(
      await request(app, "POST", `/v1/staff-invitations/${pending.body.id}/accept`, person.cookie)
    ).toMatchObject({ status: 409 });
    expect(store.purgeExpiredShopDeletions(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(
      1
    );
    expect(store.snapshot().staffInvitations).toEqual([]);
  });

  it("persists invitations through a snapshot round trip", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app);
    const invitation = await invite(app, owner, uniquePhone(), "driver");
    const restored: Cp2Store = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(restored.snapshot().staffInvitations).toEqual([
      expect.objectContaining({ id: invitation.body.id, status: "pending", role: "driver" })
    ]);
  });
});
