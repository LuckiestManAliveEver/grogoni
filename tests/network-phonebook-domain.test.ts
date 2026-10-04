import { describe, expect, it, vi } from "vitest";
import { NetworkDomain } from "../services/api/src/cp2/domains/network/store";
import { normalizeContactPhone } from "../services/api/src/cp2/domains/network/shared";
import type {
  AccountSummary,
  AuthenticatedActorView,
  NetworkConnectionSummary,
  NetworkGraphSummary,
  UserSummary
} from "../packages/shared-types/src";

// NetworkDomain rules for phonebook sync, discovery and connections, exercised directly so each
// limit and privacy rule can be pinned without the HTTP stack. HTTP flows live in
// network-phonebook-connections.test.ts. See docs/architecture/phonebook-identity-resolution.md.

interface Person {
  id: string;
  phone?: string;
  account?: Partial<AccountSummary>;
  user?: Partial<UserSummary>;
}

function fixture(
  people: Person[],
  limits?: ConstructorParameters<typeof NetworkDomain>[0]["limits"]
) {
  const accounts = new Map<string, AccountSummary>();
  const users = new Map<string, UserSummary>();
  const userByAccount = new Map<string, string>();
  const audit = vi.fn();

  const add = (person: Person) => {
    const accountId = `acct-${person.id}`;
    accounts.set(accountId, {
      id: accountId,
      identityLevel: "verified_contact",
      primaryAuthChannel: "phone",
      primaryAuthDestination: person.phone ?? `+2547990${String(accounts.size).padStart(5, "0")}`,
      ...person.account
    });
    users.set(person.id, {
      id: person.id,
      accountId,
      displayName: person.id,
      language: "en",
      ...person.user
    });
    userByAccount.set(accountId, person.id);
  };
  people.forEach(add);

  // The session is whoever `as` names; production resolves it from the cookie.
  const actor = (sessionId: string | null): AuthenticatedActorView => {
    const user = users.get(sessionId ?? "");
    if (user === undefined) throw new Error("no session");
    return { user, account: accounts.get(user.accountId)! };
  };
  const domain = new NetworkDomain({
    requirePinVerifiedSession: (sessionId) => actor(sessionId),
    accounts,
    userByAccount,
    memberships: new Map(),
    businesses: new Map(),
    userIdentities: new Map(),
    users,
    recordAuditEvent: audit,
    ...(limits === undefined ? {} : { limits })
  });

  const sync = (
    as: string,
    contacts: Array<Record<string, unknown>>,
    mode: "merge" | "replace" = "merge",
    defaultCountry?: string
  ) =>
    domain.syncPhoneContacts({
      sessionId: as,
      mode,
      ...(defaultCountry === undefined ? {} : { defaultCountry }),
      contacts: contacts as unknown as Parameters<NetworkDomain["syncPhoneContacts"]>[0]["contacts"]
    });
  const nodeFor = (as: string, name: string, phone: string) =>
    sync(as, [{ name, phone }]).syncedContactNodeIds![0]!;
  const request = (as: string, nodeId: string) =>
    domain.requestConnection({ sessionId: as, nodeId });
  const list = (as: string) => domain.listConnections({ sessionId: as });

  return { domain, accounts, users, audit, add, sync, nodeFor, request, list };
}

const directByName = (graph: NetworkGraphSummary) =>
  new Map(graph.nodes.filter((node) => node.degree === 1).map((node) => [node.displayName, node]));

describe("phonebook normalization", () => {
  it("reads national numbers in the owner's country, keeps every number, and drops bad values", () => {
    const { sync } = fixture([
      { id: "alice", phone: "+254711000001", user: { phoneCountryCode: "KE" } },
      { id: "bob", phone: "+254711000002" },
      { id: "work", phone: "+254733000003" },
      { id: "yank", phone: "+14155550123" }
    ]);

    const graph = sync("alice", [
      { name: "Bob", phone: "0711 000 002" },
      // Grogoni knows this person by their second number.
      { name: "Two Phones", phone: "0722000999", phones: ["+254 733 000 003"] },
      { name: "Abroad", phone: "+1 (415) 555-0123" },
      // A bad number or email loses that value, not the contact and not the whole sync.
      { name: "Garbage", phone: "not a number", email: "nope" }
    ]);

    const byName = directByName(graph);
    expect(byName.get("Bob")?.grogoniUserId).toBe("bob");
    expect(byName.get("Two Phones")?.grogoniUserId).toBe("work");
    expect(byName.get("Two Phones")?.contactHashIds).toHaveLength(2);
    expect(byName.get("Abroad")?.grogoniUserId).toBe("yank");
    expect(byName.get("Garbage")).toMatchObject({ grogoniUserId: null, contactHashIds: [] });
  });

  it("derives the owner's country from their own number when none is stored", () => {
    expect(normalizeContactPhone("0711000002", "KE")).toBe("+254711000002");
    expect(normalizeContactPhone("0711000002", null)).toBeNull();
    const { sync } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    expect(
      directByName(sync("alice", [{ name: "Bob", phone: "0711000002" }])).get("Bob")?.grogoniUserId
    ).toBe("bob");
  });
});

