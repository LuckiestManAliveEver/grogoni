/** Uses existing cp2_contact_hashes JSON records; preserves graph/hash IDs. Dry-run by default.
 * Run with --import tsx and server environment files, then --apply after reviewing counts.
 */
import { createRequire } from "node:module";
import { URL } from "node:url";
import { protectStoredContactHash } from "../services/api/src/cp2/domains/network/shared.ts";
const { Client } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
if (!(process.env.CONTACT_DISCOVERY_HMAC_SECRET || process.env.AUTH_AUDIT_HMAC_SECRET)?.trim())
  throw new Error("A stable server contact-discovery or audit HMAC secret is required.");
const client = new Client({
  connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000
});
const apply = process.argv.includes("--apply");
await client.connect();
try {
  await client.query("begin");
  await client.query("set local lock_timeout = '10s'");
  const records = await client.query(
    "select entity_id, record from cp2_contact_hashes where record->>'hashType' in ('phone','email') and record->>'hashValue' ~ '^[a-f0-9]{64}$' for update"
  );
  for (const { entity_id: id, record } of records.rows) {
    const next = {
      ...record,
      hashValue: protectStoredContactHash(record.hashType, record.hashValue)
    };
    if (apply)
      await client.query(
        "update cp2_contact_hashes set record=$2::jsonb where entity_id=$1 and record=$3::jsonb",
        [id, JSON.stringify(next), JSON.stringify(record)]
      );
  }
  await client.query(apply ? "commit" : "rollback");
  console.log(
    JSON.stringify({
      mode: apply ? "applied" : "dry-run",
      fingerprints: records.rowCount,
      identifiersLogged: false
    })
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
