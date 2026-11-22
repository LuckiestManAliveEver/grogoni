import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import { sessionJournalProbe } from "../supabase/functions/api/application-routes";
import type { SqlClient } from "../supabase/functions/api/session-routes";

// The hint stream's combined probe (session check plus journal read in one query), on real
// PostgreSQL: it must agree with the session rules and only ever return the caller's own changes.
const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("hint stream probe on PostgreSQL", () => {
  it("returns the live session's own changes in order, and null once the session is not live", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const client = pool as unknown as SqlClient;
    const accounts: string[] = [];
    async function person() {
      const accountId = randomUUID();
      const userId = randomUUID();
      const sessionId = randomUUID();
      accounts.push(accountId);
      await pool.query(
        `insert into accounts (id, primary_auth_channel, primary_auth_destination, created_at)
         values ($1, 'email', $2, now())`,
        [accountId, `probe-${accountId}@example.invalid`]
      );
      await pool.query(
        `insert into users (id, account_id, display_name, language, created_at)
         values ($1, $2, 'Probe', 'en', now())`,
        [userId, accountId]
      );
      await pool.query(
        `insert into sessions (id, account_id, user_id, expires_at, created_at, device_id,
           device_name, platform, browser_or_app, user_agent_hash, refresh_token_hash,
           session_family_id, refresh_expires_at, last_used_at, inactivity_expires_at,
           absolute_expires_at, authenticated_at)
         values ($1, $2, $3, now() + interval '1 day', now(), 'probe', 'probe', 'web', 'probe',
           'x', $4, $5, now() + interval '1 day', now(), now() + interval '1 day',
           now() + interval '1 day', now())`,
        [sessionId, accountId, userId, `hash-${sessionId}`, randomUUID()]
      );
      const probe = sessionJournalProbe(
        new Request("https://grogoni.invalid/v1/realtime/messages", {
          headers: { cookie: `grogoni_session=${sessionId}` }
        })
      );
      return { accountId, sessionId, probe };
    }
    const change = (accountId: string, sequence: number, conversationId: string) =>
      pool.query(
        `insert into account_sync_changes (account_id, sequence, cursor, collection, entity_id,
           operation, entity, changed_at)
         values ($1, $2, $3, 'conversation_messages', $4, 'upsert', $5, now())`,
        [accountId, sequence, randomUUID(), randomUUID(), { conversationId }]
      );
    try {
      const alice = await person();
      const bob = await person();
      expect(await alice.probe(client, "0")).toEqual({ accountId: alice.accountId, rows: [] });

      await change(alice.accountId, 2, "thread-2");
      await change(alice.accountId, 1, "thread-1");
      await change(bob.accountId, 1, "bob-thread");
      const seen = await alice.probe(client, "0");
      expect(seen.accountId).toBe(alice.accountId);
      expect(seen.rows.map((row) => [row.sequence, row.conversation_id])).toEqual([
        ["1", "thread-1"],
        ["2", "thread-2"]
      ]);
      expect((await alice.probe(client, "1")).rows.map((row) => row.sequence)).toEqual(["2"]);
      expect(await alice.probe(client, "2")).toEqual({ accountId: alice.accountId, rows: [] });

      await pool.query("update sessions set revoked_at = now() where id = $1", [alice.sessionId]);
      expect(await alice.probe(client, "0")).toEqual({ accountId: null, rows: [] });
      await pool.query("update accounts set deleted_at = now() where id = $1", [bob.accountId]);
      expect(await bob.probe(client, "0")).toEqual({ accountId: null, rows: [] });
      const noCookie = sessionJournalProbe(new Request("https://grogoni.invalid/"));
      expect(await noCookie(client, "0")).toEqual({ accountId: null, rows: [] });
    } finally {
      await pool.query("delete from account_sync_changes where account_id = any($1::uuid[])", [
        accounts
      ]);
      await pool.query("delete from sessions where account_id = any($1::uuid[])", [accounts]);
      await pool.query("delete from users where account_id = any($1::uuid[])", [accounts]);
      await pool.query("delete from accounts where id = any($1::uuid[])", [accounts]);
      await pool.end();
    }
  }, 30_000);
});