describe("phonebook number cleaning and owner country", () => {
  it("reads numbers wrapped in direction marks, tel: prefixes, extensions, labels and full-width digits", () => {
    const { sync } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const messy = [
      "\u202A+254 711 000 002\u202C",
      "\u200E0711000002",
      "tel:0711000002;ext=1",
      "0711000002 ext 12",
      "0711 000 002 (mobile)",
      "\uFF10\uFF17\uFF11\uFF11\uFF10\uFF10\uFF10\uFF10\uFF10\uFF12",
      "Mobile: 0711-000-002"
    ];
    const graph = sync(
      "alice",
      messy.map((phone, index) => ({ name: `Bob ${index}`, phone }))
    );

    // All seven spellings are Bob's one number: one contact, found on Grogoni.
    const direct = graph.nodes.filter((node) => node.degree === 1);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.grogoniUserId).toBe("bob");
  });

  it("reads any script's digits and any dash", () => {
    const { sync } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const spellings = [
      "\u0660\u0667\u0661\u0661\u0660\u0660\u0660\u0660\u0660\u0662", // Arabic-Indic
      "\u06F0\u06F7\u06F1\u06F1\u06F0\u06F0\u06F0\u06F0\u06F0\u06F2", // Extended Arabic-Indic
      "\u0966\u096D\u0967\u0967\u0966\u0966\u0966\u0966\u0966\u0968", // Devanagari
      "0711\u2011000\u2011002", // non-breaking hyphens
      "0711\u2212000002", // minus sign
      "\u00AD0711000002" // soft hyphen
    ];
    const graph = sync(
      "alice",
      spellings.map((phone, index) => ({ name: `Bob ${index}`, phone }))
    );
    const direct = graph.nodes.filter((node) => node.degree === 1);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.grogoniUserId).toBe("bob");
  });

  it("uses the owner's own number, then the device region, to read national numbers", () => {
    const fromOwnNumber = fixture([
      {
        id: "alice",
        account: { primaryAuthChannel: "device", primaryAuthDestination: "d-1" },
        user: { phoneNumberE164: "+254711000001" }
      },
      { id: "bob", phone: "+254711000002" }
    ]);
    expect(
      directByName(fromOwnNumber.sync("alice", [{ name: "Bob", phone: "0711000002" }])).get("Bob")
        ?.grogoniUserId
    ).toBe("bob");

    const emailOwner = () =>
      fixture([
        {
          id: "erin",
          account: { primaryAuthChannel: "email", primaryAuthDestination: "erin@example.com" }
        },
        { id: "bob", phone: "+254711000002" }
      ]);
    // No country known and none sent: a national number cannot be read.
    expect(
      directByName(emailOwner().sync("erin", [{ name: "Bob", phone: "0711000002" }])).get("Bob")
        ?.grogoniUserId
    ).toBeNull();
    expect(
      directByName(
        emailOwner().sync("erin", [{ name: "Bob", phone: "0711000002" }], "merge", "ke")
      ).get("Bob")?.grogoniUserId
    ).toBe("bob");
    // A bogus region is ignored rather than trusted.
    expect(
      directByName(
        emailOwner().sync("erin", [{ name: "Bob", phone: "0711000002" }], "merge", "ZZ")
      ).get("Bob")?.grogoniUserId
    ).toBeNull();
  });

  it("reads the first of two numbers in one field, and keeps a slash inside a number", () => {
    expect(normalizeContactPhone("0711 000 002 / 0722 000 003", "KE")).toBe("+254711000002");
    expect(normalizeContactPhone("0711 000 002 | 0722 000 003", "KE")).toBe("+254711000002");
    expect(normalizeContactPhone("0711 000 002 or 0722 000 003", "KE")).toBe("+254711000002");
    expect(normalizeContactPhone("0711 000 002 and 0722 000 003", "KE")).toBe("+254711000002");
    expect(normalizeContactPhone("0711000002 mobile", "KE")).toBe("+254711000002");
    expect(normalizeContactPhone("+49 30/1234567", "DE")).toBe("+49301234567");
  });

  it("keeps at most 10 numbers per contact", () => {
    const { sync } = fixture([{ id: "alice", phone: "+254711000001" }]);
    const phones = Array.from(
      { length: 12 },
      (_, index) => `+2547220000${String(index).padStart(2, "0")}`
    );
    const graph = sync("alice", [{ name: "Many", phone: phones[0], phones: phones.slice(1) }]);
    expect(directByName(graph).get("Many")?.contactHashIds).toHaveLength(10);
  });
});

