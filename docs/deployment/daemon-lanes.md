# Daemon Lanes: background tasks with no daemon host

Grogoni's background task queue (`grogoni_daemon_tasks` in Neon) is worked by two lanes that
need no server of their own:

- **Browser lane.** While a signed-in user has the app open, one of their tabs claims that
  user's due tasks and runs them, on an installed on-device model or by asking the API to run
  the claimed task.
- **Server lane.** The `daemon_worker` job inside the existing Supabase Edge API. Supabase Cron
  triggers it only when a server worker has something to do: operator tasks as soon as they
  are due, and a user's task once it has waited 10 minutes for that user's browser.

The standalone Node daemon ([native-daemon.md](native-daemon.md)) still works against the same
queue and follows the same rules. It is optional.

```
 user's open tab ──claim/settle/execute──▶  /v1/daemon/*  ─┐
                                                           ├─▶ Neon: grogoni_daemon_tasks
 Supabase Cron ──every minute──▶ grogoni_daemon_wake()     │
     (Supabase Postgres: reads one row, the wake hint)     │
         └── only if due ──▶ /internal/jobs/daemon_worker/run (Edge) ─┘
 operators ──Bearer DAEMON_SERVICE_TOKEN──▶ /internal/daemon/v1/*  (the native gateway)
```

## What each party may do

| Who              | Holds                                                    | Can                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A user's browser | Their session cookie, then one **lease token** per claim | Create, list, read and cancel **their own** tasks. Claim one due task of theirs, then renew, settle, release or ask the server to execute **that task** until the lease ends. |
| Supabase Cron    | The job token in Supabase Vault                          | Trigger `daemon_worker`                                                                                                                                                       |
| Operators        | `DAEMON_SERVICE_TOKEN`                                   | Everything the native gateway offers: submit agent or maintenance tasks, list, stats, cancel, retry                                                                           |

No API key or job token ever reaches a browser. A lease token is useless to any other user, any
other task, and after its lease ends: the database fences every write on it. Asking the server
to execute a claim swaps its token first, so a claim is run on the server at most once however
often `/execute` is sent, and a late device `/settle` on it is refused.

## The user API

