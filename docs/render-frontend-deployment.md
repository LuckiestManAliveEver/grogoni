# Render unified application deployment

The Vite frontend in `apps/web` and Fastify API in `services/api` ship together in the production
Render service `grogoni`.

`pnpm build:production` builds packages, the Vercel inference package, the web bundle, and the API.
The API process then serves `apps/web/dist`; browser navigations fall back to `index.html`, while
unknown API requests retain JSON 404 responses. Hashed `/assets/*` files are immutable, and HTML,
the service worker, manifest, and icons revalidate on every request.

Production uses `VITE_API_BASE_URL=https://grogoni.com`, so browser requests and session cookies
are same-origin. The branch-specific `grogoni-web-staging` static service remains independent
and must be given its own API URL.

## Updating Without Disturbing Active Users

Normal application updates should be shipped as rolling deploys instead of manually restarting the
service. The production Blueprint points Render at `/health/ready`; Render should only move traffic
to a new instance after that readiness check succeeds. When Render asks the old instance to stop,
the API handles `SIGTERM`/`SIGINT` by calling Fastify's graceful close path, which stops accepting
new connections, lets in-flight requests finish, and runs the existing cleanup hooks for background
runners, Redis, Postgres pools, and store resources. The shutdown grace period defaults to 25
seconds and can be adjusted with `SHUTDOWN_GRACE_MS`.

Use this path for routine changes:

1. Push the change to `main` and let Render auto-deploy `grogoni`.
2. Watch the new deploy until `/health/ready` is healthy.
3. Let Render drain the previous instance; avoid using a manual restart for ordinary code or
   frontend updates.

Database migrations still need compatibility care. A migration deployed with live traffic must be
backward-compatible with the currently running build until the new build is healthy. For breaking
schema changes, split the work into expand/deploy/contract releases so the old and new processes
can both run safely during the rolling window.

For dashboard setup, secret transfer, DNS cutover, verification, and rollback, use
[`../deployment.md`](../deployment.md).
