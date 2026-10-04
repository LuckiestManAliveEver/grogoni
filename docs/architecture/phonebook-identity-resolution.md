# Phonebook identity resolution

> People are entities. Applications are capabilities. Identifiers are attributes.

Grogoni does not require an email or social integration as a prerequisite for building a
relationship graph. The user's phone/social contact graph, already owned by
`NetworkDomain` (`services/api/src/cp2/domains/network/store.ts`), is the seed. Email, social
handles, and Grogoni accounts are identities attached to a phonebook contact, not the foundation of
the contact model.

## Existing architecture reused

This is not a new store. `NetworkDomain` already modeled almost everything this needed:
`networkNodes` (the phonebook contacts, called nodes for historical reasons -
`requirePhonebookNode` predates this doc), `externalIdentities`, and `grogoniIdentityLinks`. What was
missing was the fine-grained capability surface and the provenance/confirmation rules for identity
facts that don't come from an owner-initiated sync. This change extends that same domain: no
parallel phonebook was created. See `docs/architecture/commercial-history.md`'s "Existing
architecture reused" section for the sibling decision this mirrors - canonical business contacts
(tenant-scoped, for supplier/customer CRM) stay a separate, already-documented concept from this
one (personal, user-scoped). Neither should be confused with the other or merged.

## Provenance

Every `ExternalIdentitySummary` and `GrogoniIdentityLinkSummary` carries an `IdentityProvenance`:

- `user_entered` - the owner typed it themselves (`addManualIdentity`). Trusted immediately; no
  confirmation step, because the owner's own input already is the confirmation.
- `imported` - came from a phone or social contact sync the owner explicitly triggered
  (`syncPhoneContacts`, `syncSocialNetwork`) or from auto-linking a contact to an existing Grogoni
  account by matching a hashed phone/email against that account's primary auth destination
  (`findGrogoniIdentityLink`).
- `verified` - came from an OAuth-authenticated provider connection (`syncConnectedSocialProvider`,
  or a Google Contacts fetch using a stored OAuth token).
- `observed` - came from an external observation the owner did not directly initiate - today, a
  ComputerRuntime browsing session reading untrusted web content while completing some other task.

## The observed path never mutates the phonebook directly

`NetworkDomain.proposeIdentityCandidate` is the _only_ entry point external observations may use.
It never touches `networkNodes` or `externalIdentities` - it only ever creates a pending
`IdentityCandidateSummary`, with a best-effort `nodeId` guess (an exact, case-insensitive
display-name match - see `findBestNodeMatchForCandidate` - never a fuzzy or partial match, and
never auto-attached). A pending candidate becomes a real identity only through
`confirmIdentityCandidate`, which requires the owner's own pin-verified session and either accepts
the guessed contact, redirects it to a different existing contact (`targetNodeId`), or creates a
brand-new contact (`createNewContact`). `rejectIdentityCandidate` discards a candidate without ever
attaching it. Re-proposing the same observed identity while a candidate is still pending is
idempotent (returns the existing candidate rather than duplicating it); proposing an identity that
is already confirmed is rejected outright.

This is structurally enforced, not just a convention: `computer.*` runtime-tool actions never reach
the capability dispatcher that can call `network.identity.*` (see
`services/api/src/cp2/domains/agent-runtime/capabilities.ts` - every `computer.*` toolName is
intercepted and routed to RuntimeHandoff/the isolated browser provider before the dispatcher's
`switch` is ever reached). An agent acting on a ComputerRuntime observation has to make a separate,
explicit `network.identity.propose` call with a plain-language `evidence` string - it cannot smuggle
a direct phonebook write through the browsing tool call itself.

```text
external observation (e.g. computer.observe)
      |
      v
network.identity.propose  -->  IdentityCandidateSummary (status: pending)
      |
      +-- network.identity.reject  --> discarded, never attached
      |
      v
network.identity.confirm (owner, pin-verified session)
      |
      v
ExternalIdentitySummary (provenance: "observed") attached to a NetworkNodeSummary
```

