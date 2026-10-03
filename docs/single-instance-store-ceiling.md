# Single-instance store ceiling

Status: known limitation, tracked, not fixed. Safe for closed beta. Must be resolved (or explicitly
re-accepted) before running more than one API instance or before tenant data outgrows one
process's memory.

## The problem

`createPostgresCp2Store` (`services/api/src/cp2/postgres-store.ts`) boots by calling
`loadNormalizedSnapshot`, which reads every one of the ~100 collections listed in
`normalizedCollections` plus the relational core tables into memory, then hands that snapshot to
`createCp2Store` (`services/api/src/cp2/store.ts`, ~20k lines). From then on:

- Every read and mutation runs synchronously against in-process JS `Map`/array state inside the
  `Cp2Store` class. There is no per-request database query for business logic.
- Writes are mirrored to Postgres asynchronously afterward (`enqueueSave` -> `saveNormalizedSnapshot`),
  which is durable but means the source of truth for reads is always the in-memory copy, not
  Postgres.
- This is enforced, not incidental: `assertDatabaseMigrated` requires the schema to be current, and
  a `Proxy` wraps every mutating method to trigger the async persistence queue - the design assumes
  exactly one process holds the canonical in-memory state.

Consequences:

- **Memory-bound**: total tenant data must fit in one process's heap. Fine at closed-beta scale;
  will eventually stop being fine as data grows, with no natural early warning besides an OOM crash.
- **Single-instance only**: a second API instance would boot its own independent in-memory
  snapshot and diverge from the first the moment either one accepts a write. Postgres `LISTEN`/
  `NOTIFY` (`realtimeChannel` in `postgres-store.ts`) fans out change _notifications_ between
  instances for the sync protocol, but does not make two in-memory copies of the same mutable
  state consistent. Do not add a second `grogoni` instance (or Render autoscaling) until
  this is resolved.
- **Restart loses the persistence queue's in-flight tail**: writes are queued and flushed async;
  a hard crash between a completed HTTP response and the queued Postgres write landing can lose
  that write. `DB_PERSISTENCE_QUEUE_WARN_MS` and `/health/ready`'s `persistenceQueue` block exist
  to make this queue depth observable - watch it.

## This is not the same problem as the CP2 retirement plan

[`docs/cp2-compatibility-retirement-plan.md`](./cp2-compatibility-retirement-plan.md) retires the
`cp2_*` JSONB compatibility tables in favor of proper relational tables as the _persisted_ schema.
That work is real progress and mostly landed (core business collections and phase 1 auth tables
already read from relational tables). But it changes what `loadNormalizedSnapshot` reads _from_ -
it does not change the fact that the whole dataset still gets loaded into one process's memory at
boot and mutated in-process. Finishing that plan does not, by itself, remove the single-instance
ceiling described here.

## The same root cause affects auth rate-limiting

Three separate sliding-window counters live as plain in-memory `Map`s, for the same reason as
everything else in `Cp2Store` - they were built as part of the same synchronous, single-process
model:

- `otpRequestHistory` and `failedPinAttempts` in `services/api/src/cp2/store.ts`
  (`requireOtpRequestAllowed`, `requirePinAttemptAllowed`, and related private methods).
- `authAttemptsByIp` in `services/api/src/cp2/routes.ts` (`enforceAuthIpRate`, used by
  `/auth/signup/start`, `/auth/login/password`, `/auth/recovery/start`, `/auth/password/change`).

These are real, working brute-force defenses today - they are just per-process and reset on
restart, and would not be shared across a second instance for the same reason the rest of the
store wouldn't be.

**What's already fixed (this pass):** HTTP-level request throttling is now handled by
`@fastify/rate-limit`, backed by a shared Redis instance (`grogoni-rate-limit-cache` in
`render.yaml`, wired via `REDIS_URL`) in both `services/api` and `services/ai-runtime`. This is a
coarse, additive backstop across the _entire_ request surface (previously there was none at all
outside a handful of specific auth routes) and survives restarts/would work correctly if these
services ever run more than one instance. It does not replace the three counters above, which stay
as the precise, purpose-specific brute-force limits they already were.

