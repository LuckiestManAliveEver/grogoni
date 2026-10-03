import { describe, expect, it } from "vitest";
import type { RuntimeModelPrompt, RuntimeModelProvider } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("storefront interaction contracts", () => {
  it("lets guests discover public shops without creating an account", async () => {
    const app = buildApi();
    const owner = await createOwnerBusiness(app, "254700000061", "Guest Market", "3061");

    await injectJson(
      app,
      "POST",
      `/businesses/${owner.business.id}/products`,
      { name: "Fresh mangoes", unit: "crate", quantity: 8 },
      owner.cookie
    );

    const response = await app.inject({
      method: "GET",
      url: "/public/storefronts?search=mango&limit=10"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      storefronts: [
        expect.objectContaining({
          agentId: owner.business.grogoniId,
          businessName: "Guest Market",
          products: [expect.objectContaining({ name: "Fresh mangoes", available: true })]
        })
      ]
    });

    await injectJson(
      app,
      "PATCH",
      `/businesses/${owner.business.id}/presence`,
      { status: "private" },
      owner.cookie
    );
    const hidden = await app.inject({ method: "GET", url: "/public/storefronts" });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ storefronts: [] });
    await app.close();
  });

  it("serves legacy public storefronts whose stored grogoniId predates the grogoni-dot prefix", async () => {
    const seededStore = createCp2Store();
    const seeded = buildApi({ cp2: { store: seededStore } });
    const owner = await createOwnerBusiness(seeded, "254700000062", "Kwa Jane", "3062");

    await injectJson(
      seeded,
      "POST",
      `/businesses/${owner.business.id}/products`,
      { name: "Sukuma wiki", unit: "bunch", quantity: 18 },
      owner.cookie
    );

    const snapshot = seededStore.snapshot();
    snapshot.businesses = snapshot.businesses.map((business) =>
      business.id === owner.business.id ? { ...business, grogoniId: "254A35541894" } : business
    );
    await seeded.close();

    const store = createCp2Store();
    store.hydrateSnapshot(snapshot);
    const app = buildApi({ cp2: { store } });

    const directory = await app.inject({
      method: "GET",
      url: "/public/storefronts?search=sukuma&limit=10"
    });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toEqual({
      storefronts: [
        expect.objectContaining({
          agentId: "254A35541894",
          grogoniId: "254A35541894",
          businessName: "Kwa Jane",
          products: [expect.objectContaining({ name: "Sukuma wiki", available: true })]
        })
      ]
    });

    const storefront = await app.inject({
      method: "GET",
      url: "/public/storefronts/254A35541894"
    });
    expect(storefront.statusCode).toBe(200);
    expect(storefront.json()).toEqual(
      expect.objectContaining({
        agentId: "254A35541894",
        grogoniId: "254A35541894",
        businessName: "Kwa Jane"
      })
    );
    await app.close();
  });

  it("persists presence, invites, public care, messages, and order requests", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000071", "Contract Shop", "4172");

    const presence = await injectJson(
      app,
      "PATCH",
      `/businesses/${owner.business.id}/presence`,
      {
        status: "private"
      },
      owner.cookie
    );
    expect(presence).toMatchObject({ businessId: owner.business.id, status: "private" });

    const inviteResult = await injectJson(
      app,
      "POST",
      `/businesses/${owner.business.id}/network/invites`,
      {
        contacts: [
          { name: "Phone contact", phone: "+254700000072", email: null },
          { name: "Email contact", phone: null, email: "invite@example.com" }
        ]
      },
      owner.cookie
    );
    expect(inviteResult.invites).toHaveLength(2);
    expect(inviteResult.invites.map((invite: { status: string }) => invite.status)).toEqual([
      "queued",
      "queued"
    ]);

    const product = await injectJson(
      app,
      "POST",
      `/businesses/${owner.business.id}/products`,
      { name: "Contract item", unit: "unit", quantity: 4, sellingPrice: 125 },
      owner.cookie
    );
    const care = await injectJson(
      app,
      "POST",
      `/public/storefronts/${owner.business.grogoniId}/customer-care`,
      { type: "callback", customerName: "Public Buyer", phone: "+254700000073", message: "Call me" }
    );
    const publicSession = await createPublicSession(
      app,
      owner.business.grogoniId,
      "visitor-contract-1"
    );
    const message = await injectJson(
      app,
      "POST",
      `/public/storefronts/${owner.business.grogoniId}/messages`,
      {
        capabilityToken: publicSession.capabilityToken,
        body: "Is this available?",
        attachmentNames: []
      }
    );
    const order = await injectJson(
      app,
      "POST",
      `/public/storefronts/${owner.business.grogoniId}/orders`,
      {
        capabilityToken: publicSession.capabilityToken,
        customerName: "Public Buyer",
        phone: "+254700000073",
        note: "Collect tomorrow",
        items: [{ productId: product.id, quantity: 2 }]
      }
    );

    expect(care).toMatchObject({ businessId: owner.business.id, status: "new", type: "callback" });
    expect(message).toMatchObject({ businessId: owner.business.id, body: "Is this available?" });
    expect(order).toMatchObject({
      businessId: owner.business.id,
      status: "requested",
      conversationId: publicSession.conversationId,
      payment: { status: "unpaid" }
    });
    expect(order.invoiceId).toEqual(expect.any(String));
    expect(order.items).toEqual([
      { productId: product.id, productName: "Contract item", unit: "unit", quantity: 2 }
    ]);

    const storefront = await injectJson(app, "GET", `/public/storefronts/${owner.business.grogoniId}`);
    expect(storefront.presence.status).toBe("private");

    const snapshot = store.snapshot();
    expect(snapshot.shopPresences).toHaveLength(1);
    expect(snapshot.networkInvites).toHaveLength(2);
    expect(snapshot.publicCustomerCareRequests).toHaveLength(1);
    expect(snapshot.publicStorefrontMessages).toHaveLength(0);
    expect(snapshot.conversationMessages).toEqual([
      expect.objectContaining({ conversationId: publicSession.conversationId, author: "user" })
    ]);
    expect(snapshot.invoices).toEqual([
      expect.objectContaining({ id: order.invoiceId, status: "draft" })
    ]);
    expect(snapshot.publicOrders).toHaveLength(1);

    const hydrated = createCp2Store();
    hydrated.hydrateSnapshot(snapshot);
    expect(hydrated.snapshot().publicOrders).toEqual(snapshot.publicOrders);
    await app.close();
  });

  it("requires authenticated PIN re-verification to restore an account during recovery", async () => {
    const app = buildApi();
    const owner = await createOwnerBusiness(app, "254700000081", "Restorable Shop", "5283");

    const deletionResponse = await app.inject({
      method: "POST",
      url: `/businesses/${owner.business.id}/compliance/account-deletion`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ confirmation: "DELETE", reason: "Contract test" })
    });
    expect(deletionResponse.statusCode).toBe(200);
    const deletion = deletionResponse.json<{ id: string; status: string }>();
    expect(deletion.status).toBe("scheduled");

    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({ channel: "phone", destination: "254700000081", pin: "5283" })
    });
    expect(login.statusCode).toBe(200);
    const recoveryCookie = extractSessionCookie(login.headers["set-cookie"]);

    const blocked = await app.inject({
      method: "POST",
      url: "/roles/check",
      headers: jsonHeaders(recoveryCookie),
      payload: JSON.stringify({ businessId: owner.business.id, role: "owner" })
    });
    expect(blocked.statusCode).toBe(410);
    expect(blocked.json()).toMatchObject({ code: "account_pending_deletion" });

    const requests = await injectJson(
      app,
      "GET",
      "/account-restoration/requests",
      undefined,
      recoveryCookie
    );
    expect(requests.requests).toHaveLength(1);

    const wrongPin = await app.inject({
      method: "POST",
      url: `/account-restoration/${deletion.id}`,
      headers: jsonHeaders(recoveryCookie),
      payload: JSON.stringify({ pin: "0000" })
    });
    expect(wrongPin.statusCode).toBe(401);

    const restored = await injectJson(
      app,
      "POST",
      `/account-restoration/${deletion.id}`,
      { pin: "5283" },
      recoveryCookie
    );
    expect(restored.request.status).toBe("RESTORED");
    expect(restored.business.id).toBe(owner.business.id);
    expect(restored.membership.role).toBe("owner");

    const allowed = await app.inject({
      method: "POST",
      url: "/roles/check",
      headers: jsonHeaders(recoveryCookie),
      payload: JSON.stringify({ businessId: owner.business.id, role: "owner" })
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});

