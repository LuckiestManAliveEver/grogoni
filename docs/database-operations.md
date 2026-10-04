# Database operations

Grogoni uses Postgres with Drizzle-managed SQL migrations. Production runtime must not create or mutate schema at API startup; schema changes are applied through the migration command before the API starts.

## Required environment variables

Use a pooled database URL for application runtime:

```bash
DATABASE_URL=postgresql://...
```

Use a direct/admin URL for migrations and maintenance when the provider gives one:

```bash
DIRECT_DATABASE_URL=postgresql://...
```

If `DIRECT_DATABASE_URL` is not set, migration, backup, and restore commands fall back to `DATABASE_URL`.

## Brand rename

For a database created before the Grogoni rename, stop API writers and run this maintenance task before deploying the renamed API or running its migrations:

```bash
node --env-file=.env --env-file=.env.local services/api/scripts/rename-brand.mjs
```

The task renames public tables, columns, constraints, indexes, defaults, and writable text and JSON records in one transaction. It verifies applied migration checksums against the recorded pre-rename hashes before updating the migration ledger. An error rolls back the transaction. Immutable execution events and handoff records retain their historical contents.

Update hosted environment variables to the `GROGONI_` names in `.env.example` and deploy the matching API and web builds together. Existing browser storage and Android installs use different names after the rename.

## Run migrations

```bash
pnpm db:migrate
```

The migration runner:

- reads SQL files from `infra/db/migrations`;
- records applied files in `grogoni_schema_migrations`;
- verifies checksums on already-applied migrations;
- uses an advisory lock so two deploys do not apply migrations concurrently.

Render runs this as the API `preDeployCommand`. This keeps schema changes in a release phase instead of coupling them to TypeScript compilation.

The API will fail startup if the latest required migration has not been applied.

## Verify schema without writing application data

When only one managed database branch is available, verify the deployed schema with:

```bash
DIRECT_DATABASE_URL=postgresql://... pnpm db:verify-schema
```

This opens a read-only transaction and verifies the migration 018 and 019 checksums, sync and MCP
token table columns, and required constraint types. It does not create test accounts, shops,
products, sync records, or access tokens.

## Create a backup

Install PostgreSQL client tools locally so `pg_dump` is available, then run:

```bash
DIRECT_DATABASE_URL=postgresql://... pnpm db:backup
```

Backups are written to `backups/` and ignored by Git. Production backups must leave ephemeral runtime storage. Set:

```bash
BACKUP_UPLOAD_COMMAND='aws s3 cp {file} s3://your-private-bucket/grogoni/'
BACKUP_RETENTION_DAYS=14
```

`{file}` is replaced with the generated dump path. The backup command records each run in `database_backup_runs`.

For production, create a backup before every migration that changes tables, constraints, indexes, or data shape.

Render also defines a daily `grogoni-db-backup` cron service. It intentionally fails in production unless `BACKUP_UPLOAD_COMMAND` is configured.

## Verify a backup

```bash
DB_BACKUP_FILE=backups/grogoni-YYYY-MM-DD.dump pnpm db:backup:verify
```

This runs `pg_restore --list` and records the operational path for restore drills. A production restore drill should be performed against a disposable database branch at least monthly.

## Restore a backup

Restores are destructive. Use only against the intended target database.

```bash
DIRECT_DATABASE_URL=postgresql://... DB_RESTORE_FILE=backups/grogoni-YYYY-MM-DD.dump pnpm db:restore
```

The restore command uses `pg_restore --clean --if-exists --no-owner`.

## Rollback procedure

Forward-only migrations are the default, but paired rollback SQL lives in `infra/db/rollbacks` for migrations where rollback is technically possible.

To roll back the latest migration:

```bash
ALLOW_DB_ROLLBACK=true DB_ROLLBACK_STEPS=1 DIRECT_DATABASE_URL=postgresql://... pnpm db:rollback
```

Rollback deletes the corresponding row from `grogoni_schema_migrations` and records the rollback in `grogoni_schema_rollbacks`.

If a deployment fails after a migration:

