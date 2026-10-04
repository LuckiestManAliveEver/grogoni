# Staff invitations

Status: implemented. Owners and managers bring salespeople, dispatchers (managers), cashiers and
drivers into their business themselves; the invited person signs in with the invited phone number
(or verified email) and explicitly accepts.

Outcome it moves: before this, memberships other than the business creator's owner role could only
be created in tests, so corridor fulfillment's field-sales, dispatch and driver flows were unusable
in production (docs/architecture/corridor-fulfillment.md §11.6). The end-to-end test
`tests/staff-invitations.test.ts` "brings a salesperson in" is the measurable proof: invite → sign
up → accept → the salesperson can add a shop and is refused fulfillment setup. Every step leaves an
audit event (`staff.invitation_created`, `staff.invitation_accepted`, `staff.invitation_declined`,
`staff.invitation_revoked`, `staff.role_changed`, `staff.member_removed`, `staff.member_left`).

## Decisions (Julien)

| Question                      | Decision                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relation to network invites   | A new membership-invitation concept. Network invites stay "join the Grogoni network" (customer outreach); staff invitations are "join my business as X". |
| How access is granted         | Explicit accept by the invitee. Nothing is granted by inviting.                                                                                          |
| Who invites and manages roles | Owner and manager.                                                                                                                                       |

## Model

- `StaffInvitationSummary` (`packages/shared-types/src/staff.ts`), persisted as the generic Cp2
  collection `staffInvitations` → table `cp2_staff_invitations` (migration 099). Fields: business,
  role, invitee name (owner's label, never used to match), channel (`phone` | `email`),
  destination (E.164 phone or lowercased email), status (`pending` → `accepted` | `declined` |
  `revoked`; a pending invitation stops being acceptable after 7 days), inviter, acceptance (`acceptedByUserId`, `membershipId`).
- Accepting creates an ordinary `MembershipSummary` (`business_memberships`). Every permission
  check already reads memberships per request, so a removal or role change applies to the very
  next request, browser session or MCP token alike. No role is cached anywhere.
- Code: `services/api/src/cp2/domains/staff/{store,routes}.ts` (the `StaffDomain` slice owns the
  invitations; memberships stay in the auth kernel and are injected as the live Map).

## Authority rules (`packages/business-core/src/domains/roles.ts`)

- Permission `membership:invite` (owner, manager) gates inviting, revoking, changing roles and
  removing; `membership:read` (owner, manager) gates the staff list.
- Rank: owner 3, manager 2, every other role 1. `rolesGrantableBy(actor)` = invitable roles
  strictly below the actor; `canManageMemberRole(actor, target)` = target strictly below the actor.
  So a manager grants and manages sales agents, cashiers, drivers and view-only staff, but never
  another manager or the owner; the owner grants manager and below.
- `owner` is never grantable. Nobody changes their own role or removes themselves through the
  management endpoints; non-owners leave with `POST /staff/leave`; the owner cannot leave. So the
  owner can never be removed or demoted, and a business always keeps its owner.
- An invitation only stays usable while its inviter could still grant its role. Removing or
  demoting the inviter revokes their pending invitations they can no longer grant (audited with
  `reason: inviter_lost_authority`), and acceptance re-checks it as a second layer.
- Limits: 50 open invitations per business; one open invitation per destination; inviting an
  existing member is refused; after a decline, the same number or email cannot be re-invited for
  24 hours (no invitation spam).
- Membership loss heals the app: a session context whose active shop the person no longer belongs
  to (removed, left, shop quarantined) is reset to the marketplace on the next read
  (`ensureGrogoniSessionContext`), and the web app forgets a stored shop the account no longer has,
  both when the session context loads and when it restores the shop it last opened at launch
  (`stored-shop.ts`). The same heal applies to an owner whose shop enters the deletion quarantine;
  restoring the shop does not switch them back automatically, they reopen it from "Your shops".

## Trust model

Grogoni signs people in by phone number without verifying it (PIN sign-up and linking a phone to a
one-tap account are both unverified), and login resolves any phone identity of an account. So an
invitation to `+2547…` is an invitation to the Grogoni account that signs in with that number, which
is exactly the trust the rest of the product already places in that account.

What may accept an invitation (`identitiesOf` in `domains/staff/store.ts`):

- the account's primary phone (its sign-up number), its `primaryAuthDestination` (accounts that
  predate the identity ledger), and any verified phone;
- a phone linked to the profile later (`PUT /account/phone`: how one-tap accounts add a phone,
  and how a number is changed) **if it was linked at or before the moment the invitation was
  created**;
- a verified email.

So one-tap owners and people who changed number are reachable, but an existing account cannot
attach an already-invited number afterwards to take the invitation. If the real person links the
invited number to the account they already use after being invited, that account cannot accept
this invitation either: the owner's staff list flags it (`needsReinvite`, "Revoke it and invite
again"), and the new invitation, being newer than the link, works. The staff list shows each
member's sign-in phone, not the editable profile phone, so the owner sees which account joined.

The remaining risk is squatting at sign-up: someone creating a Grogoni account with the invited number
before its real owner does. Once that happens the number belongs to that account for every Grogoni
purpose (the real person can no longer sign up with it), so the invitation adds no new exposure.
Mitigations: nothing is granted without an explicit accept; the owner sees who joined (display
name and sign-in phone); removal is one confirmed tap and effective immediately; invitations expire
after 7 days and can be revoked. The 24-hour cooldown after a decline therefore cannot lock out the
real person either.

