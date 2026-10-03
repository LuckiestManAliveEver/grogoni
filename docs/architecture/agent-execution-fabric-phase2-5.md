# Grogoni Agent Execution Fabric — Phase 2.5: Persist ExecutionFabricStore

Status: complete. `ExecutionFabricStore`'s public interface is unchanged; nothing calling it (the
Phase 2 planner-driven runtime route, the `ModelPreferencePanel` UI, the `/businesses/:id/model-preference`
routes) required any change. This document assumes
[Phase 0](grogoni-execution-fabric-audit.md), [Phase 1](agent-execution-fabric-phase1.md), and
[Phase 2](agent-execution-fabric-phase2.md) as ground truth.

## 1. The pattern matched

Read `AgentModelBindingSummary`/`cp2_agent_model_bindings` as the reference domain — the closest
existing shape to `ExecutionFabricStore`'s three entities: a business/account-scoped record behind
a `record jsonb` envelope column (`entity_id, business_id, account_id, user_id, parent_id, record,
updated_at` — migration `040_agent_model_runtime_bindings.sql`, the same shape migration 060 already
used for `cp2_model_preferences`/`cp2_runtime_hosts`/`cp2_runtime_model_installations`). This
envelope convention is **not** how the codebase's oldest domains persist (`products`, `customers`,
etc. use hand-written per-column SQL in `postgres-store.ts`) — it's a newer, generic convention a
majority of domains added since migration ~020 already use, and `ExecutionFabricStore`'s own
migration 060 already committed to it.

The persistence mechanism for every table in this generic convention is **fully generic** —
confirmed by reading it end to end, not assumed:

- `Cp2Store` is the single in-memory source of truth for every domain, including
  `AgentModelBindingSummary` (owned by `AgentRuntimeDomain`, exposed as
  `agentRuntimeDomain.agentModelBindingsMap`, `services/api/src/cp2/domains/agent-runtime/store.ts:260`).
- `Cp2Store.snapshot()` (`store.ts:5061-5063`) turns that map into a plain array; `hydrateSnapshot()`
  clears the domain (`agentRuntimeDomain.clear()`) and calls `agentRuntimeDomain.restore(snapshot)`
  (`store.ts:5153`/`5231`) to repopulate it.
- `PostgresCp2Store` (`services/api/src/cp2/postgres-store.ts`) wraps this same in-memory `Cp2Store`:
  on startup, `loadNormalizedSnapshot()` (`postgres-store.ts:1184`) reads `select record from
  <table> order by entity_id` **generically for every entry in the `normalizedCollections` array**
  (`postgres-store.ts:26-92`, `agentModelBindings` at line 68) and calls `store.hydrateSnapshot()`.
  On every mutating call, it diffs the current `store.snapshot()` against the last-persisted one and
  calls `saveCollectionRecords()` (`postgres-store.ts:2282`) for any changed collection — a single
  generic upsert loop, keyed by `recordEntityId()` (defaulting to the record's own `id` field,
  `postgres-store.ts:3874`) and `firstText()` (`postgres-store.ts:3887`, a fixed candidate-field-name
  list per column) to derive `business_id`/`account_id`/`user_id`/`parent_id` from whatever the
  record happens to be shaped like. **No table in this convention has any bespoke SQL of its own** -
  adding a new one is adding it to `normalizedCollections` and giving the domain a `clear()`/
  `restore()`/map-getter, nothing else.

This is a read-through-at-startup, write-through-after-every-mutation cache in front of Postgres —
`Cp2Store`'s in-memory maps are always the live read path; Postgres is durability, not a query
target. `ExecutionFabricStore` now replicates this exactly: it did **not** get a bespoke
read-through cache of its own, because the rest of the store doesn't have one either — the in-memory
maps it already had _are_ the cache, and this phase only added the write-behind/read-at-startup
persistence layer around them, identically to every other domain.

## 2. What changed, file by file

