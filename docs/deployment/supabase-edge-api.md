# Supabase Edge API With Neon

Target project: `gnmndzsughifhboqvsgd` (`us-east-2`). The database stays in Neon.
No Supabase database URL is needed; the Neon schema needs the repository migrations
(`pnpm db:migrate`), including `110_edge_rate_limits.sql` before deploying this function.

## Current State

`supabase/functions/api` is the native Edge API host for liveness, CORS, Neon-backed
credential authentication, sessions, marketplace/product-capture routes, chat and
message routes, shop-system integration routes, realtime polling, and durable
background-job triggers. Signup, PIN/password login, refresh, session validation,
bootstrap, credential status, MFA challenge/verification, and logout are handled in
the same Edge function. Raw Node WebSockets and process-local timers are replaced
with HTTP polling/ack routes and persisted job trigger records, which fit the
Supabase Edge runtime model.

`/health/ready` returns HTTP 200 once the Edge function is wired with the application
router and Neon is reachable. Unit tests still cover the incomplete-host case, where
readiness remains HTTP 503 with `api_migration_incomplete`.

Live base URL: `https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api`.
Live frontend: `https://grogoni-frontend.vercel.app`. The custom domains `grogoni.com` and
`www.grogoni.com` are attached to this Vercel project, with www redirecting to the apex.
The deployment command retains existing allowed origins and explicitly adds all three
frontend origins. CORS preflights support the browser's device,
request, turn, and idempotency headers, with credentials enabled for the allowed origin.

Run `pnpm health:connected` to check the live frontend's HTML and assets, Supabase liveness,
the Vercel-to-Supabase CORS rules, Neon connectivity, unauthorized-session rejection,
login-route validation, and overall readiness.

The production checker defaults to `https://grogoni.com` and its `/api` proxy. It rejects
HTML responses, missing commit metadata, unavailable public routes, and failed auth
validation. Set `SMOKE_EXPECTED_COMMIT` to require a specific deployed commit.
Run `pnpm health:browser` for desktop and phone signup/login Continue checks. These assert
the actual POST response and JSON contract, and save screenshots in
`/tmp/grogoni-production-smoke`. They stop before account creation.

Set both `VITE_API_BASE_URL` and `VITE_API_URL` in Vercel to `/api`.
Production builds fail when neither is configured. Vercel builds currently retain
the `/api` override until the project's environment values can be verified; removing
that override is a separate configuration migration. `vercel.json` forwards `/api` to Supabase before
the SPA fallback, so session cookies remain first-party on mobile browsers. The
rewrite pins invocation to `us-east-1`, near the existing Ohio database. Direct
builds may configure the absolute API address. Build metadata includes
`VERCEL_GIT_COMMIT_SHA`.

The Vercel project's `VITE_API_BASE_URL` should be `/api` before
the frontend is rebuilt. Vercel management access is configured through the ignored
local environment. Do not substitute the deployment token for a browser API key.
Verified live: `/health/live` returns 200, `/health/db` returns 200 with
`database.provider=neon` and `database.ok=true`.

With the Supabase access token and existing Neon `DATABASE_URL` in the ignored root environment
files, run `pnpm deploy:api:supabase` to deploy and verify, or `pnpm health:api:supabase`
to repeat the live read-only health checks without deploying. Deployment sets the
`DATABASE_URL` and `WEB_ORIGINS` secrets in the Supabase project. Both are project-wide
secrets, so other functions should not use these names for unrelated configuration.

Native session routes: `GET /session`, `GET /auth/session`, `GET /api/auth/session`,
and `POST /logout`, `POST /auth/logout`, `POST /api/auth/logout`.
They query Neon per request. Logout revokes the full refresh family and mirrors the
revocation into `cp2_sessions` in the same transaction. No shared worker snapshot is used.

Native authentication routes:

- `POST /auth/login/methods`, `/auth/login/password`, `/auth/pin/login`, `/auth/pin/store-login`.
- `POST /auth/signup/start`, `/auth/signup/complete`, `/auth/pin/signup`, `/auth/pin/continue`.
- `POST /auth/pin/setup`, `/auth/session/refresh`, `/session/refresh`.
- `POST /auth/mfa/challenge`, `/auth/mfa/verify`.
- `GET /auth/bootstrap`, `/auth/credentials/status`, `/auth/pin/status`.
- `POST /auth/identify` returns the existing replacement notice (HTTP 410).
- `POST /auth/continue` creates or restores a device account using a secure bootstrap
  key and a validated P-256 public key. Device sessions are not PIN verified.
