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

Set both `VITE_API_BASE_URL` and `VITE_API_URL` in Vercel to the live Supabase URL.
Production builds fail when neither is configured. Vercel builds use `/api` in the
browser; `vercel.json` forwards that path to Supabase before the SPA fallback, so
session cookies remain first-party on mobile browsers. Direct builds retain their
configured API address. Build metadata includes `VERCEL_GIT_COMMIT_SHA`.

The Vercel project's `VITE_API_BASE_URL` should point to the live API base URL before
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
Discovery advertises passkeys only when the shared domain router is available; email recovery
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

Set `DATABASE_URL` to the existing Neon connection, not a Supabase connection.
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

Each request loads fresh state under the same transaction advisory lock used by
native authentication, then writes changes before commit. Relational reads are
batched on that connection. This prevents lost snapshot updates, but serializes
domain requests and is not a substitute for future tenant-scoped persistence.
The browser uses awaited HTTP sync polling for the first-party `/api` proxy.
Turn-stream previews remain worker-local and best effort; durable messages are
available through normal conversation and sync endpoints.

Run `pnpm test:business:supabase` against the candidate, or set `SMOKE_API_URL` to
the production function. It verifies business/product persistence, tenant
isolation, public privacy and staff joining, and removes its own disposable rows.
Candidate deployment: `pnpm deploy:api:supabase --slug=api-candidate`.
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

Supabase Cron triggers the jobs. The schedule is generated from the job definitions:

```bash
pnpm jobs:schedule:supabase           # print the SQL, change nothing
pnpm jobs:schedule:supabase --apply   # rotate the job token, apply the schedule
```

`--apply` (needs `SUPABASE_ACCESS_TOKEN`) generates a fresh `BACKGROUND_JOB_TOKEN`, sets it as
a function secret, stores the same value in Supabase Vault, creates one `grogoni-job-*` pg_cron
entry per job and removes entries for jobs that no longer exist. The token is read from Vault
at call time and never appears in `cron.job`. Every `--apply` rotates the token: function
isolates that are already warm keep the old secret and answer 401 to job calls until they
recycle (minutes), so re-run it only to change the schedule or rotate the token, not routinely.
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
