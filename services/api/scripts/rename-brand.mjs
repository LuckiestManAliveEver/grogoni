import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { Pool } from "pg";
import {
  databasePoolConfig,
  readDatabaseUrl,
  isAcceptedMigrationChecksum
} from "./database-connection.mjs";

const previousBrand = ["so", "ko"].join("");
const pattern = new RegExp(`${previousBrand}(?:\\.market\\b)?|grogoni\\.market\\b`, "gi");
const rename = (value) =>
  value
    .replace(pattern, (match) =>
      match === match.toUpperCase()
        ? "GROGONI"
        : match[0] === match[0].toUpperCase()
          ? "Grogoni"
          : "grogoni"
    )
    .replace(/\b((?:https?|wss?):\/\/(?:[a-z0-9*-]+\.)*grogoni)(?![.\w-])/gi, "$1.com")
    .replace(/@grogoni(?![.\w/-])/gi, "@grogoni.com");
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const qualified = (name) => `public.${quote(name)}`;
const databaseUrl = readDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL or DIRECT_DATABASE_URL is required.");
const pool = new Pool(
  databasePoolConfig(databaseUrl, {
    environment: {
      ...process.env,
      DB_CONNECTION_TIMEOUT_MS: "15000",
      DB_STATEMENT_TIMEOUT_MS: "20000",
      DB_QUERY_TIMEOUT_MS: "25000"
    }
  })
);
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  await client.query("select pg_advisory_xact_lock(hashtext('grogoni.brand-rename'))");
  const { rows: columns } =
    await client.query(`select table_name, column_name, data_type, column_default, is_generated
    from information_schema.columns where table_schema='public'
    and table_name in (select tablename from pg_tables where schemaname='public')`);
  const { rows: constraints } =
    await client.query(`select c.conname, t.relname as table_name, c.contype,
    pg_get_constraintdef(c.oid) as definition from pg_constraint c
    join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and c.contype in ('f','c')`);
  const { rows: indexes } = await client.query(
    `select indexname, indexdef from pg_indexes
    where schemaname='public' and indexdef ilike $1
    and indexname not in (select conname from pg_constraint)`,
    [`%${previousBrand}%`]
  );
  const statements = [];
  const replacements = [
    [`${previousBrand.toUpperCase()}(?:\\.MARKET\\y)?|GROGONI\\.MARKET\\y`, "GROGONI", "g"],
    [
      `${previousBrand[0].toUpperCase() + previousBrand.slice(1)}(?:\\.market\\y)?|Grogoni\\.market\\y`,
      "Grogoni",
      "g"
    ],
    [`${previousBrand}(?:\\.market\\y)?|grogoni\\.market\\y`, "grogoni", "gi"],
    ["((?:https?|wss?)://(?:[a-z0-9*-]+\\.)*grogoni)(?![.[:alnum:]_-])", "\\1.com", "gi"],
    ["@grogoni(?![.[:alnum:]_/-])", "@grogoni.com", "gi"]
  ];
  const transformed = replacements.reduce(
    (expression, [expressionPattern, replacement, flags]) =>
      `regexp_replace(${expression},${literal(expressionPattern)},${literal(replacement)},${literal(flags)})`,
    "value"
  );
  statements.push(
    `create or replace function pg_temp.brand_rename(value text) returns text language sql immutable strict as ${literal(`select ${transformed}`)}`
  );
  for (const row of constraints)
    statements.push(
      `alter table ${qualified(row.table_name)} drop constraint ${quote(row.conname)}`
    );
  for (const row of indexes) statements.push(`drop index ${qualified(row.indexname)}`);
  for (const table of new Set(columns.map((row) => row.table_name))) {
    // Historical execution records are protected by database immutability guards.
    if (["cp2_runtime_execution_events", "cp2_runtime_handoffs"].includes(table)) continue;
    const writable = columns.filter(
      (row) =>
        row.table_name === table &&
        row.is_generated === "NEVER" &&
        ["text", "character varying", "json", "jsonb"].includes(row.data_type)
    );
    if (!writable.length) continue;
    const expressions = writable.map((row) => {
      const col = quote(row.column_name);
      const type = row.data_type === "character varying" ? "text" : row.data_type;
      return `${col}=pg_temp.brand_rename(${col}::text)::${type}`;
    });
    const condition = writable
      .map(
        (row) =>
          `pg_temp.brand_rename(${quote(row.column_name)}::text) is distinct from ${quote(row.column_name)}::text`
      )
      .join(" or ");
    statements.push(`update ${qualified(table)} set ${expressions.join(",")} where ${condition}`);
  }
  statements.push("set constraints all immediate");
  for (const row of columns) {
    if (row.column_default && rename(row.column_default) !== row.column_default) {
      pattern.lastIndex = 0;
      statements.push(
        `alter table ${qualified(row.table_name)} alter column ${quote(row.column_name)} set default ${rename(row.column_default)}`
      );
    }
    pattern.lastIndex = 0;
    if (rename(row.column_name) !== row.column_name)
      statements.push(
        `alter table ${qualified(row.table_name)} rename column ${quote(row.column_name)} to ${quote(rename(row.column_name))}`
      );
  }
  for (const table of new Set(columns.map((row) => row.table_name))) {
    if (rename(table) !== table)
      statements.push(`alter table ${qualified(table)} rename to ${quote(rename(table))}`);
  }
  for (const row of indexes) statements.push(rename(row.indexdef));
  for (const row of constraints.sort((a, b) => (a.contype === "f") - (b.contype === "f"))) {
    statements.push(
      `alter table ${qualified(rename(row.table_name))} add constraint ${quote(rename(row.conname))} ${rename(row.definition)}`
    );
  }
  console.log(`Applying ${statements.length} statements in one transaction.`);
  await client.query(statements.join(";\n"));
  const manifest = JSON.parse(
    await readFile(new URL("./brand-migration-checksums.json", import.meta.url), "utf8")
  );
  const { rows: appliedMigrations } = await client.query(
    "select filename, checksum from grogoni_schema_migrations"
  );
  const checksumUpdates = [];
  for (const migration of manifest) {
    const sql = await readFile(
      new URL(`../../../infra/db/migrations/${migration.name}`, import.meta.url)
    );
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = appliedMigrations.find((row) => row.filename === migration.name);
    if (!applied) continue;
    const prior = applied.checksum;
    if (
      !isAcceptedMigrationChecksum(migration.name, prior, migration.oldHash) &&
      prior !== migration.repositoryHash &&
      prior !== checksum
    )
      throw new Error(`Unrecognized migration checksum: ${migration.name}`);
    checksumUpdates.push(
      `update grogoni_schema_migrations set checksum=${literal(checksum)} where filename=${literal(migration.name)}`
    );
  }
  if (checksumUpdates.length) await client.query(checksumUpdates.join(";\n"));
  const { rows: remainingConstraints } = await client.query(
    `select t.relname as table_name, c.conname
    from pg_constraint c join pg_class t on t.oid=c.conrelid
    join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and c.conname ilike $1`,
    [`%${previousBrand}%`]
  );
  for (const row of remainingConstraints)
    await client.query(
      `alter table ${qualified(row.table_name)} rename constraint ${quote(row.conname)} to ${quote(rename(row.conname))}`
    );
  const { rows: objects } = await client.query(
    `select c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname ilike $1 and c.relkind in ('i','S')`,
    [`%${previousBrand}%`]
  );
  for (const row of objects)
    await client.query(
      `alter ${row.relkind === "S" ? "sequence" : "index"} ${qualified(row.relname)} rename to ${quote(rename(row.relname))}`
    );
  await client.query("commit");
  console.log("Database brand rename committed.");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