- `GET /auth/oauth/providers` returns an empty list until OAuth is configured.
- `GET /public/storefronts`, `GET /v1/marketplace-intro`, and
  `POST /v1/marketplace-intro/complete` serve browsing and intro state.

Credential hashes preserve the existing scrypt formats and verified legacy PIN upgrade.
Failed logins commit sanitized audit records; transaction-scoped advisory locks enforce the
five-failure/15-minute limit across workers. Authentication writes mirror compatibility
records within the same transaction. Refresh rotation preserves the absolute lifetime and
15-second retry grace using an encrypted replacement token, and revokes the family on reuse.
Logout and refresh acquire the same family lock to serialize concurrent revocations.
Discovery advertises passkeys when configured; their routes initialize the shared
domain router on demand. Email recovery
remains unavailable without delivery configuration. Passkey origins are restricted to
`https://grogoni.com` and `https://www.grogoni.com`. Password login for
accounts with enabled MFA returns a ten-minute challenge without issuing cookies. TOTP and
single-use recovery codes complete it under row locks; failed attempts persist, five failures
invalidate a challenge, and account-wide verification rate limits apply across challenges.
TOTP uses the existing SHA-1/six-digit/30-second policy with a one-step clock-skew window and
rejects reused time steps. PIN setup for MFA-enabled accounts also requires a second factor.
MFA enrollment and management routes use the shared domain adapter.

Email-based account recovery is intentionally unavailable: `RESEND_API_KEY` and
`GROGONI_EMAIL_FROM` are not configured, and the operator confirmed there is no email
delivery setup yet. Do not enable development OTP exposure in the deployed function.

Run local coverage with:

```bash
pnpm exec vitest run tests/supabase-edge-auth.test.ts tests/supabase-edge-handler.test.ts tests/supabase-edge-session.test.ts tests/supabase-edge-application-routes.test.ts
```

The live session test creates a disposable Neon account and two sessions, checks
authentication and logout through the deployed Supabase endpoint, verifies family
revocation and compatibility parity, and removes its fixture in a `finally` block:

```bash
node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/test-supabase-sessions.mjs --live
```

The live authentication test uses disposable accounts, checks password signup, PIN setup,
both login methods, MFA challenge/verification, concurrent transaction consumption, TOTP
replay rejection, single-use recovery codes, concurrent refresh/reuse, lockout, logout,
and compatibility parity,
then removes its fixtures. It queries DNS directly while preserving normal HTTPS hostname
and certificate verification, to tolerate negative OS-resolver caching in this environment:

```bash
node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/test-supabase-auth.mjs --live
```

## Authentication Secrets

The previous deployment's authentication secrets could not be recovered. A read-only Neon
check confirmed zero accounts, users, PIN credentials, password credentials, passkeys, and
compatibility accounts before the operator authorized fresh secrets. Five independent
48-byte random values were generated for `PASSWORD_HASH_SECRET`, `PIN_HASH_SECRET`,
`AUTH_AUDIT_HMAC_SECRET`, `OTP_HMAC_SECRET`, and `AUTH_TOKEN_ENCRYPTION_KEY` in the
ignored, owner-readable `.env.local`. All five values are configured in Supabase, with
remote SHA-256 hashes verified against the local values. Preserve them for subsequent
deployments. Secret configuration alone does not change application readiness. Any
integration tokens encrypted under the lost key require reconnection; they cannot be
decrypted with the new key.

## Runtime Secrets

Production uses the existing Neon `DATABASE_URL`. The host also accepts ordinary
PostgreSQL URLs, including Supabase Postgres, provided the application schema and
data have been migrated there. Changing providers is not part of this deployment.
Set `WEB_ORIGINS` to the exact permitted frontend origins. Authentication and
encryption secrets from the existing API must be preserved as their routes are ported.
The Supabase personal access token is a deployment credential, not an Edge Function secret.
Never expose these credentials through frontend `VITE_*` variables.

