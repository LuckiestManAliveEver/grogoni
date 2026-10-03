import { Pool, type PoolClient } from "pg";
import { databasePoolConfig, readDatabaseUrl } from "./database-connection.mjs";
import {
  normalizeInternationalOwnerPhoneNumber,
  normalizeOwnerPhoneNumber
} from "../src/cp2/phone-identity.js";

type PhoneSource = "account" | "identity" | "user";

interface PhoneIdentityRow {
  source: PhoneSource;
  record_id: string;
  account_id: string;
  raw_phone: string;
  country: string | null;
}

interface AuditedIdentity extends PhoneIdentityRow {
  canonical: string | null;
  changed: boolean;
  error: string | null;
}

const apply = process.argv.includes("--apply");
const databaseUrl = readDatabaseUrl();
if (databaseUrl === null) {
  console.error("DATABASE_URL or DIRECT_DATABASE_URL is required to audit phone identities.");
  process.exit(1);
}

const pool = new Pool(
  databasePoolConfig(databaseUrl, {
    applicationName: apply ? "grogoni-phone-normalize" : "grogoni-phone-audit",
    poolMaxFallback: 1
  })
);

try {
  const result = await pool.query<PhoneIdentityRow>(`
    select 'user'::text as source, id::text as record_id, account_id::text,
           phone_number_e164 as raw_phone, phone_country_code as country
      from users where phone_number_e164 is not null
    union all
    select 'account'::text as source, id::text as record_id, id::text as account_id,
           primary_auth_destination as raw_phone, null::text as country
      from accounts where primary_auth_channel = 'phone'
    union all
    select 'identity'::text as source, id::text as record_id, account_id::text,
           normalized_value as raw_phone, null::text as country
      from account_identities where type = 'phone'
  `);

  const audited = result.rows.map(auditIdentity);
  const canonicalGroups = new Map<string, AuditedIdentity[]>();
  for (const item of audited) {
    if (item.canonical === null) continue;
    const group = canonicalGroups.get(item.canonical) ?? [];
    group.push(item);
    canonicalGroups.set(item.canonical, group);
  }
  const collisions = [...canonicalGroups.entries()].filter(
    ([, entries]) => new Set(entries.map((entry) => entry.account_id)).size > 1
  );
  const collidingRecords = new Set(collisions.flatMap(([, entries]) => entries.map(recordKey)));

  let updated = 0;
  if (apply) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const item of audited) {
        if (!item.changed || item.canonical === null || collidingRecords.has(recordKey(item))) {
          continue;
        }
        await applyNormalization(client, item);
        updated += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        scanned: audited.length,
        valid: audited.filter((item) => item.canonical !== null).length,
        invalid: audited.filter((item) => item.canonical === null).map(reportIdentity),
        changes: audited
          .filter((item) => item.changed && !collidingRecords.has(recordKey(item)))
          .map(reportIdentity),
        collisions: collisions.map(([canonical, entries]) => ({
          canonical: safeAuditMask(canonical),
          accounts: [...new Set(entries.map((entry) => entry.account_id))],
          records: entries.map(reportIdentity)
        })),
        skippedCollidingRecords: collidingRecords.size,
        updated
      },
      null,
      2
    )
  );
} finally {
  await pool.end();
}

function auditIdentity(row: PhoneIdentityRow): AuditedIdentity {
  try {
    const normalized =
      row.country === null
        ? normalizeInternationalOwnerPhoneNumber(row.raw_phone)
        : normalizeOwnerPhoneNumber(row.raw_phone, row.country);
    return {
      ...row,
      canonical: normalized.e164,
      changed: normalized.e164 !== row.raw_phone,
      error: null
    };
  } catch (error) {
    return {
      ...row,
      canonical: null,
      changed: false,
      error: error instanceof Error ? error.message : "Invalid phone number"
    };
  }
}

async function applyNormalization(client: PoolClient, item: AuditedIdentity): Promise<void> {
  if (item.canonical === null) return;
  const normalized = normalizeInternationalOwnerPhoneNumber(item.canonical);
  if (item.source === "user") {
    await client.query(
      `update users
          set phone_number_e164 = $1, phone_country_code = $2, phone_national_number = $3,
              phone_updated_at = now()
        where id = $4`,
      [normalized.e164, normalized.country, normalized.nationalNumber, item.record_id]
    );
  } else if (item.source === "account") {
    await client.query("update accounts set primary_auth_destination = $1 where id = $2", [
      normalized.e164,
      item.record_id
    ]);
  } else {
    await client.query(
      "update account_identities set normalized_value = $1, display_value = $1, updated_at = now() where id = $2",
      [normalized.e164, item.record_id]
    );
  }
}

function reportIdentity(item: AuditedIdentity) {
  return {
    source: item.source,
    recordId: item.record_id,
    accountId: item.account_id,
    stored: safeAuditMask(item.raw_phone),
    canonical: safeAuditMask(item.canonical),
    error: item.error
  };
}

function recordKey(item: PhoneIdentityRow): string {
  return `${item.source}:${item.record_id}`;
}

function safeAuditMask(value: string | null): string | null {
  if (value === null) return null;
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 7) return `[redacted:${value.length}]`;
  return `${value.trim().startsWith("+") ? "+" : ""}${digits.slice(0, 3)}${"*".repeat(
    Math.max(3, digits.length - 5)
  )}${digits.slice(-2)}`;
}