**What's deliberately not touched:** migrating `otpRequestHistory` / `failedPinAttempts` /
`authAttemptsByIp` to Redis was considered and set aside for this pass. Every method on `Cp2Store`
is synchronous by design; making these three counters Redis-backed means making their call chains
async, which cascades through the auth-critical methods that call them
(`loginWithAccountPin`, `verifyOtp`, `requestOtp`, signup/recovery/password-change flows). That's a
real, scoped follow-up, but it touches security-critical code in a 20k-line file and deserves its
own reviewed change, not a same-session addition alongside everything else in this pass.

## Four more issues found and fixed in later passes

A review of database persistence and production readiness (separate from the single-instance
question above) found three issues in `saveNormalizedSnapshot`/`enqueuePersistenceOperation` that
were not previously documented anywhere. All are fixed; none required the multi-week rewrite
described below.

**Every mutation re-persisted every collection, not just the one that changed.** The Proxy at the
bottom of `postgres-store.ts` calls `enqueueSave()` after _every_ mutating method, and
`saveNormalizedSnapshot` looped over all ~60 `normalizedCollections`, doing a full
`select entity_id` scan plus a per-row `insert ... on conflict do update` for each one, every time

- regardless of whether that collection had changed. A single product edit re-wrote every row in
  every collection. Fixed by passing the last successfully-persisted snapshot into
  `saveNormalizedSnapshot` and skipping `saveCollectionRecords` entirely for any collection whose
  serialized content is identical to last time (`collectionUnchanged`, `postgres-store.ts`). The
  comparison can only produce a false "changed" (falls back to the original behavior for that
  collection, which is safe by construction), never a false "unchanged," so it cannot skip work that
  was actually needed. `saveRelationalCoreRecords` (~20 hand-written table blocks, accounts/users/
  sessions/business_memberships/etc.) was deliberately **not** touched - applying the same technique
  there is a legitimate follow-up, but that function is exactly the kind of large,
  correctness-sensitive surface this document already argues against rewriting in one sitting.

**A failed save reverted in-memory state for every tenant, not just the failing write.** On any
persistence error, the old code called `store.hydrateSnapshot(lastPersistedSnapshot)` -
unconditionally rolling the entire in-memory store back to the last successful save. A transient
Postgres error (a dropped connection, a pool timeout) after a client had already received `200 OK`
for, say, an invoice confirmation, could silently undo that confirmation - and every other tenant's
mutations since the last successful save - moments later. The in-memory data was never actually
invalid after an ordinary transient failure; discarding it was strictly worse than keeping it.
Fixed: a failed save no longer reverts anything. It's recorded (`lastPersistenceError`, already
surfaced via `health()`/`/health/db`) and a retry is scheduled with exponential backoff (capped,
configurable via `DB_PERSISTENCE_RETRY_INITIAL_MS`/`DB_PERSISTENCE_RETRY_MAX_MS`). Because
`enqueueSave` always takes a fresh `store.snapshot()` at run time, the retry naturally catches up
everything accumulated since the failure, not just the operation that failed.