describe("discovery", () => {
  it("finds device-first accounts by verified phone or email, never inactive accounts, and unlinks departed ones", () => {
    const { sync, accounts, domain } = fixture([
      { id: "alice", phone: "+254711000001" },
      {
        id: "device-verified",
        account: { primaryAuthChannel: "device", primaryAuthDestination: "device-123" },
        user: { phoneNumberE164: "+254711000020", phoneVerificationStatus: "verified" }
      },
      {
        id: "device-unverified",
        account: { primaryAuthChannel: "device", primaryAuthDestination: "device-456" },
        user: { phoneNumberE164: "+254711000021", phoneVerificationStatus: "unverified" }
      },
      {
        id: "email-verified",
        phone: "+254711000022",
        user: { emailAddress: "Verified@Example.com", emailVerificationStatus: "verified" }
      },
      { id: "suspended", phone: "+254711000023", account: { status: "suspended" } }
    ]);

    const byName = directByName(
      sync("alice", [
        { name: "Device verified", phone: "+254711000020" },
        { name: "Device unverified", phone: "+254711000021" },
        { name: "Email verified", email: "verified@example.com" },
        { name: "Suspended", phone: "+254711000023" }
      ])
    );
    expect(byName.get("Device verified")?.grogoniUserId).toBe("device-verified");
    expect(byName.get("Device unverified")?.grogoniUserId).toBeNull();
    expect(byName.get("Email verified")?.grogoniUserId).toBe("email-verified");
    expect(byName.get("Suspended")?.grogoniUserId).toBeNull();

    accounts.set("acct-device-verified", {
      ...accounts.get("acct-device-verified")!,
      status: "deleted"
    });
    const after = domain.getNetworkGraph({ sessionId: "alice" });
    expect(directByName(after).get("Device verified")).toMatchObject({
      kind: "external_contact",
      grogoniUserId: null
    });
    expect(after.identityLinks.some((link) => link.linkedUserId === "device-verified")).toBe(false);
  });

  it("lets the owner connect to a contact who joined after the sync, without reloading the graph", () => {
    const { sync, add, request } = fixture([{ id: "alice", phone: "+254711000001" }]);
    const nodeId = sync("alice", [{ name: "Late", phone: "+254711000050" }])
      .syncedContactNodeIds![0]!;
    add({ id: "late", phone: "+254711000050" });

    expect(request("alice", nodeId)).toMatchObject({
      status: "pending",
      counterpartUserId: "late"
    });
  });
});

