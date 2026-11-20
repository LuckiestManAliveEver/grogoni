import { randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

// Starting a conversation with the same person twice, even at the same moment from two devices
// or from both sides, must give one conversation. The Edge API serializes these creates with a
// per-pair advisory lock (edge-snapshot-scope.ts, directPairLock); this drives the real pipeline.

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("conversation dedupe on PostgreSQL (Edge)", () => {
  it("returns one conversation for concurrent creates between the same two people", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local lock_timeout = '10s'");
        await client.query(
          "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))"
        );
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    try {
      const store = createCp2Store();
      const baseline = store.snapshot();
      const phone = () => `+442079460${String(randomInt(0, 1000)).padStart(3, "0")}`;
      let phoneA = phone();
      let phoneB = phone();
      while (phoneB === phoneA) phoneB = phone();
      const a = store.continueWithChannelPin({
        channel: "phone",
        destination: phoneA,
        pin: "3927"
      });
      const b = store.continueWithChannelPin({
        channel: "phone",
        destination: phoneB,
        pin: "3927"
      });
      phoneA = a.account.primaryAuthDestination;
      phoneB = b.account.primaryAuthDestination;
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction });
      const create = async (sessionId: string, recipient: string) => {
        const response = await edge.routes(
          new Request("https://grogoni.com/v1/conversations", {
            method: "POST",
            headers: {
              cookie: `grogoni_session=${sessionId}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ kind: "personal", activeShopId: null, recipient })
          }),
          "/v1/conversations"
        );
        expect(response?.status, await response?.clone().text()).toBe(200);
        return ((await response!.json()) as { conversation: { id: string } }).conversation.id;
      };

      const ids = await Promise.all([
        create(a.session.id, phoneB),
        create(a.session.id, phoneB),
        create(b.session.id, phoneA)
      ]);
      expect(new Set(ids).size).toBe(1);

      const rows = await pool.query(
        `select count(distinct p.record->>'conversationId') as n
           from cp2_conversation_participants p
           join cp2_conversation_participants q
             on q.record->>'conversationId' = p.record->>'conversationId'
          where p.account_id = $1 and q.account_id = $2`,
        [a.account.id, b.account.id]
      );
      expect(Number(rows.rows[0].n)).toBe(1);
      // A later create from either side reuses it.
      expect(await create(b.session.id, phoneA)).toBe(ids[0]);
    } finally {
      await pool.end();
    }
    // Cold Edge runtime plus three creates serialized by the pair lock.
  }, 30_000);
});
