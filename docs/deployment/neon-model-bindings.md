# Neon model-binding deployment

## Connection roles

Use a pooled Neon connection for normal API and cron queries:

```dotenv
DATABASE_URL=postgresql://...-pooler.../grogoni?sslmode=verify-full
```

Use a direct Neon connection for migrations:

```dotenv
DIRECT_DATABASE_URL=postgresql://.../grogoni?sslmode=verify-full
```

Production migrations refuse to run without `DIRECT_DATABASE_URL`. The connection helper upgrades
weaker Neon SSL modes to `verify-full`. Keep both values server-only.

## Apply and inspect migrations

Render runs this in `preDeployCommand`:

```bash
NODE_ENV=production pnpm db:migrate
```

The runner takes the `grogoni.schema_migrations` advisory lock, validates checksums, and commits each
migration once. A failure rolls back that migration and fails the deployment. No destructive
migration runs at API startup.

After setting a direct URL locally or in a secure Render shell:

```bash
NODE_ENV=production DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL" pnpm db:migrate
```

Verify migration 040 and its one-active-binding constraint:

```sql
select filename, applied_at
from grogoni_schema_migrations
where filename = '040_agent_model_runtime_bindings.sql';

select indexname, indexdef
from pg_indexes
where tablename = 'cp2_agent_model_bindings';
```

Inspect active bindings:

```sql
select
  entity_id,
  record ->> 'agentId' as agent_id,
  record ->> 'shopId' as shop_id,
  record ->> 'modelId' as model_id,
  record ->> 'executionTarget' as execution_target,
  record ->> 'lastVerificationStatus' as verification_status,
  updated_at
from cp2_agent_model_bindings
where record ->> 'status' = 'active'
order by updated_at desc;
```

Check for impossible duplicates (the query must return no rows):

```sql
select record ->> 'agentId' as agent_id, count(*)
from cp2_agent_model_bindings
where record ->> 'status' = 'active'
group by record ->> 'agentId'
having count(*) > 1;
```

## Transaction and recovery behavior

The CP2 PostgreSQL adapter writes a complete changed snapshot in one transaction. Activation first
performs the live runtime probe, then changes the candidate and previous binding in memory, and the
API response waits for the persistence barrier. If that database transaction fails, the store
reloads its last persisted snapshot, so the previous active binding remains authoritative.
Repeating an equivalent activation re-verifies and updates the existing binding.

The table is a JSONB CP2 envelope. It intentionally has no relational foreign keys for
`agentId`, `shopId`, and `modelId` because those are not physical columns and the repository has no
parallel normalized source-of-truth tables for these entities. Ownership and canonical model checks
are enforced before persistence; the partial unique index is database-enforced.

For rollback, restore the Neon branch/point-in-time snapshot or deploy a reviewed forward migration.
Do not run `040_agent_model_runtime_bindings.down.sql` in production merely to recover an
activation; it drops all model bindings.
