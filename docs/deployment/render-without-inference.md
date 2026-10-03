# Operating Render while inference is unavailable

Vercel executes inference as an independent deployment from Render's API. API availability is
intentionally independent from model readiness.

`INFERENCE_REQUIRED=false` means authentication, catalogue, ordering, messaging and governed
non-model operations remain online while Vercel is deploying, cold-starting, or unavailable.
Affected turns return normalized retryable runtime errors; the API does not silently choose a
different model/provider.

For a planned inference outage:

1. keep `VERCEL_INFERENCE_URL` and `GROGONI_INFERENCE_SERVICE_TOKEN` set - do not remove them from the
   Render dashboard, since Neon artifact metadata still needs to resolve for readiness reporting;
2. set `INFERENCE_REQUIRED=false` on the API (or leave it at its default) so `/health/ready` does
   not fail Render's health check while Vercel is down;
3. confirm `/health/ready` on the API remains healthy (`database.ok: true`);
4. restore the Vercel deployment, run `pnpm inference:health` (hits Vercel's `/health` directly)
   and `pnpm inference:probe` (a real end-to-end inference call through Render's `/health/ai`);
5. re-enable `INFERENCE_REQUIRED=true` if that was your steady-state setting, and run a first-chat
   smoke test.

Do not copy `GROGONI_INFERENCE_SERVICE_TOKEN`, `VERCEL_INFERENCE_URL`, or the Neon model-storage
credentials into any `VITE_*` variable. Browser-local, installed-app and owner-node runtimes remain
separate optional execution targets and are unaffected by a Vercel inference outage.

See [vercel-inference.md](./vercel-inference.md) for the full deployment runbook.
