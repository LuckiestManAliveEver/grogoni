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
  // Three database round trips regardless of schema size while the global lock is held.
  const metadata = await client.query(
    "create temporary table grogoni_edge_smoke_ids (kind text, id text) on commit drop; select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'cp2_%' order by table_name"
  );
  const allColumns = metadata[1].rows;
  const tables = allColumns
    .filter((row) => row.column_name === "record")
    .map((row) => row.table_name);
  // Gather users and task IDs before deleting any parent rows, without extra network calls.
  await client.query(
    "insert into grogoni_edge_smoke_ids select 'account', unnest($1::text[]) union all select 'business', unnest($2::text[]) union all select 'user', id::text from users where account_id = any($1::uuid[]) union all select 'task', entity_id from cp2_conversations where account_id = any($1::text[]) or business_id = any($2::text[])",
    [ids, businesses]
  );
  const deletions = [];
  for (const table of [
    "cp2_runtime_execution_events",
    "cp2_runtime_transfers",
    "cp2_runtime_task_instances",
    "cp2_runtime_task_heads",
    "cp2_runtime_handoffs"
  ]) {
    if (tables.includes(table))
      deletions.push(
        `delete from ${table} where record->>'taskId' in (select id from grogoni_edge_smoke_ids where kind = 'task');`
      );
  }
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
  for (const table of ["products", "customers", "business_memberships", "businesses"])
    deletions.push(
      `delete from ${table} where ${table === "businesses" ? "id" : "business_id"} in (select id::uuid from grogoni_edge_smoke_ids where kind = 'business');`
    );
  for (const table of [
    "account_sync_changes",
    "auth_audit_events",
    "sessions",
    "account_identities",
    "password_credentials",
    "account_pin_hashes",
    "mfa_factors",
    "recovery_codes",
    "users",
    "accounts"
  ])
    deletions.push(
      `delete from ${table} where ${table === "accounts" ? "id" : "account_id"} in (select id::uuid from grogoni_edge_smoke_ids where kind = 'account');`
    );
  deletions.push(`do $cleanup$ begin
    if to_regclass('grogoni_daemon_tasks') is not null then
      delete from grogoni_daemon_tasks where owner_user_id in (select id from grogoni_edge_smoke_ids where kind = 'user');
    end if;
  end $cleanup$;`);
  await client.query(deletions.join("\n"));
}