## Capabilities

All are user-scoped (`requirePinVerifiedSession`, no `businessId`), matching every other
`NetworkDomain` capability:

| Tool name                  | Store method               | Purpose                                                                                                                                                                     |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network.contacts.resolve` | `resolveContact`           | "Who is this?" - resolve a name/phone/email/handle against the owner's own phonebook, ranked phone/email hash match > confirmed handle match > exact name > substring name. |
| `network.identity.list`    | `listIdentityCandidates`   | List pending identity candidates awaiting confirmation.                                                                                                                     |
| `network.identity.propose` | `proposeIdentityCandidate` | Record an observed identity as pending. Never mutates the phonebook.                                                                                                        |
| `network.identity.confirm` | `confirmIdentityCandidate` | Attach a pending candidate's identity to an existing or brand-new contact.                                                                                                  |
| `network.identity.reject`  | `rejectIdentityCandidate`  | Discard a pending candidate.                                                                                                                                                |
| `network.identity.unlink`  | `unlinkIdentity`           | Remove a previously attached identity from a contact (correcting a bad link).                                                                                               |
| `network.identity.add`     | `addManualIdentity`        | Directly attach an owner-authored identity (provenance `user_entered`).                                                                                                     |

`NetworkNodeSummary.externalIdentityIds` is an array (not a single nullable id) precisely so one
contact can accumulate a phone, an email, an Instagram handle, a WhatsApp number, and a linked Grogoni
account without becoming multiple phonebook entries.

## Phonebook sync, discovery and connections

Connecting a phonebook does three things: sync the contacts, show which of them are already on
Grogoni so the owner can connect with them, and invite the rest. Contacts never become a second store:
they stay `networkNodes` in `NetworkDomain`, and connections are one new collection next to them.

### Sync modes

`POST /network/sync/contacts` takes `mode`:

- `replace` (default, unchanged behavior): the input is the whole phonebook. The previous phone
  source and every node imported through it are dropped first.
- `merge`: adds to the active phone source. The web app uses this, because the browser Contact
  Picker returns only the contacts the owner selected: picking A and B, then C, leaves A, B and C.

In both modes a contact whose phone or email hash is already in the source updates that node
(new name, extra hashes) instead of duplicating it, and a name-only contact that later arrives
with a number is upgraded in place.

Each contact may carry every number and email it has (`phones`, `emails`, up to 10 each, in
addition to `phone`/`email`), so someone is found by whichever number they use on Grogoni.
Phonebook entries are messy, so each number is first cleaned (`cleanPhonebookNumber`: Unicode
NFKC for full-width digits, any script's decimal digits (Arabic-Indic, Devanagari, ...) mapped to
ASCII, every dash and minus sign read as a hyphen, invisible direction marks removed, `tel:` prefixes, extensions and
labels such as "(mobile)" dropped, and of a field holding two numbers ("a / b", "a | b", "a or
b") only the first is kept; a bare "/" is part of the number, as in "030/1234567"). Phonebooks store numbers in national format ("0712 345 678"),
so they are read in the owner's country (`ownerPhoneCountry`): the stored phone country, else the
country of the owner's own number, else the device's region, which the web app sends as
`defaultCountry` (for owners who signed in by email or device and have no number of their own).
Numbers with an international prefix parse on their own. A number or email that still does not
parse is dropped from that contact; it never fails the sync.

The response is the graph plus `syncedContactNodeIds`: the node each submitted contact landed on,
in submission order. The server stores only hashes, so the device keeps the raw numbers it needs
for invites (`apps/web/src/phonebook-device-cache.ts`, per user, cleared on logout) and uses these
ids to pair its contacts with server-side discovery. Where the picker is unavailable (iOS Safari,
desktop), the card imports a vCard/CSV export through the same merge sync; a vCard keeps every
number and email on each card. The older "Sync contacts" action that seeds My Network from the
shop's customers also merges, so it never wipes contacts picked from the phonebook.

Limits (all in `services/api/src/cp2/domains/network/store.ts`):

| Limit                        | Value          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contacts per request         | 5,000          | Request size. The web app sends larger phonebooks in 5,000-contact merge batches.                                                                                                                                                                                                                                                                                                                                                    |
| Contacts per phonebook       | 20,000         | Checked before any write, counting only contacts that would be new (a re-synced contact is an update), so a sync is never half applied. Applies to the phone source only: social sources are separate sources and do not count toward it (what they discover is still charged to the budget below).                                                                                                                                  |
| Numbers asked about per user | 25,000 per day | Every sync, social profile list (client-submitted or a provider fetch such as Google Contacts, whose contents the owner controls) and invite request reveals which numbers are on Grogoni. Charged per number or email the owner has not asked about before, so re-syncing a phonebook is free; only requests that succeed are charged. Kept in API process memory, so each API instance has its own window and a restart resets it. |
| Unanswered requests          | 100 per user   | Spam. Applies to a new request, re-asking after a cancel, and asking back after the other side cancelled.                                                                                                                                                                                                                                                                                                                            |

Every request does a fixed number of passes over the shared maps, never one pass per contact:
one discovery pass (accounts, users and memberships, `discoveryPass`), one scan of the owner's
second-degree edges to dedupe nested connections (at most 50 per contact and 5,000 per request),
and one pass over identity links to replace the links of contacts whose Grogoni account changed.
Values are hashed without re-parsing once they are canonical (`hashCanonicalContact`). Gate tests
in `tests/network-phonebook-domain.test.ts` count these passes, so a per-contact scan fails CI.

Measured on the in-memory store:

| Scenario                                                                     | Time    |
| ---------------------------------------------------------------------------- | ------- |
| Sync 5,000 national-format contacts, 20,000 users each with a shop           | ~0.8 s  |
| Graph load, 5,000 linked contacts, 20,000 users with shops                   | ~0.1 s  |
| First graph load after 3,000 contacts joined Grogoni, 100,000 identity links | ~0.1 s  |
| Merge sync relinking 1,000 contacts, 100,000 identity links                  | ~0.15 s |
| Sync with 200 contacts × 10 nested connections, 50,000 other edges           | ~0.1 s  |
| 100 invites against 20,000 existing invites                                  | ~50 ms  |

### Discovery

`NetworkDomain.grogoniDiscoveryIndex` maps `phone:<hash>` / `email:<hash>` (the same hash as
`ContactHashSummary`) to a Grogoni user for every active account: its primary login destination, plus
the user's verified phone and verified email, so a device-first account with a verified phone is
found too. Suspended, locked, pending-deletion and deleted accounts are not discoverable.
The owner's own number is never linked.

Discovery re-runs on every sync, every `GET /network`, and every connection request
(`refreshGrogoniDiscovery`). A contact who signs up after being synced turns into a `grogoni_user` node
without another sync, and a contact whose account is gone, or who no longer holds that number, is
unlinked again.

The hashes are unsalted SHA-256 of canonical numbers. They keep raw numbers out of the database
and its backups, but phone numbers have little entropy, so they are not secret against someone
with database access. The card says only what is true: Grogoni keeps a fingerprint and the last few
digits of each number (`displayHint`), never the full number.

Discovery reveals that a number belongs to someone on Grogoni, not which shop they run. The graph,
`network.contacts.resolve`, the supplier phonebook search, the identity endpoints
(`network.identity.add`, `.confirm`, `.unlink`) and identity links return `grogoniBusinessId`/`grogoniAgentId` (and
`linkedBusinessId`/`linkedAgentId`) only for people the owner is connected with; a connection
summary names the other side's shop only once connected, or when they asked the owner (they chose
to be seen).

### Connections

`NetworkConnectionRecord` (`cp2_network_connections`, migration 105, unique per pair of users)
holds one record per pair of Grogoni users; whoever asked first is the requester. Rules live in
`services/api/src/cp2/domains/network/connections.ts`:

| Endpoint                                   | Rule                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /network/connections {nodeId}`       | The node must be the caller's own direct contact and discovered as another Grogoni user. Asking again returns the same record. If the other side already asked, this accepts it. |
| `POST /network/connections/:id/respond`    | Recipient only. `accept: true` connects; `false` declines.                                                                                                                       |
| `DELETE /network/connections/:id`          | Requester: cancels (withdraws) an unanswered request. Recipient: declines a pending one. Either side: removes an accepted connection.                                            |
| `GET /network/connections`, `GET /network` | Viewer-relative `NetworkConnectionSummary` (`direction`, counterpart name, shop). The owner's own phonebook name for the person wins over their Grogoni display name.            |

