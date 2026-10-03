# CP2 Artifact Manifest

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02

## Created CP2 Artifacts

| Path                                                 | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `documentation/checkpoints/cp2/CP2_BASELINE.md`      | Formal CP2 baseline, scope, exit criteria, and rollback instructions. |
| `documentation/checkpoints/cp2/DECISION_LOG.md`      | Account, auth, business, role, language, and audit decisions.         |
| `documentation/checkpoints/cp2/ARTIFACT_MANIFEST.md` | This manifest.                                                        |

## Implemented CP2 Artifacts

| Path                                            | Purpose                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `infra/db/migrations/001_cp2_auth_business.sql` | Account, user, business, membership, OTP, and session migration.                   |
| `infra/db/schema.ts`                            | Drizzle schema for CP2 account and business records.                               |
| `packages/shared-types/src/index.ts`            | Shared CP2 auth, account, business, membership, session, role, and language types. |
| `packages/business-core/src/index.ts`           | Baseline role values and permission helper.                                        |
| `services/api/src/cp2/store.ts`                 | Provider-neutral local OTP, session, business, role, and audit store.              |
| `services/api/src/cp2/routes.ts`                | CP2 Fastify routes for OTP, session, logout, business creation, and role checks.   |
| `services/api/src/app.ts`                       | Registers CP2 API routes.                                                          |
| `apps/web/src/main.tsx`                         | Minimal owner account and business creation flow.                                  |
| `apps/web/src/styles.css`                       | Mobile-first CP2 form layout.                                                      |
| `apps/web/src/vite-env.d.ts`                    | Vite environment typing for web build.                                             |
| `tests/cp2-auth-business.test.ts`               | CP2 success and rejection-path API tests.                                          |

## CP2 Opening Checklist

- [x] CP1 accepted as passed.
- [x] CP1 checkpoint tag exists and is pushed.
- [x] CP2 marked `active` in checkpoint log.
- [x] CP2 baseline created.
- [x] CP2 decision log created.
- [x] CP2 scope excludes production SMS provider, M-Pesa provider, marketplace, TIEL, and AI runtime implementation.

## CP2 Completion Checklist

- [x] Account schema implemented.
- [x] User schema implemented.
- [x] Business schema implemented.
- [x] Membership and role schema implemented.
- [x] OTP challenge schema implemented.
- [x] Session schema or equivalent server-side session store implemented.
- [x] Audit event linkage implemented.
- [x] OTP request API implemented.
- [x] OTP verification API implemented.
- [x] Account creation/resume API implemented.
- [x] First business creation API implemented.
- [x] Language preference saved.
- [x] Logout invalidates active session.
- [x] Refresh-surviving auth state verified.
- [x] Server-side role checks implemented.
- [x] Minimal web flow implemented.
- [x] API tests cover success and rejection paths.
- [x] Existing CP1 checks pass.
- [x] `checkpoint/cp2-auth-business` tag created.

## Verification

- `pnpm install --frozen-lockfile`
- `pnpm run ci`
- `pnpm build`
- `docker compose ps`
- `pnpm --filter @grogoni/api start`
- `pnpm health:api`
