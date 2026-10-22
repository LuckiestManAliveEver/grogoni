import { signupWithBackupEmail } from "./fixtures/account-auth";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import {
  createCp2Store,
  readSessionCookie,
  type NetworkInviteSender
} from "../services/api/src/cp2/store";
import type { NetworkConnectionSummary, NetworkGraphSummary } from "../packages/shared-types/src";

// Phonebook sync, Grogoni discovery, user-to-user connections and invite filtering.
// See docs/architecture/phonebook-identity-resolution.md ("Phonebook sync, discovery and connections").

type App = ReturnType<typeof buildApi>;

const alicePhone = "+254711000001";
const bobPhone = "+254711000002";
const carolPhone = "+254711000003";
const outsiderPhone = "+254711000009";

describe("phonebook sync", () => {
  it("merges picker selections, dedupes by phone/email, and replaces only on request", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });

    const first = await syncContacts(app, alice.cookie, "merge", [
      { name: "Wanjiru", phone: "+254 722 000 101" },
      { name: "Otieno", phone: "+254722000102" }
    ]);
    const second = await syncContacts(app, alice.cookie, "merge", [
      // Same number, different formatting and a renamed contact: updates, never duplicates.
      // National format, as phonebooks store it, read in the owner's country (Kenya).
      { name: "Wanjiru Kamau", phone: "0722 000 101" },
      { name: "Achieng", email: "ACHIENG@example.com" },
      { name: "Achieng dup", email: "achieng@example.com" }
    ]);

    const direct = directContacts(second);
    expect(direct.map((node) => node.displayName).sort()).toEqual([
      "Achieng dup",
      "Otieno",
      "Wanjiru Kamau"
    ]);
    expect(second.syncedContactNodeIds).toHaveLength(3);
    expect(second.syncedContactNodeIds?.[0]).toBe(first.syncedContactNodeIds?.[0]);
    expect(second.syncedContactNodeIds?.[1]).toBe(second.syncedContactNodeIds?.[2]);
    const phoneSources = second.sources.filter((source) => source.sourcePlatform === "phone");
    expect(phoneSources).toHaveLength(1);
    expect(phoneSources[0]).toMatchObject({ status: "active", importedCount: 3, directCount: 3 });

    const replaced = await syncContacts(app, alice.cookie, "replace", [
      { name: "Only One", phone: "+254722000199" }
    ]);
    expect(directContacts(replaced).map((node) => node.displayName)).toEqual(["Only One"]);
    await app.close();
  });

  it("upgrades a name-only contact in place when it later arrives with a number", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });

    const first = await syncContacts(app, alice.cookie, "merge", [{ name: "Mama Mboga" }]);
    const second = await syncContacts(app, alice.cookie, "merge", [
      { name: "Mama Mboga", phone: "+254722000150" }
    ]);

    expect(second.syncedContactNodeIds?.[0]).toBe(first.syncedContactNodeIds?.[0]);
    expect(directContacts(second)).toHaveLength(1);
    expect(directContacts(second)[0]?.contactHashIds).toHaveLength(1);
    await app.close();
  });

  it("rejects an unknown sync mode", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const response = await request(app, "POST", "/network/sync/contacts", alice.cookie, {
      mode: "append",
      contacts: []
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "network_sync_mode_invalid" });
    await app.close();
  });
});

describe("Grogoni discovery", () => {
  it("marks contacts who are on Grogoni, never the owner's own number, and finds late joiners", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone);

    const graph = await syncContacts(app, alice.cookie, "merge", [
      { name: "Bob", phone: bobPhone },
      { name: "Me", phone: alicePhone },
      { name: "Carol", phone: carolPhone }
    ]);
    const byName = nodesByName(graph);
    expect(byName.get("Bob")).toMatchObject({ kind: "grogoni_user", grogoniUserId: bob.userId });
    expect(byName.get("Me")).toMatchObject({ kind: "external_contact", grogoniUserId: null });
    expect(byName.get("Carol")).toMatchObject({ kind: "external_contact", grogoniUserId: null });

    // Carol signs up after Alice synced her. No re-sync: the next graph load finds her.
    const carol = await signUp(app, carolPhone);
    const later = await getJson<NetworkGraphSummary>(app, "/network", alice.cookie);
    expect(nodesByName(later).get("Carol")).toMatchObject({
      kind: "grogoni_user",
      grogoniUserId: carol.userId
    });
    expect(later.identityLinks?.filter((link) => link.linkedUserId === carol.userId)).toHaveLength(
      1
    );
    await app.close();
  });
});

