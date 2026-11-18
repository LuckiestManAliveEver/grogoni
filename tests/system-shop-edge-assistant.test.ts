import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";
import {
  systemShop,
  systemShopProductId,
  systemShopStockPolicy
} from "../services/api/src/cp2/domains/system-shop/catalogue";

/**
 * The Edge buyer assistant with Jane's Shop. The loader below behaves like the real scoped Edge
 * loader: buyer search and assistant turns never see Jane's rows (systemShopScopedRoute,
 * edge-snapshot-scope searched_businesses), but the confirm-checkout request loads her by agent
 * ID. The model is scripted.
 */
const state = vi.hoisted(() => ({
  snapshot: undefined as Cp2Snapshot | undefined,
  accountId: "",
  path: "",
  modelOutputs: [] as unknown[],
  saves: [] as Cp2Snapshot[]
}));
vi.mock("../services/api/src/cp2/postgres-store", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadTransactionalCp2Snapshot: async (_client: unknown, scope: { path?: string }) => {
    const snapshot = structuredClone(state.snapshot!);
    const confirming = scope.path === "confirm";
    if (confirming) return snapshot;
    return {
      ...snapshot,
      businesses: snapshot.businesses.filter((b) => b.id !== systemShop.businessId),
      products: snapshot.products.filter((p) => p.businessId !== systemShop.businessId)
    };
  },
  saveTransactionalCp2Snapshot: async (_client: unknown, snapshot: Cp2Snapshot) => {
    state.saves.push(structuredClone(snapshot));
    // Persist like the real diff: rows present in the save replace the stored ones.
    const stored = state.snapshot!;
    const byId = <T extends { id: string }>(current: T[], next: T[]) => {
      const merged = new Map(current.map((row) => [row.id, row]));
      for (const row of next) merged.set(row.id, row);
      return [...merged.values()];
    };
    state.snapshot = {
      ...snapshot,
      businesses: byId(stored.businesses, snapshot.businesses),
      products: byId(stored.products, snapshot.products)
    };
  }
}));
vi.mock("../services/api/src/cp2/edge-snapshot-scope", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeSnapshotScope: async (
    _client: unknown,
    _request: Request,
    path: string,
    payload?: Buffer
  ) => {
    const message = payload ? (JSON.parse(payload.toString()) as { message?: string }).message : "";
    return {
      accountId: state.accountId,
      withClause: "",
      predicate: () => "true",
      path: path === "/buy/assistant" && message === "confirm checkout" ? "confirm" : path
    };
  }
}));
vi.mock("../services/api/src/edge-store-dependencies", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeStoreDependencies: () => ({
    runtimeModelProvider: {
      name: "openrouter",
      complete: async () => ({
        provider: "openrouter",
        status: "available",
        outputText: JSON.stringify(
          state.modelOutputs.shift() ?? { type: "response", message: "Done" }
        ),
        durationMs: 1,
        errorCode: null,
        metadata: {}
      })
    }
  })
}));

describe("Jane's Shop through the Edge buyer assistant", () => {
  it("quotes from the plan, confirms against the real shop, and never saves plan rows", async () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const buyer = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254700009120",
      pin: "3927"
    });
    const assistantId = store.getGrogoniSessionContext({
      sessionId: buyer.session.id
    }).conversationId;
    store.updateAssistantPermissions(buyer.session.id, assistantId, { buy: true, execute: false });
    state.accountId = buyer.account.id;
    state.snapshot = store.snapshot();
    const realWafers = () =>
      state.snapshot!.products.find((p) => p.id === systemShopProductId("nuvita-wafers"))!;
    const stockBefore = realWafers().quantity;

    // The readiness query says Jane's Shop is complete; everything else returns no rows.
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.includes("cp2_agent_profiles")
          ? { rows: [{ products: "713", ready: true }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      )
    } as unknown as PoolClient;
    const domain = await createEdgeDomainRoutes({ transaction: async (work) => work(client) });
    const shoppingSessionId = randomUUID();
    const send = async (message: string) => {
      const response = await domain.routes(
        new Request("https://grogoni.com/buy/assistant", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `grogoni_session=${buyer.session.id}`
          },
          body: JSON.stringify({ shoppingSessionId, requestId: randomUUID(), message })
        }),
        "/buy/assistant"
      );
      return { status: response!.status, body: await response!.json() };
    };

    state.modelOutputs.push(
      { type: "tool", toolName: "commerce.search", input: { query: "nuvita" } },
      {
        type: "tool",
        toolName: "commerce.checkout",
        input: {
          items: [
            {
              sourceKind: "catalogue",
              sourceId: systemShop.grogoniId,
              sourceLabel: "Jane's Shop",
              title: "Nuvita Wafers",
              quantity: 2,
              agentId: systemShop.grogoniId,
              productId: systemShopProductId("nuvita-wafers"),
              statusBroadcastId: null,
              productCaptureItemId: null,
              websiteUrl: null
            }
          ]
        }
      }
    );
    const review = await send("Buy two Nuvita Wafers from Jane's Shop");
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.pendingCheckout).toBe(true);
    expect(review.body.reply).toContain("Jane's Shop");
    // Nothing plan-derived reached storage: Jane's real rows are untouched.
    expect(realWafers().quantity).toBe(stockBefore);
    for (const saved of state.saves) {
      expect(saved.products.some((p) => p.businessId === systemShop.businessId)).toBe(false);
      expect(saved.businesses.some((b) => b.id === systemShop.businessId)).toBe(false);
    }

    const confirmed = await send("confirm checkout");
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const checkout = state.snapshot!.unifiedCheckouts?.find(
      (c) => c.id === confirmed.body.checkoutId
    );
    expect(checkout?.handoffs).toEqual([
      expect.objectContaining({ sourceLabel: "Jane's Shop", status: "completed" })
    ]);
    expect(realWafers().quantity).toBe(stockBefore - 2);
    expect(stockBefore - 2).toBeGreaterThan(systemShopStockPolicy.restockThreshold);
  });
});
