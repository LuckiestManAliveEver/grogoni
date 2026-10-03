# CP2 store lock leak

## Symptom

- `GET /health/db` shows `database.status: "degraded"` with `database.persistenceError` set
  (`database.persistenceQueue.status` turns `"degraded"` once the oldest pending save is older
  than `DB_PERSISTENCE_QUEUE_WARN_MS`).
- API logs show `cp2_persistence_failed` with `errorCode: "55P03"` (lock_not_available), each
  followed by `cp2_persistence_lock_unavailable` listing the lock holders. That query also runs
  through the pooler, so it can land on the leaked backend itself: a holder with `self: true` is the
  leak even though it reports `active`.
- The same leak can also show up as `account_sync_changes_insert_failed` (a degraded sync journal)
  followed by `cp2_persistence_lock_unavailable`: the relational transaction ran on the leaked
  backend while the journal transaction timed out on another one.
- Failures are intermittent, not total: through the pooler, a save that happens to run on the very
  backend holding the leaked lock succeeds (advisory locks are re-entrant within a session), the
  rest fail. New data (sessions, signups, messages) works in memory but may be missing after an API
  restart.

## Cause

Every save takes the advisory lock `hashtext('grogoni.cp2.normalized_store')`. Builds before the
transaction-scoped lock took it with a session-level `pg_advisory_lock` outside the transaction and
released it with `pg_advisory_unlock` in a separate statement. Through Neon's `-pooler` endpoint
(PgBouncer in transaction mode) those statements can run on different server backends, so the
unlock misses and the lock stays held by an idle pooled backend that PgBouncer keeps open.

The current code takes `pg_advisory_xact_lock` inside each transaction, after
`set local lock_timeout = 10s`. The lock is released at commit or rollback, so it cannot leak. A lock
that already leaked still blocks it: affected saves fail after 10s and retry with backoff (up to
60s between attempts, `DB_PERSISTENCE_RETRY_MAX_MS`).

## Confirm

From the repo root. The script loads `.env` and then `.env.local`, like `pnpm dev`; `pnpm start`
loads only `.env`. It prints the host and database it inspects first: check that it is the database
the affected API uses.

```bash
pnpm db:store-lock
```

It connects to the direct (non-pooler) host and lists holders and waiters of the lock in this
database only. A leaked lock is a holder with `state: "idle"`. Holders taken by the current code are
`active` or `idle in transaction` and finish within seconds.

The leaked backend keeps serving other pooled transactions, so a single run can catch it busy and
report no idle holder. Run it a few times: a holder that stays listed across runs with a large
`connection_age` while `in_state_for` keeps resetting to small values is the leak.

## Release

1. Stop any API process still running a build from before this fix, since it can leak the lock
   again. Rebuild before restarting: `pnpm --filter @grogoni/api build`.
2. Terminate the idle holder:

   ```bash
   pnpm db:store-lock -- --release
   ```

   It terminates only holders that are idle outside a transaction, re-checking that state in the
   terminating statement. A pooled save that grabbed that same backend in the instant between the
   check and the termination would be rolled back and retried; nothing is lost.

3. Confirm recovery within about a minute (the next retry): a `cp2_persistence_saved` log line
   appears and `/health/db` shows `database.status: "ok"` with an empty persistence queue.

## A holder that is not idle

A holder stuck `active` or `idle in transaction` for minutes is a real writer, not a leak. Find it
with the same script (`application_name`, `last_query`, `in_state_for`) and fix or stop that process;
the script will not terminate it.

## Out-of-band database edits

Saves send only what changed in the API's memory since the last successful save; they no longer
rewrite every row on every save. The API never re-reads Postgres while it runs, so a manual edit can
be silently overwritten (the next time that record, or for `cp2_*` tables anything in its collection,
changes in memory), a manually inserted row can be deleted (when its collection's delete pass runs),
or the edit can simply be ignored until a restart. A graceful shutdown flushes pending saves too.

To edit CP2 tables by hand: stop every API instance, make the edit, then start the API so it loads
the edited rows.