1. Stop or roll back the API deploy.
2. Decide whether the failed app version can run against the migrated schema.
3. If not, restore the latest pre-migration backup into a replacement database or branch.
4. Point `DATABASE_URL` and `DIRECT_DATABASE_URL` at the restored database.
5. Redeploy the last known-good API commit.
6. Preserve the failed database until the incident review is complete.

Do not manually delete rows from `grogoni_schema_migrations` in production unless you are restoring the whole database to a known snapshot.

## Runtime persistence policy

The API must fail fast when migrations are missing. It must not create tables from application startup code. This keeps deploys deterministic and makes schema changes auditable.

Core business records hydrate from relational tables. The `cp2_*` tables remain as compatibility tables for non-core CP2 collections while the API surface is incrementally moved to direct relational access.

Each save upserts only the relational records that changed since the last successful save (`cp2_persistence_saved` logs how many after each relational commit, with `journal: "ok"` or `"failed"`); a `cp2_*` compatibility collection is still sent whole, in bulk, when any record in it changes. Saves run under a transaction-scoped advisory lock that is safe through Neon's transaction-mode pooler. The API never re-reads Postgres while running, so stop every API instance before editing CP2 tables by hand and start it afterwards; see [Out-of-band database edits](runbooks/cp2-store-lock-leak.md#out-of-band-database-edits). Columns that triggers or the save derive from the clock at write time (`sessions.revoked_at` for expired sessions, `verification_challenges.status` for expired challenges) are refreshed only when that row is next written; readers enforce expiry from the stored timestamps. If saves fail with `55P03` (lock_not_available), follow [the CP2 store lock leak runbook](runbooks/cp2-store-lock-leak.md).

## Monitoring and pool settings

Use:

```bash
DIRECT_DATABASE_URL=postgresql://... pnpm db:health
```

This checks connectivity, records the result in `database_health_checks`, and prints the latest applied migration.

Runtime pool controls:

```bash
DB_POOL_MAX=5
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
DB_QUERY_TIMEOUT_MS=15000
DB_STATEMENT_TIMEOUT_MS=15000
DB_PERSISTENCE_QUEUE_WARN_MS=10000
DB_SLOW_QUERY_MS=500
DB_PERSISTENCE_RETRY_INITIAL_MS=2000
DB_PERSISTENCE_RETRY_MAX_MS=60000
DB_STARTUP_MAX_ATTEMPTS=6
```

Boot-time database steps (schema checks, the inference provider refresh and the CP2 snapshot
load) retry transient network and connection failures, making up to `DB_STARTUP_MAX_ATTEMPTS`
attempts per step with jittered backoff; `1` disables retries. A schema check or snapshot load that
still fails aborts startup. A provider refresh that still fails does not: boot continues and the
refresh keeps retrying in the background. Each retry logs a `db.startup_retry` (or
`db.background_retry`) JSON line. See
[docs/runbooks/db-startup-dns-flake.md](runbooks/db-startup-dns-flake.md).

Slow persistence operations are logged by the API when they exceed `DB_SLOW_QUERY_MS`.
`GET /health/db` reports pending and queued persistence work, the active operation and its age,
and the most recent queue wait/run durations. Database health becomes degraded when the oldest
pending operation reaches `DB_PERSISTENCE_QUEUE_WARN_MS`.

A failed persistence attempt does not revert application state; it retries automatically with
exponential backoff starting at `DB_PERSISTENCE_RETRY_INITIAL_MS`, doubling up to
`DB_PERSISTENCE_RETRY_MAX_MS`, until it succeeds. `GET /health/db`'s `persistenceError` field
reports the most recent failure (`null` once a retry succeeds) - alert on it being non-null for an
extended period, since that indicates Postgres has been unreachable long enough that in-memory and
persisted state have diverged (see
[`docs/single-instance-store-ceiling.md`](single-instance-store-ceiling.md) for what that means for
a crash during the divergence window).

## Failover

For managed Postgres providers such as Neon:

1. Use a pooled `DATABASE_URL` for runtime traffic.
2. Use a direct `DIRECT_DATABASE_URL` for migrations, backups, restores, and health checks.
3. Keep a documented fallback database branch or restored database URL available.
4. During an incident, update both database URLs together and redeploy the API.
5. Run `pnpm db:health` after failover before sending traffic back to the API.