The function disables gateway JWT verification because it uses custom application sessions
rather than Supabase Auth JWTs. Every protected route must implement the application's session
authentication before it is added; the project's Supabase Auth tokens are not substitutes
for existing application session credentials.

## Required Porting Work

The Edge function now bundles the original CP2 and MCP HTTP route registrars. This
includes user profiles/security, businesses, shops, products/inventory, customers,
suppliers, staff invitations/roles, invoices/payments, fulfillment, reports,
documents, marketplace, conversations/messages, and integration routes. The
adapter keeps the original validation and authorization rather than substituting
generic table CRUD. Deployment builds the domain bundle and PDF worker automatically.
Apply migrations `109_edge_protocol_state.sql` and `110_edge_rate_limits.sql` before
deployment: MCP sessions, checkout confirmations and one-use OAuth grants must survive
worker changes, and the rate limiter counts in `cp2_edge_rate_limits` (it fails open,
logging `edge_rate_limit_unavailable`, while the table is missing).

Connections are pooled per worker. Native public reads and liveness do not load
the domain bundle or acquire a global lock. The domain bundle initializes lazily.
Domain requests load only the actor's related tenant state, explicitly requested
public businesses, and required shared catalog records. Mutations serialize on
account and business locks; ordinary GET/HEAD reads do not take those locks or
flush transient snapshot changes. MCP protocol state has a separate lock.
Persistence updates changed records and deletes only rows removed from the loaded
baseline, with optimistic checks against concurrent normalized-record updates.
Offline sequence watermarks are per business rather than a global write hotspot.
This remains an in-memory tenant adapter: a large individual tenant can still
require substantial hydration, and future per-entity SQL persistence is desirable.
The browser uses awaited HTTP sync polling for the first-party `/api` proxy.
Turn-stream previews remain worker-local and best effort; durable messages are
available through normal conversation and sync endpoints.

Run `pnpm test:business:supabase` against the candidate, or set `SMOKE_API_URL` to
the production function. It verifies business/product persistence, tenant
isolation, public privacy and staff joining, and removes its own disposable rows.
Candidate deployment: `pnpm deploy:api:supabase --slug=api-candidate`.
Run `node scripts/test-supabase-concurrency.mjs --live` for read-only bursts of
10 and 25 requests against the candidate. Set `SMOKE_API_URL=https://grogoni.com/api`
to verify the production proxy. Browser smoke uses reserved Ofcom drama numbers
and requires database/audit credentials to remove its own unconsumed signup
transactions and audit records; cleanup failures fail the run.
External email, payment, inference and computer-runtime integrations still require
their real credentials/services. The Edge store is built with the same outbound
providers as the Node API (`services/api/src/edge-store-dependencies.ts`: web push,
encrypted-message email notices, network invites, channel gateway, connected mailboxes,
account-deletion processors), each configured by the same environment variables and
omitted when they are unset.

### Background jobs

`POST /internal/jobs/:jobName/run` (header `x-job-token: $BACKGROUND_JOB_TOKEN`) runs the
job to completion and answers with its outcome; `GET /internal/jobs/:jobName/status`
returns the last recorded run from `cp2_background_jobs`. Both check the token before
touching the database. Each job does what its Node interval runner does
(`services/api/src/edge-job-runner.ts`) in one transaction that takes a per-job try-lock
before the store lock (`supabase/functions/api/job-transaction.ts`), so an overlapping
trigger answers `skipped` at once and never runs the job twice; a skipped trigger leaves
the last real run's record in place. The `ENABLE_*_RUNNER` switches behave as on the Node
API: every job runs unless its switch is `false`, except `account_deletion_purge`, which
purges data and runs only when `ENABLE_ACCOUNT_DELETION_RUNNER=true`.