describe("connections", () => {
  it("request, see incoming, accept, and remove", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true, businessName: "Alice Grocers" });
    const bob = await signUp(app, bobPhone);
    const bobNodeId = await contactNodeId(app, alice.cookie, "Bob", bobPhone);

    const requested = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: bobNodeId },
      alice.cookie
    );
    expect(requested).toMatchObject({
      status: "pending",
      direction: "outgoing",
      counterpartUserId: bob.userId,
      counterpartDisplayName: "Bob",
      nodeId: bobNodeId
    });

    // Asking again is idempotent.
    const again = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: bobNodeId },
      alice.cookie
    );
    expect(again.id).toBe(requested.id);

    // Bob does not have Alice in his phonebook: he sees her Grogoni name and her shop.
    const incoming = await listConnections(app, bob.cookie);
    expect(incoming).toEqual([
      expect.objectContaining({
        id: requested.id,
        status: "pending",
        direction: "incoming",
        counterpartUserId: alice.userId,
        counterpartBusinessName: "Alice Grocers",
        nodeId: null
      })
    ]);
    const bobGraph = await getJson<NetworkGraphSummary>(app, "/network", bob.cookie);
    expect(bobGraph.connections?.map((connection) => connection.id)).toEqual([requested.id]);

    const accepted = await postJson<{ connection: NetworkConnectionSummary }>(
      app,
      `/network/connections/${requested.id}/respond`,
      { accept: true },
      bob.cookie
    );
    expect(accepted.connection).toMatchObject({
      status: "accepted",
      respondedAt: expect.any(String)
    });
    expect(await listConnections(app, alice.cookie)).toEqual([
      expect.objectContaining({ id: requested.id, status: "accepted", direction: "outgoing" })
    ]);

    const removal = await request(
      app,
      "DELETE",
      `/network/connections/${requested.id}`,
      bob.cookie
    );
    expect(removal.statusCode).toBe(200);
    expect(await listConnections(app, alice.cookie)).toEqual([]);
    expect(await listConnections(app, bob.cookie)).toEqual([]);
    await app.close();
  });

  it("reveals which shop a contact runs only once connected", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone, { business: true, businessName: "Bob Hardware" });
    const synced = await syncContacts(app, alice.cookie, "merge", [
      { name: "Bob", phone: bobPhone }
    ]);
    const bobNode = nodesByName(synced).get("Bob")!;

    // Discovery says Bob is on Grogoni, not which shop is his.
    expect(bobNode).toMatchObject({
      grogoniUserId: bob.userId,
      grogoniBusinessId: null,
      grogoniAgentId: null
    });
    expect(synced.identityLinks.every((link) => link.linkedBusinessId === null)).toBe(true);
    const sent = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: bobNode.id },
      alice.cookie
    );
    expect(sent).toMatchObject({ counterpartBusinessName: null, counterpartGrogoniId: null });
    const resolved = await getJson<{
      matches: Array<{ node: { grogoniBusinessId: string | null } }>;
    }>(app, `/network/contacts/resolve?query=Bob`, alice.cookie);
    expect(resolved.matches[0]?.node.grogoniBusinessId).toBeNull();

    await postJson(app, `/network/connections/${sent.id}/respond`, { accept: true }, bob.cookie);
    const after = await getJson<NetworkGraphSummary>(app, "/network", alice.cookie);
    expect(nodesByName(after).get("Bob")?.grogoniBusinessId).toBe(bob.businessId);
    expect(after.connections?.[0]).toMatchObject({ counterpartBusinessName: "Bob Hardware" });
    await app.close();
  });

  it("does not reveal a contact's shop through the supplier phonebook search either", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    await signUp(app, bobPhone, { business: true, businessName: "Bob Hardware" });
    await syncContacts(app, alice.cookie, "merge", [{ name: "Bob", phone: bobPhone }]);

    const found = await getJson<
      Array<{
        displayName: string;
        grogoniBusinessId: string | null;
        grogoniAgentId: string | null;
      }>
    >(app, `/businesses/${alice.businessId}/suppliers/phonebook/search?q=Bob`, alice.cookie);
    expect(found).toEqual([
      expect.objectContaining({ displayName: "Bob", grogoniBusinessId: null, grogoniAgentId: null })
    ]);
    await app.close();
  });

  it("does not reveal a contact's shop through the identity endpoints", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    await signUp(app, bobPhone, { business: true, businessName: "Bob Hardware" });
    const synced = await syncContacts(app, alice.cookie, "merge", [
      { name: "Bob", phone: bobPhone }
    ]);
    const bobNode = nodesByName(synced).get("Bob")!;

    const added = await postJson<{
      grogoniBusinessId: string | null;
      grogoniAgentId: string | null;
      externalIdentityIds: string[];
    }>(
      app,
      `/network/nodes/${bobNode.id}/identities`,
      { provider: "instagram", providerSubject: "@bobhardware" },
      alice.cookie
    );
    expect(added).toMatchObject({ grogoniBusinessId: null, grogoniAgentId: null });
    const removed = await request(
      app,
      "DELETE",
      `/network/nodes/${bobNode.id}/identities/${added.externalIdentityIds.at(-1)}`,
      alice.cookie
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ grogoniBusinessId: null, grogoniAgentId: null });
    await app.close();
  });

  it("auto-accepts when both sides ask", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone, { business: true });
    const aliceToBob = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: await contactNodeId(app, alice.cookie, "Bob", bobPhone) },
      alice.cookie
    );
    const bobToAlice = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: await contactNodeId(app, bob.cookie, "Alice", alicePhone) },
      bob.cookie
    );

    expect(bobToAlice).toMatchObject({
      id: aliceToBob.id,
      status: "accepted",
      direction: "incoming"
    });
    expect(await listConnections(app, alice.cookie)).toEqual([
      expect.objectContaining({ status: "accepted" })
    ]);
    await app.close();
  });

  it("keeps a decline private and still lets the recipient connect later", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone, { business: true });
    const request1 = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: await contactNodeId(app, alice.cookie, "Bob", bobPhone) },
      alice.cookie
    );

    const declined = await postJson<{ connection: NetworkConnectionSummary | null }>(
      app,
      `/network/connections/${request1.id}/respond`,
      { accept: false },
      bob.cookie
    );
    expect(declined.connection).toBeNull();
    expect(await listConnections(app, bob.cookie)).toEqual([]);
    expect(await listConnections(app, alice.cookie)).toEqual([
      expect.objectContaining({ id: request1.id, status: "pending", respondedAt: null })
    ]);
    // Alice asking again does not re-notify Bob.
    await postJson(app, "/network/connections", { nodeId: request1.nodeId }, alice.cookie);
    expect(await listConnections(app, bob.cookie)).toEqual([]);
    // Bob changes his mind: responding to the hidden request is not possible, asking is.
    const hidden = await request(
      app,
      "POST",
      `/network/connections/${request1.id}/respond`,
      bob.cookie,
      { accept: true }
    );
    expect(hidden.statusCode).toBe(404);
    const bobAsks = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: await contactNodeId(app, bob.cookie, "Alice", alicePhone) },
      bob.cookie
    );
    expect(bobAsks).toMatchObject({ id: request1.id, status: "accepted" });
    await app.close();
  });

  it("enforces ownership, Grogoni membership, self, and party rules", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone, { business: true });
    const mallory = await signUp(app, outsiderPhone, { business: true });
    const graph = await syncContacts(app, alice.cookie, "merge", [
      { name: "Bob", phone: bobPhone },
      { name: "Not on Grogoni", phone: "+254722000777" },
      { name: "Me", phone: alicePhone }
    ]);
    const byName = nodesByName(graph);

    const notOnGrogoni = await request(app, "POST", "/network/connections", alice.cookie, {
      nodeId: byName.get("Not on Grogoni")!.id
    });
    expect(notOnGrogoni.statusCode).toBe(409);
    expect(notOnGrogoni.json()).toMatchObject({ code: "network_contact_not_on_grogoni" });

    const self = await request(app, "POST", "/network/connections", alice.cookie, {
      nodeId: byName.get("Me")!.id
    });
    expect(self.statusCode).toBe(409);

    // Mallory cannot use Alice's phonebook node to reach Bob.
    const foreignNode = await request(app, "POST", "/network/connections", mallory.cookie, {
      nodeId: byName.get("Bob")!.id
    });
    expect(foreignNode.statusCode).toBe(404);

    const owner = await request(app, "POST", "/network/connections", alice.cookie, {
      nodeId: byName.get("Bob")!.id
    });
    const connection = owner.json<NetworkConnectionSummary>();

    // Only the recipient responds; nobody outside the pair can respond or remove.
    for (const cookie of [alice.cookie, mallory.cookie]) {
      const respond = await request(
        app,
        "POST",
        `/network/connections/${connection.id}/respond`,
        cookie,
        { accept: true }
      );
      expect(respond.statusCode).toBe(404);
    }
    const foreignRemove = await request(
      app,
      "DELETE",
      `/network/connections/${connection.id}`,
      mallory.cookie
    );
    expect(foreignRemove.statusCode).toBe(404);

    const badBody = await request(
      app,
      "POST",
      `/network/connections/${connection.id}/respond`,
      bob.cookie,
      { accept: "yes" }
    );
    expect(badBody.statusCode).toBe(400);

    await postJson(
      app,
      `/network/connections/${connection.id}/respond`,
      { accept: true },
      bob.cookie
    );
    const declineAccepted = await request(
      app,
      "POST",
      `/network/connections/${connection.id}/respond`,
      bob.cookie,
      { accept: false }
    );
    expect(declineAccepted.statusCode).toBe(409);

    const unauthenticated = await request(app, "GET", "/network/connections");
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
  });

  it("lets the requester cancel a pending request", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone);
    const pending = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: await contactNodeId(app, alice.cookie, "Bob", bobPhone) },
      alice.cookie
    );
    const cancel = await request(app, "DELETE", `/network/connections/${pending.id}`, alice.cookie);
    expect(cancel.statusCode).toBe(200);
    expect(await listConnections(app, bob.cookie)).toEqual([]);
    await app.close();
  });

  it("survives a phonebook replace, persists through a snapshot, and is purged with either account", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const alice = await signUp(app, alicePhone, { business: true });
    const bob = await signUp(app, bobPhone, { business: true });
    const connection = await postJson<NetworkConnectionSummary>(
      app,
      "/network/connections",
      { nodeId: await contactNodeId(app, alice.cookie, "Bob", bobPhone) },
      alice.cookie
    );
    await postJson(
      app,
      `/network/connections/${connection.id}/respond`,
      { accept: true },
      bob.cookie
    );

    // Replacing the phonebook drops Bob's node, not the connection itself.
    await syncContacts(app, alice.cookie, "replace", [{ name: "Someone", phone: "+254722000555" }]);
    expect(await listConnections(app, alice.cookie)).toEqual([
      expect.objectContaining({ id: connection.id, status: "accepted", nodeId: null })
    ]);

    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(restored.snapshot().networkConnections).toEqual([
      expect.objectContaining({ id: connection.id, status: "accepted" })
    ]);

    // Bob back in Alice's phonebook before his account goes.
    await syncContacts(app, alice.cookie, "merge", [{ name: "Bob", phone: bobPhone }]);
    const now = new Date();
    const bobSessionId = readSessionCookie(bob.cookie);
    store.requestAccountDeletion({
      sessionId: bobSessionId,
      businessId: bob.businessId!,
      deletion: { confirmation: "DELETE", reason: "connection purge proof" },
      now
    });
    const result = await store.purgeExpiredAccountDeletions(
      new Date(now.getTime() + 40 * 24 * 60 * 60 * 1000)
    );
    expect(result.completed).toBe(1);
    expect(store.snapshot().networkConnections).toEqual([]);
    // Alice's own contact for Bob is hers: it stays, unlinked, instead of being purged with Bob.
    const aliceAfter = store.getNetworkGraph({ sessionId: readSessionCookie(alice.cookie) });
    expect(nodesByName(aliceAfter).get("Bob")).toMatchObject({
      kind: "external_contact",
      grogoniUserId: null,
      grogoniBusinessId: null
    });
    expect(aliceAfter.identityLinks).toEqual([]);
    await app.close();
  });
});

