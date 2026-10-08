# Supabase Edge API With Neon

Target project: `gnmndzsughifhboqvsgd` (`us-east-2`). The database stays in Neon.
No Supabase database URL or database migration is needed.

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

Credential hashes preserve the existing scrypt formats and verified legacy PIN upgrade.
Failed logins commit sanitized audit records; transaction-scoped advisory locks enforce the
five-failure/15-minute limit across workers. Authentication writes mirror compatibility
records within the same transaction. Refresh rotation preserves the absolute lifetime and
15-second retry grace using an encrypted replacement token, and revokes the family on reuse.
Logout and refresh acquire the same family lock to serialize concurrent revocations.
Discovery does not advertise unfinished passkey/account-recovery routes. Password login for
accounts with enabled MFA returns a ten-minute challenge without issuing cookies. TOTP and
single-use recovery codes complete it under row locks; failed attempts persist, five failures
invalidate a challenge, and account-wide verification rate limits apply across challenges.
TOTP uses the existing SHA-1/six-digit/30-second policy with a one-step clock-skew window and
rejects reused time steps. PIN setup for MFA-enabled accounts also requires a second factor.
MFA enrollment and management routes are not ported yet.

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
ignored, owner-readable `.env.local`. All five values are configured in Supabase, with remote
SHA-256 hashes verified against the local values. Preserve them for subsequent deployments.
Secret configuration alone does not change application readiness. Any integration tokens encrypted under the lost key require
reconnection; they cannot be decrypted with the new key.

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

- Keep all Edge-hosted routes on transaction-scoped PostgreSQL operations. Loading and
  flushing independent whole-store snapshots in concurrent workers can lose updates.
- Preserve frontend endpoint paths and response contracts for each domain as new
  surfaces are promoted into the Edge function.
- Drive scheduled work through `/internal/jobs/:jobName/run` using an operator token
  and persisted `cp2_background_jobs` records.
- Use `/v1/realtime/connect`, `/v1/realtime/events`, and
  `/v1/realtime/events/:eventId/ack` for Edge-compatible realtime delivery.
- Keep inference and computer runtimes as separately hosted services where execution exceeds
  Edge Function resource limits.
- Test concurrent writes, authentication, jobs, and frontend flows before switching the API URL.

Supabase runtime guidance:
[limits](https://supabase.com/docs/guides/functions/limits),
[deployment](https://supabase.com/docs/guides/functions/deploy), and
[secrets](https://supabase.com/docs/guides/functions/secrets).
