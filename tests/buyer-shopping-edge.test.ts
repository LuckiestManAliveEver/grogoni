import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

const state = vi.hoisted(() => ({
  snapshot: undefined as Cp2Snapshot | undefined,
  activeTransactions: 0,
  modelCalls: 0,
  saves: 0,
  accountId: "",
  conflict: false
}));
vi.mock("../services/api/src/cp2/postgres-store", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadTransactionalCp2Snapshot: async () => structuredClone(state.snapshot),
  saveTransactionalCp2Snapshot: async (_client: unknown, snapshot: Cp2Snapshot) => {
    if (state.conflict) throw Object.assign(new Error("Concurrent snapshot"), { code: "40001" });
    state.saves++;
    state.snapshot = structuredClone(snapshot);
  }
}));
vi.mock("../services/api/src/cp2/edge-snapshot-scope", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeSnapshotScope: async () => ({
    accountId: state.accountId,
    withClause: "",
    predicate: () => "true"
  })
}));
vi.mock("../services/api/src/edge-store-dependencies", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeStoreDependencies: () => ({
    runtimeModelProvider: {
      name: "openrouter",
      complete: async () => {
        expect(state.activeTransactions).toBe(0);
        state.modelCalls++;
        return {
          provider: "openrouter",
          status: "available",
          outputText: JSON.stringify({
            type: "response",
            message: "Which retailer should I browse?"
          }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    }
  })
}));

describe("Edge customer shopping", () => {
  beforeEach(() => {
    state.activeTransactions = 0;
    state.modelCalls = 0;
    state.saves = 0;
    state.conflict = false;
  });
  async function setup() {
    const store = createCp2Store();
    const buyer = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254700000723",
      pin: "1234"
    });
    state.accountId = buyer.account.id;
    state.snapshot = store.snapshot();
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 }))
    } as unknown as PoolClient;
    const domain = await createEdgeDomainRoutes({
      transaction: async (work) => {
        state.activeTransactions++;
        try {
          return await work(client);
        } finally {
          state.activeTransactions--;
        }
      }
    });
    const call = (sessionId = buyer.session.id) =>
      domain.routes(
        new Request("https://grogoni.com/buy/assistant", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `grogoni_session=${sessionId}` },
          body: JSON.stringify({
            shoppingSessionId: randomUUID(),
            requestId: randomUUID(),
            message: "Find shoes from external websites"
          })
        }),
        "/buy/assistant"
      );
    return { domain, call };
  }
  it("releases its read transaction before model inference and persists the result afterwards", async () => {
    const h = await setup();
    const result = await h.call();
    expect(result?.status).toBe(200);
    expect(state.modelCalls).toBe(1);
    expect(state.saves).toBe(1);
    expect(state.snapshot?.buyerShoppingSessions).toHaveLength(1);
    expect(state.activeTransactions).toBe(0);
  });
  it("returns a conflict instead of reporting an unsaved assistant result", async () => {
    const h = await setup();
    state.conflict = true;
    expect((await h.call())?.status).toBe(409);
    expect(state.saves).toBe(0);
  });
  it("rejects unauthenticated requests before any model call", async () => {
    const h = await setup();
    expect((await h.call(randomUUID()))?.status).toBe(401);
    expect(state.modelCalls).toBe(0);
    expect(state.saves).toBe(0);
  });
});
