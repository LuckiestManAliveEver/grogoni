import type { Pool, PoolClient } from "pg";

/**
 * A Pool facade over one already-open transaction client, for code written against a Pool (the
 * Postgres blob stores, the fulfillment service). Its nested BEGIN/COMMIT/ROLLBACK become
 * savepoints, so that code's own transactions nest inside the request's or job's transaction
 * instead of committing independently.
 */
export function transactionPool(client: PoolClient): Pool {
  let sequence = 0;
  return {
    query: client.query.bind(client),
    async connect() {
      const name = `edge_domain_${++sequence}`;
      return {
        async query(sql: string, values?: unknown[]) {
          const command = sql.trim().toLowerCase();
          if (command === "begin isolation level repeatable read") {
            await client.query("set transaction isolation level repeatable read");
            return client.query(`savepoint ${name}`);
          }
          if (command === "begin") return client.query(`savepoint ${name}`);
          if (command === "commit") return client.query(`release savepoint ${name}`);
          if (command === "rollback") return client.query(`rollback to savepoint ${name}`);
          return client.query(sql, values);
        },
        release() {}
      };
    }
  } as unknown as Pool;
}