Jobs that load the domain store hold the store lock for the whole run, including their outbound
sends (web push, email, webhooks, mailbox sync), because a store save must not race a request's
save. Every user request waits on that lock with a 10-second `lock_timeout`. Each send is
bounded, but a run is not: web push and Resend email time out at 10 seconds, the channel
gateway at 10 seconds, mailbox and invite calls at 15 seconds, and notification delivery sends
at most 25 notifications per run (1,500 an hour on the one-minute schedule). A mailbox sync run
makes several calls per due mailbox, so a run over many mailboxes can still hold the lock for a
long time. The outbox and notification jobs check for due work first and, when there is none,
return without loading the store or taking the store lock; the idempotency purge never takes
it. The fulfillment service is built as on Node, with the outbox notifier and
`FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS`. A run that still takes longer than 10 seconds makes
concurrent requests fail with 503 until it commits; set that job's `ENABLE_*_RUNNER=false` to
stop it while investigating. Removing this contention needs tenant-scoped locks instead of the
single store lock.

Delivery is at least once: a send made inside a run whose transaction then fails is
retried by the next run. On Edge one run's outbox deliveries commit together (they are
savepoints inside the job transaction), where the Node runner commits each event on its
own, so a run that fails after sending re-sends its whole batch; the batch is capped at 25
events. The same holds for invites sent while handling a request.

The `daemon_worker` job is the server lane of the background task queue: an hourly sweep, plus
a per-minute wake check (`grogoni-daemon-wake`) that runs in Supabase's own Postgres and calls
the job only when server work is due. Users' tasks run first in their open browsers. See
[Daemon lanes](daemon-lanes.md).

Supabase Cron triggers the jobs. The schedule is generated from the job definitions:

```bash
pnpm jobs:schedule:supabase           # print the SQL, change nothing
pnpm jobs:schedule:supabase --apply   # reuse the Vault token, apply the schedule
pnpm jobs:schedule:supabase --apply --rotate-token # explicit token rotation
```

`--apply` (needs `SUPABASE_ACCESS_TOKEN`) reuses the existing Vault token or generates one on
first setup, sets it as `BACKGROUND_JOB_TOKEN`,
a function secret, stores the same value in Supabase Vault, creates one `grogoni-job-*` pg_cron
entry per job and removes entries for jobs that no longer exist. The token is read from Vault
at call time and never appears in `cron.job`. Only first setup or explicit `--rotate-token`
changes it: warm function isolates can answer 401 until they recycle (minutes). Ordinary
schedule updates preserve the token to avoid that authentication gap.
Check runs with `select * from cron.job_run_details order by start_time desc` and `GET
/internal/jobs/<job>/status`.

### Rate limit

Every request that opens a database transaction is counted per client before it waits on
any lock: one counter per client, windows taken from the database clock, 300 requests a
minute, 60 for `/auth/*`, the same limits as the Node API's `@fastify/rate-limit`
(`supabase/functions/api/rate-limit.ts`). Over the limit the API answers `429
rate_limited` with `Retry-After`. Counters live in `cp2_edge_rate_limits` (migration 110),
keyed by a digest of the first `x-forwarded-for` address, which is the address Vercel's
`/api` rewrite reports. A caller that skips Vercel and calls the function URL directly
controls that header, so the limit protects `grogoni.com/api`, not the raw function URL.
The `edge_rate_limit_retention` job deletes windows older than an hour.

Limits come from `EDGE_RATE_LIMIT_MAX` (default 300) and `EDGE_RATE_LIMIT_AUTH_MAX`
(default 60); `EDGE_RATE_LIMIT_ENABLED=false` turns the limiter off. A request without an
`x-forwarded-for` header is not limited, so a missing header cannot put every user into one
shared bucket. After a deploy, confirm the first `x-forwarded-for` entry is your own
address as seen through Vercel:

```bash
curl -s https://grogoni.com/api/internal/edge/domain-startup \
  -H "x-edge-diagnostic-token: $AUTH_AUDIT_HMAC_SECRET" | jq .forwardingHeaders
curl -s https://api.ipify.org
```

If the first entry is not your address (for example a Vercel or Supabase address), every
user would share a counter: set `EDGE_RATE_LIMIT_ENABLED=false` and report it.

### Concurrent requests