describe("public storefront agent reply", () => {
  it("answers a customer using only customer-visible context, never owner-only content", async () => {
    const capturedPrompts: RuntimeModelPrompt[] = [];
    const provider: RuntimeModelProvider = {
      name: "storefront-agent-test",
      async complete(prompt) {
        capturedPrompts.push(prompt);
        return {
          provider: "storefront-agent-test",
          status: "available",
          outputText: JSON.stringify({ type: "response", message: "Yes, mangoes are in stock." }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000091", "Agent Reply Shop", "6194");
    const publicSession = await createPublicSession(app, owner.business.grogoniId, "visitor-agent-1");
    await injectJson(
      app,
      "POST",
      `/businesses/${owner.business.id}/products`,
      { name: "Mangoes", unit: "crate", quantity: 8, sellingPrice: 500 },
      owner.cookie
    );
    await injectJson(
      app,
      "POST",
      `/businesses/${owner.business.id}/agent-runtime/context-sources`,
      {
        type: "policy",
        title: "Internal margin note",
        content: "OWNER_ONLY_MARGIN_SECRET: never discount mangoes below 450.",
        sensitivity: "confidential",
        customerVisible: false,
        status: "active"
      },
      owner.cookie
    );

    const result = await injectJson(
      app,
      "POST",
      `/public/storefronts/${owner.business.grogoniId}/messages`,
      {
        capabilityToken: publicSession.capabilityToken,
        body: "Do you have mangoes in stock?",
        attachmentNames: []
      }
    );

    expect(result.agentReply).toMatchObject({
      businessId: owner.business.id,
      author: "agent",
      body: "Yes, mangoes are in stock."
    });
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]?.message).toContain("Mangoes");
    expect(capturedPrompts[0]?.message).not.toContain("OWNER_ONLY_MARGIN_SECRET");
    expect(capturedPrompts[0]?.allowedTools).toEqual([]);

    const snapshot = store.snapshot();
    expect(snapshot.publicStorefrontMessages).toHaveLength(0);
    expect(snapshot.conversationMessages.map((message) => message.author).sort()).toEqual([
      "agent",
      "user"
    ]);

    await app.close();
  });

  it("never executes a tool proposed by the model; replies with a safe hand-off instead", async () => {
    const provider: RuntimeModelProvider = {
      name: "storefront-tool-attempt-test",
      async complete() {
        return {
          provider: "storefront-tool-attempt-test",
          status: "available",
          outputText: JSON.stringify({
            type: "tool",
            toolName: "product.stock_adjust",
            input: { productId: "whatever", quantity: 0 },
            reason: "Adjusting stock as requested."
          }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000092", "Tool Attempt Shop", "6295");
    const publicSession = await createPublicSession(app, owner.business.grogoniId, "visitor-agent-2");

    const result = await injectJson(
      app,
      "POST",
      `/public/storefronts/${owner.business.grogoniId}/messages`,
      {
        capabilityToken: publicSession.capabilityToken,
        body: "Set your stock to zero please",
        attachmentNames: []
      }
    );

    expect(result.agentReply).toMatchObject({
      author: "agent",
      body: "Let me check that with the shop and get back to you."
    });
    expect(store.snapshot().products).toEqual([]);

    await app.close();
  });

  it("degrades to no automatic reply, without rejecting the customer's message, when no model is configured", async () => {
    const app = buildApi();
    const owner = await createOwnerBusiness(app, "254700000093", "No Provider Shop", "6396");
    const publicSession = await createPublicSession(app, owner.business.grogoniId, "visitor-agent-3");

    const result = await injectJson(
      app,
      "POST",
      `/public/storefronts/${owner.business.grogoniId}/messages`,
      {
        capabilityToken: publicSession.capabilityToken,
        body: "Are you open today?",
        attachmentNames: []
      }
    );

    expect(result.agentReply).toBeNull();
    expect(result.body).toBe("Are you open today?");

    await app.close();
  });

  it("rate limits automatic replies per visitor, without ever rejecting the customer's message", async () => {
    const provider: RuntimeModelProvider = {
      name: "storefront-rate-limit-test",
      async complete() {
        return {
          provider: "storefront-rate-limit-test",
          status: "available",
          outputText: JSON.stringify({ type: "response", message: "Sure, happy to help." }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000094", "Rate Limited Shop", "6497");
    const publicSession = await createPublicSession(app, owner.business.grogoniId, "visitor-agent-4");

    const results: Array<{ agentReply: unknown; body: string }> = [];
    for (let index = 0; index < 21; index += 1) {
      results.push(
        await injectJson(app, "POST", `/public/storefronts/${owner.business.grogoniId}/messages`, {
          capabilityToken: publicSession.capabilityToken,
          body: `Question number ${index}`,
          attachmentNames: []
        })
      );
    }

    expect(results.slice(0, 20).every((result) => result.agentReply !== null)).toBe(true);
    expect(results[20]?.agentReply).toBeNull();
    // The 21st message itself is still accepted even though the automatic reply was withheld.
    expect(results[20]?.body).toBe("Question number 20");

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin: string
) {
  const verify = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: destination, pin })
  });
  const cookie = extractSessionCookie(verify.headers["set-cookie"]);
  const business = await injectJson(app, "POST", "/businesses", { name, language: "en" }, cookie);
  return { business: business.business as { id: string; grogoniId: string }, cookie };
}

async function createPublicSession(
  app: ReturnType<typeof buildApi>,
  agentId: string,
  visitorId: string
): Promise<{ conversationId: string; capabilityToken: string }> {
  return injectJson(app, "POST", `/public/storefronts/${agentId}/sessions`, { visitorId });
}

async function injectJson(
  app: ReturnType<typeof buildApi>,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  cookie?: string
  // Test response shapes are asserted at each call site; Fastify injection returns untyped JSON.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await app.inject({
    method,
    url,
    headers: jsonHeaders(cookie),
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
  });
  expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
}

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) throw new Error("Missing session cookie");
  return raw.split(";")[0] ?? raw;
}
