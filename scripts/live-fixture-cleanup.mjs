/**
 * Deletes disposable accounts (and any shops they own) created by live checks against a real
 * database: scripts/test-supabase-business.mjs and scripts/eval-daemon-lanes-live.ts. Runs inside
 * the caller's transaction, which must already hold the store lock
 * (pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))). Also removes the accounts'
 * daemon tasks. Only ever pass IDs the caller itself created.
 */
export async function deleteLiveFixtureAccounts(client, { accountIds, businessIds = [] }) {
  const ids = [...accountIds];
  const businesses = [...businessIds];
  const users = (
    await client.query("select id from users where account_id = any($1::uuid[])", [ids])
  ).rows.map((row) => row.id);
  const tables = (
    await client.query(
      "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'record' and table_name like 'cp2_%' order by table_name"
    )
  ).rows.map((row) => row.table_name);
  const allColumns = (
    await client.query(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'cp2_%'"
    )
  ).rows;
  await client.query(
    "create temporary table grogoni_edge_smoke_ids (kind text, id text) on commit drop"
  );
  await client.query(
    "insert into grogoni_edge_smoke_ids select 'account', unnest($1::text[]) union all select 'business', unnest($2::text[]) union all select 'user', unnest($3::text[])",
    [ids, businesses, users]
  );
  const deletions = [];
  // Remove descendants before their runtime-binding and business parents.
  const priority = [
    "cp2_conversation_messages",
    "cp2_conversation_attachments",
    "cp2_conversations",
    "cp2_native_runtime_bindings",
    "cp2_native_execution_hosts",
    "cp2_native_runtime_models",
    "cp2_native_runtime_agents"
  ];
  for (const table of [
    ...priority.filter((table) => tables.includes(table)),
    ...tables.filter((table) => !priority.includes(table))
  ]) {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Invalid schema table name.");
    const columns = new Set(
      allColumns.filter((row) => row.table_name === table).map((row) => row.column_name)
    );
    const conditions = [
      columns.has("account_id")
        ? "account_id::text in (select id from grogoni_edge_smoke_ids where kind = 'account')"
        : "false",
      columns.has("business_id")
        ? "business_id::text in (select id from grogoni_edge_smoke_ids where kind = 'business')"
        : "false",
      columns.has("user_id")
        ? "user_id::text in (select id from grogoni_edge_smoke_ids where kind = 'user')"
        : "false",
      columns.has("entity_id")
        ? "entity_id::text in (select id from grogoni_edge_smoke_ids)"
        : "false"
    ];
    deletions.push(`delete from ${table} where (${conditions.join(" or ")});`);
  }
  await client.query(deletions.join("\n"));
  for (const table of ["products", "business_memberships"])
    await client.query(`delete from ${table} where business_id = any($1::uuid[])`, [businesses]);
  await client.query("delete from businesses where id = any($1::uuid[])", [businesses]);
  for (const table of [
    "account_sync_changes",
    "auth_audit_events",
    "sessions",
    "account_identities",
    "password_credentials",
    "account_pin_hashes",
    "mfa_factors",
    "recovery_codes"
  ])
    await client.query(`delete from ${table} where account_id = any($1::uuid[])`, [ids]);
  await client.query("delete from users where account_id = any($1::uuid[])", [ids]);
  await client.query("delete from accounts where id = any($1::uuid[])", [ids]);
  const daemonQueue = await client.query("select to_regclass('grogoni_daemon_tasks') as name");
  if (daemonQueue.rows[0]?.name)
    await client.query("delete from grogoni_daemon_tasks where owner_user_id = any($1::text[])", [
      users
    ]);
}
