import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Pool } from "pg";
import {
  databasePoolConfig,
  isAcceptedMigrationChecksum,
  readDatabaseUrl
} from "./database-connection.mjs";

const rootDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const databaseUrl = readDatabaseUrl();
const migrationsDir = resolve(rootDir, "infra/db/migrations");
const migrationFilenames = (await readdir(migrationsDir))
  .filter((filename) => filename.endsWith(".sql"))
  .sort();

if (databaseUrl === null) {
  console.error("DATABASE_URL or DIRECT_DATABASE_URL is required to verify the database schema.");
  process.exit(1);
}
const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
const isNeonDatabase =
  databaseHostname.endsWith(".neon.tech") || databaseHostname.endsWith(".neon.database");
if (process.env.REQUIRE_NEON_DATABASE === "true" && !isNeonDatabase) {
  console.error("REQUIRE_NEON_DATABASE=true, but the configured database is not a Neon host.");
  process.exit(1);
}

const expectedTables = new Map([
  [
    "account_sync_changes",
    [
      "account_id",
      "sequence",
      "cursor",
      "collection",
      "entity_id",
      "operation",
      "shop_id",
      "entity",
      "changed_at",
      "tombstone_expires_at"
    ]
  ],
  [
    "mcp_access_tokens",
    [
      "id",
      "account_id",
      "user_id",
      "created_by_session_id",
      "token_hash",
      "name",
      "scopes",
      "shop_id",
      "created_at",
      "expires_at",
      "last_used_at",
      "revoked_at"
    ]
  ]
]);
// Corridor fulfillment (089/090, docs/architecture/corridor-fulfillment.md). Checked for columns
// only: fulfillment tables deliberately hold no foreign keys into snapshot-managed tables (§5.2),
// so they do not fit the PK/FK/UNIQUE/CHECK requirement applied to `expectedTables`.
const expectedFulfillmentColumns = new Map([
  ["products", ["unit_weight_grams"]],
  [
    "invoice_items",
    [
      "unit_weight_grams_snapshot",
      "total_weight_grams",
      "weight_status",
      "weight_unresolved_reason"
    ]
  ],
  ["businesses", ["timezone"]],
  ["fulfillment_vehicles", ["id", "business_id", "capacity_grams", "active"]],
  [
    "fulfillment_dispatch_policies",
    ["id", "policy_id", "business_id", "version", "target_load_grams", "active"]
  ],
  ["fulfillment_business_settings", ["business_id", "default_policy_id"]],
  ["fulfillment_shop_locations", ["id", "business_id", "customer_id", "superseded_at"]],
  [
    "fulfillment_idempotency_records",
    ["business_id", "operation", "idempotency_key", "request_hash", "response_snapshot"]
  ],
  [
    "fulfillment_corridors",
    ["id", "business_id", "route_geometry", "distance_meters", "geometry_version", "priority"]
  ],
  ["fulfillment_corridor_geometry_versions", ["corridor_id", "version", "route_geometry"]],
  ["invoices", ["source", "source_message_channel", "created_by_user_id"]],
  [
    "fulfillment_orders",
    [
      "id",
      "business_id",
      "invoice_id",
      "customer_id",
      "confirmed_at",
      "weight_status",
      "total_weight_grams",
      "state",
      "source"
    ]
  ],
  [
    "fulfillment_manifests",
    [
      "id",
      "business_id",
      "corridor_id",
      "corridor_geometry_version",
      "policy_id",
      "policy_version",
      "vehicle_id",
      "vehicle_capacity_grams",
      "status",
      "total_weight_grams"
    ]
  ],
  [
    "fulfillment_manifest_stops",
    [
      "id",
      "manifest_id",
      "fulfillment_order_id",
      "sequence",
      "order_weight_grams",
      "allocation_active",
      "delivery_status",
      "release_reason"
    ]
  ],
  [
    "fulfillment_corridor_resolutions",
    [
      "id",
      "fulfillment_order_id",
      "corridor_id",
      "corridor_geometry_version",
      "shop_location_id",
      "diversion_meters",
      "distance_along_meters",
      "resolution_method",
      "superseded_at"
    ]
  ]
]);
// Multi-provider inference tables (101_multi_provider_inference.sql). Checked for columns only:
// they deliberately have no foreign keys (see that migration's header), so the stricter
// expectedTables constraint check above does not apply.
const expectedInferenceColumns = new Map([
  [
    "inference_providers",
    [
      "id",
      "display_name",
      "provider_type",
      "base_url",
      "execution_target",
      "enabled",
      "credential_ref"
    ]
  ],
  [
    "inference_provider_credentials",
    [
      "id",
      "scope",
      "tenant_id",
      "user_id",
      "provider_id",
      "credential_type",
      "encrypted_secret",
      "key_version",
      "status",
      "created_at",
      "updated_at",
      "revoked_at",
      "last_verified_at"
    ]
  ],
  [
    "inference_runs",
    [
      "id",
      "request_id",
      "conversation_id",
      "agent_id",
      "model_id",
      "provider_id",
      "credential_scope",
      "execution_target",
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "estimated_cost",
      "currency",
      "latency_ms",
      "first_token_ms",
      "status",
      "fallback_from_provider_id",
      "created_at"
    ]
  ],
  ["inference_policies", ["scope", "owner_key", "daily_budget", "fallback_policy"]]
]);
const expectedMigrations = new Map(
  await Promise.all(
    migrationFilenames.map(async (filename) => {
      const sql = await readFile(resolve(migrationsDir, filename), "utf8");
      return [filename, createHash("sha256").update(sql).digest("hex")];
    })
  )
);
const pool = new Pool(
  databasePoolConfig(databaseUrl, {
    applicationName: "grogoni-verify-schema",
    max: 1
  })
);
const client = await pool.connect();