describe("connection rules", () => {
  it("refuses the owner's own node and second-degree nodes", () => {
    const { domain, sync, request } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const graph = sync("alice", [
      { name: "Bob", phone: "+254711000002", connections: [{ name: "Bob's supplier" }] }
    ]);
    const ownerNode = graph.nodes.find((node) => node.degree === 0)!;
    const secondDegree = graph.nodes.find((node) => node.degree === 2)!;

    expect(ownerNode.grogoniUserId).toBe("alice");
    expect(() => request("alice", ownerNode.id)).toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
    expect(() => request("alice", secondDegree.id)).toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
    expect(domain.listConnections({ sessionId: "alice" })).toEqual([]);
  });

  it("keeps a decline invisible to the requester, byte for byte", () => {
    const { nodeFor, request, list, domain } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const sent = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    const before = list("alice");

    domain.respondToConnection({
      sessionId: "bob",
      connectionId: sent.id,
      accept: false,
      now: new Date(Date.now() + 60_000)
    });

    expect(list("alice")).toEqual(before);
    expect(list("bob")).toEqual([]);
  });

  it("cancel-and-ask behaves the same whether or not the recipient declined, and never re-asks after a decline", () => {
    const { nodeFor, request, list, domain } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" },
      { id: "carol", phone: "+254711000003" }
    ]);
    const toBob = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    const toCarol = request("alice", nodeFor("alice", "Carol", "+254711000003"));
    domain.respondToConnection({ sessionId: "bob", connectionId: toBob.id, accept: false });

    for (const sent of [toBob, toCarol]) {
      domain.removeConnection({ sessionId: "alice", connectionId: sent.id });
    }
    expect(list("alice")).toEqual([]);
    expect(list("carol")).toEqual([]);

    const againBob = request("alice", toBob.nodeId!);
    const againCarol = request("alice", toCarol.nodeId!);
    // Same shape for both: the requester cannot tell who declined.
    expect(againBob).toEqual({ ...toBob });
    expect(againCarol).toEqual({ ...toCarol });
    // Bob already said no: he is not asked again. Carol never answered: she sees it again.
    expect(list("bob")).toEqual([]);
    expect(list("carol").map((connection) => connection.id)).toEqual([toCarol.id]);
  });

  it("after a cancel, the other side asking is a new request, not an acceptance", () => {
    const { nodeFor, request, list, domain } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const sent = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    domain.removeConnection({ sessionId: "alice", connectionId: sent.id });

    const reversed = request("bob", nodeFor("bob", "Alice", "+254711000001"));
    expect(reversed).toMatchObject({ status: "pending", direction: "outgoing" });
    expect(list("alice")).toEqual([
      expect.objectContaining({
        status: "pending",
        direction: "incoming",
        counterpartUserId: "bob"
      })
    ]);
  });

  it("treats the recipient removing a pending request as a decline", () => {
    const { nodeFor, request, list, domain, audit } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const sent = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    domain.removeConnection({ sessionId: "bob", connectionId: sent.id });

    expect(list("bob")).toEqual([]);
    expect(list("alice")).toEqual([expect.objectContaining({ id: sent.id, status: "pending" })]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "network.connection_declined" })
    );
  });

  it("caps unanswered outgoing requests, counting declined ones until they are cancelled", () => {
    const people = ["bob", "carol", "dan"].map((id, index) => ({
      id,
      phone: `+25471100001${index}`
    }));
    const { nodeFor, request, domain } = fixture(
      [{ id: "alice", phone: "+254711000001" }, ...people],
      { maxPendingOutgoingConnections: 2 }
    );
    const nodes = people.map((person) => nodeFor("alice", person.id, person.phone!));
    const first = request("alice", nodes[0]!);
    request("alice", nodes[1]!);
    domain.respondToConnection({ sessionId: "bob", connectionId: first.id, accept: false });

    expect(() => request("alice", nodes[2]!)).toThrow(expect.objectContaining({ statusCode: 429 }));
    domain.removeConnection({ sessionId: "alice", connectionId: first.id });
    expect(request("alice", nodes[2]!)).toMatchObject({ status: "pending" });
  });

  it("applies the cap to re-asking after a cancel and to asking back after the other side cancelled", () => {
    const { nodeFor, request, domain } = fixture(
      [
        { id: "alice", phone: "+254711000001" },
        { id: "bob", phone: "+254711000002" },
        { id: "carol", phone: "+254711000003" }
      ],
      { maxPendingOutgoingConnections: 1 }
    );
    const bobNode = nodeFor("alice", "Bob", "+254711000002");
    const toBob = request("alice", bobNode);
    domain.removeConnection({ sessionId: "alice", connectionId: toBob.id });
    request("alice", nodeFor("alice", "Carol", "+254711000003"));

    // Re-asking Bob would make two visible requests.
    expect(() => request("alice", bobNode)).toThrow(expect.objectContaining({ statusCode: 429 }));

    // Bob uses his one slot on Carol.
    const bobToCarol = request("bob", nodeFor("bob", "Carol", "+254711000003"));
    expect(bobToCarol.status).toBe("pending");
    // Alice's request to Bob is withdrawn; Bob asking Alice back would be his second request.
    expect(() => request("bob", nodeFor("bob", "Alice", "+254711000001"))).toThrow(
      expect.objectContaining({ statusCode: 429 })
    );
  });

  it("drops connections whose other side no longer exists", () => {
    const { nodeFor, request, list, domain, users } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const sent = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    domain.respondToConnection({ sessionId: "bob", connectionId: sent.id, accept: true });
    users.delete("bob");

    expect(list("alice")).toEqual([]);
    expect(
      (domain.getNetworkGraph({ sessionId: "alice" }).connections ??
        []) as NetworkConnectionSummary[]
    ).toEqual([]);
  });
});

describe("identity endpoints", () => {
  it("confirming an observed identity does not reveal the contact's shop", () => {
    const { domain, sync } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    // Give Bob a shop through the fixture's business maps.
    const deps = (
      domain as unknown as {
        deps: { memberships: Map<string, unknown>; businesses: Map<string, unknown> };
      }
    ).deps;
    deps.businesses.set("biz-bob", {
      id: "biz-bob",
      grogoniId: "grogoni.bob",
      name: "Bob Hardware"
    });
    deps.memberships.set("m-bob", {
      id: "m-bob",
      userId: "bob",
      businessId: "biz-bob",
      role: "owner"
    });
    sync("alice", [{ name: "Bob", phone: "+254711000002" }]);

    const candidate = domain.proposeIdentityCandidate({
      sessionId: "alice",
      provider: "instagram",
      providerSubject: "@bob",
      displayName: "Bob",
      evidence: "seen on a supplier page"
    });
    const confirmed = domain.confirmIdentityCandidate({
      sessionId: "alice",
      candidateId: candidate.id
    });
    expect(confirmed).toMatchObject({
      grogoniUserId: "bob",
      grogoniBusinessId: null,
      grogoniAgentId: null
    });
  });
});

