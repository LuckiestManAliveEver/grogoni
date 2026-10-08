import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";

const require = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = require("pg");
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to run with a disposable Neon test fixture.");
const pool = new Pool(databasePoolConfig(process.env.DATABASE_URL, { max: 1 }));
const accountId = randomUUID();
const userId = randomUUID();
const sessionIds = [randomUUID(), randomUUID()];
const familyId = randomUUID();
const base = "https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api";
async function call(path, method = "GET", cookie) {
  return fetch(base + path, {
    method,
    headers: cookie ? { cookie } : {},
    signal: globalThis.AbortSignal.timeout(20000)
  });
}
try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into accounts (id, primary_auth_channel, primary_auth_destination, created_at)
      values ($1, 'email', $2, now())`,
      [accountId, `edge-test-${accountId}@example.invalid`]
    );
    await client.query(
      `insert into users (id, account_id, display_name, language, created_at)
      values ($1, $2, 'Disposable Edge test', 'en', now())`,
      [userId, accountId]
    );
    for (const id of sessionIds) {
      await client.query(
        `insert into sessions (id, account_id, user_id, session_family_id,
        expires_at, refresh_expires_at, inactivity_expires_at, absolute_expires_at, created_at)
        values ($1, $2, $3, $4, now() + interval '10 minutes', now() + interval '1 hour',
          now() + interval '1 hour', now() + interval '2 hours', now())`,
        [id, accountId, userId, familyId]
      );
      await client.query(
        `insert into cp2_sessions (entity_id, account_id, user_id, record)
        values ($1, $2, $3, $4)`,
        [
          id,
          accountId,
          userId,
          JSON.stringify({ id, accountId, userId, sessionFamilyId: familyId, revokedAt: null })
        ]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  assert.equal((await call("/session")).status, 401);
  const cookie = `grogoni_session=${sessionIds[0]}`;
  const authenticated = await call("/session", "GET", cookie);
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).account.id, accountId);
  const logout = await call("/auth/logout", "POST", cookie);
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).revoked, true);
  const clearedCookies = logout.headers.getSetCookie();
  for (const name of ["grogoni_session", "grogoni_refresh"]) {
    assert.ok(
      clearedCookies.some((cookie) => cookie.startsWith(`${name}=`) && cookie.includes("Max-Age=0"))
    );
  }
  for (const id of sessionIds)
    assert.equal((await call("/session", "GET", `grogoni_session=${id}`)).status, 401);
  const revoked = await pool.query(
    `select count(*)::integer as count from sessions
    where id = any($1::uuid[]) and revoked_at is not null`,
    [sessionIds]
  );
  assert.equal(revoked.rows[0].count, 2);
  const mirrored = await pool.query(
    `select count(*)::integer as count from cp2_sessions
    where entity_id = any($1::text[]) and record->>'revocationReason' = 'logout'`,
    [sessionIds]
  );
  assert.equal(mirrored.rows[0].count, 2);
  console.log(
    "PASS: anonymous denial, authenticated session, logout, family revocation, compatibility parity."
  );
} finally {
  try {
    await pool.query("delete from cp2_sessions where entity_id = any($1::text[])", [sessionIds]);
    await pool.query("delete from sessions where id = any($1::uuid[])", [sessionIds]);
    await pool.query("delete from users where id = $1", [userId]);
    await pool.query("delete from accounts where id = $1", [accountId]);
    const remaining = await pool.query(
      "select count(*)::integer as count from accounts where id = $1",
      [accountId]
    );
    assert.equal(remaining.rows[0].count, 0);
    console.log("Disposable test account and sessions removed.");
  } finally {
    await pool.end();
  }
}
