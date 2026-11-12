import type { RuntimeModelPrompt } from "../packages/shared-types/src";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assistantActions,
  assistantToolAction,
  assistantToolAllowed,
  assistantPermissionsVersion,
  defaultAssistantPermissions,
  normalizeAssistantPermissions
} from "../packages/shared-types/src";
import { runtimeToolRegistry } from "../packages/tool-core/src";
import { createCp2Store } from "../services/api/src/cp2/store";
import { buildApi } from "../services/api/src/app";

function guest(store: ReturnType<typeof createCp2Store>) {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return store.continueWithDevice({
    sessionId: null,
    devicePublicKeyJwk: key.publicKey.export({ format: "jwk" }),
    idempotencyKey: crypto.randomUUID()
  });
}
describe("assistant action permissions", () => {
  it("authorizes the checklist endpoints and saves only the current account's grants", async () => {
    const store = createCp2Store();
    const owner = store.signupWithPhonePin({ destination: "+254712345668", pin: "1234" });
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    const app = buildApi({ cp2: { store } });
    try {
      const url = `/v1/conversations/${id}/permissions`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const headers = { cookie: `grogoni_session=${owner.session.id}` };
      const initial = await app.inject({ method: "GET", url, headers });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().permissions).toEqual(defaultAssistantPermissions());
      expect(initial.json().functions).toHaveLength(Object.keys(runtimeToolRegistry).length);
      const updated = await app.inject({ method: "PUT", url, headers, payload: { send: true } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().permissions.send).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("withholds app context and read tools from the model after Read is disabled", async () => {
    const prompts: RuntimeModelPrompt[] = [];
    const store = createCp2Store({
      runtimeModelProvider: {
        name: "permission-context-test",
        async complete(prompt) {
          prompts.push(prompt);
          return {
            provider: "permission-context-test",
            status: "available",
            outputText: JSON.stringify({ type: "response", message: "Ready." }),
            durationMs: 1,
            errorCode: null,
            metadata: {}
          };
        }
      }
    });
    const owner = store.signupWithPhonePin({ destination: "+254712345665", pin: "1234" });
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    const business = store.createBusiness({
      sessionId: owner.session.id,
      name: "Private shop",
      language: "en"
    });
    store.updateAssistantPermissions(owner.session.id, id, { read: false });
    await store.createRuntimeTurn({
      sessionId: owner.session.id,
      businessId: business.business.id,
      message: "Hello, tell me what help you can offer"
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.context).toBeUndefined();
    expect(prompts[0]!.retrievedContext).toEqual([]);
    expect(prompts[0]!.allowedTools).not.toContain("products.list");
  });
  it("classifies every executable tool and enables only read and edit initially", () => {
    expect(
      Object.keys(runtimeToolRegistry).filter((tool) => assistantToolAction(tool) === null)
    ).toEqual([]);
    expect(assistantActions.every((action) => defaultAssistantPermissions()[action.id])).toBe(true);
    for (const tool of ["commerce.search", "product.update", "messaging.send", "commerce.checkout"])
      expect(assistantToolAllowed(defaultAssistantPermissions(), tool)).toBe(true);
    expect(assistantToolAllowed(defaultAssistantPermissions(), "new.unknown")).toBe(false);
    expect(
      assistantToolAllowed({ ...defaultAssistantPermissions(), store: false }, "product.update")
    ).toBe(false);
    expect(
      assistantToolAllowed({ ...defaultAssistantPermissions(), buy: false }, "commerce.checkout")
    ).toBe(false);
  });
  it("ignores old saves that wrote the former defaults, but keeps new choices", () => {
    const old = { read: true, edit: false, create: false, store: false };
    expect(normalizeAssistantPermissions(old)).toMatchObject({
      edit: false,
      create: true,
      store: true
    });
    expect(
      normalizeAssistantPermissions({ ...old, version: assistantPermissionsVersion })
    ).toMatchObject({ create: false, store: false });
  });
  it("persists account permissions and refuses access from another account", () => {
    const store = createCp2Store();
    const owner = store.signupWithPhonePin({ destination: "+254712345670", pin: "1234" });
    const other = store.signupWithPhonePin({ destination: "+254712345671", pin: "1234" });
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    expect(store.getAssistantPermissions(owner.session.id, id).permissions).toEqual(
      defaultAssistantPermissions()
    );
    store.updateAssistantPermissions(owner.session.id, id, { send: true, edit: false });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(restored.getAssistantPermissions(owner.session.id, id).permissions.send).toBe(true);
    expect(restored.assistantPermissionErrors(owner.session.id, "messaging.send")).toEqual([]);
    expect(restored.assistantPermissionErrors(owner.session.id, "product.update")).not.toEqual([]);
    expect(() => store.updateAssistantPermissions(other.session.id, id, { send: true })).toThrow(
      /not found/iu
    );
    expect(() =>
      store.updateAssistantPermissions(owner.session.id, id, { arbitrary: true })
    ).toThrow(/valid assistant permissions/iu);
  });
  it("lets guests buy with no credential, and honours a permission turned off", () => {
    const store = createCp2Store();
    const session = guest(store);
    const id = store.getGrogoniSessionContext({ sessionId: session.session.id }).conversationId;
    expect(store.searchBuyFeed({ sessionId: session.session.id, query: "maize" })).toBeDefined();
    const seller = store.signupWithPhonePin({ destination: "+254712345679", pin: "1234" });
    const shop = store.createBusiness({
      sessionId: seller.session.id,
      name: "Maize shop",
      language: "en"
    });
    const product = store.createProduct({
      sessionId: seller.session.id,
      businessId: shop.business.id,
      product: { name: "Maize", unit: "kg", quantity: 10, buyingPrice: 50, sellingPrice: 100 }
    });
    const item = store
      .searchBuyFeed({ sessionId: session.session.id, query: "maize" })
      .results.find((result) => result.productId === product.id)!;
    const checkout = store.createUnifiedCheckout({
      sessionId: session.session.id,
      items: [
        {
          ...item,
          quantity: 1,
          agentId: item.agentId ?? null,
          productId: product.id,
          statusBroadcastId: null,
          productCaptureItemId: null
        }
      ]
    });
    expect(checkout.failures).toHaveLength(0);
    expect(checkout.handoffs).toHaveLength(1);
    expect(store.assistantPermissionErrors(session.session.id, "commerce.search")).toEqual([]);
    store.updateAssistantPermissions(session.session.id, id, { buy: false });
    expect(store.assistantPermissionErrors(session.session.id, "commerce.checkout")).not.toEqual(
      []
    );
    expect(store.getSession(session.session.id)?.account.identityLevel).toBe("device");
    expect(
      store.snapshot().accountPinHashes.some((record) => record.accountId === session.account.id)
    ).toBe(false);
    expect(store.snapshot().passkeys).toHaveLength(0);
  });
});