describe("shops of discovered contacts", () => {
  const withShops = () => {
    const f = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "bob", phone: "+254711000002" }
    ]);
    const deps = (
      f.domain as unknown as {
        deps: { memberships: Map<string, unknown>; businesses: Map<string, unknown> };
      }
    ).deps;
    const giveShop = (id: string, name: string) => {
      deps.businesses.set(`biz-${id}`, { id: `biz-${id}`, grogoniId: `grogoni.${id}`, name });
      deps.memberships.set(`m-${id}`, {
        id: `m-${id}`,
        userId: "bob",
        businessId: `biz-${id}`,
        role: "owner"
      });
    };
    return { ...f, giveShop };
  };

  it("picks up a shop the contact opens after being discovered, on the next graph load", () => {
    const { domain, sync, giveShop } = withShops();
    const nodeId = sync("alice", [{ name: "Bob", phone: "+254711000002" }])
      .syncedContactNodeIds![0]!;
    expect(domain.networkNodesMap.get(nodeId)?.grogoniBusinessId).toBeNull();

    giveShop("hardware", "Bob Hardware");
    domain.getNetworkGraph({ sessionId: "alice" });
    expect(domain.networkNodesMap.get(nodeId)).toMatchObject({
      grogoniBusinessId: "biz-hardware",
      grogoniAgentId: "grogoni.hardware"
    });
  });

  it("shows the first shop of someone with two", () => {
    const { domain, nodeFor, request, list, giveShop } = withShops();
    giveShop("first", "Bob First");
    giveShop("second", "Bob Second");
    const sent = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    domain.respondToConnection({ sessionId: "bob", connectionId: sent.id, accept: true });

    expect(list("alice")[0]).toMatchObject({ counterpartBusinessName: "Bob First" });
    expect(domain.networkNodesMap.get(sent.nodeId!)?.grogoniBusinessId).toBe("biz-first");
  });
});

describe("account purge", () => {
  it("unlinks other owners' contacts when only the linked shop is purged", () => {
    const { domain, sync } = fixture([
      { id: "zara", phone: "+254711000009" },
      { id: "xavier", phone: "+254711000003" }
    ]);
    const deps = (
      domain as unknown as {
        deps: { memberships: Map<string, unknown>; businesses: Map<string, unknown> };
      }
    ).deps;
    // Xavier works at Yusuf's shop: that shop is his primary one.
    deps.businesses.set("biz-yusuf", {
      id: "biz-yusuf",
      grogoniId: "grogoni.yusuf",
      name: "Yusuf Traders"
    });
    deps.memberships.set("m-x", {
      id: "m-x",
      userId: "xavier",
      businessId: "biz-yusuf",
      role: "cashier"
    });
    const nodeId = sync("zara", [{ name: "Xavier", phone: "+254711000003" }])
      .syncedContactNodeIds![0]!;
    expect(domain.networkNodesMap.get(nodeId)?.grogoniBusinessId).toBe("biz-yusuf");

    // Yusuf's account is purged: his shop is in the purge scope, Xavier is not.
    expect(domain.detachPurgedUsers(new Set(["yusuf", "biz-yusuf"]), new Date())).toBe(1);
    expect(domain.networkNodesMap.get(nodeId)).toMatchObject({
      grogoniUserId: null,
      grogoniBusinessId: null,
      grogoniAgentId: null,
      kind: "external_contact"
    });
    expect([...domain.grogoniIdentityLinksMap.values()]).toEqual([]);
  });
});