describe("invites", () => {
  it("never invites someone already on Grogoni, however the number or email is written", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const app = buildApi({ cp2: { store: createCp2Store({ networkInviteSender: sender }) } });
    const alice = await signUp(app, alicePhone, { business: true });
    await signUp(app, bobPhone);
    await signUpByEmail(app, "erin@example.com");

    const response = await postJson<{
      invites: Array<{ destination: string }>;
      alreadyOnGrogoniCount: number;
    }>(
      app,
      `/businesses/${alice.businessId}/network/invites`,
      {
        contacts: [
          { name: "Bob", phone: bobPhone, email: null },
          // Bob again, national format: still Bob.
          { name: "Bob local", phone: "0711 000 002", email: null },
          { name: "Erin", phone: null, email: "Erin@Example.com" },
          { name: "Dan", phone: "0722000888", email: null }
        ]
      },
      alice.cookie
    );

    // Bob's two spellings are one person (deduped first), plus Erin.
    expect(response.alreadyOnGrogoniCount).toBe(2);
    expect(response.invites.map((invite) => invite.destination)).toEqual(["+254722000888"]);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ destination: "+254722000888" }));
    await app.close();
  });

  it("sends one invite per person across number formats and repeat requests", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const app = buildApi({ cp2: { store: createCp2Store({ networkInviteSender: sender }) } });
    const alice = await signUp(app, alicePhone, { business: true });
    const url = `/businesses/${alice.businessId}/network/invites`;

    await postJson(
      app,
      url,
      {
        contacts: [
          { name: "Dan", phone: "+254 722 000 101", email: null },
          { name: "Dan again", phone: "0722000101", email: null }
        ]
      },
      alice.cookie
    );
    await postJson(
      app,
      url,
      { contacts: [{ name: "Dan", phone: "254722000101", email: null }] },
      alice.cookie
    );

    expect(sender).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it("skips contacts it cannot read, and is not fooled by messy spellings of a Grogoni number", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const app = buildApi({ cp2: { store: createCp2Store({ networkInviteSender: sender }) } });
    const alice = await signUp(app, alicePhone, { business: true });
    await signUp(app, bobPhone);

    const response = await postJson<{
      invites: unknown[];
      alreadyOnGrogoniCount: number;
      invalidCount: number;
    }>(
      app,
      `/businesses/${alice.businessId}/network/invites`,
      {
        contacts: [
          { name: "Bob bidi", phone: "\u202A0711 000 002\u202C", email: null },
          { name: "Bob tel", phone: "tel:+254711000002;ext=9", email: null },
          {
            name: "Bob wide",
            phone: "\uFF10\uFF17\uFF11\uFF11\uFF10\uFF10\uFF10\uFF10\uFF10\uFF12",
            email: null
          },
          { name: "Junk", phone: "call me maybe", email: "not-an-email" }
        ]
      },
      alice.cookie
    );

    expect(response).toMatchObject({ invites: [], alreadyOnGrogoniCount: 1, invalidCount: 1 });
    expect(sender).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not re-invite someone whose earlier invite was stored as typed", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const store = createCp2Store({ networkInviteSender: sender });
    const app = buildApi({ cp2: { store } });
    const alice = await signUp(app, alicePhone, { business: true });
    const snapshot = store.snapshot();
    store.hydrateSnapshot({
      ...snapshot,
      networkInvites: [
        {
          id: "legacy-invite",
          businessId: alice.businessId!,
          invitedByUserId: alice.userId,
          contactName: "Dan",
          channel: "phone",
          destination: "0722 000 101",
          status: "sent",
          createdAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
          failureReason: null
        }
      ]
    });

    const response = await postJson<{ invites: Array<{ id: string }> }>(
      app,
      `/businesses/${alice.businessId}/network/invites`,
      { contacts: [{ name: "Dan", phone: "+254722000101", email: null }] },
      alice.cookie
    );

    expect(response.invites.map((invite) => invite.id)).toEqual(["legacy-invite"]);
    expect(sender).not.toHaveBeenCalled();
    await app.close();
  });
  it("charges the numbers it checks to the discovery budget, and only numbers new to the owner", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const app = buildApi({
      cp2: {
        store: createCp2Store({
          networkInviteSender: sender,
          networkLimits: { phonebookSyncDailyBudget: 2 }
        })
      }
    });
    const alice = await signUp(app, alicePhone, { business: true });
    const url = `/businesses/${alice.businessId}/network/invites`;
    // Already in Alice's phonebook: free to check again.
    await syncContacts(app, alice.cookie, "merge", [{ name: "Dan", phone: "+254722000101" }]);
    await postJson(
      app,
      url,
      { contacts: [{ name: "Dan", phone: "0722000101", email: null }] },
      alice.cookie
    );

    await postJson(
      app,
      url,
      { contacts: [{ name: "Eve", phone: "0722000102", email: null }] },
      alice.cookie
    );
    const refused = await request(app, "POST", url, alice.cookie, {
      contacts: [{ name: "Fay", phone: "0722000103", email: null }]
    });
    expect(refused.statusCode).toBe(429);
    expect(sender.mock.calls.map(([invite]) => invite.destination)).toEqual([
      "+254722000101",
      "+254722000102"
    ]);
    await app.close();
  });
  it("re-sending an open invite is free, but a new email riding on it is charged", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const app = buildApi({
      cp2: {
        store: createCp2Store({
          networkInviteSender: sender,
          networkLimits: { phonebookSyncDailyBudget: 2 }
        })
      }
    });
    const alice = await signUp(app, alicePhone, { business: true });
    const url = `/businesses/${alice.businessId}/network/invites`;
    await postJson(
      app,
      url,
      {
        contacts: [
          { name: "Dan", phone: "0722000101", email: null },
          { name: "Eve", phone: "0722000102", email: null }
        ]
      },
      alice.cookie
    );

    // Budget spent. The same open invite again costs nothing...
    const again = await request(app, "POST", url, alice.cookie, {
      contacts: [{ name: "Dan", phone: "0722000101", email: null }]
    });
    expect(again.statusCode).toBe(200);
    // ...but an email alongside it is a new question about who is on Grogoni.
    const probe = await request(app, "POST", url, alice.cookie, {
      contacts: [{ name: "Dan", phone: "0722000101", email: "someone@example.com" }]
    });
    expect(probe.statusCode).toBe(429);
    await app.close();
  });
  it("only this shop's live invites are free to re-check, and one value is charged once", async () => {
    // Eve's number cannot be reached; every other invite is delivered.
    const sender = vi.fn<NetworkInviteSender>(async (invite) =>
      invite.destination === "+254722000102"
        ? { status: "failed", failureReason: "undeliverable" }
        : { status: "sent" }
    );
    const app = buildApi({
      cp2: {
        store: createCp2Store({
          networkInviteSender: sender,
          networkLimits: { phonebookSyncDailyBudget: 3 }
        })
      }
    });
    const alice = await signUp(app, alicePhone, { business: true });
    const other = await signUp(app, outsiderPhone, { business: true });
    const aliceUrl = `/businesses/${alice.businessId}/network/invites`;

    // Another shop's open invite for Dan does not make Dan free for Alice.
    await postJson(
      app,
      `/businesses/${other.businessId}/network/invites`,
      { contacts: [{ name: "Dan", phone: "0722000101", email: null }] },
      other.cookie
    );
    // Alice's first invite fails to deliver: a failed invite is not a live one.
    await postJson(
      app,
      aliceUrl,
      { contacts: [{ name: "Eve", phone: "0722000102", email: null }] },
      alice.cookie
    );
    // The same email on two contacts is one question: 1 (Dan) + 1 (shared email) = 2 more.
    await postJson(
      app,
      aliceUrl,
      {
        contacts: [
          { name: "Dan", phone: "0722000101", email: "dan@example.com" },
          { name: "Dan work", phone: null, email: "dan@example.com" }
        ]
      },
      alice.cookie
    );
    // Budget (3) spent. Re-sending the failed invite to Eve is a new question: refused.
    const refused = await request(app, "POST", aliceUrl, alice.cookie, {
      contacts: [{ name: "Eve", phone: "0722000102", email: null }]
    });
    expect(refused.statusCode).toBe(429);
    await app.close();
  });

  it("rejects contacts with too many numbers or second-degree connections", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, alicePhone, { business: true });
    const tooManyPhones = await request(app, "POST", "/network/sync/contacts", alice.cookie, {
      contacts: [
        { name: "Many", phones: Array.from({ length: 11 }, (_, index) => `+2547220000${index}`) }
      ]
    });
    expect(tooManyPhones.statusCode).toBe(400);
    const tooManyConnections = await request(app, "POST", "/network/sync/contacts", alice.cookie, {
      contacts: [
        {
          name: "Hub",
          connections: Array.from({ length: 51 }, (_, index) => ({ name: `S${index}` }))
        }
      ]
    });
    expect(tooManyConnections.statusCode).toBe(400);
    await app.close();
  });
  it("keeps the discovery budget across a restart, and purges it with the account", async () => {
    const store = createCp2Store({ networkLimits: { phonebookSyncDailyBudget: 2 } });
    const app = buildApi({ cp2: { store } });
    const alice = await signUp(app, alicePhone, { business: true });
    await syncContacts(app, alice.cookie, "merge", [
      { name: "A", phone: "+254722000001" },
      { name: "B", phone: "+254722000002" }
    ]);
    await app.close();

    // A restart: a fresh store hydrated from the persisted snapshot.
    const restarted = createCp2Store({ networkLimits: { phonebookSyncDailyBudget: 2 } });
    restarted.hydrateSnapshot(store.snapshot());
    const restartedApp = buildApi({ cp2: { store: restarted } });
    const refused = await request(restartedApp, "POST", "/network/sync/contacts", alice.cookie, {
      mode: "merge",
      contacts: [{ name: "C", phone: "+254722000003" }]
    });
    expect(refused.statusCode).toBe(429);
    expect(restarted.snapshot().discoveryBudgets).toEqual([
      expect.objectContaining({
        userId: alice.userId,
        entries: [expect.objectContaining({ count: 2 })]
      })
    ]);

    const now = new Date();
    restarted.requestAccountDeletion({
      sessionId: readSessionCookie(alice.cookie),
      businessId: alice.businessId!,
      deletion: { confirmation: "DELETE", reason: "budget purge proof" },
      now
    });
    await restarted.purgeExpiredAccountDeletions(
      new Date(now.getTime() + 40 * 24 * 60 * 60 * 1000)
    );
    expect(restarted.snapshot().discoveryBudgets).toEqual([]);
    await restartedApp.close();
  });
});

