# Native runtime schema/deployment compatibility

## Incident this document exists because of

Render production crashed at startup:

```
error: relation "cp2_model_preferences" does not exist
code: 42P01
at async loadNormalizedSnapshot services/api/dist/cp2/postgres-store.js
at async createPostgresCp2Store
```

`cp2_model_preferences` (with `cp2_runtime_hosts` and `cp2_runtime_model_installations`) is a
retired Execution Fabric table. `infra/db/migrations/065_retire_execution_fabric.sql` migrates its
data into the native runtime graph and then permanently drops all three. Current TypeScript source
(`services/api/src/cp2/postgres-store.ts`) does not query any of them - `normalizedCollections`
only names `cp2_native_*` tables.

**Root cause, proven from the repository, not assumed:** commit `2424644` ("Retire Execution
Fabric...") deleted `services/api/src/cp2/domains/execution-fabric/{store,host-presence,
registry-adapter,runtime-route}.ts` from source. `services/api/package.json`'s build script was
plain `tsc -p tsconfig.build.json`, with no clean step. Plain `tsc` (non-`--build`, non-composite)
never deletes a compiled output file whose input `.ts` file was removed - it only re-emits outputs
for files still present in the current `include` set. The compiled tree
`services/api/dist/cp2/domains/execution-fabric/*.js` - including a `store.js` built from source
that queried `cp2_model_preferences`, `cp2_runtime_hosts`, and `cp2_runtime_model_installations` -
therefore survived on disk, untouched, in every build since. This was reproduced directly in this
repository: running the real (un-cleaned) build script left that orphaned module in `dist/`, and
`node scripts/check-retired-runtime-references.mjs` flagged it immediately. A `rm -rf dist && tsc`
rebuild removes it.

This is exactly the class of bug the "stale `dist`" hypothesis in the incident brief named - proven
concretely, not by elimination. Whether Render's specific build additionally hit the
migrate-before-build ordering hazard below (§3) in the same window cannot be confirmed after the
fact from logs alone, but that ordering hazard is real, independently dangerous, and is fixed
below regardless.

## Permanent architecture

Agent, model, and execution host are independent, swappable slots. Resolution happens **in
process, against PostgreSQL** - there is no separate orchestration/broker service.

```
Conversation
     │ runtime_binding_id
     ▼
cp2_native_runtime_bindings ──► cp2_native_runtime_agents
     │
     ▼
cp2_native_runtime_binding_models
     │
     ▼
cp2_native_runtime_models
     │
     ▼
cp2_native_model_installations
     │
     ▼
cp2_native_execution_hosts
```

`cp2_conversations.runtime_binding_id` and `conversations.runtime_binding_id` are generated
columns with a `references cp2_native_runtime_bindings(entity_id)` foreign key
(`infra/db/migrations/063_native_runtime_bindings.sql`). `services/api/src/cp2/postgres-store.ts`
loads native runtime tables into `normalizedCollections` _before_ `conversations`, specifically so
a conversation rebound to a binding created in the same flush never violates that FK.

## Retired tables: historical only

`cp2_model_preferences`, `cp2_runtime_hosts`, `cp2_runtime_model_installations` (created by
migration 060, dropped by migration 065) must never return to production runtime code. References
to them are legitimate only in:

- `infra/db/migrations/060_execution_fabric_entities.sql` and
  `infra/db/migrations/065_retire_execution_fabric.sql` (history and the retirement itself)
- `infra/db/rollbacks/060_execution_fabric_entities.down.sql`
- `services/api/scripts/verify-db-schema.mjs` (verifying their **absence**)
- `services/api/scripts/backfill-native-runtime-bindings.mjs` (the one-shot backfill tool that
  reads them - by design, before they are dropped)
- Migration/rollback/backfill tests, and docs marked historical
  (`docs/architecture/agent-execution-fabric-phase*.md`)

Everywhere else - `services/api/src`, `services/api/dist`, and the workspace packages the API
ships (`packages/shared-types`, `event-core`, `tool-core`, `sync-core`, `business-core`) - a
reference to any of the three names is a build failure. See §2.

## 1. Build is clean by construction

`services/api/package.json`: `"build": "pnpm clean && tsc -p tsconfig.build.json && node
scripts/write-build-manifest.mjs"`. `dist/` is deleted before every compile, so a compiled file can
never outlive the source file it came from. `scripts/write-build-manifest.mjs` then stamps
`dist/build-manifest.json` with the git commit SHA (`RENDER_GIT_COMMIT` on Render, `git rev-parse
HEAD` locally), build timestamp, and runtime architecture version, so a running process can prove
which source tree it was built from. `services/api/src/index.ts` reads it and logs it in the
`runtime_schema_boot` startup diagnostic (§4).

## 2. Retired-runtime build gate

`scripts/check-retired-runtime-references.mjs` (`pnpm check:retired-runtime-references`) scans
only the directories that are actually reachable from production request handling -
`services/api/src`, `services/api/dist`, and the same production package set
`check-production-imports.mjs` already treats as production packages - for the three retired table
names. It deliberately does **not** grep the whole repository: migrations, rollbacks, docs, tests,
and `services/api/scripts/` (verification and backfill tooling) are allowed to name them, and none
of those run as part of request-serving production execution. The one exception inside the scanned
roots is `services/api/src/cp2/retired-execution-fabric-tables.ts`, the single file allowed to
declare the names as a constant (used by the startup diagnostic and by tests to recognize a
retired table) - it is allowlisted by exact path, not by directory, so it stays a narrow, audited
exception rather than a loophole.

`pnpm build:production` runs it between `check:production-imports` and
`check:render-inference-boundaries`, so a production deploy containing a retired-runtime reference

- in source, or surviving in `dist` - fails the build before Render ever starts the API.

## 3. Migration ordering: compile-and-verify before migrate

Render's `grogoni` `buildCommand` now runs, in order:

```
pnpm install
→ pnpm build:production   (clean compile + all static gates, no DB access)
→ pnpm db:migrate
→ REQUIRE_NEON_DATABASE=true pnpm db:verify-schema
```

Previously `db:migrate` ran _before_ `build:production`. That ordering meant a migration -
including a destructive one, like 065's `drop table` - could commit against the shared production
database even if the application build that was supposed to go with it then failed to compile.
The previous deploy's instance, still serving traffic, would be left running code that assumed the
now-dropped tables existed. Compiling and gating first means a build that won't run cleanly never
gets the chance to migrate the schema out from under whatever is currently live.

This does not eliminate every theoretical window in a zero-downtime rolling deploy - the outgoing
instance can still be up while `db:migrate` runs against the shared database, for as long as any
destructive migration and the code that stops needing its target are shipped in the same deploy.
That is a structural property of combining "stop using X" and "drop X" in one migration. Migration
065 already shipped that way and is applied (or applying it is now correctly gated) in production;
per repository policy it is not being rewritten. Going forward, the required pattern for any
future destructive migration is:

```
Migration N:   create new structures, backfill, KEEP old structures
Deploy:        application switches exclusively to the new structures
Verify:        confirm production runtime is new-structures-only
Migration N+1: drop the old structures
```

i.e. expand, deploy, verify, contract - as separate migrations/deploys, not one. `pnpm
db:verify-schema` is the verify step's tooling: it already fails if a retired table is still
present, and now also fails if any native runtime table, its required columns, its foreign keys
into the rest of the graph, or its uniqueness guards are missing (§5) - so an incomplete or
half-migrated schema is caught before the API is allowed to start, in either direction.

`render.yaml`'s `buildFilter.paths` for `grogoni` now also includes `scripts/**` (it
previously did not) - the retired-runtime gate and the other `pnpm check:*` scripts it calls live
there, so a change to them now correctly triggers an API rebuild/redeploy.

## 4. Startup diagnostics

`services/api/src/index.ts` logs a structured, non-secret boot line after building the Fastify app:

```json
{
  "event": "runtime_schema_boot",
  "runtimeArchitecture": "native",
  "store": "postgres",
  "schemaCompatibility": "verified",
  "redisConfigured": true,
  "gitCommitSha": "...",
  "buildTimestamp": "..."
}
```

Store creation is wrapped so that if a query ever fails against one of the three retired table
names - which should be structurally impossible given §2, but this is defense in depth against a
stale or reverted build slipping through - the raw Postgres `42P01` is replaced with:

```
Native runtime schema compatibility failure: expected cp2_native_runtime_bindings,
retired cp2_model_preferences must not be used. This process is running a build that is
stale relative to the deployed schema (infra/db/migrations/065_retire_execution_fabric.sql);
redeploy from a clean build.
```

## 5. Schema verifier covers the native graph, not just the retired tables' absence

`services/api/scripts/verify-db-schema.mjs` already failed if any retired table was present. It
now also fails production startup if the schema doesn't match what the application expects on the
native side: each of the six `cp2_native_*` tables must exist with its required columns and a
primary key; the foreign keys that make binding resolution possible (installation → execution
host, installation → model, binding → agent, binding-model → binding/model/execution-host,
conversations → binding) must exist; and the three partial-unique indexes that enforce "at most
one enabled primary model per binding," "one enabled model per fallback priority," and "one active
global default binding" must exist. This was verified directly against a live, migrated (through 066) local Postgres instance, not just read for correctness.

## 6. Redis: production requires a real REDIS_URL

`services/api/src/config.ts` previously read `REDIS_URL` with a silent fallback to
`redis://127.0.0.1:6379` in every environment, including production - the exact mechanism behind
`rate_limit_redis_connection_error` / `ECONNREFUSED 127.0.0.1:6379`: no Render instance has a local
Redis, so if `REDIS_URL` was ever absent or empty when a production process read its environment
(a stale deploy that predates the `grogoni-rate-limit-cache` Key Value service being linked, or
any other environment-propagation gap), the API would silently try to talk to nothing rather than
fail loudly. `render.yaml` already wires `REDIS_URL` correctly via `fromService: { name:
grogoni-rate-limit-cache, type: keyvalue, property: connectionString }` - that wiring was not
the defect. The defect was that a missing value degraded silently instead of surfacing.

`readRedisUrl()` now throws a clear, actionable error at boot in production
(`NODE_ENV=production`) when `REDIS_URL` is unset or empty, naming the Key Value service to
configure. Non-production environments keep the loopback default, matching `docker-compose.yml`'s
local Redis and requiring no environment setup for local dev or CI.

## 7. Tests

- `tests/native-runtime-application-schema-contract.test.ts` - Test A (no retired table in
  `normalizedCollections`), Test B (all six native tables present in `normalizedCollections`),
  Test C (migration 065 drops all three retired tables, and no production-reachable source
  references them), Test D (compiled `services/api/dist` output agrees with source; skipped when
  no build artifact is present in the run, since `build:production`'s own gate already covers
  that case in CI).
- `tests/cp2-postgres-store.test.ts` - new first test in the `describePostgres` suite: confirms the
  three retired tables are absent, then calls `createPostgresCp2Store` (which internally calls
  `loadNormalizedSnapshot`) against the real, migrated local database and asserts it does not
  throw. This is the closest reproduction of the Render crash the repository has, and it is
  permanent regression coverage for it. Run with a real Postgres via
  `CP2_POSTGRES_TEST_DATABASE_URL=<connection string> pnpm exec vitest run
tests/cp2-postgres-store.test.ts` (`describePostgres` skips the suite when that variable is
  unset).
- `tests/native-runtime-migration.test.ts` (pre-existing) - asserts migration 065's archival and
  drop statements and the schema verifier's retired-table check are present in source.