try {
  await client.query("begin transaction read only");
  const connection = await client.query(`
    select current_database() as database_name, current_user as database_user
  `);
  for (const [filename, expectedChecksum] of expectedMigrations) {
    const migration = await client.query(
      `select checksum from grogoni_schema_migrations where filename = $1`,
      [filename]
    );
    if (!isAcceptedMigrationChecksum(filename, migration.rows[0]?.checksum, expectedChecksum)) {
      throw new Error(`${filename} is missing or its recorded checksum does not match.`);
    }
  }

  for (const [tableName, expectedColumns] of expectedTables) {
    const columns = await client.query(
      `
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = $1
      `,
      [tableName]
    );
    const actualColumns = new Set(columns.rows.map((row) => row.column_name));
    const missingColumns = expectedColumns.filter((column) => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(`${tableName} is missing columns: ${missingColumns.join(", ")}`);
    }

    const constraints = await client.query(
      `
        select constraint_type
        from information_schema.table_constraints
        where table_schema = 'public' and table_name = $1
      `,
      [tableName]
    );
    const constraintTypes = new Set(constraints.rows.map((row) => row.constraint_type));
    for (const requiredType of ["PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK"]) {
      if (!constraintTypes.has(requiredType)) {
        throw new Error(`${tableName} is missing a ${requiredType} constraint.`);
      }
    }
  }

  for (const [tableName, expectedColumns] of expectedInferenceColumns) {
    const columns = await client.query(
      `
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = $1
      `,
      [tableName]
    );
    const actualColumns = new Set(columns.rows.map((row) => row.column_name));
    const missingColumns = expectedColumns.filter((column) => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(`${tableName} is missing columns: ${missingColumns.join(", ")}`);
    }
  }

  for (const [tableName, expectedColumns] of expectedFulfillmentColumns) {
    const columns = await client.query(
      `
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = $1
      `,
      [tableName]
    );
    const actualColumns = new Set(columns.rows.map((row) => row.column_name));
    const missingColumns = expectedColumns.filter((column) => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(`${tableName} is missing columns: ${missingColumns.join(", ")}`);
    }
  }

  const invalidConstraints = await client.query(
    `
      select conrelid::regclass::text as table_name, conname
      from pg_constraint
      where connamespace = 'public'::regnamespace
        and not convalidated
      order by conrelid::regclass::text, conname
    `
  );
  if (invalidConstraints.rows.length > 0) {
    throw new Error(
      `Unvalidated constraints remain: ${invalidConstraints.rows
        .map((row) => `${row.table_name}.${row.conname}`)
        .join(", ")}`
    );
  }

  const invalidIndexes = await client.query(
    `
      select indexrelid::regclass::text as index_name
      from pg_index
      where indrelid in (
        select oid from pg_class where relnamespace = 'public'::regnamespace
      )
        and (not indisvalid or not indisready)
      order by indexrelid::regclass::text
    `
  );
  if (invalidIndexes.rows.length > 0) {
    throw new Error(
      `Invalid indexes remain: ${invalidIndexes.rows.map((row) => row.index_name).join(", ")}`
    );
  }

  const duplicateIndexes = await client.query(
    `
      select first_index::regclass::text as first_index,
             second_index::regclass::text as second_index
      from (
        select i1.indexrelid as first_index, i2.indexrelid as second_index
        from pg_index i1
        join pg_index i2
          on i1.indrelid = i2.indrelid
         and i1.indexrelid < i2.indexrelid
         and i1.indkey = i2.indkey
         and i1.indclass = i2.indclass
         and i1.indcollation = i2.indcollation
         and i1.indoption = i2.indoption
         and i1.indexprs is not distinct from i2.indexprs
         and i1.indpred is not distinct from i2.indpred
        join pg_class table_class on table_class.oid = i1.indrelid
        where table_class.relnamespace = 'public'::regnamespace
      ) duplicates
      order by first_index::regclass::text, second_index::regclass::text
    `
  );
  if (duplicateIndexes.rows.length > 0) {
    throw new Error(
      `Duplicate indexes remain: ${duplicateIndexes.rows
        .map((row) => `${row.first_index}/${row.second_index}`)
        .join(", ")}`
    );
  }

  const retiredRuntimeTables = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'cp2_model_preferences',
        'cp2_runtime_hosts',
        'cp2_runtime_model_installations',
        'cp2_agent_model_assignments',
        'cp2_browser_inference_assignments',
        'cp2_agent_model_bindings'
      )
    order by table_name
  `);
  if (retiredRuntimeTables.rows.length > 0) {
    throw new Error(
      `Retired runtime tables remain: ${retiredRuntimeTables.rows
        .map((row) => row.table_name)
        .join(", ")}`
    );
  }

  // Native runtime graph (infra/db/migrations/063_native_runtime_bindings.sql). Column presence
  // alone isn't enough - the whole point of this table set is the relationships between them
  // (a binding resolves through its binding-models to a model, and through a model installation
  // to an execution host), so this also checks each table exists and confirms the foreign keys
  // that make that resolution possible, rather than only checking table names as the retired-table
  // check above does. See docs/architecture/native-runtime-deployment.md.
  const nativeRuntimeTables = new Map([
    ["cp2_native_runtime_agents", ["entity_id", "record", "updated_at"]],
    ["cp2_native_runtime_models", ["entity_id", "record", "updated_at"]],
    ["cp2_native_execution_hosts", ["entity_id", "record", "updated_at"]],
    [
      "cp2_native_model_installations",
      ["entity_id", "parent_id", "model_id", "record", "updated_at"]
    ],
    ["cp2_native_runtime_bindings", ["entity_id", "parent_id", "record", "updated_at"]],
    [
      "cp2_native_runtime_binding_models",
      [
        "entity_id",
        "parent_id",
        "model_id",
        "execution_host_id",
        "role",
        "priority",
        "enabled",
        "record",
        "updated_at"
      ]
    ]
  ]);

  for (const [tableName, expectedColumns] of nativeRuntimeTables) {
    const columns = await client.query(
      `
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = $1
      `,
      [tableName]
    );
    if (columns.rows.length === 0) {
      throw new Error(`Required native runtime table is missing: ${tableName}`);
    }
    const actualColumns = new Set(columns.rows.map((row) => row.column_name));
    const missingColumns = expectedColumns.filter((column) => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(`${tableName} is missing columns: ${missingColumns.join(", ")}`);
    }

    const primaryKey = await client.query(
      `
        select 1
        from information_schema.table_constraints
        where table_schema = 'public' and table_name = $1 and constraint_type = 'PRIMARY KEY'
      `,
      [tableName]
    );
    if (primaryKey.rows.length === 0) {
      throw new Error(`${tableName} is missing a PRIMARY KEY constraint.`);
    }
  }

  async function hasForeignKey(fromTable, toTable) {
    const result = await client.query(
      `
        select 1
        from pg_constraint c
        join pg_class fromClass on fromClass.oid = c.conrelid
        join pg_class toClass on toClass.oid = c.confrelid
        where c.contype = 'f' and fromClass.relname = $1 and toClass.relname = $2
      `,
      [fromTable, toTable]
    );
    return result.rows.length > 0;
  }

  const requiredNativeRuntimeForeignKeys = [
    ["cp2_native_model_installations", "cp2_native_execution_hosts"],
    ["cp2_native_model_installations", "cp2_native_runtime_models"],
    ["cp2_native_runtime_bindings", "cp2_native_runtime_agents"],
    ["cp2_native_runtime_binding_models", "cp2_native_runtime_bindings"],
    ["cp2_native_runtime_binding_models", "cp2_native_runtime_models"],
    ["cp2_native_runtime_binding_models", "cp2_native_execution_hosts"],
    ["cp2_conversations", "cp2_native_runtime_bindings"],
    ["conversations", "cp2_native_runtime_bindings"]
  ];
  for (const [fromTable, toTable] of requiredNativeRuntimeForeignKeys) {
    if (!(await hasForeignKey(fromTable, toTable))) {
      throw new Error(
        `${fromTable} is missing a foreign key into ${toTable}: the native runtime graph is incomplete.`
      );
    }
  }

  const requiredNativeRuntimeIndexes = [
    "cp2_native_runtime_bindings_one_global_default_idx",
    "cp2_native_runtime_binding_models_one_primary_idx",
    "cp2_native_runtime_binding_models_fallback_priority_idx"
  ];
  const existingIndexes = await client.query(
    `select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)`,
    [requiredNativeRuntimeIndexes]
  );
  const existingIndexNames = new Set(existingIndexes.rows.map((row) => row.indexname));
  const missingIndexes = requiredNativeRuntimeIndexes.filter(
    (indexName) => !existingIndexNames.has(indexName)
  );
  if (missingIndexes.length > 0) {
    throw new Error(
      `Native runtime graph is missing required uniqueness guards: ${missingIndexes.join(", ")}`
    );
  }

  // Provider-neutral: no model vendor is required for Grogoni to boot (docs/architecture/
  // provider-neutral-runtime.md). The global default runtime binding is a valid, structurally
  // sound state whether or not a model has been assigned yet ("draft") or one has ("active" with
  // exactly one enabled primary role, matching the check_native_runtime_binding_primary trigger's
  // own invariant) - this must never assert a specific vendor, model id, or execution host.
  const globalDefault = await client.query(`
    select b.entity_id as binding_id,
           b.record ->> 'status' as binding_status,
           a.record ->> 'status' as agent_status,
           (
             select count(*)
             from cp2_native_runtime_binding_models bm
             where bm.parent_id = b.entity_id
               and bm.record ->> 'role' = 'primary'
               and (bm.record ->> 'enabled')::boolean
           ) as enabled_primary_count
    from cp2_native_runtime_bindings b
    join cp2_native_runtime_agents a on a.entity_id = b.parent_id
    where b.record ->> 'isDefault' = 'true'
  `);
  if (globalDefault.rows.length !== 1) {
    throw new Error("There must be exactly one global default runtime binding.");
  }
  const globalDefaultRow = globalDefault.rows[0] ?? {};
  if (globalDefaultRow.agent_status !== "active") {
    throw new Error("The global default runtime binding's agent is not active.");
  }
  if (globalDefaultRow.binding_status !== "active" && globalDefaultRow.binding_status !== "draft") {
    throw new Error(
      `The global default runtime binding has an unexpected status: ${globalDefaultRow.binding_status}.`
    );
  }
  if (
    globalDefaultRow.binding_status === "active" &&
    Number(globalDefaultRow.enabled_primary_count) !== 1
  ) {
    throw new Error(
      "An active global default runtime binding must have exactly one enabled primary model."
    );
  }

  await client.query("commit");
  console.log(
    JSON.stringify(
      {
        status: "ok",
        mode: "read-only",
        migrations: migrationFilenames,
        databaseName: connection.rows[0]?.database_name,
        databaseUser: connection.rows[0]?.database_user,
        databaseProvider: isNeonDatabase ? "neon" : "other",
        globalDefaultRuntimeStatus: globalDefaultRow.binding_status,
        retiredRuntimeTables: "absent",
        nativeRuntimeSchema: "verified"
      },
      null,
      2
    )
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