Each request loads a scoped snapshot inside one transaction and saves it with optimistic
concurrency: a save whose rows changed underneath it throws `40001` ("Concurrent snapshot
update"), which the handler answers as `503 service_unavailable`. Two rules keep that rare:

- **Hydration writes nothing.** Restoring a snapshot must not change a row that is already
  current. In October 2026 `ensureGlobalDefault()` (`services/api/src/cp2/domains/native-runtime/store.ts`)
  re-stamped the shared `builtin:shopkeeper:v1` agent's `updatedAt` on every request, so every
  signed-in request wrote the same `cp2_native_runtime_agents` row and concurrent ones lost the
  race: up to 12 of 17 parallel requests answered 503. It now rewrites the agent only when its
  content differs (`tests/native-runtime-default-idempotency.test.ts`).
- **Only what is safe to repeat is retried** (`mayRetryRequest` in
  `services/api/src/edge-domain-routes.ts`, at most two reruns with a short jittered wait). A
  `GET`/`HEAD` that lost the race reruns only if it is on the `retryableReads` allowlist: the
  app's polling and listing routes (shops, session context, conversations, a shop's records,
  public storefronts, network), which touch nothing but this database. Everything else is left
  alone on purpose: an OAuth or mailbox callback redeems a single-use code, a search may call a
  connector, and a new route is not retried until someone has checked it cannot reach a third
  party. A storefront ID claim (`POST /businesses`, `PUT`/`PATCH`/`POST
/businesses/:id/grogoni-id`) that hit the unique index (`23505`) also reruns: it lost a race to
  the same new ID and does nothing else. Nothing reruns once the attempt used an
  independent transaction (`approvalTransaction`), because that work may have committed; this
  counts reads made through it too, so such a request is not retried even when it only read. Other writes are
  never replayed by the server; the web app's outbox resends a failed message at most three
  times on its own, with backoff (see docs/frontend/frontend.md, "Sending state"). Each attempt counts against
  the rate limit.

- **Loading fills defaults; that is not a change.** Restoring a message fills fields an older
  row may lack (`provider`, `direction`, channel ids). The request's change baseline uses the
  messages as hydrated (`rebaseLoadNormalizedCollections`), while the optimistic check still
  compares with the stored rows. Before, every send rewrote every earlier message in its
  conversation, and a concurrent "mark read" on one of them failed the send with 40001.
- **Re-evaluating a rule that still says the same thing writes nothing.** Shop notification rules
  (beta and launch readiness and others) run on every request; re-stamping their `updatedAt` each
  time made concurrent requests for a shop conflict on those rows. `upsertNotification` now writes
  only when the severity, title or body changed. `tests/edge-runtime-checkpoint-scope.test.ts`
  checks every normalized table: a send rewrites only its conversation, its agent task head and
  the shop's offline watermark, so the next touch-on-every-request write fails the test.
- **A reply sorts after the message it answers.** An agent's reply carries the same timestamp as
  the message it answers; on a tie the message comes first (rows load in no fixed order on Edge).
- **Marking read is a no-op when nothing is unread.** The web app marks the open conversation read
  on every 4-second refresh. The server now leaves the participant row and the sync log alone when
  this participant has read up to the newest message from someone else and no message is still
  flagged unread, the same per-participant rule `unreadCount` uses (a message's `readAt` is shared
  by every participant, so it alone cannot say whether this one has read it). The app only asks
  when that rule says something is unread.

Writes for one account run one at a time (`edge:account:` advisory lock, 10 s lock timeout). An
agent turn holds that lock for as long as the turn runs, so another write for the same account
waits behind it; one that waits longer than the timeout answers 503 (`55P03`). The web app keeps
its own writes out of that queue where it can (no read marker during its own send).

The failure log line (`edge_transaction_failed`) carries the conflicting `table`, so the next
hot row is named in the logs rather than guessed.

### Runtime checkpoints load with their conversation

Runtime checkpoint rows (`cp2_runtime_handoffs`, `cp2_runtime_task_heads`,
`cp2_runtime_task_instances`, `cp2_runtime_transfers`, `cp2_runtime_execution_events`) carry no
account, business or user column: they belong to a task, and a task id is a conversation id. The
scoped snapshot loads them only with the conversations the caller works in: their own, ones they
take part in, and those of shops they are a member of (`edge_task_conversation_ids` in
`services/api/src/cp2/edge-snapshot-scope.ts`). A storefront visitor or a guest search never loads
any. Before this, the second agent message in any conversation answered 503: its request saw no
checkpoint, bootstrapped version 1 again, and hit `cp2_runtime_handoffs_task_version_idx`
(`23505`) (`tests/edge-runtime-checkpoint-scope.test.ts`).

