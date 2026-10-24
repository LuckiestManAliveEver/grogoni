import { createHash } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  createContactHash,
  protectStoredContactHash
} from "../services/api/src/cp2/domains/network/shared";

function person(store: ReturnType<typeof createCp2Store>, suffix: string) {
  return store.continueWithChannelPin({
    channel: "phone",
    destination: `+442079460${suffix}`,
    pin: "1234"
  });
}
afterEach(() => vi.unstubAllEnvs());

describe("messenger contact privacy", () => {
  it("uses server-keyed fingerprints and fails closed without production configuration", () => {
    const legacy = createHash("sha256").update("phone:+442079460501").digest("hex");
    vi.stubEnv("CONTACT_DISCOVERY_HMAC_SECRET", "contact-key-a");
    const first = createContactHash("phone", "+442079460501");
    expect(first).toMatch(/^hmac-v1:[a-f0-9]{64}$/);
    expect(first).not.toContain(legacy);
    expect(protectStoredContactHash("phone", legacy)).toBe(first);
    expect(protectStoredContactHash("phone", first)).toBe(first);
    vi.stubEnv("CONTACT_DISCOVERY_HMAC_SECRET", "contact-key-b");
    expect(createContactHash("phone", "+442079460501")).not.toBe(first);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTACT_DISCOVERY_HMAC_SECRET", "");
    vi.stubEnv("AUTH_AUDIT_HMAC_SECRET", "");
    expect(() => createContactHash("phone", "+442079460501")).toThrow("not configured");
  });

  it("migrates legacy hashes without losing node IDs or duplicating contacts", () => {
    const store = createCp2Store(),
      a = person(store, "501"),
      b = person(store, "502");
    const graph = store.syncPhoneContacts({
      sessionId: a.session.id,
      contacts: [{ name: "B", phone: b.account.primaryAuthDestination }]
    });
    const snapshot = store.snapshot();
    snapshot.contactHashes[0]!.hashValue = createHash("sha256")
      .update(`phone:${b.account.primaryAuthDestination}`)
      .digest("hex");
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    const again = restored.syncPhoneContacts({
      sessionId: a.session.id,
      mode: "merge",
      contacts: [{ name: "B", phone: b.account.primaryAuthDestination }]
    });
    expect(again.syncedContactNodeIds).toEqual(graph.syncedContactNodeIds);
    expect(restored.snapshot().contactHashes).toHaveLength(1);
    expect(restored.snapshot().contactHashes[0]!.hashValue).toMatch(/^hmac-v1:/);
  });

  it("honors discoverability and symmetric blocks across discovery, direct creation, writes and reloads", () => {
    const store = createCp2Store(),
      a = person(store, "511"),
      b = person(store, "512");
    const graph = store.syncPhoneContacts({
      sessionId: a.session.id,
      contacts: [{ name: "B", phone: b.account.primaryAuthDestination }]
    });
    expect(graph.nodes.some((node) => node.grogoniUserId === b.user.id)).toBe(true);
    const direct = store.createConversation({
      sessionId: a.session.id,
      kind: "personal",
      activeShopId: null,
      recipient: b.account.primaryAuthDestination
    });
    store.updateNetworkPrivacy({ sessionId: b.session.id, discoverable: false });
    expect(
      store
        .getNetworkGraph({ sessionId: a.session.id })
        .nodes.some((node) => node.grogoniUserId === b.user.id)
    ).toBe(false);
    expect(() =>
      store.createConversation({
        sessionId: a.session.id,
        kind: "personal",
        activeShopId: null,
        recipient: b.account.primaryAuthDestination
      })
    ).toThrow();
    store.updateNetworkPrivacy({ sessionId: b.session.id, discoverable: true });
    store.getNetworkGraph({ sessionId: a.session.id });
    store.blockNetworkContact({ sessionId: a.session.id, userId: b.user.id, blocked: true });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(
      restored
        .getNetworkPrivacy({ sessionId: a.session.id })
        .blockedContacts.map((entry) => entry.userId)
    ).toEqual([b.user.id]);
    expect(restored.getNetworkPrivacy({ sessionId: b.session.id }).blockedContacts).toEqual([]);
    expect(() =>
      restored.createConversation({
        sessionId: b.session.id,
        kind: "personal",
        activeShopId: null,
        recipient: a.account.primaryAuthDestination
      })
    ).toThrow();
    expect(() =>
      restored.createConversationMessage({
        sessionId: b.session.id,
        conversationId: direct.conversation.id,
        clientMessageId: "blocked-message",
        content: { type: "text", text: "must not be saved" }
      })
    ).toThrow(/available/);
    expect(
      restored.getConversation({ sessionId: b.session.id, conversationId: direct.conversation.id })
        .messages
    ).toHaveLength(0);
    restored.blockNetworkContact({ sessionId: a.session.id, userId: b.user.id, blocked: false });
    expect(
      restored.createConversation({
        sessionId: b.session.id,
        kind: "personal",
        activeShopId: null,
        recipient: a.account.primaryAuthDestination
      }).conversation.id
    ).toBe(direct.conversation.id);
  });

  it("preserves retained fingerprint IDs and deletes omitted numbers during replace sync", () => {
    const store = createCp2Store(),
      a = person(store, "531");
    const first = store.syncPhoneContacts({
      sessionId: a.session.id,
      contacts: [
        { name: "Retained", phone: "+442079460532" },
        { name: "Removed", phone: "+442079460533" }
      ]
    });
    const retainedId = first.nodes.find((node) => node.displayName === "Retained")!
      .contactHashIds[0];
    const replaced = store.syncPhoneContacts({
      sessionId: a.session.id,
      contacts: [{ name: "Retained Again", phone: "+442079460532" }]
    });
    expect(
      replaced.nodes.find((node) => node.displayName === "Retained Again")!.contactHashIds
    ).toEqual([retainedId]);
    expect(store.snapshot().contactHashes.map((hash) => hash.id)).toEqual([retainedId]);
  });

  it("deletes unreferenced imported hashes on disconnect and preserves another owner's data", () => {
    const store = createCp2Store(),
      a = person(store, "521"),
      b = person(store, "522");
    const aGraph = store.syncPhoneContacts({
      sessionId: a.session.id,
      contacts: [{ name: "Private", phone: "+442079460523" }]
    });
    store.syncPhoneContacts({
      sessionId: b.session.id,
      contacts: [{ name: "Separate", phone: "+442079460523" }]
    });
    store.deleteNetworkSource({
      sessionId: a.session.id,
      sourceId: aGraph.sources.find((source) => source.status === "active")!.id
    });
    const snapshot = store.snapshot();
    expect(snapshot.contactHashes.filter((hash) => hash.ownerUserId === a.user.id)).toEqual([]);
    expect(snapshot.contactHashes.filter((hash) => hash.ownerUserId === b.user.id)).toHaveLength(1);
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    expect(
      restored
        .getNetworkGraph({ sessionId: a.session.id })
        .nodes.filter((node) => node.sourceId !== null)
    ).toEqual([]);
  });
});
