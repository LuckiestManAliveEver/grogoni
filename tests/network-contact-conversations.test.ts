import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  ConversationInboxItem,
  ConversationView,
  NetworkGraphSummary
} from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

// Starting a chat from Phone Contacts: the owner picks an on-Grogoni contact by name ("Mama
// Njeri") whose selected number is sent over HTTPS for keyed server matching. The client opens the conversation
// by phonebook node id and the server mirrors that node id onto both participants, so each side's
// Phone Contacts finds the same chat again. See apps/web/src/network-contact-conversations.ts.

describe("phonebook contact conversations", () => {
  it("opens a direct conversation and resolves each viewer’s own private phonebook node", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, "+254799000001");
    const bob = await signUp(app, "+254799000002");
    const bobGraph = await syncContacts(app, bob.cookie, [
      { name: "Alice Wanjiru", phone: alice.phone }
    ]);
    const bobNodeId = nodeIdFor(bobGraph, "Alice Wanjiru");

    const conversation = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, recipient: `network-node:${bobNodeId}` },
      bob.cookie
    );
    const accountParticipants = conversation.participants.filter(
      (participant) => participant.role === "account"
    );
    expect(accountParticipants).toHaveLength(2);
    expect(accountParticipants.map((participant) => participant.accountId).sort()).toEqual(
      [alice.accountId, bob.accountId].sort()
    );
    // Shared participant views must not disclose one owner's private graph IDs.
    expect(accountParticipants.every((participant) => participant.networkNodeId == null)).toBe(
      true
    );
    const bobInbox = await getJson<{ conversations: ConversationInboxItem[] }>(
      app,
      "/v1/conversations",
      bob.cookie
    );
    expect(
      bobInbox.conversations.find((item) => item.id === conversation.conversation.id)?.participant
        .networkNodeId
    ).toBe(bobNodeId);

    // The chat appears in Alice's inbox with the node id, so she sees it as a person-to-person chat.
    const aliceInbox = await getJson<{ conversations: ConversationInboxItem[] }>(
      app,
      "/v1/conversations",
      alice.cookie
    );
    const aliceCopy = aliceInbox.conversations.find(
      (item) => item.id === conversation.conversation.id
    );
    expect(aliceCopy).toMatchObject({ hasHumanRecipient: true });
    expect(aliceCopy?.participant.networkNodeId).toBeNull();

    // Reopening from the same contact lands on the same chat rather than starting a second one.
    const again = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, recipient: `network-node:${bobNodeId}` },
      bob.cookie
    );
    expect(again.conversation.id).toBe(conversation.conversation.id);

    // And from the other side: Alice synced Bob's number, and the same pair is reused.
    const aliceGraph = await syncContacts(app, alice.cookie, [
      { name: "Bob Otieno", phone: bob.phone }
    ]);
    const aliceNodeId = nodeIdFor(aliceGraph, "Bob Otieno");
    const fromAlice = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, recipient: `network-node:${aliceNodeId}` },
      alice.cookie
    );
    expect(fromAlice.conversation.id).toBe(conversation.conversation.id);
    const refreshed = await getJson<{ conversations: ConversationInboxItem[] }>(
      app,
      "/v1/conversations",
      alice.cookie
    );
    expect(
      refreshed.conversations.find((item) => item.id === conversation.conversation.id)?.participant
        .networkNodeId
    ).toBe(aliceNodeId);
    await app.close();
  });

  it("refuses a node that is not in the caller's own phonebook", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const alice = await signUp(app, "+254799000011");
    const bob = await signUp(app, "+254799000012");
    const carol = await signUp(app, "+254799000013");
    const bobGraph = await syncContacts(app, bob.cookie, [
      { name: "Alice Wanjiru", phone: alice.phone }
    ]);
    const bobNodeId = nodeIdFor(bobGraph, "Alice Wanjiru");

    // Carol never synced that contact, so she cannot reach Alice through Bob's phonebook.
    const response = await postResponse(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, recipient: `network-node:${bobNodeId}` },
      carol.cookie
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "phonebook_contact_not_found" });

    // A node id that does not exist at all is refused the same way, never guessed at.
    const unknown = await postResponse(
      app,
      "/v1/conversations",
      {
        kind: "personal",
        activeShopId: null,
        recipient: "network-node:00000000-0000-4000-8000-000000000000"
      },
      bob.cookie
    );
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});

interface TestAccount {
  cookie: string;
  accountId: string;
  phone: string;
}

/** Signup takes the number without the leading "+", as the signup form submits it. */
async function signUp(app: FastifyInstance, phone: string): Promise<TestAccount> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: phone.replace(/^\+/u, ""), pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  const cookie = (raw ?? "").split(";")[0] ?? "";
  const session = await getJson<{ account: { id: string } }>(app, "/session", cookie);
  return { cookie, accountId: session.account.id, phone };
}

function syncContacts(
  app: FastifyInstance,
  cookie: string,
  contacts: Array<{ name: string; phone?: string; email?: string }>
): Promise<NetworkGraphSummary> {
  return postJson<NetworkGraphSummary>(
    app,
    "/network/sync/contacts",
    { mode: "merge", sourceName: "Phone Contacts", contacts },
    cookie
  );
}

function nodeIdFor(graph: NetworkGraphSummary, name: string): string {
  const nodeId = graph.syncedContactNodeIds?.[0];
  expect(nodeId).toEqual(expect.any(String));
  expect(graph.nodes.find((node) => node.id === nodeId)?.displayName).toBe(name);
  return nodeId as string;
}

async function getJson<T>(app: FastifyInstance, url: string, cookie: string): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie: string
): Promise<T> {
  const response = await postResponse(app, url, payload, cookie);
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function postResponse(app: FastifyInstance, url: string, payload: unknown, cookie: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(payload)
  });
}
