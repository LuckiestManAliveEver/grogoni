# Railway Service Recovery

Each service uses a versioned settings payload, with the repository root as its
build context. These JSON files are inputs for Railway's `serviceInstanceUpdate`
API, not automatically loaded `railway.json` files. Railway now rejects the
legacy `railwayConfigFile` pointer; do not set it. Apply only the intended
service/environment settings, preserving unrelated project resources. Future
automatic infrastructure management should use Railway's current IaC tooling.
API and frontend build manifests use `RAILWAY_GIT_COMMIT_SHA` for deployment
identity; do not manually pin that variable to an old commit.

Production hosted inference does not initialize an unconfigured Ollama client.
Local-default deployments still initialize it, and an explicit `OLLAMA_BASE_URL`
enables the local catalog alongside hosted inference. Explicit production
endpoints retain the HTTPS requirement; required-inference readiness stays on.

| Service          | Configuration                          | Required Settings                                                                                                                                                                          |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API              | `/infra/railway/api.json`              | Existing pooled `DATABASE_URL`, unpooled `DIRECT_DATABASE_URL`, production auth secrets, existing model provider credential; `VITE_API_BASE_URL=/` for its same-origin embedded web bundle |
| Staging web      | `/infra/railway/web.json`              | `RAILPACK_SPA_OUTPUT_DIR=apps/web/dist`, `VITE_API_BASE_URL=/api`, `API_UPSTREAM` set to the API service's HTTPS origin; no custom start command                                           |
| Computer runtime | `/infra/railway/computer-runtime.json` | Private service, `PORT=8790`, strong `COMPUTER_RUNTIME_SERVICE_TOKEN`; no root workspace build/start override                                                                              |

The API retains the existing production migration and Neon schema checks, but
runs them in pre-deploy rather than during image construction. Production
migrations require the direct connection. Never set the migration 108 cleanup
override in production to force deployment through. Inspect pending migrations
before rollout and preserve the existing database and authentication secrets.

Railpack serves staging through the root `Caddyfile`. Its `/api` proxy strips
only that prefix and preserves the original Origin and cookie headers. Add the
staging HTTPS origin to the API's explicit `WEB_ORIGINS` allowlist; keep secure
`SameSite=Lax` cookies. Do not replace Origin with a trusted production origin
or weaken cookies to work around cross-site requests. Passkeys remain bound to
their configured production relying-party domain; staging is not a substitute
for testing production WebAuthn on that domain.

The static shell uses no-cache responses, immutable hashed assets, explicit
security headers and HTML fallback only outside `/api` and `/assets`. It does
not use Vite's development/preview server as a production host. The standalone
computer service uses the existing Playwright image, not a build of unrelated
web/API packages. Deploying that service does not re-enable the API's retired
remote-computer environment bridge.

Keep credentials in Railway's environment configuration, never in these files,
build arguments, logs, or committed artifacts. Verify readiness, staging's
proxied API, asset content types, browser rendering and deployment statuses
after rollout. A successful image build alone is insufficient.