All routes need the user's session cookie; every task route acts only on that user's tasks
(another user's task answers 404).

| Route                                | Body                                                    | Answer                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/daemon/tasks`              | `{ key, message, runAt?, intervalMs? }`                 | `201 { task }` created, `200 { task }` for a key already used, `429 daemon_task_limit`, `400` invalid input                                                   |
| `GET /v1/daemon/tasks`               |                                                         | `{ tasks }`, newest 50                                                                                                                                        |
| `GET /v1/daemon/tasks/:id`           |                                                         | `{ task }`                                                                                                                                                    |
| `DELETE /v1/daemon/tasks/:id`        |                                                         | `{ task }` cancelled; a server run in progress stops within seconds (5s for `/execute`, about 8s on the cron lane). `409 task_not_active` if already finished |
| `POST /v1/daemon/claims`             | `{}`                                                    | `{ claim: { task, message, leaseToken, leaseUntil, leaseMs, executeTimeoutMs } }`, or `{ claim: null, nextDueInMs }` when idle                                |
| `POST /v1/daemon/claims/:id/renew`   | `{ leaseToken }`                                        | `{ renewed: true }`                                                                                                                                           |
| `POST /v1/daemon/claims/:id/settle`  | `{ leaseToken, outcome: { text, modelId } }` or failure | `{ task }`. A failure outcome is `{ errorCode: "UPPER_SNAKE", retryable }`.                                                                                   |
| `POST /v1/daemon/claims/:id/release` | `{ leaseToken }`                                        | `{ task }` back in the queue, the attempt not counted                                                                                                         |
| `POST /v1/daemon/claims/:id/execute` | `{ leaseToken }`                                        | `{ task }` after the server ran it                                                                                                                            |

Limits: `key` 1-120 of `A-Z a-z 0-9 . _ : -`; `message` 1-8000 characters, no NUL or unpaired
surrogates; `runAt` within a year (a past time means now); `intervalMs` from
`DAEMON_USER_MIN_INTERVAL_MS` to 30 days; a device result at most 32000 characters. A lost or
wrong lease answers `409 lease_lost`; a malformed lease token `400 lease_token_invalid`. Other
answers: `401 auth_required`, `409 task_key_conflict` (a key held by a task that is not yours,
which cannot happen through this API), `413 request_too_large` (bodies over 100 KB), `415
content_type_invalid` (not `application/json`).

## How a task moves

1. **Created.** The key is the user's idempotency key, stored as `user:<userId>:<key>`, so two
   users never collide and a replayed key returns the user's own task. Creation and the per-user
   cap are checked under one per-user lock, so concurrent requests cannot exceed the cap. A
   cancelled task whose run may still be in flight (its lease has not ended) keeps counting, so
   cancelling and re-creating cannot run more than the cap at once.
2. **Browser lane, while the app is open.** One tab (a Web Lock, `grogoni-daemon-lane`) claims
   due tasks while the tab is visible and online, and at once when it becomes visible, comes back
   online, or the app dispatches the `grogoni:daemon-lane-wake` window event.
   - When nothing is due, the claim answer says how long until this user's next task
     (`nextDueInMs`, measured on the database clock), and the tab sleeps that long: at least
     30 seconds, at most 5 minutes (the most a task created on another device waits).
   - If an on-device model is **already loaded and idle**, it generates the reply there, renews
     the lease every third of `leaseMs` while generating (at once if the claim was slow to
     arrive; counted from when the claim was sent), and settles. If renewals keep failing for
     two thirds of the lease it abandons the claim rather than settle late. The lane never loads
     a model itself, never runs on a model another load is replacing, and never starts while that
     model is generating. A chat turn started during a background generation waits for it, as
     two chat turns on one model do.
   - Otherwise, or if the device fails, returns an empty reply, or the server rejects its
     result, it asks the server to run the same claim (`/execute`, with `executeTimeoutMs` as
     its request timeout).
   - Logging out first stops the lane and releases its claim while the session is still valid
     (waiting at most 3 seconds, so logout never hangs on a server run in flight). Closing the
     app, or signing in as another user without logging out, cannot release it: the lease lapses
     and one attempt is spent.
3. **Server takeover.** If nobody runs it, the server lane may take a user's task once it has
   waited 10 minutes past its due time (or past an abandoned lease). Operator tasks are due for
   the server immediately.
4. **Settled.** Success completes the task, or re-queues it at `now + intervalMs` for recurring
   work. A retryable failure backs off and retries (3 attempts). User results have one shape:
   `{ text, modelId, executedBy: "device" | "server" }`, and `lane` records who claimed it. A
   result PostgreSQL cannot store becomes `failed` with `RESULT_NOT_STORABLE`, never a retry loop.

## What costs what when idle

Supabase Cron runs `grogoni-daemon-wake` every minute **inside Supabase's own Postgres**. It
reads one row, `grogoni_internal.daemon_wake.next_due_at`, and stops unless server work is due.
Only then does it call the Edge job (at most once a minute). So with no server work due, the
**cron side** touches neither Neon nor the Edge function.

Open tabs are the other cost: each signed-in, visible tab makes one cheap claim request (an Edge
call and a few small Neon queries: session, claim, next due) per idle interval, between 30 seconds and 5 minutes as above.
With no app open anywhere and nothing due, nothing runs and Neon can suspend.

The hint is kept conservative. It can wake a run for nothing, but it can never sleep through work:

- Whenever a task is queued or re-queued, the API **lowers** the hint to when the server would
  next need it (immediately for operator work, due time + 10 minutes for a user's), retrying once.
  Lowering bumps a version number.
- Each worker run reads the version first, works, computes the true next due time from Neon, and
  writes it **only if the version is unchanged**. If new work landed meanwhile, the lower value
  stays and the next tick runs again.
- The `daemon_worker` job also runs **unconditionally every hour** (`grogoni-job-daemon_worker`,
  minute 17), which recomputes the hint whatever happened. A failed hint write (Supabase
  unreachable) therefore delays server work by at most an hour.

Each run lasts at most 120 seconds by default (140 at most, inside pg_net's and Supabase's
150-second limits; the run's clock starts after cold start and the job lock, so leave slack). It
starts a task only if the task's timeout still fits after the claim returns. A backlog drains over
consecutive ticks.

## Production setup

Run from the repository root with the production environment files present: `.env`
(`DATABASE_URL`, `DIRECT_DATABASE_URL`), `.env.local` (`SUPABASE_ACCESS_TOKEN`) and
`.env.openrouter` (`OPENROUTER_API_KEY`, `PLATFORM_DEFAULT_MODEL_ID`).

1. **Migrations.** `115_runtime_approvals.sql` and `116_daemon_lanes.sql` are additive (a new
   table; two nullable columns and an index). Safe to re-run:

   ```sh
   NODE_ENV=production pnpm db:migrate
   REQUIRE_NEON_DATABASE=true node --env-file=.env services/api/scripts/verify-db-schema.mjs
   ```

2. **Edge secrets.** The server lane needs a model and the operator API needs a token. Setting
   `OPENROUTER_API_KEY` also enables model calls for the Edge API's chat turns, which use the
   same key. Safe to re-run:

   ```sh
   node --env-file=.env.local --env-file=.env.openrouter scripts/set-daemon-lane-secrets.mjs
   ```

   It reuses `DAEMON_SERVICE_TOKEN` from `.env.local` if one is there, otherwise generates one
   and appends it to `.env.local` (git-ignored). `SUPABASE_DB_URL` is injected by Supabase into
   every function; nothing to set.

3. **Deploy the candidate and check it.** Every deploy also rewrites the project-wide secrets
   `DATABASE_URL`, `NODE_ENV`, `WEB_*` and `WEBAUTHN_*` from your environment (the candidate shares
   them with production). The candidate is not called by the cron, so check its routes only:

   ```sh
   pnpm deploy:api:supabase --slug=api-candidate
   EVAL_REQUEST_ONLY=true EVAL_API_URL=https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api-candidate \
     pnpm eval:daemon-lanes:production
   ```

   Evidence goes to `/tmp/daemon-lanes/live-eval/production-request-only/report.json`.

4. **Deploy production.**

   ```sh
   pnpm deploy:api:supabase
   ```

5. **Schedule.** Creates the wake hint, the wake function and its cron entry, and the hourly
   `daemon_worker` entry. It also **rotates the job token**: job calls answer 401 for a few
   minutes until warm isolates recycle. So re-run it only to change the schedule, not routinely.

   ```sh
   pnpm jobs:schedule:supabase --apply
   ```

6. **Verify** end to end. About 15 minutes (the takeover case waits out the real 10-minute
   delay), a few small model calls, cleans up after itself, evidence in
   `/tmp/daemon-lanes/live-eval/production/report.json`:

   ```sh
   pnpm eval:daemon-lanes:production
   ```

## Configuration

Set as Supabase function secrets (project-wide). Defaults are production values. A value out of
range does not take the API down: the daemon lanes switch off, `/v1/daemon/*` and
`/internal/daemon/*` answer `503 daemon_unavailable`, and the Edge log has `daemon_config_invalid`
with the reason. Every other route keeps working.

| Variable                                          | Default  | Meaning                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`, `PLATFORM_DEFAULT_MODEL_ID` | none     | Required for agent tasks. Without them, `POST /v1/daemon/tasks` answers 503 `daemon_server_lane_unavailable` (the server must always be able to finish a user's task).                                                                                                                                             |
| `DAEMON_SERVICE_TOKEN`                            | none     | Enables `/internal/daemon/*` (at least 32 characters). Without it those routes answer 404.                                                                                                                                                                                                                         |
| `DAEMON_USER_TAKEOVER_MS`                         | `600000` | How long a user's due task waits for their browser (60000 to 86400000). The Node daemon reads it too.                                                                                                                                                                                                              |
| `DAEMON_EDGE_RUN_BUDGET_MS`                       | `120000` | Longest server-lane run (10000 to 140000).                                                                                                                                                                                                                                                                         |
| `DAEMON_EDGE_TASK_TIMEOUT_MS`                     | `60000`  | One task's model call, server lane and `/execute` (5000 to the smaller of budget minus 5000 and 120000).                                                                                                                                                                                                           |
| `DAEMON_BROWSER_LEASE_MS`                         | `60000`  | A browser claim's lease (15000 to 300000).                                                                                                                                                                                                                                                                         |
| `DAEMON_USER_MAX_ACTIVE`                          | `20`     | Queued plus running tasks per user, plus cancelled ones still running (1 to 1000).                                                                                                                                                                                                                                 |
| `DAEMON_USER_MIN_INTERVAL_MS`                     | `900000` | Shortest recurring interval a user may set (60000 to 30 days).                                                                                                                                                                                                                                                     |
| `ENABLE_DAEMON_WORKER`                            | on       | `false`: the server lane runs nothing and clears the wake hint, so the wake stops calling it (new work costs one more call, which clears it again). After turning it back on, run `update grogoni_internal.daemon_wake set next_due_at = now();` in Supabase, or work queued meanwhile waits for the hourly sweep. |
| `VITE_DAEMON_BROWSER_LANE`                        | on       | Web build flag; `false` ships a build whose tabs never claim.                                                                                                                                                                                                                                                      |

## Operating it

Operator calls go to the Edge API with the service token from `.env.local`:

```sh
set -a; . ./.env.local; set +a
API=https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api
AUTH="authorization: Bearer $DAEMON_SERVICE_TOKEN"
curl -s -H "$AUTH" $API/internal/daemon/v1/stats
curl -s -H "$AUTH" -H 'content-type: application/json' $API/internal/daemon/v1/tasks \
  -d '{"key":"digest-2026-10-12","payload":{"kind":"agent","message":"Summarize today."}}'
curl -s -H "$AUTH" -H 'content-type: application/json' $API/internal/daemon/v1/tasks \
  -d '{"key":"purge-hourly","payload":{"kind":"maintenance","job":"edge_rate_limit_retention"},"intervalMs":3600000}'
curl -s -H "$AUTH" $API/internal/daemon/v1/tasks            # latest 50, all lanes
curl -s -H "$AUTH" $API/internal/daemon/v1/tasks/<id>
curl -s -X DELETE -H "$AUTH" $API/internal/daemon/v1/tasks/<id>       # cancel
curl -s -X POST -H "$AUTH" $API/internal/daemon/v1/tasks/<id>/retry   # failed or cancelled
```

Maintenance tasks run the named Edge job in-process, under that job's own lock. If that job is
already running or switched off, the task does not count as done: it retries
(`JOB_ALREADY_RUNNING`) or fails (`JOB_DISABLED`). `daemon_worker` itself cannot be queued
(`422 JOB_NOT_QUEUEABLE`). A job is not interrupted by its task's timeout: it runs to completion
under its own lock, while its task is retried and finds that lock held. Keep long jobs on their
own cron schedule rather than queueing them.

Where to look:

- **Last server-lane run** (Neon): `select record from cp2_background_jobs where entity_id = 'daemon_worker';`
  The record holds claimed, finished, failed, fenced, leaseExhausted, the next due time, and
  whether the hint was `updated`, `superseded` (new work landed during the run) or `unavailable`.
- **The hint** (Supabase SQL editor): `select * from grogoni_internal.daemon_wake;`
- **Wake checks** (Supabase): `select status, start_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'grogoni-daemon-wake' order by start_time desc limit 10;`
- **Edge logs:** lines with `"event":"daemon"` (`user_task_created`, `browser_claimed`,
  `browser_server_execute`, `task_finished`, `lease_exhausted`, `wake_hint_slow` (a hint write
  outlasted the 3s a request waits; it may still land), `wake_hint_unavailable` (it failed),
  `daemon_capabilities_invalid`) and `daemon_config_invalid`.

## When things go wrong

| Situation                               | What happens                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab closes mid-task                     | The lease lapses. The user's next open tab may claim it again at once; otherwise the server takes it 10 minutes after the lease ended. One attempt is spent.                  |
| User logs out mid-task                  | The claim is released before the logout: back in the queue, the attempt not counted. If the release cannot finish within 3 seconds, the lease lapses instead.                 |
| Tab hidden mid-task                     | It finishes the task it holds, then stops claiming. Browsers throttle hidden tabs' timers; if renewals fall behind, the tab abandons the claim and the lease lapses.          |
| Device runs out of memory               | The tab asks the server to run the same claim instead.                                                                                                                        |
| Session expires mid-task                | The tab's calls answer 401; the lease lapses and the task is claimable again.                                                                                                 |
| Model provider down                     | Retryable: backoff (2s, 4s, ... capped at 60s) up to 3 attempts, then `failed` with the provider's code.                                                                      |
| A worker dies holding a lease           | Another worker recovers it once the lease ends; a claim that dies on its last attempt becomes `failed` with `LEASE_EXHAUSTED`, never retried forever.                         |
| Supabase Postgres unreachable from Edge | Requests wait at most 3s on a hint write (retried once), then answer anyway (`wake_hint_slow`, `wake_hint_unavailable` if it failed); the hourly sweep still runs everything. |
| Neon unreachable                        | The run fails and is recorded in the job status; the hint stays due, so the next tick tries again.                                                                            |
| Server lane misconfigured (no key)      | New user tasks are refused with 503; operator agent tasks with 422 `AGENT_RUNTIME_NOT_CONFIGURED`. Nothing is queued that cannot run.                                         |
| A `DAEMON_*` value out of range         | Only the daemon lanes switch off (503 `daemon_unavailable`); the rest of the API is unaffected. The wake keeps calling the job each minute until the value is fixed.          |

## Local run, tests and evals

Needs Docker and `.env.openrouter` with `OPENROUTER_API_KEY` and `PLATFORM_DEFAULT_MODEL_ID`:
the server lane refuses tasks without a model, and the eval makes a few small, paid model calls.
The first `pnpm edge:local` downloads Deno (through `npx`, about 100 MB).

```sh
docker compose up -d postgres              # the dev Postgres only
pnpm edge:local                            # the real Edge API under Deno on :8000
pnpm eval:daemon-lanes:local               # in another terminal: 12 checks, ~15-30 seconds
```

`pnpm edge:local` recreates two scratch databases on the dev Postgres (`grogoni_lanes_smoke`
plays Neon, `grogoni_lanes_hint` plays Supabase's Postgres, with a stub where pg_net would be),
applies every migration, rebuilds the bundle and starts Deno with throwaway secrets
(`scripts/edge-local-config.mjs`). It never reads `.env` or `.env.local`. The local eval
fast-forwards the 10-minute takeover by back-dating the abandoned lease, and simulates each cron
tick as Supabase runs it.

Gate tests. The browser-side files need no database (`npx vitest run <file>`). The rest need a
disposable, migrated database; run them one file at a time, or all PostgreSQL tests serially the
way CI does:

```sh
CP2_POSTGRES_TEST_DATABASE_URL=postgres://... pnpm test:postgres
```

- `services/api/src/daemon/edge-lane.test.ts`: every route, cross-user isolation, lease fencing,
  `/execute` run-once, the concurrent cap, input limits, takeover, run budget, the hint protocol,
  the wake SQL and the operator gateway.
- `tests/daemon-lanes-e2e.test.ts`: the browser lane's real code against the real routes.
- `tests/daemon-browser-lane.test.ts`: the browser lane (renewal by lease length, abandon,
  release on stop, device fallback, idle backoff, batches, Web Lock skip). No database.
- `tests/daemon-lane-hook.test.tsx`: the React hook (start, stop, account switch, sign-out wait,
  idle-model rule, wake event, activity, Web Lock).
- `tests/device-engine-state.test.ts`: which on-device model background work may use.
- `tests/device-engine-background.test.ts`: the real engine over a fake WebLLM (never loads,
  never runs on a model being replaced, never starts while a chat generates).
- `tests/daemon-lane-logout-order.test.ts`: logout stops the lane before ending the session.
- `tests/daemon-config-isolation.test.ts`: a bad setting disables only the daemon routes.
- `services/api/src/daemon/task-store.test.ts`: the queue itself, shared with the Node daemon.

## Rollback

In this order: the API must stop using the columns before the migration removes them.

1. **Stop the lanes.** Set `ENABLE_DAEMON_WORKER=false` as a function secret (the server lane
   stops and the wake goes quiet), and ship a web build with `VITE_DAEMON_BROWSER_LANE=false`.
2. **Unschedule and remove the wake** (Supabase SQL editor):

   ```sql
   select cron.unschedule('grogoni-daemon-wake');
   select cron.unschedule('grogoni-job-daemon_worker');
   drop function if exists public.grogoni_daemon_wake();
   drop schema if exists grogoni_internal cascade;
   ```

3. **Deploy the previous API** (check out the last commit before the daemon lanes, then
   `pnpm deploy:api:supabase`). Cached web builds may keep calling `/v1/daemon/*`; the previous API
   answers those with 404, which the lane treats as a failure and backs off from.
4. **Cancel the remaining user tasks** (Neon), or they would become operator tasks without
   their owner:

   ```sql
   update grogoni_daemon_tasks set status = 'cancelled', lease_token = null, updated_at = now()
   where owner_user_id is not null and status in ('queued', 'running');
   ```

5. **Roll back the migration:**

   ```sh
   ALLOW_DB_ROLLBACK=true DB_ROLLBACK_STEPS=1 NODE_ENV=production pnpm db:rollback
   ```