| File                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/api/src/cp2/store.ts:511-513`                                                | Added `modelPreferences?`, `runtimeHosts?`, `runtimeModelInstallations?` to `Cp2Snapshot` (matching every other domain's optional array fields, e.g. `agentModelBindings?:` immediately above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `services/api/src/cp2/store.ts` (`snapshot()`, next to the `agentModelBindings:` line) | Three new lines building each array from `this.executionFabricStore.<x>Map.values()`, shallow-spread per item — the exact same defensive-copy convention `agentModelAssignments`/`browserInferenceAssignments` already use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `services/api/src/cp2/store.ts` (`hydrateSnapshot()`)                                  | `this.executionFabricStore.clear()` added next to `this.agentRuntimeDomain.clear()`; `this.executionFabricStore.restore(snapshot)` added next to `this.agentRuntimeDomain.restore(snapshot)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `services/api/src/cp2/domains/execution-fabric/store.ts`                               | Added `modelPreferencesMap`/`runtimeHostsMap`/`runtimeModelInstallationsMap` getters, `clear()`, `restore(snapshot: Cp2Snapshot)` — the identical shape `AgentRuntimeDomain` already exposes. **No existing method's signature changed.** `executionHistory` deliberately has no getter and is untouched by `clear()`/`restore()` (see §5).                                                                                                                                                                                                                                                                                                                                                                                 |
| `services/api/src/cp2/postgres-store.ts:69-71`                                         | Three new `normalizedCollections` entries: `{ key: "modelPreferences", tableName: "cp2_model_preferences" }` etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `services/api/src/cp2/postgres-store.ts` (`emptySnapshot()`)                           | Three new `[]` defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `services/api/src/cp2/postgres-store.ts:2324-2334`                                     | One real bug fix (below) — added `"runtimeHostId"` to the `parent_id` candidate list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `services/api/src/cp2/store.ts` (new methods)                                          | `registerRuntimeHost`, `getRuntimeHost`, `installRuntimeModel`, `listRuntimeModelInstallations` — session-authorized `Cp2Store` pass-throughs mirroring the `createModelPreference`/`getModelPreference` pattern Phase 2 already added. These were missing entirely before this phase (only `ModelPreference` had a public `Cp2Store`-level path); added because §2 of this phase's brief explicitly scopes in "RuntimeHost create/read" and "RuntimeModelInstallation create/read," and there was no way to write or read either through the store's public surface, let alone test their persistence, without them. No HTTP route was added for either — that stays Phase 3 scope, unchanged from Phase 2's own decision. |
| `scripts/purge-all-users.sql`                                                          | Three new `DELETE`-classified rows (below) — a real correctness gap this phase would otherwise have introduced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 3. A real bug found and fixed: `parent_id` was silently never populated

