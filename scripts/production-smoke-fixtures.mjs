import { createRequire } from "node:module";
import { URL } from "node:url";
import { createHmac, randomInt } from "node:crypto";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";

const require = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = require("pg");

export function createProductionSmokeFixtures() {
  if (!process.env.DATABASE_URL || !process.env.AUTH_AUDIT_HMAC_SECRET)
    throw new Error(
      "Production smoke requires database and audit credentials for fixture cleanup."
    );
  const pool = new Pool({ ...databasePoolConfig(process.env.DATABASE_URL), max: 1 });
  const startedAt = new Date().toISOString();
  const transactions = new Set();
  const phones = new Set();
  const rateKeys = new Set();
  return {
    nextPhone() {
      // Ofcom's reserved London drama range: https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama
      const phone = `+442079460${String(randomInt(1000)).padStart(3, "0")}`;
      phones.add(phone);
      rateKeys.add(
        createHmac("sha256", process.env.AUTH_AUDIT_HMAC_SECRET)
          .update(`phone:${phone}`)
          .digest("hex")
      );
      return phone;
    },
    track(transactionId) {
      if (typeof transactionId === "string" && /^[a-f0-9-]{36}$/i.test(transactionId))
        transactions.add(transactionId);
    },
    async cleanup() {
      let client;
      try {
        client = await pool.connect();
        await client.query("begin");
        const ids = [...transactions];
        const removed = await client.query(
          `delete from auth_transactions where purpose = 'signup' and consumed_at is null
           and (id = any($1::uuid[]) or (created_at >= $2 and metadata->>'identifierValue' = any($3::text[]))) returning id`,
          [ids, startedAt, [...phones]]
        );
        await client.query("delete from cp2_auth_transactions where entity_id = any($1::text[])", [
          removed.rows.map((row) => row.id)
        ]);
        await client.query(
          "delete from auth_audit_events where created_at >= $1 and metadata->>'rateKey' = any($2::text[]) and account_id is null",
          [startedAt, [...rateKeys]]
        );
        await client.query("commit");
      } catch (error) {
        if (client) await client.query("rollback");
        throw error;
      } finally {
        client?.release();
        await pool.end();
      }
    }
  };
}