**Fixed: checkpoints no longer only grow.** Each agent turn adds a checkpoint that copies the last
one's actions and context, and a member used to load every checkpoint of every conversation in
their shops on each request. A task now keeps only what a reader can still need
(`services/api/src/cp2/domains/runtime-handoff/checkpoint-retention.ts`): the task head's
checkpoint (resume, every turn, swaps), the task instance's (drift check), every checkpoint a
transfer names (handoff restore, the web app's offline session), checkpoints without a cloud
version, and the latest 20 versions (rollback, `GET /handoffs/:id`, `GET /handoff?version=N`,
merge and offline sync). For 30 days it also keeps every branch: a checkpoint written without
promotion or synced from offline (`branchedAt`) and the checkpoint it started from, and any
checkpoint nothing descends from (counted from `createdAt`). So an unmerged branch can still be
merged and a retried offline sync, with or without an idempotency key, finds every checkpoint it
sent. Anything else older answers `RUNTIME_HANDOFF_NOT_FOUND` (404). Pruning runs on the write that adds a checkpoint, with no
operator or job: the in-memory store drops superseded ones (the writer deletes their rows), and on
Edge `saveTransactionalCp2Snapshot` first deletes stored ones the request never loaded, at most
200 per write, oldest first, so an existing backlog drains over the next writes. The Edge scope loads
only the kept ones (the same rule as SQL). Migration `123_runtime_checkpoint_retention.sql` drops the
checkpoint-to-parent foreign key (a kept checkpoint's parent may be pruned; a trigger still checks
the parent exists when a checkpoint is inserted) and checks the head, instance and transfer foreign
keys at commit, since the writer deletes checkpoints before it writes the rows that stopped
pointing at them. Rollback `123_runtime_checkpoint_retention.down.sql` cannot restore the parent
foreign key once any parent was pruned (it adds it back only when every parent still exists), so
after pruning has run in production 123 is in practice not reversible. Execution events (`cp2_runtime_execution_events`) still load in full for the
conversations a member works in; their sequence numbers are allocated from the loaded rows.

**Fixed: idempotency records are scoped to their account.** `cp2_runtime_operation_dedup` records
(checkpoint, swap, rollback, offline sync, merge) now carry `accountId` and `taskId`; the writer fills
`account_id` from the record and migration `124_runtime_operation_dedup_tenant.sql` backfills
stored rows from their result's task head and that conversation's owner. The Edge scope loads only
the caller's rows, and only the named task's when the request names one (`/v1/runtime/:taskId`, or
an MCP tool call's `taskId`). A record answers retries for 7 days; older ones are not consulted and
are deleted on the next write that records an operation (at most 200, in memory and on Edge from
storage). Before, it loaded none, so a retried checkpoint on Edge was not recognized: it
created a second dedup row with the same key and the write failed with `40001` (503)
(`tests/edge-runtime-checkpoint-scope.test.ts`).

### Offline change sequences across shops

`cp2_offline_changes` sequence numbers are unique across every shop
(`cp2_offline_changes_sequence`), but a request loads only its own shops' changes and markers. A
request that creates offline changes gives them their final numbers just before saving
(`allocateOfflineSequences`): it takes a transaction-scoped advisory lock that every such write
takes, reads the highest number in use (`offlineSequenceHighWater`, one index lookup) and numbers
its changes after it. The lock is held from there to commit, and only by writes that create
offline changes. Before, a shop reused numbers another shop had already taken, and two shops
writing at the same moment both took the next one; the later commit failed with `23505` (503)
(`tests/edge-runtime-checkpoint-scope.test.ts` runs both shops at once). A sync cursor a client
already holds can only be lower than the final numbers, so it re-reads those changes; it never
skips one.

### Storefront IDs across tenants

The scoped snapshot only holds the caller's own businesses, so it cannot see a Grogoni ID that
another tenant already owns. Requests that claim one (`POST /businesses`, writes to
`/businesses/:id/grogoni-id`) first read every taken ID from `businesses` and the unreleased rows
of `cp2_grogoni_id_history`, and the store skips those (`externalGrogoniIdTaken`). The public
availability check (`GET /public/commerce-identities/availability`) reads only the one ID it is
asked about, so an unauthenticated caller cannot make every call scan every business.
Before this, a second "Mama Mboga" shop hit the unique index (`23505`) and answered 503; it now
gets `grogoni.mama-mboga-2`. Two creates of the same new name in the same instant still meet at
the index; the loser reruns (see above) and takes the next suffix.

### Routes outside `/api`

`vercel.json` also rewrites the two MCP OAuth discovery documents to the paths the MCP
authorization spec has clients try first for an issuer with a path
(`https://grogoni.com/api`): `/.well-known/oauth-authorization-server/api` and
`/.well-known/oauth-protected-resource/api/mcp`. Without them the SPA fallback answers
with `index.html` and discovery fails. Native clients use `https://grogoni.com/api` as
their API origin (the Android default in `apps/android/app/build.gradle.kts`).
`pnpm check:api-routes` (`scripts/check-api-route-coverage.ts`) fails when a web or Android
call has no route, or when a `/businesses/:id/*` route group is not classified in
`packages/tool-core/src/contracts/api-route-coverage.json`. Routes are the domain inventory
plus the Edge routes production actually dispatches (`/realtime`, `/v1/realtime/*`,
`/internal/jobs/*`, public routes, `GET /health*`), with the methods their code accepts.

What it resolves. Request sites: API helpers (`postJson`, `getJson`, `apiFetch`, ...), also
under an import alias or held in a variable or parameter default (`request: PosJsonRequest =
postJson`); browser calls (`fetch`, `window.fetch`, and any callee named like
`fetch`/`fetcher`/`doFetch` that is not a function declared in the project or imported from a
third-party package; `sendBeacon`; `new Request`, `EventSource`, `WebSocket`;
`XMLHttpRequest.open`); links to the API base; and every key of a cache-key helper. Wrappers: a
function or method (receiver `this`, an object literal, or an instance of a class that declares
it; in the file or imported, including default exports, re-exports under another name, and
`useCallback`/`useMemo` callbacks) whose request path depends on one of its parameters, in any
position, directly or through a local constant, is a request site too. Each call is checked by
resolving the wrapper's path with its parameters bound to that call's arguments (an object
argument's properties too, for `input.base`), and a method parameter is read from the call. One
level of wrapper is followed, plus wrappers declared inside a wrapper whose path uses the outer
wrapper's parameters (`const post = (path) => input.doFetch(`${input.base}/x/${path}`)`),
resolved with both calls bound. Names follow JavaScript's scopes: a called name, a constant or a
receiver means the declaration in scope where it is written (a parameter, destructured or not, a
loop or `catch` variable, or a local declaration hides outer ones); an imported name means the
export it imports (`export function`, `export const`, `export class`, `export { x as y }`,
`export default`, anonymous ones too, re-exports, and `export * as ns from` as a namespace), and
an import from a module the check cannot resolve (a third-party package) is never taken for a
request helper, fetch, wrapper or builder, whatever it is called (an unmistakable API path
passed to it is still checked as data, below); `this.send` means the method of the enclosing
class or object (or of the class it extends, in the same file); `new C().send`, `c.send` for
`const c = new C()` and the static `C.send` mean that class's method (C a class declaration or
expression, declared or imported, or `W.C` for a namespace); `api.send` and `W.api.send` the
method of the object literal held there (here or imported, through `as`/`satisfies`); and
`W.send` for `import * as W` that module's export. A same-named declaration elsewhere never
stands in. Unmistakable API URLs (on the API base, under `/v1/`, or under `/businesses/<dynamic
id>/`) are also checked wherever they appear as data, including builder calls (`this.path(id,
"/x")`).

Paths are resolved through literals, templates, concatenation, `[...].join("/")`, ternaries, `a
?? b`, `.replace()`/`.trim()` on a base (and `.replace(/...$/, "/v1/x")` as a base ending in
`/v1/x`), `String()`/`encodeURI()`/`new URL(x)`, constants and nested endpoint objects (literal
keys too) in the same file or imported by module (relative imports and workspace packages, each
at its TypeScript entry: its `exports` source, `src/index` or a root `index`, through
re-exports, including namespace and default imports), composed constants, and builder functions
and methods (every `return`, with the call's arguments bound; a property of an object a builder
returns too). A later path piece that is a finite set of literal words (a constant, a ternary of
literals, a `"import" | "sync"` parameter or local type alias) is expanded into every
combination, up to 32, so removing any one of those routes on the server fails the check; any
other later piece is a dynamic segment. The API base is `readApiBaseUrl()` or
`import.meta.env.VITE_API_BASE_URL`/`VITE_API_URL`. Methods are read from the options object in
scope (`as const`, `{ method }`, method tables). A trailing expression glued to a word
(`/products${q}`, `${path}${query}`) is a query or a sub-path, so the rest is matched as a
prefix (a glued path constant is resolved). A path counts only if one segment is a fixed word. A
name declared in the project that cannot be evaluated (a missing export, or a missing key of a
declared constant or endpoint object; a key missing from an object a builder returns is dynamic)
fails the check unless listed in `clientPathExceptions`. Raw browser calls are relative to the
web origin: a relative API path must start with `/api/` or use the API base, and `new URL("/x",
readApiBaseUrl())` is reported because the leading slash drops `/api`. A raw call on a base the
check cannot see (a parameter, a config value) may be any origin and is not checked; a wrapper's
call sites are, when they pass the API base. Third-party bases, web-origin static files, in-app
navigation and comparisons are ignored.

What it cannot see: parameters, props, loop variables and computed keys (`PATHS[k]`) are dynamic
outside a bound wrapper or builder call; a path dynamic from its first segment
(`/v1/${anything}`); a removed route whose path a parameter route still matches
(`/v1/conversations/recycle-bin` vs `/v1/conversations/:id`); a path outside `/v1/` and
`/businesses/<id>/` that reaches the API only through a function it does not recognize (for
example a dependency typed by an interface, `this.deps.cloud("/auth/x")`); wrappers more than
one level deep, with destructured parameters, or whose base is a property of an argument passed
in a variable rather than as an object literal; a base held in a class field and read back
through `this` (the literal itself is checked as a prefix); functions returned by a getter;
members an object gets from a spread (`{ ...baseApi }.send`); a namespace inside a namespace
(`W.ns.send`); a member of a third-party import reached through more than one alias (`const a =
sdk; const b = a`), a name destructured from it (`const { http } = tauri`), or a call's result
(`sdk.create().postJson`) is taken for the project's own helper or fetch, so such a call is
reported rather than ignored; reassigned variables (the first value is used); `var` declared in
a nested block (treated as block-scoped); `this` inside a plain `function`, and methods
inherited from a class in another module; paths built by mutating a `URL` object (`url.pathname
+= ...`) or inside HTML strings; and on Android anything other than string literals
(concatenated across lines too) in files that define `request()`, or strings built on
`GROGONI_API_ORIGIN` (or a `val` holding it): a path kept in its own `val`, or built with
OkHttp's `addPathSegments`, is not read.

- Keep all Edge-hosted routes on transaction-scoped PostgreSQL operations. Loading and
  flushing independent whole-store snapshots in concurrent workers can lose updates.
- Preserve frontend endpoint paths and response contracts for each domain as new
  surfaces are promoted into the Edge function.
- Drive scheduled work through `/internal/jobs/:jobName/run` with the operator token;
  Supabase Cron calls it on the generated schedule (see Background jobs).
- Use `/v1/realtime/connect`, `/v1/realtime/events`, and
  `/v1/realtime/events/:eventId/ack` for Edge-compatible realtime delivery.
- Keep inference and computer runtimes as separately hosted services where execution exceeds
  Edge Function resource limits.
- Test concurrent writes, authentication, jobs, and frontend flows before switching the API URL.

Supabase runtime guidance:
[limits](https://supabase.com/docs/guides/functions/limits),
[deployment](https://supabase.com/docs/guides/functions/deploy), and
[secrets](https://supabase.com/docs/guides/functions/secrets).
