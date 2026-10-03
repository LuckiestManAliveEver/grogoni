# CP1 Artifact Manifest

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02

## Created CP1 Artifacts

| Path                                                 | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `documentation/checkpoints/cp1/CP1_BASELINE.md`      | Formal CP1 baseline, scope, exit criteria, and rollback instructions. |
| `documentation/checkpoints/cp1/DECISION_LOG.md`      | Engineering foundation decisions needed to start CP1.                 |
| `documentation/checkpoints/cp1/ARTIFACT_MANIFEST.md` | This manifest.                                                        |

## Implemented CP1 Artifacts

| Path                                         | Purpose                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `package.json`                               | Root workspace scripts for install, checks, build, CI, and health. |
| `pnpm-workspace.yaml`                        | pnpm monorepo workspace definition.                                |
| `apps/web`                                   | React/Vite mobile PWA shell.                                       |
| `services/api`                               | Fastify API service with `/health`.                                |
| `services/sync`                              | Sync service boundary.                                             |
| `services/ai-runtime`                        | AI runtime service boundary separated from business-core.          |
| `packages/business-core`                     | Deterministic business validation/event starter package.           |
| `packages/shared-types`                      | Shared runtime and environment types.                              |
| `packages/event-core`                        | Immutable event primitive.                                         |
| `packages/sync-core`                         | Sync queue primitive.                                              |
| `packages/tool-core`                         | Tool validation primitive.                                         |
| `packages/ui`                                | Shared React UI package.                                           |
| `docker-compose.yml`                         | Local PostgreSQL and Redis stack.                                  |
| `infra/db/migrations/000_initial.sql`        | Initial migration structure.                                       |
| `infra/db/schema.ts` and `drizzle.config.ts` | Drizzle schema and migration configuration.                        |
| `.github/workflows/ci.yml`                   | CI skeleton for install and baseline checks.                       |
| `documentation/ENVIRONMENT.md`               | Environment variable conventions.                                  |
| `documentation/CP1_LOCAL_DEV.md`             | Fresh-clone boot and verification instructions.                    |
| `documentation/FEATURE_FLAGS.md`             | Initial feature flag policy.                                       |
| `scripts/check-boundaries.mjs`               | Business-core to AI-runtime boundary check.                        |
| `tests`                                      | Baseline unit tests for API health and business-core.              |

## CP1 Opening Checklist

- [x] CP0 accepted as passed.
- [x] Stale CP0 status headers corrected.
- [x] CP1 marked `active` in checkpoint log.
- [x] CP1 baseline created.
- [x] CP1 decision log created.
- [x] CP0 decisions required before CP1 resolved or explicitly deferred.

## CP1 Completion Checklist

- [x] Monorepo directories created.
- [x] Workspace package manager configured.
- [x] Local development stack documented.
- [x] PostgreSQL and Redis local services configured.
- [x] API health check implemented.
- [x] Formatting command configured.
- [x] Lint command configured.
- [x] Type check command configured.
- [x] Unit test command configured.
- [x] CI skeleton created.
- [x] Initial migration structure created.
- [x] Environment variable conventions documented.
- [x] Business runtime packages remain independent from AI runtime implementation.
- [x] `checkpoint/cp1-engineering-foundation` tag created.

## Verification

- `pnpm install --frozen-lockfile`
- `pnpm run ci`
- `pnpm build`
- `docker compose up -d postgres redis`
- `docker compose ps`
- `pnpm --filter @grogoni/api start`
- `pnpm health:api`
