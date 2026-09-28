/**
 * Network connections on real PostgreSQL (docs/architecture/phonebook-identity-resolution.md):
 * requests, acceptances, declines and removals survive a restart, and a merge-mode phonebook sync
 * keeps its contacts and discovery. Skipped unless CP2_POSTGRES_TEST_DATABASE_URL points at a
 * database migrated with `pnpm db:migrate`.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Pool as PgPool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import type { NetworkConnectionSummary, NetworkGraphSummary } from "../packages/shared-types/src";
import { ok, signUp, uniquePhone } from "./fixtures/fulfillment-test-helpers";

const { Pool } = createRequire(resolve(process.cwd(), "services/api/package.json"))("pg") as {
  Pool: new (options: { connectionString: string }) => PgPool;
};

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("network connections on PostgreSQL", () => {
  let pool: PgPool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl ?? "" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps synced contacts and every connection state across a restart", async () => {
    const first = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const firstApp = buildApi({
      cp2: { store: first },
      mutationPersistenceFlush: () => first.flush()
    });
    const owner = await signUp(firstApp);
    const people = await Promise.all(
      ["Accepted", "Pending", "Declined", "Removed"].map(async (name) => {
        const phone = uniquePhone();
        return { name, phone, ...(await signUp(firstApp, phone)) };
      })
    );
    const synced = await ok<NetworkGraphSummary>(
      firstApp,
      "POST",
      "/network/sync/contacts",
      owner.cookie,
      {
        mode: "merge",
        contacts: people.map((person) => ({ name: person.name, phone: `+${person.phone}` }))
      }
    );
    const connectionIds = new Map<string, string>();
    for (const [index, person] of people.entries()) {
      const requested = await ok<NetworkConnectionSummary>(
        firstApp,
        "POST",
        "/network/connections",
        owner.cookie,
        { nodeId: synced.syncedContactNodeIds?.[index] }
      );
      connectionIds.set(person.name, requested.id);
    }
    const byName = (name: string) => people.find((person) => person.name === name)!;
    await ok(
      firstApp,
      "POST",
      `/network/connections/${connectionIds.get("Accepted")}/respond`,
      byName("Accepted").cookie,
      { accept: true }
    );
    await ok(
      firstApp,
      "POST",
      `/network/connections/${connectionIds.get("Declined")}/respond`,
      byName("Declined").cookie,
      { accept: false }
    );
    // Removing an accepted connection deletes it (a recipient removing a pending one declines).
    await ok(
      firstApp,
      "POST",
      `/network/connections/${connectionIds.get("Removed")}/respond`,
      byName("Removed").cookie,
      { accept: true }
    );
    await ok(
      firstApp,
      "DELETE",
      `/network/connections/${connectionIds.get("Removed")}`,
      byName("Removed").cookie
    );
    await first.flush();
    await firstApp.close();

    const rows = await pool.query<{ id: string; status: string }>(
      "select entity_id as id, record->>'status' as status from cp2_network_connections where record->>'requesterUserId' = $1",
      [owner.userId]
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))).toEqual({
      [connectionIds.get("Accepted")!]: "accepted",
      [connectionIds.get("Pending")!]: "pending",
      [connectionIds.get("Declined")!]: "declined"
    });

    // The discovery budget the sync spent is persisted too (migration 106).
    const budgets = await pool.query<{ total: string }>(
      "select sum((entry ->> 'count')::int)::text as total from cp2_discovery_budgets, jsonb_array_elements(record -> 'entries') as entry where user_id = $1",
      [owner.userId]
    );
    expect(Number(budgets.rows[0]?.total)).toBe(people.length);

    // Reloaded with a budget the persisted spending already used up: still enforced.
    const second = await createPostgresCp2Store({
      databaseUrl: databaseUrl ?? "",
      networkLimits: { phonebookSyncDailyBudget: people.length }
    });
    const secondApp = buildApi({
      cp2: { store: second },
      mutationPersistenceFlush: () => second.flush()
    });
    const graph = await ok<NetworkGraphSummary>(secondApp, "GET", "/network", owner.cookie);
    const overBudget = await secondApp.inject({
      method: "POST",
      url: "/network/sync/contacts",
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify({
        mode: "merge",
        contacts: [{ name: "New", phone: "+254722999001" }]
      })
    });
    expect(overBudget.statusCode).toBe(429);
    expect(
      second.snapshot().discoveryBudgets?.find((budget) => budget.userId === owner.userId)
    ).toMatchObject({ entries: [expect.objectContaining({ count: people.length })] });
    const direct = graph.nodes.filter((node) => node.degree === 1);
    expect(direct).toHaveLength(4);
    expect(direct.every((node) => node.sokoUserId !== null)).toBe(true);
    expect(
      Object.fromEntries(
        (graph.connections ?? []).map((connection) => [
          connection.counterpartDisplayName,
          connection.status
        ])
      )
    ).toEqual({ Accepted: "accepted", Pending: "pending", Declined: "pending" });
    const incoming = await ok<{ connections: NetworkConnectionSummary[] }>(
      secondApp,
      "GET",
      "/network/connections",
      byName("Pending").cookie
    );
    expect(incoming.connections).toEqual([
      expect.objectContaining({ direction: "incoming", status: "pending" })
    ]);
    await secondApp.close();
    // Two full store loads against a shared database that grows with every Postgres suite.
  }, 60_000);
});