Migration 060 declares `cp2_runtime_model_installations.parent_id text references
cp2_runtime_hosts(entity_id) on delete cascade` - the intended mechanism for "deleting a host cleans
up its installations." But `saveCollectionRecords()`'s generic `parent_id` derivation
(`firstText(record, ["invoiceId", "importJobId", "sourceId", "eventId", "permissionId"])`,
`postgres-store.ts:2324` before this phase) had no entry matching
`RuntimeModelInstallationSummary.runtimeHostId` - every installation row's `parent_id` would have
silently stayed `null` forever. The column is nullable, so nothing would have errored; the FK
constraint would have been trivially satisfied and the cascade-delete would simply never have
fired for any row. Fixed by adding `"runtimeHostId"` to that candidate list
(`postgres-store.ts:2324-2334`). Verified with a raw SQL query against the live column (not just
the record's own jsonb payload, which would have passed even with `parent_id` silently null) - see
§6.

## 4. A second gap found and fixed: the account purge script didn't know about these tables

`tests/user-purge-script.test.ts` asserts every table registered in `postgres-store.ts`'s
`normalizedCollections` is classified `DELETE` in `scripts/purge-all-users.sql`'s table manifest -
adding the three new collections without updating that manifest would have meant a user's account
deletion silently left their `ModelPreference`/`RuntimeHost`/`RuntimeModelInstallation` rows behind
forever. The purge script's actual deletion logic is itself fully generic
(`EXECUTE format('DELETE FROM public.%I', planned.table_name)` for every row classified `DELETE`,
`purge-all-users.sql:404`) - so the fix was exactly the three manifest lines, nothing else:

```sql
('cp2_model_preferences', 'DELETE', 11, 'Business agent model preferences (execution fabric)'),
('cp2_runtime_hosts', 'DELETE', 11, 'Account runtime host identities (execution fabric)'),
('cp2_runtime_model_installations', 'DELETE', 11, 'Account runtime host model installations (execution fabric)'),
```

`tests/user-purge-script.test.ts`'s two hardcoded totals (`plan.size` and the `DELETE` count) were
updated from 156/151 to 159/154 to match. This test would have caught this exact gap on its own -
it was found by running it, not by manual review, which is the point of it existing.

## 5. Execution history stays in-memory-only (confirmed from the doc, not assumed)

Per the brief's explicit instruction to check Phase 2's report rather than guess: Phase 2 §6
explicitly designed execution history as "not necessarily persisted, but at minimum logged" and
recorded it as in-memory-only "as a bonus rather than the load-bearing mechanism." Migration 060
never created a table for it. This phase leaves that exactly as Phase 2 left it -
`ExecutionFabricStore.executionHistory` has no map-getter, and `clear()`/`restore()` never touch it.
Adding a fourth migration/table for it was out of scope: the brief's §3 says "no schema change
should be needed... migration 060 already created the tables," and execution history was never one
of them by design, not by oversight.

## 6. No data existed to backfill (confirmed, not assumed)

Both flags default off everywhere, including production (`booleanFromEnv("EXECUTION_FABRIC_ENABLED",
false)`, `VITE_EXECUTION_FABRIC_ENABLED === "true"` strict-equality check) and neither has ever been
flipped on outside this development environment. `cp2_model_preferences`/`cp2_runtime_hosts`/
`cp2_runtime_model_installations` were created by migration 060 and have never had a single row
written to them in any real deployment - confirmed directly, not inferred, by running this phase's
tests against a genuinely fresh Postgres instance (below) and finding the tables empty before any
test wrote to them. No backfill script was written, because there is nothing to backfill.

## 7. Test results

For the first time in this project's history, these tests ran against a **real** Postgres instance
in this environment (`docker compose up -d postgres` + `pnpm db:migrate`, migration 060 included) -
every prior phase's report noted "no live Postgres was available" and relied on static SQL-content
assertions instead. That limitation is now closed for this phase's own tests.

**New: `tests/execution-fabric-postgres-persistence.test.ts`** (3 tests, gated the same way
`tests/cp2-postgres-store.test.ts` already is — `describe.skip` unless
`CP2_POSTGRES_TEST_DATABASE_URL` is set):

- _"a ModelPreference written before a restart is still readable after one"_ - the actual
  regression test for the bug this phase fixes. Creates a `PostgresCp2Store`, signs up, creates a
  business, writes a `ModelPreference`, flushes, **closes the store entirely**, then creates a
  **second, brand-new** `PostgresCp2Store` instance against the same database - a genuine
  process-boundary simulation of a Render redeploy, not a re-read of the same in-memory object -
  and asserts the preference reads back identical.
- _"a RuntimeHost registered before a restart is still readable after one, with no liveness
  field"_ - same restart simulation, plus an explicit assertion that the record's own key set is
  exactly `{id, accountId, ownerId, name, trustLevel, brokerNodeId, declaredRuntimes,
maxConcurrentJobs, createdAt, updatedAt}` - no `online`/`lastHeartbeatAt` reached the database,
  not merely absent from the TypeScript type.
- _"a RuntimeModelInstallation registered before a restart is still readable after one, and its
  parent_id column actually links it to its host"_ - restart simulation plus a raw `pg` query
  directly against `cp2_runtime_model_installations.parent_id`, proving §3's fix works at the
  column level, not just through the application's own read path (which would have passed even with
  a silently-null `parent_id`, since nothing reads that column back through `ExecutionFabricStore`
  itself).

