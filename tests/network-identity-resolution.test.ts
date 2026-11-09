import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store, readSessionCookie } from "../services/api/src/cp2/store";
import type {
  IdentityCandidateSummary,
  NetworkGraphSummary,
  NetworkNodeSummary
} from "../packages/shared-types/src";

interface CreateBusinessResponse {
  business: {
    id: string;
  };
}

describe("Phonebook identity resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a contact by phone, exact name, and substring name, ranked by confidence", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000401");

    await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      {
        contacts: [{ name: "Kamau Cereals", phone: "+254700000402" }]
      },
      sessionCookie
    );

    const byPhone = await getJson<{ query: string; matches: Array<{ matchType: string }> }>(
      app,
      "/network/contacts/resolve?query=%2B254700000402",
      sessionCookie
    );
    expect(byPhone.matches[0]).toMatchObject({ matchType: "phone" });

    const byExactName = await getJson<{
      matches: Array<{ matchType: string; confidence: number }>;
    }>(app, "/network/contacts/resolve?query=Kamau%20Cereals", sessionCookie);
    expect(byExactName.matches[0]).toMatchObject({ matchType: "name", confidence: 0.85 });

    const bySubstring = await getJson<{
      matches: Array<{ matchType: string; confidence: number }>;
    }>(app, "/network/contacts/resolve?query=Kamau", sessionCookie);
    expect(bySubstring.matches[0]).toMatchObject({ matchType: "name", confidence: 0.5 });

    const noMatch = await getJson<{ matches: unknown[] }>(
      app,
      "/network/contacts/resolve?query=Nobody%20Here",
      sessionCookie
    );
    expect(noMatch.matches).toHaveLength(0);

    await app.close();
  });

  it("never lets an observed identity attach without an explicit confirm - propose only creates a pending candidate", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000403");

    const graphBeforeSync = await getJson<NetworkGraphSummary>(app, "/network", sessionCookie);
    expect(graphBeforeSync.identityCandidates).toHaveLength(0);

    await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      { contacts: [{ name: "Kamau Cereals", phone: "+254700000404" }] },
      sessionCookie
    );

    const candidate = store.proposeIdentityCandidate({
      sessionId: readSessionCookie(sessionCookie),
      provider: "instagram",
      providerSubject: "kamau_cereals",
      displayName: "Kamau Cereals",
      handle: "@kamau_cereals",
      evidence: "Seen on instagram.com/kamau_cereals while browsing a supplier page."
    });

    expect(candidate.status).toBe("pending");
    expect(candidate.nodeId).not.toBeNull(); // exact display-name match guessed, not auto-linked

    const graph = await getJson<NetworkGraphSummary>(app, "/network", sessionCookie);
    expect(graph.identityCandidates).toHaveLength(1);
    const contactNode = graph.nodes.find((node) => node.displayName === "Kamau Cereals");
    expect(contactNode?.externalIdentityIds).toEqual([]); // still not attached

    await app.close();
  });

  it("attaches an identity to the guessed contact only once the owner confirms it", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000405");
    const sessionId = readSessionCookie(sessionCookie);

    await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      { contacts: [{ name: "Kamau Cereals", phone: "+254700000406" }] },
      sessionCookie
    );

    const candidate = store.proposeIdentityCandidate({
      sessionId,
      provider: "instagram",
      providerSubject: "kamau_cereals",
      displayName: "Kamau Cereals",
      handle: "@kamau_cereals",
      evidence: "Seen on instagram.com/kamau_cereals."
    });

    const confirmed = await postJson<NetworkNodeSummary>(
      app,
      `/network/identity-candidates/${candidate.id}/confirm`,
      {},
      sessionCookie
    );
    expect(confirmed.externalIdentityIds).toHaveLength(1);

    const afterConfirm = await getJson<{ candidates: IdentityCandidateSummary[] }>(
      app,
      "/network/identity-candidates",
      sessionCookie
    );
    expect(afterConfirm.candidates).toHaveLength(0); // no longer pending

    const resolved = await getJson<{
      matches: Array<{ matchType: string; node: NetworkNodeSummary }>;
    }>(app, "/network/contacts/resolve?query=%40kamau_cereals", sessionCookie);
    expect(resolved.matches[0]).toMatchObject({ matchType: "handle" });
    expect(resolved.matches[0]?.node.id).toBe(confirmed.id);

    await app.close();
  });

  it("requires an explicit contact choice when a candidate has no confident guess", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000407");
    const sessionId = readSessionCookie(sessionCookie);

    const candidate = store.proposeIdentityCandidate({
      sessionId,
      provider: "whatsapp",
      providerSubject: "254700099999",
      displayName: "Unknown Trader",
      evidence: "Seen while browsing a marketplace listing."
    });
    expect(candidate.nodeId).toBeNull();

    const ambiguous = await app.inject({
      method: "POST",
      url: `/network/identity-candidates/${candidate.id}/confirm`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({})
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({ code: "identity_candidate_ambiguous" });

    const created = await postJson<NetworkNodeSummary>(
      app,
      `/network/identity-candidates/${candidate.id}/confirm`,
      { createNewContact: true },
      sessionCookie
    );
    expect(created.displayName).toBe("Unknown Trader");
    expect(created.externalIdentityIds).toHaveLength(1);
    expect(created.sourceType).toBe("manual");

    await app.close();
  });

  it("discards a rejected candidate without ever attaching it", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000408");
    const sessionId = readSessionCookie(sessionCookie);

    const candidate = store.proposeIdentityCandidate({
      sessionId,
      provider: "tiktok",
      providerSubject: "someone",
      displayName: "Someone",
      evidence: "Seen while browsing."
    });

    const rejected = await postJson<{ rejected: boolean }>(
      app,
      `/network/identity-candidates/${candidate.id}/reject`,
      {},
      sessionCookie
    );
    expect(rejected.rejected).toBe(true);

    const list = await getJson<{ candidates: IdentityCandidateSummary[] }>(
      app,
      "/network/identity-candidates",
      sessionCookie
    );
    expect(list.candidates).toHaveLength(0);

    const confirmAfterReject = await app.inject({
      method: "POST",
      url: `/network/identity-candidates/${candidate.id}/confirm`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({})
    });
    expect(confirmAfterReject.statusCode).toBe(409);
    expect(confirmAfterReject.json()).toMatchObject({
      code: "identity_candidate_already_resolved"
    });

    await app.close();
  });

  it("lets the owner add and unlink an identity directly, distinct from an observed candidate", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000409");

    const graph = await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      { contacts: [{ name: "Jane Supplier", phone: "+254700000410" }] },
      sessionCookie
    );
    const node = graph.nodes.find((candidate) => candidate.displayName === "Jane Supplier");
    expect(node).toBeDefined();

    const withIdentity = await postJson<NetworkNodeSummary>(
      app,
      `/network/nodes/${node!.id}/identities`,
      { provider: "whatsapp", providerSubject: "+254700000410", handle: "+254700000410" },
      sessionCookie
    );
    expect(withIdentity.externalIdentityIds).toHaveLength(1);

    const identityId = withIdentity.externalIdentityIds[0]!;
    const unlinked = await app.inject({
      method: "DELETE",
      url: `/network/nodes/${node!.id}/identities/${identityId}`,
      headers: { cookie: sessionCookie }
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json<NetworkNodeSummary>().externalIdentityIds).toHaveLength(0);

    await app.close();
  });

  it("is idempotent under re-observation and refuses to propose an already-confirmed identity", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000411");
    const sessionId = readSessionCookie(sessionCookie);

    const first = store.proposeIdentityCandidate({
      sessionId,
      provider: "instagram",
      providerSubject: "repeat_observation",
      displayName: "Repeat Person",
      evidence: "First page visit."
    });
    const second = store.proposeIdentityCandidate({
      sessionId,
      provider: "instagram",
      providerSubject: "repeat_observation",
      displayName: "Repeat Person",
      evidence: "Second page visit, same identity."
    });
    expect(second.id).toBe(first.id); // no duplicate pending candidate

    const list = store.listIdentityCandidates({ sessionId });
    expect(list).toHaveLength(1);

    store.confirmIdentityCandidate({ sessionId, candidateId: first.id, createNewContact: true });

    expect(() =>
      store.proposeIdentityCandidate({
        sessionId,
        provider: "instagram",
        providerSubject: "repeat_observation",
        displayName: "Repeat Person",
        evidence: "Third page visit, already confirmed."
      })
    ).toThrowError(/already linked/);

    await app.close();
  });

  it("keeps provenance distinct across imported, verified, observed, and user_entered paths", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { sessionCookie } = await createOwnerBusiness(app, "254700000412");
    const sessionId = readSessionCookie(sessionCookie);

    await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/social/instagram",
      { profiles: [{ name: "Imported Person", handle: "@imported" }] },
      sessionCookie
    );

    const candidate = store.proposeIdentityCandidate({
      sessionId,
      provider: "tiktok",
      providerSubject: "observed_person",
      displayName: "Observed Person",
      evidence: "Seen while browsing."
    });
    const confirmedNode = store.confirmIdentityCandidate({
      sessionId,
      candidateId: candidate.id,
      createNewContact: true
    });

    const manualNode = store.addManualIdentity({
      sessionId,
      nodeId: confirmedNode.id,
      provider: "email",
      providerSubject: "observed.person@example.test"
    });

    const snapshot = store.snapshot();
    const importedIdentity = snapshot.externalIdentities.find(
      (identity) => identity.handle === "@imported"
    );
    const observedIdentity = snapshot.externalIdentities.find(
      (identity) => identity.provider === "tiktok" && identity.displayName === "Observed Person"
    );
    const userEnteredIdentity = snapshot.externalIdentities.find(
      (identity) => identity.provider === "email"
    );

    expect(importedIdentity?.provenance).toBe("imported");
    expect(observedIdentity?.provenance).toBe("observed");
    expect(userEnteredIdentity?.provenance).toBe("user_entered");
    expect(manualNode.externalIdentityIds).toContain(userEnteredIdentity?.id);

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string
): Promise<CreateBusinessResponse & { sessionCookie: string }> {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: destination,
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Phonebook Shop",
      language: "en"
    },
    sessionCookie
  );

  return {
    ...business,
    sessionCookie
  };
}

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: cookie === undefined ? {} : { cookie }
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined) {
    throw new Error("Missing session cookie");
  }

  return raw.split(";")[0] ?? raw;
}
