import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { transactionPool } from "../services/api/src/edge-transaction-pool";

describe("Edge transaction pool facade", () => {
  it("requests repeatable-read before a verifier savepoint without committing its parent", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = transactionPool({ query } as unknown as PoolClient);
    const client = await pool.connect();
    await client.query("begin isolation level repeatable read");
    await client.query("select current_setting('transaction_isolation')");
    await client.query("commit");
    client.release();
    expect(query.mock.calls.map((args) => args[0])).toEqual([
      "set transaction isolation level repeatable read",
      "savepoint edge_domain_1",
      "select current_setting('transaction_isolation')",
      "release savepoint edge_domain_1"
    ]);
  });
  it("fails closed if the parent transaction cannot establish the required isolation", async () => {
    const query = vi.fn(async () => {
      throw new Error("transaction already observed data");
    });
    const client = await transactionPool({ query } as unknown as PoolClient).connect();
    await expect(client.query("begin isolation level repeatable read")).rejects.toThrow(
      "transaction already observed data"
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