A decline is private. Nothing the requester can read changes: status stays `pending`, and
`updatedAt` and `respondedAt` do not move. The recipient no longer sees the request, and can still
connect later by asking, which accepts it.

Cancelling does not delete an unanswered request; it marks it withdrawn (`requesterWithdrawnAt`),
hidden from both sides. Asking again un-hides the same record. So cancel-and-ask cannot put a
declined request in front of the recipient a second time, and it behaves identically whether or
not the recipient had declined, so it cannot be used to detect a decline either. Once a request is
withdrawn, the other side asking starts a fresh request in their direction rather than accepting
one the first person took back.

Connections survive a phonebook `replace` (they reference users, not nodes) and are deleted when
either account is purged. Purging an account does not delete other owners' contacts for that
person: `detachPurgedUsers` unlinks them back to plain contacts (and drops their identity links)
before the purge sweep runs.

The recipient sees waiting requests in the app shell (`ConnectionRequestsPrompt`, next to staff
invitations, rechecked when the app returns to the foreground) and in Phone Contacts, and can
accept or decline from either.

Audit events: `network.connection_requested`, `network.connection_accepted` (`via: response` or
`mutual`), `network.connection_declined`, `network.connection_removed`, and
`network.invite_skipped_existing`.

### Invites

`POST /businesses/:businessId/network/invites` cleans and reads numbers the same way as sync
(owner's country, else `defaultCountry`), charges each number and email it checks to the
discovery budget above (it answers "is this person on Grogoni" just like a sync does), except a
value that is itself the destination of an open invite from this shop (re-sending an invite
asks nothing new; any other number or email on that contact is still charged), then skips any contact whose phone or email belongs to a
Grogoni user and reports how many in `alreadyOnGrogoniCount`; they are connected with, not invited. A
contact whose number and email both fail to parse is skipped and reported in `invalidCount`:
nothing is sent to a value nobody can check. Invites dedupe on the normalized number, so
"+254 722 000 101" and "0722000101" are one invite, including against older invites stored as
typed, and new invites store E.164. The server takes 100 contacts per request; the web app sends
larger selections in batches of 100. The card lists only non-users under "Invite to Grogoni" and
marks contacts already invited. Without a shop, the web app offers the device share sheet with a
Grogoni link instead (and reports nothing shared if the sheet is cancelled).

### The device copy

The web app lists a contact under "Invite to Grogoni" only while its server node still exists: a
contact whose node is gone (the phonebook was disconnected, or replaced from another device) is
not known to be off Grogoni, so it is not offered. Disconnecting the phonebook also clears the device
copy, and logging out clears it for every user.

## What this deliberately does not do

- It does not silently merge two people because their names are similar. `findBestNodeMatchForCandidate`
  only ever proposes an _exact_ case-insensitive display-name match, and even then the result is a
  guess a human still has to confirm.
- It does not require email or a specific social provider to exist before a contact can be
  resolved - phone-only phonebook contacts (from `syncPhoneContacts`) are resolvable by name and
  phone from day one.
- It does not give ComputerRuntime provider code, or any `computer.*` tool call, a direct write
  path into `networkNodes`/`externalIdentities`.
- It does not store raw phone numbers or emails from a phonebook sync on the server, and it does not
  read the whole phonebook in the background: the browser only exposes the contacts the owner
  picks. The Android node app is SMS-only today and has no contacts permission.
- It does not let anyone connect to a person whose number or email they do not already have.
