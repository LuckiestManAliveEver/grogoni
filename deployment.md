# Grogoni Deployment

Grogoni now targets a split deployment:

- Frontend: Vercel static Vite app from `apps/web`.
- API: the existing Node/Fastify service from `services/api`.
- Database: Supabase Postgres.
- Inference: the existing Vercel inference service in `services/ai-runtime`.

The important boundary is that `services/api` is not a Supabase Edge Function today. It uses Node,
Fastify, WebSockets, background runners, Redis-backed rate limits, and PostgreSQL pools. Supabase is
the right replacement for the database layer, but the API process still needs a Node runtime unless
the API is ported to Supabase Edge Functions separately.

## Frontend on Vercel

Deploy this repository to Vercel from the repo root. The root `vercel.json` is configured for the
web app:

```text
installCommand: pnpm install --frozen-lockfile
buildCommand: pnpm build:web:vercel
outputDirectory: apps/web/dist
```

Set these Vercel environment variables for the frontend project:

```text
VITE_API_BASE_URL=https://api.grogoni.com
VITE_API_URL=https://api.grogoni.com
VITE_DEPLOYMENT_ENV=production
VITE_INFERENCE_OWNER_NODE_ENABLED=false
VITE_INFERENCE_MAX_FALLBACKS=3
```

If the API is served from a different hostname, use that hostname for both `VITE_API_*` variables.
The SPA fallback is handled by the Vercel rewrite in `vercel.json`.

## Supabase Postgres

Create a Supabase project and copy both database URLs:

- `DATABASE_URL`: pooled connection string for normal API traffic.
- `DIRECT_DATABASE_URL`: direct/session connection string for migrations and schema checks.

Use `sslmode=require` on both URLs. Keep `CP2_STORE=postgres`.

Run migrations against Supabase before sending production traffic:

```bash
DIRECT_DATABASE_URL="postgresql://..." DATABASE_URL="postgresql://..." pnpm db:migrate
DIRECT_DATABASE_URL="postgresql://..." DATABASE_URL="postgresql://..." pnpm db:verify-schema
```

## API Service

Run the existing API as a Node service with:

```bash
pnpm install --frozen-lockfile
pnpm --filter @grogoni/api build
pnpm --filter @grogoni/api start
```

Required production environment:

```text
NODE_ENV=production
API_HOST=0.0.0.0
PORT=4000
APP_URL=https://grogoni.com
WEB_PUBLIC_URL=https://grogoni.com
WEB_ORIGINS=https://grogoni.com,https://www.grogoni.com
AUTH_BASE_URL=https://api.grogoni.com
AUTH_ALLOWED_REDIRECT_ORIGINS=https://grogoni.com,https://www.grogoni.com
WEBAUTHN_RP_ID=grogoni
WEBAUTHN_EXPECTED_ORIGINS=https://grogoni.com,https://www.grogoni.com
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
CP2_STORE=postgres
DATABASE_URL=<supabase pooled url>
DIRECT_DATABASE_URL=<supabase direct url>
REDIS_URL=<managed redis url>
```

Preserve all authentication and encryption secrets from the old deployment if users or production
data already exist:

```text
OTP_HMAC_SECRET
PASSWORD_HASH_SECRET
AUTH_AUDIT_HMAC_SECRET
PIN_HASH_SECRET
AUTH_TOKEN_ENCRYPTION_KEY
AUTH_SECRET
AUTH_SESSION_SECRET
GROGONI_INFERENCE_SERVICE_TOKEN
INFERENCE_CREDENTIAL_KEYS
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

`REDIS_URL` is required in production by the current API. Use a managed Redis provider if Supabase
is only providing Postgres.

## Inference

The repo already has a separate Vercel deployment config at `services/ai-runtime/vercel.json`.
Deploy that service separately and set the API variables:

```text
VERCEL_INFERENCE_URL=https://<ai-runtime-project>.vercel.app
GROGONI_INFERENCE_SERVICE_TOKEN=<same value in API and ai-runtime>
VERCEL_INFERENCE_TIMEOUT_MS=300000
```

If hosted inference is not ready during the first web/API cutover, leave `INFERENCE_REQUIRED=false`
so the API can boot while model calls report unconfigured runtime errors.

## DNS

Point the production hostnames at the new services:

```text
grogoni      -> Vercel frontend
www.grogoni.com  -> Vercel frontend
api.grogoni.com  -> Node API service
```

Keep the API hostname stable once published because installed clients and service workers can cache
the compiled `VITE_API_BASE_URL`.

## Verification

After DNS is attached:

```bash
curl --fail https://api.grogoni.com/health/live
curl --fail https://api.grogoni.com/health/ready
curl --fail https://api.grogoni.com/health/db
curl --fail https://api.grogoni.com/api
curl --fail --header 'Accept: text/html' https://grogoni.com/
```

Then verify in a browser:

1. `https://grogoni.com` loads the application and a nested client route survives refresh.
2. Sign-in and sign-out work with cross-origin secure cookies.
3. API calls target `https://api.grogoni.com`.
4. Passkey registration and authentication use RP ID `grogoni`.
5. Push notifications still work with the preserved VAPID keys.
6. The service worker, manifest, icons, and hashed assets return successfully from Vercel.