async function signUpByEmail(app: App, email: string) {
  await signupWithBackupEmail(app, email);
}

async function signUp(
  app: App,
  phone: string,
  options: { business?: boolean; businessName?: string } = {}
): Promise<{ cookie: string; userId: string; businessId: string | null }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: phone, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  const cookie = (raw ?? "").split(";")[0] ?? "";
  const session = await getJson<{ user: { id: string } }>(app, "/session", cookie);
  let businessId: string | null = null;

  if (options.business === true) {
    const created = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: options.businessName ?? `Shop ${phone.slice(-3)}`, language: "en" },
      cookie
    );
    businessId = created.business.id;
  }

  return { cookie, userId: session.user.id, businessId };
}

async function syncContacts(
  app: App,
  cookie: string,
  mode: "merge" | "replace",
  contacts: Array<{ name: string; phone?: string; email?: string }>
): Promise<NetworkGraphSummary> {
  return postJson<NetworkGraphSummary>(
    app,
    "/network/sync/contacts",
    { mode, sourceName: "Phone Contacts", contacts },
    cookie
  );
}

async function contactNodeId(app: App, cookie: string, name: string, phone: string) {
  const graph = await syncContacts(app, cookie, "merge", [{ name, phone }]);
  const nodeId = graph.syncedContactNodeIds?.[0];
  expect(nodeId).toEqual(expect.any(String));
  return nodeId as string;
}

async function listConnections(app: App, cookie: string) {
  return (
    await getJson<{ connections: NetworkConnectionSummary[] }>(app, "/network/connections", cookie)
  ).connections;
}

function directContacts(graph: NetworkGraphSummary) {
  return graph.nodes.filter((node) => node.degree === 1);
}

function nodesByName(graph: NetworkGraphSummary) {
  return new Map(directContacts(graph).map((node) => [node.displayName, node]));
}

async function request(
  app: App,
  method: "GET" | "POST" | "DELETE",
  url: string,
  cookie?: string,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie })
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
  });
}

async function getJson<T>(app: App, url: string, cookie?: string): Promise<T> {
  const response = await request(app, "GET", url, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function postJson<T>(app: App, url: string, payload: unknown, cookie?: string): Promise<T> {
  const response = await request(app, "POST", url, cookie, payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
