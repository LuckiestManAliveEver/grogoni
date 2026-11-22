# Render Retirement

Render is no longer part of Grogoni's hosting, and nothing in this repository deploys to it.
On 2026-11-22 the Render account had no services (the API key listed none, and
`grogoni.onrender.com` answered 404), so `render.yaml` only described infrastructure that no
longer existed. It was removed, together with everything that only Render used.

## What production runs on now

| Concern           | Where it runs                                    | Config                                           |
| ----------------- | ------------------------------------------------ | ------------------------------------------------ |
| Web app           | Vercel (`grogoni.com`, `www.grogoni.com`)        | `vercel.json` (deploys on every push to main)    |
| API               | Supabase Edge Function, behind Vercel's `/api/*` | `supabase/functions/api`, `supabase-edge-api.md` |
| Database          | Neon PostgreSQL                                  | migrations applied by hand, `pnpm db:migrate`    |
| Nightly backup    | GitHub Actions                                   | `.github/workflows/neon-backup.yml`              |
| Purges, DB health | GitHub Actions                                   | `.github/workflows/scheduled-maintenance.yml`    |

## Where each Render service went

| Render service               | Now                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `grogoni` (Node API, web)    | Supabase Edge Function. The Node API still runs locally (`pnpm dev`).                                                                      |
| `grogoni-web-staging`        | Vercel preview deployments (one per pushed branch).                                                                                        |
| `grogoni-rate-limit-cache`   | Not needed: the Edge API keeps rate limits in Postgres (`110_edge_rate_limits`).                                                           |
| `grogoni-computer-runtime`   | Not deployed anywhere. `services/computer-runtime` remains for local use.                                                                  |
| `grogoni-db-backup` cron     | `neon-backup.yml` (already the live backup).                                                                                               |
| `grogoni-shop-purge` cron    | `scheduled-maintenance.yml` job `shop-purge`, daily 03:37 UTC.                                                                             |
| `grogoni-account-purge` cron | `scheduled-maintenance.yml` job `account-purge`, daily 04:07 UTC.                                                                          |
| `grogoni-db-health` cron     | `scheduled-maintenance.yml` job `db-health`, every 30 min (was 10 on Render).                                                              |
| Deploy webhook push          | Removed (`/internal/render/deploy-webhook`). It was already unreachable: the API refuses to start with `RENDER_DEPLOY_WEBHOOK_SECRET` set. |

The service worker still shows an `app.update_available` push if one arrives, so a future
deploy notifier can reuse it.

## Switching the scheduled jobs on

Every job in `scheduled-maintenance.yml` stays off until its repository variable is `true`, the
same gate `neon-backup.yml` uses. Until then, account deletions past their 30-day recovery window
are not purged, which the Play legal-readiness record depends on.

1. Add repository secrets (Settings > Secrets and variables > Actions):
   - `PRODUCTION_DATABASE_URL`: the Neon pooled connection string the API uses.
   - `PRODUCTION_DIRECT_DATABASE_URL`: the Neon direct (non-pooler) connection string.
   - `ACCOUNT_DELETION_PROCESSORS_JSON` and `ACCOUNT_DELETION_WEBHOOK_SECRET`: the values the
     Render account-purge cron had.
2. Run each job once by hand: Actions > Scheduled Database Maintenance > Run workflow, choosing
   `db-health`, then `shop-purge`, then `account-purge`. Check each log.
3. Set the variables `DB_HEALTH_ENABLED`, `SHOP_PURGE_ENABLED` and `ACCOUNT_PURGE_ENABLED` to
   `true`.
4. Record the date in `config/play-legal-readiness.json` as
   `accountDeletion.purgeScheduleEnabledOn`. `pnpm android:legal:verify` lists it as pending until
   then, because code cannot see whether a repository variable is set.

The production secrets are set only on the step that runs each script, never during
`pnpm install` or the build, so no dependency's install script can read them. The health probe
runs every 30 minutes rather than Render's 10 to keep GitHub Actions minutes down; change the cron
(and `tests/scheduled-maintenance-workflow.test.ts`) if faster detection is worth the cost.

`tests/scheduled-maintenance-workflow.test.ts` keeps each job's schedule, command, secret scope and
gate from drifting, and fails if `render.yaml` comes back.
