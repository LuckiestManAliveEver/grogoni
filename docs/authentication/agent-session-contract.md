# Agent session authentication contract

## Canonical browser authentication

Grogoni's web and PWA clients authenticate to the public API with the `grogoni_session` and
`grogoni_refresh` HTTP-only cookies. Login, signup, OAuth completion, and device recovery all issue
this same cookie family. Browser JavaScript does not read or copy either credential.

All authenticated frontend requests use `apps/web/src/lib/api.ts`. That client always uses
`credentials: "include"`. When an ordinary API request receives a 401, the client single-flights
`POST /auth/session/refresh` across concurrent callers and replays each original request at most
once. Authentication entry points are never recursively refreshed.

`apps/web/src/hooks/useAuthState.ts` owns the UI lifecycle for those credentials:

1. A cached account and shop may restore the offline shell as `offline-authenticated`.
2. Cached data is not proof of a server session. Online server work is blocked while
   `GET /auth/bootstrap` validates or refreshes the cookie family.
3. Only `authenticated` may initialize server-backed agent work.
4. A retryable network failure keeps local data available but does not grant server-authenticated
   status.
5. A final authentication 401 clears the cached session view and opens reauthentication. The UI
   must not claim that the user remains signed in.

## Runtime session lifecycle

```text
login/signup/device recovery
        ↓ HTTP-only access + refresh cookies
canonical authenticated API client
        ↓ GET /auth/bootstrap (refresh and one replay when needed)
validated account + user
        ↓ POST /businesses/:businessId/runtime/sessions
access-session validation + PIN state
        ↓
business membership and business:read authorization
        ↓
idempotent user/business runtime session
        ↓ POST /businesses/:businessId/runtime/turns
server-owned business agent profile + active model binding
        ↓
API-to-inference bearer service credential
        ↓
model/runtime response
```

The runtime-session endpoint does not accept a client-selected agent ID. The business is the tenant
boundary, and the server resolves that business's agent profile and active model binding when a turn
is created. This prevents a caller from combining an authorized business with another business's
agent.

Session creation accepts an `idempotencyKey`. The frontend retains one key across a failed creation
attempt, including a lost response, and the API scopes lookup by authenticated user and business.
Replaying the request therefore returns the original runtime session. A different account or
business cannot claim it with the same key.

## Authorization and error boundaries

- `401 auth_required` means the access session is missing or expired. The frontend client first
  attempts the canonical refresh path.
- A final definitive 401 means reauthentication is required.
- `403 membership_required` or `permission_denied` means the authenticated account is not allowed
  to use that business. Refreshing or logging in again must not bypass it.
- `409 agent_runtime_not_ready` and `AGENT_MODEL_NOT_CONFIGURED` are agent/model state failures,
  not user-authentication failures.
- `INFERENCE_AUTHENTICATION_FAILED` is the API-to-runtime service credential boundary. It must not
  sign the browser out.
- Runtime availability, timeout, and model errors must leave the user session intact.

Runtime creation logs request correlation ID, business ID, credential presence, authentication
outcome, user ID after authorization, runtime session ID, and a stable error code. Cookies, bearer
tokens, prompts, and message bodies are never logged.

## Production configuration

Current production is a Render static frontend at `https://grogoni.com` and a Render API at
`https://grogoni.com`. These hosts are same-site, so secure `SameSite=Lax` host-only cookies are
appropriate.

Frontend build:

```dotenv
VITE_API_BASE_URL=https://grogoni.com
```

Render API:

```dotenv
WEB_ORIGINS=https://grogoni.com,https://www.grogoni.com
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
SESSION_ACCESS_TTL_SECONDS=900
SESSION_INACTIVITY_TTL_DAYS=30
SESSION_ABSOLUTE_TTL_DAYS=180
SESSION_ROTATION_ENABLED=true
SESSION_REUSE_DETECTION_ENABLED=true
```

Render API to the configured inference service:

```dotenv
BACKEND_INFERENCE_ENABLED=true
BACKEND_INFERENCE_BASE_URL=<configured inference service URL>
BACKEND_INFERENCE_MODEL_ID=qwen2.5-0.5b-android
INFERENCE_SERVICE_TOKEN=<same secret configured on the inference service>
```

`INFERENCE_SERVICE_TOKEN` is server-only and must never use a `VITE_` prefix.

This repository has no Vercel deployment configuration. If a separate Vercel preview or production
frontend is introduced, set `VITE_API_BASE_URL` in that project and add its exact HTTPS origin to
`WEB_ORIGINS` and the relevant WebAuthn/OAuth origin lists. A `*.vercel.app` frontend is cross-site
from `grogoni`; supporting that topology requires `COOKIE_SAME_SITE=none` with
`COOKIE_SECURE=true`. Prefer the same-site `grogoni` custom domain for production.

## Verification checklist

- Confirm login/signup responses set both host-only secure cookies.
- Confirm `/auth/bootstrap` succeeds after a PWA reload before runtime creation begins.
- Confirm an expired access cookie triggers one refresh and one replay.
- Confirm duplicate creation with the same idempotency key returns one runtime session.
- Confirm account A receives 403 for account B's business and no runtime session is persisted.
- Confirm API readiness reports database health separately from optional inference readiness.
- Confirm the API and inference service use the same `INFERENCE_SERVICE_TOKEN` without printing it.