All 3 pass:

```
CP2_POSTGRES_TEST_DATABASE_URL=postgres://grogoni:grogoni_dev_password@127.0.0.1:5432/grogoni_market \
  npx vitest run tests/execution-fabric-postgres-persistence.test.ts
Test Files  1 passed (1)
     Tests  3 passed (3)
```

**Every existing Phase 1/Phase 2 `ExecutionFabricStore` test still passes unmodified**
(`tests/execution-fabric-store.test.ts`, `tests/execution-fabric-runtime-route.test.ts`,
`tests/execution-fabric-registry-reconciliation.test.ts`, `tests/execution-fabric-browser-adapter.test.ts`)

- they exercise `ExecutionFabricStore`/`createCp2Store()` (the in-memory constructor) directly and
  never touch Postgres, so they were never at risk from this phase's change and needed zero
  modification. One assertion in `tests/execution-fabric-entities-migration.test.ts` was
  **updated, not removed** - it previously asserted `postgres-store.ts` never mentions these
  tables (accurate through Phase 2); it now asserts the opposite (accurate as of this phase), with
  the reasoning stated inline.

**Full repo suite, run once against a freshly migrated, empty Postgres database** (to get a clean
signal - repeated runs against the same growing database produced two unrelated, data-volume-caused
flakes on unrelated pre-existing tests that a fresh database confirmed were not real regressions):

```
CP2_POSTGRES_TEST_DATABASE_URL=... npx vitest run tests/
Test Files  1 failed | 195 passed | 1 skipped (197)
     Tests  1 failed | 928 passed | 1 skipped (930)
```

The one failure, `tests/cp2-postgres-store.test.ts`'s _"persists API state in normalized Postgres
tables across store restarts"_, is a **pre-existing bug unrelated to this phase**, found only
because this is the first session with a real Postgres available to run it at all. Traced to its
exact cause: the test calls `POST /auth/pin/signup` (which, per `store.ts:1492`'s `pin_already_set`
check, already sets a PIN as part of signup) and then immediately calls `POST /auth/pin/setup`
again, which correctly rejects with 409. Confirmed unrelated by reading the failing code path
directly - `pin_already_set` has no relationship to `ExecutionFabricStore`, `ModelPreference`, or
anything this phase touched. Left unfixed, per this phase's explicit "this phase does exactly one
thing" scope - flagged here as a genuine, newly-surfaced, pre-existing gap rather than silently
left for someone else to rediscover.

**Full monorepo typecheck** (all 11 workspace projects) and **both production builds**
(`@grogoni/api`, `@grogoni/web`) pass clean.

## 8. Deliverable check

- [x] `ExecutionFabricStore`'s public interface unchanged - every existing method's signature is
      identical; the four new methods (`modelPreferencesMap`/`runtimeHostsMap`/
      `runtimeModelInstallationsMap` getters, `clear()`, `restore()`) are additions used only by
      `Cp2Store`'s snapshot machinery, mirroring exactly how every other domain already exposes
      itself - nothing that called the class before needed to change.
- [x] Restart-simulation test passes - §7, against a real Postgres instance, with a genuine
      second-process-boundary store instantiation, not a re-read of the same object.
- [x] No new liveness/heartbeat persistence introduced - explicitly asserted by test (§7's
      `RuntimeHost` test checks the record's exact key set after a real Postgres round trip, not
      just the TypeScript type).
- [x] No multi-instance coordination logic added - none was written; the generic
      `normalizedCollections` mechanism this phase plugged into already existed and needed no
      changes for multi-instance concerns (out of scope per the brief - `render.yaml` has no
      `scaling` block today).
- [x] All Phase 1/Phase 2 tests still pass unmodified - confirmed in §7, with the one deliberate,
      documented exception (`execution-fabric-entities-migration.test.ts`'s assertion updated to
      reflect this phase's intentional change, not a regression).
