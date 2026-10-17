import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import {
  createEdgeDomainRoutes,
  mayRetryRequest,
  trackIndependentWork
} from "../services/api/src/edge-domain-routes";

/**
 * Regressions from the 2026-10 production browser journey: concurrent reads answered 503
 * (snapshot write conflicts) and a second shop with a taken name answered 503 (unique index).
 */
const state = vi.hoisted(() => ({ snapshot: undefined as Cp2Snapshot | undefined }));
vi.mock("../services/api/src/cp2/postgres-store", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    loadTransactionalCp2Snapshot: async () => structuredClone(state.snapshot),
    saveTransactionalCp2Snapshot: async (_client: unknown, snapshot: Cp2Snapshot) => {
      state.snapshot = structuredClone(snapshot);
    }
  };
});

const conflict = (code = "40001") =>
  Object.assign(new Error(code === "40001" ? "Concurrent snapshot update" : "duplicate key"), {
    code
  });

async function setup(options: { takenIds?: string[]; failFirst?: number; failCode?: string } = {}) {
  const store = createCp2Store();
  const owner = store.continueWithChannelPin({
    channel: "phone",
    destination: "+254712345678",
    pin: "1234"
  });
  state.snapshot = store.snapshot();
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("select grogoni_id as id from businesses"))
        return { rows: (options.takenIds ?? []).map((id) => ({ id })), rowCount: 0 };
      return { rows: [], rowCount: 0 };
    })
  } as unknown as PoolClient;
  let failuresLeft = options.failFirst ?? 0;
  let transactions = 0;
  const domain = await createEdgeDomainRoutes({
    transaction: async (action) => {
      transactions++;
      if (failuresLeft > 0) {
        failuresLeft--;
        throw conflict(options.failCode);
      }
      return action(client);
    }
  });
  const call = (path: string, method = "GET", body?: unknown) =>
    domain.routes(
      new Request(`https://example.com${path}`, {
        method,
        headers: {
          cookie: `grogoni_session=${owner.session.id}`,
          "content-type": "application/json",
          origin: "https://grogoni.com"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      path.split("?")[0]
    );
  return { call, queries, client, transactions: () => transactions };
}

describe("Edge routes under concurrent load", () => {
  beforeEach(() => {
    state.snapshot = createCp2Store().snapshot();
  });

  it("retries a read that lost a snapshot write race instead of answering 503", async () => {
    const { call, transactions } = await setup({ failFirst: 2 });
    const shops = await call("/v1/shops");
    expect(shops!.status).toBe(200);
    expect(transactions()).toBe(3);
  });

  it("gives up after three conflicted reads so the caller sees the failure", async () => {
    const { call, transactions } = await setup({ failFirst: 3 });
    await expect(call("/v1/shops")).rejects.toMatchObject({ code: "40001" });
    expect(transactions()).toBe(3);
  });

  it("never replays an /auth GET: an OAuth callback redeems a single-use code", async () => {
    const { call, transactions } = await setup({ failFirst: 1 });
    await expect(call("/auth/oauth/google/callback?code=c&state=s")).rejects.toMatchObject({
      code: "40001"
    });
    expect(transactions()).toBe(1);
  });

  it("retries only allowlisted reads, and storefront ID claims that lost a race", () => {
    const clean = { independentWork: false };
    const race = conflict();
    for (const path of [
      "/v1/shops",
      "/v1/session/context",
      "/v1/conversations",
      "/v1/conversations/c1",
      "/businesses/b1/products",
      "/public/storefronts",
      "/network/connections"
    ])
      expect(mayRetryRequest("GET", path, clean, race), path).toBe(true);
    expect(mayRetryRequest("HEAD", "/v1/conversations", clean, race)).toBe(true);
    // Single-use codes and third-party calls: never replayed.
    for (const path of [
      "/auth/oauth/google/callback",
      "/api/auth/session",
      "/v1/mailboxes/oauth/google/callback",
      "/buy/search",
      "/businesses/b1/suppliers/phonebook/search",
      "/v1/something-new"
    ])
      expect(mayRetryRequest("GET", path, clean, race), path).toBe(false);
    expect(mayRetryRequest("POST", "/v1/shops", clean, race)).toBe(false);
    expect(mayRetryRequest("GET", "/v1/shops", clean, new Error("boom"))).toBe(false);
    // Work committed in an independent transaction would run again.
    expect(mayRetryRequest("GET", "/v1/shops", { independentWork: true }, race)).toBe(false);
    const duplicate = conflict("23505");
    expect(mayRetryRequest("POST", "/businesses", clean, duplicate)).toBe(true);
    expect(mayRetryRequest("PUT", "/businesses/b1/grogoni-id", clean, duplicate)).toBe(true);
    expect(mayRetryRequest("DELETE", "/businesses/b1/grogoni-id", clean, duplicate)).toBe(false);
    expect(mayRetryRequest("POST", "/v1/products", clean, duplicate)).toBe(false);
    expect(mayRetryRequest("POST", "/businesses", { independentWork: true }, duplicate)).toBe(
      false
    );
  });

  it("records an attempt's independent transaction so it is not retried", async () => {
    const attempt = { independentWork: false };
    const tracked = trackIndependentWork(
      {
        transaction: async (action) => action({} as PoolClient),
        approvalTransaction: async (action) => action({} as PoolClient)
      },
      attempt
    );
    await tracked.transaction(async () => undefined);
    expect(attempt.independentWork).toBe(false);
    await tracked.approvalTransaction!(async () => undefined);
    expect(attempt.independentWork).toBe(true);
  });

  it("never replays a write: a conflicted POST fails once and is not retried", async () => {
    const { call, transactions } = await setup({ failFirst: 1 });
    await expect(
      call("/businesses", "POST", { name: "Edge shop", language: "en" })
    ).rejects.toMatchObject({ code: "40001" });
    expect(transactions()).toBe(1);
  });
});

describe("Edge storefront ID allocation", () => {
  beforeEach(() => {
    state.snapshot = createCp2Store().snapshot();
  });

  it("skips a Grogoni ID another tenant holds, which the scoped snapshot cannot see", async () => {
    const free = await (
      await setup()
    ).call("/businesses", "POST", {
      name: "Mama Mboga",
      language: "en"
    });
    const freeId = (await free!.json()).business.grogoniId as string;

    state.snapshot = createCp2Store().snapshot();
    const { call, queries } = await setup({ takenIds: [freeId] });
    const created = await call("/businesses", "POST", { name: "Mama Mboga", language: "en" });
    expect(created!.status).toBe(200);
    const grogoniId = (await created!.json()).business.grogoniId as string;
    expect(grogoniId).not.toBe(freeId);
    expect(grogoniId.startsWith(freeId)).toBe(true);
    expect(queries.some((sql) => sql.includes("select grogoni_id as id from businesses"))).toBe(
      true
    );
  });

  it("reruns a shop create that lost the race to the same new ID instead of answering 503", async () => {
    const { call, transactions } = await setup({ failFirst: 1, failCode: "23505" });
    const created = await call("/businesses", "POST", { name: "Mama Mboga", language: "en" });
    expect(created!.status).toBe(200);
    expect(transactions()).toBe(2);
  });

  it("reports another tenant's ID as unavailable", async () => {
    const free = await (
      await setup()
    ).call("/businesses", "POST", {
      name: "Mama Mboga",
      language: "en"
    });
    const takenId = (await free!.json()).business.grogoniId as string;
    state.snapshot = createCp2Store().snapshot();
    const { call, queries } = await setup({ takenIds: [takenId] });
    const checked = await call(
      `/public/commerce-identities/availability?address=${encodeURIComponent(takenId)}`
    );
    expect(checked!.status).toBe(200);
    expect((await checked!.json()).available).toBe(false);
    expect(queries.some((sql) => sql.includes("select grogoni_id as id from businesses"))).toBe(
      true
    );
  });

  it("asks the database about the one ID an availability check names, not every tenant's", async () => {
    const { call, client } = await setup();
    await call("/public/commerce-identities/availability?address=grogoni.mama-mboga");
    const lookups = vi
      .mocked(client.query)
      .mock.calls.filter(([sql]) =>
        String(sql).includes("select grogoni_id as id from businesses")
      );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]![1]).toEqual(["grogoni.mama-mboga"]);
  });

  it("does not query every tenant's IDs for requests that cannot claim one", async () => {
    const { call, queries } = await setup();
    await call("/v1/shops");
    expect(queries.some((sql) => sql.includes("select grogoni_id as id from businesses"))).toBe(
      false
    );
  });
});