Finding and fixing the second issue surfaced a real, pre-existing, unrelated bug: `ShopPresenceSummary`
has no `id` field (it's keyed by `businessId`), but `recordEntityId`'s fallback case required one,
so **every shop-presence update crashed with a 500 whenever the Postgres store persisted it** - which
is what production runs. This had nothing to do with the two fixes above; it was found only because
testing the failure/retry behavior required forcing a real save to fail, which surfaced how badly a
save failure used to behave. Fixed with a one-line addition to `recordEntityId`'s special cases.

The first three fixes are covered by tests in `tests/cp2-postgres-store.test.ts`, run against a real
Postgres database (not mocked): "skips re-persisting a collection that has not changed since the
last save," "does not discard in-memory mutations when a save fails, and recovers on its own," and
"persists a shop presence update instead of failing (shopPresences has no id field)." The full
existing Postgres-backed test suite (`cp2-postgres-store.test.ts`,
`cp2-store-persistence.test.ts`, `postgres-persistence-boundary.test.ts`,
`cp21-postgres-migration.test.ts`, `cp23-postgres-migration.test.ts`, `api-persistence-ack.test.ts`

- 21 tests total) passes unmodified against the same database.

**Mutation bursts queued redundant full snapshots faster than Postgres could drain them.** A
snapshot captures fresh in-memory state when its queued operation starts, but `enqueueSave` still
added a separate operation for every mutation. Under production traffic, each 18-23 second save
allowed more mutations to arrive, creating hundreds of snapshots that mostly persisted the same
latest state. The readiness queue therefore degraded even though Postgres itself was reachable and
reported no persistence error. Fixed by coalescing all mutations that arrive before a queued
snapshot starts into that snapshot, and all mutations that arrive while it runs into at most one
trailing snapshot. `flush()` follows dynamically-appended trailing work before returning. A real
Postgres advisory-lock regression test holds one save in flight, generates a mutation burst, proves
the queue remains bounded, then releases the lock and verifies the final state is durable.

None of this changes the single-instance/memory-bound conclusion above - it makes the existing
single-instance store cheaper to run and safer under transient Postgres errors, not
horizontally scalable.

## Why this isn't being rewritten in this pass

- `store.ts` + `postgres-store.ts` together are ~24k lines, covering ~100 collections and ~150
  mutating methods, all synchronous by design.
- The actual fix - stop hydrating a full in-memory snapshot at boot, make `Cp2Store` methods query
  Postgres per request - means converting every one of those methods from sync to async and
  re-verifying transactional correctness (invoice confirmation + inventory movement, payment +
  balance updates, etc.) without the in-memory snapshot's implicit single-process atomicity to lean
  on.
- That's a multi-week rewrite touching auth, payments, and inventory simultaneously. Attempting it
  in one sitting risks shipping something that looks done but silently breaks a transactional
  guarantee - worse than leaving the documented limitation in place.
- This matches the original assessment in
  [`documentation/POSTGRES_PRODUCTION_READINESS_PLAN.md`](../documentation/POSTGRES_PRODUCTION_READINESS_PLAN.md):
  Postgres persistence was added first (done), full relational read/write was always the follow-on
  (not done).

## Recommended path, in order

1. **Now / cheap - done**: `GET /metrics` (see [`docs/observability.md`](./observability.md))
   exposes process RSS/heap, CPU, and event-loop lag for free via `@grogoni/observability`, plus
   HTTP/Neon-query/model-request latency histograms and connection-pool saturation gauges for the
   same pools this document is about. Nothing scrapes it yet and there's no alerting wired to it -
   that's the remaining part of "now / cheap" - but the numbers are real and queryable today, not
   blocked on this rewrite. Treat "add a second API instance" as blocked until step 3 lands.
   (Today's `starter` plan is single-instance already, so there's no accidental exposure yet - this
   is about not reaching for horizontal scaling as the fix when load grows.)
2. **Scoped follow-up**: make `otpRequestHistory`, `failedPinAttempts`, and `authAttemptsByIp`
   Redis-backed (the Redis instance now exists - see above). Smaller surface than the full rewrite,
   directly removes the "resets on restart" and "wouldn't work with >1 instance" gaps for the most
   security-sensitive remaining in-memory state. Needs its own PR with auth test coverage, since it
   changes sync methods to async on hot auth paths.
3. **The real fix**: extend the phased, collection-by-collection approach that
   `cp2-compatibility-retirement-plan.md` already uses successfully (dual-write, checksum parity,
   switch reads, retire) to the in-memory layer itself - one collection at a time, moving from
   "hydrated into memory at boot" to "queried from Postgres per request," starting with the
   collections least entangled with cross-collection business logic. Size and schedule this as its
   own multi-week project, not a patch.
