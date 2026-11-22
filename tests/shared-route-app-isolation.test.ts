import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

// The Edge API serves non-MCP requests from one Fastify app per isolate, resolving each
// request's store and services through AsyncLocalStorage. Interleaved requests from different
// accounts must each act as their own account, and a client cannot pick another request's context
// by sending the internal context header. Snapshot load and save are stubbed (no database) with
// random delays so requests genuinely interleave.
const state = vi.hoisted(() => ({ snapshot: undefined as unknown }));
vi.mock("../services/api/src/cp2/postgres-store", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    loadTransactionalCp2Snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
      return structuredClone(state.snapshot);
    },
    saveTransactionalCp2Snapshot: async () => undefined
  };
});

describe("shared Edge route app isolation", () => {
  it("keeps 60 interleaved requests from 4 accounts apart, ignoring a spoofed context header", async () => {
    const store = createCp2Store();
    const actors = Array.from({ length: 4 }, (_, index) =>
      store.continueWithChannelPin({
        channel: "phone",
        destination: `+25471234567${index}`,
        pin: "3927"
      })
    );
    state.snapshot = store.snapshot() as Cp2Snapshot;
    const client = {
      query: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        return { rows: [], rowCount: 0 };
      })
    } as unknown as PoolClient;
    const domain = await createEdgeDomainRoutes({ transaction: async (action) => action(client) });
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        const actor = actors[index % actors.length]!;
        const response = await domain.routes(
          new Request("https://grogoni.com/v1/conversations", {
            method: "POST",
            body: JSON.stringify({ kind: "personal", activeShopId: null, title: `t${index}` }),
            headers: {
              "content-type": "application/json",
              cookie: `grogoni_session=${actor.session.id}`,
              origin: "https://grogoni.com",
              "x-grogoni-edge-route-context": "attacker"
            }
          }),
          "/v1/conversations"
        );
        return { own: actor.account.id, status: response!.status, body: await response!.text() };
      })
    );
    expect([...new Set(results.map((result) => result.status))]).toEqual([200]);
    for (const result of results) {
      expect(result.body).toContain(result.own);
      for (const other of actors)
        if (other.account.id !== result.own) expect(result.body).not.toContain(other.account.id);
    }
  }, 60_000);
});
