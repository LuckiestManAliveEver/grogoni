# Native Grogoni Daemon

The native daemon is a standalone always-on Node process, not a timer inside
Supabase Edge. Supabase remains the authenticated domain API and Neon remains
the durable database. Host this process on a VM or persistent Node/container host.

## Setup

1. Apply migration `112_native_daemon.sql` to the daemon's PostgreSQL database.
2. Create a dedicated login role and grant it access to the queue table only. The
   password is hex, so it needs no escaping in SQL or a connection URL. It travels
   only through shell builtins and stdin (never a command line visible in `ps`) and
   is written straight into the daemon's environment file instead of the terminal.
   The block is safe to re-run after a partial failure: it replaces any earlier
   `DAEMON_DATABASE_URL` line, creates the role or resets its password, and
   re-applies the grants. It runs in a subshell, so a failure stops the block
   without closing your terminal. Run it as root for `/etc/grogoni` (after
   `install -d -m 0750 /etc/grogoni`):

   ```sh
   (
     set -e
     umask 077
     DAEMON_ENV_FILE=/etc/grogoni/daemon.env   # or .env.daemon locally
     DAEMON_DB_PASSWORD=$(openssl rand -hex 32)
     touch "$DAEMON_ENV_FILE"
     chmod 600 "$DAEMON_ENV_FILE"
     sed -i '/^DAEMON_DATABASE_URL=/d' "$DAEMON_ENV_FILE"
     printf 'DAEMON_DATABASE_URL=postgres://grogoni_daemon:%s@<host>/<database>?sslmode=verify-full\n' \
       "$DAEMON_DB_PASSWORD" >> "$DAEMON_ENV_FILE"
     printf "do \$r\$ begin
       if exists (select from pg_roles where rolname = 'grogoni_daemon') then
         alter role grogoni_daemon login password '%s';
       else
         create role grogoni_daemon login password '%s';
       end if;
     end \$r\$;\n" "$DAEMON_DB_PASSWORD" "$DAEMON_DB_PASSWORD" \
       | psql -v ON_ERROR_STOP=1 "$OWNER_DATABASE_URL"
     psql -v ON_ERROR_STOP=1 "$OWNER_DATABASE_URL" -f infra/db/roles/grogoni_daemon_role.sql
   )
   ```

   Replace `<host>` and `<database>` in that file. node-postgres treats
   `sslmode=require` as `verify-full` anyway; for a self-signed server certificate add
   `&sslrootcert=/path/to/ca.pem`, and for a local database without TLS use
   `sslmode=disable`. If the server logs DDL (`log_statement` = `ddl` or `all`), the
   password statement is logged; disable that for the session or rotate afterwards. The role gets `usage` on the queue's
   schema and read/write on `grogoni_daemon_tasks` only. On PostgreSQL 14 and older,
   `PUBLIC` can also create objects in the `public` schema by default; run
   `revoke create on schema public from public` there if that matters to you. If
   retention is disabled (`DAEMON_RETENTION_DAYS=0`), revoke `delete` from the role.