describe("abuse limits", () => {
  it("refuses syncs past the daily budget without writing anything, and does not charge refused syncs", () => {
    const { sync, domain } = fixture([{ id: "alice", phone: "+254711000001" }], {
      phonebookSyncDailyBudget: 3,
      maxPhonebookContacts: 2
    });
    sync("alice", [
      { name: "A", phone: "+254722000001" },
      { name: "B", phone: "+254722000002" }
    ]);

    expect(() =>
      sync("alice", [
        { name: "C", phone: "+254722000003" },
        { name: "D", phone: "+254722000004" }
      ])
    ).toThrow(expect.objectContaining({ statusCode: 429, code: "network_sync_rate_limited" }));
    // Refused by the contact cap: not charged, so one more contact still fits the budget.
    expect(() => sync("alice", [{ name: "C", phone: "+254722000003" }])).toThrow(
      expect.objectContaining({ statusCode: 400, code: "network_contacts_limit" })
    );
    expect(sync("alice", [{ name: "A renamed", phone: "+254722000001" }]).nodes).toBeDefined();
    expect(
      domain
        .getDirectNetwork({ sessionId: "alice" })
        .map((node) => node.displayName)
        .sort()
    ).toEqual(["A renamed", "B"]);
  });

  it("counts only new contacts against the phonebook cap, so a full phonebook can still be re-synced", () => {
    const { sync, domain } = fixture([{ id: "alice", phone: "+254711000001" }], {
      maxPhonebookContacts: 2
    });
    const both = [
      { name: "A", phone: "+254722000001" },
      { name: "B", email: "b@example.com" }
    ];
    sync("alice", both);

    // Same two people, different spellings, plus an in-batch duplicate: nothing new.
    expect(() =>
      sync(
        "alice",
        [
          { name: "A again", phone: "0722000001", phones: ["+254722000001"] },
          { name: "B", email: "B@Example.com" },
          { name: "B", email: "b@example.com" }
        ],
        "merge",
        "KE"
      )
    ).not.toThrow();
    expect(() => sync("alice", [{ name: "C", phone: "+254722000003" }])).toThrow(
      expect.objectContaining({ code: "network_contacts_limit" })
    );
    expect(domain.getDirectNetwork({ sessionId: "alice" })).toHaveLength(2);
    // A full replace is still allowed: it starts the phonebook over.
    expect(
      directByName(sync("alice", [{ name: "C", phone: "+254722000003" }], "replace")).size
    ).toBe(1);
  });

  it("refuses more contacts per request than the server takes", () => {
    const { sync } = fixture([{ id: "alice", phone: "+254711000001" }], {
      maxPhonebookSyncContacts: 2
    });
    expect(() => sync("alice", [{ name: "A" }, { name: "B" }, { name: "C" }])).toThrow(
      expect.objectContaining({ statusCode: 400, code: "network_contacts_too_many" })
    );
  });
  it("charges the budget per number asked about, not per contact", () => {
    const { sync } = fixture([{ id: "alice", phone: "+254711000001" }], {
      phonebookSyncDailyBudget: 3
    });
    expect(() =>
      sync("alice", [
        {
          name: "Many",
          phone: "+254722000001",
          phones: ["+254722000002", "+254722000003", "+254722000004"]
        }
      ])
    ).toThrow(expect.objectContaining({ statusCode: 429 }));
    expect(() => sync("alice", [{ name: "One", phone: "+254722000001" }])).not.toThrow();
  });

  it("gives social profiles the same budget, and client-submitted ones the per-request cap", () => {
    const setup = () =>
      fixture([{ id: "alice", phone: "+254711000001" }], {
        phonebookSyncDailyBudget: 4,
        maxPhonebookSyncContacts: 2
      }).domain;
    const profiles = (count: number, from = 0) =>
      Array.from({ length: count }, (_, index) => ({
        name: `P${from + index}`,
        handle: `p${from + index}`,
        phone: `+2547220000${String(from + index).padStart(2, "0")}`
      }));

    const client = setup();
    expect(() =>
      client.syncSocialNetwork({ sessionId: "alice", provider: "whatsapp", profiles: profiles(3) })
    ).toThrow(expect.objectContaining({ code: "network_contacts_too_many" }));
    client.syncSocialNetwork({ sessionId: "alice", provider: "whatsapp", profiles: profiles(2) });
    client.syncSocialNetwork({
      sessionId: "alice",
      provider: "whatsapp",
      profiles: profiles(2, 2)
    });
    expect(() =>
      client.syncSocialNetwork({
        sessionId: "alice",
        provider: "whatsapp",
        profiles: profiles(1, 4)
      })
    ).toThrow(expect.objectContaining({ code: "network_sync_rate_limited" }));

    // A provider fetch arrives whole (no per-request cap) but is still within the budget.
    const provider = setup();
    expect(() =>
      provider.syncSocialNetwork({
        sessionId: "alice",
        provider: "google",
        provenance: "verified",
        profiles: profiles(4)
      })
    ).not.toThrow();
  });

  it("charges invite discovery lookups to the same budget, and only when committed", () => {
    const { domain } = fixture(
      [
        { id: "alice", phone: "+254711000001" },
        { id: "bob", phone: "+254711000002" }
      ],
      { phonebookSyncDailyBudget: 2 }
    );
    const now = new Date();
    const two = [
      { channel: "phone" as const, value: "+254711000002" },
      { channel: "phone" as const, value: "+254711000009" }
    ];
    const first = domain.createDiscoveryLookup({ userId: "alice", values: two, now });
    expect(first.find("phone", "+254711000002")).toBe("bob");
    expect(first.find("phone", "+254711000009")).toBeNull();
    // Not committed (the request failed): nothing charged.
    const second = domain.createDiscoveryLookup({ userId: "alice", values: two, now });
    second.commit();
    expect(() =>
      domain.createDiscoveryLookup({
        userId: "alice",
        values: [{ channel: "email", value: "x@example.com" }],
        now
      })
    ).toThrow(expect.objectContaining({ statusCode: 429 }));
  });
  it("charges only numbers the owner has not asked about before, including provider fetches", () => {
    const { sync, domain } = fixture([{ id: "alice", phone: "+254711000001" }], {
      phonebookSyncDailyBudget: 3
    });
    const three = [
      { name: "A", phone: "+254722000001" },
      { name: "B", phone: "+254722000002" },
      { name: "C", phone: "+254722000003" }
    ];
    sync("alice", three);
    // Re-syncing the same phonebook, even as a replace, asks nothing new.
    sync("alice", three, "replace");
    sync("alice", three);
    // A provider fetch is charged like any other sync: the owner controls what is in it.
    expect(() =>
      domain.syncSocialNetwork({
        sessionId: "alice",
        provider: "google",
        provenance: "verified",
        profiles: [{ name: "New", phone: "+254722000009" }]
      })
    ).toThrow(expect.objectContaining({ statusCode: 429 }));
  });

  it("frees a cap slot when a request is accepted", () => {
    const { nodeFor, request, domain } = fixture(
      [
        { id: "alice", phone: "+254711000001" },
        { id: "bob", phone: "+254711000002" },
        { id: "carol", phone: "+254711000003" }
      ],
      { maxPendingOutgoingConnections: 1 }
    );
    const toBob = request("alice", nodeFor("alice", "Bob", "+254711000002"));
    domain.respondToConnection({ sessionId: "bob", connectionId: toBob.id, accept: true });
    expect(request("alice", nodeFor("alice", "Carol", "+254711000003")).status).toBe("pending");
  });

  it("counts a contact repeated inside one batch once against the phonebook cap", () => {
    const { sync } = fixture([{ id: "alice", phone: "+254711000001" }], {
      maxPhonebookContacts: 2
    });
    sync("alice", [{ name: "A", phone: "+254722000001" }]);
    expect(() =>
      sync(
        "alice",
        [
          { name: "C", phone: "+254722000003" },
          { name: "C again", phone: "0722000003" }
        ],
        "merge",
        "KE"
      )
    ).not.toThrow();
  });

  it("keeps each number on one contact when a merged contact spans two", () => {
    const { sync } = fixture([{ id: "alice", phone: "+254711000001" }]);
    sync("alice", [
      { name: "Home", phone: "+254722000001" },
      { name: "Work", phone: "+254722000002" }
    ]);
    const graph = sync("alice", [
      { name: "Both", phone: "+254722000001", phones: ["+254722000002"] }
    ]);
    const hashes = graph.nodes
      .filter((node) => node.degree === 1)
      .flatMap((node) => node.contactHashIds);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
  it("scans memberships a constant number of times per graph load, however many contacts link", () => {
    const people = Array.from({ length: 60 }, (_, index) => ({
      id: `u${index}`,
      phone: `+2547330${String(index).padStart(5, "0")}`
    }));
    const { domain, sync } = fixture([{ id: "alice", phone: "+254711000001" }, ...people]);
    const deps = (
      domain as unknown as {
        deps: { memberships: Map<string, unknown>; businesses: Map<string, unknown> };
      }
    ).deps;
    for (const person of people) {
      deps.businesses.set(`b-${person.id}`, {
        id: `b-${person.id}`,
        grogoniId: `grogoni.${person.id}`,
        name: person.id
      });
      deps.memberships.set(`m-${person.id}`, {
        id: `m-${person.id}`,
        userId: person.id,
        businessId: `b-${person.id}`,
        role: "owner"
      });
    }
    sync(
      "alice",
      people.map((person) => ({ name: person.id, phone: person.phone }))
    );

    const values = vi.spyOn(deps.memberships, "values");
    const graph = domain.getNetworkGraph({ sessionId: "alice" });

    expect(
      graph.nodes.filter((node) => node.grogoniUserId !== null && node.degree === 1)
    ).toHaveLength(60);
    expect(values.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("dedupes nested connections with one scan of edges, and caps them per request", () => {
    const { domain, sync } = fixture([{ id: "alice", phone: "+254711000001" }], {
      maxPhonebookSyncContacts: 300
    });
    const nested = Array.from({ length: 200 }, (_, index) => ({ name: `Supplier ${index}` }));
    sync("alice", [{ name: "Hub", phone: "+254722000001", connections: nested }]);

    const values = vi.spyOn(domain.networkEdgesMap, "values");
    const again = sync("alice", [
      { name: "Hub", phone: "+254722000001", connections: [...nested, { name: "supplier 0" }] }
    ]);
    // Same 200 names (case-insensitive): nothing new, and edges were scanned once, not 201 times.
    expect(again.nodes.filter((node) => node.degree === 2)).toHaveLength(200);
    expect(values.mock.calls.length).toBeLessThanOrEqual(3);
    values.mockRestore();

    expect(() =>
      sync("alice", [
        { name: "A", phone: "+254722000002", connections: nested },
        { name: "B", phone: "+254722000003", connections: nested }
      ])
    ).toThrow(expect.objectContaining({ statusCode: 400, code: "network_connections_too_many" }));
  });

  it("never makes an unverified email discoverable", () => {
    const { sync } = fixture([
      { id: "alice", phone: "+254711000001" },
      {
        id: "bob",
        phone: "+254711000002",
        user: { emailAddress: "bob@example.com", emailVerificationStatus: "unverified" }
      }
    ]);
    expect(
      directByName(sync("alice", [{ name: "Bob", email: "bob@example.com" }])).get("Bob")
        ?.grogoniUserId
    ).toBeNull();
  });
  it("replaces changed links in one pass over identity links, however many contacts relink", () => {
    const { domain, sync, add } = fixture([{ id: "alice", phone: "+254711000001" }]);
    const numbers = Array.from(
      { length: 300 },
      (_, index) => `+2547440${String(index).padStart(5, "0")}`
    );
    sync(
      "alice",
      numbers.map((phone, index) => ({ name: `Late ${index}`, phone }))
    );
    // All 300 join Grogoni after being synced: the next graph load relinks every one of them.
    numbers.forEach((phone, index) => add({ id: `late${index}`, phone }));

    const entries = vi.spyOn(domain.grogoniIdentityLinksMap, "entries");
    const graph = domain.getNetworkGraph({ sessionId: "alice" });

    expect(
      graph.nodes.filter((node) => node.degree === 1 && node.grogoniUserId !== null)
    ).toHaveLength(300);
    expect(entries.mock.calls.length).toBeLessThanOrEqual(1);
    entries.mockRestore();
  });

  it("one owner's relink never touches another owner's identity links", () => {
    const { domain, sync, add } = fixture([
      { id: "alice", phone: "+254711000001" },
      { id: "zara", phone: "+254711000009" },
      { id: "bob", phone: "+254711000002" }
    ]);
    sync("zara", [{ name: "Bob", phone: "+254711000002" }]);
    sync("alice", [{ name: "Late", phone: "+254711000050" }]);
    add({ id: "late", phone: "+254711000050" });

    domain.getNetworkGraph({ sessionId: "alice" });
    expect(domain.getNetworkGraph({ sessionId: "zara" }).identityLinks).toEqual([
      expect.objectContaining({ ownerUserId: "zara", linkedUserId: "bob" })
    ]);
  });

  it("links name-only contacts that gain Grogoni numbers within the sync itself", () => {
    const people = Array.from({ length: 50 }, (_, index) => ({
      id: `p${index}`,
      phone: `+2547550${String(index).padStart(5, "0")}`
    }));
    const { domain, sync } = fixture([{ id: "alice", phone: "+254711000001" }, ...people]);
    sync(
      "alice",
      people.map((person) => ({ name: person.id })),
      "replace"
    );

    const upgraded = sync(
      "alice",
      people.map((person) => ({ name: person.id, phone: person.phone }))
    );
    expect(
      upgraded.nodes.filter((node) => node.degree === 1 && node.grogoniUserId !== null)
    ).toHaveLength(50);
    expect(upgraded.identityLinks).toHaveLength(50);

    // Linked by the sync's own (single) relink pass: the next graph load has nothing to relink,
    // so re-sending the same phonebook cannot force repeated relinking work.
    const entries = vi.spyOn(domain.grogoniIdentityLinksMap, "entries");
    domain.getNetworkGraph({ sessionId: "alice" });
    expect(entries).not.toHaveBeenCalled();
    entries.mockRestore();
  });

  it("dedupes the same second-degree name sent twice for one contact in one request", () => {
    const { sync } = fixture([{ id: "alice", phone: "+254711000001" }]);
    const graph = sync("alice", [
      {
        name: "Hub",
        phone: "+254722000001",
        connections: [{ name: "Maize Co" }, { name: "maize co" }]
      }
    ]);
    expect(graph.nodes.filter((node) => node.degree === 2)).toHaveLength(1);
  });
});