**Proof of possession by link.** Every invitation carries a secret join link
(`/?staffInvite=<id>&t=<secret>`, 144 random bits) that only the business's owner and managers see.
The staff card sends it straight to the invited number from the owner's own phone: **Send SMS**
(an `sms:` link to the exact number with the message prefilled) or **WhatsApp** (official `wa.me`
click-to-chat), or by email for email invitations; **Copy link** shares it any other way. Opening
the link and accepting sends the secret with the acceptance; the server compares it in constant
time and records `acceptedWithLink`, and the owner's staff list marks that member **confirmed by
link**, meaning they received the message sent to the invited number, the possession proof that
PIN sign-up lacks. The link never grants anything by itself: the invited sign-in identity is still
required, a stranger holding it gets 404, and a wrong secret (or another invitation's) is refused
with 403 `staff_invitation_link_invalid`. The invitee API never returns the secret. A squatter who
registered the number first cannot get "confirmed by link" unless the real person forwards the
message, so the owner can tell the two apart.

## API

| Method and path                                               | Who                              | Notes                                                           |
| ------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `GET /businesses/:id/staff`                                   | owner, manager                   | Members (with `manageable`), open invitations, `grantableRoles` |
| `POST /businesses/:id/staff/invitations`                      | owner, manager                   | `{ name, role, phone, country? }` or `{ name, role, email }`    |
| `POST /businesses/:id/staff/invitations/:invitationId/revoke` | owner, manager (role they grant) |                                                                 |
| `PATCH /businesses/:id/staff/members/:membershipId`           | owner, manager (below them)      | `{ role }`                                                      |
| `DELETE /businesses/:id/staff/members/:membershipId`          | owner, manager (below them)      |                                                                 |
| `POST /businesses/:id/staff/leave`                            | any non-owner member             |                                                                 |
| `GET /v1/staff-invitations`                                   | the signed-in person             | Their open invitations                                          |
| `POST /v1/staff-invitations/:invitationId/accept`             | the invited account only         | Returns `{ invitation, business, membership }`                  |
| `POST /v1/staff-invitations/:invitationId/decline`            | the invited account only         |                                                                 |

Another account's invitation id, or another business's invitation or membership id, is
indistinguishable from a missing one (404). Phones are normalized with the same functions sign-in
uses (`phone-identity.ts`), so `0712 345 678` with `KE` and `+254712345678` are the same invitee.
Staff management is not exposed over MCP: granting access is deliberately a human action.

## UI

- `apps/web/src/StaffCard.tsx`, in Settings → Business under "Your shops": members, waiting
  invitations (Share, Revoke), invite form (name, phone with country, role with a one-line
  description), role change and confirmed removal where the server says `manageable`. Staff who
  may not manage people get a 403 on the list and see only a confirmed "Leave this business".
- Join links: opening one is captured at app start (`staff-join-link.ts`, before routing; the
  secret is removed from the address bar), survives signing up or logging in, is sent with Accept,
  and tells the person when the link was sent to a different number. Signed-out visitors who
  opened a link see "Sign up or log in with the phone number the invitation was sent to".
- `apps/web/src/StaffInvitationsPrompt.tsx`, in the app shell for every signed-in account,
  including someone who just signed up with no shop of their own: Accept / Decline. It checks again
  whenever the app comes back into view, so a person already signed in sees a new invitation
  without reloading. Accepting refreshes the account's shop list and switches into the joined shop
  without a reload.
- English and Swahili (`apps/web/src/staff-copy.ts`).

## Tests

- `tests/staff-invitations.test.ts` (gate): role rules; identity matching on the domain directly
  (sign-in phone, phone linked before vs after the invitation, verified phone, verified vs
  unverified email, legacy primary-destination accounts), and over HTTP a number changed before the
  invitation; the end-to-end outcome; only the invitee accepts or
  declines, once; revoked/declined/expired refused; an existing member is never offered or given a
  second membership; manager limits including revoke; no self-change, owner cannot leave; removal
  and demotion effective on the next request including MCP; a removed member's session context
  returns to the marketplace; inviter-authority revocation, each of its two layers separately;
  duplicates, members, bad input, local-number normalization, the 50 limit, the decline cooldown
  and its scoping to one business;
  the no-OTP phone-attach squat refused; sign-in phone shown; tenant isolation; non-managers
  refused; quarantine hides and purge deletes invitations; snapshot round trip.
- Mutation testing: an independent reviewer's harness removes each of 21 authorization and
  matching checks in `domains/staff/store.ts` one at a time; every one of them now fails this suite.
- `tests/staff-invitations-postgres.test.ts` (real PostgreSQL): pending, accepted, declined and
  revoked invitations, role changes, removals and leaving all survive a restart; the decline
  cooldown holds after it; a pending invitation is accepted after it.
- Join links (gate): the owner gets the secret, the invitee API never returns it, a wrong or other
  invitation's secret is refused, a stranger holding the link gets 404, a valid link records
  `confirmedByLink` and an audited `viaLink`, in-app acceptance stays unconfirmed; the proof and
  the secret survive a restart on PostgreSQL; `tests/staff-join-link.test.ts` covers link building,
  SMS/WhatsApp/email addressing and encoding, capture and cleanup of the address bar, and expiry;
  the cards send the secret on accept, show the wrong-number notice and the signed-out banner.
- `tests/stored-shop.test.ts`: a device forgets a stored shop the account no longer belongs to,
  takes the server's role for one it still has, and moves to another shop after leaving.
- `tests/staff-cards.test.tsx` (jsdom): list and server-driven controls, invite by phone, role
  change, confirmed removal, revoke, closing the share sheet is not an error, Leave-only view,
  owner never offered Leave, invitee accept and hand-off, decline, error alerts, re-check on focus,
  the shell notices, Swahili parity, mounting.