3. Configure `DAEMON_DATABASE_URL` (or `DATABASE_URL`), `DAEMON_SERVICE_TOKEN`
   (at least 32 random characters, e.g. `openssl rand -hex 32`), and
   `OPENROUTER_API_KEY`. Model mappings and token limits use the same settings as
   the API. Optional settings are listed under [Configuration](#configuration).
4. Build workspace dependencies and API with `pnpm build:production:workspace`.
   Run `pnpm daemon:start`; use `pnpm daemon:dev` for source execution locally.
   Both read `.env.openrouter` and then `.env.daemon` (both git-ignored), never the
   app's `.env`, so the daemon cannot silently pick up the app's `DATABASE_URL` or
   `GROGONI_API_URL`. Put the daemon's settings in `.env.daemon`.
5. For Linux service supervision, adapt `infra/systemd/grogoni-daemon.service`.
   Install the app in `/opt/grogoni`, create an unprivileged `grogoni` user,
   and put secrets in `/etc/grogoni/daemon.env` with mode `0600`.
   Enable the unit after checking its paths. It restarts on crashes and stops
   cooperatively on SIGTERM/SIGINT. No service is installed automatically.

The gateway binds loopback port 42700 by default. Put a TLS reverse proxy and
network access controls in front of remote access. Never expose it to browsers
or share the service token with merchants: this is an operator control plane.
Do not set `DAEMON_HOST=0.0.0.0` without those protections.

## Configuration

| Variable                                   | Default               | Meaning                                                                     |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------- |
| `DAEMON_DATABASE_URL`                      | `DATABASE_URL`        | Queue database, ideally as the `grogoni_daemon` role.                       |
| `DAEMON_SERVICE_TOKEN`                     | required              | Bearer token for every endpoint except `/health/live`.                      |
| `DAEMON_HOST` / `DAEMON_PORT`              | `127.0.0.1` / `42700` | Gateway bind address.                                                       |
| `DAEMON_RETENTION_DAYS`                    | `30`                  | Days to keep completed, failed and cancelled tasks. `0` keeps them forever. |
| `DAEMON_SHUTDOWN_GRACE_MS`                 | `20000`               | How long in-flight work may finish after SIGTERM. Max `25000`.              |
| `PLATFORM_DEFAULT_MODEL_ID`                | `gpt-6-luna`          | Model for agent tasks that omit `modelId`.                                  |
| `PLATFORM_DEFAULT_AGENT_ADAPTER_ID`        | `grogoni`             | Engine for agent tasks that omit it (`grogoni` or `pi`).                    |
| `GROGONI_API_URL` / `BACKGROUND_JOB_TOKEN` | unset                 | Required only for maintenance tasks.                                        |

Startup validates configuration and exits non-zero rather than falling back:
invalid numbers, a token shorter than 32 characters or containing whitespace,
`PLATFORM_DEFAULT_MODEL_ID` not mapped in `OPENROUTER_MODELS` (when
`OPENROUTER_API_KEY` is set), a malformed or non-HTTPS `GROGONI_API_URL`,
`GROGONI_API_URL` without `BACKGROUND_JOB_TOKEN`, `DAEMON_ALLOW_LOCAL_API` other
than `true`/`false`, or nothing to run at all (neither `OPENROUTER_API_KEY` nor
`GROGONI_API_URL`). A blank value means the default (so `DAEMON_HOST=` still binds
loopback, and a blank `DAEMON_DATABASE_URL` falls back to `DATABASE_URL`). A database that is unreachable at boot gets 6 connection attempts (5
retries) with jittered exponential backoff; the backoff adds at most about 15
seconds, and each attempt can also wait out the connection timeout, so against an
unresponsive host boot can take around 35 seconds before the process exits.
systemd then restarts it every 10 seconds with no start limit
(`StartLimitIntervalSec=0`), so the daemon comes back on its own however long the
outage lasts. SIGTERM during the boot retry stops it without starting anything,
after any connection attempt already in flight finishes (seconds at most). A
missing migration fails immediately.

## Tasks

All endpoints except `GET /health/live` require `Authorization: Bearer <token>`,
including readiness. `GET /health/ready` checks database/schema connectivity and
shutdown state; give your load balancer or monitor the token.

`POST /v1/tasks` accepts:

```json
{
  "key": "daily-summary-2026-10",
  "payload": {
    "kind": "agent",
    "message": "Return a brief greeting, without tools.",
    "modelId": "gpt-6-luna",
    "agentAdapterId": "grogoni"
  },
  "intervalMs": 86400000,
  "maxAttempts": 3
}
```

Omit `intervalMs` for one-shot work; minimum recurrence is one minute. A recurring
task that exhausts `maxAttempts` (retries back off 2, 4, 8, 16 seconds) stops and
stays visible as failed, and so does one whose final attempt crashes
(`LEASE_EXHAUSTED`). Give recurring tasks `"maxAttempts": 5` so a short outage or
a single crash does not end the schedule, and alert on `counts.failed`. Optional
`runAt` schedules the first invocation. The idempotency key returns the original
task on repeated submission; it does not update its contents. Once retention
deletes a finished task, its key can be submitted again as new work. Models must
be operator-mapped (`OPENROUTER_MODELS`); engines are Grogoni or Pi. Work this
daemon cannot run is refused at submission with `422` and one of
`MODEL_NOT_CONFIGURED`, `AGENT_RUNTIME_NOT_CONFIGURED`, `JOB_API_NOT_CONFIGURED`,
or `MESSAGE_TOO_LARGE`, instead of being accepted and dead-lettered later.
`MESSAGE_TOO_LARGE` applies the Grogoni engine's own limit: the serialized prompt
must fit in 131,072 bytes, which is about 130,000 ASCII characters but only about
43,000 CJK characters (the schema's 60,000-character cap is the outer bound). Invalid input, including blank
keys or messages and text containing U+0000, gets `400 INVALID_TASK`; values are
not type-coerced (`"60000"` is not an interval).

| Endpoint                   | Purpose                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/tasks/:id`        | Status and latest result.                                                                                                                                                                            |
| `GET /v1/tasks`            | The 50 most recently updated tasks.                                                                                                                                                                  |
| `DELETE /v1/tasks/:id`     | Cancel queued or running work. Running work stops on its next lease heartbeat.                                                                                                                       |
| `POST /v1/tasks/:id/retry` | Requeue a failed or cancelled task (`{"queued": true}`). A task cancelled mid-run returns `{"queued": false}` until its old lease expires (at most 30 seconds), so two workers never run it at once. |
| `GET /v1/stats`            | Queue health, below.                                                                                                                                                                                 |

Task responses use this shape. Internal lease tokens are never returned.

```json
{
  "id": "4a6ae60f-ebf3-40e2-97fa-52d3bcf49a20",
  "key": "daily-summary-2026-10",
  "payload": {
    "kind": "agent",
    "message": "...",
    "modelId": "gpt-6-luna",
    "agentAdapterId": "grogoni"
  },
  "status": "queued",
  "runAt": "2026-10-12T00:00:00.000Z",
  "intervalMs": 86400000,
  "attempts": 0,
  "maxAttempts": 3,
  "executions": 0,
  "leaseUntil": null,
  "result": null,
  "errorCode": null,
  "createdAt": "2026-10-11T07:39:47.078Z",
  "updatedAt": "2026-10-11T07:39:47.078Z"
}
```

For existing channel delivery, mailbox synchronization, retention, or fulfillment
work, set `GROGONI_API_URL` and `BACKGROUND_JOB_TOKEN`, then enqueue a maintenance
payload such as `{"kind":"maintenance","job":"connected_mailbox_sync"}`.
Only the existing API job allowlist is accepted. `GROGONI_API_URL` must be HTTPS
unless `DAEMON_ALLOW_LOCAL_API=true`, which permits plain HTTP to any host; use it
only for local development or a private network you control. The API retains its own locks, authorization,
and domain side-effect handlers. Avoid duplicating schedules already owned by
Supabase Cron or the Node API; API locks prevent overlap, not later duplicate runs.

## Monitoring

`GET /v1/stats` returns:

```json
{
  "counts": { "queued": 2, "running": 1, "completed": 40, "failed": 1, "cancelled": 0 },
  "oldestDueSeconds": 4,
  "expiredLeases": 0
}
```

Alert when `oldestDueSeconds` keeps growing (workers are not keeping up or are
down), when `expiredLeases` stays above zero (a worker crashed or stalled), or
when `counts.failed` rises (dead letters to inspect and retry).

Lifecycle logs are one JSON object per line on stdout (`journalctl -u grogoni-daemon`).
They contain task IDs, attempts, durations and error codes, never prompts,
results or credentials:

| `type`                                  | When                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon_started` / `daemon_stopping`    | Process start (with `port`, `retentionDays`) and SIGTERM/SIGINT.                                                                                                                                                                                                                            |
| `task_started`                          | A worker claimed a task (`attempt`).                                                                                                                                                                                                                                                        |
| `task_finished` / `task_failed`         | Outcome settled (`durationMs`, `errorCode` on failure).                                                                                                                                                                                                                                     |
| `task_interrupted`                      | Shutdown grace expired; the task was released for another worker.                                                                                                                                                                                                                           |
| `lease_lost`                            | The task was cancelled or its lease could not be renewed; its outcome is discarded.                                                                                                                                                                                                         |
| `task_settle_fenced`                    | The claim was already settled, cancelled or re-claimed (for example a settlement retry after the first attempt's reply was lost); nothing new was written.                                                                                                                                  |
| `task_settlement_failed`                | Settlement failed three times (retried 0.5 s and 1 s apart while the lease held). The outcome may or may not have been written; if not, the lease expires and the task runs again if it has attempts left, otherwise it becomes a `LEASE_EXHAUSTED` dead letter. Check `GET /v1/tasks/:id`. |
| `lease_exhausted`                       | An expired claim had no attempts left and was dead-lettered (`taskId`, `errorCode: LEASE_EXHAUSTED`).                                                                                                                                                                                       |
| `queue_unavailable`                     | Claiming failed (database down); the worker retries every second.                                                                                                                                                                                                                           |
| `gateway_error`                         | An endpoint failed on the database (`errorCode`); the caller saw `503`.                                                                                                                                                                                                                     |
| `database_startup_retry`                | The database was unreachable at boot; another attempt follows.                                                                                                                                                                                                                              |
| `database_startup_recovered`            | Boot succeeded after one or more retries (`failedAttempts`).                                                                                                                                                                                                                                |
| `database_pool_error`                   | An idle database connection failed; the pool replaces it.                                                                                                                                                                                                                                   |
| `retention_purged` / `retention_failed` | Hourly cleanup deleted `deleted` rows, or could not reach the database.                                                                                                                                                                                                                     |

## Guarantees And Limits

Tasks survive process restarts. PostgreSQL `SKIP LOCKED` claims allow multiple
workers; a 30-second renewable lease and unique claim token fence stale results.
Leases are renewed every quarter lease. A failed or hung renewal is tolerated
while the last success still covers the lease: ownership is measured from when a
successful renewal was sent, and once half the lease passes without one the worker
abandons the task, at the latest three quarters into the lease, before the
database lets another worker claim it. An expired claim with attempts left is
recovered automatically by the next claim. One that expires on its final attempt
(the worker crashed or was killed, its settlement or shutdown release never
landed, or its renewals failed long enough for it to abandon the claim) is
dead-lettered as
`LEASE_EXHAUSTED` and logged as `lease_exhausted`, rather than recovered forever,
so a task that kills its worker cannot repeat paid work without bound; retry it
explicitly once the cause is fixed. Retryable
failures (anything the model runtime classifies as transient: timeouts, rate limits,
provider outages, empty provider replies; and `JOB_API_UNAVAILABLE`) back off
exponentially up to the task's attempt limit; terminal failures
remain as visible dead letters. Recurring work schedules its next run after
completion, without catch-up bursts. An exhausted recurring task stops rather
than generating unlimited retries.

On SIGTERM the daemon stops claiming (a task claimed at that moment is handed
straight back, not started), reports not ready, and gives in-flight work
`DAEMON_SHUTDOWN_GRACE_MS` to finish. Work that finishes is settled normally, so a
nearly complete model call is not repeated. Work still running after the grace
period is aborted and released to another worker without spending an attempt.
Further SIGTERM/SIGINT signals are ignored so they cannot cut the grace period
short; systemd's SIGKILL after `TimeoutStopSec` (40 seconds) remains the hard stop.
The 20-second default leaves room for release and shutdown within that window.

Retention runs at startup and then hourly, deleting terminal tasks last updated
more than `DAEMON_RETENTION_DAYS` ago, oldest first, in batches of 1000. Queued,
running and active recurring tasks are never deleted, including a task an operator
requeues while a purge is running: the purge locks its batch, skips rows another
transaction holds, and re-checks state before deleting. Several daemons can run
retention at once safely.

Error codes from maintenance jobs are `JOB_API_UNAVAILABLE` (retried) and
`JOB_API_REJECTED` (not retried), distinct from model-provider codes. A result
the database cannot store (for example U+0000 inside a JSON key) is recorded as
`RESULT_NOT_STORABLE` instead of being re-run; U+0000 inside text values is stored
as U+FFFD.

Execution is **at least once**, not exactly once. A crash after an external action
or paid model request but before settlement can repeat it. Use domain-level
idempotency for mutations and provider spending limits for cost control.
Prompt/result data stays in the operator queue until retention removes it.
This queue keeps the latest result, not a full run archive.

Agent jobs are isolated model turns with no business credentials or tool grants.
They return proposals, never execute model-generated commands. Business tool
authorization, durable conversations, MCP, channels, and approvals remain in the
existing API. No arbitrary shell, plugin download, or filesystem access is added.

Run replicas with identical configuration. Submission and retry refuse work the
receiving daemon cannot run, but a replica configured differently could still claim
it and dead-letter it. Cancelling a maintenance task stops the daemon's request; a
job the API has already started finishes there under the API's own locks. A
maintenance response larger than 256 KB is recorded as `JOB_API_REJECTED` even
though the job ran; job endpoints return small summaries.

Stop all workers before rollback; `112_native_daemon.down.sql` removes the queue
and its results.

## Verification

`pnpm exec vitest run tests/native-daemon.test.ts` checks gateway, worker and
retention behavior without a database.
For real lease, role, retention and restart tests, start the disposable database with
`docker compose -f docker-compose.daemon-test.yml up -d --wait`, then run:

```sh
CP2_POSTGRES_TEST_DATABASE_URL=postgres://daemon_test:daemon_test_only@127.0.0.1:55439/daemon_test pnpm exec vitest run services/api/src/daemon/task-store.test.ts
```

Tests create and remove an isolated schema and a temporary role, and start/stop
native child processes (including a SIGTERM during an in-flight job). They do not
call a paid model. Stop the disposable database afterward with
`docker compose -f docker-compose.daemon-test.yml down`.

`pnpm eval:daemon-live` is the paid end-to-end check: it starts the daemon against
the disposable database, runs real agent tasks through OpenRouter, and fails
below its pass threshold. Run it before shipping daemon changes.
